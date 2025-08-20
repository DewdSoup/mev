// services/arb-mm/scripts/replay_last.ts
// ESM-safe. Replays most recent live window via backtest.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIVE_DIR = path.resolve(__dirname, "..", "data", "live");

function latestSummary(): string | undefined {
  try {
    const files = fs
      .readdirSync(LIVE_DIR)
      .filter((f) => f.endsWith(".summary.json"))
      .map((f) => path.join(LIVE_DIR, f));
    if (!files.length) return;
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0];
  } catch {
    return;
  }
}

const latest = latestSummary();
if (!latest) {
  console.error("replay_last: no live summaries found in data/live/");
  process.exit(1);
}

let started_at: string | undefined;
let stopped_at: string | undefined;

try {
  const raw = fs.readFileSync(latest, "utf8");
  const j = JSON.parse(raw);
  started_at = j?.started_at;
  stopped_at = j?.stopped_at;
} catch (e) {
  console.error(`replay_last: failed to parse ${latest}:`, e);
  process.exit(1);
}

if (!started_at || !stopped_at) {
  console.error(
    `replay_last: missing started_at/stopped_at in ${path.basename(latest)}`
  );
  process.exit(1);
}

console.log(
  `replay_last: using window ${started_at} → ${stopped_at} (from ${path.basename(
    latest
  )})`
);

const res = spawnSync(
  "pnpm",
  ["run", "backtest", "--", "--from", started_at, "--to", stopped_at],
  {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
  }
);

process.exit(res.status == null ? 1 : res.status);
