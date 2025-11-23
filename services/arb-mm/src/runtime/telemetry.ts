import fs from "fs";
import path from "path";
import { logger } from "../ml_logger.js";
import { resolveRepoRoot } from "../util/paths.js";

export interface CandidateTelemetry {
  ts: number;
  symbol: string;
  path: string;
  srcVenue: string;
  dstVenue?: string;
  wouldTrade: boolean;
  edgeBps: number;
  pnlQuote: number;
  sizeBase: number;
  reason?: string;
}

export interface VenueFreshnessTelemetry {
  timestamp: number;
  byVenue: Record<string, {
    pools: number;
    withHeartbeat: number;
    missingHeartbeat: number;
    heartbeat_age_ms_max: number | null;
    heartbeat_age_ms_avg: number | null;
    ws_age_ms_max: number | null;
    ws_age_ms_avg: number | null;
    ws_endpoints?: string[];
    ws_endpoint_labels?: string[];
  }>;
}

const REPO_ROOT = resolveRepoRoot(import.meta.url);

function resolveTelemetryDir(): string {
  const dirHint = process.env.TELEMETRY_DIR?.trim();
  if (dirHint && dirHint.length > 0) {
    return path.isAbsolute(dirHint) ? dirHint : path.resolve(REPO_ROOT, dirHint);
  }
  const runRootHint = process.env.RUN_ROOT?.trim();
  if (runRootHint && runRootHint.length > 0) {
    const resolvedRunRoot = path.isAbsolute(runRootHint)
      ? runRootHint
      : path.resolve(REPO_ROOT, runRootHint);
    return path.join(resolvedRunRoot, "telemetry");
  }
  return path.join(REPO_ROOT, "data", "telemetry");
}

const TELEMETRY_DIR = resolveTelemetryDir();
const CANDIDATE_FILE = path.join(TELEMETRY_DIR, "candidate-stats.jsonl");
const VENUE_FRESHNESS_FILE = path.join(TELEMETRY_DIR, "venue-freshness.jsonl");

logger.log("telemetry_init", {
  telemetry_dir: TELEMETRY_DIR,
  candidate_file: CANDIDATE_FILE,
  venue_freshness_file: VENUE_FRESHNESS_FILE,
});

const ENSURED_DIRS = new Set<string>();

function ensureDirExists(dir: string): void {
  if (ENSURED_DIRS.has(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    ENSURED_DIRS.add(dir);
  } catch (err) {
    logger.log("telemetry_dir_error", {
      dir,
      err: String((err as any)?.message ?? err),
    });
  }
}

function appendJson(filePath: string, payload: unknown): void {
  try {
    ensureDirExists(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(payload) + "\n", { encoding: "utf8" });
  } catch (err) {
    logger.log("telemetry_write_error", {
      file: filePath,
      err: String((err as any)?.message ?? err),
    });
  }
}

export function recordCandidateStat(stat: CandidateTelemetry): void {
  appendJson(CANDIDATE_FILE, stat);
}

export function recordVenueFreshness(summary: VenueFreshnessTelemetry): void {
  const ts = summary.timestamp;
  for (const [venue, metrics] of Object.entries(summary.byVenue ?? {})) {
    appendJson(VENUE_FRESHNESS_FILE, { ts, venue, ...metrics });
  }
}
