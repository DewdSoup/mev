// services/arb-mm/src/provider/ws_markets.ts
// WS-first market snapshots for Raydium CPMM & Orca CLMM (free-tier friendly).
// - Subscribes only to the exact accounts listed in configs/pairs.json
// - Minimal bootstrap HTTP (one-time) for decimals, vaults & whirlpool orientation
// - Streams account changes via WS; decodes → joiner.upsertAmms(...)
// - Auto re-subscribe on WS resets (Helius inactivity); periodic freshness checks
//
// Requires: @orca-so/whirlpools-sdk, @solana/spl-token, bn.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    Connection,
    PublicKey,
    type Commitment, // <- type-only import for TS verbatimModuleSyntax
} from "@solana/web3.js";
import { AccountLayout, MintLayout } from "@solana/spl-token";
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { ParsableWhirlpool, PriceMath, ParsableTickArray } from "@orca-so/whirlpools-sdk";
import { PDAUtil, TickUtil } from "@orca-so/whirlpools-sdk";
import type { TickArrayData } from "@orca-so/whirlpools-sdk";
import BN from "bn.js";
import Decimal from "decimal.js";

import { logger } from "../ml_logger.js";
import type { EdgeJoiner } from "../edge/joiner.js";
import { cacheRaydiumFee, cacheOrcaFee } from "../util/fee_cache.js";

type VenueCfg = { kind: string; id: string; poolKind?: string; enabled?: boolean; feeBps?: number };
type PairCfg = {
    symbol: string;
    baseMint: string;
    quoteMint: string;
    phoenixMarket?: string;
    venues: VenueCfg[];
};
type PairsFile = { pairs: PairCfg[] };

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

const COMMITMENT: Commitment = "processed";
const WS_RETRY_MS = Math.max(1200, Number(process.env.WS_RECONNECT_MS ?? 2000));
const KEEPALIVE_MS = Math.max(60_000, Number(process.env.WS_KEEPALIVE_HEALTH_MS ?? 300_000));

// Freshness / TTLs
const AMM_TTL_MS = Number(process.env.BOOK_TTL_MS ?? 6000);              // joiner TTL (keep > decision TTL)
const ORCA_FORCE_POLL_MS = Math.max(900, Number(process.env.ORCA_FORCE_POLL_MS ?? 1200)); // force a refresh if no WS within this window
const ORCA_TICKARRAY_HORIZON = Math.max(1, Math.min(6, Number(process.env.ORCA_TICKARRAY_HORIZON ?? 2)));

