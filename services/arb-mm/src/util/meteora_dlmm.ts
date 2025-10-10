import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";

import MeteoraPkg from "@meteora-ag/dlmm";

import { rpcClient } from "@mev/rpc-facade";
import { logger } from "../ml_logger.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const DLMM_CLASS: any = (MeteoraPkg as any)?.default ?? (MeteoraPkg as any)?.DLMM ?? MeteoraPkg;

export const DLMM_STATE_REFRESH_MS = Math.max(500, Number(process.env.DLMM_STATE_REFRESH_MS ?? 2_000));
export const DLMM_STATE_MAX_AGE_MS = Math.max(DLMM_STATE_REFRESH_MS, Number(process.env.DLMM_STATE_MAX_AGE_MS ?? 5_000));
export const DLMM_BIN_ARRAY_HORIZON = Math.max(2, Math.min(6, Number(process.env.DLMM_BIN_ARRAY_HORIZON ?? 4)));
export const DLMM_BIN_ARRAY_CACHE_MS = Math.max(250, Number(process.env.DLMM_BIN_ARRAY_CACHE_MS ?? 1_500));
export const DLMM_BIN_ARRAY_MAX_AGE_MS = Math.max(DLMM_BIN_ARRAY_CACHE_MS, Number(process.env.DLMM_BIN_ARRAY_MAX_AGE_MS ?? 7_500));
export const DLMM_MIN_SLIPPAGE_BPS = Math.max(1, Number(process.env.DLMM_MIN_SLIPPAGE_BPS ?? 1));

const DLMM_BACKOFF_BASE_MS = Math.max(200, Number(process.env.DLMM_BACKOFF_BASE_MS ?? 500));
const DLMM_BACKOFF_MAX_MS = Math.max(DLMM_BACKOFF_BASE_MS, Number(process.env.DLMM_BACKOFF_MAX_MS ?? 10_000));
const DLMM_ERROR_LOG_THROTTLE_MS = Math.max(250, Number(process.env.DLMM_ERROR_LOG_THROTTLE_MS ?? 2_000));

interface DlmmPoolCache {
    instance: any;
    lastRefreshMs: number;
    lastSuccessMs: number;
    failureCount: number;
    cooldownUntil: number;
    lastError?: string;
    refreshing?: Promise<void>;
    binCache: Map<string, BinArrayCacheEntry>;
    binFailures: Map<string, BinFailureState>;
    binFetchInFlight: Map<string, Promise<BinFetchOutcome>>;
}

interface BinArrayCacheEntry {
    ts: number;
    binArrays: any[];
    staleReason?: string;
}

interface BinFailureState {
    failureCount: number;
    cooldownUntil: number;
    lastError?: string;
}

type BinFetchOutcome = { ok: true; binArrays: any[]; fetchedAt: number } | { ok: false; err: string };

interface ErrorState {
    lastLog: number;
    suppressed: number;
}

const poolCache = new Map<string, DlmmPoolCache>();
const mintDecimalsCache = new Map<string, number>();
const errorThrottle = new Map<string, ErrorState>();

function asConnection(conn?: Connection): Connection {
    return conn ?? rpcClient;
}

function safeLog(event: string, payload: Record<string, unknown>): void {
    try {
        logger.log(event, payload);
    } catch {
        /* logging best effort */
    }
}

function logThrottled(event: string, key: string, payload: Record<string, unknown>): void {
    const now = Date.now();
    const state = errorThrottle.get(key);
    if (!state) {
        errorThrottle.set(key, { lastLog: now, suppressed: 0 });
        safeLog(event, payload);
        return;
    }

    if (now - state.lastLog >= DLMM_ERROR_LOG_THROTTLE_MS) {
        const suppressed = state.suppressed;
        state.lastLog = now;
        state.suppressed = 0;
        safeLog(event, suppressed ? { ...payload, suppressed } : payload);
        return;
    }

    state.suppressed += 1;
}

function logRecovery(event: string, key: string, payload: Record<string, unknown>): void {
    const state = errorThrottle.get(key);
    if (!state) return;
    if (state.suppressed <= 0) {
        state.lastLog = Date.now();
        return;
    }
    const suppressed = state.suppressed;
    state.lastLog = Date.now();
    state.suppressed = 0;
    safeLog(event, { ...payload, suppressed });
}

