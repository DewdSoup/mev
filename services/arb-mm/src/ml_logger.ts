// services/arb-mm/src/ml_logger.ts
// Wraps base runtime logger AND writes a single aggregate session JSONL.
// Adds ML-friendly events + session_start/session_end with counts_by_path.

import fs from "fs";
import path from "path";
import { logger as base } from "@mev/storage";
import { writeMlEvent } from "./ml_events.js";
import { stamp } from "./config.js";

const SESSION_ID = (process.env.SESSION_ID?.trim() || `sess_${stamp()}`) as string;
const SESSION_LOGS_ENABLE = getBool("SESSION_LOGS_ENABLE", true);
const SESSION_LOGS_DIR = process.env.SESSION_LOGS_DIR?.trim() || "services/arb-mm/data/sessions";
const SESSION_FILE = path.resolve(process.cwd(), SESSION_LOGS_DIR, `${SESSION_ID}.events.jsonl`);

// ─────────────────────────────────────────────────────────────────────────────
// small io helper
function getBool(k: string, d = false) {
  const v = String(process.env[k] ?? (d ? "1" : "0")).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
function ensureDir(p: string) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function appendJsonl(obj: any) {
  if (!SESSION_LOGS_ENABLE) return;
  ensureDir(path.dirname(SESSION_FILE));
  try {
    fs.appendFileSync(SESSION_FILE, JSON.stringify(obj) + "\n");
  } catch {}
}
// ─────────────────────────────────────────────────────────────────────────────

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

type PathCounts = {
  [path: string]: {
    considered?: number;
    submitted?: number;
    landed?: number;
    errors?: number;
  };
};
const pathCounts: PathCounts = Object.create(null);

// ─────────────────────────────────────────────────────────────────────────────
// session_start row
appendJsonl({ ts: Date.now(), session_id: SESSION_ID, name: "session_start", data: {
  pid: process.pid,
  cwd: process.cwd(),
  env_digest: {
    LIVE_TRADING: getBool("LIVE_TRADING", false),
    SHADOW_TRADING: getBool("SHADOW_TRADING", false),
    USE_RPC_SIM: getBool("USE_RPC_SIM", false),
  }
}});

function bumpStats(event: string, data: any) {
  // per-path counters
  const p = data?.path as string | undefined;
  if (p) {
    const c = (pathCounts[p] ||= {});
    if (event === "would_trade" || event === "would_not_trade") {
      c.considered = (c.considered ?? 0) + 1;
    } else if (event === "submitted_tx") {
      c.submitted = (c.submitted ?? 0) + 1;
    } else if (event === "landed") {
      c.landed = (c.landed ?? 0) + 1;
    } else if (event === "land_error") {
      c.errors = (c.errors ?? 0) + 1;
    }
  }

  // overall stats
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
    // 1) normal runtime line
    base.log(event, data);
    // 2) mirror to ML file
    writeMlEvent({ ts: Date.now(), session_id: SESSION_ID, name: event, data });
    // 3) write to session aggregate file
    appendJsonl({ ts: Date.now(), session_id: SESSION_ID, name: event, data });
    // 4) update counters
    bumpStats(event, data ?? {});
  },
};

// flush a session_end row on shutdown
function flushSessionEnd(code?: number) {
  appendJsonl({
    ts: Date.now(),
    session_id: SESSION_ID,
    name: "session_end",
    data: {
      exit_code: code ?? 0,
      stats: { ...stats },
      counts_by_path: { ...pathCounts },
    },
  });
}
let flushed = false;
function onceFlush(code?: number) {
  if (flushed) return;
  flushed = true;
  try { flushSessionEnd(code); } catch {}
}
process.on("beforeExit", () => onceFlush(0));
process.on("exit", (code) => onceFlush(code ?? 0));
process.on("SIGINT", () => { onceFlush(0); });
process.on("SIGTERM", () => { onceFlush(0); });

export function getSessionId() { return SESSION_ID; }
export function getSessionStats(): Stats { return { ...stats }; }
