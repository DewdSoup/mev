// services/arb-mm/src/executor/live.ts
// (full file with RPC backoff + tx simulation + send gate integrated)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Connection, PublicKey, TransactionInstruction, Keypair,
  VersionedTransaction, TransactionMessage,
} from "@solana/web3.js";
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { logger } from "../ml_logger.js";
import { buildRaydiumCpmmSwapIx } from "./buildRaydiumCpmmIx.js";
import { buildRaydiumClmmSwapIx } from "./buildRaydiumClmmIx.js";
import { buildOrcaWhirlpoolSwapIx } from "./buildOrcaWhirlpoolIx.js";
import { buildPhoenixSwapIxs } from "../util/phoenix.js";
import { toIxArray, assertIxArray } from "../util/ix.js";
import { submitAtomic, buildPreIxs } from "../tx/submit.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { withRpcBackoff } from "../util/rpc_backoff.js";
import { rpcSimFn as rpcSimTx } from "../tx/rpcSim.js";            // <- NEW
import { canActuallySendNow } from "../tx/sendGate.js";           // <- NEW

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

const SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || "50");

// Defaults to your SOL/USDC pools (override with env if you prefer)
const DEFAULT_RAYDIUM_POOL_ID = (
  process.env.RAYDIUM_POOL_ID ||
  process.env.RAYDIUM_POOL_ID_SOL_USDC ||
  "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
).trim();

const DEFAULT_ORCA_POOL_ID = (
  process.env.ORCA_POOL_ID ||
  "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"
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
  const BPS = 10_000n; const b = BigInt(Math.max(0, Math.min(10_000, Math.ceil(bps)))); return (x * (BPS - b)) / BPS;
}

