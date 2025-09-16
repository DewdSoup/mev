// services/arb-mm/src/edge/joiner.ts
// Multi-venue joiner (Raydium & Orca) with concurrent per-venue route evaluation.
// NOW config-driven via adapters manifest, still keeps fast publisher snapshots.
// - Reads pairs.json venues[] and gates to only configured pools (Broaden venue by config, not code).
// - Uses adapters.manifest().quote() first (fee/slippage aware), then falls back to local CPMM/CLMM paths.
// - Tracks AMM↔AMM opportunities (configurable), still emits PHX features only for PHX paths.
// - Optional RPC sim tolerance gate for PHX paths.
// - Orca CLMM quoting prefers adapter quoter; hard fallback keeps "works without funding."

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { logger } from "../ml_logger.js";
import { synthFromMid, type PhoenixBook } from "../syntheticPhoenix.js";
import { emitFeature, featureFromEdgeAndDecision } from "../feature_sink.js";
import { noteDecision } from "../risk.js";
import type { SlipMode } from "../config.js";
import {
  optimizeSize,
  type CpmmReserves as SizeCpmmReserves,
  type PhoenixBook as SizePhoenixBook,
  type SizeOptInputs,
} from "../executor/size.js";
import {
  orcaAvgBuyQuotePerBase,
  orcaAvgSellQuotePerBase,
} from "../executor/orca_quoter.js";

// NEW: config-driven adapters
import { getAdapter } from "../adapters/manifest.js";
type QuoteReq = {
  poolId: string;
  side: "buy" | "sell";           // buy = want BASE (pay QUOTE) ; sell = sell BASE (get QUOTE)
  sizeBase: number;               // size in BASE units
  slippageBps: number;
  baseMint?: string;
  quoteMint?: string;
};
// IMPORTANT: align with adapter QuoteResp (error branch uses `err`, not `reason`)
type QuoteRes =
  | { ok: true; price: number; feeBps?: number; meta?: any }
  | { ok: false; err: string };

// ────────────────────────────────────────────────────────────────────────────
// Production constants (caps/guards)
const MAX_REALISTIC_PROFIT_BPS = Number(process.env.MAX_REALISTIC_PROFIT_BPS ?? 100);
const MIN_PROFITABLE_BPS = Number(process.env.MIN_PROFITABLE_BPS ?? 5);
const MAX_DAILY_TRADES = Number(process.env.MAX_DAILY_TRADES ?? 50);
const MAX_DAILY_VOLUME_QUOTE = Number(process.env.MAX_DAILY_VOLUME_QUOTE ?? 10000);
const PRICE_VALIDATION_WINDOW_BPS = Number(process.env.PRICE_VALIDATION_WINDOW_BPS ?? 200);

// Clamp for Orca exact-in/out to ensure SDK never sees 0
const MIN_ORCA_BASE_SIZE = Number(process.env.MIN_ORCA_BASE_SIZE ?? "0.000001");

// ────────────────────────────────────────────────────────────────────────────
// Staleness guard (inline helper)
function envInt(name: string, def: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}
const AMM_SLOT_MAX_LAG = envInt("AMM_SLOT_MAX_LAG", 8);
const AMM_SNAPSHOT_MAX_AGE_MS = envInt("AMM_SNAPSHOT_MAX_AGE_MS", envInt("PRICE_STALENESS_MS", 5000));

function staleReason(
  snap: { ts: number; slot?: number | null; venue: string; ammId: string },
  phoenixSlot?: number | null,
  now = Date.now()
): string | null {
  const ageMs = Math.max(0, now - (snap.ts || 0));
  if (ageMs > AMM_SNAPSHOT_MAX_AGE_MS) return `age_ms>${AMM_SNAPSHOT_MAX_AGE_MS}`;
  if (snap.slot != null && phoenixSlot != null) {
    const lag = phoenixSlot - snap.slot;
    if (lag > AMM_SLOT_MAX_LAG) return `slot_lag>${AMM_SLOT_MAX_LAG} (amm=${snap.slot} phoenix=${phoenixSlot})`;
  }
  return null;
}

function envTrue(name: string, def?: boolean): boolean {
  const d = def ?? false;
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return d;
}
function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Circuit breaker state
let dailyTrades = 0;
let dailyVolumeQuote = 0;
let lastResetDay = new Date().getUTCDate();

function nnum(x: any): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function round(n: any, p?: number): number {
  const num = typeof n === "bigint" ? Number(n) : typeof n === "string" ? Number(n) : Number(n);
  const places = p ?? 6;
  return Number.isFinite(num) ? Number(num.toFixed(places)) : Number.NaN;
}

// ────────────────────────────────────────────────────────────────────────────
// Types and state
type Mid = { px: number; ts: number };
type DepthSide = { px: number; qty: number };

type AmmKey = string; // `${venue}:${ammId}`
type AmmSnap = {
  venue: "raydium" | "orca" | string;
  ammId: string;
  px: number;
  ts: number;            // publisher-provided ts if available; else Date.now()
  slot?: number | null;  // optional publisher slot
  reserves?: { base: number; quote: number; baseDecimals: number; quoteDecimals: number };
  feeBps: number;
};

// Unified node abstraction for 2-leg paths
type VenueNode =
  | { kind: "phx"; id: "phoenix"; feeBps: number }
  | { kind: "amm"; id: string; feeBps: number; amm: AmmSnap };

export interface JoinerParams {
  minAbsBps: number;
  waitLogMs: number;
  thresholdBps: number;
  flatSlippageBps: number;
  tradeSizeBase: number;
  phoenixFeeBps: number;
  ammFeeBps: number;           // fallback only (per-venue/pool fee may arrive in payload/adapter)
  fixedTxCostQuote: number;