function computeBackoff(failureCount: number): number {
    const exponent = Math.max(0, failureCount - 1);
    const delay = DLMM_BACKOFF_BASE_MS * Math.pow(2, exponent);
    return Math.min(delay, DLMM_BACKOFF_MAX_MS);
}

function binKey(swapForY: boolean, horizon: number): string {
    return `${swapForY ? "1" : "0"}:${Math.max(1, horizon)}`;
}

async function ensurePoolCache(poolId: string, connection?: Connection): Promise<DlmmPoolCache> {
    const existing = poolCache.get(poolId);
    if (existing) return existing;

    const conn = asConnection(connection);
    try {
        const instance = await DLMM_CLASS.create(conn, new PublicKey(poolId));
        const now = Date.now();
        const created: DlmmPoolCache = {
            instance,
            lastRefreshMs: now,
            lastSuccessMs: now,
            failureCount: 0,
            cooldownUntil: 0,
            binCache: new Map(),
            binFailures: new Map(),
            binFetchInFlight: new Map(),
        };
        poolCache.set(poolId, created);
        return created;
    } catch (err) {
        const msg = String((err as any)?.message ?? err);
        logThrottled("meteora_dlmm_instance_error", `instance:${poolId}`, { pool: poolId, err: msg });
        throw err;
    }
}

async function maybeRefetchInstance(poolId: string, cache: DlmmPoolCache): Promise<void> {
    const now = Date.now();
    if (now - cache.lastRefreshMs < DLMM_STATE_REFRESH_MS) return;
    cache.lastRefreshMs = now;

    if (now < cache.cooldownUntil) return;

    if (cache.refreshing) {
        try {
            await cache.refreshing;
        } catch {
            /* prior refresh errored, rely on cached state */
        }
        return;
    }

    cache.refreshing = (async () => {
        try {
            await cache.instance.refetchStates();
            cache.lastSuccessMs = Date.now();
            const prevFailures = cache.failureCount;
            cache.failureCount = 0;
            cache.cooldownUntil = 0;
            cache.lastError = undefined;
            if (prevFailures > 0) {
                logRecovery("meteora_dlmm_state_refresh_recovered", `state:${poolId}`, { pool: poolId });
            }
        } catch (err) {
            const msg = String((err as any)?.message ?? err);
            cache.failureCount += 1;
            cache.lastError = msg;
            const delay = computeBackoff(cache.failureCount);
            cache.cooldownUntil = Date.now() + delay;
            logThrottled("meteora_dlmm_state_refresh_error", `state:${poolId}`, {
                pool: poolId,
                err: msg,
                failure_count: cache.failureCount,
                cooldown_ms: delay,
            });
            throw err;
        } finally {
            cache.refreshing = undefined;
        }
    })();

    try {
        await cache.refreshing;
    } catch {
        /* swallow — state remains usable albeit stale */
    }
}

export function toPublicKeyLike(value: any): PublicKey {
    if (!value) throw new Error("meteora_missing_pubkey");
    if (value instanceof PublicKey) return value;
    if (typeof value === "string") return new PublicKey(value);
    if (typeof value?.toBase58 === "function") return new PublicKey(value.toBase58());
    return new PublicKey(value);
}

export interface DlmmPoolStateMeta {
    lastSuccessMs: number;
    stateAgeMs: number;
    fresh: boolean;
    cooldownMs: number;
    failureCount: number;
    lastError?: string;
}

export async function getDlmmInstance(poolId: string, connection?: Connection): Promise<any> {
    const cache = await ensurePoolCache(poolId, connection);
    await maybeRefetchInstance(poolId, cache);
    return cache.instance;
}

export function getDlmmPoolState(poolId: string): DlmmPoolStateMeta | undefined {
    const cache = poolCache.get(poolId);
    if (!cache) return undefined;
    const now = Date.now();
    const stateAgeMs = now - cache.lastSuccessMs;
    return {
        lastSuccessMs: cache.lastSuccessMs,
        stateAgeMs,
        fresh: stateAgeMs <= DLMM_STATE_MAX_AGE_MS,
        cooldownMs: Math.max(0, cache.cooldownUntil - now),
        failureCount: cache.failureCount,
        lastError: cache.lastError,
    };
}

export interface DlmmBinArrayParams {
    poolId: string;
    swapForY: boolean;
    horizon?: number;
    connection?: Connection;
    maxAgeMs?: number;
    staleToleranceMs?: number;
    allowStale?: boolean;
    allowRefresh?: boolean;
}

