// services/arb-mm/src/config.ts
// Centralized env + defaults + params merge + path helpers.
// Enhanced to prefer .env.live (then fall back to .env). Supports ENV_FILE override.
// NEW: respects __ENV_LIVE_LOCKED=1 to avoid re-loading env files if upstream already loaded them.

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";

export type SlipMode = "flat" | "amm_cpmm" | "adaptive";

// ESM-safe service root (…/services/arb-mm)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SVC_ROOT = path.resolve(__dirname, "..");

// Load .env.live with highest precedence, then .env
function loadRootEnv() {
  // If upstream (main.ts or shell) has already loaded & locked env, skip.
  if (String(process.env.__ENV_LIVE_LOCKED ?? "0") === "1") return;

  const ENV_FILE = process.env.ENV_FILE?.trim();
  const candidates = [
    // explicit file (absolute or relative)
    ...(ENV_FILE ? [path.isAbsolute(ENV_FILE) ? ENV_FILE : path.resolve(SVC_ROOT, ENV_FILE)] : []),

    // service-local .env.live / .env
    path.resolve(SVC_ROOT, ".env.live"),
    path.resolve(SVC_ROOT, ".env"),

    // repo root .env.live / .env
    path.resolve(SVC_ROOT, "..", "..", ".env.live"),
    path.resolve(SVC_ROOT, "..", "..", ".env"),

    // process cwd (rare, but keep)
    path.resolve(process.cwd(), ".env.live"),
    path.resolve(process.cwd(), ".env"),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        return;
      }
    } catch { }
  }

  // fallback to default resolution if nothing found
  dotenv.config();
}
loadRootEnv();

export function parseMsEnv(v: string | undefined, def = 5000, min = 50, max = 60000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
export function parseFloatEnv(v: string | undefined, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
export function parseIntEnv(v: string | undefined, def = 0, min?: number, max?: number) {
  const n = Number(v);
  const base = Number.isInteger(n) ? n : Math.trunc(Number.isFinite(n) ? n : def);
  const lo = min ?? Number.MIN_SAFE_INTEGER;
  const hi = max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(lo, Math.min(hi, base));
}
export function parseBoolEnv(v: string | undefined, def = false) {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}
export function envBool(k: string, def: boolean): boolean {
  const v = process.env[k];
  if (v === undefined) return def;
  if (v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes") return true;
  if (v === "0" || v?.toLowerCase() === "false" || v?.toLowerCase() === "no") return false;
  return def;
}

// ── Paths (anchor to service root, then repo root) ───────────
export function resolvePathCandidates(rel: string) {
  return [
    path.resolve(SVC_ROOT, rel),
    path.resolve(SVC_ROOT, "..", "..", rel),
  ];
}
export function firstExistingPathOrDefault(relOrAbs: string): string {
  if (path.isAbsolute(relOrAbs)) return relOrAbs;
  const candidates = resolvePathCandidates(relOrAbs);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return path.resolve(SVC_ROOT, relOrAbs);
}

// ── RPC resolver ───────────
function resolveRpc(): string {
  const explicit = process.env.RPC_URL?.trim();
  if (explicit) return explicit;
  const primary = process.env.RPC_PRIMARY?.trim();
  if (primary) return primary;
  const heliusKey = process.env.HELIUS_API_KEY?.trim();
  if (heliusKey) return `https://rpc.helius.xyz/?api-key=${heliusKey}`;
  // absolute fallback
  return "https://api.mainnet-beta.solana.com";
}
export function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "***");
    return url.toString();
  } catch {
    return u;
  }
}
export const RPC = resolveRpc();

