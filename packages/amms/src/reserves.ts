// packages/amms/src/reserves.ts
// Raydium CPMM on-chain reader: decode pool account once, then poll vault balances.
// Helius-first RPC, masked in logs. Supports multi-market via configs/markets.json
// while preserving env-first single-market behavior.

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { logger } from "@mev/storage";

// ── Load root .env ──────────────────────────────────────────────────────────
function loadRootEnv() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(process.cwd(), "..", "..", "..", ".env"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      return;
    }
  }
  dotenv.config();
}
loadRootEnv();

// ── Utils ───────────────────────────────────────────────────────────────────
function parseMsEnv(v: string | undefined, def = 2000, min = 200, max = 60000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "***");
    return url.toString();
  } catch {
    return u;
  }
}
function resolveRpc(): string {
  const primary = process.env.RPC_PRIMARY?.trim();
  if (primary) return primary;
  const heliusKey = process.env.HELIUS_API_KEY?.trim();
  if (heliusKey) return `https://rpc.helius.xyz/?api-key=${heliusKey}`;
  return clusterApiUrl("mainnet-beta");
}
const RPC = resolveRpc();
const TICK_MS = parseMsEnv(process.env.AMMS_TICK_MS, 2000, 200, 60000);

// Optional: seed file fallback if present and not placeholder
function tryLoadSeedPoolId(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "configs/raydium.pools.json"),
    path.resolve(process.cwd(), "..", "..", "configs", "raydium.pools.json"),
    path.resolve(process.cwd(), "..", "..", "..", "packages", "amms", "configs", "raydium.pools.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const arr = JSON.parse(fs.readFileSync(p, "utf8")) as any[];
      const hit = arr?.find?.((x) => (x?.symbol ?? "").startsWith("SOL/USDC")) || arr?.[0];
      const ammId = String(hit?.ammId ?? "");
      if (ammId && ammId !== "11111111111111111111111111111111") return ammId;
    } catch { /* ignore */ }
  }
  return null;
}

// ── Multi-market config (env-first) ─────────────────────────────────────────
type MarketCfg = {
  symbol: string;
  raydium?: { ammId: string; baseDecimals?: number; quoteDecimals?: number };
};

function loadMarketsConfig(): MarketCfg[] | null {
  const candidates = [
    path.resolve(process.cwd(), "configs/markets.json"),
    path.resolve(process.cwd(), "..", "..", "configs", "markets.json"),
    path.resolve(process.cwd(), "..", "..", "..", "configs", "markets.json"),
    path.resolve(process.cwd(), "..", "..", "..", "packages", "amms", "configs", "markets.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const arr = JSON.parse(fs.readFileSync(p, "utf8")) as MarketCfg[];
      if (Array.isArray(arr) && arr.length) return arr;
    } catch { /* ignore */ }
  }
  return null;
}

// ── Types & math ────────────────────────────────────────────────────────────
type ResolvedPool = {
  ammId: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  baseMint: PublicKey;
  quoteMint: PublicKey;
};

function pow10n(exp: number): bigint {
  if (exp <= 0) return 1n;
  return 10n ** BigInt(exp);
}
function toBigIntSafe(s: string | number | bigint): bigint {
  if (typeof s === "bigint") return s;
  if (typeof s === "number") return BigInt(Math.trunc(s));
  return BigInt(s);
}
function computePx(
  baseAmount: bigint,
  quoteAmount: bigint,
  baseDecimals: number,
  quoteDecimals: number
): { px: number; px_str: string } {
  if (baseAmount <= 0n) return { px: 0, px_str: "0.000000000" };
  // price = (quote/base) * 10^(baseDecimals - quoteDecimals)
  const scale9 = 1_000_000_000n;
  const num = quoteAmount * pow10n(baseDecimals) * scale9;
  const den = baseAmount * pow10n(quoteDecimals);
  const qInt = num / den; // integer in 1e9 scale
  const px = Number(qInt) / 1e9;
  return { px, px_str: px.toFixed(9) };
}

