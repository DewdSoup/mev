// services/arb-mm/src/executor/live.ts
// (full file with RPC backoff + tx simulation + send gate integrated)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
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
import { getRpcP95Ms } from "../runtime/metrics.js";              // <- NEW

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

/** ──────────────────────────────────────────────────────────────────────
 *  Fee / cost constants (Step 2)
 *  ────────────────────────────────────────────────────────────────────── */
const CU_LIMIT = Number.isFinite(Number(process.env.SUBMIT_CU_LIMIT)) ? Number(process.env.SUBMIT_CU_LIMIT) : 400_000;

// Signature fee (lamports); Solana default is 5_000 lamports.
const SIGNATURE_FEE_LAMPORTS = Number.isFinite(Number(process.env.SIGNATURE_FEE_LAMPORTS))
  ? Number(process.env.SIGNATURE_FEE_LAMPORTS)
  : 5_000;

// Max μLamports/CU clamp (keeps us from overbidding by mistake)
const TIP_MAX_MICROLAMPORTS_PER_CU = Number.isFinite(Number(process.env.TIP_MAX_MICROLAMPORTS_PER_CU))
  ? Number(process.env.TIP_MAX_MICROLAMPORTS_PER_CU)
  : 100_000;

// Baseline μLamports/CU (used when latency is low)
const TIP_BASE_MICROLAMPORTS_PER_CU = Number.isFinite(Number(process.env.TIP_MICROLAMPORTS_PER_CU))
  ? Number(process.env.TIP_MICROLAMPORTS_PER_CU)
  : 5_000;

// Backward-compat fallback for environments that still want a fixed EV cost
const FIXED_TX_COST_QUOTE_FALLBACK = Number(process.env.FIXED_TX_COST_QUOTE ?? "0") || 0;

// Pre-sim units guess (only used to gate obviously unprofitable sends before sim)
const EST_UNITS_BEFORE_SIM = Number.isFinite(Number(process.env.EST_UNITS_BEFORE_SIM))
  ? Number(process.env.EST_UNITS_BEFORE_SIM)
  : Math.floor(CU_LIMIT * 0.7);

// Toggle: use dynamic fixed cost instead of FIXED_TX_COST_QUOTE_FALLBACK
const USE_DYNAMIC_TX_COST = String(process.env.EXEC_USE_DYNAMIC_TX_COST ?? "1").trim() !== "0";

const SKIP_BALANCE_READS = String(process.env.SKIP_BALANCE_READS ?? "1").trim() === "1";

// Extra guardrail for EV gate
const PNL_SAFETY_BPS = Number(process.env.PNL_SAFETY_BPS ?? "0") || 0;

/** ──────────────────────────────────────────────────────────────────────
 *  Helpers (Step 3)
 *  ────────────────────────────────────────────────────────────────────── */
function computeAdaptiveCuPrice(): number {
  const base = TIP_BASE_MICROLAMPORTS_PER_CU;
  const p95 = getRpcP95Ms(); // smoothed in main.ts
  const bump =
    p95 > 1200 ? 6 :
      p95 > 800 ? 4 :
        p95 > 500 ? 2 :
          1;
  return Math.min(base * bump, TIP_MAX_MICROLAMPORTS_PER_CU);
}

function estimateFixedCostQuote(units: number, usedCuPriceMicro: number, refPxQuotePerBase: number): number {
  // lamports for priority fee + base signature
  const lamportsPriority = Math.ceil((units * usedCuPriceMicro) / 1_000_000);
  const lamportsTotal = lamportsPriority + SIGNATURE_FEE_LAMPORTS;
  const sol = lamportsTotal / 1_000_000_000; // 1e9 lamports per SOL
  // Convert SOL cost to quote using the current (~mid) SOL/USDC
  return sol * Math.max(0, refPxQuotePerBase || 0);
}

