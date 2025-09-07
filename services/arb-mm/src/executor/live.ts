// services/arb-mm/src/executor/live.ts
// CHANGES:
// - Force-send pathway: respect FORCE_EXECUTE_EVEN_IF_NEG (+ optional FORCE_EXECUTE_MAX_BASE clamp).
// - Pre-send EV sanity gate with PNL_SAFETY_BPS (skipped when forced).
// - Log pre_tx_balances and post_tx_balances (SOL lamports, WSOL ui, USDC ui).
// - Log realized deltas per tx (realized_usdc_delta, wsol_delta, sol_lamports_delta).

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
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

const SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || "50");
const DEFAULT_RAYDIUM_POOL_ID = (
  process.env.RAYDIUM_POOL_ID ||
  process.env.RAYDIUM_POOL_ID_SOL_USDC ||
  "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
).trim();

const CONFIRM_LEVEL = (process.env.TX_CONFIRM_LEVEL as any) || "confirmed";
const CU_LIMIT = Number.isFinite(Number(process.env.SUBMIT_CU_LIMIT)) ? Number(process.env.SUBMIT_CU_LIMIT) : 400_000;
const CU_PRICE = Number.isFinite(Number(process.env.TIP_MICROLAMPORTS_PER_CU)) ? Number(process.env.TIP_MICROLAMPORTS_PER_CU) : 0;
const FIXED_TX_COST_QUOTE = Number(process.env.FIXED_TX_COST_QUOTE ?? "0") || 0;
const PNL_SAFETY_BPS = Number(process.env.PNL_SAFETY_BPS ?? "0") || 0;

