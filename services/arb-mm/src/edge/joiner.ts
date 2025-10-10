// services/arb-mm/src/edge/joiner.ts
// Multi-venue joiner (Raydium & Orca) with concurrent per-venue route evaluation.
// NOW config-driven via adapters manifest, still keeps fast publisher snapshots.
// - Reads pairs.json venues[] and gates to only configured pools (Broaden venue by config, not code).
// - Uses adapters.manifest().quote() first (fee/slippage aware), then falls back to local CPMM/CLMM paths.
// - Tracks AMM↔AMM opportunities (configurable), still emits PHX features only for PHX paths.
// - Optional RPC sim tolerance gate for PHX paths.
// - Orca CLMM quoting prefers adapter quoter; hard fallback keeps "works without funding."

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { logger } from "../ml_logger.js";
import { type PhoenixBook } from "../syntheticPhoenix.js";
import { emitFeature, featureFromEdgeAndDecision } from "../feature_sink.js";
import { noteDecision } from "../risk.js";
import type { SlipMode } from "../config.js";
import {
  type PhoenixBook as SizePhoenixBook,
} from "../executor/size.js";
import {
  orcaAvgBuyQuotePerBase,
  orcaAvgSellQuotePerBase,
} from "../executor/orca_quoter.js";
import { quoteClmm } from "./clmm_quoter.js";
import { quoteDlmm } from "./dlmm_quoter.js";
import Decimal from "decimal.js";
import { getCachedOrcaFee, getCachedRaydiumFee } from "../util/fee_cache.js";
import { cpmmBuyQuotePerBase, cpmmSellQuotePerBase } from "../util/cpmm.js";
import type { PairSpec } from "../registry/pairs.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

// NEW: config-driven adapters
import { getAdapter } from "../adapters/manifest.js";
type QuoteReq = {
  poolId: string;
  side: "buy" | "sell";           // buy = want BASE (pay QUOTE) ; sell = sell BASE (get QUOTE)
  sizeBase: number;               // size in BASE units
  slippageBps: number;
  baseMint?: string;
  quoteMint?: string;
};
// IMPORTANT: align with adapter QuoteResp (error branch uses `err`, not `reason`)
type QuoteRes =
  | { ok: true; price: number; feeBps?: number; meta?: any }
  | { ok: false; err: string };

// ────────────────────────────────────────────────────────────────────────────
// Production constants (caps/guards)
const MAX_REALISTIC_PROFIT_BPS = Number(process.env.MAX_REALISTIC_PROFIT_BPS ?? 100);
const MIN_PROFITABLE_BPS = Number(process.env.MIN_PROFITABLE_BPS ?? 5);
const MIN_NET_PROFIT_BPS = Number(process.env.MIN_NET_PROFIT_BPS ?? MIN_PROFITABLE_BPS);
const MAX_DAILY_TRADES = Number(process.env.MAX_DAILY_TRADES ?? 50);
const MAX_DAILY_VOLUME_QUOTE = Number(process.env.MAX_DAILY_VOLUME_QUOTE ?? 10000);
const PRICE_VALIDATION_WINDOW_BPS = Number(
  process.env.PRICE_VALIDATION_WINDOW_BPS ??
  process.env.PRICE_VALIDATION_MAX_SPREAD_BPS ??
  200
);

// Clamp for Orca exact-in/out to ensure SDK never sees 0
const MIN_ORCA_BASE_SIZE = Number(process.env.MIN_ORCA_BASE_SIZE ?? "0.000001");
const CLMM_PREFER_ADAPTER = envTrue("CLMM_PREFER_ADAPTER", false);
const RATE_LIMIT_BACKOFF_MS = Math.max(250, Number(process.env.RATE_LIMIT_BACKOFF_MS ?? 1500));
const MIN_PRICE_DELTA_BPS = Math.max(0, Number(process.env.MIN_PRICE_DELTA_BPS ?? 1));
const ALLOW_STALE_DECISIONS = envTrue("ALLOW_STALE_DECISIONS", true);
const AMM_DEGRADE_LOG_WINDOW_MS = Math.max(500, Number(process.env.AMM_DEGRADE_LOG_WINDOW_MS ?? 2000));

const PATH_PAIR_LOG_ENABLED = envTrue("LOG_PATH_PAIRS", true);
const PATH_PAIR_LOG_PATH = (() => {
  const explicit = String(process.env.PATH_PAIRS_LOG ?? "").trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(explicit);
  const runRoot = String(process.env.RUN_ROOT ?? "").trim();
  if (runRoot) return path.resolve(runRoot, "path-pairs.log");
  return path.resolve(process.cwd(), "data", "logs", "path-pairs.log");
})();

