// services/arb-mm/src/util/rpc_backoff.ts
// Generic RPC wrapper with bounded concurrency + exponential backoff + jitter.
// Wrap a @solana/web3.js Connection and return a proxy exposing the same methods
// (only the commonly-used ones are wrapped here).
//
// Env control:
//   RPC_BACKOFF_MAX_CONCURRENCY (default 6)
//   RPC_BACKOFF_MAX_RETRIES (default 5)
//   RPC_BACKOFF_BASE_MS (default 200)
//   RPC_BACKOFF_MAX_MS (default 2000)
//   RPC_BACKOFF_LOG (default true)
//
// Usage:
//   import { withRpcBackoff } from "./util/rpc_backoff.js";
//   const conn = new Connection(RPC, ...);
//   const connSafe = withRpcBackoff(conn);

import { logger } from "../ml_logger.js";

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

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number) {
    // +/- 25% jitter
    const r = (Math.random() - 0.5) * 0.5;
    return Math.max(0, Math.floor(ms * (1 + r)));
}

/** Simple semaphore for concurrency limiting. */
class Semaphore {
    private current = 0;
    private queue: Array<() => void> = [];
    constructor(private max: number) { }
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

/** Determine if we should retry based on error or RPC result. */
function shouldRetryError(e: any): boolean {
    if (!e) return false;
    const msg = String((e as any)?.message ?? e).toLowerCase();
    // Helius / Alchemy / RPC 429 semantics often include '429' / 'too many requests' / 'rate limited'
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) return true;
    // common transient RPC errors
    if (msg.includes("timeout") || msg.includes("internal server error") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
    return false;
}

/**
 * Wrap a single async call with retry/backoff.
 * fn: a function which returns a Promise.
 */
async function callWithRetry<T>(fn: AnyFn, opts?: {
    maxRetries?: number;
    baseMs?: number;
    maxMs?: number;
    ctx?: any;
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
            if (!shouldRetryError(e) || attempt > maxRetries) {
                if (SHOULD_LOG) logger.log("rpc_backoff_final_error", { label, attempt, error: String(e?.message ?? e) });
                throw err;
            }
            // exponential backoff with jitter
            const backMs = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
            const wait = jitter(backMs);
            if (SHOULD_LOG) logger.log("rpc_backoff_retry", { label, attempt, wait_ms: wait, error: String(e?.message ?? e) });
            await sleep(wait);
            continue;
        }
    }
}

/**
 * Wrap a Connection instance and return a proxy that retries common calls.
 * The returned object is typed as `any` to be flexible; we only wrap the methods
 * used throughout the arb runner.
 */
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

    // Build proxy object that forwards all properties but wraps selected functions
    const proxy: any = new Proxy(conn, {
        get(target, prop: string | symbol, receiver) {
            if (typeof prop === "string") {
                // methods we wrap
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
            // default: forward unmodified
            const v = (target as any)[prop];
            if (typeof v === "function") return v.bind(target);
            return v;
        }
    });

    // small metadata for debugging
    proxy.__rpc_backoff = {
        maxConcurrency,
        maxRetries,
        baseMs,
        maxMs,
    };

    logger.log("rpc_backoff_initialized", { maxConcurrency, maxRetries, baseMs, maxMs });
    return proxy;
}