function envTrue(k: string): boolean {
  const v = String(process.env[k] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
function envNum(k: string): number | undefined {
  const n = Number(process.env[k]);
  return Number.isFinite(n) ? n : undefined;
}

// Types / helpers
export type AtomicPath = "PHX->AMM" | "AMM->PHX";
function uiToAtoms(ui: number, decimals: number): bigint { return BigInt(Math.floor(ui * 10 ** decimals)); }
function applyBpsDownBig(x: bigint, bps: number): bigint {
  const BPS = 10_000n; const b = BigInt(Math.max(0, Math.min(10_000, Math.ceil(bps))));
  return (x * (BPS - b)) / BPS;
}
function cpmmExpectedOutBig(args: { dx: bigint; x: bigint; y: bigint; feeBps: number }): bigint {
  const dxLessFee = applyBpsDownBig(args.dx, args.feeBps);
  return (dxLessFee * args.y) / (args.x + dxLessFee);
}

type PoolMeta = { baseMint: PublicKey; quoteMint: PublicKey; baseVault?: PublicKey; quoteVault?: PublicKey };
const POOL_META_CACHE = new Map<string, PoolMeta>();
const DEFAULT_BASE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DEFAULT_QUOTE_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function getenv(k: string) { const v = process.env[k]; return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function findPoolJsonPath(): string | undefined {
  const envs = [getenv("RAYDIUM_POOL_JSON_PATH"), getenv("RAYDIUM_POOL_KEYS_JSON"), getenv("RAYDIUM_POOLS_FILE")];
  for (const e of envs) { if (e && fs.existsSync(e)) return path.resolve(e); }
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

  try {
    const p = findPoolJsonPath();
    if (p) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j?.id) {
        const id = new PublicKey(j.id);
        if (!id.equals(poolId)) {
          logger.log("raydium_pool_id_mismatch_env_disk", { env: poolId.toBase58(), json: id.toBase58() });
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

  const baseMint = (() => { const e = process.env.RAYDIUM_POOL_BASE_MINT?.trim(); try { return e ? new PublicKey(e) : DEFAULT_BASE_MINT; } catch { return DEFAULT_BASE_MINT; } })();
  const quoteMint = (() => { const e = process.env.RAYDIUM_POOL_QUOTE_MINT?.trim(); try { return e ? new PublicKey(e) : DEFAULT_QUOTE_MINT; } catch { return DEFAULT_QUOTE_MINT; } })();

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

async function getUiBalances(conn: Connection, owner: PublicKey) {
  const wsolAtaEnv = getenv("WSOL_ATA");
  const usdcAtaEnv = getenv("USDC_ATA");
  const WSOL_MINT = new PublicKey(getenv("WSOL_MINT") ?? "So11111111111111111111111111111111111111112");
  const USDC_MINT = new PublicKey(getenv("USDC_MINT") ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  const wsolAta = wsolAtaEnv ? new PublicKey(wsolAtaEnv) : getAssociatedTokenAddressSync(WSOL_MINT, owner, false, TOKEN_PROGRAM_ID);
  const usdcAta = usdcAtaEnv ? new PublicKey(usdcAtaEnv) : getAssociatedTokenAddressSync(USDC_MINT, owner, false, TOKEN_PROGRAM_ID);

  const [lamports, wsolBal, usdcBal] = await Promise.all([
    conn.getBalance(owner, "confirmed"),
    conn.getTokenAccountBalance(wsolAta, "confirmed").then(r => Number(r.value.uiAmount ?? 0)).catch(() => 0),
    conn.getTokenAccountBalance(usdcAta, "confirmed").then(r => Number(r.value.uiAmount ?? 0)).catch(() => 0),
  ]);
  return { solLamports: lamports, wsolUi: wsolBal, usdcUi: usdcBal, wsolAta: wsolAta.toBase58(), usdcAta: usdcAta.toBase58() };
}

export class LiveExecutor {
  constructor(private conn: Connection, private payer: Keypair) { }

  async startPhoenix(): Promise<void> { /* no-op */ }

  async maybeExecute(payload: any): Promise<void> {
    try {
      const path = (payload?.path as AtomicPath) || "PHX->AMM";
      let sizeBase = Number(payload?.size_base ?? payload?.trade_size_base ?? 0);
      const phoenix = payload?.phoenix || {};
      const buy_px = Number(payload?.buy_px ?? 0);
      const sell_px = Number(payload?.sell_px ?? 0);

      // ── Force-send path controls ─────────────────────────────────────────
      const FORCE = envTrue("FORCE_EXECUTE_EVEN_IF_NEG");
      const MAX_FORCE_BASE = envNum("FORCE_EXECUTE_MAX_BASE");
      if (FORCE && MAX_FORCE_BASE && sizeBase > MAX_FORCE_BASE) {
        logger.log("force_exec_clamped_size", { from: sizeBase, to: MAX_FORCE_BASE });
        sizeBase = MAX_FORCE_BASE;
      }

      // Stage 0: pre-send EV sanity (joiner already handled thresholds & safety)
      const evQuote = (sell_px - buy_px) * sizeBase - FIXED_TX_COST_QUOTE;
      const avgPx = (buy_px > 0 && sell_px > 0) ? (buy_px + sell_px) / 2 : 0;
      const evBps = (avgPx > 0) ? ((sell_px / buy_px) - 1) * 10_000 : -1e9;

      if (FORCE) {
        logger.log("force_exec_enabled", {
          path, size_base: sizeBase, buy_px, sell_px,
          ev_quote: evQuote, ev_bps: evBps,
          threshold_bps: Number(process.env.TRADE_THRESHOLD_BPS ?? 0) || 0,
          safety_bps: PNL_SAFETY_BPS,
        });
      } else {
        if (!(evQuote > 0)) {
          logger.log("submit_error", { where: "pre_send_ev_gate", error: "negative_expected_pnl_quote", sizeBase, buy_px, sell_px, ev_quote: evQuote });
          return;
        }
        const wantBps = (Number(process.env.TRADE_THRESHOLD_BPS ?? 0) || 0) + PNL_SAFETY_BPS;
        if (!(evBps >= wantBps)) {
          logger.log("submit_error", {
            where: "pre_send_ev_gate",
            error: "negative_or_insufficient_expected_pnl",
            size_base: sizeBase, buy_px, sell_px, ev_quote: evQuote, ev_bps: evBps, safety_bps: PNL_SAFETY_BPS
          });
          return;
        }
      }

      if (!phoenix?.market) {
        logger.log("submit_error", { where: "maybe_execute", error: "missing_phoenix_market" });
        return;
      }

      const market = new PublicKey(phoenix.market);

      // Stage 1: BUILD PHOENIX FIRST
      let phxIxs: TransactionInstruction[] = Array.isArray(payload?.phxIxs) ? toIxArray(payload.phxIxs) : [];
      if (!phxIxs.length) {
        const limitPx = Number(phoenix.limit_px ?? phoenix.limitPx ?? (payload?.sell_px ?? payload?.buy_px));
        const slippageBps = Number(process.env.PHOENIX_SLIPPAGE_BPS ?? "3");
        logger.log("phoenix_build_params", { market: market.toBase58(), side: phoenix.side, sizeBase, limitPx, slippageBps });
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
          if (Array.isArray(built)) phxIxs = toIxArray(built);
          else if (built && typeof built === "object" && "ixs" in built) phxIxs = toIxArray((built as any).ixs);
          else if (built && typeof built === "object" && "ok" in built && (built as any).ok && (built as any).ixs) phxIxs = toIxArray((built as any).ixs);
          if (!phxIxs.length) throw new Error("phoenix_build_returned_no_instructions");
          logger.log("phoenix_build_ok", { ixs: phxIxs.length });
        } catch (e: any) {
          logger.log("submit_error", { where: "phoenix_build", error: String(e?.message ?? e) });
          return;
        }
      }
      assertIxArray(phxIxs, "phoenix");

      // Stage 2: RAYDIUM minOut and BUILD
      const baseIn = path === "PHX->AMM";
      const poolIdStr = DEFAULT_RAYDIUM_POOL_ID;
      const poolId = new PublicKey(poolIdStr);
      const meta = await ensureRaydiumPoolMeta(this.conn, poolId);

      let amountInAtoms: bigint;
      if (baseIn) amountInAtoms = uiToAtoms(sizeBase, 9);
      else {
        const px = Number(phoenix.limit_px ?? phoenix.limitPx ?? payload?.buy_px ?? payload?.sell_px ?? 0);
        const quoteInUi = Math.max(0, sizeBase * (px || 0));
        amountInAtoms = uiToAtoms(quoteInUi, 6);
      }

      let reserves: { base: bigint; quote: bigint } | undefined;
      try {
        if (meta.baseVault && meta.quoteVault) reserves = await getVaultReservesFromVaults(this.conn, meta.baseVault, meta.quoteVault);
      } catch (e: any) {
        logger.log("raydium_reserve_fetch_error", { pool: poolIdStr, err: String(e?.message ?? e) });
      }

      const feeBps = Number.parseFloat(process.env.RAYDIUM_TRADE_FEE_BPS ?? "25");
      const dynExtra = Number.parseFloat(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? "0");
      const bufferBps = Number.parseFloat(process.env.RAYDIUM_MINOUT_BUFFER_BPS ?? "0");
      const usedSlip = Math.max(0, SLIPPAGE_BPS + dynExtra + bufferBps);

      let minOut: bigint;
      if (reserves) {
        const x = baseIn ? reserves.base : reserves.quote;
        const y = baseIn ? reserves.quote : reserves.base;
        const expectedOut = cpmmExpectedOutBig({ dx: amountInAtoms, x, y, feeBps });
        minOut = applyBpsDownBig(expectedOut, usedSlip);
        logger.log("raydium_minout_dbg", {
          base_in: baseIn,
          amount_in_atoms: amountInAtoms.toString(),
          fee_bps: feeBps,
          slip_bps_used: usedSlip,
          reserves_base: x.toString(),
          reserves_quote: y.toString(),
          expected_out_atoms: expectedOut.toString(),
          min_out_atoms: minOut.toString(),
        });
      } else {
        const refPx = Number(baseIn ? (payload?.sell_px ?? payload?.buy_px) : (payload?.buy_px ?? payload?.sell_px)) || 0;
        if (!(refPx > 0)) { logger.log("submit_error", { where: "raydium_build", error: "no_reserves_and_no_ref_px" }); return; }
        if (baseIn) {
          const inUi = Number(amountInAtoms) / 1e9;
          const outUi = inUi * refPx;
          const outAtoms = BigInt(Math.floor(outUi * 1e6));
          minOut = applyBpsDownBig(outAtoms, usedSlip);
        } else {
          const inUi = Number(amountInAtoms) / 1e6;
          const outUi = inUi / refPx;
          const outAtoms = BigInt(Math.floor(outUi * 1e9));
          minOut = applyBpsDownBig(outAtoms, usedSlip);
        }
        logger.log("raydium_minout_dbg", {
          base_in: baseIn, amount_in_atoms: amountInAtoms.toString(),
          fee_bps: feeBps, slip_bps_used: usedSlip, reserves_base: null, reserves_quote: null,
          ref_px_used: refPx, min_out_atoms: minOut.toString(),
        });
      }

      const inMint: PublicKey = baseIn ? meta.baseMint : meta.quoteMint;
      const outMint: PublicKey = baseIn ? meta.quoteMint : meta.baseMint;
      let rayIxs: TransactionInstruction[] = [];
      try {
        rayIxs = await buildRaydiumCpmmSwapIx({
          connection: this.conn,
          owner: this.payer.publicKey,
          poolId,
          inMint,
          outMint,
          amountIn: amountInAtoms,
          amountOutMin: minOut,
        });
        if (!Array.isArray(rayIxs) || rayIxs.length === 0) throw new Error("raydium_builder_returned_no_instructions");
        logger.log("raydium_build_ok", { ixs: rayIxs.length });
      } catch (e: any) {
        logger.log("submit_error", { where: "raydium_build", error: String(e?.message ?? e) });
        return;
      }
      assertIxArray(rayIxs, "raydium");

      // --------- PRE-TX BALANCES ----------
      const pre = await getUiBalances(this.conn, this.payer.publicKey);
      logger.log("pre_tx_balances", {
        path, size_base: sizeBase, size_source: payload?.size_source ?? "unknown",
        buy_px, sell_px, FIXED_TX_COST_QUOTE, PNL_SAFETY_BPS,
        forced: FORCE || undefined,
        ...pre
      });

      // --------- SUBMIT ----------
      const only = process.env.ONLY_PHX ? "phx" : (process.env.ONLY_RAY ? "ray" : "both");
      const preIxs = buildPreIxs(CU_LIMIT, CU_PRICE);

      logger.log("submit_ixs", { label: "atomic", phx: phxIxs.length, ray: rayIxs.length, total: preIxs.length + phxIxs.length + rayIxs.length });
      const sig = await submitAtomic({
        connection: this.conn,
        owner: this.payer,
        preIxs,
        phxIxs,
        rayIxs,
        only: only as any,
      });

      logger.log("submitted_tx", {
        path, size_base: sizeBase, ix_count: preIxs.length + phxIxs.length + rayIxs.length,
        cu_limit: CU_LIMIT, tip_lamports: undefined, sig, live: true, shadow: false,
      });

      // --------- CONFIRM ----------
      const t0 = Date.now();
      const conf = await this.conn.confirmTransaction(sig, CONFIRM_LEVEL as any);
      const conf_ms = Date.now() - t0;
      const slot = (conf as any)?.context?.slot ?? null;

      // --------- POST-TX BALANCES + REALIZED ----------
      const post = await getUiBalances(this.conn, this.payer.publicKey);
      const realized = {
        realized_usdc_delta: Number((post.usdcUi - pre.usdcUi).toFixed(6)),
        realized_wsol_delta: Number((post.wsolUi - pre.wsolUi).toFixed(9)),
        sol_lamports_delta: post.solLamports - pre.solLamports,
      };
      logger.log("post_tx_balances", { sig, slot, conf_ms, ...post, ...realized });

      // Summary line per tx
      logger.log("realized_summary", {
        sig, path, size_base: sizeBase,
        buy_px, sell_px,
        expected_ev_quote: Number(((sell_px - buy_px) * sizeBase - FIXED_TX_COST_QUOTE).toFixed(6)),
        ...realized
      });

      logger.log("landed", { sig, slot, conf_ms, shadow: false });
    } catch (e: any) {
      logger.log("submit_error", { where: "maybe_execute", error: String(e?.message ?? e) });
    }
  }
}
