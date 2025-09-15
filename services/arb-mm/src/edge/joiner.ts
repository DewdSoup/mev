// services/arb-mm/src/edge/joiner.ts
// Multi-venue joiner (Raydium & Orca) with concurrent per-venue route evaluation.
// Keeps EV math, guards, and logging. Adds CLMM depth-aware quoting for Orca paths.
// - Reads per-pool feeBps from AMM payload when available.
// - Only PHX paths go through RPC-sim to satisfy its typing narrow.

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
function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function envTrue(name: string, def?: boolean): boolean {
  const d = def ?? false;
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return d;
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

export interface JoinerParams {
  minAbsBps: number;
  waitLogMs: number;
  thresholdBps: number;
  flatSlippageBps: number;
  tradeSizeBase: number;
  phoenixFeeBps: number;
  ammFeeBps: number;           // fallback only (per-venue/pool fee may arrive in payload)
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
  amm_pool_id?: string;       // 👈 exact pool to hit
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
  private lastDecisionAtMs = 0;
  private lastSig?: string;

  constructor(
    private P: JoinerParams,
    private C: JoinerCfg,
    private onDecision: DecisionHook,
    private rpcSim?: RpcSimFn,
    private onRpcSample?: RpcSampleHook
  ) { }

  // ──────────────────────────────────────────────────────────────────────────
  // Ingress: AMMs
  upsertAmms(raw: any): void {
    const obj = raw?.data ?? raw;
    const px = nnum(obj?.px) ?? (typeof obj?.px_str === "string" ? Number(obj.px_str) : undefined);
    const venue = String(obj?.venue ?? "raydium").toLowerCase();
    const ammId = String(obj?.ammId ?? obj?.id ?? "");
    if (!ammId || !(px && px > 0)) return;

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

    // Filter AMM snapshots by staleness
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
          reason: "all_amm_snapshots_stale",
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
        symbol: "SOL/USDC",
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

    // Build L2 for optimizer (if available)
    let bookOpt: SizePhoenixBook | undefined;
    if (Array.isArray((this.phxBook as any)?.levels_bids) && Array.isArray((this.phxBook as any)?.levels_asks)) {
      const bids = ((this.phxBook as any).levels_bids as DepthSide[]).filter(l => l && l.px > 0 && l.qty > 0).map(l => ({ px: l.px, qtyBase: l.qty }));
      const asks = ((this.phxBook as any).levels_asks as DepthSide[]).filter(l => l && l.px > 0 && l.qty > 0).map(l => ({ px: l.px, qtyBase: l.qty }));
      if (bids.length && asks.length) bookOpt = { bids, asks, takerFeeBps: this.P.phoenixFeeBps };
    }

    // Enumerate all AMM->PHX and PHX->AMM paths per-venue
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
    const candidates: Candidate[] = [];

    for (const amm of validAmms) {
      const hasRes = !!amm.reserves && amm.reserves.base > 0 && amm.reserves.quote > 0;

      // Size grid per AMM (use reserves if present for poolFrac cap)
      const grid = this.buildSizeGrid((bid + ask) / 2, hasRes ? { base: amm.reserves!.base } : undefined);

      // Seeding with optimizer proposals if Phoenix L2 available AND CPMM reserves available
      try {
        if (bookOpt && hasRes) {
          const cpmm: SizeCpmmReserves = { base: amm.reserves!.base, quote: amm.reserves!.quote, feeBps: amm.feeBps };
          const lowerBase = Math.max(grid[0] ?? this.P.tradeSizeBase, 1e-6);
          const maxFrac = envNum("SIZEOPT_MAX_POOL_FRAC") ?? this.C.cpmmMaxPoolTradeFrac;
          const upperAbs = envNum("SIZEOPT_ABS_MAX_BASE");
          const probes = Math.max(5, Math.min(25, Number(process.env.SIZEOPT_PROBE_STEPS ?? 9)));
          const common = { book: bookOpt, cpmm, maxPoolFrac: maxFrac, lowerBase };
          const a = optimizeSize({ kind: "AMM->PHX", ...common, ...(upperAbs != null ? { upperBaseCap: upperAbs } : {}) } as SizeOptInputs, probes);
          const b = optimizeSize({ kind: "PHX->AMM", ...common, ...(upperAbs != null ? { upperBaseCap: upperAbs } : {}) } as SizeOptInputs, probes);
          if (a.bestBase > 0) grid.push(a.bestBase);
          if (b.bestBase > 0) grid.push(b.bestBase);
        }
      } catch { /* best-effort */ }

      const sizes = Array.from(new Set(grid.map(x => Number(x.toFixed(9))))).filter(x => x > 0 && Number.isFinite(x)).sort((a, b) => a - b);
      for (const s of sizes) {
        // AMM->PHX: buy on AMM, sell on Phoenix
        {
          const sEff = amm.venue === "orca" ? Math.max(s, MIN_ORCA_BASE_SIZE) : s;
          let buyAmm: number | undefined;
          if (amm.venue === "orca") {
            const q = await orcaAvgBuyQuotePerBase(amm.ammId, sEff, this.P.flatSlippageBps);
            buyAmm = q.ok ? q.price : this.midBuyQuotePerBase(amm.px, amm.feeBps, this.P.flatSlippageBps);
          } else {
            buyAmm = hasRes
              ? this.cpmmBuyQuotePerBase(amm.reserves!.base, amm.reserves!.quote, sEff, amm.feeBps)
              : this.midBuyQuotePerBase(amm.px, amm.feeBps, this.P.flatSlippageBps);
          }

          const sellPhx = bookOpt ? this.walkPhoenix("sell", sEff, this.P.phoenixFeeBps) : bid * (1 - this.C.phoenixSlippageBps / 10_000);

          if (buyAmm != null && sellPhx != null) {
            const pnl = (sellPhx - buyAmm) * sEff - this.P.fixedTxCostQuote;
            const bpsGross = (bid / amm.px - 1) * 10_000;
            const bpsNet = (sellPhx / buyAmm - 1) * 10_000;
            const ok = this.validateOpportunity("AMM->PHX", sEff, buyAmm, sellPhx, pnl, this.P.fixedTxCostQuote);
            if (ok.valid) candidates.push({ path: "AMM->PHX", amm, size: sEff, buyPx: buyAmm, sellPx: sellPhx, bpsGross, bpsNet, pnlNet: pnl });
            else logger.log("opportunity_rejected", { path: "AMM->PHX", venue: amm.venue, size: sEff, buy_px: buyAmm, sell_px: sellPhx, pnl, reason: ok.reason });
          }
        }
        // PHX->AMM: buy on Phoenix, sell on AMM
        {
          const sEff = amm.venue === "orca" ? Math.max(s, MIN_ORCA_BASE_SIZE) : s;
          const buyPhx = bookOpt ? this.walkPhoenix("buy", sEff, this.P.phoenixFeeBps) : ask * (1 + this.C.phoenixSlippageBps / 10_000);

          let sellAmm: number | undefined;
          if (amm.venue === "orca") {
            const q = await orcaAvgSellQuotePerBase(amm.ammId, sEff, this.P.flatSlippageBps);
            sellAmm = q.ok ? q.price : this.midSellQuotePerBase(amm.px, amm.feeBps, this.P.flatSlippageBps);
          } else {
            sellAmm = hasRes
              ? this.cpmmSellQuotePerBase(amm.reserves!.base, amm.reserves!.quote, sEff, amm.feeBps)
              : this.midSellQuotePerBase(amm.px, amm.feeBps, this.P.flatSlippageBps);
          }

          if (buyPhx != null && sellAmm != null) {
            const pnl = (sellAmm - buyPhx) * sEff - this.P.fixedTxCostQuote;
            const bpsGross = (amm.px / ask - 1) * 10_000;
            const bpsNet = (sellAmm / buyPhx - 1) * 10_000;
            const ok = this.validateOpportunity("PHX->AMM", sEff, buyPhx, sellAmm, pnl, this.P.fixedTxCostQuote);
            if (ok.valid) candidates.push({ path: "PHX->AMM", amm, size: sEff, buyPx: buyPhx, sellPx: sellAmm, bpsGross, bpsNet, pnlNet: pnl });
            else logger.log("opportunity_rejected", { path: "PHX->AMM", venue: amm.venue, size: sEff, buy_px: buyPhx, sell_px: sellAmm, pnl, reason: ok.reason });
          }
        }
      }
    }

    // Optional: Cross-AMM tracking/execution (Raydium<->Orca).
    const trackAmmAmm = envTrue("TRACK_AMM_AMM", true);
    const execAmmAmm = envTrue("EXECUTE_AMM_AMM", false);
    let bestAmmAmm: { src: AmmSnap; dst: AmmSnap; size: number; buyPx: number; sellPx: number; bpsNet: number; pnlNet: number } | undefined;

    if (trackAmmAmm || execAmmAmm) {
      const amms = validAmms;
      for (let i = 0; i < amms.length; i++) for (let j = 0; j < amms.length; j++) {
        if (i === j) continue;
        const A = amms[i], B = amms[j];
        const aHas = !!A.reserves && A.reserves.base > 0 && A.reserves.quote > 0;
        const bHas = !!B.reserves && B.reserves.base > 0 && B.reserves.quote > 0;

        const midRef = (bid + ask) / 2;
        const grid = this.buildSizeGrid(midRef, (aHas && bHas) ? { base: Math.min(A.reserves!.base, B.reserves!.base) } : undefined);
        for (const s of grid) {
          const sEff = Math.max(s, MIN_ORCA_BASE_SIZE);

          // Buy on A
          let buyA: number | undefined;
          if (A.venue === "orca") {
            const q = await orcaAvgBuyQuotePerBase(A.ammId, sEff, this.P.flatSlippageBps);
            buyA = q.ok ? q.price : this.midBuyQuotePerBase(A.px, A.feeBps, this.P.flatSlippageBps);
          } else {
            buyA = aHas
              ? this.cpmmBuyQuotePerBase(A.reserves!.base, A.reserves!.quote, sEff, A.feeBps)
              : this.midBuyQuotePerBase(A.px, A.feeBps, this.P.flatSlippageBps);
          }

          // Sell on B
          let sellB: number | undefined;
          if (B.venue === "orca") {
            const q = await orcaAvgSellQuotePerBase(B.ammId, sEff, this.P.flatSlippageBps);
            sellB = q.ok ? q.price : this.midSellQuotePerBase(B.px, B.feeBps, this.P.flatSlippageBps);
          } else {
            sellB = bHas
              ? this.cpmmSellQuotePerBase(B.reserves!.base, B.reserves!.quote, sEff, B.feeBps)
              : this.midSellQuotePerBase(B.px, B.feeBps, this.P.flatSlippageBps);
          }

          if (buyA != null && sellB != null) {
            const pnl = (sellB - buyA) * sEff - this.P.fixedTxCostQuote;
            const bpsNet = (sellB / buyA - 1) * 10_000;
            if (pnl > 0 && (!bestAmmAmm || pnl > bestAmmAmm.pnlNet)) {
              bestAmmAmm = { src: A, dst: B, size: sEff, buyPx: buyA, sellPx: sellB, bpsNet, pnlNet: pnl };
            }
          }
        }
      }
      if (bestAmmAmm) {
        if (trackAmmAmm) {
          logger.log("amm_amm_tracked", {
            symbol: "SOL/USDC",
            src: bestAmmAmm.src.venue,
            dst: bestAmmAmm.dst.venue,
            size_base: round(bestAmmAmm.size, 9),
            buy_px: round(bestAmmAmm.buyPx),
            sell_px: round(bestAmmAmm.sellPx),
            edge_bps_net: round(bestAmmAmm.bpsNet, 4),
            expected_pnl: round(bestAmmAmm.pnlNet, 6),
            note: execAmmAmm ? "candidate for execution" : "not executable in this phase",
          });
        }
        if (execAmmAmm) {
          candidates.push({
            path: "AMM->AMM",
            amm: bestAmmAmm.src,
            ammDst: bestAmmAmm.dst,
            size: bestAmmAmm.size,
            buyPx: bestAmmAmm.buyPx,
            sellPx: bestAmmAmm.sellPx,
            bpsGross: bestAmmAmm.bpsNet,
            bpsNet: bestAmmAmm.bpsNet,
            pnlNet: bestAmmAmm.pnlNet,
          });
        }
      }
    }

    // Choose the best candidate among all paths
    const best = candidates.sort((a, b) => b.pnlNet - a.pnlNet)[0];
    if (!best) {
      if (this.C.logSimFields) logger.log("would_not_trade", {
        symbol: "SOL/USDC",
        reason: "no_profitable_opportunities_found",
        grid_count: 0,
        validation_enabled: true,
      });
      this.onDecision(false, -1e9, -1e9, undefined);
      return;
    }

    // RPC sim (optional) — only for PHX paths
    const base: any = {
      symbol: "SOL/USDC",
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

    // Feature emission — ONLY for PHX paths
    if (best.path === "AMM->PHX" || best.path === "PHX->AMM") {
      emitFeature(
        featureFromEdgeAndDecision({
          symbol: "SOL/USDC",
          amm_base_reserve: best.amm.reserves?.base,
          amm_quote_reserve: best.amm.reserves?.quote,
          amm_base_decimals: best.amm.reserves?.baseDecimals,
          amm_quote_decimals: best.amm.reserves?.quoteDecimals,
          phoenix_source: "book",
          phoenix_book_method: (book as any).book_method,
          book_ttl_ms: this.C.bookTtlMs,
        }, {
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
        })
      );
    }
  }
}
