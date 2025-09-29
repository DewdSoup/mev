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
let sessionStartWritten = false;

function todayStamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function resolveBaseDir(dataDirHint?: string): string {
  const single = String(process.env.RUN_ROOT_SINGLE ?? "").trim() === "1";
  const dirHint = process.env.ARB_ML_DIR?.trim();
  if (dirHint) return path.isAbsolute(dirHint) ? dirHint : path.resolve(REPO_ROOT, dirHint);

  const runRoot = process.env.RUN_ROOT?.trim();
  if (runRoot) {
    const resolvedRun = path.isAbsolute(runRoot) ? runRoot : path.resolve(REPO_ROOT, runRoot);
    return single ? resolvedRun : path.join(resolvedRun, "ml");
  }

  const baseHint = dataDirHint || process.env.ARB_DATA_DIR?.trim();
  const base = baseHint
    ? (path.isAbsolute(baseHint) ? baseHint : path.resolve(REPO_ROOT, baseHint))
    : path.join(REPO_ROOT, "data", "arb");
  return single ? base : path.join(base, "ml");
}

function setMlDir(opts?: { dataDir?: string; sessionTag?: string }) {
  const nextDir = resolveBaseDir(opts?.dataDir);
  const nextTag = String(opts?.sessionTag || process.env.SESSION_TAG || "default");
  const dirChanged = mlDir !== nextDir;
  const tagChanged = sessionTag !== nextTag;

  if (dirChanged || tagChanged) {
    if (writeStream) {
      try { writeStream.end(); } catch {}
      writeStream = null;
    }
    mlDir = nextDir;
    curDate = "";
    sessionStartWritten = false;
  }

  sessionTag = nextTag;
  ensureDir(mlDir);
}

function openStream() {
  if (!mlDir) setMlDir();
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

function writeSessionStart() {
  if (sessionStartWritten) return;
  if (!writeStream) return;
  const start = {
    event: "ml_session_start",
    ts: new Date().toISOString(),
    session_tag: sessionTag,
    pid: process.pid,
  };
  try {
    writeStream.write(JSON.stringify(start) + "\n");
    sessionStartWritten = true;
  } catch {}
}

export function mlInit(opts: { dataDir?: string; sessionTag?: string }) {
  setMlDir(opts);
  openStream();
  writeSessionStart();
}
export function mlWrite(obj: MlEvent) {
  try {
    if (!mlDir) setMlDir();
    openStream();
    if (!writeStream) return;
    writeSessionStart();
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
    if (!mlDir) setMlDir();
    openStream();
    writeSessionStart();
    if (summary) {
      mlWrite({ event: "ml_session_end", ts: new Date().toISOString(), session_tag: sessionTag, ...summary });
    } else {
      mlWrite({ event: "ml_session_end", ts: new Date().toISOString(), session_tag: sessionTag });
    }
  } finally {
    if (writeStream) { try { writeStream.end(); } catch {} writeStream = null; }
  }
}
