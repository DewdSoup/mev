// services/arb-mm/src/edge/joiner.ts
// Book-first edge calc + decision layer (CPMM/adaptive) + optional RPC-sim.
// Depth-aware Phoenix (optional) and fee-accurate effective prices.
// Emits clean edge_report logs and ML features.
//
// NEW in this build (fixes the 0.001-SOL gate):
// - Evaluate EV over a size grid for BOTH PATHS (AMM->PHX, PHX->AMM).
// - Choose s* = argmax EV(s) across both paths; gate on EV(s*).
// - Size floor at decision-time via DECISION_MIN_BASE, SIZEOPT_MIN_BASE, or
//   dynamic floor from fixed cost (≤ target bps).
// - Use PHOENIX L2 depth for size-based prices when enabled; CPMM for AMM leg.
// - Emit recommended_size_base = s*; logs always show evaluated size.
//
// Environment knobs added/used here (optional):
//   DECISION_MIN_BASE                (e.g., 0.03)     → hard floor in BASE
//   DECISION_SIZE_GRID               (e.g., "0.02,0.03,0.05,0.1")
//   DECISION_FIXEDCOST_TARGET_BPS    (default 1)      → compute dynamic floor so fixed-cost bps ≤ target
//   SIZEOPT_MIN_BASE                 (legacy)         → used if DECISION_MIN_BASE absent
//   SIZEOPT_ABS_MAX_BASE             (optional cap)   → absolute cap in BASE for grid
//   SIZEOPT_MAX_POOL_FRAC            (fallback)       → else use C.cpmmMaxPoolTradeFrac
//   PHOENIX_DEPTH_ENABLED            (1/true)         → enables depth-based PHX prices
//
// Notes:
// - Fixed tx cost is deducted in EV(s) for every size probe.
// - When depth is insufficient or CPMM is off, we fall back to conservative flat slippage paths.
//
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../ml_logger.js";
import { synthFromMid, type PhoenixBook } from "../syntheticPhoenix.js";
import { emitFeature, featureFromEdgeAndDecision } from "../feature_sink.js";
import { noteDecision } from "../risk.js";
import type { SlipMode } from "../config.js";
import {
  optimizeSize,
  type CpmmReserves as SizeCpmmReserves,
  type PhoenixBook as SizePhoenixBook,
} from "../executor/size.js";

function nnum(x: any): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function round(n: any, p = 6): number {
  const num = typeof n === "bigint" ? Number(n) : typeof n === "string" ? Number(n) : Number(n);
  return Number.isFinite(num) ? Number(num.toFixed(p)) : Number.NaN;
}
function sig(obj: any): string {
  const pick = {
    s: obj.symbol,
    a: obj.amm_mid,
    b: obj.phoenix_bid,
    k: obj.phoenix_ask,
    m: obj.phoenix_mid,
    bs: obj.toPhoenixSellBps,
    bb: obj.toPhoenixBuyBps,
    ab: obj.absBps,
    bm: obj.phoenix_book_method,
  };
  return JSON.stringify(pick);
}
function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function envTrue(name: string, def = false): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return def;
}

type Mid = { px: number; ts: number };
type Reserves = {
  base: number;
  quote: number;
  baseDecimals: number;
  quoteDecimals: number;
  ts: number;
};
type DepthSide = { px: number; qty: number };

export interface JoinerParams {
  minAbsBps: number;
  waitLogMs: number;
  thresholdBps: number;
  flatSlippageBps: number;
  tradeSizeBase: number;
  phoenixFeeBps: number;
  ammFeeBps: number;          // NOTE: EV will NOT subtract this when using CPMM eff px
  fixedTxCostQuote: number;
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
}