let pathPairWriter: fs.WriteStream | null = null;
if (PATH_PAIR_LOG_ENABLED && PATH_PAIR_LOG_PATH) {
  try { fs.mkdirSync(path.dirname(PATH_PAIR_LOG_PATH), { recursive: true }); } catch { /* ignore */ }
  try {
    pathPairWriter = fs.createWriteStream(PATH_PAIR_LOG_PATH, {
      flags: "a",
      encoding: "utf8",
      mode: 0o644,
    });
  } catch (err) {
    pathPairWriter = null;
    logger.log("path_pair_log_open_error", { file: PATH_PAIR_LOG_PATH, err: String((err as any)?.message ?? err) });
  }
  const close = () => {
    try { pathPairWriter?.end(); } catch { /* noop */ }
    pathPairWriter = null;
  };
  process.once("beforeExit", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function appendPathPairLog(payload: Record<string, unknown>): void {
  if (!pathPairWriter) return;
  try {
    pathPairWriter.write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    logger.log("path_pair_log_write_error", { err: String((err as any)?.message ?? err) });
    try { pathPairWriter.end(); } catch { /* noop */ }
    pathPairWriter = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Staleness guard helpers
function envInt(name: string, def: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}

function loadVenueOverrides(prefix: string): Record<string, number> {
  const out: Record<string, number> = {};
  const needle = `${prefix}__`;
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(needle)) continue;
    const venue = key.slice(needle.length).toLowerCase();
    const num = Number(value);
    if (Number.isFinite(num)) out[venue] = Number(num);
  }
  return out;
}

const AMM_SLOT_MAX_LAG_DEFAULT = envInt("AMM_SLOT_MAX_LAG", 2);
const AMM_SLOT_MAX_LAG_BY_VENUE = loadVenueOverrides("AMM_SLOT_MAX_LAG");

const AMM_SNAPSHOT_FALLBACK_AGE_MS_DEFAULT = envInt(
  "AMM_SNAPSHOT_FALLBACK_AGE_MS",
  envInt("PRICE_STALENESS_MS", 4000)
);
const AMM_SNAPSHOT_FALLBACK_AGE_MS_BY_VENUE = loadVenueOverrides("AMM_SNAPSHOT_FALLBACK_AGE_MS");

const AMM_HEARTBEAT_SOFT_MS_DEFAULT = envInt("AMM_HEARTBEAT_SOFT_MS", 20_000);
const AMM_HEARTBEAT_SOFT_MS_BY_VENUE = loadVenueOverrides("AMM_HEARTBEAT_SOFT_MS");

const CONFIG_SLOT_LAG_BY_VENUE = new Map<string, number>();
const CONFIG_AGE_BY_VENUE = new Map<string, number>();
const CONFIG_HEARTBEAT_GRACE_MS_BY_VENUE = new Map<string, number>();
const CONFIG_TRADEABLE_BY_VENUE = new Map<string, boolean>();

function resolveVenueNumber(
  venue: string,
  overrides: Record<string, number>,
  fallback: number,
): number {
  return overrides[venue.toLowerCase()] ?? fallback;
}

export function resolveSlotLagLimit(venue: string): number {
  const envOverride = AMM_SLOT_MAX_LAG_BY_VENUE[venue.toLowerCase()];
  if (envOverride != null) return envOverride;
  const cfg = CONFIG_SLOT_LAG_BY_VENUE.get(venue.toLowerCase());
  if (cfg != null) return cfg;
  return resolveVenueNumber(venue, AMM_SLOT_MAX_LAG_BY_VENUE, AMM_SLOT_MAX_LAG_DEFAULT);
}

export function resolveSnapshotAgeLimit(venue: string): number {
  const envOverride = AMM_SNAPSHOT_FALLBACK_AGE_MS_BY_VENUE[venue.toLowerCase()];
  if (envOverride != null) return envOverride;
  const cfg = CONFIG_AGE_BY_VENUE.get(venue.toLowerCase());
  if (cfg != null) return cfg;
  return resolveVenueNumber(venue, AMM_SNAPSHOT_FALLBACK_AGE_MS_BY_VENUE, AMM_SNAPSHOT_FALLBACK_AGE_MS_DEFAULT);
}

export function resolveHeartbeatGraceMs(venue: string): number {
  const envOverride = AMM_HEARTBEAT_SOFT_MS_BY_VENUE[venue.toLowerCase()];
  if (envOverride != null) return envOverride;
  const cfg = CONFIG_HEARTBEAT_GRACE_MS_BY_VENUE.get(venue.toLowerCase());
  if (cfg != null) return cfg;
  return resolveVenueNumber(venue, AMM_HEARTBEAT_SOFT_MS_BY_VENUE, AMM_HEARTBEAT_SOFT_MS_DEFAULT);
}

type FreshnessCheck = {
  ok: boolean;
  reason?: string;
  skew?: number;
  ageMs?: number;
};

export function checkAmmFreshness(
  snap: { ts: number; slot?: number | null; venue: string; ammId: string },
  phoenixSlot: number | null | undefined,
  now: number,
  slotSkewMax: number,
  fallbackAgeMs: number,
  bookTtlMs?: number
): FreshnessCheck {
  const slot = snap.slot != null ? Number(snap.slot) : null;
  const hasSlot = slot != null && Number.isFinite(slot);
  const phxSlot = phoenixSlot != null && Number.isFinite(phoenixSlot) ? Number(phoenixSlot) : null;

  if (hasSlot && phxSlot != null) {
    const diff = phxSlot - slot!; // positive => AMM lagging behind Phoenix
    const skew = Math.abs(diff);
    if (diff > slotSkewMax) {
      return { ok: false, reason: `slot_skew>${slotSkewMax}`, skew };
    }
    return { ok: true, skew };
  }

  const ageMs = Math.max(0, now - (snap.ts || 0));
  const ttl = typeof bookTtlMs === "number" && Number.isFinite(bookTtlMs)
    ? Math.max(100, bookTtlMs)
    : null;
  const limit = Math.max(100, ttl != null ? Math.max(fallbackAgeMs, ttl) : fallbackAgeMs);
  if (ageMs > limit) {
    return { ok: false, reason: `age_ms>${limit}`, ageMs };
  }
  return { ok: true, ageMs };
}

export function isSoftStaleEligible(
  snapshot: AmmSnap,
  reason: string,
  now: number,
  graceMs: number,
  tradeablePreferred?: boolean,
): boolean {
  if (!ALLOW_STALE_DECISIONS) return false;
  const wantSoft = Boolean(snapshot.tradeableWhenDegraded || tradeablePreferred);
  if (!wantSoft) return false;
  if (!(reason.startsWith("slot_skew") || reason.startsWith("age_ms"))) return false;
  const heartbeatAt = nnum(snapshot.heartbeatAt);
  const wsAt = nnum(snapshot.wsAt);
  const signalAt = heartbeatAt ?? wsAt;
  if (signalAt == null) return false;
  if (now - signalAt > graceMs) return false;
  if (heartbeatAt != null && now - heartbeatAt > graceMs) return false;
  return true;
}

function envTrue(name: string, def?: boolean): boolean {
  const d = def ?? false;
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return d;
}
function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Circuit breaker state
let dailyTrades = 0;
let dailyVolumeQuote = 0;
let lastResetDay = new Date().getUTCDate();

function nnum(x: any): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function parseAtoms(str: string | undefined): bigint | null {
  if (!str) return null;
  const normalized = str.trim();
  if (!normalized || normalized.includes(".")) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}
function round(n: any, p?: number): number {
  const num = typeof n === "bigint" ? Number(n) : typeof n === "string" ? Number(n) : Number(n);
  const places = p ?? 6;
  return Number.isFinite(num) ? Number(num.toFixed(places)) : Number.NaN;
}

// ────────────────────────────────────────────────────────────────────────────
// Types and state
type Mid = { px: number; ts: number };
type DepthSide = { px: number; qty: number };

type AmmKey = string; // `${venue}:${ammId}`
type AmmSnap = {
  venue: "raydium" | "orca" | string;
  ammId: string;
  px: number;
  ts: number;            // publisher-provided ts if available; else Date.now()
  slot?: number | null;  // optional publisher slot
  reserves?: { base: number; quote: number; baseDecimals: number; quoteDecimals: number };
  feeBps: number;
  poolKind?: string;
  degraded?: boolean;
  degradedReason?: string | null;
  stale?: boolean;
  staleReason?: string | null;
  tradeableWhenDegraded?: boolean;
  softStale?: boolean;
  heartbeatAt?: number | null;
  heartbeatSlot?: number | null;
  wsAt?: number | null;
  syntheticSlot?: boolean;
  freshnessSource?: string | null;
};

// Unified node abstraction for 2-leg paths
type VenueNode =
  | { kind: "phx"; id: "phoenix" | "phoenix_buy" | "phoenix_sell"; feeBps: number }
  | { kind: "amm"; id: string; feeBps: number; amm: AmmSnap };

export interface JoinerParams {
  minAbsBps: number;
  waitLogMs: number;
  thresholdBps: number;
  flatSlippageBps: number;
  tradeSizeBase: number;
  phoenixFeeBps: number;
  ammFeeBps: number;           // fallback only (per-venue/pool fee may arrive in payload/adapter)
  fixedTxCostQuote: number;

  decisionMinBase?: number;
  minBase?: number;
  minTradeBase?: number;
}

export interface JoinerCfg {
  bookTtlMs: number;
  activeSlippageMode: SlipMode;
  phoenixSlippageBps: number;
  cpmmMaxPoolTradeFrac: number;
  dynamicSlippageExtraBps: number;
  logSimFields: boolean;
  enforceDedupe: boolean;
  decisionBucketMs: number;
  decisionMinEdgeDeltaBps: number;
  useRpcSim: boolean;
  decisionMinBase?: number;
}

// NB: Keep DecisionHookDetails.path as a superset; callers can ignore AMM->AMM.
export type DecisionHookDetails = {
  path: "AMM->PHX" | "PHX->AMM" | "AMM->AMM";
  side: "buy" | "sell";
  buy_px: number;
  sell_px: number;
  rpc_eff_px?: number;
  recommended_size_base?: number;
  amm_venue?: string;
  amm_pool_id?: string;       // exact pool to hit
  amm_dst_venue?: string;     // for AMM->AMM
  amm_dst_pool_id?: string;   // for AMM->AMM
  amm_meta?: { poolKind?: string; feeBps?: number; slot?: number | null; ts?: number };
  amm_dst_meta?: { poolKind?: string; feeBps?: number; slot?: number | null; ts?: number };
};

export type DecisionHook = (
  wouldTrade: boolean,
  edgeNetBps: number,
  expectedPnl: number,
  details?: DecisionHookDetails
) => void;

export type RpcSampleHook = (sample: { ms: number; blocked: boolean }) => void;

export type RpcSimFn = (input: {
  path: "AMM->PHX" | "PHX->AMM";
  sizeBase: number;
  ammMid: number;
  reserves?: { base: number; quote: number };
  ammFeeBps: number;
}) => Promise<{
  rpc_eff_px?: number;
  rpc_price_impact_bps?: number;
  rpc_sim_ms: number;
  rpc_sim_mode: string;
  rpc_sim_error?: string;
  rpc_qty_out?: number;
  rpc_units?: number;
  prioritization_fee?: number;
} | undefined>;

type PathCandidate = {
  path: "AMM->PHX" | "PHX->AMM" | "AMM->AMM";
  amm: AmmSnap;
  ammDst?: AmmSnap;
  size: number;
  buyPx: number;
  sellPx: number;
  bpsGross: number;
  bpsNet: number;
  pnlNet: number;
};

// ────────────────────────────────────────────────────────────────────────────
// Pairs config (broaden venues by config, not code)

// ── types used by readPairsConfig() ─────────────────────────────────────────
type VenueCfg = {
  kind: string;
  id: string;
  venue?: string;
  poolKind?: string;
  enabled?: boolean;
  freshness?: {
    slotLagSlots?: number;
    maxAgeMs?: number;
    heartbeatGraceMs?: number;
    tradeableWhenDegraded?: boolean;
  };
};
type PairCfg = {
  symbol: string;
  baseMint: string;
  quoteMint: string;
  phoenixMarket?: string;
  venues: VenueCfg[];
};


function readPairsConfig(): { pairs: PairCfg[] } | null {
  try {
    const p =
      process.env.PAIRS_JSON?.trim() ||
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "configs", "pairs.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(j?.pairs)) return j as { pairs: PairCfg[] };
  } catch (e) {
    logger.log("pairs_json_read_error", { err: String((e as any)?.message ?? e) });
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────

export class EdgeJoiner {
  private amms = new Map<AmmKey, AmmSnap>(); // multi-venue AMM snapshots
  private phxMid?: Mid;
  private phxBook: (PhoenixBook & {
    ts: number;
    book_method?: string;
    levels_bids?: DepthSide[];
    levels_asks?: DepthSide[];
  }) | null = null;

  private phxSlot?: number | null; // optional Phoenix slot for staleness guard

  private lastWaitLog = 0;
  private lastSig?: string;
  private lastEvalContext?: { bid: number; ask: number; amms: Record<string, number> };
  private lastEvalSig?: string;
  private lastEvalAt = 0;
  private probeSizeBase: number | undefined = (() => {
    const raw = process.env.FIXED_PROBE_BASE;
    if (raw == null || raw === "") return undefined; // no default → allow dynamic sizing
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
  private rateLimitedUntil = 0;
  private lastRateLimitLog = 0;

  // config gating
  private allowedPools = new Set<string>(); // `${venue}:${id}`
  private warnedPools = new Set<string>();
  private symbol = "SOL/USDC";
  private baseMint?: string;
  private quoteMint?: string;
  private phoenixMarket?: string;
  private phoenixSnapshotDir?: string;
  private phxSnapshotLastMtime = 0;
  private phxSnapshotPersistMs = 0;
  private phoenixSnapshotTimer: NodeJS.Timeout | null = null;
  private dlmmQuoteMemo = new Map<string, QuoteRes>();
  private degradedLogMemo = new Map<string, { reason: string; atMs: number }>();
  private ignoredLogMemo = new Map<string, { reason: string; atMs: number }>();
  private softStaleLogMemo = new Map<string, { reason: string; atMs: number }>();

  constructor(
    private P: JoinerParams,
    private C: JoinerCfg,
    private onDecision: DecisionHook,
    private rpcSim?: RpcSimFn,
    private onRpcSample?: RpcSampleHook
  ) {
    // Load pairs.json once; gate to configured pools only (if present)
    try {
      const cfg = readPairsConfig();
      if (cfg && cfg.pairs.length) {
        const first = cfg.pairs[0];
        this.symbol = first.symbol || this.symbol;
        this.baseMint = first.baseMint;
        this.quoteMint = first.quoteMint;
        this.phoenixMarket = first.phoenixMarket;
        for (const pair of cfg.pairs) {
          for (const v of pair.venues || []) {
            if (v && v.enabled === false) continue;  // ← respect disabled pools
            const key = `${String(v.kind).toLowerCase()}:${v.id}`;
            this.allowedPools.add(key);

            const venueName = String(v?.kind ?? v?.venue ?? "").toLowerCase();
            const freshness = v?.freshness;
            if (freshness) {
              if (Number.isFinite(freshness.slotLagSlots)) {
                CONFIG_SLOT_LAG_BY_VENUE.set(venueName, Number(freshness.slotLagSlots));
              }
              if (Number.isFinite(freshness.maxAgeMs)) {
                CONFIG_AGE_BY_VENUE.set(venueName, Number(freshness.maxAgeMs));
              }
              if (Number.isFinite(freshness.heartbeatGraceMs)) {
                CONFIG_HEARTBEAT_GRACE_MS_BY_VENUE.set(venueName, Number(freshness.heartbeatGraceMs));
              }
              if (typeof freshness.tradeableWhenDegraded === "boolean") {
                CONFIG_TRADEABLE_BY_VENUE.set(venueName, freshness.tradeableWhenDegraded);
              }
            }
          }
        }

        logger.log("joiner_pairs_loaded", {
          symbol: this.symbol,
          pool_count: this.allowedPools.size,
        });
      } else {
        logger.log("joiner_pairs_fallback", { symbol: this.symbol, pool_count: 0 });
      }
    } catch { /* best-effort */ }

    const snapshotDirRaw = String(process.env.PHOENIX_SNAPSHOT_DIR ?? "").trim();
    if (snapshotDirRaw) this.phoenixSnapshotDir = path.resolve(snapshotDirRaw);
    else this.phoenixSnapshotDir = path.resolve(process.cwd(), "data", "cache", "phoenix");

    this.loadPhoenixSnapshot(true);

    try {
      const fallbackDefault = AMM_SNAPSHOT_FALLBACK_AGE_MS_DEFAULT;
      const effectiveAgeMs = Math.max(
        100,
        this.C.bookTtlMs != null && Number.isFinite(this.C.bookTtlMs)
          ? Math.min(fallbackDefault, this.C.bookTtlMs)
          : fallbackDefault
      );
      logger.log("joiner_freshness_config", {
        book_ttl_ms: this.C.bookTtlMs,
        slot_skew_default: AMM_SLOT_MAX_LAG_DEFAULT,
        slot_skew_env_overrides: AMM_SLOT_MAX_LAG_BY_VENUE,
        slot_skew_config_overrides: Object.fromEntries(CONFIG_SLOT_LAG_BY_VENUE),
        fallback_age_ms_default: AMM_SNAPSHOT_FALLBACK_AGE_MS_DEFAULT,
        fallback_age_env_overrides: AMM_SNAPSHOT_FALLBACK_AGE_MS_BY_VENUE,
        fallback_age_config_overrides: Object.fromEntries(CONFIG_AGE_BY_VENUE),
        heartbeat_soft_ms_default: AMM_HEARTBEAT_SOFT_MS_DEFAULT,
        heartbeat_soft_env_overrides: AMM_HEARTBEAT_SOFT_MS_BY_VENUE,
        heartbeat_soft_config_overrides: Object.fromEntries(CONFIG_HEARTBEAT_GRACE_MS_BY_VENUE),
        effective_age_ms: effectiveAgeMs,
      });
    } catch {
      /* ignore logging failures */
    }

    const snapshotPollMs = envInt("PHOENIX_SNAPSHOT_POLL_MS", 5000);
    if (snapshotPollMs > 0 && this.phoenixMarket) {
      this.phoenixSnapshotTimer = setInterval(() => {
        try {
          this.loadPhoenixSnapshot(false);
        } catch (e) {
          logger.log("phoenix_snapshot_refresh_error", { err: String((e as any)?.message ?? e) });
        }
      }, snapshotPollMs);
      this.phoenixSnapshotTimer.unref?.();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ingress: AMMs (publisher stream)
  upsertAmms(raw: any): void {
    const obj = raw?.data ?? raw;
    const px = nnum(obj?.px) ?? (typeof obj?.px_str === "string" ? Number(obj.px_str) : undefined);
    const venue = String(obj?.venue ?? "raydium").toLowerCase();
    const ammId = String(obj?.ammId ?? obj?.id ?? "");
    if (!ammId || !(px && px > 0)) return;

    const poolKindRaw = String(obj?.poolKind ?? obj?.pool_kind ?? obj?.poolType ?? obj?.pool_type ?? "")
      .trim()
      .toLowerCase();

    // Gate by AMMS_ENABLE (optional)
    const enableList = String(process.env.AMMS_ENABLE ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (enableList.length) {
      const enableSet = new Set(enableList);
      let allowed = enableSet.has(venue);
      if (!allowed && poolKindRaw) {
        allowed = enableSet.has(`${venue}_${poolKindRaw}`) || enableSet.has(poolKindRaw);
      }
      if (!allowed && poolKindRaw === "dlmm" && !enableList.some((entry) => entry.startsWith("meteora"))) {
        allowed = true;
        if (!this.warnedPools.has("meteora_auto")) {
          this.warnedPools.add("meteora_auto");
          logger.log("amm_enable_auto", { venue: "meteora", pool_kind: "dlmm" });
        }
      }
      if (!allowed) return;
    }

    // Gate to configured pools (if any listed in pairs.json)
    if (this.allowedPools.size && !this.allowedPools.has(`${venue}:${ammId}`)) return;

    const baseDecimals = nnum(obj?.baseDecimals);
    const quoteDecimals = nnum(obj?.quoteDecimals);
    const baseIntStr = typeof obj?.base_int === "string" ? obj.base_int : undefined;
    const quoteIntStr = typeof obj?.quote_int === "string" ? obj.quote_int : undefined;
    const baseUi = nnum(obj?.base_ui);
    const quoteUi = nnum(obj?.quote_ui);

    let reserves: AmmSnap["reserves"] | undefined;
    if (baseDecimals != null && quoteDecimals != null) {
      const baseAtoms = baseIntStr ? parseAtoms(baseIntStr) : null;
      const quoteAtoms = quoteIntStr ? parseAtoms(quoteIntStr) : null;
      if (baseAtoms != null && quoteAtoms != null) {
        const base = Number(baseAtoms) / Math.pow(10, baseDecimals);
        const quote = Number(quoteAtoms) / Math.pow(10, quoteDecimals);
        if (base > 0 && quote > 0 && Number.isFinite(base) && Number.isFinite(quote)) {
          reserves = { base, quote, baseDecimals, quoteDecimals };
        }
      } else {
        const fallbackBase = baseIntStr != null ? Number(baseIntStr) : baseUi;
        const fallbackQuote = quoteIntStr != null ? Number(quoteIntStr) : quoteUi;
        if (fallbackBase != null && fallbackQuote != null && fallbackBase > 0 && fallbackQuote > 0 && Number.isFinite(fallbackBase) && Number.isFinite(fallbackQuote)) {
          reserves = { base: fallbackBase, quote: fallbackQuote, baseDecimals, quoteDecimals };
        }
      }
    }

    if (reserves && (!(reserves.base > 0) || !(reserves.quote > 0))) {
      reserves = undefined;
    }
    if (reserves && (reserves.base * Math.pow(10, reserves.baseDecimals) < 1 || reserves.quote * Math.pow(10, reserves.quoteDecimals) < 1)) {
      // Defensive: discard obviously mis-scaled reserves (e.g., UI values sent as atoms)
      logger.log("amm_reserve_underflow", {
        venue,
        ammId,
        base: reserves.base,
        quote: reserves.quote,
        base_decimals: reserves.baseDecimals,
        quote_decimals: reserves.quoteDecimals,
      });
      reserves = undefined;
    }

    // Prefer per-pool fee from payload; env fallback if missing.
    const feeFromPayload =
      nnum(obj?.feeBps) ??
      nnum(obj?.fee_bps) ??
      nnum(obj?.amm_fee_bps);
    const cachedFee = (() => {
      if (venue === "raydium") return getCachedRaydiumFee(ammId) ?? null;
      if (venue === "orca") return getCachedOrcaFee(ammId) ?? null;
      return null;
    })();
    const feeFallback =
      cachedFee ?? (
        venue === "raydium"
          ? Number(process.env.RAYDIUM_TRADE_FEE_BPS ?? this.P.ammFeeBps ?? 25)
          : venue === "orca"
            ? Number(process.env.ORCA_TRADE_FEE_BPS ?? this.P.ammFeeBps ?? 30)
            : Number(this.P.ammFeeBps ?? 25)
      );

    const key = `${venue}:${ammId}`;
    const prev = this.amms.get(key);

    const tsFromPayload = nnum(obj?.ts);
    const slotFromPayload = nnum(obj?.slot);
    const heartbeatAtRaw = nnum(obj?.heartbeat_at ?? obj?.heartbeatAt);
    const heartbeatSlotRaw = nnum(obj?.heartbeat_slot ?? obj?.heartbeatSlot);
    const wsAtRaw = nnum(obj?.ws_at ?? obj?.wsAt);
    const syntheticSlotRaw = obj?.syntheticSlot ?? obj?.synthetic_slot;
    const tradeableRaw = obj?.tradeableWhenDegraded ?? obj?.tradeable_when_degraded;
    const freshnessSourceRaw = typeof obj?.source === "string" ? obj.source : typeof obj?.origin === "string" ? obj.origin : undefined;

    const hasField = (field: string): boolean =>
      !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, field);
    const hasAnyField = (...fields: string[]): boolean => fields.some((f) => hasField(f));

    const ts = tsFromPayload && tsFromPayload > 0 ? tsFromPayload : prev?.ts ?? Date.now();

    const slot =
      hasField("slot")
        ? (slotFromPayload ?? null)
        : prev?.slot ?? null;

    const heartbeatAt =
      hasAnyField("heartbeat_at", "heartbeatAt")
        ? (heartbeatAtRaw ?? null)
        : prev?.heartbeatAt ?? null;

    const heartbeatSlot =
      hasAnyField("heartbeat_slot", "heartbeatSlot")
        ? (heartbeatSlotRaw ?? null)
        : prev?.heartbeatSlot ?? null;

    const wsAt =
      hasAnyField("ws_at", "wsAt")
        ? (wsAtRaw ?? null)
        : prev?.wsAt ?? null;

    const syntheticSlot =
      hasAnyField("synthetic_slot", "syntheticSlot")
        ? (typeof syntheticSlotRaw === "boolean" ? syntheticSlotRaw : undefined)
        : prev?.syntheticSlot;

    const tradeableWhenDegraded =
      hasAnyField("tradeable_when_degraded", "tradeableWhenDegraded")
        ? (typeof tradeableRaw === "boolean" ? tradeableRaw : Boolean(tradeableRaw))
        : Boolean(prev?.tradeableWhenDegraded);

    const freshnessSource =
      freshnessSourceRaw !== undefined
        ? freshnessSourceRaw
        : (prev?.freshnessSource ?? null);

    const staleReason =
      hasAnyField("stale_reason", "staleReason")
        ? (typeof obj?.stale_reason === "string"
          ? obj.stale_reason
          : typeof obj?.staleReason === "string"
            ? obj.staleReason
            : null)
        : (prev?.staleReason ?? null);

    const feeBps = feeFromPayload ?? prev?.feeBps ?? feeFallback;
    const finalReserves = reserves ?? prev?.reserves;

    const snap: AmmSnap = {
      venue: venue as any,
      ammId,
      px,
      ts,
      slot,
      reserves: finalReserves,
      feeBps,
      tradeableWhenDegraded,
      heartbeatAt: heartbeatAt ?? null,
      heartbeatSlot: heartbeatSlot ?? null,
      wsAt: wsAt ?? null,
      syntheticSlot: syntheticSlot ?? undefined,
      freshnessSource: freshnessSource ?? null,
      staleReason: staleReason ?? null,
    };
    const poolKindRawUpper = String(obj?.poolKind ?? obj?.pool_kind ?? obj?.poolType ?? obj?.pool_type ?? "").trim();
    if (poolKindRawUpper) snap.poolKind = poolKindRawUpper.toLowerCase();

    this.amms.set(key, snap);
    void this.maybeReport();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ingress: Phoenix
  upsertPhoenix(raw: any): void {
    const ev = (raw?.event ?? raw?.name ?? raw?.type ?? "") as string;
    const obj = raw?.data ?? raw;

    // Pick up phoenix slot if present
    const maybeSlot = nnum(obj?.slot);
    if (maybeSlot != null) this.phxSlot = maybeSlot;

    if (ev === "phoenix_l2") {
      const bid = nnum(obj?.best_bid);
      const ask = nnum(obj?.best_ask);
      if (bid && ask && bid > 0 && ask > 0 && bid < ask) {
        const bidsArr = Array.isArray(obj?.levels_bids)
          ? (obj.levels_bids as any[]).map((l) => ({ px: Number(l.px), qty: Number(l.qty) }))
          : undefined;
        const asksArr = Array.isArray(obj?.levels_asks)
          ? (obj.levels_asks as any[]).map((l) => ({ px: Number(l.px), qty: Number(l.qty) }))
          : undefined;
        const bookTs = nnum(obj?.ts) ?? Date.now();
        this.phxBook = {
          best_bid: bid,
          best_ask: ask,
          mid: (bid + ask) / 2,
          ts: bookTs,
          source: "book",
          book_method: String(obj?.source ?? "unknown"),
          ...(bidsArr && bidsArr.length ? { levels_bids: bidsArr } : {}),
          ...(asksArr && asksArr.length ? { levels_asks: asksArr } : {}),
        } as any;
        if (bidsArr && bidsArr.length && asksArr && asksArr.length) {
          this.persistPhoenixSnapshot(obj);
        }
      }
    } else if (ev === "phoenix_mid") {
      const px = nnum(obj?.px) ?? (typeof obj?.px_str === "string" ? Number(obj.px_str) : undefined);
      const eventTs = nnum(obj?.ts) ?? Date.now();
      if (px && px > 0) this.phxMid = { px, ts: eventTs };
      const bid = nnum(obj?.best_bid);
      const ask = nnum(obj?.best_ask);
      if (bid && ask && bid > 0 && ask > 0 && bid < ask) {
        const bookTs = eventTs;
        this.phxBook = {
          best_bid: bid,
          best_ask: ask,
          mid: (bid + ask) / 2,
          ts: bookTs,
          source: "book",
          book_method: String(obj?.source ?? "unknown"),
        } as any;
        this.persistPhoenixSnapshot(obj);
      }
    }
    void this.maybeReport();
  }

  refreshPhoenixSnapshot(force = false): void {
    this.loadPhoenixSnapshot(force);
  }

  private loadPhoenixSnapshot(force: boolean): void {
    if (!this.phoenixMarket || !this.phoenixSnapshotDir) return;
    try {
      const file = path.join(this.phoenixSnapshotDir, `${this.phoenixMarket}.json`);
      if (!fs.existsSync(file)) {
        if (force) {
          logger.log("phoenix_snapshot_missing", { file, market: this.phoenixMarket });
        }
        return;
      }
      const st = fs.statSync(file);
      if (!force && st.mtimeMs <= this.phxSnapshotLastMtime) return;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      this.phxSnapshotLastMtime = st.mtimeMs;
      this.upsertPhoenix({ event: "phoenix_l2", data: raw });
      logger.log("phoenix_snapshot_loaded", { file, mtime_ms: st.mtimeMs });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (force && err?.code !== "ENOENT") {
        logger.log("phoenix_snapshot_load_error", {
          dir: this.phoenixSnapshotDir,
          market: this.phoenixMarket,
          error: String(err?.message ?? err),
        });
      }
    }
  }

  private persistPhoenixSnapshot(data: any): void {
    if (!this.phoenixMarket || !this.phoenixSnapshotDir) return;
    const bids = Array.isArray(data?.levels_bids) ? data.levels_bids : [];
    const asks = Array.isArray(data?.levels_asks) ? data.levels_asks : [];
    if (!bids.length || !asks.length) return;
    try {
      const now = Date.now();
      if (now - this.phxSnapshotPersistMs < 250) return;
      const file = path.join(this.phoenixSnapshotDir, `${this.phoenixMarket}.json`);
      fs.mkdirSync(this.phoenixSnapshotDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data ?? {}));
      this.phxSnapshotPersistMs = now;
      this.phxSnapshotLastMtime = now;
    } catch (e) {
      logger.log("phoenix_snapshot_persist_error", {
        market: this.phoenixMarket,
        error: String((e as any)?.message ?? e),
      });
    }
  }

  close(): void {
    if (this.phoenixSnapshotTimer) {
      clearInterval(this.phoenixSnapshotTimer);
      this.phoenixSnapshotTimer = null;
    }
    try {
      if (this.phxBook) {
        this.persistPhoenixSnapshot({ event: "phoenix_l2", ...this.phxBook });
      }
    } catch { /* ignore */ }
  }

  // ──────────────────────────────────────────────────────────────────────────
  private getFreshBook(): (PhoenixBook & { ts: number; book_method?: string; levels_bids?: DepthSide[]; levels_asks?: DepthSide[] }) | null {
    const now = Date.now();
    if (this.phxBook && now - this.phxBook.ts <= this.C.bookTtlMs) return this.phxBook;
    return null;
  }

  // CPMM effective price (QUOTE per BASE)
  // CLMM / mid-only fallback (used only if quoter errs)
  private midBuyQuotePerBase(mid: number, feeBps: number, slipBps: number): number {
    const fee = Math.max(0, feeBps) / 10_000;
    const slip = Math.max(0, slipBps) / 10_000;
    return mid * (1 + slip) * (1 + fee);
  }
  private midSellQuotePerBase(mid: number, feeBps: number, slipBps: number): number {
    const fee = Math.max(0, feeBps) / 10_000;
    const slip = Math.max(0, slipBps) / 10_000;
    return mid * (1 - slip) * (1 - fee);
  }

  private walkPhoenix(side: "buy" | "sell", sizeBase: number, feeBps: number): number | undefined {
    const B = this.getFreshBook();
    if (!B) return undefined;
    const ladder: DepthSide[] | undefined = side === "sell" ? (B as any).levels_bids : (B as any).levels_asks;
    if (!ladder || ladder.length === 0 || !(sizeBase > 0)) return undefined;

    let rem = new Decimal(sizeBase);
    let notional = new Decimal(0);
    for (const { px, qty } of ladder) {
      if (!(px > 0 && qty > 0)) continue;
      const qtyDec = new Decimal(qty);
      const pxDec = new Decimal(px);
      const take = Decimal.min(rem, qtyDec);
      notional = notional.plus(take.mul(pxDec));
      rem = rem.minus(take);
      if (rem.lte(1e-12)) break;
    }
    if (rem.gt(1e-12)) return undefined;

    const fee = new Decimal(Math.max(0, feeBps)).div(10_000);
    const extra = new Decimal(Math.max(0, Number(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? this.C.dynamicSlippageExtraBps))).div(10_000);
    const depthExtra = new Decimal(Math.max(0, Number(process.env.PHOENIX_DEPTH_EXTRA_BPS ?? 0))).div(10_000);

    const avgPx = notional.div(sizeBase);
    if (avgPx.lte(0)) return undefined;
    if (side === "sell") {
      const adj = Decimal.max(0, new Decimal(1).minus(depthExtra).minus(extra).minus(fee));
      return avgPx.mul(adj).toNumber();
    } else {
      const adj = Decimal.max(0, new Decimal(1).plus(depthExtra).plus(extra).plus(fee));
      return avgPx.mul(adj).toNumber();
    }
  }

  private isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  private bumpRateLimited(meta?: any) {
    const waitMs = Math.max(RATE_LIMIT_BACKOFF_MS, Number(meta?.wait_ms ?? 0));
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + waitMs);
    const now = Date.now();
    if (now - this.lastRateLimitLog >= this.P.waitLogMs) {
      this.lastRateLimitLog = now;
      logger.log("joiner_rate_limited", { wait_ms: waitMs, until: new Date(this.rateLimitedUntil).toISOString() });
    }
  }

  private computeMinTradeBase(refPx: number): number {
    const floorFromEnv = envNum("DECISION_MIN_BASE");
    const floorFromCtor =
      this.P.decisionMinBase ??
      this.C.decisionMinBase ??
      this.P.minBase ??
      this.P.minTradeBase;

    const sizeoptMin = envNum("SIZEOPT_MIN_BASE");
    const targetBps = Math.max(0.1, envNum("DECISION_FIXEDCOST_TARGET_BPS") ?? 1);
    const dynMin = (this.P.fixedTxCostQuote > 0 && refPx > 0)
      ? (10_000 * this.P.fixedTxCostQuote) / (refPx * targetBps)
      : 0;

    return Math.max(
      1e-6,
      floorFromEnv ?? floorFromCtor ?? sizeoptMin ?? dynMin ?? this.P.tradeSizeBase
    );
  }

  private pickTradeSize(args: {
    path: "AMM->PHX" | "PHX->AMM" | "AMM->AMM";
    nodeSrc: VenueNode;
    nodeDst: VenueNode;
    refPx: number;
  }): number | undefined {
    const minBase = this.computeMinTradeBase(args.refPx);
    const liveOverrideRaw = envNum("LIVE_SIZE_BASE");
    const liveOverride = liveOverrideRaw != null && Number.isFinite(liveOverrideRaw) && liveOverrideRaw > 0 ? liveOverrideRaw : undefined;
    const basePreferred = this.probeSizeBase ?? liveOverride ?? this.P.tradeSizeBase;
    const preferred = basePreferred != null && Number.isFinite(basePreferred) && basePreferred > 0 ? basePreferred : undefined;

    let size = preferred ?? minBase;
    if (size < minBase) size = minBase;

    const absMaxRaw = envNum("SIZEOPT_ABS_MAX_BASE");
    const absMax = absMaxRaw != null && Number.isFinite(absMaxRaw) && absMaxRaw > 0 ? absMaxRaw : undefined;
    if (absMax && size > absMax) size = absMax;

    const fracRaw = envNum("SIZEOPT_MAX_POOL_FRAC");
    const fracCandidate = fracRaw != null && Number.isFinite(fracRaw) ? fracRaw : this.C.cpmmMaxPoolTradeFrac;
    const maxFrac = Math.max(0, Math.min(1, fracCandidate));

    const applyCap = (node: VenueNode | undefined) => {
      if (!node || node.kind !== "amm") return;
      const reserves = node.amm.reserves;
      if (!reserves || !(reserves.base > 0) || !Number.isFinite(reserves.base)) return;
      if (!(maxFrac > 0)) return;
      const cap = reserves.base * maxFrac;
      if (cap > 0) size = Math.min(size, cap);
    };

    if (args.path === "AMM->PHX") {
      applyCap(args.nodeSrc);
    } else if (args.path === "PHX->AMM") {
      applyCap(args.nodeDst);
    } else {
      applyCap(args.nodeSrc);
      applyCap(args.nodeDst);
    }

    if (!(size > 0) || !Number.isFinite(size)) return undefined;
    if (absMax && size > absMax) size = absMax;
    if (size < minBase) return undefined;

    return Number(size.toFixed(9));
  }

  private enforceVenueMinSize(size: number, src: VenueNode, dst: VenueNode): number | undefined {
    if (!(size > 0) || !Number.isFinite(size)) return undefined;
    if (
      (src.kind === "amm" && src.amm.venue === "orca") ||
      (dst.kind === "amm" && dst.amm.venue === "orca")
    ) {
      return Math.max(size, MIN_ORCA_BASE_SIZE);
    }
    return size;
  }

  private async evaluatePathCandidate(args: {
    nodeSrc: VenueNode;
    nodeDst: VenueNode;
    path: PathCandidate["path"];
    bid: number;
    ask: number;
    midRef: number;
    trackAmmAmm: boolean;
    execAmmAmm: boolean;
    latestAmm: AmmSnap | undefined;
  }): Promise<PathCandidate | null> {
    const { nodeSrc, nodeDst, path, bid, ask, midRef, trackAmmAmm, execAmmAmm, latestAmm } = args;

    const describeNode = (node: VenueNode): string =>
      node.kind === "amm" ? `${node.amm.venue}:${node.amm.ammId}` : node.id;

    const logPathSkip = (reason: string, extras?: Record<string, unknown>) => {
      try {
        logger.log("path_candidate_skip", {
          symbol: this.symbol,
          path,
          src: describeNode(nodeSrc),
          dst: describeNode(nodeDst),
          reason,
          ...(extras ?? {}),
        });
      } catch {
        /* ignore */
      }
    };

    const pickedSize = this.pickTradeSize({ path, nodeSrc, nodeDst, refPx: midRef });
    if (!(pickedSize && pickedSize > 0)) {
      logPathSkip("size_not_available");
      return null;
    }

    const adjusted = this.enforceVenueMinSize(pickedSize, nodeSrc, nodeDst);
    if (!(adjusted && adjusted > 0)) {
      logPathSkip("size_adjustment_failed");
      return null;
    }

    const size = Number(adjusted.toFixed(9));

    try {
      logger.log("size_probe", {
        symbol: this.symbol,
        path,
        src: nodeSrc.kind === "amm" ? `${nodeSrc.amm.venue}:${nodeSrc.amm.ammId}` : nodeSrc.id,
        dst: nodeDst.kind === "amm" ? `${nodeDst.amm.venue}:${nodeDst.amm.ammId}` : nodeDst.id,
        size_base: size,
        size_raw: pickedSize,
        min_base: this.computeMinTradeBase(midRef),
      });
    } catch { /* noop */ }

    const qBuy = await this.quoteNodeAvgPerBase(nodeSrc, "buy", size, midRef);
    const qSell = await this.quoteNodeAvgPerBase(nodeDst, "sell", size, midRef);
    const buyPx = qBuy.px;
    const sellPx = qSell.px;

    if (buyPx == null || sellPx == null) {
      logPathSkip("quote_missing", {
        buy_origin: qBuy.used,
        sell_origin: qSell.used,
        buy_meta: qBuy.meta ?? null,
        sell_meta: qSell.meta ?? null,
      });
      return null;
    }

    const pnl = (sellPx - buyPx) * size - this.P.fixedTxCostQuote;
    const notional = buyPx * size;
    const srcMid = nodeSrc.kind === "amm" ? nodeSrc.amm.px : ask;
    const dstMid = nodeDst.kind === "amm" ? nodeDst.amm.px : bid;
    const bpsGross = ((dstMid / srcMid) - 1) * 10_000;
    const bpsNet = ((sellPx / buyPx) - 1) * 10_000;

    const ok = this.validateOpportunity(path, size, buyPx, sellPx, pnl, this.P.fixedTxCostQuote, bpsNet, notional);

    const candidatePayload = {
      symbol: this.symbol,
      path,
      src: nodeSrc.kind === "amm" ? `${nodeSrc.amm.venue}:${nodeSrc.amm.ammId}` : nodeSrc.id,
      dst: nodeDst.kind === "amm" ? `${nodeDst.amm.venue}:${nodeDst.amm.ammId}` : nodeDst.id,
      size_base: size,
      buy_px: buyPx,
      sell_px: sellPx,
      buy_quote_source: qBuy.used,
      sell_quote_source: qSell.used,
      buy_fee_bps: qBuy.feeBps,
      sell_fee_bps: qSell.feeBps,
      buy_meta: qBuy.meta ?? null,
      sell_meta: qSell.meta ?? null,
      pnl,
      fixed_cost: this.P.fixedTxCostQuote,
      edge_bps_gross: bpsGross,
      edge_bps_net: bpsNet,
      notional_quote: notional,
      valid: ok.valid,
      validation_reason: ok.reason ?? null,
    };

    try { logger.log("candidate_evaluated", candidatePayload); } catch { /* ignore */ }

    if (!ok.valid) {
      logger.log("opportunity_rejected", {
        path,
        venue: nodeSrc.kind === "amm" ? nodeSrc.amm.venue : "phx",
        size,
        buy_px: buyPx,
        sell_px: sellPx,
        pnl,
        reason: ok.reason,
        src_origin: qBuy.used,
        dst_origin: qSell.used,
        src_fee_bps: qBuy.feeBps,
        dst_fee_bps: qSell.feeBps,
        expected_pnl: pnl,
        notional_quote: notional,
      });
      logPathSkip(ok.reason ?? "validation_failed", {
        edge_bps_net: bpsNet,
        expected_pnl: pnl,
        notional_quote: notional,
      });
      return null;
    }

    if (path === "AMM->AMM" && !execAmmAmm) {
      if (trackAmmAmm) {
        logger.log("amm_amm_tracked", {
          symbol: this.symbol,
          src: (nodeSrc as any).amm?.venue ?? "phx",
          dst: (nodeDst as any).amm?.venue ?? "phx",
          size_base: round(size, 9),
          buy_px: round(buyPx),
          sell_px: round(sellPx),
          edge_bps_net: round(bpsNet, 4),
          expected_pnl: round(pnl, 6),
          note: "not executable in this phase",
        });
      }
      return null;
    }

    const snapSrc = nodeSrc.kind === "amm" ? nodeSrc.amm : latestAmm;
    const snapDst = nodeDst.kind === "amm" ? nodeDst.amm : undefined;
    if (!snapSrc) return null;

    return {
      path,
      amm: snapSrc,
      ammDst: snapDst,
      size,
      buyPx,
      sellPx,
      bpsGross,
      bpsNet,
      pnlNet: pnl,
    };
  }

  private validateOpportunity(
    path: "AMM->PHX" | "PHX->AMM" | "AMM->AMM",
    sizeBase: number,
    buyPx: number,
    sellPx: number,
    expectedPnl: number,
    fixedCost: number,
    netBps: number,
    notional: number
  ): { valid: boolean; reason?: string } {
    if (!(buyPx > 0 && sellPx > 0 && sizeBase > 0)) {
      return { valid: false, reason: "invalid_prices_or_size" };
    }
    if (!(notional > 0) || !Number.isFinite(notional)) {
      return { valid: false, reason: "invalid_notional" };
    }
    if (!Number.isFinite(expectedPnl)) {
      return { valid: false, reason: "invalid_expected_pnl" };
    }
    if (!Number.isFinite(netBps)) {
      return { valid: false, reason: "invalid_edge_bps" };
    }
    if (expectedPnl <= 0) {
      return { valid: false, reason: "negative_expected_pnl" };
    }
    if (netBps <= 0) {
      return { valid: false, reason: "non_positive_net_edge" };
    }
    if (netBps < MIN_NET_PROFIT_BPS) {
      return { valid: false, reason: `net_edge_below_min_${netBps.toFixed(2)}bps` };
    }
    const grossSpread = (sellPx / buyPx - 1) * 10_000;
    if (grossSpread < MIN_PROFITABLE_BPS) {
      return { valid: false, reason: `gross_edge_below_min_${grossSpread.toFixed(2)}bps` };
    }
    const calculatedPnl = (sellPx - buyPx) * sizeBase - fixedCost;
    const pnlDiff = Math.abs(calculatedPnl - expectedPnl);
    const tolerance = Math.max(1e-6, Math.abs(expectedPnl) * 0.001);
    if (pnlDiff > tolerance) {
      return { valid: false, reason: `pnl_mismatch_${pnlDiff.toFixed(6)}` };
    }
    const profitBps = (expectedPnl / notional) * 10_000;
    if (profitBps > MAX_REALISTIC_PROFIT_BPS) {
      return { valid: false, reason: `unrealistic_profit_${profitBps.toFixed(2)}bps` };
    }
    return { valid: true };
  }

  // Adapter-first quote (then fallback to venue-specific local math)
  private async quoteAmmAvgPerBase(
    amm: AmmSnap,
    side: "buy" | "sell",
    sizeBase: number,
    fallbackMid: number
  ): Promise<{ px?: number; feeBps: number; used: "adapter" | "local" | "fallback"; meta?: any }> {
    const logQuote = (origin: string, price: number | undefined, extras?: Record<string, unknown>) => {
      try {
        logger.log(price != null && Number.isFinite(price) ? "quote_debug" : "quote_debug_null", {
          venue: amm.venue,
          pool: amm.ammId,
          side,
          origin,
          size_base: sizeBase,
          fallback_mid: fallbackMid,
          price: price ?? null,
          ...(extras ?? {}),
        });
      } catch { /* ignore logging failures */ }
    };
    const adapter = getAdapter(amm.venue);
    const slip = this.P.flatSlippageBps;

    const poolKind = String(amm.poolKind ?? "").toLowerCase();
    const isClmm = poolKind === "clmm";
    const isDlmm = poolKind === "dlmm";
    const sizeBucket = Number.isFinite(sizeBase) ? Number(sizeBase.toFixed(6)) : sizeBase;
    const dlmmMemoKey = isDlmm ? `${amm.ammId}:${side}:${sizeBucket}:${slip}` : null;

    let adapterQuoteCached: QuoteRes | undefined;
    const hasAdapter = typeof adapter?.quote === "function";

    const runAdapterQuote = async (): Promise<QuoteRes> => {
      if (adapterQuoteCached) return adapterQuoteCached;
      if (!hasAdapter) return { ok: false, err: "adapter_missing" } as QuoteRes;
      try {
        const req: QuoteReq = {
          poolId: amm.ammId,
          side,
          sizeBase,
          slippageBps: slip,
          baseMint: this.baseMint,
          quoteMint: this.quoteMint,
        };
        adapterQuoteCached = await adapter!.quote(undefined as any, req as any);
        return adapterQuoteCached;
      } catch (e) {
        logger.log("adapter_quote_error", { venue: amm.venue, pool: amm.ammId, err: String((e as any)?.message ?? e) });
        adapterQuoteCached = { ok: false, err: String((e as any)?.message ?? e) } as QuoteRes;
        return adapterQuoteCached!;
      }
    };

    if (this.isRateLimited()) {
      return { px: undefined, feeBps: amm.feeBps, used: "fallback", meta: { rate_limited: true, wait_ms: this.rateLimitedUntil - Date.now() } };
    }

    if (isDlmm) {
      const cached = dlmmMemoKey ? this.dlmmQuoteMemo.get(dlmmMemoKey) : undefined;
      const fromCache = cached != null;
      const dlmmQuote = fromCache ? cached : await quoteDlmm({
        poolId: amm.ammId,
        side,
        sizeBase,
        slippageBps: slip,
        baseMint: this.baseMint,
        quoteMint: this.quoteMint,
      });
      if (!fromCache && dlmmMemoKey) {
        this.dlmmQuoteMemo.set(dlmmMemoKey, dlmmQuote);
      }
      if (dlmmQuote.ok && Number.isFinite(dlmmQuote.price) && (dlmmQuote.price ?? 0) > 0) {
        const price = dlmmQuote.price ?? 0;
        const effectiveFeeBps = Number.isFinite(dlmmQuote.feeBps)
          ? (dlmmQuote.feeBps as number)
          : (amm.feeBps ?? this.P.ammFeeBps);
        logQuote("dlmm_quoter", price, {
          fee_bps: effectiveFeeBps,
          meta: dlmmQuote.meta ?? null,
          cache_hit: fromCache,
          degraded: Boolean((dlmmQuote.meta as any)?.degraded),
          degraded_reason: (dlmmQuote.meta as any)?.degraded_reason ?? null,
        });
        return {
          px: price,
          feeBps: effectiveFeeBps,
          used: "local",
          meta: { source: "dlmm_quoter", cache_hit: fromCache, ...(dlmmQuote.meta ?? {}) },
        };
      }
      logQuote("dlmm_quoter_err", undefined, {
        err: dlmmQuote.ok ? undefined : dlmmQuote.err,
        cache_hit: fromCache,
        degraded: Boolean((dlmmQuote as any)?.meta?.degraded),
        degraded_reason: (dlmmQuote as any)?.meta?.degraded_reason ?? null,
      });
    }

    if (hasAdapter && (!isClmm || CLMM_PREFER_ADAPTER)) {
      const q = await runAdapterQuote();
      if ((q as any)?.ok && typeof (q as any).price === "number" && Number.isFinite((q as any).price)) {
        const feeBps = Number.isFinite((q as any).feeBps) ? Number((q as any).feeBps) : amm.feeBps;
        const price = Number((q as any).price);
        logQuote("adapter", price, {
          fee_bps: feeBps,
          slip_bps: slip,
          origin_meta: (q as any).meta ?? null,
        });
        return { px: price, feeBps, used: "adapter", meta: (q as any).meta };
      }
    }

    // High-precision CLMM quoting (Raydium & Orca)
    if (isClmm) {
      const clmm = await quoteClmm({
        venue: amm.venue,
        poolKind,
        poolId: amm.ammId,
        side,
        sizeBase,
        slippageBps: slip,
        baseMint: this.baseMint,
        quoteMint: this.quoteMint,
        feeBpsHint: amm.feeBps,
        reserves: amm.reserves
          ? {
            base: amm.reserves.base,
            quote: amm.reserves.quote,
            baseDecimals: amm.reserves.baseDecimals,
            quoteDecimals: amm.reserves.quoteDecimals,
          }
          : undefined,
      });
      if (clmm.ok && Number.isFinite(clmm.price) && clmm.price > 0) {
        logQuote("clmm_quoter", clmm.price, {
          fee_bps: Number.isFinite(clmm.feeBps) ? clmm.feeBps : amm.feeBps,
          slip_bps: slip,
          source_meta: clmm.meta ?? null,
        });
        return {
          px: clmm.price,
          feeBps: Number.isFinite(clmm.feeBps) && clmm.feeBps > 0 ? clmm.feeBps : amm.feeBps,
          used: "local",
          meta: { source: "clmm_quoter", ...(clmm.meta ?? {}) },
        };
      }
      if (!clmm.ok && (clmm.err === "rate_limited" || clmm.err === "rate_limited_cooldown")) {
        this.bumpRateLimited(clmm.meta);
        return { px: undefined, feeBps: amm.feeBps, used: "fallback", meta: { rate_limited: true, source: clmm.meta?.source ?? "clmm" } };
      }
      if (hasAdapter && !CLMM_PREFER_ADAPTER) {
        const q = await runAdapterQuote();
        if ((q as any)?.ok && typeof (q as any).price === "number" && Number.isFinite((q as any).price)) {
          const feeBps = Number.isFinite((q as any).feeBps) ? Number((q as any).feeBps) : amm.feeBps;
          const price = Number((q as any).price);
          logQuote("adapter_fallback", price, {
            fee_bps: feeBps,
            slip_bps: slip,
            origin_meta: (q as any).meta ?? null,
          });
          return { px: price, feeBps, used: "adapter", meta: (q as any).meta };
        }
      }

      const mid = nnum(amm.px);
      const feeBpsMid = Number.isFinite(amm.feeBps) ? Number(amm.feeBps) : this.P.ammFeeBps;
      if (mid != null && mid > 0 && Number.isFinite(mid) && Number.isFinite(feeBpsMid)) {
        const refMid = fallbackMid > 0 && Number.isFinite(fallbackMid) ? fallbackMid : mid;
        const deviationBps = refMid > 0 ? Math.abs(mid - refMid) / refMid * 10_000 : 0;
        if (deviationBps <= Math.max(100, PRICE_VALIDATION_WINDOW_BPS)) {
          const feeFrac = Math.max(0, feeBpsMid) / 10_000;
          const slipFrac = Math.max(0, slip) / 10_000;
          const factor = side === "buy"
            ? 1 + feeFrac + slipFrac
            : 1 - feeFrac - slipFrac;
          if (factor > 0) {
            const pxMid = mid * factor;
            if (Number.isFinite(pxMid) && pxMid > 0) {
              logQuote("clmm_mid", pxMid, { fee_bps: feeBpsMid, slip_bps: slip, deviation_bps: deviationBps });
              return {
                px: pxMid,
                feeBps: feeBpsMid,
                used: "local",
                meta: { source: "clmm_mid", mid, refMid, feeBps: feeBpsMid, slipBps: slip, deviationBps },
              };
            }
          }
        }
      }

      logger.log("clmm_quote_fallback", {
        venue: amm.venue,
        pool: amm.ammId,
        side,
        err: clmm.ok ? "invalid_price" : clmm.err,
      });
    }

    // Fallback to local math (keeps working even if adapters are missing)
    try {
      if (amm.venue === "orca") {
        // Orca CLMM: use the local Whirlpool quoter helpers if adapter is absent
        if (side === "buy") {
          const q = await orcaAvgBuyQuotePerBase(amm.ammId, Math.max(sizeBase, MIN_ORCA_BASE_SIZE), slip);
          if (q.ok) {
            logQuote("orca_avg_buy", q.price, { fee_bps: amm.feeBps, slip_bps: slip });
            return { px: q.price, feeBps: amm.feeBps, used: "local" };
          }
        } else {
          const q = await orcaAvgSellQuotePerBase(amm.ammId, Math.max(sizeBase, MIN_ORCA_BASE_SIZE), slip);
          if (q.ok) {
            logQuote("orca_avg_sell", q.price, { fee_bps: amm.feeBps, slip_bps: slip });
            return { px: q.price, feeBps: amm.feeBps, used: "local" };
          }
        }
      } else if (!isClmm && !isDlmm) {
        // Raydium CPMM: closed-form reserves math
        const hasRes = !!amm.reserves && amm.reserves.base > 0 && amm.reserves.quote > 0;
        if (hasRes) {
          if (side === "buy") {
            const px = cpmmBuyQuotePerBase(amm.reserves!.base, amm.reserves!.quote, sizeBase, amm.feeBps);
            if (px != null) {
              logQuote("cpmm_buy", px, {
                fee_bps: amm.feeBps,
                reserves_base: amm.reserves!.base,
                reserves_quote: amm.reserves!.quote,
              });
              return { px, feeBps: amm.feeBps, used: "local" };
            }
          } else {
            const px = cpmmSellQuotePerBase(amm.reserves!.base, amm.reserves!.quote, sizeBase, amm.feeBps);
            if (px != null) {
              logQuote("cpmm_sell", px, {
                fee_bps: amm.feeBps,
                reserves_base: amm.reserves!.base,
                reserves_quote: amm.reserves!.quote,
              });
              return { px, feeBps: amm.feeBps, used: "local" };
            }
          }
        }
      }
    } catch { /* fall through */ }

    if (isDlmm) {
      logQuote("dlmm_quoter_no_fallback", undefined, { reason: "dlmm_disabled" });
      return { px: undefined, feeBps: amm.feeBps, used: "fallback", meta: { source: "dlmm_disabled_fallback" } };
    }

    // Final fallback: mid + slippage + fee (conservative)
    const px = side === "buy"
      ? this.midBuyQuotePerBase(fallbackMid, amm.feeBps, slip)
      : this.midSellQuotePerBase(fallbackMid, amm.feeBps, slip);
    logQuote("fallback_mid", px, { fee_bps: amm.feeBps, slip_bps: slip });
    return { px, feeBps: amm.feeBps, used: "fallback" };
  }

  // Node-agnostic quote (PHX or AMM)
  private async quoteNodeAvgPerBase(
    node: VenueNode,
    side: "buy" | "sell",
    sizeBase: number,
    fallbackMid: number
  ): Promise<{ px?: number; feeBps: number; used: "adapter" | "local" | "fallback"; meta?: any }> {
    if (node.kind === "phx") {
      // Try depth-walk first
      const pxDepth = this.walkPhoenix(side, sizeBase, node.feeBps);
      if (pxDepth != null) return { px: pxDepth, feeBps: node.feeBps, used: "local" };

      // Fallback: best bid/ask + configured slip (match prior behaviour)
      const B = this.getFreshBook();
      const slip = (this.C.phoenixSlippageBps ?? 0) / 10_000;
      if (B && (B as any).best_bid > 0 && (B as any).best_ask > 0) {
        const bid = (B as any).best_bid;
        const ask = (B as any).best_ask;
        const px = side === "buy" ? ask * (1 + slip) : bid * (1 - slip);
        return { px, feeBps: node.feeBps, used: "fallback" };
      }

      // Last resort: mid-based fallback
      const px = side === "buy"
        ? this.midBuyQuotePerBase(fallbackMid, node.feeBps, this.C.phoenixSlippageBps)
        : this.midSellQuotePerBase(fallbackMid, node.feeBps, this.C.phoenixSlippageBps);
      return { px, feeBps: node.feeBps, used: "fallback" };
    }

    // AMM node
    return this.quoteAmmAvgPerBase(node.amm, side, sizeBase, fallbackMid);
  }

  private logSoftStale(snapshot: AmmSnap, reason: string, freshness: FreshnessCheck, now: number): void {
    const memoKey = `${snapshot.venue}:${snapshot.ammId}`;
    const last = this.softStaleLogMemo.get(memoKey);
    if (!last || last.reason !== reason || now - last.atMs >= AMM_DEGRADE_LOG_WINDOW_MS) {
      logger.log("amm_snapshot_soft_stale", {
        venue: snapshot.venue,
        ammId: snapshot.ammId,
        reason,
        ts: snapshot.ts,
        slot: snapshot.slot ?? null,
        phoenix_slot: this.phxSlot ?? null,
        slot_skew: freshness.skew,
        slot_skew_max: resolveSlotLagLimit(snapshot.venue),
        age_ms: freshness.ageMs,
        age_limit_ms: resolveSnapshotAgeLimit(snapshot.venue),
        heartbeat_ms: snapshot.heartbeatAt != null ? Math.max(0, now - (snapshot.heartbeatAt as number)) : null,
        ws_age_ms: snapshot.wsAt != null ? Math.max(0, now - (snapshot.wsAt as number)) : null,
        synthetic_slot: snapshot.syntheticSlot ?? false,
      });
      this.softStaleLogMemo.set(memoKey, { reason, atMs: now });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  private async maybeReport(): Promise<void> {
    // Reset circuit breakers daily
    const nowDay = new Date().getUTCDate();
    if (nowDay !== lastResetDay) {
      dailyTrades = 0; dailyVolumeQuote = 0; lastResetDay = nowDay;
    }

    const book = this.getFreshBook();
    const now = Date.now();

    if (!book || this.amms.size === 0) {
      if (now - this.lastWaitLog >= this.P.waitLogMs) {
        this.lastWaitLog = now;
        logger.log("edge_waiting", {
          have_raydium: !!Array.from(this.amms.values()).find(a => a.venue === "raydium"),
          have_orca: !!Array.from(this.amms.values()).find(a => a.venue === "orca"),
          have_phoenix_mid: !!this.phxMid,
          have_phoenix_book: !!this.phxBook,
          min_abs_bps: this.P.minAbsBps,
        });
      }
      return;
    }

    const bid = (book as any).best_bid;
    const ask = (book as any).best_ask;
    if (!(bid > 0 && ask > 0)) return;

    // Filter AMM snapshots by staleness + config allow-list
    const freshAmms: AmmSnap[] = [];
    const staleAmms: { snap: AmmSnap; reason: string; skew?: number; ageMs?: number }[] = [];
    for (const a of this.amms.values()) {
      const tradeablePreferred = CONFIG_TRADEABLE_BY_VENUE.get(a.venue.toLowerCase());
      if (tradeablePreferred) {
        a.tradeableWhenDegraded = true;
      }
      const slotLagLimit = resolveSlotLagLimit(a.venue);
      const fallbackAgeMs = resolveSnapshotAgeLimit(a.venue);
      const heartbeatGraceMs = resolveHeartbeatGraceMs(a.venue);
      const bookTtl = this.C.bookTtlMs != null ? Math.max(this.C.bookTtlMs, fallbackAgeMs) : undefined;

      const freshness = checkAmmFreshness(
        { ts: a.ts, slot: a.slot ?? null, venue: a.venue, ammId: a.ammId },
        this.phxSlot ?? null,
        now,
        slotLagLimit,
        fallbackAgeMs,
        bookTtl
      );

      let snapshot: AmmSnap | null = null;
      const memoKey = `${a.venue}:${a.ammId}`;

      if (!freshness.ok) {
        const reason = freshness.reason ?? "stale";

        if (isSoftStaleEligible(a, reason, now, heartbeatGraceMs, Boolean(tradeablePreferred))) {
          const soft: AmmSnap = { ...a, softStale: true, stale: true, staleReason: reason };
          snapshot = soft;
          this.logSoftStale(soft, reason, freshness, now);
          this.degradedLogMemo.delete(memoKey);
          this.ignoredLogMemo.delete(memoKey);
        } else {
          const canUseStale = ALLOW_STALE_DECISIONS && (
            reason.startsWith("slot_skew") ||
            reason.startsWith("age_ms") ||
            reason.includes("slot") ||
            reason.includes("age")
          );

          if (canUseStale) {
            const degraded: AmmSnap = {
              ...a,
              degraded: true,
              degradedReason: reason,
              stale: true,
              staleReason: reason,
              softStale: false,
            };
            const last = this.degradedLogMemo.get(memoKey);
            if (!last || last.reason !== reason || now - last.atMs >= AMM_DEGRADE_LOG_WINDOW_MS) {
              logger.log("amm_snapshot_degraded", {
                venue: degraded.venue,
                ammId: degraded.ammId,
                reason,
                ts: degraded.ts,
                slot: degraded.slot ?? null,
                phoenix_slot: this.phxSlot ?? null,
                slot_skew: freshness.skew,
                slot_skew_max: slotLagLimit,
                age_ms: freshness.ageMs,
                age_limit_ms: fallbackAgeMs,
                heartbeat_ms: a.heartbeatAt != null ? Math.max(0, now - (a.heartbeatAt as number)) : null,
                ws_age_ms: a.wsAt != null ? Math.max(0, now - (a.wsAt as number)) : null,
                synthetic_slot: a.syntheticSlot ?? false,
              });
              this.degradedLogMemo.set(memoKey, { reason, atMs: now });
            }
            this.softStaleLogMemo.delete(memoKey);
            snapshot = degraded;
          } else {
            const last = this.ignoredLogMemo.get(memoKey);
            if (!last || last.reason !== reason || now - last.atMs >= AMM_DEGRADE_LOG_WINDOW_MS) {
              logger.log("amm_snapshot_ignored", {
                venue: a.venue,
                ammId: a.ammId,
                reason,
                ts: a.ts,
                slot: a.slot ?? null,
                phoenix_slot: this.phxSlot ?? null,
                slot_skew: freshness.skew,
                slot_skew_max: slotLagLimit,
                age_ms: freshness.ageMs,
                age_limit_ms: fallbackAgeMs,
              });
              this.ignoredLogMemo.set(memoKey, { reason, atMs: now });
            }
            this.degradedLogMemo.delete(memoKey);
            this.softStaleLogMemo.delete(memoKey);
            staleAmms.push({ snap: a, reason, skew: freshness.skew, ageMs: freshness.ageMs });
            continue;
          }
        }
      } else {
        const fresh = {
          ...a,
          softStale: false,
          staleReason: null,
          degraded: false,
          degradedReason: null,
          stale: false,
        } as AmmSnap;
        snapshot = fresh;
        this.degradedLogMemo.delete(memoKey);
        this.ignoredLogMemo.delete(memoKey);
        this.softStaleLogMemo.delete(memoKey);
      }

      if (!snapshot) continue;
      if (!snapshot.degraded) {
        this.degradedLogMemo.delete(memoKey);
        this.ignoredLogMemo.delete(memoKey);
      }
      if (!snapshot.softStale) {
        this.softStaleLogMemo.delete(memoKey);
      }
      if (this.allowedPools.size && !this.allowedPools.has(`${snapshot.venue}:${snapshot.ammId}`)) continue;
      freshAmms.push(snapshot);
    }
    const validAmms: AmmSnap[] = freshAmms;

    if (validAmms.length === 0) {
      if (now - this.lastWaitLog >= this.P.waitLogMs) {
        this.lastWaitLog = now;
        logger.log("edge_waiting", {
          have_raydium: false,
          have_orca: false,
          have_phoenix_mid: !!this.phxMid,
          have_phoenix_book: !!this.phxBook,
          reason: staleAmms.length ? "all_amm_snapshots_stale" : "no_amms",
        });
      }
      return;
    }

    const stateSigParts: string[] = [];
    if (Number.isFinite(bid) && Number.isFinite(ask)) {
      stateSigParts.push(`phx:${bid.toFixed(6)}:${ask.toFixed(6)}`);
    }
    for (const a of validAmms) {
      const mid = Number.isFinite(a.px) ? (a.px as number).toFixed(6) : "nan";
      stateSigParts.push(`${a.venue}:${a.ammId}:${mid}:${a.ts ?? 0}`);
    }
    const evalSig = stateSigParts.join("|");
    const bucketMs = Math.max(50, this.C.decisionBucketMs ?? 0);
    let deltaBps = Number.POSITIVE_INFINITY;
    if (this.lastEvalContext) {
      const prev = this.lastEvalContext;
      deltaBps = 0;
      if (prev.bid > 0 && bid > 0) deltaBps = Math.max(deltaBps, Math.abs(bid / prev.bid - 1) * 10_000);
      if (prev.ask > 0 && ask > 0) deltaBps = Math.max(deltaBps, Math.abs(ask / prev.ask - 1) * 10_000);
      for (const a of validAmms) {
        const key = `${a.venue}:${a.ammId}`;
        const prevMid = prev.amms[key];
        if (prevMid > 0 && a.px > 0) {
          deltaBps = Math.max(deltaBps, Math.abs((a.px as number) / prevMid - 1) * 10_000);
        }
      }
    }
    if (this.lastEvalSig === evalSig && now - this.lastEvalAt < bucketMs) {
      if (deltaBps !== Number.POSITIVE_INFINITY && deltaBps < MIN_PRICE_DELTA_BPS) {
        return;
      }
    }
    if (this.isRateLimited()) {
      if (now - this.lastRateLimitLog >= this.P.waitLogMs) {
        this.lastRateLimitLog = now;
        logger.log("joiner_rate_limited_skip", { wait_ms: this.rateLimitedUntil - now });
      }
      return;
    }
    this.lastEvalSig = evalSig;
    this.lastEvalAt = now;
    this.lastEvalContext = {
      bid,
      ask,
      amms: Object.fromEntries(validAmms.map((a) => [`${a.venue}:${a.ammId}`, Number(a.px ?? 0)])),
    };

    this.dlmmQuoteMemo.clear();

    // Emit a single edge_report snapshot (Phoenix vs latest valid AMM mid)
    const latestAmm = validAmms.slice().sort((a, b) => b.ts - a.ts)[0];
    const ammPx = latestAmm?.px ?? (bid + ask) / 2;

    const toPhoenixSellBps = (ammPx / bid - 1) * 10_000;
    const toPhoenixBuyBps = (ask / ammPx - 1) * 10_000;
    const absBps = Math.max(Math.abs(toPhoenixSellBps), Math.abs(toPhoenixBuyBps));
    if (absBps >= this.P.minAbsBps) {
      const payload = {
        symbol: this.symbol,
        amm_mid: Number(ammPx.toFixed(6)),
        amm_mid_str: ammPx.toFixed(9),
        phoenix_bid: Number(bid.toFixed(6)),
        phoenix_bid_str: bid.toFixed(9),
        phoenix_ask: Number(ask.toFixed(6)),
        phoenix_ask_str: ask.toFixed(9),
        phoenix_mid: Number(((bid + ask) / 2).toFixed(6)),
        phoenix_source: "book",
        toPhoenixSellBps: Number(toPhoenixSellBps.toFixed(4)),
        toPhoenixBuyBps: Number(toPhoenixBuyBps.toFixed(4)),
        absBps: Number(absBps.toFixed(4)),
        validation_passed: true,
        phoenix_book_method: (book as any).book_method ?? "unknown",
      };
      const sig = JSON.stringify(payload);
      if (sig !== this.lastSig) { logger.log("edge_report", payload); this.lastSig = sig; }
    }

    // Build L2 for optimizer (if available) — may be unused but harmless
    let bookOpt: SizePhoenixBook | undefined;
    if (Array.isArray((this.phxBook as any)?.levels_bids) && Array.isArray((this.phxBook as any)?.levels_asks)) {
      const bids = ((this.phxBook as any).levels_bids as DepthSide[]).filter(l => l && l.px > 0 && l.qty > 0).map(l => ({ px: l.px, qtyBase: l.qty }));
      const asks = ((this.phxBook as any).levels_asks as DepthSide[]).filter(l => l && l.px > 0 && l.qty > 0).map(l => ({ px: l.px, qtyBase: l.qty }));
      if (bids.length && asks.length) bookOpt = { bids, asks, takerFeeBps: this.P.phoenixFeeBps };
    }

    // ── Unified 2-leg path enumerator (PHX<->AMM and AMM<->AMM) ─────────────
    const includeDualPhoenix = envTrue("ENABLE_AMM_PHX", true);
    const phoenixNodes: VenueNode[] = includeDualPhoenix
      ? [
        { kind: "phx", id: "phoenix_buy", feeBps: this.P.phoenixFeeBps },
        { kind: "phx", id: "phoenix_sell", feeBps: this.P.phoenixFeeBps },
      ]
      : [{ kind: "phx", id: "phoenix", feeBps: this.P.phoenixFeeBps }];

    const ammNodes: VenueNode[] = validAmms.map((a) => ({
      kind: "amm" as const,
      id: `${a.venue}:${a.ammId}`,
      feeBps: a.feeBps,
      amm: a,
    }));

    const nodes: VenueNode[] = [...phoenixNodes, ...ammNodes];

    const candidates: PathCandidate[] = [];
    const trackAmmAmm = envTrue("TRACK_AMM_AMM", true);
    const execAmmAmm = envTrue("EXECUTE_AMM_AMM", false);
    const midRef = (bid + ask) / 2;
    const pathStats: Record<PathCandidate["path"], number> = {
      "PHX->AMM": 0,
      "AMM->PHX": 0,
      "AMM->AMM": 0,
    };
    const bestPerPath = new Map<PathCandidate["path"], PathCandidate>();

    const logPathPairs = PATH_PAIR_LOG_ENABLED;

    for (const nodeSrc of nodes) {
      for (const nodeDst of nodes) {
        if (nodeSrc === nodeDst) continue;
        // Skip PHX->PHX (same venue both sides)
        if (nodeSrc.kind === "phx" && nodeDst.kind === "phx") continue;

        // Path label compatible with rest of pipeline
        const path: PathCandidate["path"] =
          nodeSrc.kind === "phx" && nodeDst.kind === "amm" ? "PHX->AMM" :
            nodeSrc.kind === "amm" && nodeDst.kind === "phx" ? "AMM->PHX" :
              "AMM->AMM";

        if (path === "AMM->AMM" && !trackAmmAmm && !execAmmAmm) continue;

        if (logPathPairs) {
          const payload = {
            t: new Date().toISOString(),
            symbol: this.symbol,
            path,
            src: nodeSrc.kind === "amm" ? `${nodeSrc.amm.venue}:${nodeSrc.amm.ammId}` : nodeSrc.id,
            dst: nodeDst.kind === "amm" ? `${nodeDst.amm.venue}:${nodeDst.amm.ammId}` : nodeDst.id,
          } as const;
          try { logger.log("path_pair_considered", payload); } catch { /* ignore */ }
          appendPathPairLog(payload as unknown as Record<string, unknown>);
        }

        const candidate = await this.evaluatePathCandidate({
          nodeSrc,
          nodeDst,
          path,
          bid,
          ask,
          midRef,
          trackAmmAmm,
          execAmmAmm,
          latestAmm,
        });

        if (candidate) {
          pathStats[path] = (pathStats[path] ?? 0) + 1;
          candidates.push(candidate);
          const prevBest = bestPerPath.get(path);
          if (!prevBest || candidate.pnlNet > prevBest.pnlNet) {
            bestPerPath.set(path, candidate);
          }
        }
      }
    }

    try {
      const paths: Record<string, unknown> = {};
      const summarizeCandidate = (path: PathCandidate["path"], cand: PathCandidate | undefined, count: number) => {
        const key = path === "PHX->AMM"
          ? "phx_to_amm"
          : path === "AMM->PHX"
            ? "amm_to_phx"
            : "amm_to_amm";

        if (!cand) {
          paths[key] = { available: false, candidates: count };
          return;
        }

        const summary: Record<string, unknown> = {
          available: true,
          candidates: count,
          edge_bps_net: round(cand.bpsNet, 4),
          pnl_quote: round(cand.pnlNet, 6),
          size_base: round(cand.size, 9),
        };

        if (path === "PHX->AMM") {
          summary.src = "phoenix";
          summary.dst = `${cand.amm.venue}:${cand.amm.ammId}`;
        } else if (path === "AMM->PHX") {
          summary.src = `${cand.amm.venue}:${cand.amm.ammId}`;
          summary.dst = "phoenix";
        } else {
          summary.src = `${cand.amm.venue}:${cand.amm.ammId}`;
          summary.dst = cand.ammDst ? `${cand.ammDst.venue}:${cand.ammDst.ammId}` : "unknown";
        }

        paths[key] = summary;
      };

      summarizeCandidate("PHX->AMM", bestPerPath.get("PHX->AMM"), pathStats["PHX->AMM"] ?? 0);
      summarizeCandidate("AMM->PHX", bestPerPath.get("AMM->PHX"), pathStats["AMM->PHX"] ?? 0);
      summarizeCandidate("AMM->AMM", bestPerPath.get("AMM->AMM"), pathStats["AMM->AMM"] ?? 0);

      logger.log("path_best_snapshot", {
        symbol: this.symbol,
        ...paths,
      });
    } catch {
      /* ignore logging failures */
    }

    try {
      logger.log("path_candidate_counts", {
        symbol: this.symbol,
        phx_to_amm: pathStats["PHX->AMM"],
        amm_to_phx: pathStats["AMM->PHX"],
        amm_to_amm: pathStats["AMM->AMM"],
      });
    } catch {
      /* ignore logging failures */
    }

    // Choose the best candidate among all paths
    const best = candidates.sort((a, b) => b.pnlNet - a.pnlNet)[0];
    if (!best) {
      if (this.C.logSimFields) logger.log("would_not_trade", {
        symbol: this.symbol,
        reason: "no_profitable_opportunities_found",
        size_grid_count: 1,
        validation_enabled: true,
      });
      this.onDecision(false, Number.NaN, Number.NaN, undefined);
      return;
    }

    // RPC sim (optional) — only for PHX paths
    const base: any = {
      symbol: this.symbol,
      path: best.path,
      side: best.path === "AMM->PHX" ? "sell" : "buy",
      amm_venue: best.amm.venue,
      ...(best.path === "AMM->AMM" ? { amm_dst_venue: best.ammDst?.venue } : {}),
      trade_size_base: round(best.size, 9),
      recommended_size_base: round(best.size, 9),
      threshold_bps: round(this.P.thresholdBps, 4),
      slippage_bps: round(this.P.flatSlippageBps, 4),
      phoenix_slippage_bps: round(this.C.phoenixSlippageBps, 4),
      slippage_mode: this.C.activeSlippageMode,
      phoenix_source: "book",
      phoenix_book_method: (book as any).book_method ?? "unknown",
      phoenix_slot: this.phxSlot ?? null,
      buy_px: round(best.buyPx),
      sell_px: round(best.sellPx),
      edge_bps_net: round(best.bpsNet, 4),
      expected_pnl: round(best.pnlNet, 6),
      fees_bps: { phoenix: this.P.phoenixFeeBps, amm: best.amm.feeBps, ...(best.ammDst ? { amm_dst: best.ammDst.feeBps } : {}) },
      amm_slot: best.amm.slot ?? null,
      amm_ts: best.amm.ts ?? null,
      ...(best.ammDst
        ? {
          amm_dst_slot: best.ammDst.slot ?? null,
          amm_dst_ts: best.ammDst.ts ?? null,
        }
        : {}),
      fixed_tx_cost_quote: round(this.P.fixedTxCostQuote, 6),
      decision_min_base:
        envNum("DECISION_MIN_BASE") ??
        this.P.decisionMinBase ??
        this.C.decisionMinBase ??
        envNum("SIZEOPT_MIN_BASE") ??
        this.P.minBase ??
        this.P.minTradeBase,
      size_grid_count: 1,
      validation_enabled: true,
    };

    const hasRes = !!best.amm.reserves && best.amm.reserves.base > 0 && best.amm.reserves.quote > 0;
    const ammEffPx = ((): number | undefined => {
      if (best.amm.venue === "orca") {
        // already included in buy/sellPx; report impact relative to mid
        return best.path === "AMM->PHX"
          ? best.buyPx
          : best.sellPx;
      }
      if (best.path === "AMM->PHX") {
        return hasRes
          ? cpmmBuyQuotePerBase(best.amm.reserves!.base, best.amm.reserves!.quote, best.size, best.amm.feeBps)
          : this.midBuyQuotePerBase(best.amm.px, best.amm.feeBps, this.P.flatSlippageBps);
      } else if (best.path === "PHX->AMM") {
        return hasRes
          ? cpmmSellQuotePerBase(best.amm.reserves!.base, best.amm.reserves!.quote, best.size, best.amm.feeBps)
          : this.midSellQuotePerBase(best.amm.px, best.amm.feeBps, this.P.flatSlippageBps);
      } else {
        return undefined;
      }
    })();
    if (ammEffPx != null) {
      base.amm_eff_px = round(ammEffPx);
      base.amm_price_impact_bps = round((ammEffPx / best.amm.px - 1) * 10_000, 4);
    }

    if (this.C.useRpcSim && this.rpcSim && best.path !== "AMM->AMM" && best.amm.reserves) {
      try {
        const out = await this.rpcSim({
          path: best.path as "AMM->PHX" | "PHX->AMM",
          sizeBase: best.size,
          ammMid: best.amm.px,
          reserves: hasRes ? { base: best.amm.reserves.base, quote: best.amm.reserves.quote } : undefined,
          ammFeeBps: best.amm.feeBps,
        });
        if (out) {
          if (typeof out.rpc_eff_px === "number" && Number.isFinite(out.rpc_eff_px)) base.rpc_eff_px = round(out.rpc_eff_px);
          if (typeof out.rpc_price_impact_bps === "number" && Number.isFinite(out.rpc_price_impact_bps)) base.rpc_price_impact_bps = round(out.rpc_price_impact_bps, 4);
          if (typeof out.rpc_sim_ms === "number" && out.rpc_sim_ms >= 0) base.rpc_sim_ms = out.rpc_sim_ms;
          if (typeof out.rpc_sim_mode === "string") base.rpc_sim_mode = out.rpc_sim_mode;
          if (typeof out.rpc_qty_out === "number" && Number.isFinite(out.rpc_qty_out)) base.rpc_qty_out = round(out.rpc_qty_out, 9);
          if (typeof out.rpc_units === "number" && Number.isFinite(out.rpc_units)) { base.rpc_units = out.rpc_units; base.compute_units = out.rpc_units; }
          if (typeof out.prioritization_fee === "number" && Number.isFinite(out.prioritization_fee)) base.prioritization_fee = out.prioritization_fee;
          this.onRpcSample?.({ ms: (out.rpc_sim_ms ?? 0), blocked: false });
        }
      } catch (e: any) {
        base.rpc_sim_error = String(e?.message ?? e);
      }
    }

    const rpcEff = (base as any).rpc_eff_px;
    if (rpcEff != null && Number.isFinite(rpcEff) && base.amm_eff_px != null) {
      const delta_bps = Math.abs((rpcEff / base.amm_eff_px - 1) * 10_000);
      const RPC_TOL_BPS = Number(process.env.RPC_SIM_TOL_BPS ?? 2);
      if (delta_bps > RPC_TOL_BPS) {
        base.rpc_deviation_bps = round(delta_bps, 4);
        base.guard_deviation_bps = round(delta_bps, 4);
        base.guard_blocked = true;
        this.onRpcSample?.({ ms: (base as any).rpc_sim_ms ?? 0, blocked: true });
        logger.log("would_not_trade", { ...base, reason: `rpc deviation > ${RPC_TOL_BPS} bps` });
        this.onDecision(false, best.bpsNet, best.pnlNet, undefined);
        return;
      }
      base.guard_deviation_bps = round(delta_bps, 4);
      base.guard_blocked = false;
      this.onRpcSample?.({ ms: (base as any).rpc_sim_ms ?? 0, blocked: false });
    }

    const safetyBps = Number(process.env.PNL_SAFETY_BPS ?? "0") || 0;
    const wantBps = this.P.thresholdBps + safetyBps;
    const wouldTrade = best.bpsNet >= wantBps && best.pnlNet > 0;

    if (wouldTrade) {
      const notionalQuote = best.size * ((best.buyPx + best.sellPx) / 2);
      noteDecision(notionalQuote);
      logger.log("would_trade", { ...base, safety_bps: round(safetyBps, 4), reason: "profitable_opportunity_validated" });
    } else {
      const reason =
        best.pnlNet <= 0
          ? "negative expected pnl after fees/slippage at s*"
          : `edge below threshold+safety (net_bps=${round(best.bpsNet, 4)} < ${wantBps})`;
      logger.log("would_not_trade", { ...base, safety_bps: round(safetyBps, 4), reason });
    }

    // Decision callback (includes AMM->AMM details if present)
    this.onDecision(wouldTrade, best.bpsNet, best.pnlNet, {
      path: best.path,
      side: best.path === "AMM->PHX" ? "sell" : "buy",
      buy_px: round(best.buyPx),
      sell_px: round(best.sellPx),
      recommended_size_base: best.size,
      amm_venue: best.amm.venue,
      amm_pool_id: best.amm.ammId,
      amm_meta: { poolKind: best.amm.poolKind, feeBps: best.amm.feeBps, slot: best.amm.slot ?? null, ts: best.amm.ts },
      ...(best.path === "AMM->AMM"
        ? {
          amm_dst_venue: best.ammDst?.venue,
          amm_dst_pool_id: best.ammDst?.ammId,
          amm_dst_meta: best.ammDst
            ? { poolKind: best.ammDst.poolKind, feeBps: best.ammDst.feeBps, slot: best.ammDst.slot ?? null, ts: best.ammDst.ts }
            : undefined,
        }
        : {}),
    });

    // Feature emission — ONLY for PHX paths (compat with 1-arg and 2-arg emitFeature signatures)
    if (best.path === "AMM->PHX" || best.path === "PHX->AMM") {
      const featPayload = featureFromEdgeAndDecision(
        {
          symbol: this.symbol,
          amm_base_reserve: best.amm.reserves?.base,
          amm_quote_reserve: best.amm.reserves?.quote,
          amm_base_decimals: best.amm.reserves?.baseDecimals,
          amm_quote_decimals: best.amm.reserves?.quoteDecimals,
          phoenix_source: "book",
          phoenix_book_method: (book as any).book_method,
          book_ttl_ms: this.C.bookTtlMs,
        },
        {
          path: best.path as "AMM->PHX" | "PHX->AMM",
          side: best.path === "AMM->PHX" ? "sell" : "buy",
          edge_bps_gross: round(best.bpsGross, 4),
          buy_px: round(best.buyPx),
          sell_px: round(best.sellPx),
          expected_pnl: round(best.pnlNet, 6),
          threshold_bps: this.P.thresholdBps,
          slippage_bps: this.P.flatSlippageBps,
          trade_size_base: best.size,
          would_trade: wouldTrade,
        }
      );

      // Arity-flexible call so TS is happy whether emitFeature expects (payload) or (topic, payload)
      const ef: any = emitFeature as any;
      try {
        if (typeof ef === "function") {
          if (ef.length >= 2) ef("edge_feature", featPayload);
          else ef(featPayload);
        }
      } catch {
        /* noop */
      }
    }
  }
}