type PoolMeta = { baseMint: PublicKey; quoteMint: PublicKey; baseVault?: PublicKey; quoteVault?: PublicKey };
const POOL_META_CACHE = new Map<string, PoolMeta>();
const DEFAULT_BASE_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // WSOL
const DEFAULT_QUOTE_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC

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
  } catch (err) {
    const e = err as any;
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
  } catch (err) {
    const e = err as any;
    logger.log("raydium_pool_meta_onchain_error", { pool: key, err: String(e?.message ?? e) });
  }

  const baseMint = (() => { const e = process.env.RAYDIUM_POOL_BASE_MINT?.trim(); try { return e ? new PublicKey(e) : DEFAULT_BASE_MINT; } catch { return DEFAULT_BASE_MINT; } })();
  const quoteMint = (() => { const e = process.env.RAYDIUM_POOL_QUOTE_MINT?.trim(); try { return e ? new PublicKey(e) : DEFAULT_QUOTE_MINT; } catch { return DEFAULT_QUOTE_MINT; } })();

  const meta: PoolMeta = { baseMint, quoteMint };
  POOL_META_CACHE.set(key, meta);
  logger.log("raydium_pool_meta_source", { pool: key, source: "env" });
  return meta;
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
  constructor(private connRaw: Connection, private payer: Keypair) {
    try {
      const maxConc = Number(process.env.RPC_BACKOFF_MAX_CONCURRENCY ?? 6);
      const maxRetries = Number(process.env.RPC_BACKOFF_MAX_RETRIES ?? 5);
      this.conn = withRpcBackoff(this.connRaw, { maxConcurrency: maxConc, maxRetries });
    } catch (err) {
      const e = err as any;
      logger.log("rpc_backoff_wrap_error", { err: String(e?.message ?? e) });
      // @ts-ignore
      this.conn = this.connRaw;
    }
  }

  private conn: Connection;

  async startPhoenix(): Promise<void> { /* no-op */ }

  async maybeExecute(payload: any): Promise<void> {
    try {
      const atomicPath = (payload?.path as AtomicPath) || "PHX->AMM";
      const ammVenue = String(payload?.amm_venue ?? payload?.ammVenue ?? "raydium").toLowerCase() as "raydium" | "orca";
      const poolFromPayload = String(payload?.amm?.pool ?? "").trim();
      const poolKind = String(payload?.amm_meta?.poolKind ?? payload?.amm_pool_kind ?? "")
        .trim()
        .toLowerCase();
      let sizeBase = Number(payload?.size_base ?? payload?.trade_size_base ?? 0);
      const phoenix = payload?.phoenix || {};
      const buy_px = Number(payload?.buy_px ?? 0);
      const sell_px = Number(payload?.sell_px ?? 0);

      const FORCE = envTrue("FORCE_EXECUTE_EVEN_IF_NEG");
      const MAX_FORCE_BASE = envNum("FORCE_EXECUTE_MAX_BASE");
      if (FORCE && MAX_FORCE_BASE && sizeBase > MAX_FORCE_BASE) {
        logger.log("force_exec_clamped_size", { from: sizeBase, to: MAX_FORCE_BASE });
        sizeBase = MAX_FORCE_BASE;
      }

      // Pre-send EV sanity (skip if forced)
      const evQuote = (sell_px - buy_px) * sizeBase - FIXED_TX_COST_QUOTE;
      const evBps = (buy_px > 0 && sell_px > 0) ? ((sell_px / buy_px) - 1) * 10_000 : -1e9;
      if (!FORCE) {
        if (!(evQuote > 0)) {
          logger.log("submit_error", { where: "pre_send_ev_gate", error: "negative_expected_pnl_quote", sizeBase, buy_px, sell_px, ev_quote: evQuote });
          return;
        }
        const wantBps = (Number(process.env.TRADE_THRESHOLD_BPS ?? 0) || 0) + PNL_SAFETY_BPS;
        if (!(evBps >= wantBps)) {
          logger.log("submit_error", { where: "pre_send_ev_gate", error: "insufficient_edge_bps", size_base: sizeBase, ev_bps: evBps, want_bps: wantBps });
          return;
        }
      } else {
        logger.log("force_exec_enabled", { path: atomicPath, ammVenue, size_base: sizeBase, ev_quote: evQuote, ev_bps: evBps });
      }

      if (!phoenix?.market) {
        logger.log("submit_error", { where: "maybe_execute", error: "missing_phoenix_market" });
        return;
      }

      const market = new PublicKey(phoenix.market);

      // 1) PHOENIX
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
        } catch (err) {
          const e = err as any;
          logger.log("submit_error", { where: "phoenix_build", error: String(e?.message ?? e) });
          return;
        }
      }
      assertIxArray(phxIxs, "phoenix");

      // 2) AMM leg: choose Raydium or Orca
      const baseIn = atomicPath === "PHX->AMM";
      let rayIxs: TransactionInstruction[] = [];
      let orcaIxs: TransactionInstruction[] = [];

      if (ammVenue === "raydium" && poolKind === "clmm") {
        const clmmPoolId = poolFromPayload || getenv("RAYDIUM_CLMM_POOL_ID");
        if (!clmmPoolId) {
          logger.log("submit_error", { where: "raydium_clmm_build", error: "missing_pool_id" });
          return;
        }

        const refPx = Number(baseIn ? payload?.sell_px : payload?.buy_px) || 0;
        if (!(refPx > 0)) { logger.log("submit_error", { where: "raydium_clmm_build", error: "no_ref_px" }); return; }

        const amountInAtoms = baseIn
          ? uiToAtoms(sizeBase, 9)
          : uiToAtoms(sizeBase * refPx, 6);

        const expectedOutAtoms = baseIn
          ? uiToAtoms(sizeBase * refPx, 6)
          : uiToAtoms(sizeBase, 9);

        const clmm = await buildRaydiumClmmSwapIx({
          connection: this.conn,
          user: this.payer.publicKey,
          poolId: clmmPoolId,
          baseIn,
          amountInAtoms,
          expectedOutAtoms,
          slippageBps: SLIPPAGE_BPS,
        });

        if (!clmm.ok) { logger.log("submit_error", { where: "raydium_clmm_build", error: clmm.reason }); return; }
        rayIxs = clmm.ixs;
        assertIxArray(rayIxs, "raydium_clmm");
        logger.log("raydium_clmm_build_ok", { ixs: rayIxs.length, pool: clmmPoolId });
      } else if (ammVenue === "raydium") {
        const poolIdStr = poolFromPayload || DEFAULT_RAYDIUM_POOL_ID;
        const poolId = new PublicKey(poolIdStr);
        const meta = await ensureRaydiumPoolMeta(this.conn, poolId);

        let amountInAtoms: bigint;
        if (baseIn) amountInAtoms = uiToAtoms(sizeBase, 9);
        else {
          const px = Number(phoenix.limit_px ?? phoenix.limitPx ?? payload?.buy_px ?? payload?.sell_px ?? 0);
          const quoteInUi = Math.max(0, sizeBase * (px || 0));
          amountInAtoms = uiToAtoms(quoteInUi, 6);
        }

        const dynExtra = Number.parseFloat(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? "0");
        const bufferBps = Number.parseFloat(process.env.RAYDIUM_MINOUT_BUFFER_BPS ?? "0");
        const usedSlip = Math.max(0, SLIPPAGE_BPS + dynExtra + bufferBps);

        const inMint: PublicKey = baseIn ? meta.baseMint : meta.quoteMint;
        const outMint: PublicKey = baseIn ? meta.quoteMint : meta.baseMint;

        const refPx = Number(baseIn ? (payload?.sell_px ?? payload?.buy_px) : (payload?.buy_px ?? payload?.sell_px)) || 0;
        if (!(refPx > 0)) { logger.log("submit_error", { where: "raydium_build", error: "no_ref_px" }); return; }

        let outAtoms: bigint;
        if (baseIn) {
          const inUi = Number(amountInAtoms) / 1e9;
          const outUi = inUi * refPx;
          outAtoms = BigInt(Math.floor(outUi * 1e6));
        } else {
          const inUi = Number(amountInAtoms) / 1e6;
          const outUi = inUi / refPx;
          outAtoms = BigInt(Math.floor(outUi * 1e9));
        }
        const minOut = applyBpsDownBig(outAtoms, usedSlip);

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
          logger.log("raydium_build_ok", { ixs: rayIxs.length, pool: poolIdStr });
        } catch (err) {
          const e = err as any;
          logger.log("submit_error", { where: "raydium_build", error: String(e?.message ?? e) });
          return;
        }
        assertIxArray(rayIxs, "raydium");
      } else {
        const whirlpoolId = new PublicKey(poolFromPayload || DEFAULT_ORCA_POOL_ID);

        const px = Number(baseIn ? payload?.sell_px : payload?.buy_px) || 0;
        if (!(px > 0)) { logger.log("submit_error", { where: "orca_build", error: "no_ref_px" }); return; }

        const amountInAtoms = baseIn
          ? uiToAtoms(sizeBase, 9)
          : uiToAtoms(sizeBase * px, 6);

        try {
          const orcaResult = await buildOrcaWhirlpoolSwapIx({
            connection: this.conn,
            user: this.payer.publicKey,
            poolId: whirlpoolId.toBase58(),
            baseIn,
            amountInAtoms,
            slippageBps: SLIPPAGE_BPS,
          });

          if (orcaResult.ok) {
            orcaIxs = orcaResult.ixs;
          } else {
            throw new Error(orcaResult.reason);
          }
          if (!Array.isArray(orcaIxs) || orcaIxs.length === 0) throw new Error("orca_builder_returned_no_instructions");
          logger.log("orca_build_ok", { ixs: orcaIxs.length, pool: whirlpoolId.toBase58() });
        } catch (err) {
          const e = err as any;
          logger.log("submit_error", { where: "orca_build", error: String(e?.message ?? e) });
          return;
        }
        assertIxArray(orcaIxs, "orca");
      }

      // --------- PRE-TX BALANCES ----------
      const pre = await getUiBalances(this.conn, this.payer.publicKey);
      logger.log("pre_tx_balances", {
        path: atomicPath, ammVenue, size_base: sizeBase,
        buy_px, sell_px, FIXED_TX_COST_QUOTE, PNL_SAFETY_BPS,
        forced: FORCE || undefined,
        ...pre
      });

      // --------- BUILD ATOMIC (for simulation) ----------
      const preIxs = buildPreIxs(CU_LIMIT, CU_PRICE);
      const ammIxs = ammVenue === "raydium" ? rayIxs : orcaIxs;
      const ixs = [...preIxs, ...phxIxs, ...ammIxs];

      const latest = await this.conn.getLatestBlockhash("processed");
      const msg = new TransactionMessage({
        payerKey: this.payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: ixs,
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([this.payer]);

      // --------- RPC SIM ----------
      const sim = await rpcSimTx(this.conn, tx, { sigVerify: true, commitment: "processed" });
      logger.log("rpc_sim", {
        ok: sim.ok,
        units: sim.unitsConsumed,
        logs_tail: sim.logs?.slice?.(-6),
        err: sim.err,
      });

      // Send gate: block when unfunded or sim-only mode on
      const gate = await canActuallySendNow(this.conn, { env: process.env, owner: this.payer.publicKey });
      if (!gate) {
        logger.log("send_gate_off", { reason: "sim_only_or_unfunded", sim_ok: sim.ok, err: sim.err });
        return;
      }

      if (!sim.ok) {
        logger.log("submit_error", { where: "rpc_sim", error: sim.err ?? "simulation_failed" });
        return;
      }

      // --------- SUBMIT ----------
      const only = process.env.ONLY_PHX ? "phx" : (process.env.ONLY_RAY ? "ray" : undefined);
      const total = preIxs.length + phxIxs.length + ammIxs.length;
      logger.log("submit_ixs", { label: "atomic", phx: phxIxs.length, amm: ammIxs.length, total });

      const sig = await submitAtomic({
        connection: this.conn,
        owner: this.payer,
        preIxs,
        phxIxs,
        rayIxs: ammIxs, // pass AMM ixs regardless of venue
        only: only as any,
      });

      logger.log("submitted_tx", { path: atomicPath, ammVenue, size_base: sizeBase, ix_count: total, cu_limit: CU_LIMIT, sig, live: true, shadow: false });

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

      logger.log("realized_summary", {
        sig, path: atomicPath, ammVenue, size_base: sizeBase,
        buy_px, sell_px,
        expected_ev_quote: Number(((sell_px - buy_px) * sizeBase - FIXED_TX_COST_QUOTE).toFixed(6)),
        ...realized
      });

      logger.log("landed", { sig, slot, conf_ms, shadow: false });
    } catch (err) {
      const e = err as any;
      logger.log("submit_error", { where: "maybe_execute", error: String(e?.message ?? e) });
    }
  }
}