// ── On-chain decode ─────────────────────────────────────────────────────────
async function resolvePoolOnChain(conn: Connection, poolId: PublicKey): Promise<ResolvedPool | null> {
  const info = await conn.getAccountInfo(poolId, "processed");
  if (!info) return null;

  const state: any = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);

  const baseVault = new PublicKey(state.baseVault);
  const quoteVault = new PublicKey(state.quoteVault);
  const baseMint = new PublicKey(state.baseMint);
  const quoteMint = new PublicKey(state.quoteMint);

  const baseDecimals: number =
    typeof state.baseDecimal === "number" ? state.baseDecimal : state.baseDecimal?.toNumber?.() ?? 0;
  const quoteDecimals: number =
    typeof state.quoteDecimal === "number" ? state.quoteDecimal : state.quoteDecimal?.toNumber?.() ?? 0;

  if (!baseDecimals || !quoteDecimals) return null;

  return { ammId: poolId, baseVault, quoteVault, baseMint, quoteMint, baseDecimals, quoteDecimals };
}

async function getVaultAmount(conn: Connection, vault: PublicKey): Promise<bigint> {
  const bal = await conn.getTokenAccountBalance(vault, "processed");
  return toBigIntSafe(bal?.value?.amount ?? "0");
}

// ── Single-market runner (used for env-first and for each market in config) ─
async function runOne(conn: Connection, symbol: string, poolIdStr: string) {
  const poolPk = new PublicKey(poolIdStr);
  const resolvedMaybe = await resolvePoolOnChain(conn, poolPk);
  if (resolvedMaybe === null) {
    logger.log("amms_error", {
      reason: "decode_failed",
      hint: "Pool account not found or unexpected layout. Check RAYDIUM pool id.",
      pool: poolIdStr,
      symbol,
    });
    return;
  }

  const POOL_AMM_ID = resolvedMaybe.ammId;
  const BASE_VAULT = resolvedMaybe.baseVault;
  const QUOTE_VAULT = resolvedMaybe.quoteVault;
  const BASE_DECIMALS = resolvedMaybe.baseDecimals;
  const QUOTE_DECIMALS = resolvedMaybe.quoteDecimals;

  logger.log("amms_market_match", { name: `${symbol} (Raydium CPMM)`, pool: POOL_AMM_ID.toBase58() });

  async function tick() {
    try {
      const [baseAmt, quoteAmt] = await Promise.all([
        getVaultAmount(conn, BASE_VAULT),
        getVaultAmount(conn, QUOTE_VAULT),
      ]);
      const { px, px_str } = computePx(baseAmt, quoteAmt, BASE_DECIMALS, QUOTE_DECIMALS);

      logger.log("amms_price", {
        ts: Date.now(),                    // ← timestamp for backtest
        symbol,
        ammId: POOL_AMM_ID.toBase58(),
        baseDecimals: BASE_DECIMALS,
        quoteDecimals: QUOTE_DECIMALS,
        px,
        px_str,
        base_int: baseAmt.toString(),
        quote_int: quoteAmt.toString(),
        tick_ms: TICK_MS,
      });
    } catch (e) {
      logger.log("amms_warn", { stage: "vault_read", err: String(e), tick_ms: TICK_MS, symbol });
    }
  }

  await tick();
  setInterval(tick, TICK_MS);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  logger.log("amms_boot", { rpc: maskUrl(RPC) });
  const conn = new Connection(RPC, { commitment: "processed" });

  // ENV-FIRST: explicit single pool
  const envPool = process.env.RAYDIUM_POOL_ID_SOL_USDC?.trim();
  if (envPool) {
    logger.log("amms_pools_loaded", { count: 1, fromLocal: false, via: "env" });
    await runOne(conn, "SOL/USDC", envPool);
    // keep process alive
    setInterval(() => {}, 1 << 30);
    return;
  }

  // CONFIG: multi-market
  const cfg = loadMarketsConfig();
  if (cfg && cfg.length) {
    const markets = cfg.filter(m => m.raydium?.ammId).map(m => ({ symbol: m.symbol, ammId: m.raydium!.ammId }));
    if (markets.length) {
      logger.log("amms_pools_loaded", { count: markets.length, fromLocal: true, via: "configs/markets.json" });
      for (const m of markets) runOne(conn, m.symbol, m.ammId).catch((e) => logger.log("amms_fatal_market", { symbol: m.symbol, err: String(e) }));
      setInterval(() => {}, 1 << 30);
      return;
    }
  }

  // Seed file fallback (legacy)
  const seedPool = tryLoadSeedPoolId();
  const poolIdStr = seedPool ?? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
  logger.log("amms_pools_loaded", { count: 1, fromLocal: !!seedPool, via: seedPool ? "raydium.pools.json" : "default" });
  await runOne(conn, "SOL/USDC", poolIdStr);

  // keep process alive for the dev runner
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => logger.log("amms_fatal", { err: String(e) }));
