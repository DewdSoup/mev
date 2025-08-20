// services/arb-mm/src/ml_logger.ts
import { logger as base } from "@mev/storage";
import { writeMlEvent } from "./ml_events.js";
import { stamp } from "./config.js";

const SESSION_ID = process.env.SESSION_ID?.trim() || `sess_${stamp()}`;

type Stats = {
  considered: number;
  would_trade: number;
  would_not_trade: number;
  submitted_tx: number;
  landed: number;
  land_error: number;
  tip_lamports_sum: number;
  best_edge_bps?: number;
  worst_edge_bps?: number;
  filled_quote_sum?: number;
  filled_base_sum?: number;
};
const stats: Stats = {
  considered: 0, would_trade: 0, would_not_trade: 0,
  submitted_tx: 0, landed: 0, land_error: 0,
  tip_lamports_sum: 0,
};

function bumpStats(event: string, data: any) {
  if (event === "would_trade" || event === "would_not_trade") {
    stats.considered++;
    if (event === "would_trade") stats.would_trade++; else stats.would_not_trade++;
    const b = Number(data?.edge_bps_net);
    if (Number.isFinite(b)) {
      stats.best_edge_bps = stats.best_edge_bps == null ? b : Math.max(stats.best_edge_bps, b);
      stats.worst_edge_bps = stats.worst_edge_bps == null ? b : Math.min(stats.worst_edge_bps, b);
    }
  } else if (event === "submitted_tx") {
    stats.submitted_tx++;
  } else if (event === "landed") {
    stats.landed++;
    const fq = Number(data?.filled_quote);
    const fb = Number(data?.filled_base);
    if (Number.isFinite(fq)) stats.filled_quote_sum = (stats.filled_quote_sum ?? 0) + fq;
    if (Number.isFinite(fb)) stats.filled_base_sum = (stats.filled_base_sum ?? 0) + fb;
  } else if (event === "land_error") {
    stats.land_error++;
  } else if (event === "tip_calc") {
    const t = Number(data?.tip_lamports);
    if (Number.isFinite(t)) stats.tip_lamports_sum += t;
  }
}

export const logger = {
  log(event: string, data?: any) {
    // write normal runtime line
    base.log(event, data);
    // mirror to ML file
    writeMlEvent({ ts: Date.now(), session_id: SESSION_ID, name: event, data });
    bumpStats(event, data);
  },
};

export function getSessionId() { return SESSION_ID; }
export function getSessionStats(): Stats { return { ...stats }; }
