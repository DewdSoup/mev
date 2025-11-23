import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type {
  Commitment,
  SendOptions,
  BlockhashWithExpiryBlockHeight,
  AccountInfo,
  GetAccountInfoConfig,
  GetProgramAccountsConfig,
  GetMultipleAccountsConfig,
} from "@solana/web3.js";
import { logger } from "@mev/storage";
import { withRpcBackoff, type RpcRateLimitInfo } from "./backoff.js";

const DEFAULT_HTTP_ENDPOINT = String(process.env.RPC_URL ?? process.env.RPC_PRIMARY ?? "").trim();
const DEFAULT_WS_ENDPOINT =
  process.env.RPC_WSS_URL?.trim() ||
  process.env.WS_URL?.trim() ||
  process.env.WSS_URL?.trim() ||
  process.env.RPC_WSS_FALLBACK?.trim() ||
  process.env.WS_FALLBACK?.trim();

if (!DEFAULT_HTTP_ENDPOINT) {
  throw new Error("rpc_facade_missing_rpc_url");
}

function envBool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return def;
}

function envNum(name: string, def: number, min?: number, max?: number): number {
  const raw = Number(process.env[name]);
  const val = Number.isFinite(raw) ? raw : def;
  const lo = min ?? Number.MIN_SAFE_INTEGER;
  const hi = max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(lo, Math.min(hi, val));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type QueueItem<T> = {
  label: string;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  work: () => Promise<T>;
};

class TokenBucketLimiter {
  private capacity: number;
  private ratePerMs: number;
  private readonly debounceMs: number;
  private tokens: number;
  private lastRefill: number;
  private queue: Array<QueueItem<any>> = [];
  private processing = false;
  public queueDepth = 0;
  private readonly onDepthSample?: (depth: number) => void;
  private currentRps: number;
  private currentBurst: number;

  constructor(opts: { rps: number; burst: number; debounceMs: number; onDepthSample?: (depth: number) => void }) {
    this.debounceMs = Math.max(0, opts.debounceMs);
    this.onDepthSample = opts.onDepthSample;
    this.capacity = 1;
    this.ratePerMs = 1 / 1000;
    this.tokens = 1;
    this.lastRefill = Date.now();
    this.currentRps = 1;
    this.currentBurst = 1;
    this.updateLimits(opts.rps, opts.burst);
    this.tokens = this.capacity;
  }

  updateLimits(rps: number, burst?: number) {
    const safeRps = Math.max(1, Number.isFinite(rps) ? Number(rps) : 1);
    const safeBurst = Math.max(1, Number.isFinite(burst ?? this.currentBurst) ? Number(burst ?? this.currentBurst) : 1);
    this.capacity = safeBurst;
    this.currentBurst = safeBurst;
    this.currentRps = safeRps;
    this.ratePerMs = safeRps / 1000;
    this.tokens = Math.min(this.tokens, this.capacity);
  }

  describeLimits() {
    return { rps: this.currentRps, burst: this.currentBurst };
  }

  async run<T>(label: string, work: () => Promise<T>, disable: boolean): Promise<T> {
    if (disable) return work();
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, resolve, reject, work });
      this.queueDepth = Math.max(this.queueDepth, this.queue.length);
      this.onDepthSample?.(this.queue.length);
      if (!this.processing) {
        this.processing = true;
        void this.processLoop();
      }
    });
  }

  private async processLoop(): Promise<void> {
    while (this.queue.length) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        const item = this.queue.shift()!;
        try {
          const result = await item.work();
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }
        if (this.queue.length && this.debounceMs > 0) {
          await sleep(this.debounceMs);
        }
        this.onDepthSample?.(this.queue.length);
        continue;
      }
      const needed = 1 - this.tokens;
      const waitMs = Math.max(this.debounceMs, needed / this.ratePerMs);
      await sleep(Math.ceil(waitMs));
    }
    this.queueDepth = 0;
    this.onDepthSample?.(0);
    this.processing = false;
  }

  private refill() {
    const now = Date.now();
    if (now <= this.lastRefill) return;
    const elapsed = now - this.lastRefill;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
  }
}

