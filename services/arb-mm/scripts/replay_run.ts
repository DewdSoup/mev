#!/usr/bin/env tsx
/**
 * Offline replay helper for staging validation.
 *
 * Usage:
 *   pnpm --filter @mev/arb-mm run staging:replay -- --run data/runs/2025-10-17T070504392Z
 *
 * Without --run, the most recent directory under data/runs will be used.
 */
import fs from "fs";
import path from "path";

type JsonRecord = Record<string, any>;

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) || fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function readJsonl(file: string): JsonRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as JsonRecord;
      } catch {
        return null;
      }
    })
    .filter((obj): obj is JsonRecord => obj !== null);
}

function resolveLatestRun(runRoot: string): string | null {
  if (!fs.existsSync(runRoot)) return null;
  const entries = fs
    .readdirSync(runRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => ({ name: dirent.name, full: path.join(runRoot, dirent.name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
  return entries[0]?.full ?? null;
}

function formatCountMap(map: Record<string, number>): Array<{ key: string; count: number }> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function isoToMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function main() {
  const args = process.argv.slice(2);
  const runFlagIdx = args.findIndex((arg) => arg === "--run");
  const telemetryFlagIdx = args.findIndex((arg) => arg === "--telemetry");

  let runDir = runFlagIdx >= 0 ? args[runFlagIdx + 1] : undefined;
  const telemetryOverride = telemetryFlagIdx >= 0 ? args[telemetryFlagIdx + 1] : undefined;

  const repoRoot = findRepoRoot(process.cwd());
  const defaultRunsDir = path.join(repoRoot, "data", "runs");
  const defaultTelemetryFile = path.join(repoRoot, "data", "telemetry", "candidate-stats.jsonl");

  if (!runDir) {
    const latest = resolveLatestRun(defaultRunsDir);
    if (!latest) {
      console.error("No runs found under", defaultRunsDir);
      process.exit(1);
    }
    runDir = latest;
  }

  const resolvedRunDir = path.isAbsolute(runDir) ? runDir : path.resolve(repoRoot, runDir);
  if (!fs.existsSync(resolvedRunDir) || !fs.statSync(resolvedRunDir).isDirectory()) {
    console.error("Run directory not found:", resolvedRunDir);
    process.exit(1);
  }

  const runtimeFile = path.join(resolvedRunDir, "arb-runtime.jsonl");
  const pathPairsFile = path.join(resolvedRunDir, "path-pairs.log");
  const runMetaFile = path.join(resolvedRunDir, "run.json");
  const telemetryFile = telemetryOverride
    ? path.resolve(telemetryOverride)
    : defaultTelemetryFile;

  const runtimeEvents = readJsonl(runtimeFile);
  const pathPairs = readJsonl(pathPairsFile);
  const telemetryEvents = fs.existsSync(telemetryFile) ? readJsonl(telemetryFile) : [];
  const runMeta = fs.existsSync(runMetaFile)
    ? JSON.parse(fs.readFileSync(runMetaFile, "utf8"))
    : {};

  const pathCounts: Record<string, number> = {};
  const skipReasons: Record<string, number> = {};
  const rejectionReasons: Record<string, number> = {};
  const bestNetByPath: Record<string, { bpsNet: number; pnlQuote: number; sizeBase: number }> = {};
  const candidateStats = {
    evaluated: 0,
    wouldTrade: 0,
    wouldNotTrade: 0,
  };

  let firstEventMs: number | null = null;
  let lastEventMs: number | null = null;

  for (const entry of pathPairs) {
    const pathStr = typeof entry.path === "string" ? entry.path : "unknown";
    pathCounts[pathStr] = (pathCounts[pathStr] ?? 0) + 1;
    const tsMs = isoToMs(entry.t);
    if (tsMs != null) {
      if (firstEventMs == null || tsMs < firstEventMs) firstEventMs = tsMs;
      if (lastEventMs == null || tsMs > lastEventMs) lastEventMs = tsMs;
    }
  }

  for (const event of runtimeEvents) {
    const ev = event.event as string | undefined;
    const tsMs = isoToMs(event.t);
    if (tsMs != null) {
      if (firstEventMs == null || tsMs < firstEventMs) firstEventMs = tsMs;
      if (lastEventMs == null || tsMs > lastEventMs) lastEventMs = tsMs;
    }
    if (!ev) continue;

    if (ev === "candidate_evaluated") {
      candidateStats.evaluated += 1;
      const data = event.data ?? {};
      const pathKey = typeof data.path === "string" ? data.path : "unknown";
      const edgeNet = Number(data.edge_bps_net ?? data.edgeBpsNet ?? data.bpsNet ?? Number.NaN);
      const pnlQuote = Number(data.pnl ?? data.pnlNet ?? Number.NaN);
      const sizeBase = Number(data.size_base ?? data.size ?? Number.NaN);
      if (!Number.isNaN(edgeNet)) {
        const prev = bestNetByPath[pathKey];
        if (!prev || edgeNet > prev.bpsNet) {
          bestNetByPath[pathKey] = {
            bpsNet: edgeNet,
            pnlQuote: Number.isFinite(pnlQuote) ? pnlQuote : 0,
            sizeBase: Number.isFinite(sizeBase) ? sizeBase : 0,
          };
        }
      }
    } else if (ev === "would_trade") {
      candidateStats.wouldTrade += 1;
    } else if (ev === "would_not_trade") {
      candidateStats.wouldNotTrade += 1;
    } else if (ev === "path_candidate_skip") {
      const reason = typeof event.data?.reason === "string" ? event.data.reason : "unknown";
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    } else if (ev === "opportunity_rejected") {
      const reason = typeof event.data?.reason === "string" ? event.data.reason : "unknown";
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
  }

  const telemetrySummary: {
    total: number;
    wouldTrade: number;
    wouldNotTrade: number;
    reasons: Record<string, number>;
    paths: Record<string, number>;
  } = {
    total: 0,
    wouldTrade: 0,
    wouldNotTrade: 0,
    reasons: {},
    paths: {},
  };

  if (telemetryEvents.length && firstEventMs != null) {
    const lowerBound = firstEventMs - 60_000;
    const upperBound = (lastEventMs ?? firstEventMs) + 60_000;
    for (const record of telemetryEvents) {
      const ts = typeof record.ts === "number" ? record.ts : null;
      if (ts == null || ts < lowerBound || ts > upperBound) continue;
      telemetrySummary.total += 1;
      const path = typeof record.path === "string" ? record.path : "unknown";
      telemetrySummary.paths[path] = (telemetrySummary.paths[path] ?? 0) + 1;
      if (record.wouldTrade) telemetrySummary.wouldTrade += 1;
      else telemetrySummary.wouldNotTrade += 1;
      const reason = typeof record.reason === "string" ? record.reason : "unknown";
      telemetrySummary.reasons[reason] = (telemetrySummary.reasons[reason] ?? 0) + 1;
    }
  }

  const startedAtIso = typeof runMeta.started_at === "string" ? runMeta.started_at : null;
  const durationMs =
    firstEventMs != null && lastEventMs != null ? Math.max(0, lastEventMs - firstEventMs) : null;

  const summary = {
    runDir: resolvedRunDir,
    runId: typeof runMeta.run_id === "string" ? runMeta.run_id : path.basename(resolvedRunDir),
    startedAt: startedAtIso,
    window: {
      firstEvent: firstEventMs != null ? new Date(firstEventMs).toISOString() : null,
      lastEvent: lastEventMs != null ? new Date(lastEventMs).toISOString() : null,
      durationSeconds: durationMs != null ? Number((durationMs / 1000).toFixed(2)) : null,
    },
    totals: candidateStats,
    pathCounts: formatCountMap(pathCounts),
    bestNetByPath: Object.entries(bestNetByPath)
      .map(([pathKey, payload]) => ({ path: pathKey, ...payload }))
      .sort((a, b) => b.bpsNet - a.bpsNet)
      .slice(0, 10),
    rejectionReasons: formatCountMap(rejectionReasons),
    skipReasons: formatCountMap(skipReasons),
    telemetry: {
      source: telemetryEvents.length ? telemetryFile : null,
      total: telemetrySummary.total,
      wouldTrade: telemetrySummary.wouldTrade,
      wouldNotTrade: telemetrySummary.wouldNotTrade,
      topReasons: formatCountMap(telemetrySummary.reasons).slice(0, 10),
      pathCounts: formatCountMap(telemetrySummary.paths),
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
