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
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { logger, logTxExecEvent } from "../ml_logger.js";
import { submitAtomic, buildPreIxs } from "../tx/submit.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { withRpcBackoff } from "../util/rpc_backoff.js";
import { rpcSimFn as rpcSimTx } from "../tx/rpcSim.js";            // <- NEW
import { canActuallySendNow } from "../tx/sendGate.js";           // <- NEW
import { getRpcP95Ms } from "../runtime/metrics.js";              // <- NEW
import { buildExecutionLegSequence } from "./transaction_builder.js";
import type { ExecutionLeg, AmmExecutionLeg, PhoenixExecutionLeg } from "../types/execution.js";

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

const SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || "50");
const EXEC_MODE = String(process.env.EXEC_MODE ?? "LIVE").trim().toUpperCase();
const SIM_ONLY = EXEC_MODE === "SIM_ONLY";

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

function readU32LE(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(offset, true);
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

function extractComputeBudgetSettings(ixs: TransactionInstruction[]): { limit?: number; price?: number } {
  const settings: { limit?: number; price?: number } = {};
  for (const ix of ixs) {
    if (!ix || !ix.programId?.equals?.(ComputeBudgetProgram.programId)) continue;
    if (!ix.data || ix.data.length === 0) continue;
    const discriminator = ix.data[0];
    if (discriminator === 2 && ix.data.length >= 5) {
      const units = readU32LE(ix.data, 1);
      settings.limit = Math.max(settings.limit ?? 0, units);
    } else if (discriminator === 3 && ix.data.length >= 9) {
      const price = Number(readU64LE(ix.data, 1));
      settings.price = Math.max(settings.price ?? 0, price);
    }
  }
  return settings;
}

function stripComputeBudgetIxs(ixs: TransactionInstruction[]): TransactionInstruction[] {
  return ixs.filter((ix) => !ix.programId?.equals?.(ComputeBudgetProgram.programId));
}

function dedupeComputeBudgetIxs(ixs: TransactionInstruction[]): TransactionInstruction[] {
  const seen = new Set<string>();
  const programId = ComputeBudgetProgram.programId.toBase58();
  const out: TransactionInstruction[] = [];
  for (const ix of ixs) {
    if (!ix || !ix.programId?.equals?.(ComputeBudgetProgram.programId)) {
      out.push(ix);
      continue;
    }
    const tag = (ix.data && ix.data.length > 0) ? ix.data[0] : -1;
    const key = `${programId}:${tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ix);
  }
  return out;
}

// Types / helpers
export type AtomicPath = string;
function uiToAtoms(ui: number, decimals: number): bigint { return BigInt(Math.floor(ui * 10 ** decimals)); }
function applyBpsDownBig(x: bigint, bps: number): bigint {
  const BPS = 10_000n; const b = BigInt(Math.max(0, Math.min(10_000, Math.ceil(bps)))); return (x * (BPS - b)) / BPS;
}

function toPathLabel(path: AtomicPath): string | undefined {
  const p = String(path || "").toLowerCase();
  if (!p) return undefined;
  if (p === "phx->amm") return "phx_amm";
  if (p === "amm->phx") return "amm_phx";
  if (p === "amm->amm") return "amm_amm";
  const norm = p.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return norm || undefined;
}

function classifySimError(err: unknown): { type?: string; message?: string; raw?: string } {
  if (err == null) return {};
  const raw = typeof err === "string" ? err : JSON.stringify(err);
  if (!raw) return {};
  const lower = raw.toLowerCase();
  let type: string | undefined;
  if (raw.includes("InsufficientFundsForFee")) type = "InsufficientFundsForFee";
  else if (lower.includes("instructionerror")) type = "InstructionError";
  else if (lower.includes("blockhashnotfound")) type = "BlockhashNotFound";
  else if (lower.includes("accountnotfound")) type = "AccountNotFound";
  else if (lower.includes("slippage")) type = "Slippage";
  const message = raw.length > 240 ? raw.slice(0, 240) : raw;
  return { type, message, raw };
}

function isAmmExecutionLeg(leg: ExecutionLeg): leg is AmmExecutionLeg {
  return leg.kind === "amm";
}

function isPhoenixExecutionLeg(leg: ExecutionLeg): leg is PhoenixExecutionLeg {
  return leg.kind === "phoenix";
}

function normalizeExecutionLeg(raw: any): ExecutionLeg | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind ?? "").toLowerCase();
  if (kind === "phoenix") {
    const market = String(raw.market ?? raw.phoenixMarket ?? "").trim();
    const side = String(raw.side ?? raw.direction ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
    const sizeBase = Number(raw.sizeBase ?? raw.size_base ?? raw.size ?? 0);
    const limitPx = Number(raw.limitPx ?? raw.limit_px ?? raw.price ?? 0);
    if (!(market && sizeBase > 0 && limitPx > 0)) return null;
    const slippageBps = raw.slippageBps != null ? Number(raw.slippageBps) : undefined;
    return { kind: "phoenix", market, side, sizeBase, limitPx, slippageBps };
  }
  if (kind === "amm") {
    const venue = String(raw.venue ?? raw.ammVenue ?? raw.amm_venue ?? "").trim().toLowerCase();
    const poolId = String(raw.poolId ?? raw.pool_id ?? raw.pool ?? "").trim();
    const directionRaw = String(raw.direction ?? raw.flow ?? "baseToQuote").toLowerCase();
    const direction: "baseToQuote" | "quoteToBase" = directionRaw === "quotetobase" ? "quoteToBase" : directionRaw === "baseToquote" ? "baseToQuote" : (directionRaw === "quotetobase" || directionRaw === "qtb") ? "quoteToBase" : directionRaw === "base" ? "baseToQuote" : (directionRaw === "quoteToBase" ? "quoteToBase" : "baseToQuote");
    const sizeBase = Number(raw.sizeBase ?? raw.size_base ?? raw.size ?? 0);
    const refPx = Number(raw.refPx ?? raw.ref_px ?? raw.price ?? 0);
    if (!(venue && sizeBase > 0 && refPx > 0)) return null;
    const poolKind = raw.poolKind ?? raw.pool_kind ?? undefined;
    const label = raw.label ?? undefined;
    const baseMint = raw.baseMint ?? raw.base_mint ?? undefined;
    const quoteMint = raw.quoteMint ?? raw.quote_mint ?? undefined;
    return {
      kind: "amm",
      venue,
      poolId,
      poolKind: typeof poolKind === "string" ? poolKind : undefined,
      direction: direction === "quoteToBase" ? "quoteToBase" : "baseToQuote",
      sizeBase,
      refPx,
      baseMint: typeof baseMint === "string" ? baseMint : undefined,
      quoteMint: typeof quoteMint === "string" ? quoteMint : undefined,
      label: typeof label === "string" ? label : undefined,
    };
  }
  return null;
}

function buildLegacyLegs(payload: any): ExecutionLeg[] {
  const legs: ExecutionLeg[] = [];
  const path = (payload?.path as AtomicPath) ?? "PHX->AMM";
  const sizeBase = Number(payload?.size_base ?? payload?.trade_size_base ?? 0);
  if (!(sizeBase > 0)) return legs;
  const market = String(payload?.phoenix?.market ?? payload?.phoenix_market ?? "").trim();
  const buyPx = Number(payload?.buy_px ?? 0);
  const sellPx = Number(payload?.sell_px ?? 0);
  const ammVenue = String(payload?.amm_venue ?? payload?.amm?.venue ?? "raydium").toLowerCase();
  const poolId = String(payload?.amm_pool_id ?? payload?.amm?.pool ?? "").trim();
  const poolKind = String(payload?.amm_meta?.poolKind ?? payload?.amm?.meta?.poolKind ?? "").trim();
  const dstVenue = String(payload?.amm_dst_venue ?? payload?.amm_dst?.venue ?? "").toLowerCase();
  const dstPoolId = String(payload?.amm_dst_pool_id ?? payload?.amm_dst?.pool ?? "").trim();
  const dstPoolKind = String(payload?.amm_dst_meta?.poolKind ?? payload?.amm_dst?.meta?.poolKind ?? "").trim();

  if (path === "PHX->AMM") {
    if (market) legs.push({ kind: "phoenix", market, side: "buy", sizeBase, limitPx: buyPx });
    legs.push({ kind: "amm", venue: ammVenue, poolId, poolKind, direction: "baseToQuote", sizeBase, refPx: sellPx, label: "amm" });
  } else if (path === "AMM->PHX") {
    legs.push({ kind: "amm", venue: ammVenue, poolId, poolKind, direction: "quoteToBase", sizeBase, refPx: buyPx, label: "amm" });
    if (market) legs.push({ kind: "phoenix", market, side: "sell", sizeBase, limitPx: sellPx });
  } else if (path === "AMM->AMM") {
    legs.push({ kind: "amm", venue: ammVenue, poolId, poolKind, direction: "quoteToBase", sizeBase, refPx: buyPx, label: "src" });
    legs.push({ kind: "amm", venue: dstVenue || ammVenue, poolId: dstPoolId, poolKind: dstPoolKind, direction: "baseToQuote", sizeBase, refPx: sellPx, label: "dst" });
  }

  return legs.filter(Boolean);
}

function extractExecutionLegs(payload: any): ExecutionLeg[] {
  if (Array.isArray(payload?.legs)) {
    const normalized = payload.legs.map(normalizeExecutionLeg);
    return normalized.filter((leg: ExecutionLeg | null): leg is ExecutionLeg => leg != null);
  }
  return buildLegacyLegs(payload);
}

function inferAtomicPathFromLegs(legs: ExecutionLeg[], fallback: AtomicPath): AtomicPath {
  if (legs.length > 2) return "MULTI";
  if (!legs.length) return fallback;
  if (legs.every(isAmmExecutionLeg)) return "AMM->AMM";
  if (legs.length >= 2 && isPhoenixExecutionLeg(legs[0]) && isAmmExecutionLeg(legs[1])) return "PHX->AMM";
  if (legs.length >= 2 && isAmmExecutionLeg(legs[0]) && legs.slice(1).some(isPhoenixExecutionLeg)) return "AMM->PHX";
  return fallback;
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
      const legs = extractExecutionLegs(payload);
      if (!legs.length) {
        logger.log("submit_error", { where: "maybe_execute", error: "no_execution_legs" });
        return;
      }

      const isMultiHop = legs.length > 2;
      const multiHopExecEnabled = envTrue("ENABLE_MULTI_HOP_EXEC");
      if (isMultiHop && !multiHopExecEnabled) {
        logger.log("multi_hop_execution_disabled", {
          legs: legs.length,
          path: payload?.path ?? inferAtomicPathFromLegs(legs, "PHX->AMM"),
        });
        return;
      }

      const fallbackPath = (payload?.path as AtomicPath) || "PHX->AMM";
      const atomicPath = inferAtomicPathFromLegs(legs, fallbackPath);
      const pathLabel = toPathLabel(atomicPath);
      const isAmmAmm = atomicPath === "AMM->AMM";
      const attemptId = typeof payload?.attempt_id === "string" ? payload.attempt_id : undefined;

      const ammLegs = legs.filter(isAmmExecutionLeg);
      const phoenixLegs = legs.filter(isPhoenixExecutionLeg);
      const primaryAmmLeg = ammLegs[0] ?? null;
      const secondaryAmmLeg = ammLegs[1] ?? null;
      const primaryPhoenixLeg = phoenixLegs[0] ?? null;

      let sizeBase = Number(payload?.size_base ?? payload?.trade_size_base ?? primaryAmmLeg?.sizeBase ?? primaryPhoenixLeg?.sizeBase ?? 0);

      let buy_px = Number(payload?.buy_px ?? 0);
      if (!(buy_px > 0)) {
        if (atomicPath === "PHX->AMM" && primaryPhoenixLeg) buy_px = primaryPhoenixLeg.limitPx;
        else if (primaryAmmLeg) buy_px = primaryAmmLeg.refPx;
      }

      let sell_px = Number(payload?.sell_px ?? 0);
      if (!(sell_px > 0)) {
        if (atomicPath === "AMM->PHX" && primaryPhoenixLeg) sell_px = primaryPhoenixLeg.limitPx;
        else if (atomicPath === "PHX->AMM" && primaryAmmLeg) sell_px = primaryAmmLeg.refPx;
        else if (secondaryAmmLeg) sell_px = secondaryAmmLeg.refPx;
      }

      const ammVenue = String(
        payload?.amm_venue ??
        payload?.amm?.venue ??
        payload?.ammVenue ??
        primaryAmmLeg?.venue ??
        "raydium"
      ).toLowerCase() as "raydium" | "orca" | "lifinity" | "meteora";

      const poolFromPayload = String(
        payload?.amm_pool_id ??
        payload?.amm?.pool ??
        primaryAmmLeg?.poolId ??
        ""
      ).trim();

      const poolKind = String(
        payload?.amm_meta?.poolKind ??
        payload?.amm?.meta?.poolKind ??
        payload?.amm_pool_kind ??
        primaryAmmLeg?.poolKind ??
        ""
      )
        .trim()
        .toLowerCase();

      const ammDstVenue = String(
        payload?.amm_dst_venue ??
        payload?.amm_dst?.venue ??
        secondaryAmmLeg?.venue ??
        ""
      ).toLowerCase() as "raydium" | "orca" | "lifinity" | "meteora" | "";

      const ammDstPoolId = String(
        payload?.amm_dst_pool_id ??
        payload?.amm_dst?.pool ??
        secondaryAmmLeg?.poolId ??
        ""
      ).trim();

      const ammDstPoolKind = String(
        payload?.amm_dst_meta?.poolKind ??
        payload?.amm_dst?.meta?.poolKind ??
        secondaryAmmLeg?.poolKind ??
        ""
      )
        .trim()
        .toLowerCase();

      const baseMintStr = (String(payload?.base_mint ?? payload?.amm_meta?.baseMint ?? primaryAmmLeg?.baseMint ?? "").trim()) || DEFAULT_BASE_MINT.toBase58();
      const quoteMintStr = (String(payload?.quote_mint ?? payload?.amm_meta?.quoteMint ?? primaryAmmLeg?.quoteMint ?? "").trim()) || DEFAULT_QUOTE_MINT.toBase58();
      const dstBaseMintStr = (String(payload?.amm_dst_meta?.baseMint ?? secondaryAmmLeg?.baseMint ?? baseMintStr).trim()) || baseMintStr;
      const dstQuoteMintStr = (String(payload?.amm_dst_meta?.quoteMint ?? secondaryAmmLeg?.quoteMint ?? quoteMintStr).trim()) || quoteMintStr;

      const phoenixMarket = String(payload?.phoenix?.market ?? primaryPhoenixLeg?.market ?? "").trim();
      const hasPhoenixLeg = !!primaryPhoenixLeg || !!phoenixMarket;

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

      if (!isAmmAmm && !hasPhoenixLeg) {
        logger.log("submit_error", { where: "maybe_execute", error: "missing_phoenix_market" });
        return;
      }

      const resolvePoolId = (venue: string, poolId: string): string => {
        if (poolId) return poolId;
        if (venue === "raydium") return (process.env.RAYDIUM_POOL_ID ?? process.env.RAYDIUM_POOL_ID_SOL_USDC ?? DEFAULT_RAYDIUM_POOL_ID).trim();
        if (venue === "orca") return (process.env.ORCA_POOL_ID ?? DEFAULT_ORCA_POOL_ID).trim();
        if (venue === "meteora") return poolId;
        return poolId;
      };

      // ── Build legs ─────────────────────────────────────────────────────
      const legMintHints = (leg: ExecutionLeg): { baseMint?: string; quoteMint?: string } => {
        if (!isAmmExecutionLeg(leg)) return {};
        if (leg.label === "dst") return { baseMint: dstBaseMintStr, quoteMint: dstQuoteMintStr };
        return { baseMint: baseMintStr, quoteMint: quoteMintStr };
      };

      const builtLegs = await buildExecutionLegSequence({
        connection: this.conn,
        payer: this.payer,
        legs,
        slippageBps: SLIPPAGE_BPS,
        phoenixSlippageBps: Number(process.env.PHOENIX_SLIPPAGE_BPS ?? "3"),
        resolvePoolId,
        getMintHints: legMintHints,
      });

      const lutSet = new Map<string, PublicKey>();
      for (const built of builtLegs) {
        for (const pk of built.lookupTables) {
          if (!pk) continue;
          lutSet.set(pk.toBase58(), pk);
        }
      }

      const phoenixBuilt = builtLegs.filter((b) => b.kind === "phoenix");
      const ammBuilt = builtLegs.filter((b) => b.kind === "amm");

      const phxIxsRaw = phoenixBuilt.flatMap((b) => b.instructions);
      const ammSrcIxsRaw = isAmmAmm
        ? (ammBuilt[0]?.instructions ?? [])
        : ammBuilt.flatMap((b) => b.instructions);
      const ammDstIxsRaw = isAmmAmm ? (ammBuilt[1]?.instructions ?? []) : [];

      if (isAmmAmm && (!ammSrcIxsRaw.length || !ammDstIxsRaw.length)) {
        logger.log("submit_error", { where: "amm_amm_build", error: "missing_leg_ixs" });
        return;
      }

      const computeBudgetHints = extractComputeBudgetSettings([...phxIxsRaw, ...ammSrcIxsRaw, ...ammDstIxsRaw]);
      const mergedCuLimit = Math.max(CU_LIMIT, computeBudgetHints.limit ?? 0);
      const mergedCuPrice = Math.max(usedCuPrice, computeBudgetHints.price ?? 0);

      const phxIxs = stripComputeBudgetIxs(phxIxsRaw);
      const ammSrcIxs = stripComputeBudgetIxs(ammSrcIxsRaw);
      const ammDstIxs = stripComputeBudgetIxs(ammDstIxsRaw);

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
      const preIxs = buildPreIxs(mergedCuLimit, mergedCuPrice);

      const instructions = dedupeComputeBudgetIxs(
        isAmmAmm
          ? [...preIxs, ...ammSrcIxs, ...ammDstIxs]
          : [...preIxs, ...phxIxs, ...ammSrcIxs]
      );

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
      const txVenueDst = isAmmAmm ? ammDstVenue : hasPhoenixLeg ? "phoenix" : undefined;
      const txPoolSrc = poolFromPayload || undefined;
      const txPoolDst = isAmmAmm ? (ammDstPoolId || undefined) : undefined;

      logger.log("tx_sim_start", {
        attempt_id: attemptId,
        path: atomicPath,
        size_base: sizeBase,
        amm_src: ammVenue,
        amm_dst: isAmmAmm ? ammDstVenue : undefined,
        exec_mode: EXEC_MODE,
      });
      if (attemptId) {
        logTxExecEvent({
          phase: "sim_start",
          attempt_id: attemptId,
          exec_mode: EXEC_MODE,
          path_label: pathLabel,
          venue_src: ammVenue,
          venue_dst: txVenueDst,
          pool_src: txPoolSrc,
          pool_dst: txPoolDst,
          size_base: sizeBase,
        });
      }
      if (SIM_ONLY) {
        logger.log("tx_sim_debug", {
          attempt_id: attemptId,
          path: atomicPath,
          path_label: isAmmAmm ? "amm_amm" : hasPhoenixLeg ? "phx_amm" : "amm_only",
          exec_mode: EXEC_MODE,
          ix_count: instructions.length,
          program_ids: instructions.map((ix) => ix.programId.toBase58?.() ?? String(ix.programId)),
        });
      }
      const sim = await rpcSimTx(this.conn, tx, { sigVerify: true, commitment: "processed" });
      const simLogBase = {
        attempt_id: attemptId,
        path: atomicPath,
        size_base: sizeBase,
        amm_src: ammVenue,
        amm_dst: isAmmAmm ? ammDstVenue : undefined,
        exec_mode: EXEC_MODE,
        units: sim.unitsConsumed,
        err: sim.err,
        logs_tail: sim.logs?.slice?.(-6),
      };
      const simUnits = Number.isFinite(sim.unitsConsumed) ? Number(sim.unitsConsumed) : null;
      const simLogsTail = Array.isArray(sim.logs) ? sim.logs : simLogBase.logs_tail;
      if (sim.ok) {
        logger.log("tx_sim_ok", simLogBase);
        if (attemptId) {
          logTxExecEvent({
            phase: "sim_ok",
            attempt_id: attemptId,
            exec_mode: EXEC_MODE,
            path_label: pathLabel,
            venue_src: ammVenue,
            venue_dst: txVenueDst,
            pool_src: txPoolSrc,
            pool_dst: txPoolDst,
            size_base: sizeBase,
            units_consumed: simUnits,
            logs_tail: simLogsTail ?? undefined,
            sim_ok: true,
          });
        }
      } else {
        logger.log("tx_sim_err", simLogBase);
        if (attemptId) {
          const simErrInfo = classifySimError(sim.err);
          logTxExecEvent({
            phase: "sim_err",
            attempt_id: attemptId,
            exec_mode: EXEC_MODE,
            path_label: pathLabel,
            venue_src: ammVenue,
            venue_dst: txVenueDst,
            pool_src: txPoolSrc,
            pool_dst: txPoolDst,
            size_base: sizeBase,
            units_consumed: simUnits,
            logs_tail: simLogsTail ?? undefined,
            sim_ok: false,
            sim_err_type: simErrInfo.type,
            sim_err_message: simErrInfo.message,
            sim_err_raw: simErrInfo.raw,
          });
        }
        return;
      }

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
          units_used: unitsUsed,
          attempt_id: attemptId,
        });
        return;
      }

      logger.log("rpc_sim", {
        attempt_id: attemptId,
        ok: sim.ok,
        units: sim.unitsConsumed,
        logs_tail: sim.logs?.slice?.(-6),
        err: sim.err,
      });

      if (SIM_ONLY) {
        logger.log("tx_sim_dry_run_complete", {
          attempt_id: attemptId,
          path: atomicPath,
          size_base: sizeBase,
          amm_src: ammVenue,
          amm_dst: isAmmAmm ? ammDstVenue : undefined,
          exec_mode: EXEC_MODE,
          simulated_ev_quote: Number(evQuoteFinal.toFixed(6)),
          fixed_cost_quote: fixedCostFinal,
          units_used: unitsUsed,
        });
        return;
      }

      const gate = await canActuallySendNow(this.conn, { env: process.env, owner: this.payer.publicKey });
      if (!gate) {
        logger.log("send_gate_off", { reason: "sim_only_or_unfunded", sim_ok: sim.ok, err: sim.err, attempt_id: attemptId });
        return;
      }

      if (!sim.ok) {
        logger.log("submit_error", { where: "rpc_sim", error: sim.err ?? "simulation_failed", attempt_id: attemptId });
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
        cu_limit: mergedCuLimit,
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
