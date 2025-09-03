// services/arb-mm/src/executor/live.ts
// CHANGES:
// - ensureRaydiumPoolMeta(): no SDK discovery; reads full keys from disk,
//   then (optional) on-chain decode fallback; final fallback = env mints.
// - removes the noisy `raydium_poolkeys_fetch_error` + `...not found via SDK` path.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Keypair,
} from "@solana/web3.js";
import BN from "bn.js";
import { SPL_ACCOUNT_LAYOUT, LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { logger } from "../ml_logger.js";
import { buildRaydiumCpmmSwapIx } from "./buildRaydiumCpmmIx.js";
import { buildPhoenixSwapIxs } from "../util/phoenix.js";
import { toIxArray, assertIxArray } from "../util/ix.js";
import { submitAtomic, buildPreIxs } from "../tx/submit.js";

// ─────────────────────────────────────────────────────────────────────────────
// ESM-safe dirname
const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Tunables / env
// ─────────────────────────────────────────────────────────────────────────────
const SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || "50"); // fallback 50 bps
const DEFAULT_RAYDIUM_POOL_ID = (
  process.env.RAYDIUM_POOL_ID ||
  process.env.RAYDIUM_POOL_ID_SOL_USDC ||
  "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
).trim();

const CONFIRM_LEVEL =
  (process.env.TX_CONFIRM_LEVEL as any) || "confirmed";
const CU_LIMIT = Number.isFinite(Number(process.env.SUBMIT_CU_LIMIT))
  ? Number(process.env.SUBMIT_CU_LIMIT)
  : 400_000;
const CU_PRICE = Number.isFinite(Number(process.env.TIP_MICROLAMPORTS_PER_CU))
  ? Number(process.env.TIP_MICROLAMPORTS_PER_CU)
  : 0;

// ─────────────────────────────────────────────────────────────────────────────
// Types / helpers
// ─────────────────────────────────────────────────────────────────────────────
export type AtomicPath = "PHX->AMM" | "AMM->PHX";

function uiToAtoms(ui: number, decimals: number): bigint {
  return BigInt(Math.floor(ui * 10 ** decimals));
}
function applyBpsDownBig(x: bigint, bps: number): bigint {
  const BPS = 10_000n;
  const b = BigInt(Math.max(0, Math.min(10_000, Math.ceil(bps))));
  return (x * (BPS - b)) / BPS;
}
function cpmmExpectedOutBig(args: { dx: bigint; x: bigint; y: bigint; feeBps: number }): bigint {
  const dxLessFee = applyBpsDownBig(args.dx, args.feeBps);
  return (dxLessFee * args.y) / (args.x + dxLessFee);
}

// ─────────────────────────────────────────────────────────────────────────────
// Raydium: robust pool meta + reserves (disk → on-chain → env)
// ─────────────────────────────────────────────────────────────────────────────
type PoolMeta = { baseMint: PublicKey; quoteMint: PublicKey; baseVault?: PublicKey; quoteVault?: PublicKey };
const POOL_META_CACHE = new Map<string, PoolMeta>();
const DEFAULT_BASE_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // WSOL
const DEFAULT_QUOTE_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC

