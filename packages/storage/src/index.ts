import "dotenv/config";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

const LOG_FILE = process.env.LOG_FILE ?? "./logs/runtime.jsonl";

async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch {
    // ignore
  }
}
void ensureDir(LOG_FILE);

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
