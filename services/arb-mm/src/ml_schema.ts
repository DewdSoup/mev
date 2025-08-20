// services/arb-mm/src/ml_schema.ts
// Clean ML events (compact, stable schema) → data/ml/events-YYYY-MM-DD.jsonl
// All calls are best-effort (never throw).

import { writeMlEvent } from "./ml_events.js";

// Optional session id (if ml_logger is present)
let session_id: string | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = await import("./ml_logger.js");
  if (typeof mod.getSessionId === "function") {
    session_id = mod.getSessionId();
  }
} catch {}

function base(rec: Record<string, unknown>) {
  const ts = Date.now();
  if (session_id) writeMlEvent({ ts, session_id, ...rec });
  else writeMlEvent({ ts, ...rec });
}

// Edge snapshot at decision time (used for feature training)
export function emitEdgeSnapshot(d: any) {
  base({
    event: "edge_snapshot",
    symbol: d?.symbol ?? "SOL/USDC",
    path: d?.path,
    side: d?.side,
    buy_px: num(d?.buy_px),
    sell_px: num(d?.sell_px),
    trade_size_base: num(d?.trade_size_base) || num(d?.size_base),
    edge_bps_net: num(d?.edge_bps_net),
    threshold_bps: num(d?.threshold_bps),
    // Phoenix/AMM context (only the useful bits)
    phx_spread_bps: num(d?.phx_spread_bps),
    phx_slippage_bps_used: num(d?.phx_slippage_bps_used),
    cpmm_max_pool_trade_frac: num(d?.cpmm_max_pool_trade_frac),
    dynamic_slippage_extra_bps: num(d?.dynamic_slippage_extra_bps),
    amm_eff_px: num(d?.amm_eff_px ?? d?.amm_sell_px_sim ?? d?.amm_buy_px_sim),
    amm_price_impact_bps: num(d?.amm_price_impact_bps),
    rpc_eff_px: num(d?.rpc_eff_px),
  });
}

// Decision label for training
export function emitDecision(wouldTrade: boolean, reason: string | undefined, d: any, expectedPnl?: number) {
  base({
    event: wouldTrade ? "would_trade" : "would_not_trade",
    symbol: d?.symbol ?? "SOL/USDC",
    path: d?.path,
    side: d?.side,
    trade_size_base: num(d?.trade_size_base) || num(d?.size_base),
    edge_bps_net: num(d?.edge_bps_net),
    expected_pnl: num(expectedPnl),
    reason: reason ?? d?.reason ?? null,
  });
}

// RPC simulation/sample timing for latency models
export function emitRpcSample(ms: number, blocked: boolean | undefined) {
  base({
    event: "sim_result",
    rpc_sim_ms: num(ms),
    blocked: Boolean(blocked),
  });
}

// Submission + fill for inclusion models
export function emitSubmittedTx(d: any) {
  base({
    event: "submitted_tx",
    path: d?.path,
    size_base: num(d?.size_base),
    ix_count: int(d?.ix_count),
    cu_limit: int(d?.cu_limit),
    tip_lamports: int(d?.tip_lamports),
    live: Boolean(d?.live),
    shadow: Boolean(d?.shadow),
  });
}

export function emitLanded(d: any) {
  base({
    event: "landed",
    sig: d?.sig,
    slot: d?.slot ?? null,
    conf_ms: int(d?.conf_ms),
    fill_px: num(d?.fill_px),
    filled_base: num(d?.filled_base),
    filled_quote: num(d?.filled_quote),
    shadow: Boolean(d?.shadow),
  });
}

function num(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function int(x: any): number | null {
  const n = Math.trunc(Number(x));
  return Number.isFinite(n) ? n : null;
}
