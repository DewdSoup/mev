import "dotenv/config";
import { appendFile } from "node:fs/promises";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}

function ensureRunRoot(): string {
  const runRootRaw = process.env.RUN_ROOT?.trim();
  if (runRootRaw) {
    const resolved = path.isAbsolute(runRootRaw) ? runRootRaw : path.resolve(REPO_ROOT, runRootRaw);
    mkdirSync(resolved, { recursive: true });
    process.env.RUN_ROOT = resolved;
    return resolved;
  }

  const runsRootRaw = process.env.RUNS_ROOT?.trim();
  const runsRoot = runsRootRaw
    ? (path.isAbsolute(runsRootRaw) ? runsRootRaw : path.resolve(REPO_ROOT, runsRootRaw))
    : path.join(REPO_ROOT, "data", "runs");
  mkdirSync(runsRoot, { recursive: true });

  const runId = process.env.RUN_ID?.trim() || stamp();
  const runRoot = path.join(runsRoot, runId);
  mkdirSync(runRoot, { recursive: true });

  process.env.RUNS_ROOT = runsRoot;
  process.env.RUN_ID = runId;
  process.env.RUN_ROOT = runRoot;
  if (!process.env.RUN_ROOT_SINGLE) process.env.RUN_ROOT_SINGLE = "1";

  const dataVars = [
    "DATA_DIR",
    "ARB_DATA_DIR",
    "ARB_LIVE_DIR",
    "ARB_ML_DIR",
    "SESSION_LOGS_DIR",
    "AMMS_DATA_DIR",
  ];
  for (const key of dataVars) {
    if (!process.env[key] || process.env[key]?.trim() === "") {
      process.env[key] = runRoot;
    }
  }

  const runMetaPath = path.join(runRoot, "run.json");
  if (!existsSync(runMetaPath)) {
    try {
      writeFileSync(
        runMetaPath,
        JSON.stringify(
          {
            run_id: runId,
            started_at: new Date().toISOString(),
            source: process.env.RUN_SOURCE ?? "auto",
          },
          null,
          2,
        ),
      );
    } catch {
      /* ignore metadata write errors */
    }
  }

  const liveDir = path.join(runRoot, "live");
  try { mkdirSync(liveDir, { recursive: true }); } catch { /* ignore */ }

  return runRoot;
}

function ensureDirSync(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // ignore mkdir errors
  }
}

function resolveLogFile(): string {
  const explicit = process.env.LOG_FILE?.trim();
  if (explicit && explicit.length) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(REPO_ROOT, explicit);
    ensureDirSync(resolved);
    return resolved;
  }

  const runRoot = ensureRunRoot();
  const fallback = path.join(runRoot, "arb-runtime.jsonl");
  process.env.LOG_FILE = fallback;
  ensureDirSync(fallback);
  return fallback;
}

export function getRunRoot(): string {
  return ensureRunRoot();
}

const LOG_FILE = resolveLogFile();

type Payload = unknown;

async function write(rec: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(LOG_FILE, JSON.stringify(rec) + "\n");
  } catch {
    // swallow file write errors; console is the source of truth during dev
  }
}

/** Named export with a .log() method */
export const logger = {
  log(event: string, payload?: Payload): void {
    const t = new Date().toISOString();
    if (payload === undefined) {
      // eslint-disable-next-line no-console
      console.log(`${t} ${event}`);
      void write({ t, event });
    } else {
      // eslint-disable-next-line no-console
      console.log(`${t} ${event}`, payload);
      void write({ t, event, data: payload });
    }
  },
  scope(scope: string): { log: (event: string, payload?: Payload) => void } {
    return {
      log(event: string, payload?: Payload): void {
        const t = new Date().toISOString();
        const ev = `${scope}_${event}`;
        if (payload === undefined) {
          // eslint-disable-next-line no-console
          console.log(`${t} ${ev}`);
          void write({ t, scope, event });
        } else {
          // eslint-disable-next-line no-console
          console.log(`${t} ${ev}`, payload);
          void write({ t, scope, event, data: payload });
        }
      },
    };
  },
};
