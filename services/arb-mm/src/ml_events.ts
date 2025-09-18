// services/arb-mm/src/ml_events.ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

type MlEvent = Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let writeStream: fs.WriteStream | null = null;
let curDate = "";
let mlDir = "";
let sessionTag = "default";

function todayStamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function openStream() {
  const date = todayStamp();
  if (writeStream && date === curDate) return;
  if (writeStream) {
    try { writeStream.end(); } catch {}
    writeStream = null;
  }
  curDate = date;
  const file = path.join(mlDir, `events-${date}.jsonl`);
  writeStream = fs.createWriteStream(file, { flags: "a" });
}

export function mlInit(opts: { dataDir?: string; sessionTag?: string }) {
  const dataHint = opts?.dataDir || process.env.ARB_DATA_DIR?.trim();
  const base = dataHint
    ? (path.isAbsolute(dataHint) ? dataHint : path.resolve(REPO_ROOT, dataHint))
    : path.join(REPO_ROOT, "data", "arb");
  sessionTag = String(opts?.sessionTag || process.env.SESSION_TAG || "default");
  mlDir = path.join(base, "ml");
  ensureDir(mlDir);
  openStream();
  mlWrite({ event: "ml_session_start", ts: new Date().toISOString(), session_tag: sessionTag, pid: process.pid });
}
export function mlWrite(obj: MlEvent) {
  try {
    openStream();
    if (!writeStream) return;
    writeStream.write(JSON.stringify(obj) + "\n");
  } catch {}
}
export function writeMlEvent(record: any) {
  // compatibility shim for ml_logger.ts
  mlWrite(record);
}
export function mlEdgeReport(payload: MlEvent) {
  mlWrite({ ts: Date.now(), event: "edge_report", ...payload });
}
export function mlDecision(payload: MlEvent & { would_trade: boolean }) {
  mlWrite({ ts: Date.now(), event: payload.would_trade ? "would_trade" : "would_not_trade", ...payload });
}
export function mlLanded(payload: MlEvent) {
  mlWrite({ ts: Date.now(), event: "landed", ...payload });
}
export function mlClose(summary?: MlEvent) {
  try {
    if (summary) {
      mlWrite({ event: "ml_session_end", ts: new Date().toISOString(), session_tag: sessionTag, ...summary });
    } else {
      mlWrite({ event: "ml_session_end", ts: new Date().toISOString(), session_tag: sessionTag });
    }
  } finally {
    if (writeStream) { try { writeStream.end(); } catch {} writeStream = null; }
  }
}