  decisionMinBase?: number;
  minBase?: number;
  minTradeBase?: number;
}

export interface JoinerCfg {
  bookTtlMs: number;
  activeSlippageMode: SlipMode;
  phoenixSlippageBps: number;
  cpmmMaxPoolTradeFrac: number;
  dynamicSlippageExtraBps: number;
  logSimFields: boolean;
  enforceDedupe: boolean;
  decisionBucketMs: number;
  decisionMinEdgeDeltaBps: number;
  useRpcSim: boolean;
  decisionMinBase?: number;
}

// NB: Keep DecisionHookDetails.path as a superset; callers can ignore AMM->AMM.
export type DecisionHookDetails = {
  path: "AMM->PHX" | "PHX->AMM" | "AMM->AMM";
  side: "buy" | "sell";
  buy_px: number;
  sell_px: number;
  rpc_eff_px?: number;
  recommended_size_base?: number;
  amm_venue?: string;
  amm_pool_id?: string;       // exact pool to hit
  amm_dst_venue?: string;     // for AMM->AMM
};

export type DecisionHook = (
  wouldTrade: boolean,
  edgeNetBps: number,
  expectedPnl: number,
  details?: DecisionHookDetails
) => void;

export type RpcSampleHook = (sample: { ms: number; blocked: boolean }) => void;

export type RpcSimFn = (input: {
  path: "AMM->PHX" | "PHX->AMM";
  sizeBase: number;
  ammMid: number;
  reserves?: { base: number; quote: number };
  ammFeeBps: number;
}) => Promise<{
  rpc_eff_px?: number;
  rpc_price_impact_bps?: number;
  rpc_sim_ms: number;
  rpc_sim_mode: string;
  rpc_sim_error?: string;
  rpc_qty_out?: number;
  rpc_units?: number;
  prioritization_fee?: number;
} | undefined>;

// ────────────────────────────────────────────────────────────────────────────
// Pairs config (broaden venues by config, not code)

type VenueCfg = { kind: string; id: string; poolKind?: string };
type PairCfg = {
  symbol: string;
  baseMint: string;
  quoteMint: string;
  phoenixMarket?: string;
  venues: VenueCfg[];
};