function getenv(k: string) { const v = process.env[k]; return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function envTrue(k: string, d = false) {
    const v = String(process.env[k] ?? "").trim().toLowerCase();
    if (!v) return d;
    return v === "1" || v === "true" || v === "yes";
}

function slotFromContext(context: { slot?: number } | null | undefined, account?: { slot?: number } | null): number | undefined {
    const viaCtx = context?.slot;
    if (typeof viaCtx === "number" && Number.isFinite(viaCtx)) return Number(viaCtx);
    const viaAcc = account && typeof (account as any)?.slot === "number" ? (account as any).slot : undefined;
    if (typeof viaAcc === "number" && Number.isFinite(viaAcc)) return Number(viaAcc);
    return undefined;
}

// Cache: mint decimals
const mintDecimals = new Map<string, number>();
async function loadMintDecimals(http: Connection, mint: PublicKey): Promise<number> {
    const key = mint.toBase58();
    if (mintDecimals.has(key)) return mintDecimals.get(key)!;
    const info = await http.getAccountInfo(mint, COMMITMENT);
    if (!info?.data) throw new Error(`mint_missing_${key}`);
    const mintData = MintLayout.decode(info.data);
    const dec = Number(mintData.decimals);
    mintDecimals.set(key, dec);
    return dec;
}

function atomsToUi(atoms: bigint, decimals: number): number {
    const d = new Decimal(atoms.toString());
    const ten = new Decimal(10);
    return d.div(ten.pow(decimals)).toNumber();
}
function decodeSplAmount(data: Buffer): bigint {
    const acc = AccountLayout.decode(data);
    const arr = Uint8Array.from(acc.amount as unknown as Buffer);
    let x = 0n;
    for (let i = 0; i < 8; i++) x |= BigInt(arr[i]) << (8n * BigInt(i));
    return x;
}

// ────────────────────────────────────────────────────────────────────────────
// Raydium CPMM helpers
type RaydiumVaults = { baseVault: PublicKey; quoteVault: PublicKey; baseDecimals: number; quoteDecimals: number; feeBps: number };
async function getRaydiumVaultsAndDecimals(
    http: Connection,
    poolId: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    feeBpsHint?: number,
): Promise<RaydiumVaults> {
    const info = await http.getAccountInfo(poolId, COMMITMENT);
    if (!info?.data) throw new Error(`ray_pool_missing_${poolId.toBase58()}`);
    const s: any = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);
    const baseVault = new PublicKey(s.baseVault);
    const quoteVault = new PublicKey(s.quoteVault);
    const [baseDecimals, quoteDecimals] = await Promise.all([
        loadMintDecimals(http, baseMint),
        loadMintDecimals(http, quoteMint),
    ]);
    // CPmm fee: keep at 25bps unless you have dynamic config onchain
    const tradeFeeNum = Number(s.tradeFeeNumerator ?? s.swapFeeNumerator ?? s.fees?.tradeFeeNumerator ?? NaN);
    const tradeFeeDen = Number(s.tradeFeeDenominator ?? s.swapFeeDenominator ?? s.fees?.tradeFeeDenominator ?? NaN);
    let feeBps = Number.isFinite(tradeFeeNum) && Number.isFinite(tradeFeeDen) && tradeFeeDen > 0
        ? Math.round((tradeFeeNum / tradeFeeDen) * 10_000)
        : NaN;
    if (!Number.isFinite(feeBps) || feeBps <= 0) {
        feeBps = Number.isFinite(Number(feeBpsHint)) ? Number(feeBpsHint) :
            Number.isFinite(Number(process.env.RAYDIUM_TRADE_FEE_BPS)) ? Number(process.env.RAYDIUM_TRADE_FEE_BPS) :
            25;
    }
    return { baseVault, quoteVault, baseDecimals, quoteDecimals, feeBps };
}

// ────────────────────────────────────────────────────────────────────────────
// Orca Whirlpool helpers
type OrcaContext = {
    whirlpool: PublicKey;
    tokenMintA: PublicKey;
    tokenMintB: PublicKey;
    decA: number;
    decB: number;
    baseIsA: boolean;    // orientation vs (base, quote)
    feeBps: number;      // derived from whirlpool.feeRate / 100
    tickSpacing: number;
    programId: PublicKey;
};

type OrcaTickArrayState = {
    startTick: number;
    pubkey: PublicKey;
    subId: number;
    lastSlot?: number;
    data?: TickArrayData | null;
};

type OrcaPoolState = {
    ctx: OrcaContext;
    lastPushMs: number;
    activeTickIndex: number;
    tickArrays: Map<number, OrcaTickArrayState>;
};