type BlockhashCacheEntry = {
  value: BlockhashWithExpiryBlockHeight;
  ts: number;
};

class BlockhashCache {
  private readonly ttlMs: number;
  private readonly map = new Map<string, BlockhashCacheEntry>();

  constructor(ttlMs: number) {
    this.ttlMs = Math.max(500, ttlMs);
  }

  get(commitment: Commitment): BlockhashWithExpiryBlockHeight | null {
    const key = commitment ?? "finalized";
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  set(commitment: Commitment, value: BlockhashWithExpiryBlockHeight) {
    const key = commitment ?? "finalized";
    this.map.set(key, { value, ts: Date.now() });
  }
}

type BatchRequest = {
  pubkey: PublicKey;
  config?: GetAccountInfoConfig;
  resolve: (info: AccountInfo<Buffer> | null) => void;
  reject: (err: unknown) => void;
};

class AccountBatcher {
  private readonly delayMs: number;
  private readonly maxBatch: number;
  private queue: BatchRequest[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly facade: RpcFacade, delayMs: number, maxBatch: number) {
    this.delayMs = Math.max(1, delayMs);
    this.maxBatch = Math.max(1, maxBatch);
  }

  schedule(pubkey: PublicKey, config?: GetAccountInfoConfig): Promise<AccountInfo<Buffer> | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ pubkey, config, resolve, reject });
      if (this.queue.length >= this.maxBatch) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.delayMs);
      }
    });
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) return;

    const requests = this.queue.splice(0, this.maxBatch);
    const keyGroups = new Map<string, BatchRequest[]>();
    for (const req of requests) {
      const commitment = req.config?.commitment ?? "processed";
      const encoding = (req.config as any)?.encoding ?? "base64";
      const dataSlice = req.config?.dataSlice ? `${req.config.dataSlice.offset}:${req.config.dataSlice.length}` : "";
      const groupKey = `${commitment}|${encoding}|${dataSlice}`;
      if (!keyGroups.has(groupKey)) keyGroups.set(groupKey, []);
      keyGroups.get(groupKey)!.push(req);
    }

    await Promise.allSettled(
      Array.from(keyGroups.entries()).map(async ([groupKey, items]) => {
        const [commitmentRaw, encoding, dataSliceRaw] = groupKey.split("|");
        const commitment = commitmentRaw as Commitment;
        const dataSlice = dataSliceRaw
          ? (() => {
              const [offsetStr, lenStr] = dataSliceRaw.split(":");
              return { offset: Number(offsetStr), length: Number(lenStr) };
            })()
          : undefined;
        const pubkeys = items.map((i) => i.pubkey);
        const label = `getMultipleAccountsInfo_${commitment}`;
        try {
          const requestConfig = {
            commitment,
            dataSlice,
          } as GetMultipleAccountsConfig & { encoding?: any };
          if (encoding) requestConfig.encoding = encoding;
          const infos = await this.facade.callWithBackoff(label, (conn) =>
            conn.getMultipleAccountsInfo(pubkeys, requestConfig)
          );
          items.forEach((item, idx) => {
            const info = infos?.[idx] ?? null;
            item.resolve(info);
          });
        } catch (err) {
          items.forEach((item) => item.reject(err));
        }
      })
    );
  }
}

