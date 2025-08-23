// services/arb-mm/scripts/ml_tap.ts
// ESM-safe tailer: runtime.jsonl -> data/ml/events-YYYY-MM-DD.jsonl

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

type RuntimeLine = { t?: string; event?: string; data?: any };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC = path.resolve(__dirname, "../logs/runtime.jsonl");
const OUT_DIR = path.resolve(__dirname, "../data/ml");

function dayStr(ts: number) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

let curDay: string | null = null;
let out: fs.WriteStream | null = null;
function ensureOut(ts: number) {
  const day = dayStr(ts);
  if (day === curDay && out) return;
  try {
    if (out) out.end();
  } catch { }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `events-${day}.jsonl`);
  out = fs.createWriteStream(file, { flags: "a" });
  curDay = day;
}

const INTERESTING = new Set([
  "would_trade",
  "would_not_trade",
  "submitted_tx",
  "landed",
  "land_error",
  "tip_calc",
  "guard_violation",
  "preflight_error",
  "needs_funding",
  "submit_error",
  "jito_bundle_ok",
  "jito_bundle_fallback_rpc",
  "jito_unavailable",
]);

let pos = 0;
let buf = "";

function flatten(x: any, pfx = "", outObj: any = {}) {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    for (const [k, v] of Object.entries(x)) {
      const nk = pfx ? `${pfx}_${k}` : k;
      flatten(v, nk, outObj);
    }
  } else {
    outObj[pfx || "value"] = x;
  }
  return outObj;
}

function processChunk(chunk: string) {
  buf += chunk;
  for (; ;) {
    const i = buf.indexOf("\n");
    if (i < 0) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as RuntimeLine;
      if (!obj?.event || !INTERESTING.has(obj.event)) continue;
      const ts = Date.parse(obj.t ?? new Date().toISOString());
      const tsSafe = Number.isFinite(ts) ? ts : Date.now();
      ensureOut(tsSafe);
      const rec: any = {
        schema: "ml_events.v1",
        ts: tsSafe,
        name: obj.event,
        ...flatten(obj.data ?? {}),
      };
      out!.write(JSON.stringify(rec) + "\n");
    } catch {
      // swallow parse errors
    }
  }
}

function tick() {
  try {
    if (!fs.existsSync(SRC)) return setTimeout(tick, 500);
    const st = fs.statSync(SRC);
    if (st.size < pos) pos = 0; // rotated
    if (st.size > pos) {
      const rs = fs.createReadStream(SRC, {
        start: pos,
        end: st.size,
        encoding: "utf8",
      });
      rs.on("data", (chunk: string | Buffer) =>
        processChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
      );
      rs.on("end", () => {
        pos = st.size;
        setTimeout(tick, 250);
      });
      rs.on("error", () => setTimeout(tick, 500));
    } else {
      setTimeout(tick, 250);
    }
  } catch {
    setTimeout(tick, 500);
  }
}

console.log("[ml_tap] tailing", SRC, "->", OUT_DIR);
tick();

process.on("SIGINT", () => {
  try {
    out?.end();
  } finally {
    process.exit(0);
  }
});
process.on("SIGTERM", () => {
  try {
    out?.end();
  } finally {
    process.exit(0);
  }
});