async function loadOrcaContext(
    http: Connection,
    whirlpool: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    feeBpsHint?: number, // fallback only
): Promise<OrcaContext> {
    const acct = await http.getAccountInfo(whirlpool, COMMITMENT);
    if (!acct?.data) throw new Error(`orca_whirlpool_missing_${whirlpool.toBase58()}`);

    // Parse onchain whirlpool data (no extra RPCs). NOTE: 2-arg signature.
    const parsed: any = ParsableWhirlpool.parse(whirlpool, { ...acct, owner: acct.owner, data: acct.data });
    if (!parsed) throw new Error("orca_parse_failed");

    const tokenMintA = new PublicKey(parsed.tokenMintA);
    const tokenMintB = new PublicKey(parsed.tokenMintB);
    const [decA, decB] = await Promise.all([loadMintDecimals(http, tokenMintA), loadMintDecimals(http, tokenMintB)]);
    const baseIsA = tokenMintA.equals(baseMint);
    const tickSpacing = Number(parsed.tickSpacing ?? NaN);
    if (!Number.isFinite(tickSpacing) || tickSpacing <= 0) {
        throw new Error("orca_invalid_tick_spacing");
    }

    // Orca: feeRate is "hundredths of a basis point"
    // => 30 bps = 3000, 4 bps = 400, etc.
    const feeRateHundredths = Number(parsed.feeRate ?? NaN);
    const feeBps =
        Number.isFinite(feeRateHundredths) ? (feeRateHundredths / 100) :
            (Number.isFinite(Number(feeBpsHint)) ? Number(feeBpsHint) :
                Number.isFinite(Number(process.env.ORCA_TRADE_FEE_BPS)) ? Number(process.env.ORCA_TRADE_FEE_BPS) :
                    30);

    return {
        whirlpool,
        tokenMintA,
        tokenMintB,
        decA,
        decB,
        baseIsA,
        feeBps,
        tickSpacing,
        programId: acct.owner,
    };
}

function computeOrcaQuotePerBaseFromSqrt(
    sqrtPriceX64: BN,
    decA: number,
    decB: number,
    baseIsA: boolean
): number {
    // PriceMath returns tokenB per tokenA. When our BASE is mintA we want
    // tokenB/tokenA (i.e. QUOTE per BASE). When BASE is mintB we need the
    // inverse.
    const priceBoverA = PriceMath.sqrtPriceX64ToPrice(sqrtPriceX64, decA, decB);
    const p = Number(priceBoverA.toString());
    if (!Number.isFinite(p) || p <= 0) return NaN;
    return baseIsA ? p : 1 / p;
}

// ────────────────────────────────────────────────────────────────────────────

