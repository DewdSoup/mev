import { Connection, PublicKey } from "@solana/web3.js";
import type { LiquidityPoolKeys } from "@raydium-io/raydium-sdk";
import { ParsableWhirlpool } from "@orca-so/whirlpools-sdk";

import { derivePoolKeysFromOnchain, resolveRaydiumFeeBpsCached } from "./raydium.js";
import { getPhoenixTakerFeeBps } from "./phoenix.js";

const DEFAULT_RAY_FALLBACK = Number.isFinite(Number(process.env.RAYDIUM_TRADE_FEE_BPS))
  ? Number(process.env.RAYDIUM_TRADE_FEE_BPS)
  : 25;
const DEFAULT_ORCA_FALLBACK = Number.isFinite(Number(process.env.ORCA_TRADE_FEE_BPS))
  ? Number(process.env.ORCA_TRADE_FEE_BPS)
  : 30;
const DEFAULT_PHX_FALLBACK = Number.isFinite(Number(process.env.PHOENIX_TAKER_FEE_BPS))
  ? Number(process.env.PHOENIX_TAKER_FEE_BPS)
  : 2;

const FEE_CACHE_TTL_MS = Math.max(60_000, Number(process.env.FEE_CACHE_TTL_MS ?? 900_000));

type FeeEntry = { bps: number; ts: number };

function keyOf(id: string | PublicKey): string {
  return typeof id === "string" ? id : id.toBase58();
}

function isFresh(entry?: FeeEntry | null): entry is FeeEntry {
  return !!entry && Number.isFinite(entry.bps) && Date.now() - entry.ts < FEE_CACHE_TTL_MS;
}

function remember(map: Map<string, FeeEntry>, id: string | PublicKey, feeBps: number) {
  if (!Number.isFinite(feeBps) || feeBps <= 0) return;
  map.set(keyOf(id), { bps: feeBps, ts: Date.now() });
}

const rayCache = new Map<string, FeeEntry>();
const rayInflight = new Map<string, Promise<number>>();

const orcaCache = new Map<string, FeeEntry>();
const orcaInflight = new Map<string, Promise<number>>();

const phxCache = new Map<string, FeeEntry>();
const phxInflight = new Map<string, Promise<number>>();
const lifinityCache = new Map<string, FeeEntry>();

export function cacheRaydiumFee(id: string | PublicKey, feeBps: number): void {
  remember(rayCache, id, feeBps);
}

export function cacheOrcaFee(id: string | PublicKey, feeBps: number): void {
  remember(orcaCache, id, feeBps);
}

export function cachePhoenixFee(id: string | PublicKey, feeBps: number): void {
  remember(phxCache, id, feeBps);
}

export function cacheLifinityFee(id: string | PublicKey, feeBps: number): void {
  remember(lifinityCache, id, feeBps);
}

export function getCachedRaydiumFee(id: string | PublicKey): number | null {
  const cached = rayCache.get(keyOf(id));
  return isFresh(cached) ? cached.bps : null;
}

export function getCachedOrcaFee(id: string | PublicKey): number | null {
  const cached = orcaCache.get(keyOf(id));
  return isFresh(cached) ? cached.bps : null;
}

export function getCachedPhoenixFee(id: string | PublicKey): number | null {
  const cached = phxCache.get(keyOf(id));
  return isFresh(cached) ? cached.bps : null;
}

export function getCachedLifinityFee(id: string | PublicKey): number | null {
  const cached = lifinityCache.get(keyOf(id));
  return isFresh(cached) ? cached.bps : null;
}

export async function ensureRaydiumFee(
  conn: Connection,
  pool: string | PublicKey,
  fallbackBps = DEFAULT_RAY_FALLBACK
): Promise<number> {
  const key = keyOf(pool);
  const cached = rayCache.get(key);
  if (isFresh(cached)) return cached.bps;

  const inflight = rayInflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    let fee = fallbackBps;
    try {
      const poolId = typeof pool === "string" ? new PublicKey(pool) : pool;
      const poolKeys: LiquidityPoolKeys = await derivePoolKeysFromOnchain(conn, poolId);
      fee = await resolveRaydiumFeeBpsCached(conn, poolKeys, fallbackBps);
    } catch {
      const fallbackCached = rayCache.get(key);
      if (fallbackCached?.bps != null && Number.isFinite(fallbackCached.bps)) {
        fee = fallbackCached.bps;
      }
    }
    remember(rayCache, key, fee);
    return fee;
  })().finally(() => rayInflight.delete(key));

  rayInflight.set(key, task);
  return task;
}

export async function ensureOrcaFee(
  conn: Connection,
  pool: string | PublicKey,
  fallbackBps = DEFAULT_ORCA_FALLBACK
): Promise<number> {
  const key = keyOf(pool);
  const cached = orcaCache.get(key);
  if (isFresh(cached)) return cached.bps;

  const inflight = orcaInflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    let fee = fallbackBps;
    try {
      const poolPk = typeof pool === "string" ? new PublicKey(pool) : pool;
      const info = await conn.getAccountInfo(poolPk, "processed");
      if (info?.data) {
        const parsed: any = ParsableWhirlpool.parse(poolPk, { ...info, owner: info.owner, data: info.data });
        const feeRateHundredths = Number(parsed?.feeRate ?? NaN);
        if (Number.isFinite(feeRateHundredths)) fee = feeRateHundredths / 100;
      }
    } catch {
      const fallbackCached = orcaCache.get(key);
      if (fallbackCached?.bps != null && Number.isFinite(fallbackCached.bps)) {
        fee = fallbackCached.bps;
      }
    }
    remember(orcaCache, key, fee);
    return fee;
  })().finally(() => orcaInflight.delete(key));

  orcaInflight.set(key, task);
  return task;
}

export async function ensurePhoenixFee(
  conn: Connection,
  market: string | PublicKey,
  fallbackBps = DEFAULT_PHX_FALLBACK
): Promise<number> {
  const key = keyOf(market);
  const cached = phxCache.get(key);
  if (isFresh(cached)) return cached.bps;

  const inflight = phxInflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    let fee = fallbackBps;
    try {
      const fetched = await getPhoenixTakerFeeBps(conn, market);
      if (Number.isFinite(fetched) && fetched != null) fee = fetched;
    } catch {
      const fallbackCached = phxCache.get(key);
      if (fallbackCached?.bps != null && Number.isFinite(fallbackCached.bps)) {
        fee = fallbackCached.bps;
      }
    }
    remember(phxCache, key, fee);
    return fee;
  })().finally(() => phxInflight.delete(key));

  phxInflight.set(key, task);
  return task;
}
