// services/arb-mm/src/edge/joiner.ts
// Book-first edge calc + decision layer (CPMM/adaptive) + optional RPC-sim.
// Depth-aware Phoenix (optional) and fee-accurate effective prices.
// Emits clean edge_report logs and ML features.

import { logger } from "../ml_logger.js";
import { synthFromMid, type PhoenixBook } from "../syntheticPhoenix.js";
import { emitFeature, featureFromEdgeAndDecision } from "../feature_sink.js";
import { noteDecision } from "../risk.js";
import type { SlipMode } from "../config.js";

function nnum(x: any): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

// SAFE round: tolerate undefined/NaN/strings/bigints without throwing.
function round(n: any, p = 6): number {
  const num =
    typeof n === "bigint" ? Number(n) :
    typeof n === "string" ? Number(n) :
    Number(n);
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
  ammFeeBps: number;
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
};

export type DecisionHook = (
  wouldTrade: boolean,
  edgeNetBps: number,
  expectedPnl: number,
  details?: DecisionHookDetails
) => void;

export type RpcSampleHook = (sample: { ms: number; blocked: boolean }) => void;

// NOTE: rpc_eff_px / rpc_price_impact_bps are optional — callers may
// return timing-only objects and skip price gating.
export type RpcSimFn = (input: {
  path: "AMM->PHX" | "PHX->AMM";
  sizeBase: number;
  ammMid: number;
  reserves?: { base: number; quote: number };
  ammFeeBps: number;
}) => Promise<
  | {
      rpc_eff_px?: number;
      rpc_price_impact_bps?: number;
      rpc_sim_ms: number;
      rpc_sim_mode: string;
      rpc_sim_error?: string;
      rpc_qty_out?: number;
      rpc_units?: number;
      prioritization_fee?: number;
    }
  | undefined
>;

