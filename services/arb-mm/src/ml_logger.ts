// services/arb-mm/src/ml_logger.ts
// Wraps base runtime logger AND writes a single aggregate session JSONL.
// Adds ML-friendly events + session_start/session_end with counts_by_path.

import fs from "fs";
import path from "path";
import { logger as base } from "@mev/storage";
import { writeMlEvent } from "./ml_events.js";

// local, file-safe timestamp (YYYYMMDDTHHMMSSmmmZ → sans colons)
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}

const SESSION_ID =
  (process.env.SESSION_ID?.trim() || `sess_${stamp()}`) as string;
const SESSION_LOGS_ENABLE = getBool("SESSION_LOGS_ENABLE", true);
const SESSION_LOGS_DIR =
  process.env.SESSION_LOGS_DIR?.trim() || "services/arb-mm/data/sessions";
const SESSION_FILE = path.resolve(
  process.cwd(),
  SESSION_LOGS_DIR,
  `${SESSION_ID}.events.jsonl`,
);

// ─────────────────────────────────────────────────────────────────────────────
// small io helpers
function getBool(k: string, d = false) {
  const v = String(process.env[k] ?? (d ? "1" : "0")).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
function ensureDir(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
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
  considered: 0,
  would_trade: 0,
  would_not_trade: 0,
  submitted_tx: 0,
  landed: 0,
  land_error: 0,
  tip_lamports_sum: 0,
};

const pathCounts: Record<string, number> = Object.create(null);

function bumpStats(event: string, data?: any) {
  switch (event) {
    case "would_trade":
      stats.considered++;
      stats.would_trade++;
      break;
    case "would_not_trade":
      stats.considered++;
      stats.would_not_trade++;
      break;
    case "submitted_tx":
      stats.submitted_tx++;
      break;
    case "landed":
      if (data?.status === "ok") {
        stats.landed++;
      } else {
        stats.land_error++;
      }
      break;
  }

  const edge = Number(data?.edge_bps_net ?? data?.edge_bps);
  if (Number.isFinite(edge)) {
    if (stats.best_edge_bps === undefined || edge > stats.best_edge_bps) {
      stats.best_edge_bps = edge;
    }
    if (stats.worst_edge_bps === undefined || edge < stats.worst_edge_bps) {
      stats.worst_edge_bps = edge;
    }
  }

  const tip = Number(data?.tip_lamports ?? data?.tipLamports);
  if (Number.isFinite(tip)) {
    stats.tip_lamports_sum += tip;
  }

  const fq = Number(data?.filled_quote ?? data?.filledQuote);
  if (Number.isFinite(fq)) stats.filled_quote_sum = (stats.filled_quote_sum ?? 0) + fq;

  const fb = Number(data?.filled_base ?? data?.filledBase);
  if (Number.isFinite(fb)) stats.filled_base_sum = (stats.filled_base_sum ?? 0) + fb;

  const p = String(data?.path ?? "").trim();
  if (p) pathCounts[p] = (pathCounts[p] ?? 0) + 1;
}

export function getSessionId() {
  return SESSION_ID;
}
export function getSessionStats(): Stats {
  return { ...stats };
}

// Unified logger: forwards to base runtime logger *and* writes ML/session JSONL.
export const logger = {
  log(event: string, payload?: any) {
    // 1) Forward to base (@mev/storage) so existing logs stay identical
    base.log(event, payload);

    // 2) ML-friendly line (include session_id)
    const now = Date.now();
    const rec = payload === undefined ? { ts: now, event, session_id: SESSION_ID }
                                      : { ts: now, event, session_id: SESSION_ID, ...payload };
    try { writeMlEvent(rec); } catch {}

    // 3) Per-session JSONL aggregator (human tail-able)
    appendJsonl(rec);

    // 4) Stats
    bumpStats(event, payload);
  },

  // Optional: simple scoping like @mev/storage.logger.scope()
  scope(scope: string) {
    return {
      log: (event: string, payload?: any) =>
        logger.log(`${scope}_${event}`, payload),
    };
  },
};

// Write a one-liner at process start so the session file exists early.
appendJsonl({ ts: Date.now(), event: "session_start", session_id: SESSION_ID });

// Write a summary at shutdown
function writeSessionEnd() {
  const out = {
    ts: Date.now(),
    event: "session_end",
    session_id: SESSION_ID,
    stats: { ...stats },
    counts_by_path: { ...pathCounts },
  };
  try { appendJsonl(out); } catch {}
}

process.once("SIGINT", () => writeSessionEnd());
process.once("SIGTERM", () => writeSessionEnd());
process.once("beforeExit", () => writeSessionEnd());
