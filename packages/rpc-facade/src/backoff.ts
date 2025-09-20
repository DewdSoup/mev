import { logger } from "@mev/storage";

type AnyFn = (...args: any[]) => Promise<any>;

function envNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function envBool(name: string, def = true): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return def;
  return v === "1" || v === "true" || v === "yes";
}

const DEFAULT_MAX_CONCURRENCY = envNum("RPC_BACKOFF_MAX_CONCURRENCY", 6);
const DEFAULT_MAX_RETRIES = envNum("RPC_BACKOFF_MAX_RETRIES", 5);
const DEFAULT_BASE_MS = envNum("RPC_BACKOFF_BASE_MS", 200);
const DEFAULT_MAX_MS = envNum("RPC_BACKOFF_MAX_MS", 2000);
const SHOULD_LOG = envBool("RPC_BACKOFF_LOG", true);
const STATS_EVERY_MS = envNum("RPC_BACKOFF_STATS_MS", 15_000);

const retryCounts = new Map<string, number>();
const finalCounts = new Map<string, number>();
const rateLimitCounts = new Map<string, number>();
let lastStatsEmit = Date.now();

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function maybeEmitStats() {
  if (!(STATS_EVERY_MS > 0)) return;
  const now = Date.now();
  if (now - lastStatsEmit < STATS_EVERY_MS) return;
  const retry = retryCounts.size ? Object.fromEntries(retryCounts.entries()) : undefined;
  const finals = finalCounts.size ? Object.fromEntries(finalCounts.entries()) : undefined;
  const rateLimited = rateLimitCounts.size ? Object.fromEntries(rateLimitCounts.entries()) : undefined;
  logger.log("rpc_backoff_stats", {
    window_ms: now - lastStatsEmit,
    retry_counts: retry,
    final_errors: finals,
    rate_limited: rateLimited,
  });
  retryCounts.clear();
  finalCounts.clear();
  rateLimitCounts.clear();
  lastStatsEmit = now;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number) {
  const r = (Math.random() - 0.5) * 0.5;
  return Math.max(0, Math.floor(ms * (1 + r)));
}

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];
  constructor(private max: number) {}
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>((res) => this.queue.push(res));
    this.current++;
  }
  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

function classifyError(e: any): { retry: boolean; rateLimited: boolean } {
  if (!e) return { retry: false, rateLimited: false };
  const msg = String((e as any)?.message ?? e).toLowerCase();
  const rateLimited = msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  const transient =
    rateLimited ||
    msg.includes("timeout") ||
    msg.includes("internal server error") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504");
  return { retry: transient, rateLimited };
}

async function callWithRetry<T>(fn: AnyFn, opts?: {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  label?: string;
}): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseMs = opts?.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts?.maxMs ?? DEFAULT_MAX_MS;
  const label = opts?.label ?? "rpc";

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const out = await fn();
      return out;
    } catch (err) {
      const e = err as any;
      const { retry, rateLimited } = classifyError(e);
      if (rateLimited) bump(rateLimitCounts, label);
      if (!retry || attempt > maxRetries) {
        bump(finalCounts, label);
        maybeEmitStats();
        if (SHOULD_LOG) logger.log("rpc_backoff_final_error", { label, attempt, error: String(e?.message ?? e) });
        throw err;
      }
      const backMs = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
      const wait = jitter(backMs);
      bump(retryCounts, label);
      maybeEmitStats();
      if (SHOULD_LOG) {
        const logObj: Record<string, unknown> = {
          label,
          attempt,
          wait_ms: wait,
          error: String(e?.message ?? e),
        };
        if (rateLimited) logObj.rate_limited = true;
        logger.log("rpc_backoff_retry", logObj);
      }
      await sleep(wait);
    }
  }
}

export function withRpcBackoff(conn: any, opts?: { maxConcurrency?: number; maxRetries?: number; baseMs?: number; maxMs?: number }) {
  const maxConcurrency = opts?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const sem = new Semaphore(maxConcurrency);
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseMs = opts?.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts?.maxMs ?? DEFAULT_MAX_MS;

  const wrap = (fnName: string) => {
    const orig = conn[fnName]?.bind(conn);
    if (typeof orig !== "function") return undefined;
    return async (...args: any[]) => {
      await sem.acquire();
      try {
        return await callWithRetry(() => orig(...args), { maxRetries, baseMs, maxMs, label: fnName });
      } finally {
        sem.release();
      }
    };
  };

  const proxy: any = new Proxy(conn, {
    get(target, prop: string | symbol, receiver) {
      if (typeof prop === "string") {
        if ([
          "getLatestBlockhash",
          "getAccountInfo",
          "getParsedTokenAccountsByOwner",
          "getBalance",
          "getTokenAccountBalance",
          "getRecentPerformanceSamples",
          "getVersion",
          "getSlot",
          "sendTransaction",
          "confirmTransaction",
        ].includes(prop)) {
          const wrapped = wrap(prop);
          if (wrapped) return wrapped;
        }
      }
      const v = (target as any)[prop];
      if (typeof v === "function") return v.bind(target);
      return v;
    },
  });

  proxy.__rpc_backoff = {
    maxConcurrency,
    maxRetries,
    baseMs,
    maxMs,
  };

  logger.log("rpc_backoff_initialized", { maxConcurrency, maxRetries, baseMs, maxMs });
  return proxy;
}