// ── Fee resolver ───────────
function asNum(v: any, dflt: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function loadFeesJson() {
  const p = process.env.FEES_JSON?.trim();
  if (!p) return null;
  try {
    const abs = firstExistingPathOrDefault(p);
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}
const FEES_JSON = loadFeesJson();

export function resolveFeeBps(kind: "AMM" | "PHOENIX", id: string | undefined, fallback: number) {
  let bps = asNum(process.env[`${kind}_TAKER_FEE_BPS`], fallback);
  const altGlobal = process.env[`FEE_BPS_${kind}`];
  if (altGlobal != null) bps = asNum(altGlobal, bps);

  if (FEES_JSON?.global?.[kind] != null) bps = asNum(FEES_JSON.global[kind], bps);

  if (id) {
    const envOv = process.env[`${kind}_TAKER_FEE_BPS__${id}`] ?? process.env[`FEE_BPS_${kind}__${id}`];
    if (envOv != null) bps = asNum(envOv, bps);
    const jsonOv = FEES_JSON?.[kind]?.[id];
    if (jsonOv != null) bps = asNum(jsonOv, bps);
  }
  return bps;
}

// ── Params loader ───────────────────────────────────────────────────────────
type DailyParams = Partial<{
  TRADE_THRESHOLD_BPS: number;
  MAX_SLIPPAGE_BPS: number;
  TRADE_SIZE_BASE: number;
}>;
function loadLatestParamsSync(PARAMS_DIR: string): { file?: string; params: DailyParams } {
  try {
    if (!fs.existsSync(PARAMS_DIR)) return { params: {} };
    const files = fs
      .readdirSync(PARAMS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(PARAMS_DIR, f));
    if (files.length === 0) return { params: {} };
    const latest = files
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]!.p;
    const raw = JSON.parse(fs.readFileSync(latest, "utf8"));
    const best = raw?.best ?? {};
    const params: DailyParams = {
      TRADE_THRESHOLD_BPS: typeof best.TRADE_THRESHOLD_BPS === "number" ? best.TRADE_THRESHOLD_BPS : undefined,
      MAX_SLIPPAGE_BPS: typeof best.MAX_SLIPPAGE_BPS === "number" ? best.MAX_SLIPPAGE_BPS : undefined,
      TRADE_SIZE_BASE: typeof best.TRADE_SIZE_BASE === "number" ? best.TRADE_SIZE_BASE : undefined,
    };
    return { file: latest, params };
  } catch {
    return { params: {} };
  }
}

export interface AppConfig {
  AMMS_JSONL: string;
  PHOENIX_JSONL: string;
  EDGE_MIN_ABS_BPS: number;
  EDGE_WAIT_LOG_MS: number;
  EDGE_FOLLOW_POLL_MS: number;

  BOOK_TTL_MS: number;
  SYNTH_WIDTH_BPS: number;

  DATA_DIR: string;
  PARAMS_DIR: string;
  AUTO_APPLY_PARAMS: boolean;
  PARAM_FILE?: string;

  TRADE_THRESHOLD_BPS: number;
  MAX_SLIPPAGE_BPS: number;
  TRADE_SIZE_BASE: number;
  PHOENIX_TAKER_FEE_BPS: number;
  AMM_TAKER_FEE_BPS: number;
  FIXED_TX_COST_QUOTE: number;
  DECISION_DEDUPE_MS: number;
  DECISION_BUCKET_MS: number;
  DECISION_MIN_EDGE_DELTA_BPS: number;
  ENFORCE_DEDUPE: boolean;
  SLIPPAGE_MODE: SlipMode;
  USE_POOL_IMPACT_SIM: boolean;
  ACTIVE_SLIPPAGE_MODE: SlipMode;
  USE_RPC_SIM: boolean;
  USE_RAYDIUM_SWAP_SIM: boolean;
  PHOENIX_SLIPPAGE_BPS: number;
  CPMM_MAX_POOL_TRADE_FRAC: number;
  DYNAMIC_SLIPPAGE_EXTRA_BPS: number;
  LOG_SIM_FIELDS: boolean;
  ALLOW_SYNTH_TRADES: boolean;

  RPC_SIM_CU_LIMIT: number;
  RPC_SIM_CU_PRICE_MICROLAMPORTS: number;
  SUBMIT_CU_LIMIT: number;
  SUBMIT_TIP_LAMPORTS: number;

  TIP_MODE: "fixed" | "cu_price";
  TIP_MICROLAMPORTS_PER_CU: number;
  TIP_MULTIPLIER: number;
  TIP_MAX_LAMPORTS: number;

  WALLET_PUBKEY?: string;
  USDC_MINT?: string;
  SOL_MINT?: string;
  USDC_ATA?: string;
  WSOL_ATA?: string;

  PHOENIX_MARKET: string;

  MIN_SOL_BALANCE_LAMPORTS: number;

  PHOENIX_DEPTH_ENABLED?: boolean;
  PHOENIX_DEPTH_LEVELS?: number;
  PHOENIX_DEPTH_EXTRA_BPS?: number;

  // runtime control
  ATOMIC_MODE?: "none" | "single_tx";
  RUN_FOR_MINUTES?: number; // auto-stop window
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}

export function loadConfig(): AppConfig {
  const AMMS_JSONL = firstExistingPathOrDefault(process.env.EDGE_AMMS_JSONL ?? "packages/amms/logs/runtime.jsonl");
  const PHOENIX_JSONL = firstExistingPathOrDefault(process.env.EDGE_PHOENIX_JSONL ?? "packages/phoenix/logs/runtime.jsonl");

  const EDGE_MIN_ABS_BPS = parseFloatEnv(process.env.EDGE_MIN_ABS_BPS, 0);
  const EDGE_WAIT_LOG_MS = parseMsEnv(process.env.EDGE_WAIT_LOG_MS, 5000, 100, 60000);
  const EDGE_FOLLOW_POLL_MS = parseMsEnv(process.env.EDGE_FOLLOW_POLL_MS, 500, 50, 5000);

  const BOOK_TTL_MS = parseMsEnv(process.env.PHOENIX_BOOK_TTL_MS ?? process.env.BOOK_TTL_MS, 500, 100, 60000);
  const SYNTH_WIDTH_BPS = parseFloatEnv(process.env.PHOENIX_SYNTH_WIDTH_BPS, 8);

  const DATA_ENV_RAW = process.env.DATA_DIR ?? process.env.ARB_DATA_DIR;
  const DATA_ENV = DATA_ENV_RAW?.trim();
  const DATA_DIR = DATA_ENV
    ? (path.isAbsolute(DATA_ENV) ? DATA_ENV : path.resolve(SVC_ROOT, DATA_ENV))
    : path.resolve(SVC_ROOT, "data");
  const PARAMS_DIR = path.join(DATA_DIR, "params");
  const AUTO_APPLY_PARAMS = parseBoolEnv(process.env.AUTO_APPLY_PARAMS, false);

  const DEF_TRADE_THRESHOLD_BPS = 10;
  const DEF_MAX_SLIPPAGE_BPS = 2;
  const DEF_TRADE_SIZE_BASE = 0.1;

  const ENV_THRESHOLD = parseFloatEnv(process.env.TRADE_THRESHOLD_BPS, DEF_TRADE_THRESHOLD_BPS);
  const ENV_MAX_SLIP = parseFloatEnv(process.env.MAX_SLIPPAGE_BPS, DEF_MAX_SLIPPAGE_BPS);
  const ENV_SIZE = parseFloatEnv(process.env.TRADE_SIZE_BASE, DEF_TRADE_SIZE_BASE);

  let PARAM_FILE: string | undefined;
  let P_THRESHOLD: number | undefined;
  let P_MAX_SLIP: number | undefined;
  let P_SIZE: number | undefined;
  if (AUTO_APPLY_PARAMS) {
    const { file, params } = loadLatestParamsSync(PARAMS_DIR);
    PARAM_FILE = file;
    P_THRESHOLD = params.TRADE_THRESHOLD_BPS;
    P_MAX_SLIP = params.MAX_SLIPPAGE_BPS;
    P_SIZE = params.TRADE_SIZE_BASE;
  }

  const TRADE_THRESHOLD_BPS = P_THRESHOLD ?? ENV_THRESHOLD ?? DEF_TRADE_THRESHOLD_BPS;
  const MAX_SLIPPAGE_BPS = P_MAX_SLIP ?? ENV_MAX_SLIP ?? DEF_MAX_SLIPPAGE_BPS;
  const TRADE_SIZE_BASE = P_SIZE ?? ENV_SIZE ?? DEF_TRADE_SIZE_BASE;

  const PHOENIX_TAKER_FEE_BPS = parseFloatEnv(process.env.PHOENIX_TAKER_FEE_BPS, 0);
  const AMM_TAKER_FEE_BPS = parseFloatEnv(process.env.AMM_TAKER_FEE_BPS, 0);
  const FIXED_TX_COST_QUOTE = parseFloatEnv(process.env.FIXED_TX_COST_QUOTE, 0);

  const DECISION_DEDUPE_MS = parseMsEnv(process.env.DECISION_DEDUPE_MS, 1000, 0, 600000);
  const DECISION_BUCKET_MS = parseMsEnv(process.env.DECISION_BUCKET_MS, 250, 0, 600000);
  const DECISION_MIN_EDGE_DELTA_BPS = parseFloatEnv(process.env.DECISION_MIN_EDGE_DELTA_BPS, 0.25);
  const ENFORCE_DEDUPE = parseBoolEnv(process.env.ENFORCE_DEDUPE, true);

  const SLIPPAGE_MODE = (process.env.SLIPPAGE_MODE?.toLowerCase() as SlipMode) || "adaptive";
  const USE_POOL_IMPACT_SIM = envBool("USE_POOL_IMPACT_SIM", true);
  const ACTIVE_SLIPPAGE_MODE: SlipMode = USE_POOL_IMPACT_SIM ? "adaptive" : SLIPPAGE_MODE;

  const USE_RPC_SIM = envBool("USE_RPC_SIM", false); // default OFF for real trades
  const USE_RAYDIUM_SWAP_SIM = envBool("USE_RAYDIUM_SWAP_SIM", false);

  const PHOENIX_SLIPPAGE_BPS = parseFloatEnv(process.env.PHOENIX_SLIPPAGE_BPS, Math.min(TRADE_THRESHOLD_BPS, MAX_SLIPPAGE_BPS));
  const CPMM_MAX_POOL_TRADE_FRAC = parseFloatEnv(process.env.CPMM_MAX_POOL_TRADE_FRAC, 0.05);
  const DYNAMIC_SLIPPAGE_EXTRA_BPS = parseFloatEnv(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS, 0.25);
  const LOG_SIM_FIELDS = parseBoolEnv(process.env.LOG_SIM_FIELDS, true);

  const ALLOW_SYNTH_TRADES = parseBoolEnv(process.env.ALLOW_SYNTH_TRADES, false);

  // Sim/submit/tips
  const RPC_SIM_CU_LIMIT = parseIntEnv(process.env.RPC_SIM_CU_LIMIT, 400_000);
  const RPC_SIM_CU_PRICE_MICROLAMPORTS = parseIntEnv(process.env.RPC_SIM_CU_PRICE_MICROLAMPORTS, 80);
  const SUBMIT_CU_LIMIT = parseIntEnv(process.env.SUBMIT_CU_LIMIT, 400_000);
  const SUBMIT_TIP_LAMPORTS = parseIntEnv(process.env.SUBMIT_TIP_LAMPORTS, 0);

  const TIP_MODE = (process.env.TIP_MODE?.toLowerCase() as "fixed" | "cu_price") || "cu_price";
  const TIP_MICROLAMPORTS_PER_CU = parseIntEnv(process.env.TIP_MICROLAMPORTS_PER_CU, RPC_SIM_CU_PRICE_MICROLAMPORTS);
  const TIP_MULTIPLIER = parseFloatEnv(process.env.TIP_MULTIPLIER, 1.2);
  const TIP_MAX_LAMPORTS = parseIntEnv(process.env.TIP_MAX_LAMPORTS, 2_000_000);

  // Wallet/mints/ATAs (optional; preflight computes if missing)
  const WALLET_PUBKEY = process.env.WALLET_PUBKEY?.trim();
  const USDC_MINT = process.env.USDC_MINT?.trim();
  const SOL_MINT = process.env.SOL_MINT?.trim();
  const USDC_ATA = process.env.USDC_ATA?.trim();
  const WSOL_ATA = process.env.WSOL_ATA?.trim();

  // Phoenix market id
  const PHOENIX_MARKET =
    process.env.PHOENIX_MARKET?.trim() ||
    process.env.PHOENIX_MARKET_ID?.trim() ||
    "";

  const MIN_SOL_BALANCE_LAMPORTS = parseIntEnv(process.env.MIN_SOL_BALANCE_LAMPORTS, 5_000_000);

  // runtime controls
  const ATOMIC_MODE = (process.env.ATOMIC_MODE as any) ?? "none";
  const RUN_FOR_MINUTES = parseIntEnv(process.env.RUN_FOR_MINUTES, 30, 1, 720); // default 30 min

  return {
    AMMS_JSONL,
    PHOENIX_JSONL,
    EDGE_MIN_ABS_BPS,
    EDGE_WAIT_LOG_MS,
    EDGE_FOLLOW_POLL_MS,
    BOOK_TTL_MS,
    SYNTH_WIDTH_BPS,
    DATA_DIR,
    PARAMS_DIR,
    AUTO_APPLY_PARAMS,
    PARAM_FILE,
    TRADE_THRESHOLD_BPS,
    MAX_SLIPPAGE_BPS,
    TRADE_SIZE_BASE,
    PHOENIX_TAKER_FEE_BPS,
    AMM_TAKER_FEE_BPS,
    FIXED_TX_COST_QUOTE,
    DECISION_DEDUPE_MS,
    DECISION_BUCKET_MS,
    DECISION_MIN_EDGE_DELTA_BPS,
    ENFORCE_DEDUPE,
    SLIPPAGE_MODE,
    USE_POOL_IMPACT_SIM,
    ACTIVE_SLIPPAGE_MODE,
    USE_RPC_SIM,
    USE_RAYDIUM_SWAP_SIM,
    PHOENIX_SLIPPAGE_BPS,
    CPMM_MAX_POOL_TRADE_FRAC,
    DYNAMIC_SLIPPAGE_EXTRA_BPS,
    LOG_SIM_FIELDS,
    ALLOW_SYNTH_TRADES,

    RPC_SIM_CU_LIMIT,
    RPC_SIM_CU_PRICE_MICROLAMPORTS,
    SUBMIT_CU_LIMIT,
    SUBMIT_TIP_LAMPORTS,

    TIP_MODE,
    TIP_MICROLAMPORTS_PER_CU,
    TIP_MULTIPLIER,
    TIP_MAX_LAMPORTS,

    WALLET_PUBKEY,
    USDC_MINT,
    SOL_MINT,
    USDC_ATA,
    WSOL_ATA,

    PHOENIX_MARKET,
    MIN_SOL_BALANCE_LAMPORTS,

    PHOENIX_DEPTH_ENABLED: parseBoolEnv(process.env.PHOENIX_DEPTH_ENABLED, false),
    PHOENIX_DEPTH_LEVELS: parseIntEnv(process.env.PHOENIX_DEPTH_LEVELS, 12, 1, 50),
    PHOENIX_DEPTH_EXTRA_BPS: parseFloatEnv(process.env.PHOENIX_DEPTH_EXTRA_BPS, 0.15),

    ATOMIC_MODE: ATOMIC_MODE as AppConfig["ATOMIC_MODE"],
    RUN_FOR_MINUTES,
  };
}