function getenv(k: string) {
  const v = process.env[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function findPoolJsonPath(): string | undefined {
  const envs = [
    getenv("RAYDIUM_POOL_JSON_PATH"),
    getenv("RAYDIUM_POOL_KEYS_JSON"),
    getenv("RAYDIUM_POOLS_FILE"),
  ];
  for (const e of envs) {
    if (e && fs.existsSync(e)) return path.resolve(e);
  }
  const candidates = [
    path.resolve(process.cwd(), "configs", "raydium.pool.json"),
    path.resolve(process.cwd(), "..", "configs", "raydium.pool.json"),
    path.resolve(process.cwd(), "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__here, "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__here, "..", "..", "..", "configs", "raydium.pool.json"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return undefined;
}

async function ensureRaydiumPoolMeta(conn: Connection, poolId: PublicKey): Promise<PoolMeta> {
  const key = poolId.toBase58();
  if (POOL_META_CACHE.has(key)) return POOL_META_CACHE.get(key)!;

  // 1) Disk full-keys
  try {
    const p = findPoolJsonPath();
    if (p) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j?.id) {
        const id = new PublicKey(j.id);
        if (!id.equals(poolId)) {
          logger.log("raydium_pool_id_mismatch_env_disk", {
            env: poolId.toBase58(),
            json: id.toBase58(),
          });
        }
        const meta: PoolMeta = {
          baseMint: new PublicKey(j.baseMint),
          quoteMint: new PublicKey(j.quoteMint),
          baseVault: j.baseVault ? new PublicKey(j.baseVault) : undefined,
          quoteVault: j.quoteVault ? new PublicKey(j.quoteVault) : undefined,
        };
        POOL_META_CACHE.set(key, meta);
        logger.log("raydium_pool_meta_source", { pool: key, source: "disk" });
        return meta;
      }
    }
  } catch (e: any) {
    logger.log("raydium_pool_meta_disk_error", { pool: key, err: String(e?.message ?? e) });
  }

  // 2) On-chain decode (AmmV4 state)
  try {
    const info = await conn.getAccountInfo(poolId, "processed");
    if (info?.data) {
      const s: any = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);
      const meta: PoolMeta = {
        baseMint: new PublicKey(s.baseMint),
        quoteMint: new PublicKey(s.quoteMint),
        baseVault: new PublicKey(s.baseVault),
        quoteVault: new PublicKey(s.quoteVault),
      };
      POOL_META_CACHE.set(key, meta);
      logger.log("raydium_pool_meta_source", { pool: key, source: "onchain" });
      return meta;
    }
  } catch (e: any) {
    logger.log("raydium_pool_meta_onchain_error", { pool: key, err: String(e?.message ?? e) });
  }

  // 3) Env fallback (mints only)
  const baseMint = (() => {
    const e = process.env.RAYDIUM_POOL_BASE_MINT?.trim();
    try { return e ? new PublicKey(e) : DEFAULT_BASE_MINT; } catch { return DEFAULT_BASE_MINT; }
  })();
  const quoteMint = (() => {
    const e = process.env.RAYDIUM_POOL_QUOTE_MINT?.trim();
    try { return e ? new PublicKey(e) : DEFAULT_QUOTE_MINT; } catch { return DEFAULT_QUOTE_MINT; }
  })();

  const meta: PoolMeta = { baseMint, quoteMint };
  POOL_META_CACHE.set(key, meta);
  logger.log("raydium_pool_meta_source", { pool: key, source: "env" });
  return meta;
}

async function getVaultReservesFromVaults(conn: Connection, baseVault: PublicKey, quoteVault: PublicKey) {
  const accs = await conn.getMultipleAccountsInfo([baseVault, quoteVault], { commitment: "processed" as any });
  if (!accs[0]?.data || !accs[1]?.data) throw new Error("raydium_pool_reserves_missing");
  const baseInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[0].data);
  const quoteInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[1].data);
  const base = BigInt(new BN(baseInfo.amount).toString());
  const quote = BigInt(new BN(quoteInfo.amount).toString());
  return { base, quote };
}

// ─────────────────────────────────────────────────────────────────────────────
// LiveExecutor
// ─────────────────────────────────────────────────────────────────────────────
export class LiveExecutor {
  constructor(
    private conn: Connection,
    private payer: Keypair
  ) { }

  async startPhoenix(): Promise<void> {
    /* no-op (compat) */
  }

