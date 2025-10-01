// services/arb-mm/src/feature_sink.ts
// ML-grade sinks:
// 1) /data/features/edge_features-YYYYMMDD.jsonl  (per-decision features)
// 2) /data/ml/events-YYYYMMDD.jsonl               (submit/fill/error lifecycle)

import fs from "fs";
import path from "path";
import { logger } from "@mev/storage";

let chainTps: number | undefined;
export function setChainTps(tps?: number) { chainTps = tps; }

function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function dataDirs() {
  const baseRaw = process.env.DATA_DIR?.trim();
  const base = baseRaw ? path.resolve(baseRaw) : path.resolve(process.cwd(), "data");
  ensureDir(base);
  const single = String(process.env.RUN_ROOT_SINGLE ?? "").trim() === "1";
  if (single) {
    return { base, feat: base, ml: base, single: true } as const;
  }
  const feat = path.join(base, "features"); ensureDir(feat);
  const ml = path.join(base, "ml"); ensureDir(ml);
  return { base, feat, ml, single: false } as const;
}
function dayFile(dir: string, stem: string, single?: boolean) {
  if (single) return path.join(dir, `${stem}.jsonl`);
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return path.join(dir, `${stem}-${y}${m}${dd}.jsonl`);
}

export function emitFeature(row: any) {
  try {
    const dirs = dataDirs();
    const file = dayFile(dirs.feat, "edge_features", dirs.single);
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch (e) {
    logger.log("feature_sink_error", { err: String(e) });
  }
}

export function emitMl(kind: "submit" | "fill" | "error", row: any) {
  try {
    const dirs = dataDirs();
    const file = dayFile(dirs.ml, "events", dirs.single);
    const out = { ts: Date.now(), kind, ...row };
    fs.appendFileSync(file, JSON.stringify(out) + "\n");
  } catch (e) {
    logger.log("ml_sink_error", { err: String(e) });
  }
}

// builder to normalize a decision snapshot into a single row
export function featureFromEdgeAndDecision(edge: any, d: {
  path: "AMM->PHX" | "PHX->AMM";
  side: "buy" | "sell";
  edge_bps_gross: number;
  buy_px: number; sell_px: number;
  expected_pnl: number;
  threshold_bps: number; slippage_bps: number;
  trade_size_base: number;
  would_trade: boolean;
}) {
  const ts = Date.now();
  const round = (x: any, p = 6) => (typeof x === "number" && Number.isFinite(x)) ? Number(x.toFixed(p)) : x;

  return {
    ts,
    symbol: edge.symbol ?? "SOL/USDC",
    path: d.path,
    side: d.side,

    // L2 snapshot
    amm_mid: round(edge.amm_mid),
    phx_bid: round(edge.phoenix_bid),
    phx_ask: round(edge.phoenix_ask),
    phx_mid: round(edge.phoenix_mid),
    phx_spread_bps: round(edge.phx_spread_bps, 4),
    book_ttl_ms: edge.book_ttl_ms,
    book_method: edge.phoenix_book_method,

    // Reserves (helps learn impact)
    amm_base_reserve: edge.amm_base_reserve,
    amm_quote_reserve: edge.amm_quote_reserve,
    amm_base_decimals: edge.amm_base_decimals,
    amm_quote_decimals: edge.amm_quote_decimals,

    // Decision math
    trade_size_base: d.trade_size_base,
    buy_px: round(d.buy_px),
    sell_px: round(d.sell_px),
    edge_bps_gross: round(d.edge_bps_gross, 4),
    threshold_bps: d.threshold_bps,
    slippage_bps: d.slippage_bps,
    expected_pnl: round(d.expected_pnl, 6),
    would_trade: d.would_trade,

    // Sim/guards
    amm_eff_px: round(edge.amm_eff_px),
    amm_price_impact_bps: round(edge.amm_price_impact_bps, 4),
    amm_buy_px_sim: round(edge.amm_buy_px_sim),
    amm_sell_px_sim: round(edge.amm_sell_px_sim),
    rpc_eff_px: round(edge.rpc_eff_px),
    rpc_price_impact_bps: round(edge.rpc_price_impact_bps, 4),
    rpc_qty_out: edge.rpc_qty_out,
    rpc_units: edge.rpc_units,
    rpc_sim_ms: edge.rpc_sim_ms,
    guard_deviation_bps: round(edge.guard_deviation_bps, 4),
    guard_blocked: edge.guard_blocked,

    // Chain load
    chain_tps: chainTps,
  };
}