export type DecisionHookDetails = {
  path: "AMM->PHX" | "PHX->AMM";
  side: "buy" | "sell";
  buy_px: number;
  sell_px: number;
  rpc_eff_px?: number;
  recommended_size_base?: number;   // used by main.ts to execute
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

export class EdgeJoiner {
  private amms?: Mid;
  private phxMid?: Mid;
  private phxBook: (PhoenixBook & {
    ts: number;
    book_method?: string;
    levels_bids?: DepthSide[];
    levels_asks?: DepthSide[];
  }) | null = null;
  private lastWaitLog = 0;

  private reserves?: Reserves;

  private lastDecisionAtMs = 0;
  private lastPath?: "AMM->PHX" | "PHX->AMM";
  private lastSide?: "buy" | "sell";
  private lastEdgeNetBps?: number;

  private lastEdgeSig?: string;

  constructor(
    private P: JoinerParams,
    private C: JoinerCfg,
    private onDecision: DecisionHook,
    private rpcSim?: RpcSimFn,
    private onRpcSample?: RpcSampleHook
  ) { }

  upsertAmms(raw: any) {
    const obj = raw?.data ?? raw;
    const px = nnum(obj?.px) ?? (typeof obj?.px_str === "string" ? Number(obj.px_str) : undefined);
    if (px && px > 0) this.amms = { px, ts: Date.now() };

    try {
      const baseDecimals = nnum(obj?.baseDecimals);
      const quoteDecimals = nnum(obj?.quoteDecimals);
      const baseIntStr = typeof obj?.base_int === "string" ? obj.base_int : undefined;
      const quoteIntStr = typeof obj?.quote_int === "string" ? obj.quote_int : undefined;
      if (baseDecimals != null && quoteDecimals != null && baseIntStr && quoteIntStr) {
        const base = Number(baseIntStr) / Math.pow(10, baseDecimals);
        const quote = Number(quoteIntStr) / Math.pow(10, quoteDecimals);
        if (base > 0 && quote > 0 && Number.isFinite(base) && Number.isFinite(quote)) {
          this.reserves = { base, quote, baseDecimals, quoteDecimals, ts: Date.now() };
        }
      }
    } catch { }
    void this.maybeReport();
  }

  upsertPhoenix(raw: any) {
    const ev = (raw?.event ?? raw?.name ?? raw?.type ?? "") as string;
    const obj = raw?.data ?? raw;

    if (ev === "phoenix_l2") {
      const bid = nnum(obj?.best_bid);
      const ask = nnum(obj?.best_ask);
      const bidsArr = Array.isArray(obj?.levels_bids) ? (obj.levels_bids as any[]).map((l) => ({ px: Number(l.px), qty: Number(l.qty) })) : undefined;
      const asksArr = Array.isArray(obj?.levels_asks) ? (obj.levels_asks as any[]).map((l) => ({ px: Number(l.px), qty: Number(l.qty) })) : undefined;

      if (bid && ask) {
        this.phxBook = {
          best_bid: bid,
          best_ask: ask,
          mid: (bid + ask) / 2,
          ts: Date.now(),
          source: "book",
          book_method: String(obj?.source ?? "unknown"),
          levels_bids: bidsArr,
          levels_asks: asksArr,
        };
      }
    } else if (ev === "phoenix_mid") {
      const px = nnum(obj?.px) ?? (typeof obj?.px_str === "string" ? Number(obj.px_str) : undefined);
      if (px && px > 0) this.phxMid = { px, ts: Date.now() };
      const bid = nnum(obj?.best_bid);
      const ask = nnum(obj?.best_ask);
      if (bid && ask) {
        this.phxBook = {
          best_bid: bid,
          best_ask: ask,
          mid: (bid + ask) / 2,
          ts: Date.now(),
          source: "book",
          book_method: String(obj?.source ?? "unknown"),
        };
      }
    }
    void this.maybeReport();
  }

  private getFreshBook(): (PhoenixBook & { ts: number; book_method?: string; levels_bids?: DepthSide[]; levels_asks?: DepthSide[] }) | null {
    const now = Date.now();
    if (this.phxBook && now - this.phxBook.ts <= this.C.bookTtlMs) return this.phxBook;
    if (this.phxMid) {
      const synth = synthFromMid(this.phxMid.px, this.phxMid.ts);
      if (synth) return { ...synth, ts: Date.now() } as any;
    }
    return null;
  }

  // CPMM: USDC per SOL for buy (QUOTE in -> BASE out)
  private cpmmBuyQuotePerBase(xBase: number, yQuote: number, wantBase: number, feeBps: number) {
    if (!(xBase > 0 && yQuote > 0) || !(wantBase > 0)) return;
    const fee = Math.max(0, feeBps) / 10_000;
    if (wantBase >= xBase * (1 - 1e-9)) return;
    const dqPrime = (wantBase * yQuote) / (xBase - wantBase);
    const dq = dqPrime / (1 - fee);
    if (!Number.isFinite(dq)) return;
    return dq / wantBase;
  }
  // CPMM: USDC per SOL for sell (BASE in -> QUOTE out)
  private cpmmSellQuotePerBase(xBase: number, yQuote: number, sellBase: number, feeBps: number) {
    if (!(xBase > 0 && yQuote > 0) || !(sellBase > 0)) return;
    const fee = Math.max(0, feeBps) / 10_000;
    const dbPrime = sellBase * (1 - fee);
    const dy = (yQuote * dbPrime) / (xBase + dbPrime);
    if (!Number.isFinite(dy)) return;
    return dy / sellBase;
  }

  private shouldEmit(path: "AMM->PHX" | "PHX->AMM", side: "buy" | "sell", edgeNetBps: number): boolean {
    if (!this.C.enforceDedupe) return true;
    const now = Date.now();
    if (now - this.lastDecisionAtMs < this.C.decisionBucketMs) return false;
    if (
      this.lastPath === path &&
      this.lastSide === side &&
      this.lastEdgeNetBps != null &&
      Math.abs(edgeNetBps - this.lastEdgeNetBps) < this.C.decisionMinEdgeDeltaBps
    ) {
      return false;
    }
    this.lastDecisionAtMs = now;
    this.lastPath = path;
    this.lastSide = side;
    this.lastEdgeNetBps = edgeNetBps;
    return true;
  }

  private async maybeReport() {
    const now = Date.now();
    const book = this.getFreshBook();
    const amm = this.amms;

    if (!amm || !book) {
      if (now - this.lastWaitLog >= this.P.waitLogMs) {
        this.lastWaitLog = now;
        logger.log("edge_waiting", {
          have_raydium: !!amm,
          have_phoenix_mid: !!this.phxMid,
          have_phoenix_book: !!this.phxBook,
          min_abs_bps: this.P.minAbsBps,
        });
      }
      return;
    }

    const ammPx = amm.px;
    const bid = (book as any).best_bid;
    const ask = (book as any).best_ask;
    if (!(ammPx > 0 && bid > 0 && ask > 0)) return;

    const toPhoenixSellBps = (ammPx / bid - 1) * 10_000;
    const toPhoenixBuyBps = (ask / ammPx - 1) * 10_000;
    const absBps = Math.max(Math.abs(toPhoenixSellBps), Math.abs(toPhoenixBuyBps));
    if (absBps < this.P.minAbsBps) return;

    const payload: any = {
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
    };
    if ((book as any).book_method) payload.phoenix_book_method = (book as any).book_method;

    // Emit deduped edge snapshot
    const payloadSig = sig(payload);
    if (this.lastEdgeSig !== payloadSig) {
      logger.log("edge_report", payload);
      this.lastEdgeSig = payloadSig;
    }

    // Prepare feature row
    const edgeForFeature: any = {
      symbol: "SOL/USDC",
      amm_mid: Number(ammPx.toFixed(6)),
      phoenix_bid: Number(bid.toFixed(6)),
      phoenix_ask: Number(ask.toFixed(6)),
      phoenix_mid: Number(((bid + ask) / 2).toFixed(6)),
      toPhoenixSellBps: Number(toPhoenixSellBps.toFixed(4)),
      toPhoenixBuyBps: Number(toPhoenixBuyBps.toFixed(4)),
      absBps: Number(absBps.toFixed(4)),
      phoenix_source: "book",
      phoenix_book_method: (book as any).book_method,
      book_ttl_ms: this.C.bookTtlMs,
    };
    if (this.reserves) {
      edgeForFeature.amm_base_reserve = Number(this.reserves.base.toFixed(6));
      edgeForFeature.amm_quote_reserve = Number(this.reserves.quote.toFixed(6));
      edgeForFeature.amm_base_decimals = this.reserves.baseDecimals;
      edgeForFeature.amm_quote_decimals = this.reserves.quoteDecimals;
    }

    await this.decideAndLog(ammPx, bid, ask, (book as any).book_method, edgeForFeature);
  }

  // Depth-walk Phoenix book to our size (optional)
  private walkPhoenix(side: "buy" | "sell", sizeBase: number, feeBps: number) {
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
    if (rem > 1e-12) return undefined; // not enough depth

    const fee = Math.max(0, feeBps) / 10_000;
    const extra = Math.max(0, Number(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? this.C.dynamicSlippageExtraBps) / 10_000);
    const depthExtra = Math.max(0, Number(process.env.PHOENIX_DEPTH_EXTRA_BPS ?? 0) / 10_000);

    const avgPx = notional / sizeBase;
    return side === "sell"
      ? avgPx * (1 - depthExtra - extra) * (1 - fee) // receive on PHX
      : avgPx * (1 + depthExtra + extra) * (1 + fee); // pay on PHX
  }

  // ---- EV model for a given path + size (returns undefined if unavailable at this size) ----
  private evForSize(
    path: "AMM->PHX" | "PHX->AMM",
    sizeBase: number,
    ammMid: number,
    phxBid: number,
    phxAsk: number
  ): | {
    path: "AMM->PHX" | "PHX->AMM";
    side: "buy" | "sell";
    buyPx: number;    // QUOTE per BASE paid
    sellPx: number;   // QUOTE per BASE received
    bpsGross: number;
    bpsNet: number;
    pnlNet: number;   // quote
  }
    | undefined {
    if (!(sizeBase > 0)) return undefined;
    const flatSlip = this.P.flatSlippageBps / 10_000;
    const phxSpreadBps = ((phxAsk / phxBid) - 1) * 10_000;
    const phxSlipBpsUsed = Math.max(this.C.phoenixSlippageBps, phxSpreadBps * 0.5) + this.C.dynamicSlippageExtraBps;
    const phxSlip = phxSlipBpsUsed / 10_000;

    const phxFee = this.P.phoenixFeeBps / 10_000;
    const ammFee = this.P.ammFeeBps / 10_000;

    // AMM effective prices (size-aware if CPMM enabled)
    let ammBuyPxSim: number | undefined;
    let ammSellPxSim: number | undefined;
    if ((this.C.activeSlippageMode === "amm_cpmm" || this.C.activeSlippageMode === "adaptive") && this.reserves) {
      const { base, quote } = this.reserves;
      const maxDb = base * this.C.cpmmMaxPoolTradeFrac;
      if (sizeBase <= maxDb) {
        ammBuyPxSim = this.cpmmBuyQuotePerBase(base, quote, sizeBase, this.P.ammFeeBps);
        ammSellPxSim = this.cpmmSellQuotePerBase(base, quote, sizeBase, this.P.ammFeeBps);
        if (ammBuyPxSim != null) ammBuyPxSim *= (1 + this.C.dynamicSlippageExtraBps / 10_000);
        if (ammSellPxSim != null) ammSellPxSim *= (1 - this.C.dynamicSlippageExtraBps / 10_000);
      } else {
        // size exceeds policy cap
        return undefined;
      }
    }

    const buyFlat = (px: number, fee: number, slip: number) => px * (1 + slip) * (1 + fee);
    const sellFlat = (px: number, fee: number, slip: number) => px * (1 - slip) * (1 - fee);

    const phxDepthOn = envTrue("PHOENIX_DEPTH_ENABLED", false);
    const phxSellEffDepth = phxDepthOn ? this.walkPhoenix("sell", sizeBase, this.P.phoenixFeeBps) : undefined;
    const phxBuyEffDepth = phxDepthOn ? this.walkPhoenix("buy", sizeBase, this.P.phoenixFeeBps) : undefined;

    if (path === "AMM->PHX") {
      // Buy BASE on AMM (cost), sell BASE on PHX (revenue)
      const buyA_flat = buyFlat(ammMid, ammFee, flatSlip);
      const buyPx =
        this.C.activeSlippageMode === "flat" || ammBuyPxSim == null
          ? buyA_flat
          : this.C.activeSlippageMode === "amm_cpmm"
            ? ammBuyPxSim
            : Math.max(buyA_flat, ammBuyPxSim); // adaptive: be conservative on cost

      const sellPx = phxSellEffDepth ?? sellFlat(phxBid, phxFee, phxSlip);
      if (!(buyPx > 0 && sellPx > 0)) return undefined;

      const pnlNet = (sellPx - buyPx) * sizeBase - this.P.fixedTxCostQuote;
      const bpsGross = (phxBid / ammMid - 1) * 10_000;
      const bpsNet = (sellPx / buyPx - 1) * 10_000;

      return { path, side: "sell", buyPx, sellPx, bpsGross, bpsNet, pnlNet };
    } else {
      // PHX->AMM: Buy BASE on PHX (cost), sell BASE on AMM (revenue)
      const buyPx = phxBuyEffDepth ?? buyFlat(phxAsk, phxFee, phxSlip);

      const sellB_flat = sellFlat(ammMid, ammFee, flatSlip);
      const sellPx =
        this.C.activeSlippageMode === "flat" || ammSellPxSim == null
          ? sellB_flat
          : this.C.activeSlippageMode === "amm_cpmm"
            ? ammSellPxSim
            : Math.min(sellB_flat, ammSellPxSim); // adaptive: be conservative on revenue

      if (!(buyPx > 0 && sellPx > 0)) return undefined;

      const pnlNet = (sellPx - buyPx) * sizeBase - this.P.fixedTxCostQuote;
      const bpsGross = (ammMid / phxAsk - 1) * 10_000;
      const bpsNet = (sellPx / buyPx - 1) * 10_000;

      return { path, side: "buy", buyPx, sellPx, bpsGross, bpsNet, pnlNet };
    }
  }

  private buildSizeGrid(ammMid: number): number[] {
    const explicitGrid = String(process.env.DECISION_SIZE_GRID ?? "").trim();
    if (explicitGrid) {
      const xs = explicitGrid.split(",").map(s => Number(s.trim())).filter(x => Number.isFinite(x) && x > 0);
      return Array.from(new Set(xs)).sort((a, b) => a - b);
    }

    // Decision floor:
    // 1) explicit DECISION_MIN_BASE
    // 2) SIZEOPT_MIN_BASE legacy
    // 3) dynamic: ensure fixed-cost bps ≤ target (default 1 bps)
    const floorExplicit = envNum("DECISION_MIN_BASE");
    const sizeoptMin = envNum("SIZEOPT_MIN_BASE");
    const targetBps = Math.max(0.1, envNum("DECISION_FIXEDCOST_TARGET_BPS") ?? 1);
    const dynMin = (this.P.fixedTxCostQuote > 0 && ammMid > 0)
      ? (10_000 * this.P.fixedTxCostQuote) / (ammMid * targetBps)
      : 0;

    const floor = Math.max(1e-6, floorExplicit ?? sizeoptMin ?? dynMin ?? this.P.tradeSizeBase);

    // Upper cap:
    // min(ABS_MAX, poolFracCap)
    const absMax = envNum("SIZEOPT_ABS_MAX_BASE");
    const maxFrac = envNum("SIZEOPT_MAX_POOL_FRAC") ?? this.C.cpmmMaxPoolTradeFrac;
    const poolCap = this.reserves ? this.reserves.base * maxFrac : (absMax ?? floor * 8);
    const upper = Math.max(floor, Math.min(poolCap, absMax ?? Number.POSITIVE_INFINITY));

    // Geometric-ish grid (covers ~x6–x8 range with 7–9 probes)
    const steps = Math.max(5, Math.min(15, Number(process.env.SIZEOPT_PROBE_STEPS ?? 9)));
    const ratio = Math.pow(upper / floor, 1 / Math.max(1, steps - 1));
    const out: number[] = [];
    let v = floor;
    for (let i = 0; i < steps; i++) {
      out.push(v);
      v = v * ratio;
    }

    // Include configured trade size (if between floor and upper)
    if (this.P.tradeSizeBase > floor && this.P.tradeSizeBase < upper) out.push(this.P.tradeSizeBase);

    // De-dup + sort
    const uniq = Array.from(new Set(out.map(x => Number(x.toFixed(9))))).filter(x => x > 0 && Number.isFinite(x));
    uniq.sort((a, b) => a - b);
    return uniq;
  }

  private async decideAndLog(
    ammMid: number,
    phxBid: number,
    phxAsk: number,
    bookMethod?: string,
    edgeForFeature?: any
  ) {
    // Build size grid once per tick
    const grid = this.buildSizeGrid((phxBid + phxAsk) / 2);

    // Try to seed grid with optimizeSize maxima (gross) for both paths when we have full inputs.
    let bookOpt: SizePhoenixBook | undefined;
    let cpmmOpt: SizeCpmmReserves | undefined;
    try {
      if (
        this.reserves &&
        this.phxBook &&
        Array.isArray((this.phxBook as any).levels_bids) &&
        Array.isArray((this.phxBook as any).levels_asks)
      ) {
        const bidsL2 = ((this.phxBook as any).levels_bids as DepthSide[])
          .filter(l => l && l.px > 0 && l.qty > 0)
          .map(l => ({ px: l.px, qtyBase: l.qty }));
        const asksL2 = ((this.phxBook as any).levels_asks as DepthSide[])
          .filter(l => l && l.px > 0 && l.qty > 0)
          .map(l => ({ px: l.px, qtyBase: l.qty }));
        if (bidsL2.length && asksL2.length) {
          bookOpt = { bids: bidsL2, asks: asksL2, takerFeeBps: this.P.phoenixFeeBps };
          const feeBpsCpmm = Number.isFinite(Number(process.env.RAYDIUM_TRADE_FEE_BPS))
            ? Number(process.env.RAYDIUM_TRADE_FEE_BPS)
            : (this.P.ammFeeBps > 0 ? this.P.ammFeeBps : 25);
          cpmmOpt = { base: this.reserves.base, quote: this.reserves.quote, feeBps: feeBpsCpmm };

          const lowerBase = Math.max(grid[0] ?? this.P.tradeSizeBase, 1e-6);
          const maxFrac = envNum("SIZEOPT_MAX_POOL_FRAC") ?? this.C.cpmmMaxPoolTradeFrac;
          const upperAbs = envNum("SIZEOPT_ABS_MAX_BASE") ?? undefined;
          const probes = Math.max(5, Math.min(25, Number(process.env.SIZEOPT_PROBE_STEPS ?? 9)));

          const a = optimizeSize({ kind: "AMM->PHX", book: bookOpt, cpmm: cpmmOpt, maxPoolFrac: maxFrac, lowerBase, upperBaseCap: upperAbs }, probes);
          const b = optimizeSize({ kind: "PHX->AMM", book: bookOpt, cpmm: cpmmOpt, maxPoolFrac: maxFrac, lowerBase, upperBaseCap: upperAbs }, probes);

          if (a.bestBase > 0) grid.push(a.bestBase);
          if (b.bestBase > 0) grid.push(b.bestBase);
        }
      }
    } catch {
      // optimizer seeding is best-effort
    }

    // Clean grid again after seeding
    const sizes = Array.from(new Set(grid.map(x => Number(x.toFixed(9))))).filter(x => x > 0 && Number.isFinite(x)).sort((a, b) => a - b);

    // Evaluate both paths across sizes
    let best:
      | {
        path: "AMM->PHX" | "PHX->AMM";
        side: "buy" | "sell";
        size: number;
        buyPx: number;
        sellPx: number;
        bpsGross: number;
        bpsNet: number;
        pnlNet: number;
      }
      | undefined;

    for (const path of ["AMM->PHX", "PHX->AMM"] as const) {
      for (const s of sizes) {
        const ev = this.evForSize(path, s, ammMid, phxBid, phxAsk);
        if (!ev) continue;
        if (!best || ev.pnlNet > best.pnlNet) {
          best = { path: ev.path, side: ev.side, size: s, buyPx: ev.buyPx, sellPx: ev.sellPx, bpsGross: ev.bpsGross, bpsNet: ev.bpsNet, pnlNet: ev.pnlNet };
        }
      }
    }

    if (!best) {
      // No feasible size/path under current depth/limits
      if (this.C.logSimFields) {
        logger.log("would_not_trade", {
          symbol: "SOL/USDC",
          reason: "no_feasible_size_under_limits",
          decision_min_base: envNum("DECISION_MIN_BASE") ?? envNum("SIZEOPT_MIN_BASE"),
          grid_count: sizes.length,
          cpmm_max_pool_trade_frac: this.C.cpmmMaxPoolTradeFrac,
          phoenix_depth_enabled: envTrue("PHOENIX_DEPTH_ENABLED", false),
        });
      }
      this.onDecision(false, -1e9, -1e9, undefined);
      return;
    }

    // Compose base log object at the chosen size/path
    const base: any = {
      symbol: "SOL/USDC",
      path: best.path,
      side: best.side,
      trade_size_base: round(best.size, 9),
      recommended_size_base: round(best.size, 9),
      threshold_bps: round(this.P.thresholdBps, 4),
      slippage_bps: round(this.P.flatSlippageBps, 4),
      phoenix_slippage_bps: round(this.C.phoenixSlippageBps, 4),
      slippage_mode: this.C.activeSlippageMode,
      phoenix_source: "book",
      phoenix_book_method: bookMethod ?? "unknown",
      buy_px: round(best.buyPx),
      sell_px: round(best.sellPx),
      edge_bps_net: round(best.bpsNet, 4),
      expected_pnl: round(best.pnlNet, 6),
      fees_bps: { phoenix: this.P.phoenixFeeBps, amm: this.P.ammFeeBps },
      fixed_tx_cost_quote: round(this.P.fixedTxCostQuote, 6),
      decision_min_base: envNum("DECISION_MIN_BASE") ?? envNum("SIZEOPT_MIN_BASE"),
      size_grid_count: sizes.length,
    };

    // Diagnostics
    if (this.C.logSimFields) {
      base.phx_spread_bps = round(((phxAsk / phxBid) - 1) * 10_000, 4);
      if (envTrue("PHOENIX_DEPTH_ENABLED", false)) base.phx_depth_used = true;
      if (this.C.activeSlippageMode === "amm_cpmm" || this.C.activeSlippageMode === "adaptive") {
        base.cpmm_max_pool_trade_frac = this.C.cpmmMaxPoolTradeFrac;
        base.dynamic_slippage_extra_bps = this.C.dynamicSlippageExtraBps;
      }
    }

    // AMM effective px at chosen size (for impact log)
    let ammEffPx = ammMid;
    if ((this.C.activeSlippageMode === "amm_cpmm" || this.C.activeSlippageMode === "adaptive") && this.reserves) {
      const { base: X, quote: Y } = this.reserves;
      const s = best.size;
      if (best.path === "AMM->PHX") {
        const px = this.cpmmBuyQuotePerBase(X, Y, s, this.P.ammFeeBps);
        if (px != null) ammEffPx = px;
      } else {
        const px = this.cpmmSellQuotePerBase(X, Y, s, this.P.ammFeeBps);
        if (px != null) ammEffPx = px;
      }
    }
    base.amm_eff_px = round(ammEffPx);
    base.amm_price_impact_bps = round((ammEffPx / ammMid - 1) * 10_000, 4);

    // Optional RPC sim at chosen size
    if (this.C.useRpcSim && this.rpcSim && this.reserves) {
      try {
        const out = await this.rpcSim({
          path: best.path,
          sizeBase: best.size,
          ammMid,
          reserves: { base: this.reserves.base, quote: this.reserves.quote },
          ammFeeBps: this.P.ammFeeBps,
        });

        if (out) {
          if (typeof out.rpc_eff_px === "number" && Number.isFinite(out.rpc_eff_px)) {
            base.rpc_eff_px = round(out.rpc_eff_px);
            base.sim_eff_px = base.rpc_eff_px;
          }
          if (typeof out.rpc_price_impact_bps === "number" && Number.isFinite(out.rpc_price_impact_bps)) {
            base.rpc_price_impact_bps = round(out.rpc_price_impact_bps, 4);
            base.sim_slippage_bps = base.rpc_price_impact_bps;
          }
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

    // Optional RPC deviation guard
    const rpcEff = (base as any).rpc_eff_px;
    if (rpcEff != null && Number.isFinite(rpcEff)) {
      const delta_bps = Math.abs((rpcEff / base.amm_eff_px - 1) * 10_000);
      const RPC_TOL_BPS = Number(process.env.RPC_SIM_TOL_BPS ?? 2);
      if (delta_bps > RPC_TOL_BPS) {
        (base as any).rpc_deviation_bps = round(delta_bps, 4);
        (base as any).guard_deviation_bps = round(delta_bps, 4);
        (base as any).guard_blocked = true;
        this.onRpcSample?.({ ms: (base as any).rpc_sim_ms ?? 0, blocked: true });

        logger.log("would_not_trade", { ...base, reason: `rpc deviation > ${RPC_TOL_BPS} bps` });
        this.onDecision(false, best.bpsNet, best.pnlNet, undefined);
        return;
      }
      (base as any).guard_deviation_bps = round(delta_bps, 4);
      (base as any).guard_blocked = false;
      this.onRpcSample?.({ ms: (base as any).rpc_sim_ms ?? 0, blocked: false });
    }

    // ---- FINAL gate on EV at s* (with safety) ----
    const safetyBps = Number(process.env.PNL_SAFETY_BPS ?? "0") || 0;
    const wantBps = this.P.thresholdBps + safetyBps;

    const wouldTrade = best.bpsNet >= wantBps && best.pnlNet > 0;

    if (!this.shouldEmit(best.path, best.side, best.bpsNet)) return;

    if (wouldTrade) {
      const notionalQuote = best.size * ((best.buyPx + best.sellPx) / 2);
      noteDecision(notionalQuote);
      logger.log("would_trade", {
        ...base,
        safety_bps: round(safetyBps, 4),
        reason: "edge above threshold+safety at s*",
      });
    } else {
      const reason =
        best.pnlNet <= 0
          ? "negative expected pnl after fees/slippage at s*"
          : `edge below threshold+safety (net_bps=${round(best.bpsNet, 4)} < ${wantBps})`;
      logger.log("would_not_trade", { ...base, safety_bps: round(safetyBps, 4), reason });
    }

    // Decision callback → executor
    this.onDecision(wouldTrade, best.bpsNet, best.pnlNet, {
      path: best.path,
      side: best.side,
      buy_px: round(best.buyPx),
      sell_px: round(best.sellPx),
      recommended_size_base: best.size,
    });

    // ML feature row
    if (edgeForFeature) {
      emitFeature(
        featureFromEdgeAndDecision(edgeForFeature, {
          path: best.path,
          side: best.side,
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
