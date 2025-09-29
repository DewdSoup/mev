// services/arb-mm/scripts/live_report.ts
// See freshest live summary even if older runs wrote to a nested path.
// ESM-safe; no external deps.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SVC_ROOT = path.resolve(__dirname, "..");
const envLive = process.env.ARB_LIVE_DIR?.trim();
const ENV_LIVE_DIR = envLive && envLive.length
  ? (path.isAbsolute(envLive) ? envLive : path.resolve(process.cwd(), envLive))
  : null;
const PRIMARY = path.join(SVC_ROOT, "..", "data", "arb", "live");
const ALT = path.join(SVC_ROOT, "data", "live"); // legacy nested

function listSummaries(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".summary.json") || (f.startsWith("arb-summary-") && f.endsWith(".json")))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function readJson(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function n(v: any, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }

const searchDirs = [PRIMARY, ALT];
if (ENV_LIVE_DIR) searchDirs.unshift(ENV_LIVE_DIR);

const seen = new Set<string>();
const all = searchDirs
  .flatMap((dir) => listSummaries(dir))
  .filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  })
  .sort((a, b) => path.basename(a).localeCompare(path.basename(b))); // by filename asc

if (all.length === 0) {
  const relPrimary = path.relative(process.cwd(), PRIMARY);
  const relEnv = ENV_LIVE_DIR ? path.relative(process.cwd(), ENV_LIVE_DIR) : null;
  if (relEnv) console.log(`No live summary files in ${relEnv}.`);
  console.log(`No live summary files in ${relPrimary} (or ALT).`);
  process.exit(0);
}

const latest = all[all.length - 1];
const j = readJson(latest);
if (!j) {
  console.error(`Failed to parse ${latest}`);
  process.exit(1);
}

console.log("─".repeat(60));
console.log("Live Session Summary:", path.basename(latest));
console.log("Window:", j.started_at ?? "?", "→", j.stopped_at ?? "?");
console.log("Counts:", `considered=${n(j.considered)}`, `would_trade=${n(j.would_trade)}`, `would_not_trade=${n(j.would_not_trade)}`);
console.log("Edges:", `best_bps=${n(j.best_edge_bps)}`, `worst_bps=${n(j.worst_edge_bps)}`);
console.log("PnL:", `sum_quote=${n(j.pnl_sum, 0).toFixed(6)}`);
console.log("Config:", `th=${n(j.threshold_bps)}`, `slip=${n(j.slippage_bps)}`, `size=${n(j.trade_size_base)}`);
console.log("_src_", path.relative(process.cwd(), latest));
console.log("─".repeat(60));

// Show newest 10 with mtimes from union
console.log("Newest 10 (union of PRIMARY+ALT):");
for (const p of all.slice(-10)) {
  let m = "";
  try { m = new Date(fs.statSync(p).mtimeMs).toISOString(); } catch {}
  console.log(" •", path.relative(process.cwd(), p), `(mtime ${m})`);
}