  /**
   * Build PHX + Ray ixs and send atomically via submitAtomic()
   */
  async maybeExecute(payload: any): Promise<void> {
    try {
      const path = (payload?.path as AtomicPath) || "PHX->AMM";
      const sizeBase = Number(payload?.size_base ?? payload?.trade_size_base ?? 0);
      const phoenix = payload?.phoenix || {};

      if (!phoenix?.market) {
        logger.log("submit_error", { where: "maybe_execute", error: "missing_phoenix_market" });
        return;
      }

      const market = new PublicKey(phoenix.market);

      // ─────────────────────────────────────────────────────────────────────
      // 1) Phoenix leg (build or accept provided)
      // ─────────────────────────────────────────────────────────────────────
      let phxIxs: TransactionInstruction[] = Array.isArray(payload?.phxIxs)
        ? toIxArray(payload.phxIxs)
        : [];

      if (!phxIxs.length) {
        const limitPx = Number(
          phoenix.limit_px ?? phoenix.limitPx ?? (payload?.sell_px ?? payload?.buy_px)
        );
        const slippageBps = Number(process.env.PHOENIX_SLIPPAGE_BPS ?? "3");

        const phxParams = {
          market: market.toBase58(),
          side: phoenix.side, // "buy" | "sell"
          sizeBase,
          limitPx,
          slippageBps,
        };
        logger.log("phoenix_build_params", phxParams);

        try {
          const built: any = await buildPhoenixSwapIxs({
            connection: this.conn,
            owner: this.payer.publicKey,
            market,
            side: phoenix.side,
            sizeBase,
            limitPx,
            slippageBps,
          } as any);

          logger.log("phoenix_build_result_shape", {
            type: typeof built,
            hasIxsField: built && typeof built === "object" && "ixs" in built,
            isArray: Array.isArray(built),
            keys: built && typeof built === "object" ? Object.keys(built) : null,
          });

          // Accept any of the SDK shapes
          if (Array.isArray(built)) phxIxs = toIxArray(built);
          else if (built && typeof built === "object" && "ixs" in built) phxIxs = toIxArray((built as any).ixs);
          else if (built && typeof built === "object" && "ok" in built) {
            if ((built as any).ok && (built as any).ixs) phxIxs = toIxArray((built as any).ixs);
            else {
              const reason = (built as any).reason ?? "phoenix_builder_not_ok";
              logger.log("submit_error", { where: "phoenix_build", error: reason, debug: (built as any)?.debug ?? phxParams });
              return;
            }
          }

          if (!phxIxs.length) {
            logger.log("submit_error", { where: "phoenix_build", error: "phoenix_build_returned_no_instructions", debug: phxParams });
            return;
          }
        } catch (e: any) {
          logger.log("submit_error", { where: "phoenix_build", error: String(e?.message ?? e) });
          return;
        }
      }
      assertIxArray(phxIxs, "phoenix");

      // ─────────────────────────────────────────────────────────────────────
      // 2) Raydium leg (disk/on-chain meta + reserves → CPMM minOut; refPx fallback)
      // ─────────────────────────────────────────────────────────────────────
      const baseIn = path === "PHX->AMM"; // PHX buy → have BASE → AMM leg is BASE->QUOTE

      let amountInAtoms: bigint;
      if (baseIn) {
        amountInAtoms = uiToAtoms(sizeBase, 9); // BASE atoms (9 decimals for SOL)
      } else {
        const px = Number(phoenix.limit_px ?? phoenix.limitPx ?? payload?.buy_px ?? payload?.sell_px ?? 0);
        const quoteInUi = Math.max(0, sizeBase * (px || 0));
        amountInAtoms = uiToAtoms(quoteInUi, 6); // QUOTE atoms (6 decimals for USDC)
      }

      const poolIdStr = DEFAULT_RAYDIUM_POOL_ID;
      const poolId = new PublicKey(poolIdStr);

      // robust meta (disk → on-chain → env)
      const meta = await ensureRaydiumPoolMeta(this.conn, poolId);

      // reserves (optional but preferred)
      let reserves: { base: bigint; quote: bigint } | undefined;
      try {
        if (meta.baseVault && meta.quoteVault) {
          reserves = await getVaultReservesFromVaults(this.conn, meta.baseVault, meta.quoteVault);
        }
      } catch (e: any) {
        logger.log("raydium_reserve_fetch_error", { pool: poolIdStr, err: String(e?.message ?? e) });
      }

      const feeBps = Number.parseFloat(process.env.RAYDIUM_TRADE_FEE_BPS ?? "25");
      const dynExtra = Number.parseFloat(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? "0");
      const bufferBps = Number.parseFloat(process.env.RAYDIUM_MINOUT_BUFFER_BPS ?? "0");
      const usedSlip = Math.max(0, SLIPPAGE_BPS + dynExtra + bufferBps);

      // minOut
      let minOut: bigint;
      if (reserves) {
        const x = baseIn ? reserves.base : reserves.quote;
        const y = baseIn ? reserves.quote : reserves.base;
        const expectedOut = cpmmExpectedOutBig({ dx: amountInAtoms, x, y, feeBps });
        minOut = applyBpsDownBig(expectedOut, usedSlip);
      } else {
        // Conservative reference-price fallback
        const refPx =
          Number(baseIn ? (payload?.sell_px ?? payload?.buy_px) : (payload?.buy_px ?? payload?.sell_px)) ||
          0;
        if (!(refPx > 0)) {
          logger.log("submit_error", { where: "raydium_build", error: "no_reserves_and_no_ref_px" });
          return;
        }
        if (baseIn) {
          const inUi = Number(amountInAtoms) / 1e9;         // BASE atoms → BASE UI
          const outUi = inUi * refPx;                       // USDC UI
          const outAtoms = BigInt(Math.floor(outUi * 1e6)); // USDC atoms
          minOut = applyBpsDownBig(outAtoms, usedSlip);
        } else {
          const inUi = Number(amountInAtoms) / 1e6;         // USDC atoms → USDC UI
          const outUi = inUi / refPx;                       // BASE UI
          const outAtoms = BigInt(Math.floor(outUi * 1e9)); // BASE atoms
          minOut = applyBpsDownBig(outAtoms, usedSlip);
        }
      }

      const inMint: PublicKey = baseIn ? meta.baseMint : meta.quoteMint;
      const outMint: PublicKey = baseIn ? meta.quoteMint : meta.baseMint;

      const rayIxs: TransactionInstruction[] = await buildRaydiumCpmmSwapIx({
        connection: this.conn,
        owner: this.payer.publicKey,
        poolId,
        inMint,
        outMint,
        amountIn: amountInAtoms,
        amountOutMin: minOut,
      });

      if (!Array.isArray(rayIxs) || rayIxs.length === 0) {
        logger.log("submit_error", { where: "maybe_execute", error: "no_ray_ixs" });
        return;
      }
      assertIxArray(rayIxs, "raydium");

      // ─────────────────────────────────────────────────────────────────────
      // 3) Send atomically
      // ─────────────────────────────────────────────────────────────────────
      const only =
        process.env.ONLY_PHX ? "phx" :
          process.env.ONLY_RAY ? "ray" : "both";

      // Build pre-ixts (CU limit + optional tip)
      const pre = buildPreIxs(CU_LIMIT, CU_PRICE);

      // Submit
      logger.log("submit_ixs", { label: "atomic", phx: phxIxs.length, ray: rayIxs.length, total: pre.length + phxIxs.length + rayIxs.length });
      const sig = await submitAtomic({
        connection: this.conn,
        owner: this.payer,
        preIxs: pre,
        phxIxs,
        rayIxs,
        only: only as any,
      });

      logger.log("submitted_tx", {
        path,
        size_base: sizeBase,
        ix_count: pre.length + phxIxs.length + rayIxs.length,
        cu_limit: CU_LIMIT,
        tip_lamports: undefined,
        sig,
        live: true,
        shadow: false,
      });

      // Confirm
      const t0 = Date.now();
      const conf = await this.conn.confirmTransaction(sig, CONFIRM_LEVEL as any);
      const conf_ms = Date.now() - t0;
      const slot = (conf as any)?.context?.slot ?? null;

      logger.log("landed", {
        sig,
        slot,
        conf_ms,
        shadow: false,
      });
    } catch (e: any) {
      logger.log("submit_error", { where: "maybe_execute", error: String(e?.message ?? e) });
    }
  }
}
