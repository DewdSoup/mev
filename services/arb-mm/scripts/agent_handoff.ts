// services/arb-mm/scripts/agent_handoff.ts
// Compact, lossless "handoff" snapshot so any agent/dev can resume fast.
// Usage: pnpm tsx services/arb-mm/scripts/agent_handoff.ts

import fs from "fs";
import path from "path";

function readLastN(file: string, n = 40): string[] {
  if (!fs.existsSync(file)) return [];
  const data = fs.readFileSync(file, "utf8");
  const lines = data.trimEnd().split(/\r?\n/);
  return lines.slice(-n);
}

function newestFile(dir: string, prefix = "", ext = ".json"): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith(ext))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f ? path.join(dir, files[0].f) : null;
}

function getenv(k: string, d?: string) {
  return process.env[k] ?? d ?? "";
}

const cwd = process.cwd();
const repoRoot = cwd.includes(`${path.sep}services${path.sep}arb-mm`)
  ? path.resolve(cwd, "..")
  : cwd;

const AMMS_LOG = getenv("EDGE_AMMS_JSONL") || path.join(repoRoot, "data", "amms", "runtime.jsonl");
const PHX_LOG  = getenv("EDGE_PHOENIX_JSONL") || path.join(repoRoot, "data", "phoenix", "runtime.jsonl");
const ARB_LIVE_DIR = path.join(repoRoot, "data", "arb", "live");
const HANDOFF_DIR  = path.join(repoRoot, "data", "arb", "handoff");
fs.mkdirSync(HANDOFF_DIR, { recursive: true });

const latestSummaryPath = newestFile(ARB_LIVE_DIR, "arb-summary-", ".json");
let summary: any = null;
if (latestSummaryPath && fs.existsSync(latestSummaryPath)) {
  try { summary = JSON.parse(fs.readFileSync(latestSummaryPath, "utf8")); } catch {}
}

const tailAmms = readLastN(AMMS_LOG, 25);
const tailPhx  = readLastN(PHX_LOG, 25);

const flags = {
  SHADOW_TRADING: getenv("SHADOW_TRADING","0"),
  LIVE_TRADING:   getenv("LIVE_TRADING","0"),
  USE_RPC_SIM:    getenv("USE_RPC_SIM","0"),
  USE_RAYDIUM_SWAP_SIM: getenv("USE_RAYDIUM_SWAP_SIM","0"),
  TIP_MODE: getenv("TIP_MODE","fixed"),
  TRADE_THRESHOLD_BPS: getenv("TRADE_THRESHOLD_BPS",""),
  MAX_SLIPPAGE_BPS: getenv("MAX_SLIPPAGE_BPS",""),
  TRADE_SIZE_BASE: getenv("TRADE_SIZE_BASE",""),
};

const feeCfg = {
  phoenix_fee_bps: getenv("PHOENIX_TAKER_FEE_BPS",""),
  raydium_fee_bps: getenv("RAYDIUM_TAKER_FEE_BPS",""),
};

const ts = new Date().toISOString().replace(/[:.]/g,"");
const outPath = path.join(HANDOFF_DIR, `${ts}.md`);

function block(title: string, body: string) {
  return `### ${title}\n\n${body.trim()}\n`;
}

function code(lang: string, s: string) {
  return "```"+lang+"\n"+s.trim()+"\n```\n";
}

const header = `# Agent Handoff — ${new Date().toISOString()}

**Command hint:** \`pnpm shadow\` (no sends) • \`pnpm live\` (sends ON if LIVE_TRADING=1)

`;

const cfg = block("Flags / Config (env view)", code("json", JSON.stringify({flags, feeCfg}, null, 2)));

const live = summary ? block("Latest Live Summary",
code("json", JSON.stringify({
  file: latestSummaryPath,
  window: { started_at: summary.started_at, stopped_at: summary.stopped_at },
  counts: { considered: summary.considered, would_trade: summary.would_trade, would_not_trade: summary.would_not_trade },
  edges: { best_bps: summary.best_edge_bps, worst_bps: summary.worst_edge_bps },
  rpc: summary.rpc
}, null, 2))) : block("Latest Live Summary", "_No live summary found yet._");

const tails = block("Recent Runtime Lines",
  "**AMMs (last 25):**\n" + code("", tailAmms.join("\n") || "(empty)") +
  "\n**Phoenix (last 25):**\n" + code("", tailPhx.join("\n") || "(empty)")
);

const actions = block("Next 3 Actions (scaffold)",
`1) Verify EV calibration (pred vs realized slippage bps) with micro-size.
2) Check inclusion path (Jito vs RPC) and tip policy impact.
3) If negative drift: drop LIVE_TRADING=0 and run \`pnpm daily\` to inspect features.`);

const md = header + cfg + live + tails + actions;

fs.writeFileSync(outPath, md, "utf8");
console.log(md);
console.error(`\n[handoff] wrote: ${outPath}`);