export class EdgeJoiner {
  private amms?: Mid;
  private phxMid?: Mid;
  // Extended book: include depth arrays when provided by the feed
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
  ) {}

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
    } catch {}
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

    if (
      this.C.logSimFields &&
      (this.C.activeSlippageMode === "amm_cpmm" || this.C.activeSlippageMode === "adaptive") &&
      this.reserves &&
      this.P.tradeSizeBase > 0 &&
      this.P.tradeSizeBase <= this.reserves.base * this.C.cpmmMaxPoolTradeFrac
    ) {
      const { base, quote } = this.reserves;
      const buySim = this.cpmmBuyQuotePerBase(base, quote, this.P.tradeSizeBase, this.P.ammFeeBps);
      const sellSim = this.cpmmSellQuotePerBase(base, quote, this.P.tradeSizeBase, this.P.ammFeeBps);
      if (buySim != null && Number.isFinite(buySim)) {
        (payload as any).amm_eff_px_buy = round(buySim);
        (payload as any).amm_price_impact_bps_buy = round((buySim / ammPx - 1) * 10_000, 4);
      }
      if (sellSim != null && Number.isFinite(sellSim)) {
        (payload as any).amm_eff_px_sell = round(sellSim);
        (payload as any).amm_price_impact_bps_sell = round((sellSim / ammPx - 1) * 10_000, 4);
      }
    }

    const payloadSig = sig(payload);
    if (this.lastEdgeSig !== payloadSig) {
      logger.log("edge_report", payload);
      this.lastEdgeSig = payloadSig;
    }

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

  private cpmmBuyQuotePerBase(xBase: number, yQuote: number, wantBase: number, feeBps: number) {
    if (!(xBase > 0 && yQuote > 0) || !(wantBase > 0)) return;
    const fee = Math.max(0, feeBps) / 10_000;
    if (wantBase >= xBase * (1 - 1e-9)) return;
    const dqPrime = (wantBase * yQuote) / (xBase - wantBase);
    const dq = dqPrime / (1 - fee);
    if (!Number.isFinite(dq)) return;
    return dq / wantBase;
  }
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

  // Depth-walk Phoenix book to our size (optional, env-driven)
  private walkPhoenix(side: "buy"|"sell", sizeBase: number, feeBps: number) {
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
    if (side === "sell") {
      // receive on PHX
      return avgPx * (1 - depthExtra - extra) * (1 - fee);
    } else {
      // pay on PHX
      return avgPx * (1 + depthExtra + extra) * (1 + fee);
    }
  }

  private async decideAndLog(
    ammMid: number,
    phxBid: number,
    phxAsk: number,
    bookMethod?: string,
    edgeForFeature?: any
  ) {
    const flatSlip = this.P.flatSlippageBps / 10_000;

    const spreadBps = ((phxAsk / phxBid) - 1) * 10_000;
    const phxSlipBpsUsed = Math.max(this.C.phoenixSlippageBps, spreadBps * 0.5) + this.C.dynamicSlippageExtraBps;
    const phxSlip = phxSlipBpsUsed / 10_000;

    const phxFee = this.P.phoenixFeeBps / 10_000;
    const ammFee = this.P.ammFeeBps / 10_000;
    const sizeBase = this.P.tradeSizeBase;

    const buyFlat = (px: number, fee: number, slip: number) => px * (1 + slip) * (1 + fee);
    const sellFlat = (px: number, fee: number, slip: number) => px * (1 - slip) * (1 - fee);

    let ammBuyPxSim: number | undefined;
    let ammSellPxSim: number | undefined;
    if ((this.C.activeSlippageMode === "amm_cpmm" || this.C.activeSlippageMode === "adaptive") && this.reserves) {
      const { base, quote } = this.reserves;
      const maxDb = base * this.C.cpmmMaxPoolTradeFrac;
      if (sizeBase > 0 && sizeBase <= maxDb) {
        ammBuyPxSim = this.cpmmBuyQuotePerBase(base, quote, sizeBase, this.P.ammFeeBps);
        ammSellPxSim = this.cpmmSellQuotePerBase(base, quote, sizeBase, this.P.ammFeeBps);
        if (ammBuyPxSim != null) ammBuyPxSim *= (1 + this.C.dynamicSlippageExtraBps / 10_000);
        if (ammSellPxSim != null) ammSellPxSim *= (1 - this.C.dynamicSlippageExtraBps / 10_000);
      }
    }

    // Depth-aware Phoenix (if enabled and depth present)
    const phxDepthOn = String(process.env.PHOENIX_DEPTH_ENABLED ?? "0").toLowerCase() === "1" || String(process.env.PHOENIX_DEPTH_ENABLED ?? "").toLowerCase() === "true";
    const phxSellEffDepth = phxDepthOn ? this.walkPhoenix("sell", sizeBase, this.P.phoenixFeeBps) : undefined;
    const phxBuyEffDepth  = phxDepthOn ? this.walkPhoenix("buy",  sizeBase, this.P.phoenixFeeBps) : undefined;

    const buyA_flat = buyFlat(ammMid, ammFee, flatSlip);
    const sellA = phxSellEffDepth ?? sellFlat(phxBid, phxFee, phxSlip);
    const buyA_used =
      this.C.activeSlippageMode === "flat" || ammBuyPxSim == null
        ? buyA_flat
        : this.C.activeSlippageMode === "amm_cpmm"
        ? ammBuyPxSim
        : Math.max(buyA_flat, ammBuyPxSim);
    const bpsNetA = (sellA / buyA_used - 1) * 10_000;
    const pnlNetA = (sellA - buyA_used) * sizeBase - this.P.fixedTxCostQuote;
    const bpsGrossA = (phxBid / ammMid - 1) * 10_000;

    const buyB = phxBuyEffDepth ?? buyFlat(phxAsk, phxFee, phxSlip);
    const sellB_flat = sellFlat(ammMid, ammFee, flatSlip);
    const sellB_used =
      this.C.activeSlippageMode === "flat" || ammSellPxSim == null
        ? sellB_flat
        : this.C.activeSlippageMode === "amm_cpmm"
        ? ammSellPxSim
        : Math.min(sellB_flat, ammSellPxSim);
    const bpsNetB = (sellB_used / buyB - 1) * 10_000;
    const pnlNetB = (sellB_used - buyB) * sizeBase - this.P.fixedTxCostQuote;
    const bpsGrossB = (ammMid / phxAsk - 1) * 10_000;

    const chooseA = bpsNetA >= bpsNetB;
    const best = chooseA
      ? { path: "AMM->PHX" as const, side: "sell" as const, buyPx: buyA_used, sellPx: sellA, edgeBpsNet: bpsNetA, edgeBpsGross: bpsGrossA, expectedPnl: pnlNetA }
      : { path: "PHX->AMM" as const, side: "buy" as const, buyPx: buyB, sellPx: sellB_used, edgeBpsNet: bpsNetB, edgeBpsGross: bpsGrossB, expectedPnl: pnlNetB };

    const base: any = {
      symbol: "SOL/USDC",
      path: best.path,
      side: best.side,
      trade_size_base: round(this.P.tradeSizeBase, 9),
      threshold_bps: round(this.P.thresholdBps, 4),
      slippage_bps: round(this.P.flatSlippageBps, 4),
      phoenix_slippage_bps: round(this.C.phoenixSlippageBps, 4),
      slippage_mode: this.C.activeSlippageMode,
      phoenix_source: "book",
      phoenix_book_method: bookMethod ?? "unknown",
      buy_px: round(best.buyPx),
      sell_px: round(best.sellPx),
      edge_bps_net: round(best.edgeBpsNet, 4),
      expected_pnl: round(best.expectedPnl, 6),
      fees_bps: { phoenix: this.P.phoenixFeeBps, amm: this.P.ammFeeBps },
      fixed_tx_cost_quote: round(this.P.fixedTxCostQuote, 6),
    };

    if (this.C.logSimFields) {
      base.phx_spread_bps = round(((phxAsk / phxBid) - 1) * 10_000, 4);
      base.phx_slippage_bps_used = round(Math.max(this.C.phoenixSlippageBps, (((phxAsk / phxBid) - 1) * 10_000) * 0.5) + this.C.dynamicSlippageExtraBps, 4);
      if (phxDepthOn) base.phx_depth_used = true;
      if (this.C.activeSlippageMode === "amm_cpmm" || this.C.activeSlippageMode === "adaptive") {
        if (ammBuyPxSim != null) base.amm_buy_px_sim = round(ammBuyPxSim);
        if (ammSellPxSim != null) base.amm_sell_px_sim = round(ammSellPxSim);
        base.cpmm_max_pool_trade_frac = this.C.cpmmMaxPoolTradeFrac;
        base.dynamic_slippage_extra_bps = this.C.dynamicSlippageExtraBps;
      }
    }

    const ammEffPx =
      best.path === "AMM->PHX"
        ? (this.C.activeSlippageMode === "flat" ? ammMid : (ammBuyPxSim ?? ammMid))
        : (this.C.activeSlippageMode === "flat" ? ammMid : (ammSellPxSim ?? ammMid));
    base.amm_eff_px = round(ammEffPx);
    base.amm_price_impact_bps = round((ammEffPx / ammMid - 1) * 10_000, 4);

    // ── Optional RPC sim (only attach fields when they are real numbers)
    if (this.C.useRpcSim && this.rpcSim && this.reserves) {
      try {
        const out = await this.rpcSim({
          path: best.path,
          sizeBase,
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
          if (out.rpc_sim_error) base.rpc_sim_error = out.rpc_sim_error;

          this.onRpcSample?.({ ms: (out.rpc_sim_ms ?? 0), blocked: false });
        }
      } catch (e: any) {
        base.rpc_sim_error = String(e?.message ?? e);
      }
    }

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
        this.onDecision(false, best.edgeBpsNet, best.expectedPnl, undefined);
        return;
      }
      (base as any).guard_deviation_bps = round(delta_bps, 4);
      (base as any).guard_blocked = false;
      this.onRpcSample?.({ ms: (base as any).rpc_sim_ms ?? 0, blocked: false });
    }

    const wouldTrade = best.edgeBpsNet >= this.P.thresholdBps && best.expectedPnl >= 0;
    if (!this.shouldEmit(best.path, best.side, best.edgeBpsNet)) return;

    if (wouldTrade) {
      const notionalQuote = this.P.tradeSizeBase * ((best.buyPx + best.sellPx) / 2);
      noteDecision(notionalQuote);
      logger.log("would_trade", { ...base, reason: "edge above threshold" });
    } else {
      const reason =
        best.expectedPnl < 0
          ? "negative expected pnl after fees/slippage"
          : `edge below threshold (net_bps=${round(best.edgeBpsNet, 4)} < ${this.P.thresholdBps})`;
      logger.log("would_not_trade", { ...base, reason });
    }

    this.onDecision(wouldTrade, best.edgeBpsNet, best.expectedPnl, {
      path: best.path,
      side: best.side,
      buy_px: round(best.buyPx),
      sell_px: round(best.sellPx),
      rpc_eff_px: (base as any).rpc_eff_px,
    });

    if (edgeForFeature) {
      emitFeature(
        featureFromEdgeAndDecision(edgeForFeature, {
          path: best.path,
          side: best.side,
          edge_bps_gross: round(best.edgeBpsGross, 4),
          buy_px: round(best.buyPx),
          sell_px: round(best.sellPx),
          expected_pnl: round(best.expectedPnl, 6),
          threshold_bps: this.P.thresholdBps,
          slippage_bps: this.P.flatSlippageBps,
          trade_size_base: this.P.tradeSizeBase,
          would_trade: wouldTrade,
        })
      );
    }
  }
}