export type DlmmBinArrayResult = {
    ok: true;
    instance: any;
    binArrays: any[];
    fresh: boolean;
    ageMs: number;
    staleReason?: string;
    stateFresh: boolean;
    stateAgeMs: number;
    failureCount?: number;
};

export type DlmmBinArrayError = {
    ok: false;
    err: string;
    failureCount?: number;
    stateFresh?: boolean;
    stateAgeMs?: number;
};

export async function getDlmmBinArrays(params: DlmmBinArrayParams): Promise<DlmmBinArrayResult | DlmmBinArrayError> {
    const {
        poolId,
        swapForY,
        horizon = DLMM_BIN_ARRAY_HORIZON,
        connection,
        maxAgeMs = DLMM_BIN_ARRAY_CACHE_MS,
        staleToleranceMs = DLMM_BIN_ARRAY_MAX_AGE_MS,
        allowStale = true,
        allowRefresh = true,
    } = params;

    const cache = await ensurePoolCache(poolId, connection);
    await maybeRefetchInstance(poolId, cache);

    const requestStart = Date.now();
    const key = binKey(swapForY, horizon);
    const cached = cache.binCache.get(key);
    const ageMs = cached ? requestStart - cached.ts : Number.POSITIVE_INFINITY;

    if (cached && ageMs <= maxAgeMs) {
        cache.lastSuccessMs = requestStart;
        const stateFresh = true;
        cache.failureCount = 0;
        cache.cooldownUntil = 0;
        cache.lastError = undefined;
        cache.binFailures.delete(key);
        return {
            ok: true,
            instance: cache.instance,
            binArrays: cached.binArrays,
            fresh: true,
            ageMs,
            staleReason: cached.staleReason,
            stateFresh,
            stateAgeMs: 0,
        };
    }

    const failure = cache.binFailures.get(key);
    const blockedByCooldown = failure && requestStart < failure.cooldownUntil;

    let stateAgeMs = requestStart - cache.lastSuccessMs;
    let stateFresh = stateAgeMs <= DLMM_STATE_MAX_AGE_MS;

    if (!allowRefresh || blockedByCooldown) {
        if (cached && allowStale && ageMs <= staleToleranceMs) {
            return {
                ok: true,
                instance: cache.instance,
                binArrays: cached.binArrays,
                fresh: false,
                ageMs,
                staleReason: failure?.lastError ?? cached.staleReason ?? (blockedByCooldown ? "cooldown" : "stale"),
                stateFresh,
                stateAgeMs,
                failureCount: failure?.failureCount,
            };
        }

        return {
            ok: false,
            err: failure?.lastError ?? "dlmm_bin_fetch_blocked",
            failureCount: failure?.failureCount,
            stateFresh,
            stateAgeMs,
        };
    }

    const inFlight = cache.binFetchInFlight.get(key);
    if (inFlight) {
        const outcome = await inFlight;
        const resolvedNow = Date.now();
        if (outcome.ok) {
            const ts = outcome.fetchedAt;
            cache.binCache.set(key, { ts, binArrays: outcome.binArrays });
            cache.binFailures.delete(key);
            cache.lastSuccessMs = ts;
            cache.failureCount = 0;
            cache.cooldownUntil = 0;
            cache.lastError = undefined;
            logRecovery("meteora_dlmm_bin_fetch_recovered", `bin:${poolId}:${key}`, { pool: poolId, swap_for_y: swapForY });
            stateAgeMs = resolvedNow - cache.lastSuccessMs;
            stateFresh = stateAgeMs <= DLMM_STATE_MAX_AGE_MS;
            return {
                ok: true,
                instance: cache.instance,
                binArrays: outcome.binArrays,
                fresh: true,
                ageMs: resolvedNow - ts,
                stateFresh,
                stateAgeMs,
            };
        }

        const failureState = cache.binFailures.get(key) ?? { failureCount: 0, cooldownUntil: 0 } as BinFailureState;
        failureState.failureCount += 1;
        failureState.lastError = outcome.err;
        failureState.cooldownUntil = resolvedNow + computeBackoff(failureState.failureCount);
        cache.binFailures.set(key, failureState);
        cache.lastError = outcome.err;
        logThrottled("meteora_dlmm_fetch_failed", `bin:${poolId}:${key}`, {
            pool: poolId,
            swap_for_y: swapForY,
            horizon,
            err: outcome.err,
            failure_count: failureState.failureCount,
            cooldown_ms: Math.max(0, failureState.cooldownUntil - resolvedNow),
        });

        if (cached && allowStale && ageMs <= staleToleranceMs) {
            cached.staleReason = outcome.err;
            return {
                ok: true,
                instance: cache.instance,
                binArrays: cached.binArrays,
                fresh: false,
                ageMs: resolvedNow - cached.ts,
                staleReason: outcome.err,
                stateFresh,
                stateAgeMs,
                failureCount: failureState.failureCount,
            };
        }

        return {
            ok: false,
            err: outcome.err,
            failureCount: failureState.failureCount,
            stateFresh,
            stateAgeMs,
        };
    }

    const fetchPromise: Promise<BinFetchOutcome> = (async () => {
        try {
            const binArrays = await cache.instance.getBinArrayForSwap(swapForY, horizon);
            return { ok: true as const, binArrays, fetchedAt: Date.now() };
        } catch (err) {
            return { ok: false as const, err: String((err as any)?.message ?? err) };
        }
    })();

    cache.binFetchInFlight.set(key, fetchPromise);

    const outcome = await fetchPromise;
    const finishedNow = Date.now();
    if (cache.binFetchInFlight.get(key) === fetchPromise) {
        cache.binFetchInFlight.delete(key);
    }

    if (outcome.ok) {
        cache.binCache.set(key, { ts: outcome.fetchedAt, binArrays: outcome.binArrays });
        cache.binFailures.delete(key);
        cache.lastSuccessMs = outcome.fetchedAt;
        cache.failureCount = 0;
        cache.cooldownUntil = 0;
        cache.lastError = undefined;
        logRecovery("meteora_dlmm_bin_fetch_recovered", `bin:${poolId}:${key}`, { pool: poolId, swap_for_y: swapForY });
        stateAgeMs = finishedNow - cache.lastSuccessMs;
        stateFresh = stateAgeMs <= DLMM_STATE_MAX_AGE_MS;
        return {
            ok: true,
            instance: cache.instance,
            binArrays: outcome.binArrays,
            fresh: true,
            ageMs: finishedNow - outcome.fetchedAt,
            stateFresh,
            stateAgeMs,
        };
    }

    const failureState = cache.binFailures.get(key) ?? ({ failureCount: 0, cooldownUntil: 0 } as BinFailureState);
    failureState.failureCount += 1;
    failureState.lastError = outcome.err;
    failureState.cooldownUntil = finishedNow + computeBackoff(failureState.failureCount);
    cache.binFailures.set(key, failureState);
    cache.lastError = outcome.err;

    logThrottled("meteora_dlmm_fetch_failed", `bin:${poolId}:${key}`, {
        pool: poolId,
        swap_for_y: swapForY,
        horizon,
        err: outcome.err,
        failure_count: failureState.failureCount,
        cooldown_ms: Math.max(0, failureState.cooldownUntil - finishedNow),
    });

    if (cached && allowStale && ageMs <= staleToleranceMs) {
        cached.staleReason = outcome.err;
        return {
            ok: true,
            instance: cache.instance,
            binArrays: cached.binArrays,
            fresh: false,
            ageMs: finishedNow - cached.ts,
            staleReason: outcome.err,
            stateFresh,
            stateAgeMs,
            failureCount: failureState.failureCount,
        };
    }

    return {
        ok: false,
        err: outcome.err,
        failureCount: failureState.failureCount,
        stateFresh,
        stateAgeMs,
    };
}

export async function getMintDecimals(mint: PublicKey, connection?: Connection): Promise<number> {
    const key = mint.toBase58();
    const cached = mintDecimalsCache.get(key);
    if (cached != null) return cached;
    const conn = asConnection(connection);
    const info = await conn.getParsedAccountInfo(mint, "processed");
    const decimals = Number((info.value as any)?.data?.parsed?.info?.decimals ?? 9);
    mintDecimalsCache.set(key, decimals);
    return decimals;
}

export function uiToBn(amount: number, decimals: number): BN {
    const dec = new Decimal(amount);
    if (!dec.isFinite() || dec.lte(0)) return new BN(0);
    const atoms = dec.mul(new Decimal(10).pow(decimals)).floor();
    return new BN(atoms.toFixed(0));
}

export function atomsToDecimal(amount: BN, decimals: number): Decimal {
    if (!amount) return new Decimal(0);
    return new Decimal(amount.toString()).div(new Decimal(10).pow(decimals));
}
