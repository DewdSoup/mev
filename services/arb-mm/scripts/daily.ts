// services/arb-mm/scripts/daily.ts
// Build a clean daily package for *yesterday* (UTC):
// 1) backtest the full day window
// 2) write a human daily report md
// 3) write a params snapshot json
//
// ESM-safe (__dirname via fileURLToPath). Zero extra deps.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const REPLAY_DIR = path.join(DATA, "replay");
const REPORTS_DIR = path.join(DATA, "reports");
const PARAMS_DIR = path.join(DATA, "params");

// Quiet by default; set DAILY_VERBOSE=true to stream full backtest logs.
const VERBOSE = String(process.env.DAILY_VERBOSE ?? "").toLowerCase() === "true";

// ensure dirs
for (const p of [DATA, REPLAY_DIR, REPORTS_DIR, PARAMS_DIR]) {
  fs.mkdirSync(p, { recursive: true });
}

// yesterday 00:00Z → today 00:00Z
function yesterWindowUtc(): { day: string; from: string; to: string } {
  const now = new Date();
  const today00 = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
  const y00 = new Date(today00);
  y00.setUTCDate(y00.getUTCDate() - 1);
  const day = [
    y00.getUTCFullYear(),
    String(y00.getUTCMonth() + 1).padStart(2, "0"),
    String(y00.getUTCDate()).padStart(2, "0"),
  ].join("-");
  return { day, from: y00.toISOString(), to: today00.toISOString() };
}

function latestReplaySummary(): string | undefined {
  const files = fs.readdirSync(REPLAY_DIR).filter((f) => f.endsWith(".summary.json"));
  if (!files.length) return;
  const full = files.map((f) => path.join(REPLAY_DIR, f));
  full.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return full[0];
}

function writeReport(day: string, sumPath: string, j: any) {
  const md = `# Daily Report — ${day}

**Window:** ${j.started_at ?? "?"} → ${j.stopped_at ?? "?"}

- Considered: **${j.considered ?? 0}**
- Would trade: **${j.would_trade ?? 0}**
- Would not trade: **${j.would_not_trade ?? 0}**
- PnL (sum): **${Number(j.pnl_sum ?? 0).toFixed(6)}**
- Best edge (bps): **${j.best_edge_bps ?? 0}**
- Worst edge (bps): **${j.worst_edge_bps ?? 0}**

**Config**
- threshold_bps: ${j.threshold_bps}
- slippage_bps: ${j.slippage_bps}
- trade_size_base: ${j.trade_size_base}
- book_ttl_ms: ${j.book_ttl_ms}
- decision_dedupe_ms: ${j.decision_dedupe_ms}
- decision_bucket_ms: ${j.decision_bucket_ms}
- min_edge_delta_bps: ${j.min_edge_delta_bps}
- allow_synth_trades: ${j.allow_synth_trades}

**RPC**
- samples: ${j.rpc?.samples ?? 0}
- p50_ms: ${j.rpc?.p50_ms ?? 0}
- p95_ms: ${j.rpc?.p95_ms ?? 0}
- used_swap_sim: ${j.rpc?.used_swap_sim ?? "false"}

_Source summary_: ${path.relative(ROOT, sumPath)}
`;
  const out = path.join(REPORTS_DIR, `${day}.md`);
  fs.writeFileSync(out, md);
  console.log(`daily: report → ${path.relative(process.cwd(), out)}`);
}

function writeParams(day: string, j: any) {
  const params = {
    day,
    threshold_bps: j.threshold_bps ?? 2,
    slippage_bps: j.slippage_bps ?? 0.5,
    trade_size_base: j.trade_size_base ?? 0.05,
    book_ttl_ms: j.book_ttl_ms ?? 5000,
    decision_dedupe_ms: j.decision_dedupe_ms ?? 1000,
    decision_bucket_ms: j.decision_bucket_ms ?? 250,
    min_edge_delta_bps: j.min_edge_delta_bps ?? 0.25,
    allow_synth_trades: j.allow_synth_trades ?? false,
    rpc_used_swap_sim: j.rpc?.used_swap_sim ?? "false",
  };
  const out = path.join(PARAMS_DIR, `${day}.json`);
  fs.writeFileSync(out, JSON.stringify(params, null, 2));
  console.log(`daily: params  → ${path.relative(process.cwd(), out)}`);
}

(async () => {
  const { day, from, to } = yesterWindowUtc();
  console.log(`daily: backtest window ${from} → ${to}`);

  const res = spawnSync("pnpm", ["run", "backtest", "--", "--from", from, "--to", to], {
    stdio: VERBOSE ? "inherit" : "ignore",
    cwd: ROOT,
    env: process.env,
  });
  if (res.status !== 0) {
    console.error(`daily: backtest failed with code ${res.status}`);
    process.exit(res.status ?? 1);
  }

  const sumPath = latestReplaySummary();
  if (!sumPath) {
    console.error("daily: no replay summaries found in data/replay/");
    process.exit(1);
  }
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(sumPath, "utf8"));
  } catch (e) {
    console.error(`daily: failed to parse ${sumPath}:`, e);
    process.exit(1);
  }

  writeReport(day, sumPath, j);
  writeParams(day, j);
})();