function envTrue(k: string): boolean {
  const v = String(process.env[k] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
function envNum(k: string): number | undefined {
  const n = Number(process.env[k]);
  return Number.isFinite(n) ? n : undefined;
}

// Types / helpers
export type AtomicPath = "PHX->AMM" | "AMM->PHX" | "AMM->AMM";
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

type BalanceSnapshot = {
  solLamports: number;
  wsolUi: number;
  usdcUi: number;
  wsolAta: string;
  usdcAta: string;
};

const BALANCE_CACHE_MS = Number(process.env.BALANCE_CACHE_MS ?? 3_000);
let balanceCache: { ts: number; data: BalanceSnapshot | null } = { ts: 0, data: null };
const missingAtas = new Set<string>();

async function safeTokenBalance(conn: Connection, pubkey: PublicKey): Promise<number> {
  const key = pubkey.toBase58();
  if (missingAtas.has(key)) return 0;
  if (SKIP_BALANCE_READS) return 0;
  try {
    const res = await conn.getTokenAccountBalance(pubkey, "confirmed");
    return Number(res.value.uiAmount ?? 0);
  } catch (err) {
    const msg = String((err as any)?.message ?? err ?? "");
    if (msg.includes("could not find account") || msg.includes("Account does not exist")) {
      missingAtas.add(key);
    }
    return 0;
  }
}

async function getUiBalances(conn: Connection, owner: PublicKey): Promise<BalanceSnapshot> {
  const now = Date.now();
  const cached = balanceCache.data;
  if (cached && now - balanceCache.ts <= BALANCE_CACHE_MS) return cached;

  const wsolAtaEnv = getenv("WSOL_ATA");
  const usdcAtaEnv = getenv("USDC_ATA");
  const WSOL_MINT = new PublicKey(getenv("WSOL_MINT") ?? "So11111111111111111111111111111111111111112");
  const USDC_MINT = new PublicKey(getenv("USDC_MINT") ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  const wsolAta = wsolAtaEnv ? new PublicKey(wsolAtaEnv) : getAssociatedTokenAddressSync(WSOL_MINT, owner, false, TOKEN_PROGRAM_ID);
  const usdcAta = usdcAtaEnv ? new PublicKey(usdcAtaEnv) : getAssociatedTokenAddressSync(USDC_MINT, owner, false, TOKEN_PROGRAM_ID);

  if (SKIP_BALANCE_READS) {
    return {
      solLamports: 0,
      wsolUi: 0,
      usdcUi: 0,
      wsolAta: wsolAta.toBase58(),
      usdcAta: usdcAta.toBase58(),
    };
  }

  const [lamports, wsolBal, usdcBal] = await Promise.all([
    conn.getBalance(owner, "confirmed"),
    safeTokenBalance(conn, wsolAta),
    safeTokenBalance(conn, usdcAta),
  ]);
  const snapshot: BalanceSnapshot = {
    solLamports: lamports,
    wsolUi: wsolBal,
    usdcUi: usdcBal,
    wsolAta: wsolAta.toBase58(),
    usdcAta: usdcAta.toBase58(),
  };
  balanceCache = { ts: now, data: snapshot };
  return snapshot;
}

export class LiveExecutor {
  constructor(private connRaw: Connection, private payer: Keypair) {
    try {
      const maxConc = Number(process.env.RPC_BACKOFF_MAX_CONCURRENCY ?? 6);
      const maxRetries = Number(process.env.RPC_BACKOFF_MAX_RETRIES ?? 5);
      const isFacade = (this.connRaw as any)?.__rpc_facade__;
      if (isFacade) {
        this.conn = this.connRaw;
      } else {
        this.conn = withRpcBackoff(this.connRaw, { maxConcurrency: maxConc, maxRetries });
      }
    } catch (err) {
      const e = err as any;
      logger.log("rpc_backoff_wrap_error", { err: String(e?.message ?? e) });
      // @ts-ignore
      this.conn = this.connRaw;
    }
  }

  private conn: Connection;
  private lutCache = new Map<string, AddressLookupTableAccount>();

  private async getLookupTableAccounts(pubkeys: PublicKey[]): Promise<AddressLookupTableAccount[]> {
    const uniq = new Map<string, PublicKey>();
    for (const pk of pubkeys) {
      if (!pk) continue;
      uniq.set(pk.toBase58(), pk);
    }
    const want = Array.from(uniq.values());
    if (!want.length) return [];

    const out: AddressLookupTableAccount[] = [];
    const misses: PublicKey[] = [];
    for (const pk of want) {
      const key = pk.toBase58();
      const hit = this.lutCache.get(key);
      if (hit) {
        out.push(hit);
      } else {
        misses.push(pk);
      }
    }

    if (misses.length) {
      const fetched = await Promise.all(misses.map(async (pk) => {
        try {
          const res = await this.conn.getAddressLookupTable(pk);
          const value = res.value ?? null;
          if (!value) {
            logger.log("lookup_table_missing", { address: pk.toBase58() });
            return null;
          }
          this.lutCache.set(pk.toBase58(), value);
          return value;
        } catch (err) {
          logger.log("lookup_table_fetch_error", {
            address: pk.toBase58(),
            err: String((err as any)?.message ?? err),
          });
          return null;
        }
      }));
      for (const acc of fetched) {
        if (acc) out.push(acc);
      }
    }

    return out;
  }

  async startPhoenix(): Promise<void> { /* no-op */ }

  async maybeExecute(payload: any): Promise<void> {
    try {
      const atomicPath = (payload?.path as AtomicPath) || "PHX->AMM";
      const isAmmAmm = atomicPath === "AMM->AMM";
      const ammVenue = String(
        payload?.amm_venue ??
        payload?.amm?.venue ??
        payload?.ammVenue ??
        "raydium"
      ).toLowerCase() as "raydium" | "orca";
      const poolFromPayload = String(
        payload?.amm_pool_id ??
        payload?.amm?.pool ??
        ""
      ).trim();
      const poolKind = String(
        payload?.amm_meta?.poolKind ??
        payload?.amm?.meta?.poolKind ??
        payload?.amm_pool_kind ??
        ""
      )
        .trim()
        .toLowerCase();
      const ammDstVenue = String(
        payload?.amm_dst_venue ??
        payload?.amm_dst?.venue ??
        ""
      ).toLowerCase() as "raydium" | "orca" | "";
      const ammDstPoolId = String(
        payload?.amm_dst_pool_id ??
        payload?.amm_dst?.pool ??
        ""
      ).trim();
      const ammDstPoolKind = String(
        payload?.amm_dst_meta?.poolKind ??
        payload?.amm_dst?.meta?.poolKind ??
        ""
      )
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

      // ── Adaptive price (Step 4) ────────────────────────────────────────
      const usedCuPrice = computeAdaptiveCuPrice();

      // ── Pre-send EV sanity (Step 5) ────────────────────────────────────
      const avgPx =
        (buy_px > 0 && sell_px > 0)
          ? (buy_px + sell_px) / 2
          : Number(process.env.DEFAULT_SOL_USD ?? 150);

      const fixedCostPre = USE_DYNAMIC_TX_COST
        ? estimateFixedCostQuote(EST_UNITS_BEFORE_SIM, usedCuPrice, avgPx)
        : FIXED_TX_COST_QUOTE_FALLBACK;

      const evQuotePre = (sell_px - buy_px) * sizeBase - fixedCostPre;
      const evBpsBase = (buy_px > 0 && sell_px > 0) ? ((sell_px / buy_px) - 1) * 10_000 : Number.NaN;
      const evBps = Number.isFinite(evBpsBase) ? evBpsBase : Number.NaN;

      if (!FORCE) {
        if (!(evQuotePre > 0)) {
          logger.log("submit_error", {
            where: "pre_send_ev_gate",
            error: "negative_expected_pnl_quote",
            sizeBase,
            buy_px,
            sell_px,
            ev_quote: evQuotePre,
            fixed_cost_pre: fixedCostPre
          });
          return;
        }
        const wantBps = (Number(process.env.TRADE_THRESHOLD_BPS ?? 0) || 0) + PNL_SAFETY_BPS;
        if (!Number.isFinite(evBps) || evBps < wantBps) {
          logger.log("submit_error", {
            where: "pre_send_ev_gate",
            error: "insufficient_edge_bps",
            size_base: sizeBase,
            ev_bps: evBps,
            want_bps: wantBps
          });
          return;
        }
      } else {
        logger.log("force_exec_enabled", {
          path: atomicPath,
          amm_src: ammVenue,
          size_base: sizeBase,
          ev_quote_pre: evQuotePre,
          ev_bps: evBps,
          fixed_cost_pre: fixedCostPre,
          ...(isAmmAmm ? { amm_dst: ammDstVenue } : {})
        });
      }

      if (!isAmmAmm && !phoenix?.market) {
        logger.log("submit_error", { where: "maybe_execute", error: "missing_phoenix_market" });
        return;
      }

      const resolvePoolId = (venue: string, poolId: string): string => {
        if (poolId) return poolId;
        if (venue === "raydium") return (process.env.RAYDIUM_POOL_ID ?? process.env.RAYDIUM_POOL_ID_SOL_USDC ?? DEFAULT_RAYDIUM_POOL_ID).trim();
        if (venue === "orca") return (process.env.ORCA_POOL_ID ?? DEFAULT_ORCA_POOL_ID).trim();
        return poolId;
      };

      type BuiltLeg = { ixs: TransactionInstruction[]; lookupTables: PublicKey[] };

      const buildAmmLeg = async (leg: {
        venue: string;
        poolId: string;
        poolKind?: string;
        baseIn: boolean;
        sizeBase: number;
        refPx: number;
        label: string;
      }): Promise<BuiltLeg> => {
        const venue = leg.venue.toLowerCase();
        const poolKind = (leg.poolKind ?? "").toLowerCase();
        const poolId = resolvePoolId(venue, leg.poolId);
        if (!poolId) {
          throw new Error(`missing_pool_id_${venue}`);
        }
        if (!(leg.refPx > 0)) {
          throw new Error(`${venue}_no_ref_px`);
        }

        if (venue === "raydium" && poolKind === "clmm") {
          const amountInAtoms = leg.baseIn
            ? uiToAtoms(leg.sizeBase, 9)
            : uiToAtoms(leg.sizeBase * leg.refPx, 6);

          const expectedOutAtoms = leg.baseIn
            ? uiToAtoms(leg.sizeBase * leg.refPx, 6)
            : uiToAtoms(leg.sizeBase, 9);

          const clmm = await buildRaydiumClmmSwapIx({
            connection: this.conn,
            user: this.payer.publicKey,
            poolId,
            baseIn: leg.baseIn,
            amountInAtoms,
            expectedOutAtoms,
            slippageBps: SLIPPAGE_BPS,
          });
          if (!clmm.ok) throw new Error(clmm.reason);
          const ixs = clmm.ixs;
          assertIxArray(ixs, "raydium_clmm");
          logger.log("raydium_clmm_build_ok", { ixs: ixs.length, pool: poolId, leg: leg.label });
          return { ixs, lookupTables: clmm.lookupTables ?? [] };
        }

        if (venue === "raydium") {
          const poolPk = new PublicKey(poolId);
          const meta = await ensureRaydiumPoolMeta(this.conn, poolPk);
          const amountInAtoms = leg.baseIn
            ? uiToAtoms(leg.sizeBase, 9)
            : uiToAtoms(leg.sizeBase * leg.refPx, 6);

          const dynExtra = Number.parseFloat(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? "0");
          const bufferBps = Number.parseFloat(process.env.RAYDIUM_MINOUT_BUFFER_BPS ?? "0");
          const usedSlip = Math.max(0, SLIPPAGE_BPS + dynExtra + bufferBps);

          const inMint: PublicKey = leg.baseIn ? meta.baseMint : meta.quoteMint;
          const outMint: PublicKey = leg.baseIn ? meta.quoteMint : meta.baseMint;

          let outAtoms: bigint;
          if (leg.baseIn) {
            const inUi = Number(amountInAtoms) / 1e9;
            const outUi = inUi * leg.refPx;
            outAtoms = BigInt(Math.floor(outUi * 1e6));
          } else {
            const inUi = Number(amountInAtoms) / 1e6;
            const outUi = inUi / leg.refPx;
            outAtoms = BigInt(Math.floor(outUi * 1e9));
          }
          const minOut = applyBpsDownBig(outAtoms, usedSlip);

          const ixs = await buildRaydiumCpmmSwapIx({
            connection: this.conn,
            owner: this.payer.publicKey,
            poolId: poolPk,
            inMint,
            outMint,
            amountIn: amountInAtoms,
            amountOutMin: minOut,
          });
          assertIxArray(ixs, "raydium_cpmm");
          logger.log("raydium_build_ok", { ixs: ixs.length, pool: poolId, leg: leg.label });
          return { ixs, lookupTables: [] };
        }

        if (venue === "orca") {
          const whirlpoolPk = new PublicKey(poolId);
          const amountInAtoms = leg.baseIn
            ? uiToAtoms(leg.sizeBase, 9)
            : uiToAtoms(leg.sizeBase * leg.refPx, 6);
          const built = await buildOrcaWhirlpoolSwapIx({
            connection: this.conn,
            user: this.payer.publicKey,
            poolId: whirlpoolPk.toBase58(),
            baseIn: leg.baseIn,
            amountInAtoms,
            slippageBps: SLIPPAGE_BPS,
          });
          if (!built.ok) throw new Error(built.reason);
          const ixs = built.ixs;
          assertIxArray(ixs, "orca");
          logger.log("orca_build_ok", { ixs: ixs.length, pool: whirlpoolPk.toBase58(), leg: leg.label });
          return { ixs, lookupTables: [] };
        }

        throw new Error(`unsupported_amm_venue_${venue}`);
      };

      // ── Build legs ─────────────────────────────────────────────────────
      let phxIxs: TransactionInstruction[] = [];
      let ammSrcIxs: TransactionInstruction[] = [];
      let ammDstIxs: TransactionInstruction[] = [];
      const lutSet = new Map<string, PublicKey>();
      const pushLuts = (luts: PublicKey[] = []) => {
        for (const pk of luts) {
          if (!pk) continue;
          lutSet.set(pk.toBase58(), pk);
        }
      };

      if (isAmmAmm) {
        const srcPoolId = resolvePoolId(ammVenue, poolFromPayload);
        const dstPoolId = resolvePoolId(ammDstVenue, ammDstPoolId);
        if (!srcPoolId || !dstPoolId) {
          logger.log("submit_error", { where: "amm_amm_build", error: "missing_pool_id", srcPoolId, dstPoolId });
          return;
        }
        const srcLeg = await buildAmmLeg({
          venue: ammVenue,
          poolId: srcPoolId,
          poolKind,
          baseIn: false, // quote -> base
          sizeBase,
          refPx: buy_px,
          label: "src",
        });
        const dstLeg = await buildAmmLeg({
          venue: ammDstVenue || ammVenue,
          poolId: dstPoolId,
          poolKind: ammDstPoolKind,
          baseIn: true, // base -> quote
          sizeBase,
          refPx: sell_px,
          label: "dst",
        });
        ammSrcIxs = srcLeg.ixs;
        ammDstIxs = dstLeg.ixs;
        pushLuts(srcLeg.lookupTables);
        pushLuts(dstLeg.lookupTables);
      } else {
        const market = new PublicKey(phoenix.market);
        phxIxs = Array.isArray(payload?.phxIxs) ? toIxArray(payload.phxIxs) : [];
        if (!phxIxs.length) {
          const limitPx = Number(phoenix.limit_px ?? phoenix.limitPx ?? (payload?.sell_px ?? payload?.buy_px));
          const slippageBps = Number(process.env.PHOENIX_SLIPPAGE_BPS ?? "3");
          logger.log("phoenix_build_params", { market: market.toBase58(), side: phoenix.side, sizeBase, limitPx, slippageBps });
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
        }
        assertIxArray(phxIxs, "phoenix");

        const srcPoolId = resolvePoolId(ammVenue, poolFromPayload);
        const leg = await buildAmmLeg({
          venue: ammVenue,
          poolId: srcPoolId,
          poolKind,
          baseIn: atomicPath === "PHX->AMM",
          sizeBase,
          refPx: atomicPath === "PHX->AMM" ? sell_px : buy_px,
          label: "amm",
        });
        ammSrcIxs = leg.ixs;
        pushLuts(leg.lookupTables);
      }

      // ── PRE-TX BALANCES & LOG (Step 7a) ────────────────────────────────
      const pre = await getUiBalances(this.conn, this.payer.publicKey);
      logger.log("pre_tx_balances", {
        path: atomicPath,
        amm_src: ammVenue,
        amm_dst: isAmmAmm ? ammDstVenue : undefined,
        size_base: sizeBase,
        buy_px,
        sell_px,
        PNL_SAFETY_BPS,
        forced: FORCE || undefined,
        FIXED_TX_COST_QUOTE: USE_DYNAMIC_TX_COST ? undefined : FIXED_TX_COST_QUOTE_FALLBACK,
        fixed_tx_cost_quote_est: fixedCostPre,
        ...pre,
      });

      // ── BUILD ATOMIC (for simulation) (Step 4) ─────────────────────────
      const preIxs = buildPreIxs(CU_LIMIT, usedCuPrice);

      const instructions = isAmmAmm
        ? [...preIxs, ...ammSrcIxs, ...ammDstIxs]
        : [...preIxs, ...phxIxs, ...ammSrcIxs];

      const lutAccounts = await this.getLookupTableAccounts(Array.from(lutSet.values()));
      if (lutSet.size && lutAccounts.length < lutSet.size) {
        logger.log("lookup_table_incomplete", {
          requested: Array.from(lutSet.keys()),
          fetched: lutAccounts.length,
        });
        return;
      }

      const latest = await this.conn.getLatestBlockhash("processed");
      const msg = new TransactionMessage({
        payerKey: this.payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions,
      }).compileToV0Message(lutAccounts);
      const tx = new VersionedTransaction(msg);
      tx.sign([this.payer]);

      // ── RPC SIM (Step 6) ───────────────────────────────────────────────
      const sim = await rpcSimTx(this.conn, tx, { sigVerify: true, commitment: "processed" });

      // Compute final fixed cost using simulated units (fallback to pre-estimate)
      const unitsUsed = Number.isFinite(Number(sim.unitsConsumed)) ? Number(sim.unitsConsumed) : EST_UNITS_BEFORE_SIM;
      const fixedCostFinal = USE_DYNAMIC_TX_COST
        ? estimateFixedCostQuote(unitsUsed, usedCuPrice, avgPx)
        : FIXED_TX_COST_QUOTE_FALLBACK;

      // Gate again if the dynamic cost made this unprofitable
      const evQuoteFinal = (sell_px - buy_px) * sizeBase - fixedCostFinal;
      if (!FORCE && !(evQuoteFinal > 0)) {
        logger.log("submit_error", {
          where: "rpc_sim_ev_gate",
          error: "negative_expected_pnl_after_sim",
          sizeBase,
          buy_px,
          sell_px,
          ev_quote: evQuoteFinal,
          fixed_cost_final: fixedCostFinal,
          units_used: unitsUsed
        });
        return;
      }

      logger.log("rpc_sim", {
        ok: sim.ok,
        units: sim.unitsConsumed,
        logs_tail: sim.logs?.slice?.(-6),
        err: sim.err,
      });

      const gate = await canActuallySendNow(this.conn, { env: process.env, owner: this.payer.publicKey });
      if (!gate) {
        logger.log("send_gate_off", { reason: "sim_only_or_unfunded", sim_ok: sim.ok, err: sim.err });
        return;
      }

      if (!sim.ok) {
        logger.log("submit_error", { where: "rpc_sim", error: sim.err ?? "simulation_failed" });
        return;
      }

      // ── SUBMIT ─────────────────────────────────────────────────────────
      const only = isAmmAmm
        ? "both"
        : process.env.ONLY_PHX
          ? "phx"
          : process.env.ONLY_RAY
            ? "ray"
            : undefined;
      const total = instructions.length;
      logger.log("submit_ixs", {
        label: isAmmAmm ? "amm-amm" : "atomic",
        phx: phxIxs.length,
        amm_src: ammSrcIxs.length,
        amm_dst: ammDstIxs.length,
        total,
      });

      const sig = await submitAtomic({
        connection: this.conn,
        owner: this.payer,
        preIxs,
        phxIxs: isAmmAmm ? ammSrcIxs : phxIxs,
        rayIxs: isAmmAmm ? ammDstIxs : ammSrcIxs,
        only: only as any,
        lookupTableAccounts: lutAccounts,
      });

      logger.log("submitted_tx", {
        path: atomicPath,
        amm_src: ammVenue,
        amm_dst: isAmmAmm ? ammDstVenue : undefined,
        size_base: sizeBase,
        ix_count: total,
        cu_limit: CU_LIMIT,
        sig,
        live: true,
        shadow: false,
      });

      // ── CONFIRM ────────────────────────────────────────────────────────
      const t0 = Date.now();
      const conf = await this.conn.confirmTransaction(sig, CONFIRM_LEVEL as any);
      const conf_ms = Date.now() - t0;
      const slot = (conf as any)?.context?.slot ?? null;

      // ── POST-TX BALANCES + REALIZED (Step 7b) ─────────────────────────
      const post = await getUiBalances(this.conn, this.payer.publicKey);
      const realized = {
        realized_usdc_delta: Number((post.usdcUi - pre.usdcUi).toFixed(6)),
        realized_wsol_delta: Number((post.wsolUi - pre.wsolUi).toFixed(9)),
        sol_lamports_delta: post.solLamports - pre.solLamports,
      };
      logger.log("post_tx_balances", { sig, slot, conf_ms, ...post, ...realized });

      logger.log("realized_summary", {
        sig,
        path: atomicPath,
        amm_src: ammVenue,
        amm_dst: isAmmAmm ? ammDstVenue : undefined,
        size_base: sizeBase,
        buy_px, sell_px,
        expected_ev_quote: Number(((sell_px - buy_px) * sizeBase - fixedCostFinal).toFixed(6)),
        ...realized
      });

      logger.log("landed", { sig, slot, conf_ms, shadow: false });
    } catch (err) {
      const e = err as any;
      logger.log("submit_error", { where: "maybe_execute", error: String(e?.message ?? e) });
    }
  }
}