export async function startWsMarkets(args: {
    httpUrl?: string;
    wsUrl?: string;
    pairsPath?: string;
    joiner: EdgeJoiner;
}): Promise<{ close: () => Promise<void> }> {
    const httpUrl = args.httpUrl || getenv("RPC_URL") || getenv("HELIUS_HTTP")!;
    const wsUrl = args.wsUrl || getenv("RPC_WSS_URL") || getenv("WSS_URL") || getenv("WS_URL") || (httpUrl?.replace("https://", "wss://"))!;
    const pairsPath = args.pairsPath || getenv("PAIRS_JSON") || path.resolve(process.cwd(), "configs", "pairs.json");

    const http = new Connection(httpUrl, {
        commitment: COMMITMENT,
        disableRetryOnRateLimit: false,
    });
    const ws = new Connection(httpUrl, {
        commitment: COMMITMENT,
        wsEndpoint: wsUrl,
        disableRetryOnRateLimit: false,
    });

    const conf = JSON.parse(fs.readFileSync(pairsPath, "utf8")) as PairsFile;
    if (!conf?.pairs?.length) {
        logger.log("ws_provider_pairs_empty", { pairsPath });
        return {
            close: async () => {
                keepaliveTimer && clearInterval(keepaliveTimer);
                orcaTimer && clearInterval(orcaTimer);
            },
        };
    }

    // Track subs to rewire on close
    type Sub = { id: number; label: string; pk: PublicKey };
    const subs: Sub[] = [];
    const addSub = (id: number, label: string, pk: PublicKey) => subs.push({ id, label, pk });
    const clearSubs = async () => {
        await Promise.all(subs.map(s => ws.removeAccountChangeListener(s.id).catch(() => { })));
        subs.length = 0;
    };

    // Global slot heartbeat
    let lastObservedSlot = 0;
    ws.onSlotChange?.((s: any) => {
        if (s?.slot != null) lastObservedSlot = Math.max(lastObservedSlot, Number(s.slot));
    });

    // Keep-alive tick
    const keepaliveTimer = setInterval(() => { http.getSlot(COMMITMENT).catch(() => undefined); }, KEEPALIVE_MS);
    keepaliveTimer.unref?.();

    // ── Per-pool freshness state (for Orca forced refreshes)
    const orcaState = new Map<string, OrcaPoolState>();

    const ensureTickArrayLock = new Set<string>();

    async function subscribeTickArray(
        poolIdStr: string,
        poolKey: PublicKey,
        state: OrcaPoolState,
        startTick: number
    ) {
        const existing = state.tickArrays.get(startTick);
        if (existing && existing.subId !== -1) {
            return;
        }
        const pendingKey = `${poolIdStr}:${startTick}`;
        if (ensureTickArrayLock.has(pendingKey)) return;
        ensureTickArrayLock.add(pendingKey);
        try {
            const { publicKey } = PDAUtil.getTickArray(state.ctx.programId, poolKey, startTick);
            state.tickArrays.set(startTick, {
                startTick,
                pubkey: publicKey,
                subId: -1,
                data: existing?.data,
                lastSlot: existing?.lastSlot,
            });
            const subId = await ws.onAccountChange(publicKey, (acc, context) => {
                const entry = state.tickArrays.get(startTick);
                if (!entry) return;
                try {
                    const parsed = ParsableTickArray.parse(publicKey, acc as any);
                    entry.data = parsed;
                } catch (e) {
                    logger.log("orca_tick_array_parse_error", {
                        pool: poolIdStr,
                        start_tick: startTick,
                        err: String((e as any)?.message ?? e),
                    });
                }
                const slot = slotFromContext(context, acc as any);
                if (slot != null) {
                    entry.lastSlot = slot;
                    lastObservedSlot = Math.max(lastObservedSlot, slot);
                }
            });
            const entry = state.tickArrays.get(startTick);
            if (entry) {
                entry.subId = subId;
                entry.pubkey = publicKey;
            }
            logger.log("orca_tick_array_subscribed", { pool: poolIdStr, start_tick: startTick, pda: publicKey.toBase58() });
        } catch (e) {
            state.tickArrays.delete(startTick);
            logger.log("orca_tick_array_sub_error", {
                pool: poolIdStr,
                start_tick: startTick,
                err: String((e as any)?.message ?? e),
            });
        } finally {
            ensureTickArrayLock.delete(pendingKey);
        }
    }

    async function unsubscribeTickArray(state: OrcaPoolState, startTick: number) {
        const entry = state.tickArrays.get(startTick);
        if (!entry) return;
        state.tickArrays.delete(startTick);
        if (entry.subId >= 0) {
            try { await ws.removeAccountChangeListener(entry.subId); } catch { /* noop */ }
        }
        logger.log("orca_tick_array_unsubscribed", {
            pool: state.ctx.whirlpool.toBase58(),
            start_tick: startTick,
        });
    }

    async function ensureTickArrays(
        poolIdStr: string,
        poolKey: PublicKey,
        state: OrcaPoolState,
        tickIndex: number
    ) {
        if (!Number.isFinite(tickIndex)) return;
        const spacing = state.ctx.tickSpacing;
        const desired = new Set<number>();
        for (let offset = -ORCA_TICKARRAY_HORIZON; offset <= ORCA_TICKARRAY_HORIZON; offset += 1) {
            let startTick: number;
            try {
                startTick = TickUtil.getStartTickIndex(tickIndex, spacing, offset);
            } catch {
                continue;
            }
            if (desired.has(startTick)) continue;
            desired.add(startTick);
            if (!state.tickArrays.has(startTick)) {
                await subscribeTickArray(poolIdStr, poolKey, state, startTick);
            }
        }
        for (const startTick of [...state.tickArrays.keys()]) {
            if (!desired.has(startTick)) {
                void unsubscribeTickArray(state, startTick);
            }
        }
    }

    function latestTickArraySlot(state?: OrcaPoolState): number | undefined {
        if (!state) return undefined;
        let best = 0;
        for (const entry of state.tickArrays.values()) {
            if (entry.lastSlot && entry.lastSlot > best) best = entry.lastSlot;
        }
        return best > 0 ? best : undefined;
    }

    // Force-poll any Orca pool that hasn't had a WS tick within ORCA_FORCE_POLL_MS
    const orcaTimer = setInterval(async () => {
        const now = Date.now();
        for (const [poolKeyStr, state] of orcaState.entries()) {
            const { ctx, lastPushMs } = state;
            if (now - lastPushMs < ORCA_FORCE_POLL_MS) continue;
            try {
                const acc = await http.getAccountInfo(ctx.whirlpool, COMMITMENT);
                if (!acc?.data) continue;
                const parsed: any = ParsableWhirlpool.parse(ctx.whirlpool, { ...acc, owner: acc.owner, data: acc.data });
                const sqrtRaw = parsed?.sqrtPrice ?? 0;
                const sqrtBN = new BN(String(sqrtRaw));
                if (sqrtBN.isZero()) continue;

                const px = computeOrcaQuotePerBaseFromSqrt(sqrtBN, ctx.decA, ctx.decB, ctx.baseIsA);
                if (!Number.isFinite(px) || px <= 0) continue;

                const slotHintNum = Math.max(latestTickArraySlot(state) ?? 0, lastObservedSlot || 0);
                args.joiner.upsertAmms({
                    venue: "orca",
                    ammId: ctx.whirlpool.toBase58(),
                    px,
                    ts: now,
                    slot: slotHintNum > 0 ? slotHintNum : undefined,
                    feeBps: ctx.feeBps,
                    poolKind: "clmm",
                    baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                    quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                    source: "ws+poll",
                });
                state.lastPushMs = now;
                const tickIdx = Number(parsed?.tickCurrentIndex);
                if (Number.isFinite(tickIdx)) {
                    state.activeTickIndex = tickIdx;
                    await ensureTickArrays(poolKeyStr, ctx.whirlpool, state, tickIdx);
                }
                logger.log("orca_force_poll", {
                    pool: poolKeyStr,
                    waited_ms: now - lastPushMs,
                });
            } catch (e) {
                logger.log("orca_force_poll_error", { pool: poolKeyStr, err: String((e as any)?.message ?? e) });
            }
        }
    }, Math.min(ORCA_FORCE_POLL_MS, 2000));
    orcaTimer.unref?.();

    // Main wire function (idempotent)
    const wireAll = async () => {
        const pair = conf.pairs[0]; // your SOL/USDC pair
        const baseMint = new PublicKey(pair.baseMint);
        const quoteMint = new PublicKey(pair.quoteMint);

        for (const v of (pair.venues ?? [])) {
            if (v.enabled === false) continue;

            const kind = String(v.kind).toLowerCase();
            const poolId = new PublicKey(v.id);
            const feeBpsHint = Number.isFinite(Number(v.feeBps)) ? Number(v.feeBps) : undefined;

            // ── Raydium CPMM
            if (kind === "raydium" && (v.poolKind ?? "cpmm").toLowerCase() === "cpmm") {
                const meta = await getRaydiumVaultsAndDecimals(http, poolId, baseMint, quoteMint, feeBpsHint);
                cacheRaydiumFee(poolId, meta.feeBps);
                logger.log("fee_model_ray", {
                    pool: poolId.toBase58(),
                    fee_bps: meta.feeBps,
                    source: "onchain",
                });
                const state = { base: 0n, quote: 0n };

                const push = (now: number, slotOverride?: number) => {
                    if (state.base <= 0n || state.quote <= 0n) return;
                    const baseUi = atomsToUi(state.base, meta.baseDecimals);
                    const quoteUi = atomsToUi(state.quote, meta.quoteDecimals);
                    const px = quoteUi > 0 && baseUi > 0 ? (quoteUi / baseUi) : NaN;
                    if (!Number.isFinite(px) || !(px > 0)) return;
                    const slotResolved = Math.max(slotOverride ?? 0, lastObservedSlot || 0);
                    args.joiner.upsertAmms({
                        venue: "raydium",
                        ammId: poolId.toBase58(),
                        px,
                        ts: now,
                        slot: slotResolved > 0 ? slotResolved : undefined,
                        feeBps: meta.feeBps,
                        poolKind: "cpmm",
                        baseDecimals: meta.baseDecimals,
                        quoteDecimals: meta.quoteDecimals,
                        base_int: state.base.toString(),
                        quote_int: state.quote.toString(),
                        source: "ws",
                    });
                };

                // WS: vault balances (2-arg signature)
                const subBase = await ws.onAccountChange(meta.baseVault, (acc, context) => {
                    const slot = slotFromContext(context, acc as any);
                    if (slot != null) lastObservedSlot = Math.max(lastObservedSlot, slot);
                    try {
                        state.base = decodeSplAmount(acc.data);
                        push(Date.now(), slot);
                    } catch { }
                });
                addSub(subBase, "ray_base_vault", meta.baseVault);

                const subQuote = await ws.onAccountChange(meta.quoteVault, (acc, context) => {
                    const slot = slotFromContext(context, acc as any);
                    if (slot != null) lastObservedSlot = Math.max(lastObservedSlot, slot);
                    try {
                        state.quote = decodeSplAmount(acc.data);
                        push(Date.now(), slot);
                    } catch { }
                });
                addSub(subQuote, "ray_quote_vault", meta.quoteVault);

                // Prime via HTTP
                try {
                    const [bInfo, qInfo] = await Promise.all([
                        http.getAccountInfo(meta.baseVault, COMMITMENT),
                        http.getAccountInfo(meta.quoteVault, COMMITMENT),
                    ]);
                    if (bInfo?.data) state.base = decodeSplAmount(bInfo.data);
                    if (qInfo?.data) state.quote = decodeSplAmount(qInfo.data);
                    push(Date.now());
                } catch { }

                logger.log("ws_ray_cpmm_wired", {
                    pool: poolId.toBase58(),
                    base_vault: meta.baseVault.toBase58(),
                    quote_vault: meta.quoteVault.toBase58(),
                    fee_bps: meta.feeBps,
                });
            }

            // ── Orca CLMM (Whirlpool)
            if (kind === "orca" && (v.poolKind ?? "clmm").toLowerCase() === "clmm") {
                const ctx = await loadOrcaContext(http, poolId, baseMint, quoteMint, feeBpsHint);
                cacheOrcaFee(poolId, ctx.feeBps);
                logger.log("fee_model_orca", {
                    pool: poolId.toBase58(),
                    fee_bps: ctx.feeBps,
                    source: "onchain",
                });

                const poolKeyStr = poolId.toBase58();
                let poolState = orcaState.get(poolKeyStr);
                if (!poolState) {
                    poolState = {
                        ctx,
                        lastPushMs: 0,
                        activeTickIndex: 0,
                        tickArrays: new Map<number, OrcaTickArrayState>(),
                    };
                    orcaState.set(poolKeyStr, poolState);
                } else {
                    poolState.ctx = ctx;
                }

                // Prime once from HTTP
                try {
                    const prime = await http.getAccountInfo(poolId, COMMITMENT);
                    if (prime?.data) {
                        const parsed: any = ParsableWhirlpool.parse(poolId, { ...prime, owner: prime.owner, data: prime.data });
                        const sqrtRaw = parsed?.sqrtPrice ?? 0;
                        const sqrtBN = new BN(String(sqrtRaw));
                        if (!sqrtBN.isZero()) {
                            const px = computeOrcaQuotePerBaseFromSqrt(sqrtBN, ctx.decA, ctx.decB, ctx.baseIsA);
                            if (Number.isFinite(px) && px > 0) {
                                const now = Date.now();
                                const slotHintNum = Math.max(latestTickArraySlot(poolState) ?? 0, lastObservedSlot || 0);
                                args.joiner.upsertAmms({
                                    venue: "orca",
                                    ammId: poolId.toBase58(),
                                    px,
                                    ts: now,
                                    slot: slotHintNum > 0 ? slotHintNum : undefined,
                                    feeBps: ctx.feeBps,
                                    poolKind: "clmm",
                                    baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                                    quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                                    source: "prime",
                                });
                                poolState.lastPushMs = now;
                                const tickIdx = Number(parsed?.tickCurrentIndex);
                                if (Number.isFinite(tickIdx)) {
                                    poolState.activeTickIndex = tickIdx;
                                    await ensureTickArrays(poolKeyStr, poolId, poolState, tickIdx);
                                }
                            }
                        }
                    }
                } catch (e) {
                    logger.log("orca_prime_error", { pool: poolKeyStr, err: String((e as any)?.message ?? e) });
                }

                // WS: whirlpool account (2-arg signature)
                const subId = await ws.onAccountChange(poolId, (acc, context) => {
                    const slot = slotFromContext(context, acc as any);
                    if (slot != null) lastObservedSlot = Math.max(lastObservedSlot, slot);
                    try {
                        const parsed: any = ParsableWhirlpool.parse(poolId, { ...acc, owner: acc.owner, data: acc.data });
                        const sqrtRaw = parsed?.sqrtPrice ?? 0;
                        const sqrtBN = new BN(String(sqrtRaw));
                        if (sqrtBN.isZero()) return;

                        const px = computeOrcaQuotePerBaseFromSqrt(sqrtBN, ctx.decA, ctx.decB, ctx.baseIsA);
                        if (!Number.isFinite(px) || px <= 0) return;

                        const now = Date.now();
                        const state = orcaState.get(poolKeyStr);
                        const slotHintNum = Math.max(slot ?? 0, latestTickArraySlot(state) ?? 0, lastObservedSlot || 0);
                        args.joiner.upsertAmms({
                            venue: "orca",
                            ammId: poolId.toBase58(),
                            px,
                            ts: now,
                            slot: slotHintNum > 0 ? slotHintNum : undefined,
                            feeBps: ctx.feeBps,   // exact per-pool fee (feeRate/100)
                            poolKind: "clmm",
                            baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                            quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                            source: "ws",
                        });
                        if (state) {
                            state.lastPushMs = now;
                            const tickIdx = Number(parsed?.tickCurrentIndex);
                            if (Number.isFinite(tickIdx)) {
                                state.activeTickIndex = tickIdx;
                                void ensureTickArrays(poolKeyStr, poolId, state, tickIdx);
                            }
                        }
                    } catch (e) {
                        logger.log("orca_ws_decode_error", { pool: poolId.toBase58(), err: String((e as any)?.message ?? e) });
                    }
                });
                addSub(subId, "orca_whirlpool", poolId);

                logger.log("ws_orca_clmm_wired", {
                    pool: poolId.toBase58(),
                    tokenMintA: ctx.tokenMintA.toBase58(),
                    tokenMintB: ctx.tokenMintB.toBase58(),
                    base_is_A: ctx.baseIsA,
                    fee_bps: ctx.feeBps,
                });
            }
        }
    };

    // Rewire on open/close
    let reconnectTimer: NodeJS.Timeout | null = null;
    const onOpen = () => {
        logger.log("ws_open", { wsUrl });
    };
    const onClose = () => {
        logger.log("ws_closed", { wsUrl });
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try {
                await clearSubs();
                await wireAll();
            } catch (e) {
                logger.log("ws_rewire_error", { err: String((e as any)?.message ?? e) });
            }
        }, WS_RETRY_MS);
        reconnectTimer?.unref?.();
    };
    (ws as any)._rpcWebSocket?.on?.("open", onOpen);
    (ws as any)._rpcWebSocket?.on?.("close", onClose);

    await wireAll();
    logger.log("ws_provider_ready", { httpUrl, wsUrl, pairsPath });

    return {
        close: async () => {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            keepaliveTimer && clearInterval(keepaliveTimer);
            orcaTimer && clearInterval(orcaTimer);
            try { await clearSubs(); } catch { }
            for (const state of orcaState.values()) {
                for (const entry of state.tickArrays.values()) {
                    if (entry.subId >= 0) {
                        try { await ws.removeAccountChangeListener(entry.subId); } catch { }
                    }
                }
                state.tickArrays.clear();
            }
            orcaState.clear();
            try { (ws as any)._rpcWebSocket?.off?.("open", onOpen); } catch { }
            try { (ws as any)._rpcWebSocket?.off?.("close", onClose); } catch { }
        },
    };
}