function readPairsConfig(): { pairs: PairCfg[] } | null {
  try {
    const p =
      process.env.PAIRS_JSON?.trim() ||
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "configs", "pairs.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(j?.pairs)) return j as { pairs: PairCfg[] };
  } catch (e) {
    logger.log("pairs_json_read_error", { err: String((e as any)?.message ?? e) });
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────

export class EdgeJoiner {
  private amms = new Map<AmmKey, AmmSnap>(); // multi-venue AMM snapshots
  private phxMid?: Mid;
  private phxBook: (PhoenixBook & {
    ts: number;
    book_method?: string;
    levels_bids?: DepthSide[];
    levels_asks?: DepthSide[];
  }) | null = null;

  private phxSlot?: number | null; // optional Phoenix slot for staleness guard

  private lastWaitLog = 0;
  private lastSig?: string;

  // config gating
  private allowedPools = new Set<string>(); // `${venue}:${id}`
  private symbol = "SOL/USDC";
  private baseMint?: string;
  private quoteMint?: string;

  constructor(
    private P: JoinerParams,
    private C: JoinerCfg,
    private onDecision: DecisionHook,
    private rpcSim?: RpcSimFn,
    private onRpcSample?: RpcSampleHook
  ) {
    // Load pairs.json once; gate to configured pools only (if present)
    try {
      const cfg = readPairsConfig();
      if (cfg && cfg.pairs.length) {
        const first = cfg.pairs[0];
        this.symbol = first.symbol || this.symbol;
        this.baseMint = first.baseMint;
        this.quoteMint = first.quoteMint;
        for (const pair of cfg.pairs) {
          for (const v of pair.venues || []) {
            const key = `${String(v.kind).toLowerCase()}:${v.id}`;
            this.allowedPools.add(key);
          }
        }
        logger.log("joiner_pairs_loaded", {
          symbol: this.symbol,
          pool_count: this.allowedPools.size,
        });
      } else {
        logger.log("joiner_pairs_fallback", { symbol: this.symbol, pool_count: 0 });
      }
    } catch { /* best-effort */ }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ingress: AMMs (publisher stream)
  upsertAmms(raw: any): void {
    const obj = raw?.data ?? raw;
    const px = nnum(obj?.px) ?? (typeof obj?.px_str === "string" ? Number(obj.px_str) : undefined);
    const venue = String(obj?.venue ?? "raydium").toLowerCase();
    const ammId = String(obj?.ammId ?? obj?.id ?? "");
    if (!ammId || !(px && px > 0)) return;

    // Gate by AMMS_ENABLE (optional)
    const enableList = String(process.env.AMMS_ENABLE ?? "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    if (enableList.length && !enableList.includes(venue)) return;

    // Gate to configured pools (if any listed in pairs.json)
    if (this.allowedPools.size && !this.allowedPools.has(`${venue}:${ammId}`)) return;

    const baseDecimals = nnum(obj?.baseDecimals);
    const quoteDecimals = nnum(obj?.quoteDecimals);
    const baseIntStr = typeof obj?.base_int === "string" ? obj.base_int : undefined;
    const quoteIntStr = typeof obj?.quote_int === "string" ? obj.quote_int : undefined;

    let reserves: AmmSnap["reserves"] | undefined;
    if (baseDecimals != null && quoteDecimals != null && baseIntStr && quoteIntStr) {
      const base = Number(baseIntStr) / Math.pow(10, baseDecimals);
      const quote = Number(quoteIntStr) / Math.pow(10, quoteDecimals);
      if (base > 0 && quote > 0 && Number.isFinite(base) && Number.isFinite(quote)) {
        reserves = { base, quote, baseDecimals, quoteDecimals };
      }
    }

    // Prefer per-pool fee from payload; env fallback if missing.
    const feeFromPayload =
      nnum(obj?.feeBps) ??
      nnum(obj?.fee_bps) ??
      nnum(obj?.amm_fee_bps);
    const feeFallback =
      venue === "raydium"
        ? Number(process.env.RAYDIUM_TRADE_FEE_BPS ?? this.P.ammFeeBps ?? 25)
        : venue === "orca"
          ? Number(process.env.ORCA_TRADE_FEE_BPS ?? this.P.ammFeeBps ?? 30)
          : Number(this.P.ammFeeBps ?? 25);
    const feeBps = feeFromPayload ?? feeFallback;

    const tsFromPayload = nnum(obj?.ts);
    const slotFromPayload = nnum(obj?.slot);

    const snap: AmmSnap = {
      venue: venue as any,
      ammId,
      px,
      ts: tsFromPayload && tsFromPayload > 0 ? tsFromPayload : Date.now(),
      slot: slotFromPayload ?? null,
      reserves,
      feeBps,
    };

    this.amms.set(`${venue}:${ammId}`, snap);
    void this.maybeReport();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ingress: Phoenix
  upsertPhoenix(raw: any): void {
    const ev = (raw?.event ?? raw?.name ?? raw?.type ?? "") as string;
    const obj = raw?.data ?? raw;

    // Pick up phoenix slot if present
    const maybeSlot = nnum(obj?.slot);
    if (maybeSlot != null) this.phxSlot = maybeSlot;

    if (ev === "phoenix_l2") {
      const bid = nnum(obj?.best_bid);
      const ask = nnum(obj?.best_ask);
      if (bid && ask && bid > 0 && ask > 0 && bid < ask) {
        const bidsArr = Array.isArray(obj?.levels_bids)
          ? (obj.levels_bids as any[]).map((l) => ({ px: Number(l.px), qty: Number(l.qty) }))
          : undefined;
        const asksArr = Array.isArray(obj?.levels_asks)
          ? (obj.levels_asks as any[]).map((l) => ({ px: Number(l.px), qty: Number(l.qty) }))
          : undefined;
        this.phxBook = {
          best_bid: bid,
          best_ask: ask,
          mid: (bid + ask) / 2,
          ts: Date.now(),
          source: "book",
          book_method: String(obj?.source ?? "unknown"),
          ...(bidsArr && bidsArr.length ? { levels_bids: bidsArr } : {}),
          ...(asksArr && asksArr.length ? { levels_asks: asksArr } : {}),
        } as any;
      }
    } else if (ev === "phoenix_mid") {
      const px = nnum(obj?.px) ?? (typeof obj?.px_str === "string" ? Number(obj.px_str) : undefined);
      if (px && px > 0) this.phxMid = { px, ts: Date.now() };
      const bid = nnum(obj?.best_bid);
      const ask = nnum(obj?.best_ask);
      if (bid && ask && bid > 0 && ask > 0 && bid < ask) {
        this.phxBook = {
          best_bid: bid,
          best_ask: ask,
          mid: (bid + ask) / 2,
          ts: Date.now(),
          source: "book",
          book_method: String(obj?.source ?? "unknown"),
        } as any;
      }
    }
    void this.maybeReport();
  }

  // ──────────────────────────────────────────────────────────────────────────
  private getFreshBook(): (PhoenixBook & { ts: number; book_method?: string; levels_bids?: DepthSide[]; levels_asks?: DepthSide[] }) | null {
    const now = Date.now();
    if (this.phxBook && now - this.phxBook.ts <= this.C.bookTtlMs) return this.phxBook;
    if (this.phxMid) {
      const synth = synthFromMid(this.phxMid.px, this.phxMid.ts);
      if (synth) return { ...synth, ts: Date.now() } as any;
    }
    return null;
  }

  // CPMM effective price (QUOTE per BASE)
  private cpmmBuyQuotePerBase(xBase: number, yQuote: number, wantBase: number, feeBps: number): number | undefined {
    if (!(xBase > 0 && yQuote > 0) || !(wantBase > 0)) return undefined;
    const fee = Math.max(0, feeBps) / 10_000;
    if (wantBase >= xBase * (1 - 1e-9)) return undefined;
    const dqPrime = (wantBase * yQuote) / (xBase - wantBase);
    const dq = dqPrime / (1 - fee);
    if (!Number.isFinite(dq)) return undefined;
    return dq / wantBase; // avg QUOTE per BASE paid
  }
  private cpmmSellQuotePerBase(xBase: number, yQuote: number, sellBase: number, feeBps: number): number | undefined {
    if (!(xBase > 0 && yQuote > 0) || !(sellBase > 0)) return undefined;
    const fee = Math.max(0, feeBps) / 10_000;
    const dbPrime = sellBase * (1 - fee);
    const dy = (yQuote * dbPrime) / (xBase + dbPrime);
    if (!Number.isFinite(dy)) return undefined;
    return dy / sellBase; // avg QUOTE per BASE received
  }

  // CLMM / mid-only fallback (used only if quoter errs)
  private midBuyQuotePerBase(mid: number, feeBps: number, slipBps: number): number {
    const fee = Math.max(0, feeBps) / 10_000;
    const slip = Math.max(0, slipBps) / 10_000;
    return mid * (1 + slip) * (1 + fee);
  }
  private midSellQuotePerBase(mid: number, feeBps: number, slipBps: number): number {
    const fee = Math.max(0, feeBps) / 10_000;
    const slip = Math.max(0, slipBps) / 10_000;
    return mid * (1 - slip) * (1 - fee);
  }

  private walkPhoenix(side: "buy" | "sell", sizeBase: number, feeBps: number): number | undefined {
    const B = this.getFreshBook();
    if (!B) return undefined;
    const ladder: DepthSide[] | undefined = side === "sell" ? (B as any).levels_bids : (B as any).levels_asks;
    if (!ladder || ladder.length === 0 || !(sizeBase > 0)) return undefined;

    let rem = sizeBase, notional = 0;
    for (const { px, qty } of ladder) {
      if (!(px > 0 && qty > 0)) continue;
      const take = Math.min(rem, qty);
      notional += take * px;
      rem -= take;
      if (rem <= 1e-12) break;
    }
    if (rem > 1e-12) return undefined;

    const fee = Math.max(0, feeBps) / 10_000;
    const extra = Math.max(0, Number(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? this.C.dynamicSlippageExtraBps) / 10_000);
    const depthExtra = Math.max(0, Number(process.env.PHOENIX_DEPTH_EXTRA_BPS ?? 0) / 10_000);

    const avgPx = notional / sizeBase;
    return side === "sell"
      ? avgPx * (1 - depthExtra - extra) * (1 - fee)
      : avgPx * (1 + depthExtra + extra) * (1 + fee);
  }

  private buildSizeGrid(refPx: number, reserves?: { base: number }): number[] {
    const explicitGrid = String(process.env.DECISION_SIZE_GRID ?? "").trim();
    if (explicitGrid) {
      const xs = explicitGrid.split(",").map(s => Number(s.trim())).filter(x => Number.isFinite(x) && x > 0);
      return Array.from(new Set(xs)).sort((a, b) => a - b);
    }

    const floorFromEnv = envNum("DECISION_MIN_BASE");
    const floorFromCtor =
      this.P.decisionMinBase ??
      this.C.decisionMinBase ??
      this.P.minBase ??
      this.P.minTradeBase;

    const sizeoptMin = envNum("SIZEOPT_MIN_BASE");
    const targetBps = Math.max(0.1, envNum("DECISION_FIXEDCOST_TARGET_BPS") ?? 1);
    const dynMin = (this.P.fixedTxCostQuote > 0 && refPx > 0)
      ? (10_000 * this.P.fixedTxCostQuote) / (refPx * targetBps)
      : 0;

    const floor = Math.max(
      1e-6,
      floorFromEnv ?? floorFromCtor ?? sizeoptMin ?? dynMin ?? this.P.tradeSizeBase
    );

    const absMax = envNum("SIZEOPT_ABS_MAX_BASE");
    const maxFrac = envNum("SIZEOPT_MAX_POOL_FRAC") ?? this.C.cpmmMaxPoolTradeFrac;
    const poolCap = reserves ? reserves.base * maxFrac : (absMax ?? floor * 8);
    const upper = Math.max(floor, Math.min(poolCap, absMax ?? Number.POSITIVE_INFINITY));

    const steps = Math.max(5, Math.min(15, Number(process.env.SIZEOPT_PROBE_STEPS ?? 9)));
    const ratio = Math.pow(upper / floor, 1 / Math.max(1, steps - 1));
    const out: number[] = [];
    let v = floor;
    for (let i = 0; i < steps; i++) {
      out.push(v); v = v * ratio;
    }
    if (this.P.tradeSizeBase > floor && this.P.tradeSizeBase < upper) out.push(this.P.tradeSizeBase);

    const uniq = Array.from(new Set(out.map(x => Number(x.toFixed(9))))).filter(x => x > 0 && Number.isFinite(x));
    uniq.sort((a, b) => a - b);
    return uniq;
  }

  private validateOpportunity(
    path: "AMM->PHX" | "PHX->AMM" | "AMM->AMM",
    sizeBase: number,
    buyPx: number,
    sellPx: number,
    expectedPnl: number,
    fixedCost: number
  ): { valid: boolean; reason?: string } {
    if (buyPx <= 0 || sellPx <= 0 || sizeBase <= 0) return { valid: false, reason: "invalid_prices_or_size" };
    if (expectedPnl <= 0) return { valid: false, reason: "negative_expected_pnl" };
    const grossSpread = (sellPx / buyPx - 1) * 10000;
    if (grossSpread < MIN_PROFITABLE_BPS) return { valid: false, reason: `gross_spread_too_low_${grossSpread.toFixed(2)}bps` };
    const calculatedPnl = (sellPx - buyPx) * sizeBase - fixedCost;
    const pnlDiff = Math.abs(calculatedPnl - expectedPnl);
    if (pnlDiff > 0.001) return { valid: false, reason: `pnl_calculation_mismatch_${pnlDiff.toFixed(6)}` };
    const notional = sizeBase * buyPx;
    const profitBps = (expectedPnl / notional) * 10000;
    if (profitBps > MAX_REALISTIC_PROFIT_BPS) return { valid: false, reason: `unrealistic_profit_${profitBps.toFixed(2)}bps` };
    return { valid: true };
  }

  // Adapter-first quote (then fallback to venue-specific local math)
  private async quoteAmmAvgPerBase(
    amm: AmmSnap,
    side: "buy" | "sell",
    sizeBase: number,
    fallbackMid: number
  ): Promise<{ px?: number; feeBps: number; used: "adapter" | "local" | "fallback"; meta?: any }> {
    const adapter = getAdapter(amm.venue);
    const slip = this.P.flatSlippageBps;

    // Prefer adapter (config-driven; fee-aware)
    if (adapter?.quote) {
      try {
        const req: QuoteReq = {
          poolId: amm.ammId,
          side,
          sizeBase,
          slippageBps: slip,
          baseMint: this.baseMint,
          quoteMint: this.quoteMint,
        };
        // NOTE: adapter.quote expects (ctx, req)
        const q: QuoteRes = await adapter.quote(undefined as any, req as any);
        if ((q as any)?.ok && typeof (q as any).price === "number" && Number.isFinite((q as any).price)) {
          const feeBps = Number.isFinite((q as any).feeBps) ? Number((q as any).feeBps) : amm.feeBps;
          return { px: (q as any).price, feeBps, used: "adapter", meta: (q as any).meta };
        }
      } catch (e) {
        logger.log("adapter_quote_error", { venue: amm.venue, pool: amm.ammId, err: String((e as any)?.message ?? e) });
      }
    }

    // Fallback to local math (keeps working even if adapters are missing)
    try {
      if (amm.venue === "orca") {
        // Orca CLMM: use the local Whirlpool quoter helpers if adapter is absent
        if (side === "buy") {
          const q = await orcaAvgBuyQuotePerBase(amm.ammId, Math.max(sizeBase, MIN_ORCA_BASE_SIZE), slip);
          if (q.ok) return { px: q.price, feeBps: amm.feeBps, used: "local" };
        } else {
          const q = await orcaAvgSellQuotePerBase(amm.ammId, Math.max(sizeBase, MIN_ORCA_BASE_SIZE), slip);
          if (q.ok) return { px: q.price, feeBps: amm.feeBps, used: "local" };
        }
      } else {
        // Raydium CPMM: closed-form reserves math
        const hasRes = !!amm.reserves && amm.reserves.base > 0 && amm.reserves.quote > 0;
        if (hasRes) {
          if (side === "buy") {
            const px = this.cpmmBuyQuotePerBase(amm.reserves!.base, amm.reserves!.quote, sizeBase, amm.feeBps);
            if (px != null) return { px, feeBps: amm.feeBps, used: "local" };
          } else {
            const px = this.cpmmSellQuotePerBase(amm.reserves!.base, amm.reserves!.quote, sizeBase, amm.feeBps);
            if (px != null) return { px, feeBps: amm.feeBps, used: "local" };
          }
        }
      }
    } catch { /* fall through */ }

    // Final fallback: mid + slippage + fee (conservative)
    const px = side === "buy"
      ? this.midBuyQuotePerBase(fallbackMid, amm.feeBps, slip)
      : this.midSellQuotePerBase(fallbackMid, amm.feeBps, slip);
    return { px, feeBps: amm.feeBps, used: "fallback" };
  }

  // Node-agnostic quote (PHX or AMM)
  private async quoteNodeAvgPerBase(
    node: VenueNode,
    side: "buy" | "sell",
    sizeBase: number,
    fallbackMid: number
  ): Promise<{ px?: number; feeBps: number; used: "adapter" | "local" | "fallback"; meta?: any }> {
    if (node.kind === "phx") {
      // Try depth-walk first
      const pxDepth = this.walkPhoenix(side, sizeBase, node.feeBps);
      if (pxDepth != null) return { px: pxDepth, feeBps: node.feeBps, used: "local" };

      // Fallback: best bid/ask + configured slip (match prior behaviour)
      const B = this.getFreshBook();
      const slip = (this.C.phoenixSlippageBps ?? 0) / 10_000;
      if (B && (B as any).best_bid > 0 && (B as any).best_ask > 0) {
        const bid = (B as any).best_bid;
        const ask = (B as any).best_ask;
        const px = side === "buy" ? ask * (1 + slip) : bid * (1 - slip);
        return { px, feeBps: node.feeBps, used: "fallback" };
      }

      // Last resort: mid-based fallback
      const px = side === "buy"
        ? this.midBuyQuotePerBase(fallbackMid, node.feeBps, this.C.phoenixSlippageBps)
        : this.midSellQuotePerBase(fallbackMid, node.feeBps, this.C.phoenixSlippageBps);
      return { px, feeBps: node.feeBps, used: "fallback" };
    }

    // AMM node
    return this.quoteAmmAvgPerBase(node.amm, side, sizeBase, fallbackMid);
  }

  // ──────────────────────────────────────────────────────────────────────────
  private async maybeReport(): Promise<void> {
    // Reset circuit breakers daily
    const nowDay = new Date().getUTCDate();
    if (nowDay !== lastResetDay) {
      dailyTrades = 0; dailyVolumeQuote = 0; lastResetDay = nowDay;
    }

    const book = this.getFreshBook();
    const now = Date.now();

    if (!book || this.amms.size === 0) {
      if (now - this.lastWaitLog >= this.P.waitLogMs) {
        this.lastWaitLog = now;
        logger.log("edge_waiting", {
          have_raydium: !!Array.from(this.amms.values()).find(a => a.venue === "raydium"),
          have_orca: !!Array.from(this.amms.values()).find(a => a.venue === "orca"),
          have_phoenix_mid: !!this.phxMid,
          have_phoenix_book: !!this.phxBook,
          min_abs_bps: this.P.minAbsBps,
        });
      }
      return;
    }

    const bid = (book as any).best_bid;
    const ask = (book as any).best_ask;
    if (!(bid > 0 && ask > 0)) return;

    // Filter AMM snapshots by staleness + config allow-list
    const validAmms: AmmSnap[] = [];
    for (const a of this.amms.values()) {
      const reason = staleReason({ ts: a.ts, slot: a.slot ?? null, venue: a.venue, ammId: a.ammId }, this.phxSlot ?? null, now);
      if (reason) {
        logger.log("amm_snapshot_ignored", {
          venue: a.venue,
          ammId: a.ammId,
          reason,
          ts: a.ts,
          slot: a.slot ?? null,
          phoenix_slot: this.phxSlot ?? null,
        });
        continue;
      }
      if (this.allowedPools.size && !this.allowedPools.has(`${a.venue}:${a.ammId}`)) continue;
      validAmms.push(a);
    }
    if (validAmms.length === 0) {
      if (now - this.lastWaitLog >= this.P.waitLogMs) {
        this.lastWaitLog = now;
        logger.log("edge_waiting", {
          have_raydium: false,
          have_orca: false,
          have_phoenix_mid: !!this.phxMid,
          have_phoenix_book: !!this.phxBook,
          reason: "all_amm_snapshots_stale_or_not_in_config",
        });
      }
      return;
    }

    // Emit a single edge_report snapshot (Phoenix vs latest valid AMM mid)
    const latestAmm = validAmms.sort((a, b) => b.ts - a.ts)[0];
    const ammPx = latestAmm?.px ?? (bid + ask) / 2;

    const toPhoenixSellBps = (ammPx / bid - 1) * 10_000;
    const toPhoenixBuyBps = (ask / ammPx - 1) * 10_000;
    const absBps = Math.max(Math.abs(toPhoenixSellBps), Math.abs(toPhoenixBuyBps));
    if (absBps >= this.P.minAbsBps) {
      const payload = {
        symbol: this.symbol,
        amm_mid: Number(ammPx.toFixed(6)),
        amm_mid_str: ammPx.toFixed(9),
        phoenix_bid: Number(bid.toFixed(6)),
        phoenix_bid_str: bid.toFixed(9),
        phoenix_ask: Number(ask.toFixed(6)),
        phoenix_ask_str: ask.toFixed(9),
        phoenix_mid: Number(((bid + ask) / 2).toFixed(6)),
        phoenix_source: "book",
        toPhoenixSellBps: Number(toPhoenixSellBps.toFixed(4)),
        toPhoenixBuyBps: Number(toPhoenixBuyBps.toFixed(4)),
        absBps: Number(absBps.toFixed(4)),
        validation_passed: true,
        phoenix_book_method: (book as any).book_method ?? "unknown",
      };
      const sig = JSON.stringify(payload);
      if (sig !== this.lastSig) { logger.log("edge_report", payload); this.lastSig = sig; }
    }

    // Build L2 for optimizer (if available) — may be unused but harmless
    let bookOpt: SizePhoenixBook | undefined;
    if (Array.isArray((this.phxBook as any)?.levels_bids) && Array.isArray((this.phxBook as any)?.levels_asks)) {
      const bids = ((this.phxBook as any).levels_bids as DepthSide[]).filter(l => l && l.px > 0 && l.qty > 0).map(l => ({ px: l.px, qtyBase: l.qty }));
      const asks = ((this.phxBook as any).levels_asks as DepthSide[]).filter(l => l && l.px > 0 && l.qty > 0).map(l => ({ px: l.px, qtyBase: l.qty }));
      if (bids.length && asks.length) bookOpt = { bids, asks, takerFeeBps: this.P.phoenixFeeBps };
    }

    // ── Unified 2-leg path enumerator (PHX<->AMM and AMM<->AMM) ─────────────
    type Candidate = {
      path: "AMM->PHX" | "PHX->AMM" | "AMM->AMM";
      amm: AmmSnap;
      ammDst?: AmmSnap; // for AMM->AMM
      size: number;
      buyPx: number;
      sellPx: number;
      bpsGross: number;
      bpsNet: number;
      pnlNet: number;
    };

    const nodes: VenueNode[] = [
      { kind: "phx" as const, id: "phoenix" as const, feeBps: this.P.phoenixFeeBps },
      ...validAmms.map((a) => ({
        kind: "amm" as const,
        id: `${a.venue}:${a.ammId}`,
        feeBps: a.feeBps,
        amm: a,
      })),
    ];

    const candidates: Candidate[] = [];
    for (const nodeSrc of nodes) {
      for (const nodeDst of nodes) {
        if (nodeSrc === nodeDst) continue;
        // Skip PHX->PHX (same venue both sides)
        if (nodeSrc.kind === "phx" && nodeDst.kind === "phx") continue;

        // Path label compatible with rest of pipeline
        const path: Candidate["path"] =
          nodeSrc.kind === "phx" && nodeDst.kind === "amm" ? "PHX->AMM" :
            nodeSrc.kind === "amm" && nodeDst.kind === "phx" ? "AMM->PHX" :
              "AMM->AMM";

        // Execution gates
        const trackAmmAmm = envTrue("TRACK_AMM_AMM", true);
        const execAmmAmm = envTrue("EXECUTE_AMM_AMM", false);
        if (path === "AMM->AMM" && !trackAmmAmm && !execAmmAmm) continue;

        // Size grid (cap by reserves if AMM on source)
        const midRef = (bid + ask) / 2;
        const srcRes = nodeSrc.kind === "amm" ? nodeSrc.amm.reserves : undefined;
        const grid = this.buildSizeGrid(midRef, srcRes ? { base: srcRes.base } : undefined);
        const sizes = Array.from(new Set(grid.map(x => Number(x.toFixed(9)))))
          .filter(x => x > 0 && Number.isFinite(x))
          .sort((a, b) => a - b);

        for (const s0 of sizes) {
          const sEff =
            (nodeSrc.kind === "amm" && nodeSrc.amm.venue === "orca") ||
              (nodeDst.kind === "amm" && nodeDst.amm.venue === "orca")
              ? Math.max(s0, MIN_ORCA_BASE_SIZE)
              : s0;

          // Buy at source, sell at dest (BASE as the moving asset)
          const qBuy = await this.quoteNodeAvgPerBase(nodeSrc, "buy", sEff, midRef);
          const qSell = await this.quoteNodeAvgPerBase(nodeDst, "sell", sEff, midRef);
          const buyPx = qBuy.px;
          const sellPx = qSell.px;

          if (buyPx != null && sellPx != null) {
            const pnl = (sellPx - buyPx) * sEff - this.P.fixedTxCostQuote;

            // Use node “mid”s for gross spread calc (compat with prior logs)
            const srcMid = nodeSrc.kind === "amm" ? nodeSrc.amm.px : ask;  // buying at PHX uses ask ref
            const dstMid = nodeDst.kind === "amm" ? nodeDst.amm.px : bid;  // selling at PHX uses bid ref
            const bpsGross = ((dstMid / srcMid) - 1) * 10_000;
            const bpsNet = ((sellPx / buyPx) - 1) * 10_000;

            const ok = this.validateOpportunity(path, sEff, buyPx, sellPx, pnl, this.P.fixedTxCostQuote);
            if (ok.valid) {
              if (path !== "AMM->AMM" || execAmmAmm) {
                const snapSrc = nodeSrc.kind === "amm" ? nodeSrc.amm : latestAmm;   // keep payload shape
                const snapDst = nodeDst.kind === "amm" ? nodeDst.amm : undefined;
                candidates.push({
                  path,
                  amm: snapSrc!,
                  ammDst: snapDst,
                  size: sEff,
                  buyPx, sellPx,
                  bpsGross, bpsNet, pnlNet: pnl,
                });
              } else if (trackAmmAmm && path === "AMM->AMM") {
                logger.log("amm_amm_tracked", {
                  symbol: this.symbol,
                  src: (nodeSrc as any).amm?.venue ?? "phx",
                  dst: (nodeDst as any).amm?.venue ?? "phx",
                  size_base: round(sEff, 9),
                  buy_px: round(buyPx),
                  sell_px: round(sellPx),
                  edge_bps_net: round(bpsNet, 4),
                  expected_pnl: round(pnl, 6),
                  note: "not executable in this phase",
                });
              }
            } else {
              logger.log("opportunity_rejected", {
                path,
                venue: nodeSrc.kind === "amm" ? nodeSrc.amm.venue : "phx",
                size: sEff, buy_px: buyPx, sell_px: sellPx, pnl, reason: ok.reason
              });
            }
          }
        }
      }
    }

    // Choose the best candidate among all paths
    const best = candidates.sort((a, b) => b.pnlNet - a.pnlNet)[0];
    if (!best) {
      if (this.C.logSimFields) logger.log("would_not_trade", {
        symbol: this.symbol,
        reason: "no_profitable_opportunities_found",
        grid_count: 0,
        validation_enabled: true,
      });
      this.onDecision(false, -1e9, -1e9, undefined);
      return;
    }

    // RPC sim (optional) — only for PHX paths
    const base: any = {
      symbol: this.symbol,
      path: best.path,
      side: best.path === "AMM->PHX" ? "sell" : "buy",
      amm_venue: best.amm.venue,
      ...(best.path === "AMM->AMM" ? { amm_dst_venue: best.ammDst?.venue } : {}),
      trade_size_base: round(best.size, 9),
      recommended_size_base: round(best.size, 9),
      threshold_bps: round(this.P.thresholdBps, 4),
      slippage_bps: round(this.P.flatSlippageBps, 4),
      phoenix_slippage_bps: round(this.C.phoenixSlippageBps, 4),
      slippage_mode: this.C.activeSlippageMode,
      phoenix_source: "book",
      phoenix_book_method: (book as any).book_method ?? "unknown",
      buy_px: round(best.buyPx),
      sell_px: round(best.sellPx),
      edge_bps_net: round(best.bpsNet, 4),
      expected_pnl: round(best.pnlNet, 6),
      fees_bps: { phoenix: this.P.phoenixFeeBps, amm: best.amm.feeBps, ...(best.ammDst ? { amm_dst: best.ammDst.feeBps } : {}) },
      fixed_tx_cost_quote: round(this.P.fixedTxCostQuote, 6),
      decision_min_base:
        envNum("DECISION_MIN_BASE") ??
        this.P.decisionMinBase ??
        this.C.decisionMinBase ??
        envNum("SIZEOPT_MIN_BASE") ??
        this.P.minBase ??
        this.P.minTradeBase,
      size_grid_count: 0,
      validation_enabled: true,
    };

    const hasRes = !!best.amm.reserves && best.amm.reserves.base > 0 && best.amm.reserves.quote > 0;
    const ammEffPx = ((): number | undefined => {
      if (best.amm.venue === "orca") {
        // already included in buy/sellPx; report impact relative to mid
        return best.path === "AMM->PHX"
          ? best.buyPx
          : best.sellPx;
      }
      if (best.path === "AMM->PHX") {
        return hasRes
          ? this.cpmmBuyQuotePerBase(best.amm.reserves!.base, best.amm.reserves!.quote, best.size, best.amm.feeBps)
          : this.midBuyQuotePerBase(best.amm.px, best.amm.feeBps, this.P.flatSlippageBps);
      } else if (best.path === "PHX->AMM") {
        return hasRes
          ? this.cpmmSellQuotePerBase(best.amm.reserves!.base, best.amm.reserves!.quote, best.size, best.amm.feeBps)
          : this.midSellQuotePerBase(best.amm.px, best.amm.feeBps, this.P.flatSlippageBps);
      } else {
        return undefined;
      }
    })();
    if (ammEffPx != null) {
      base.amm_eff_px = round(ammEffPx);
      base.amm_price_impact_bps = round((ammEffPx / best.amm.px - 1) * 10_000, 4);
    }

    if (this.C.useRpcSim && this.rpcSim && best.path !== "AMM->AMM" && best.amm.reserves) {
      try {
        const out = await this.rpcSim({
          path: best.path as "AMM->PHX" | "PHX->AMM",
          sizeBase: best.size,
          ammMid: best.amm.px,
          reserves: hasRes ? { base: best.amm.reserves.base, quote: best.amm.reserves.quote } : undefined,
          ammFeeBps: best.amm.feeBps,
        });
        if (out) {
          if (typeof out.rpc_eff_px === "number" && Number.isFinite(out.rpc_eff_px)) base.rpc_eff_px = round(out.rpc_eff_px);
          if (typeof out.rpc_price_impact_bps === "number" && Number.isFinite(out.rpc_price_impact_bps)) base.rpc_price_impact_bps = round(out.rpc_price_impact_bps, 4);
          if (typeof out.rpc_sim_ms === "number" && out.rpc_sim_ms >= 0) base.rpc_sim_ms = out.rpc_sim_ms;
          if (typeof out.rpc_sim_mode === "string") base.rpc_sim_mode = out.rpc_sim_mode;
          if (typeof out.rpc_qty_out === "number" && Number.isFinite(out.rpc_qty_out)) base.rpc_qty_out = round(out.rpc_qty_out, 9);
          if (typeof out.rpc_units === "number" && Number.isFinite(out.rpc_units)) { base.rpc_units = out.rpc_units; base.compute_units = out.rpc_units; }
          if (typeof out.prioritization_fee === "number" && Number.isFinite(out.prioritization_fee)) base.prioritization_fee = out.prioritization_fee;
          this.onRpcSample?.({ ms: (out.rpc_sim_ms ?? 0), blocked: false });
        }
      } catch (e: any) {
        base.rpc_sim_error = String(e?.message ?? e);
      }
    }

    const rpcEff = (base as any).rpc_eff_px;
    if (rpcEff != null && Number.isFinite(rpcEff) && base.amm_eff_px != null) {
      const delta_bps = Math.abs((rpcEff / base.amm_eff_px - 1) * 10_000);
      const RPC_TOL_BPS = Number(process.env.RPC_SIM_TOL_BPS ?? 2);
      if (delta_bps > RPC_TOL_BPS) {
        base.rpc_deviation_bps = round(delta_bps, 4);
        base.guard_deviation_bps = round(delta_bps, 4);
        base.guard_blocked = true;
        this.onRpcSample?.({ ms: (base as any).rpc_sim_ms ?? 0, blocked: true });
        logger.log("would_not_trade", { ...base, reason: `rpc deviation > ${RPC_TOL_BPS} bps` });
        this.onDecision(false, best.bpsNet, best.pnlNet, undefined);
        return;
      }
      base.guard_deviation_bps = round(delta_bps, 4);
      base.guard_blocked = false;
      this.onRpcSample?.({ ms: (base as any).rpc_sim_ms ?? 0, blocked: false });
    }

    const safetyBps = Number(process.env.PNL_SAFETY_BPS ?? "0") || 0;
    const wantBps = this.P.thresholdBps + safetyBps;
    const wouldTrade = best.bpsNet >= wantBps && best.pnlNet > 0;

    if (wouldTrade) {
      const notionalQuote = best.size * ((best.buyPx + best.sellPx) / 2);
      noteDecision(notionalQuote);
      logger.log("would_trade", { ...base, safety_bps: round(safetyBps, 4), reason: "profitable_opportunity_validated" });
    } else {
      const reason =
        best.pnlNet <= 0
          ? "negative expected pnl after fees/slippage at s*"
          : `edge below threshold+safety (net_bps=${round(best.bpsNet, 4)} < ${wantBps})`;
      logger.log("would_not_trade", { ...base, safety_bps: round(safetyBps, 4), reason });
    }

    // Decision callback (includes AMM->AMM details if present)
    this.onDecision(wouldTrade, best.bpsNet, best.pnlNet, {
      path: best.path,
      side: best.path === "AMM->PHX" ? "sell" : "buy",
      buy_px: round(best.buyPx),
      sell_px: round(best.sellPx),
      recommended_size_base: best.size,
      amm_venue: best.amm.venue,
      amm_pool_id: best.amm.ammId,
      ...(best.path === "AMM->AMM" ? { amm_dst_venue: best.ammDst?.venue } : {}),
    });

    // Feature emission — ONLY for PHX paths (compat with 1-arg and 2-arg emitFeature signatures)
    if (best.path === "AMM->PHX" || best.path === "PHX->AMM") {
      const featPayload = featureFromEdgeAndDecision(
        {
          symbol: this.symbol,
          amm_base_reserve: best.amm.reserves?.base,
          amm_quote_reserve: best.amm.reserves?.quote,
          amm_base_decimals: best.amm.reserves?.baseDecimals,
          amm_quote_decimals: best.amm.reserves?.quoteDecimals,
          phoenix_source: "book",
          phoenix_book_method: (book as any).book_method,
          book_ttl_ms: this.C.bookTtlMs,
        },
        {
          path: best.path as "AMM->PHX" | "PHX->AMM",
          side: best.path === "AMM->PHX" ? "sell" : "buy",
          edge_bps_gross: round(best.bpsGross, 4),
          buy_px: round(best.buyPx),
          sell_px: round(best.sellPx),
          expected_pnl: round(best.pnlNet, 6),
          threshold_bps: this.P.thresholdBps,
          slippage_bps: this.P.flatSlippageBps,
          trade_size_base: best.size,
          would_trade: wouldTrade,
        }
      );

      // Arity-flexible call so TS is happy whether emitFeature expects (payload) or (topic, payload)
      const ef: any = emitFeature as any;
      try {
        if (typeof ef === "function") {
          if (ef.length >= 2) ef("edge_feature", featPayload);
          else ef(featPayload);
        }
      } catch {
        /* noop */
      }
    }
  }
}