class RpcMetrics {
  private readonly calls = new Map<string, number>();
  private readonly errors = new Map<string, number>();
  private limiterHighWater = 0;
  private blockhashHits = 0;
  private blockhashMisses = 0;
  private readonly interval: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(intervalMs: number) {
    this.interval = Math.max(0, intervalMs);
    if (this.interval > 0) {
      this.timer = setInterval(() => this.emit(), this.interval);
      if (typeof this.timer.unref === "function") this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  recordCall(label: string) {
    this.bump(this.calls, label);
  }

  recordError(label: string) {
    this.bump(this.errors, label);
  }

  recordQueueDepth(depth: number) {
    if (!Number.isFinite(depth)) return;
    this.limiterHighWater = Math.max(this.limiterHighWater, depth);
  }

  recordBlockhashHit(hit: boolean) {
    if (hit) this.blockhashHits += 1;
    else this.blockhashMisses += 1;
  }

  private bump(map: Map<string, number>, label: string) {
    const key = label || "unknown";
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private emit() {
    if (!this.calls.size && !this.errors.size && !this.limiterHighWater && !this.blockhashHits && !this.blockhashMisses) {
      return;
    }
    const payload: Record<string, unknown> = {
      calls: Object.fromEntries(this.calls.entries()),
      errors: this.errors.size ? Object.fromEntries(this.errors.entries()) : undefined,
      limiter_queue_high_water: this.limiterHighWater,
      blockhash_hits: this.blockhashHits,
      blockhash_misses: this.blockhashMisses,
    };
    logger.log("rpc_facade_metrics", payload);
    this.calls.clear();
    this.errors.clear();
    this.limiterHighWater = 0;
    this.blockhashHits = 0;
    this.blockhashMisses = 0;
  }
}

export type RpcFacadeOptions = {
  limiterEnabled: boolean;
  rps: number;
  burst: number;
  debounceMs: number;
  blockhashTtlMs: number;
  batchDelayMs: number;
  batchMax: number;
  metricsIntervalMs: number;
};

const DEFAULT_OPTS: RpcFacadeOptions = {
  limiterEnabled: envBool("RPC_FACADE_LIMITER", false),
  rps: envNum("RPC_FACADE_RPS", 8, 1, 100),
  burst: envNum("RPC_FACADE_BURST", 8, 1, 200),
  debounceMs: envNum("RPC_FACADE_DEBOUNCE_MS", 5, 0, 50),
  blockhashTtlMs: envNum("RPC_FACADE_BLOCKHASH_TTL_MS", 2500, 500, 10000),
  batchDelayMs: envNum("RPC_FACADE_BATCH_DELAY_MS", 6, 1, 50),
  batchMax: envNum("RPC_FACADE_BATCH_MAX", 32, 1, 128),
  metricsIntervalMs: envNum("RPC_FACADE_METRICS_MS", 30_000, 0, 600_000),
};

export class RpcFacade {
  public readonly rawConnection: Connection;
  private readonly backoffConnection: Connection;
  private readonly limiter: TokenBucketLimiter;
  private readonly blockhashCache: BlockhashCache;
  private readonly batcher: AccountBatcher;
  private readonly limiterDisabled: boolean;
  private readonly proxy: Connection;
  private readonly metrics: RpcMetrics;
  private limiterMaxRps: number;
  private limiterMaxBurst: number;
  private limiterCurrentRps: number;
  private limiterCurrentBurst: number;
  private readonly rampDownFactor = 0.8;
  private readonly rampDownCooldownMs: number;
  private readonly rampUpIntervalMs: number;
  private readonly rampUpStep: number;
  private lastRampDownTs = 0;
  private lastRampUpTs = 0;
  private lastRateLimitTs = 0;
  private readonly onBackoffRateLimit = (info: RpcRateLimitInfo) => {
    this.registerRateLimit("backoff", info);
  };

  constructor(private readonly opts: RpcFacadeOptions = DEFAULT_OPTS) {
    this.rawConnection = new Connection(DEFAULT_HTTP_ENDPOINT, {
      commitment: "processed",
      wsEndpoint: DEFAULT_WS_ENDPOINT,
    });
    this.metrics = new RpcMetrics(opts.metricsIntervalMs);
    this.limiter = new TokenBucketLimiter({
      rps: opts.rps,
      burst: opts.burst,
      debounceMs: opts.debounceMs,
      onDepthSample: (depth) => this.metrics.recordQueueDepth(depth),
    });
    this.limiterDisabled = !opts.limiterEnabled || envBool("RPC_FACADE_PASSTHROUGH", false);
    this.limiterMaxRps = Math.max(1, opts.rps);
    this.limiterMaxBurst = Math.max(1, opts.burst);
    this.limiterCurrentRps = this.limiterMaxRps;
    this.limiterCurrentBurst = this.limiterMaxBurst;
    this.rampDownCooldownMs = envNum("RPC_FACADE_RAMP_DOWN_COOLDOWN_MS", 2000, 250, 30_000);
    this.rampUpIntervalMs = envNum("RPC_FACADE_RAMP_UP_INTERVAL_MS", 5000, 500, 60_000);
    const rampPct = envNum("RPC_FACADE_RAMP_UP_PCT", 5, 1, 50);
    this.rampUpStep = Math.max(1, Math.round((this.limiterMaxRps * rampPct) / 100));
    this.backoffConnection = withRpcBackoff(this.rawConnection, {
      onRateLimit: this.onBackoffRateLimit,
    });
    this.blockhashCache = new BlockhashCache(opts.blockhashTtlMs);
    this.batcher = new AccountBatcher(this, opts.batchDelayMs, opts.batchMax);
    this.proxy = this.buildProxy();
    logger.log("rpc_facade_init", {
      http: maskUrlForLogs(DEFAULT_HTTP_ENDPOINT),
      ws_enabled: Boolean(DEFAULT_WS_ENDPOINT),
      limiter_enabled: !this.limiterDisabled,
      rps: opts.rps,
      burst: opts.burst,
      debounce_ms: opts.debounceMs,
      batch_delay_ms: opts.batchDelayMs,
      batch_max: opts.batchMax,
      blockhash_ttl_ms: opts.blockhashTtlMs,
      metrics_ms: opts.metricsIntervalMs,
    });
    process.once("exit", () => this.metrics.stop());
  }

  get connection(): Connection {
    return this.proxy;
  }

  private onLimiterSuccess() {
    if (this.limiterDisabled) return;
    this.maybeRampUp();
  }

  private isRateLimitError(err: unknown): boolean {
    if (!err) return false;
    const code = (err as any)?.code;
    if (code === -32429) return true;
    const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
    return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  }

  private registerRateLimit(
    source: "facade" | "backoff",
    info?: Partial<RpcRateLimitInfo> & { error?: unknown }
  ) {
    if (this.limiterDisabled) return;
    const now = Date.now();
    this.lastRateLimitTs = now;
    if (now - this.lastRampDownTs < this.rampDownCooldownMs) {
      return;
    }
    const nextRps = Math.max(1, Math.floor(this.limiterCurrentRps * this.rampDownFactor));
    if (nextRps >= this.limiterCurrentRps) {
      this.lastRampDownTs = now;
      this.lastRampUpTs = now;
      return;
    }
    const ratio = this.limiterMaxRps > 0 ? nextRps / this.limiterMaxRps : 1;
    const nextBurst = Math.max(1, Math.round(this.limiterMaxBurst * ratio));
    this.limiter.updateLimits(nextRps, nextBurst);
    this.limiterCurrentRps = nextRps;
    this.limiterCurrentBurst = nextBurst;
    this.lastRampDownTs = now;
    this.lastRampUpTs = now;
    logger.log("rpc_limiter_adjust", {
      reason: "rate_limit",
      source,
      rps: nextRps,
      burst: nextBurst,
      cap_rps: this.limiterMaxRps,
      cap_burst: this.limiterMaxBurst,
      label: info?.label,
      attempt: info?.attempt,
      wait_ms: info?.waitMs,
      error: info?.error ? String((info.error as any)?.message ?? info.error) : undefined,
    });
  }

  private maybeRampUp() {
    if (this.limiterDisabled) return;
    if (this.limiterCurrentRps >= this.limiterMaxRps) return;
    const now = Date.now();
    if (now - this.lastRampUpTs < this.rampUpIntervalMs) return;
    if (this.lastRateLimitTs && now - this.lastRateLimitTs < this.rampUpIntervalMs) return;
    const nextRps = Math.min(this.limiterMaxRps, this.limiterCurrentRps + this.rampUpStep);
    if (nextRps <= this.limiterCurrentRps) return;
    const ratio = this.limiterMaxRps > 0 ? nextRps / this.limiterMaxRps : 1;
    const nextBurst = Math.max(1, Math.round(this.limiterMaxBurst * ratio));
    this.limiter.updateLimits(nextRps, nextBurst);
    this.limiterCurrentRps = nextRps;
    this.limiterCurrentBurst = nextBurst;
    this.lastRampUpTs = now;
    logger.log("rpc_limiter_adjust", {
      reason: "ramp_up",
      source: "facade",
      rps: nextRps,
      burst: nextBurst,
      cap_rps: this.limiterMaxRps,
      cap_burst: this.limiterMaxBurst,
    });
  }

  async exec<T>(label: string, work: () => Promise<T>): Promise<T> {
    const metricsLabel = label || "unknown";
    this.metrics.recordCall(metricsLabel);
    return this.limiter.run(label, async () => {
      try {
        const result = await work();
        this.onLimiterSuccess();
        return result;
      } catch (err) {
        this.metrics.recordError(metricsLabel);
        if (this.isRateLimitError(err)) {
          this.registerRateLimit("facade", { label, error: err });
        }
        throw err;
      }
    }, this.limiterDisabled);
  }

  async callWithBackoff<T>(label: string, work: (conn: Connection) => Promise<T>): Promise<T> {
    return this.exec(label, () => work(this.backoffConnection));
  }

  async getAccountInfo(pubkey: PublicKey, config?: GetAccountInfoConfig): Promise<AccountInfo<Buffer> | null> {
    return this.batcher.schedule(pubkey, config);
  }

  async getLatestBlockhash(commitment: Commitment = "processed"): Promise<BlockhashWithExpiryBlockHeight> {
    const cached = this.blockhashCache.get(commitment);
    if (cached) {
      this.metrics.recordBlockhashHit(true);
      return cached;
    }
    const next = await this.callWithBackoff(`getLatestBlockhash_${commitment}`, (conn) =>
      conn.getLatestBlockhash(commitment)
    );
    this.metrics.recordBlockhashHit(false);
    this.blockhashCache.set(commitment, next);
    return next;
  }

  async sendTransaction(tx: VersionedTransaction, opts?: SendOptions): Promise<string> {
    const senderUrl = process.env.RPC_SENDER_URL?.trim();
    if (senderUrl) {
      logger.log("rpc_facade_sender_path", { sender: maskUrlForLogs(senderUrl) });
    }
    return this.callWithBackoff("sendTransaction", (conn) => conn.sendTransaction(tx, opts));
  }

  async simulateTransaction(tx: VersionedTransaction, opts?: Parameters<Connection["simulateTransaction"]>[1]) {
    return this.callWithBackoff("simulateTransaction", (conn) => conn.simulateTransaction(tx, opts));
  }

  async confirmTransaction(signature: string, commitment?: Commitment) {
    return this.callWithBackoff("confirmTransaction", (conn) => conn.confirmTransaction(signature, commitment as any));
  }

  async getSlot(commitment?: Commitment): Promise<number> {
    return this.callWithBackoff(`getSlot_${commitment ?? "default"}`, (conn) => conn.getSlot(commitment));
  }

  async getRecentPerformanceSamples(limit: number) {
    return this.callWithBackoff("getRecentPerformanceSamples", (conn) => conn.getRecentPerformanceSamples(limit));
  }

  async getVersion() {
    return this.callWithBackoff("getVersion", (conn) => conn.getVersion());
  }

  async getEpochInfo(commitment?: Commitment) {
    return this.callWithBackoff(`getEpochInfo_${commitment ?? "processed"}`, (conn) => conn.getEpochInfo(commitment));
  }

  async getAddressLookupTable(address: PublicKey) {
    return this.callWithBackoff("getAddressLookupTable", (conn) => conn.getAddressLookupTable(address));
  }

  async getBalance(pubkey: PublicKey, commitment?: Commitment): Promise<number> {
    return this.callWithBackoff(`getBalance_${commitment ?? "processed"}`, (conn) => conn.getBalance(pubkey, commitment));
  }

  async getTokenAccountBalance(pubkey: PublicKey, commitment?: Commitment) {
    return this.callWithBackoff(`getTokenAccountBalance_${commitment ?? "processed"}`, (conn) => conn.getTokenAccountBalance(pubkey, commitment));
  }

  async getProgramAccounts(programId: PublicKey, config?: GetProgramAccountsConfig) {
    return this.callWithBackoff("getProgramAccounts", (conn) => conn.getProgramAccounts(programId, config));
  }

  async warmupAccounts(pubkeys: PublicKey[], commitment: Commitment = "processed", chunkSize = 100): Promise<(AccountInfo<Buffer> | null)[]> {
    if (!pubkeys.length) return [];
    const out: (AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < pubkeys.length; i += chunkSize) {
      const chunk = pubkeys.slice(i, i + chunkSize);
      const infos = await this.callWithBackoff(`warmup_getMultipleAccounts_${commitment}`, (conn) =>
        conn.getMultipleAccountsInfo(chunk, { commitment })
      );
      for (const info of infos ?? []) out.push(info ?? null);
    }
    return out;
  }

  private buildProxy(): Connection {
    const self = this;
    const handler: ProxyHandler<Connection> = {
      get(target, prop, receiver) {
        if (prop === "__rpc_facade__") return true;
        if (prop === "getLatestBlockhash") {
          return (commitment?: Commitment) => self.getLatestBlockhash(commitment ?? "processed");
        }
        if (prop === "sendTransaction") {
          return (tx: VersionedTransaction, opts?: SendOptions) => self.sendTransaction(tx, opts);
        }
        if (prop === "simulateTransaction") {
          return (tx: VersionedTransaction, opts?: Parameters<Connection["simulateTransaction"]>[1]) =>
            self.simulateTransaction(tx, opts);
        }
        if (prop === "confirmTransaction") {
          return (signature: string, commitment?: Commitment) => self.confirmTransaction(signature, commitment);
        }
        if (prop === "getAccountInfo") {
          return (pubkey: PublicKey, config?: GetAccountInfoConfig) => self.getAccountInfo(pubkey, config);
        }
        if (prop === "getTokenAccountBalance") {
          return (pubkey: PublicKey, commitment?: Commitment) => self.getTokenAccountBalance(pubkey, commitment);
        }
        if (prop === "getBalance") {
          return (pubkey: PublicKey, commitment?: Commitment) => self.getBalance(pubkey, commitment);
        }
        if (prop === "getSlot") {
          return (commitment?: Commitment) => self.getSlot(commitment);
        }
        if (prop === "getRecentPerformanceSamples") {
          return (limit: number) => self.getRecentPerformanceSamples(limit);
        }
        if (prop === "getVersion") {
          return () => self.getVersion();
        }
        if (prop === "getEpochInfo") {
          return (commitment?: Commitment) => self.getEpochInfo(commitment);
        }
        if (prop === "getAddressLookupTable") {
          return (pk: PublicKey) => self.getAddressLookupTable(pk);
        }
        if (prop === "getProgramAccounts") {
          return (programId: PublicKey, config?: GetProgramAccountsConfig) => self.getProgramAccounts(programId, config);
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") return value.bind(target);
        return value;
      },
    };
    return new Proxy(this.backoffConnection, handler);
  }
}

function maskUrlForLogs(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("api-key")) {
      u.searchParams.set("api-key", "***");
    }
    return u.toString();
  } catch {
    return url;
  }
}

let singleton: RpcFacade | null = null;

export function getRpcFacade(): RpcFacade {
  if (!singleton) singleton = new RpcFacade();
  return singleton;
}

export const rpc = getRpcFacade();
export const rpcClient = rpc.connection;
export const RPC_HTTP_ENDPOINT = DEFAULT_HTTP_ENDPOINT;
export const RPC_WS_ENDPOINT = DEFAULT_WS_ENDPOINT ?? "";
