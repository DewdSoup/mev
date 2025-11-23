// services/arb-mm/src/provider/ws_markets.ts
// WS-first market snapshots for Raydium CPMM, Orca CLMM, and Meteora DLMM.
// - Subscribes only to the exact accounts listed in configs/pairs.json
// - Minimal bootstrap HTTP (one-time) for decimals, vaults & orientation
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
import {
    createProgram as createMeteoraProgram,
    decodeAccount as decodeMeteoraAccount,
    getPriceOfBinByBinId,
} from "@meteora-ag/dlmm";
import type { TickArrayData } from "@orca-so/whirlpools-sdk";
import BN from "bn.js";
import Decimal from "decimal.js";

import { logger } from "../ml_logger.js";
import type { EdgeJoiner } from "../edge/joiner.js";
import type { MarketStateProvider } from "../market/provider.js";
import { cacheRaydiumFee, cacheOrcaFee, cacheLifinityFee } from "../util/fee_cache.js";
import {
    loadLifinityPoolMeta,
    refreshLifinitySnapshot,
    toUi as lifinityAtomsToUi,
    lifinityQuoteFromSnapshot,
} from "../util/lifinity.js";
import { recordHeartbeatMetric } from "../runtime/metrics.js";

type VenueCfg = {
    kind: string;
    id: string;
    venue?: string;
    poolKind?: string;
    enabled?: boolean;
    feeBps?: number;
    baseDecimals?: number;
    quoteDecimals?: number;
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
type PairsFile = { pairs: PairCfg[] };

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

const COMMITMENT: Commitment = "processed";
const WS_RETRY_MS = Math.max(1200, Number(process.env.WS_RECONNECT_MS ?? 2000));
const KEEPALIVE_MS = Math.max(60_000, Number(process.env.WS_KEEPALIVE_HEALTH_MS ?? 300_000));

// Freshness / TTLs
const AMM_TTL_MS = Number(process.env.BOOK_TTL_MS ?? 6000);              // joiner TTL (keep > decision TTL)
const ORCA_FORCE_POLL_MS = Math.max(1_500, Number(process.env.ORCA_FORCE_POLL_MS ?? 4_500)); // force a refresh if no WS within this window, keep < snapshot TTL
const METEORA_HEARTBEAT_MS = Math.max(1_000, Number(process.env.METEORA_HEARTBEAT_MS ?? 4_000)); // refresh quiescent pools before joiner TTL
const METEORA_HEARTBEAT_LOG_MS = Math.max(5_000, Number(process.env.METEORA_HEARTBEAT_LOG_MS ?? 30_000));
const RAYDIUM_HEARTBEAT_MS = Math.max(1_000, Number(process.env.RAYDIUM_HEARTBEAT_MS ?? 2_000));
const RAYDIUM_HEARTBEAT_LOG_MS = Math.max(5_000, Number(process.env.RAYDIUM_HEARTBEAT_LOG_MS ?? 30_000));
const ORCA_TICKARRAY_HORIZON = Math.max(1, Math.min(6, Number(process.env.ORCA_TICKARRAY_HORIZON ?? 2)));
const LIFINITY_HEARTBEAT_MS = Math.max(1_000, Number(process.env.LIFINITY_HEARTBEAT_MS ?? 3_000));
const LIFINITY_HEARTBEAT_LOG_MS = Math.max(5_000, Number(process.env.LIFINITY_HEARTBEAT_LOG_MS ?? 20_000));

function getenv(k: string) { const v = process.env[k]; return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function httpToWs(url?: string): string | undefined {
    if (!url) return undefined;
    if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
    if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
    return url;
}
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
    const raw = acc.amount as unknown;

    if (typeof raw === "bigint") {
        return raw;
    }

    if (BN.isBN(raw)) {
        return BigInt((raw as BN).toString(10));
    }

    if (typeof raw === "number") {
        return BigInt(raw);
    }

    if (typeof raw === "string") {
        return BigInt(raw);
    }

    if (raw && typeof raw === "object" && typeof (raw as { length?: number }).length === "number") {
        const view = Uint8Array.from(raw as any);
        if (view.length === 0) return 0n;
        let x = 0n;
        for (let i = 0; i < view.length; i++) {
            const value = view[i] ?? 0;
            x |= BigInt(value) << (8n * BigInt(i));
        }
        return x;
    }

    throw new Error("spl_amount_decode_unsupported");
}

type NormalizedPoolSpec = {
    poolId: PublicKey;
    poolIdStr: string;
    venue: string;
    poolKind: string;
    feeBps?: number;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    symbol: string;
    freshness?: VenueCfg["freshness"];
    baseDecimalsHint?: number;
    quoteDecimalsHint?: number;
};

type MeteoraPoolState = {
    poolId: PublicKey;
    poolIdStr: string;
    symbol: string;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseDecimals: number;
    quoteDecimals: number;
    baseIsX: boolean;
    feeBps: number;
    reserveX: PublicKey;
    reserveY: PublicKey;
    reserveXSubId?: number;
    reserveYSubId?: number;
    reserveXTarget?: string;
    reserveYTarget?: string;
    stateSubId?: number;
    reserveXAtoms?: bigint;
    reserveYAtoms?: bigint;
    binStep: number;
    activeId: number;
    lastPushMs: number;
    lastSlotHint?: number;
    lastHeartbeatLogMs?: number;
    lastHeartbeatMs?: number;
    lastHeartbeatSlot?: number;
    lastHeartbeatSynthetic?: boolean;
    heartbeatConsecutiveMisses?: number;
    lastWsSlot?: number;
    lastWsMs?: number;
    lastPushSlot?: number;
    lastPushSynthetic?: boolean;
    tradeableWhenDegradedPreferred?: boolean;
    heartbeatGraceMs?: number;
};

type RaydiumPoolState = {
    poolId: PublicKey;
    poolIdStr: string;
    baseVault: PublicKey;
    quoteVault: PublicKey;
    baseDecimals: number;
    quoteDecimals: number;
    feeBps: number;
    base: bigint;
    quote: bigint;
    lastPushMs: number;
    lastSlotHint?: number;
    lastWsSlot?: number;
    lastWsMs?: number;
    lastHeartbeatMs?: number;
    tradeableWhenDegradedPreferred?: boolean;
    heartbeatGraceMs?: number;
};

type LifinityPoolState = {
    poolId: PublicKey;
    poolIdStr: string;
    meta: Awaited<ReturnType<typeof loadLifinityPoolMeta>>;
    baseReserve: bigint;
    quoteReserve: bigint;
    lastPushMs: number;
    lastSlotHint?: number;
    lastWsSlot?: number;
    lastWsMs?: number;
    lastHeartbeatMs?: number;
    lastHeartbeatLogMs?: number;
    tradeableWhenDegradedPreferred?: boolean;
    heartbeatGraceMs?: number;
    baseDecimalsHint?: number;
    quoteDecimalsHint?: number;
};

function collectPoolSpecs(conf: PairsFile): NormalizedPoolSpec[] {
    const out: NormalizedPoolSpec[] = [];
    const seen = new Set<string>();

    for (const pair of conf.pairs ?? []) {
        const baseMintStr = pair.baseMint?.trim();
        const quoteMintStr = pair.quoteMint?.trim();
        if (!baseMintStr || !quoteMintStr) continue;

        let baseMintPk: PublicKey;
        let quoteMintPk: PublicKey;
        try {
            baseMintPk = new PublicKey(baseMintStr);
            quoteMintPk = new PublicKey(quoteMintStr);
        } catch {
            continue;
        }

        for (const venue of pair.venues ?? []) {
            if (!venue || venue.enabled === false) continue;
            const vAny = venue as any;
            const venueName = String((vAny.kind ?? vAny.venue ?? "")).toLowerCase();
            if (!venueName || venueName === "phoenix") continue;

            const poolIdStr = String(venue.id ?? vAny.poolId ?? "").trim();
            if (!poolIdStr) continue;

            const key = `${venueName}:${poolIdStr}`;
            if (seen.has(key)) continue;

            const poolKindRaw = String(vAny.poolKind ?? vAny.pool_kind ?? "").trim().toLowerCase();
            const inferredKind = poolKindRaw || (venueName === "raydium" ? "cpmm"
                : venueName === "orca" ? "clmm"
                : venueName === "meteora" ? "dlmm"
                : "");
            if (!inferredKind) continue;

            let poolPk: PublicKey;
            try {
                poolPk = new PublicKey(poolIdStr);
            } catch {
                continue;
            }

            const feeBps = typeof venue.feeBps === "number" ? venue.feeBps : undefined;
            const baseDecimalsHint = Number.isFinite(Number((venue as any)?.baseDecimals))
                ? Number((venue as any).baseDecimals)
                : undefined;
            const quoteDecimalsHint = Number.isFinite(Number((venue as any)?.quoteDecimals))
                ? Number((venue as any).quoteDecimals)
                : undefined;

            out.push({
                poolId: poolPk,
                poolIdStr,
                venue: venueName,
                poolKind: inferredKind,
                feeBps,
                baseMint: baseMintPk,
                quoteMint: quoteMintPk,
                symbol: pair.symbol ?? `${baseMintStr}/${quoteMintStr}`,
                freshness: venue.freshness,
                baseDecimalsHint,
                quoteDecimalsHint,
            });
            seen.add(key);
        }
    }

    return out;
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
    lastSlotHint?: number;
    lastWsSlot?: number;
    lastWsMs?: number;
    lastHeartbeatMs?: number;
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
    provider?: MarketStateProvider | null;
}): Promise<{ close: () => Promise<void> }> {
    const httpUrl = args.httpUrl || getenv("RPC_URL") || getenv("HELIUS_HTTP")!;
    const wsUrl =
        args.wsUrl ||
            getenv("RPC_WSS_URL") ||
            getenv("WS_URL") ||
            getenv("WSS_URL") ||
            getenv("RPC_WSS_FALLBACK") ||
            getenv("WS_FALLBACK") ||
            httpToWs(httpUrl)!;
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
    const wsEndpointLabel = (() => {
        const lower = String(wsUrl ?? "").toLowerCase();
        if (!lower) return "unknown";
        if (lower.includes("localhost") || lower.includes("127.0.0.1")) return "local";
        if (lower.includes("helius")) return "helius";
        return "custom";
    })();

    const conf = JSON.parse(fs.readFileSync(pairsPath, "utf8")) as PairsFile;
    if (!conf?.pairs?.length) {
        logger.log("ws_provider_pairs_empty", { pairsPath });
        return {
            close: async () => {
                keepaliveTimer && clearInterval(keepaliveTimer);
                orcaTimer && clearInterval(orcaTimer);
                meteoraTimer && clearInterval(meteoraTimer);
            },
        };
    }

    // Track subs to rewire on close
    type Sub = { id: number; label: string; pk: PublicKey; venue?: string; marketOrPoolKey?: string };
    const subs: Sub[] = [];
    const logWsSubscription = (venue: string, marketOrPoolKey: string, label?: string) => {
        logger.log("ws_subscription", {
            type: "ws_subscription",
            source: "ws_markets",
            venue,
            marketOrPoolKey,
            ws_url: wsUrl,
            label,
            event: "subscribe",
            ts: Date.now(),
        });
    };
    const addSub = (id: number, label: string, pk: PublicKey, meta?: { venue?: string; marketOrPoolKey?: string }) => {
        const entry: Sub = { id, label, pk, venue: meta?.venue, marketOrPoolKey: meta?.marketOrPoolKey };
        subs.push(entry);
        if (meta?.venue || meta?.marketOrPoolKey) {
            logWsSubscription(meta.venue ?? "unknown", meta.marketOrPoolKey ?? pk.toBase58(), label);
        }
    };
    const removeTrackedSub = async (id?: number) => {
        if (id == null) return;
        const idx = subs.findIndex((entry) => entry.id === id);
        if (idx >= 0) subs.splice(idx, 1);
        try { await ws.removeAccountChangeListener(id); } catch { /* noop */ }
    };
    const clearSubs = async () => {
        await Promise.all(subs.map((s) => ws.removeAccountChangeListener(s.id).catch(() => { })));
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

    let orcaTimer: NodeJS.Timeout | null = null;
    let meteoraTimer: NodeJS.Timeout | null = null;
    let raydiumTimer: NodeJS.Timeout | null = null;
    let lifinityTimer: NodeJS.Timeout | null = null;
    const provider = args.provider ?? null;

    // ── Per-pool freshness state (for Orca forced refreshes)
    const orcaState = new Map<string, OrcaPoolState>();
    const meteoraState = new Map<string, MeteoraPoolState>();
    const raydiumState = new Map<string, RaydiumPoolState>();
    const lifinityState = new Map<string, LifinityPoolState>();
    let meteoraProgram: any | null = null;

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
            logWsSubscription("orca", `${poolIdStr}:tick:${startTick}`, "orca_tick_array");
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
    orcaTimer = setInterval(async () => {
        const now = Date.now();
        for (const [poolKeyStr, state] of orcaState.entries()) {
            const { ctx, lastPushMs } = state;
            if (now - lastPushMs < ORCA_FORCE_POLL_MS) continue;
            try {
                const resp = await http.getAccountInfoAndContext(ctx.whirlpool, COMMITMENT);
                const acc = resp?.value;
                if (!acc?.data) continue;
                const parsed: any = ParsableWhirlpool.parse(ctx.whirlpool, { ...acc, owner: acc.owner, data: acc.data });
                const sqrtRaw = parsed?.sqrtPrice ?? 0;
                const sqrtBN = new BN(String(sqrtRaw));
                if (sqrtBN.isZero()) continue;

                const px = computeOrcaQuotePerBaseFromSqrt(sqrtBN, ctx.decA, ctx.decB, ctx.baseIsA);
                if (!Number.isFinite(px) || px <= 0) continue;

                const pollSlot = typeof resp?.context?.slot === "number" ? resp.context.slot : undefined;
                const slotHintNum = Math.max(pollSlot ?? 0, latestTickArraySlot(state) ?? 0, lastObservedSlot || 0);
                const slotUsed = slotHintNum > 0 ? slotHintNum : undefined;
                const syntheticSlot = slotUsed != null && !(typeof pollSlot === "number" && pollSlot > 0);
                const wsAtValue = now;
                args.joiner.upsertAmms({
                    venue: "orca",
                    ammId: ctx.whirlpool.toBase58(),
                    px,
                    ts: now,
                    slot: slotUsed,
                    feeBps: ctx.feeBps,
                    poolKind: "clmm",
                    baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                    quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                    source: "ws+poll",
                    ws_at: wsAtValue,
                    heartbeat_at: wsAtValue,
                    synthetic_slot: syntheticSlot || undefined,
                });
                recordHeartbeatMetric({
                    venue: "orca",
                    poolId: ctx.whirlpool.toBase58(),
                    wsAt: wsAtValue,
                    heartbeatAt: wsAtValue,
                    source: "ws+poll",
                    synthetic: syntheticSlot,
                    wsUrl,
                    endpointLabel: wsEndpointLabel,
                });
                state.lastPushMs = now;
                if (slotUsed != null) {
                    state.lastSlotHint = slotUsed;
                    state.lastWsSlot = slotUsed;
                }
                state.lastWsMs = wsAtValue;
                const tickIdx = Number(parsed?.tickCurrentIndex);
                if (Number.isFinite(tickIdx)) {
                    state.activeTickIndex = tickIdx;
                    await ensureTickArrays(poolKeyStr, ctx.whirlpool, state, tickIdx);
                }
                logger.log("orca_force_poll", {
                    pool: poolKeyStr,
                    waited_ms: now - lastPushMs,
                    slot: pollSlot ?? null,
                });
            } catch (e) {
                logger.log("orca_force_poll_error", { pool: poolKeyStr, err: String((e as any)?.message ?? e) });
            }
        }
    }, Math.min(ORCA_FORCE_POLL_MS, 2000));
    orcaTimer?.unref?.();

    const getMeteoraProgram = () => {
        if (!meteoraProgram) {
            meteoraProgram = createMeteoraProgram(http);
        }
        return meteoraProgram;
    };

    const meteoraHeartbeatInterval = Math.max(1_000, Math.min(METEORA_HEARTBEAT_MS, 2_000));
    meteoraTimer = setInterval(() => {
        const now = Date.now();
        for (const [poolKeyStr, state] of meteoraState.entries()) {
            const waitedMs = now - state.lastPushMs;
            if (waitedMs < METEORA_HEARTBEAT_MS) continue;
            try {
                const heartbeat = pushMeteoraSnapshot(state, "heartbeat", state.lastSlotHint ?? null);
                if (!heartbeat.ok) {
                    state.heartbeatConsecutiveMisses = (state.heartbeatConsecutiveMisses ?? 0) + 1;
                    continue;
                }
                const missCount = state.heartbeatConsecutiveMisses ?? 0;
                state.heartbeatConsecutiveMisses = 0;

                const shouldLog = now - (state.lastHeartbeatLogMs ?? 0) >= METEORA_HEARTBEAT_LOG_MS;
                if (shouldLog || heartbeat.syntheticSlot) {
                    state.lastHeartbeatLogMs = now;
                    logger.log("meteora_heartbeat_refresh", {
                        pool: poolKeyStr,
                        waited_ms: waitedMs,
                        slot: heartbeat.slotUsed ?? null,
                        synthetic: heartbeat.syntheticSlot || false,
                        ws_age_ms: state.lastWsMs != null ? Math.max(0, now - state.lastWsMs) : null,
                        misses: missCount,
                    });
                }
            } catch (e) {
                state.heartbeatConsecutiveMisses = (state.heartbeatConsecutiveMisses ?? 0) + 1;
                logger.log("meteora_heartbeat_error", {
                    pool: poolKeyStr,
                    err: String((e as any)?.message ?? e),
                });
            }
        }
    }, meteoraHeartbeatInterval);
    meteoraTimer?.unref?.();

    const raydiumHeartbeatInterval = Math.max(1_000, Math.min(RAYDIUM_HEARTBEAT_MS, 2_000));
    raydiumTimer = setInterval(() => {
        const now = Date.now();
        for (const [poolKeyStr, state] of raydiumState.entries()) {
            const waitedMs = now - state.lastPushMs;
            if (waitedMs < RAYDIUM_HEARTBEAT_MS) continue;
            const priorHeartbeat = state.lastHeartbeatMs ?? 0;
            const slotSeed = Math.max(state.lastSlotHint ?? 0, state.lastWsSlot ?? 0, lastObservedSlot || 0);
            const synthetic = !(slotSeed > 0);
            const ok = pushRaydiumSnapshot(state, "heartbeat", slotSeed > 0 ? slotSeed : null, synthetic);
            if (!ok) continue;
            if (now - priorHeartbeat >= RAYDIUM_HEARTBEAT_LOG_MS) {
                logger.log("raydium_heartbeat_refresh", {
                    pool: poolKeyStr,
                    waited_ms: waitedMs,
                    slot: state.lastSlotHint ?? null,
                    synthetic,
                    ws_age_ms: state.lastWsMs != null ? Math.max(0, now - state.lastWsMs) : null,
                });
            }
        }
    }, raydiumHeartbeatInterval);
    raydiumTimer?.unref?.();

    lifinityTimer = setInterval(() => {
        const now = Date.now();
        for (const state of lifinityState.values()) {
            const waitedMs = now - state.lastPushMs;
            if (waitedMs < LIFINITY_HEARTBEAT_MS) continue;
            void (async () => {
                try {
                    const snapshot = await refreshLifinitySnapshot({
                        connection: http,
                        poolId: state.poolId,
                        expectedBaseMint: state.meta.baseMint,
                        expectedQuoteMint: state.meta.quoteMint,
                        baseDecimalsHint: state.baseDecimalsHint ?? state.meta.baseDecimals,
                        quoteDecimalsHint: state.quoteDecimalsHint ?? state.meta.quoteDecimals,
                    });
                    state.baseReserve = snapshot.baseReserve;
                    state.quoteReserve = snapshot.quoteReserve;
                    state.meta = snapshot.meta;
                    state.baseDecimalsHint = snapshot.meta.baseDecimals;
                    state.quoteDecimalsHint = snapshot.meta.quoteDecimals;
                    cacheLifinityFee(state.poolId, state.meta.feeBps);
                    const pushed = pushLifinitySnapshot(state, "heartbeat", snapshot.slot ?? null);
                    if (pushed) {
                        const lastLog = state.lastHeartbeatLogMs ?? 0;
                        if (now - lastLog >= LIFINITY_HEARTBEAT_LOG_MS) {
                            state.lastHeartbeatLogMs = now;
                            logger.log("lifinity_heartbeat_refresh", {
                                pool: state.poolIdStr,
                                waited_ms: waitedMs,
                                slot: snapshot.slot ?? null,
                            });
                        }
                    }
                } catch (err) {
                    logger.log("lifinity_heartbeat_error", {
                        pool: state.poolIdStr,
                        err: String((err as any)?.message ?? err),
                    });
                }
            })();
        }
    }, Math.max(1_000, Math.min(LIFINITY_HEARTBEAT_MS, 2_000)));
    lifinityTimer?.unref?.();

    function computeMeteoraPrice(state: MeteoraPoolState): number | null {
        if (!Number.isFinite(state.activeId) || !Number.isFinite(state.binStep)) return null;
        const ratio = Number(getPriceOfBinByBinId(state.activeId, state.binStep));
        if (!Number.isFinite(ratio) || ratio <= 0) return null;
        if (state.baseIsX) {
            return ratio * Math.pow(10, state.baseDecimals - state.quoteDecimals);
        }
        const inv = ratio > 0 ? 1 / ratio : null;
        if (inv == null || inv <= 0) return null;
        return inv * Math.pow(10, state.quoteDecimals - state.baseDecimals);
    }

    type MeteoraPushResult = { ok: boolean; slotUsed?: number; syntheticSlot?: boolean };

    function pushMeteoraSnapshot(state: MeteoraPoolState, source: string, slot?: number | null): MeteoraPushResult {
        const px = computeMeteoraPrice(state);
        if (!Number.isFinite(px) || px == null || px <= 0) return { ok: false };

        const baseAtoms = state.baseIsX ? state.reserveXAtoms : state.reserveYAtoms;
        const quoteAtoms = state.baseIsX ? state.reserveYAtoms : state.reserveXAtoms;

        const baseUi = baseAtoms != null ? atomsToUi(baseAtoms, state.baseDecimals) : undefined;
        const quoteUi = quoteAtoms != null ? atomsToUi(quoteAtoms, state.quoteDecimals) : undefined;

        const now = Date.now();
        const prevSlotHint = state.lastSlotHint ?? 0;
        const cachedWsSlot = state.lastWsSlot ?? 0;
        const slotHint = Math.max(slot ?? 0, cachedWsSlot, prevSlotHint, lastObservedSlot || 0);
        const slotUsed = slotHint > 0 ? slotHint : undefined;
        const slotProvided = typeof slot === "number" && slot > 0;
        const syntheticSlot = slotUsed != null && !slotProvided;

        const heartbeatAtValue = source === "heartbeat" ? now : state.lastHeartbeatMs ?? null;
        const heartbeatSlotValue = source === "heartbeat" ? slotUsed : state.lastHeartbeatSlot ?? slotUsed ?? null;
        const wsAtValue = slotUsed != null ? now : state.lastWsMs ?? null;
        const heartbeatGrace = state.heartbeatGraceMs ?? Math.max(METEORA_HEARTBEAT_MS, 1_000) * 2;
        const tradeableSoft = state.tradeableWhenDegradedPreferred && heartbeatAtValue != null
            ? (now - heartbeatAtValue) <= heartbeatGrace
            : false;

        args.joiner.upsertAmms({
            venue: "meteora",
            ammId: state.poolIdStr,
            px,
            ts: now,
            slot: slotUsed,
            feeBps: state.feeBps,
            poolKind: "dlmm",
            baseDecimals: state.baseDecimals,
            quoteDecimals: state.quoteDecimals,
            base_int: baseAtoms?.toString(),
            quote_int: quoteAtoms?.toString(),
            base_ui: baseUi,
            quote_ui: quoteUi,
            source,
            tradeable_when_degraded: tradeableSoft,
            heartbeat_at: heartbeatAtValue,
            heartbeat_slot: heartbeatSlotValue ?? null,
            ws_at: wsAtValue,
            synthetic_slot: syntheticSlot || undefined,
        });

        recordHeartbeatMetric({
            venue: "meteora",
            poolId: state.poolIdStr,
            heartbeatAt: heartbeatAtValue,
            wsAt: wsAtValue,
            source,
            synthetic: syntheticSlot,
            wsUrl,
            endpointLabel: wsEndpointLabel,
        });

        state.lastPushMs = now;
        state.lastPushSlot = slotUsed;
        state.lastPushSynthetic = syntheticSlot;
        if (slotHint > 0) {
            state.lastSlotHint = slotHint;
            state.lastWsSlot = slotHint;
        }
        if (wsAtValue != null) state.lastWsMs = wsAtValue;
        if (source === "heartbeat") {
            state.lastHeartbeatMs = now;
            state.lastHeartbeatSlot = slotUsed;
            state.lastHeartbeatSynthetic = syntheticSlot;
        } else if (source === "ws") {
            if (slotUsed != null) state.lastWsSlot = slotUsed;
        }
        return { ok: true, slotUsed, syntheticSlot };
    }

    function pushLifinitySnapshot(state: LifinityPoolState, source: string, slotOverride?: number | null): boolean {
        const baseUi = lifinityAtomsToUi(state.baseReserve, state.meta.baseDecimals);
        const quoteUi = lifinityAtomsToUi(state.quoteReserve, state.meta.quoteDecimals);
        if (!(baseUi > 0) || !(quoteUi > 0)) return false;

        const rawPx = baseUi > 0 ? quoteUi / baseUi : null;

        const snapshotForQuote = {
            poolId: state.poolId,
            ts: Date.now(),
            slot: slotOverride ?? state.lastSlotHint ?? state.lastWsSlot,
            baseReserve: state.baseReserve,
            quoteReserve: state.quoteReserve,
            meta: state.meta,
        };

        const probeSizeBase = 1e-4;
        let probePx: number | null = null;
        try {
            const probe = lifinityQuoteFromSnapshot({
                snapshot: snapshotForQuote as any,
                sizeBase: probeSizeBase,
                direction: "baseToQuote",
            });
            if (probe.ok && Number.isFinite(probe.price) && probe.price > 0 && probe.price < 10_000) {
                probePx = probe.price;
            }
        } catch {
            /* fall back to raw ratio */
        }

        const px = Number.isFinite(probePx) && (probePx as number) > 0 ? (probePx as number) : rawPx;
        if (!Number.isFinite(px) || !(px as number > 0)) return false;

        const now = Date.now();
        const slotHint = Math.max(slotOverride ?? 0, state.lastSlotHint ?? 0, lastObservedSlot || 0);
        const slotUsed = slotHint > 0 ? slotHint : undefined;
        const slotProvided = typeof slotOverride === "number" && slotOverride > 0;
        const syntheticSlot = slotUsed != null && !slotProvided;

        args.joiner.upsertAmms({
            venue: "lifinity",
            ammId: state.poolIdStr,
            ts: now,
            slot: slotUsed,
            px,
            feeBps: state.meta.feeBps,
            poolKind: "cpmm",
            baseDecimals: state.meta.baseDecimals,
            quoteDecimals: state.meta.quoteDecimals,
            base_int: state.baseReserve.toString(),
            quote_int: state.quoteReserve.toString(),
            px_raw_ratio: rawPx ?? undefined,
            source,
            tradeable_when_degraded: state.tradeableWhenDegradedPreferred ?? false,
        });

        logger.log("lifinity_price_debug", {
            venue: "lifinity",
            pool: state.poolIdStr,
            px_quoter: probePx ?? null,
            px_raw_ratio: rawPx,
            base_ui: baseUi,
            quote_ui: quoteUi,
        });

        recordHeartbeatMetric({
            venue: "lifinity",
            poolId: state.poolIdStr,
            heartbeatAt: now,
            wsAt: now,
            source,
            synthetic: syntheticSlot,
            wsUrl,
            endpointLabel: wsEndpointLabel,
        });

        state.lastPushMs = now;
        state.lastHeartbeatMs = now;
        if (slotUsed != null) {
            state.lastSlotHint = slotUsed;
            state.lastWsSlot = slotUsed;
        }
        state.lastWsMs = now;
        state.lastHeartbeatLogMs = now;
        cacheLifinityFee(state.poolId, state.meta.feeBps);
        provider?.ingestExternalAmmSnapshot({
            venue: "lifinity",
            poolId: state.poolIdStr,
            poolKind: "cpmm",
            price: px,
            feeBps: state.meta.feeBps,
            baseDecimals: state.meta.baseDecimals,
            quoteDecimals: state.meta.quoteDecimals,
            baseReserveAtoms: state.baseReserve.toString(),
            quoteReserveAtoms: state.quoteReserve.toString(),
            baseUi,
            quoteUi,
            baseVault: state.meta.baseVault.toBase58(),
            quoteVault: state.meta.quoteVault.toBase58(),
            slot: slotUsed ?? null,
            ts: now,
            source,
            tradeableWhenDegraded: state.tradeableWhenDegradedPreferred ?? false,
            syntheticSlot,
        });
        return true;
    }

    function pushRaydiumSnapshot(state: RaydiumPoolState, source: string, slotOverride?: number | null, syntheticHint = false): boolean {
        if (!(state.base > 0n && state.quote > 0n)) return false;

        const baseUi = atomsToUi(state.base, state.baseDecimals);
        const quoteUi = atomsToUi(state.quote, state.quoteDecimals);
        const px = quoteUi > 0 && baseUi > 0 ? quoteUi / baseUi : NaN;
        if (!Number.isFinite(px) || !(px > 0)) return false;

        const now = Date.now();
        const prevSlotHint = state.lastSlotHint ?? 0;
        const cachedSlot = state.lastWsSlot ?? 0;
        const slotHint = Math.max(slotOverride ?? 0, cachedSlot, prevSlotHint, lastObservedSlot || 0);
        const slotUsed = slotHint > 0 ? slotHint : undefined;
        const slotProvided = typeof slotOverride === "number" && slotOverride > 0;
        const syntheticSlot = slotUsed != null && (syntheticHint || !slotProvided);

        const wsAtValue = slotUsed != null ? now : state.lastWsMs ?? null;
        const heartbeatAtValue = source === "heartbeat" ? now : state.lastHeartbeatMs ?? null;
        const heartbeatGrace = state.heartbeatGraceMs ?? AMM_TTL_MS * 2;
        const tradeableSoft = state.tradeableWhenDegradedPreferred && heartbeatAtValue != null
            ? (now - heartbeatAtValue) <= heartbeatGrace
            : false;
        const heartbeatSlotValue = heartbeatAtValue != null ? (slotUsed ?? state.lastSlotHint ?? null) : null;

        args.joiner.upsertAmms({
            venue: "raydium",
            ammId: state.poolIdStr,
            px,
            ts: now,
            slot: slotUsed,
            feeBps: state.feeBps,
            poolKind: "cpmm",
            baseDecimals: state.baseDecimals,
            quoteDecimals: state.quoteDecimals,
            base_int: state.base.toString(),
            quote_int: state.quote.toString(),
            source,
            tradeable_when_degraded: tradeableSoft,
            heartbeat_at: heartbeatAtValue,
            heartbeat_slot: heartbeatSlotValue,
            ws_at: wsAtValue,
            synthetic_slot: syntheticSlot || undefined,
        });

        recordHeartbeatMetric({
            venue: "raydium",
            poolId: state.poolIdStr,
            heartbeatAt: heartbeatAtValue,
            wsAt: wsAtValue,
            source,
            synthetic: syntheticSlot,
            wsUrl,
            endpointLabel: wsEndpointLabel,
        });

        state.lastPushMs = now;
        if (slotUsed != null) {
            state.lastSlotHint = slotUsed;
            state.lastWsSlot = slotUsed;
        }
        if (wsAtValue != null) state.lastWsMs = wsAtValue;
        if (source === "heartbeat") {
            state.lastHeartbeatMs = now;
        }
        return true;
    }

    const subscribeMeteoraReserve = async (
        state: MeteoraPoolState,
        which: "x" | "y",
        account: PublicKey,
    ): Promise<void> => {
        const subId = await ws.onAccountChange(account, (acc, context) => {
            const slot = slotFromContext(context, acc as any);
            const nowMs = Date.now();
            if (slot != null) {
                lastObservedSlot = Math.max(lastObservedSlot, slot);
                state.lastWsSlot = slot;
            }
            state.lastWsMs = nowMs;
            try {
                const amount = decodeSplAmount(acc.data);
                if (which === "x") state.reserveXAtoms = amount;
                else state.reserveYAtoms = amount;
                pushMeteoraSnapshot(state, "ws", slot ?? null);
            } catch (e) {
                logger.log("ws_meteora_reserve_decode_error", {
                    pool: state.poolIdStr,
                    which,
                    err: String((e as any)?.message ?? e),
                });
            }
        });
        addSub(subId, which === "x" ? "meteora_reserve_x" : "meteora_reserve_y", account);
        logWsSubscription("meteora", state.poolIdStr, which === "x" ? "meteora_reserve_x" : "meteora_reserve_y");
        if (which === "x") {
            state.reserveXSubId = subId;
            state.reserveXTarget = account.toBase58();
        } else {
            state.reserveYSubId = subId;
            state.reserveYTarget = account.toBase58();
        }
        logger.log("ws_meteora_reserve_wired", {
            pool: state.poolIdStr,
            which,
            account: account.toBase58(),
        });
    };

    const ensureMeteoraVaultSubs = async (state: MeteoraPoolState): Promise<void> => {
        const wantX = state.reserveX.toBase58();
        if (state.reserveXTarget !== wantX) {
            await removeTrackedSub(state.reserveXSubId);
            await subscribeMeteoraReserve(state, "x", state.reserveX);
        }

        const wantY = state.reserveY.toBase58();
        if (state.reserveYTarget !== wantY) {
            await removeTrackedSub(state.reserveYSubId);
            await subscribeMeteoraReserve(state, "y", state.reserveY);
        }
    };

    const loadMeteoraState = async (spec: NormalizedPoolSpec): Promise<MeteoraPoolState | null> => {
        try {
            const infoResp = await http.getAccountInfoAndContext(spec.poolId, COMMITMENT);
            const info = infoResp?.value;
            if (!info?.data) {
                logger.log("ws_meteora_pool_missing", { pool: spec.poolIdStr });
                return null;
            }

            const primeSlot = typeof infoResp?.context?.slot === "number" ? infoResp.context.slot : undefined;

            const program = getMeteoraProgram();
            const pair = decodeMeteoraAccount(program, "lbPair", info.data) as any;
            const mintX = new PublicKey(pair.tokenXMint);
            const mintY = new PublicKey(pair.tokenYMint);

            let baseIsX: boolean;
            if (mintX.equals(spec.baseMint)) baseIsX = true;
            else if (mintY.equals(spec.baseMint)) baseIsX = false;
            else baseIsX = true;

            const baseMintPk = baseIsX ? mintX : mintY;
            const quoteMintPk = baseIsX ? mintY : mintX;

            const [baseDecimals, quoteDecimals] = await Promise.all([
                loadMintDecimals(http, baseMintPk),
                loadMintDecimals(http, quoteMintPk),
            ]);

            const reserveX = new PublicKey(pair.reserveX);
            const reserveY = new PublicKey(pair.reserveY);

            const reserveInfos = await http.getMultipleAccountsInfo([reserveX, reserveY], { commitment: COMMITMENT });
            const rawReserveX = reserveInfos[0]?.data ?? null;
            const rawReserveY = reserveInfos[1]?.data ?? null;

            if (!rawReserveX || !rawReserveY) {
                logger.log("ws_meteora_reserve_pending", {
                    pool: spec.poolIdStr,
                    have_x: Boolean(rawReserveX),
                    have_y: Boolean(rawReserveY),
                });
            }

            const amountX = rawReserveX ? decodeSplAmount(rawReserveX) : undefined;
            const amountY = rawReserveY ? decodeSplAmount(rawReserveY) : undefined;

            const activeId = Number(typeof pair.activeId?.toString === "function" ? pair.activeId.toString() : pair.activeId ?? 0);
            const binStep = Number(pair.binStep ?? 0);

            const feeBps = Number.isFinite(spec.feeBps) ? Number(spec.feeBps) : 0;

            const state: MeteoraPoolState = {
                poolId: spec.poolId,
                poolIdStr: spec.poolIdStr,
                symbol: spec.symbol,
                baseMint: spec.baseMint,
                quoteMint: spec.quoteMint,
                baseDecimals,
                quoteDecimals,
                baseIsX,
                feeBps,
                reserveX,
                reserveY,
                binStep,
                activeId,
                reserveXAtoms: amountX,
                reserveYAtoms: amountY,
                lastPushMs: 0,
                tradeableWhenDegradedPreferred: Boolean(spec.freshness?.tradeableWhenDegraded),
                heartbeatGraceMs: Number.isFinite(spec.freshness?.heartbeatGraceMs)
                    ? Number(spec.freshness?.heartbeatGraceMs)
                    : undefined,
            };

            const seedSlot = primeSlot ?? (lastObservedSlot || 0);
            const seedNow = Date.now();
            if (seedSlot > 0) {
                state.lastWsSlot = seedSlot;
                state.lastSlotHint = seedSlot;
            }
            state.lastWsMs = seedNow;

            pushMeteoraSnapshot(state, "prime", seedSlot > 0 ? seedSlot : null);
            await ensureMeteoraVaultSubs(state);
            return state;
        } catch (e) {
            logger.log("ws_meteora_prime_error", {
                pool: spec.poolIdStr,
                err: String((e as any)?.message ?? e),
            });
            return null;
        }
    };

    const wireMeteoraPool = async (spec: NormalizedPoolSpec): Promise<void> => {
        const state = await loadMeteoraState(spec);
        if (!state) return;
        meteoraState.set(spec.poolIdStr, state);

        const subId = await ws.onAccountChange(spec.poolId, (acc, context) => {
            const slot = slotFromContext(context, acc as any);
            const nowMs = Date.now();
            if (slot != null) {
                lastObservedSlot = Math.max(lastObservedSlot, slot);
            }
            void (async () => {
                try {
                    const program = getMeteoraProgram();
                    const pair = decodeMeteoraAccount(program, "lbPair", acc.data) as any;
                    const tracked = meteoraState.get(spec.poolIdStr);
                    if (!tracked) return;

                    const nextActive = Number(typeof pair.activeId?.toString === "function" ? pair.activeId.toString() : pair.activeId ?? tracked.activeId);
                    if (Number.isFinite(nextActive)) tracked.activeId = nextActive;

                    const nextBinStep = Number(pair.binStep ?? tracked.binStep);
                    if (Number.isFinite(nextBinStep) && nextBinStep > 0) tracked.binStep = nextBinStep;

                    const reserveX = new PublicKey(pair.reserveX);
                    const reserveY = new PublicKey(pair.reserveY);
                    const reserveChanged = !reserveX.equals(tracked.reserveX) || !reserveY.equals(tracked.reserveY);
                    tracked.reserveX = reserveX;
                    tracked.reserveY = reserveY;
                    if (reserveChanged) await ensureMeteoraVaultSubs(tracked);

                    if (slot != null) tracked.lastWsSlot = slot;
                    tracked.lastWsMs = nowMs;
                    pushMeteoraSnapshot(tracked, "ws", slot ?? null);
                } catch (e) {
                    logger.log("ws_meteora_state_error", {
                        pool: spec.poolIdStr,
                        err: String((e as any)?.message ?? e),
                    });
                }
            })();
        });
        addSub(subId, "meteora_pair", spec.poolId);
        logWsSubscription("meteora", spec.poolIdStr, "meteora_pair");
        state.stateSubId = subId;

        logger.log("ws_meteora_dlmm_wired", {
            pool: spec.poolIdStr,
            fee_bps: state.feeBps,
            base_mint: state.baseMint.toBase58(),
            quote_mint: state.quoteMint.toBase58(),
            base_is_x: state.baseIsX,
        });
    };

    const loadLifinityState = async (spec: NormalizedPoolSpec): Promise<LifinityPoolState | null> => {
        try {
            const meta = await loadLifinityPoolMeta({
                connection: http,
                poolId: spec.poolId,
                expectedBaseMint: spec.baseMint,
                expectedQuoteMint: spec.quoteMint,
                baseDecimalsHint: spec.baseDecimalsHint,
                quoteDecimalsHint: spec.quoteDecimalsHint,
            });

            const snapshot = await refreshLifinitySnapshot({
                connection: http,
                poolId: spec.poolId,
                expectedBaseMint: spec.baseMint,
                expectedQuoteMint: spec.quoteMint,
                baseDecimalsHint: spec.baseDecimalsHint,
                quoteDecimalsHint: spec.quoteDecimalsHint,
            });

            logger.log("lifinity_vaults_resolved", {
                pool: spec.poolIdStr,
                base_vault: snapshot.meta.baseVault.toBase58(),
                quote_vault: snapshot.meta.quoteVault.toBase58(),
                source: snapshot.vaultSource ?? "unknown",
            });

            const now = Date.now();
            const state: LifinityPoolState = {
                poolId: spec.poolId,
                poolIdStr: spec.poolIdStr,
                meta,
                baseReserve: snapshot.baseReserve,
                quoteReserve: snapshot.quoteReserve,
                lastPushMs: now,
                lastSlotHint: snapshot.slot ?? undefined,
                lastWsSlot: snapshot.slot ?? undefined,
                lastWsMs: now,
                lastHeartbeatMs: now,
                lastHeartbeatLogMs: now,
                tradeableWhenDegradedPreferred: Boolean(spec.freshness?.tradeableWhenDegraded),
                heartbeatGraceMs: spec.freshness?.heartbeatGraceMs,
                baseDecimalsHint: spec.baseDecimalsHint ?? meta.baseDecimals,
                quoteDecimalsHint: spec.quoteDecimalsHint ?? meta.quoteDecimals,
            };

            pushLifinitySnapshot(state, "prime", snapshot.slot ?? null);
            cacheLifinityFee(spec.poolId, meta.feeBps);
            return state;
        } catch (err) {
            logger.log("lifinity_state_load_error", {
                pool: spec.poolIdStr,
                err: String((err as any)?.message ?? err),
            });
            return null;
        }
    };

    const subscribeLifinityVault = async (
        state: LifinityPoolState,
        kind: "base" | "quote",
        vault: PublicKey,
    ): Promise<void> => {
        const subId = await ws.onAccountChange(vault, (acc, context) => {
            try {
                const amount = decodeSplAmount(acc.data);
                if (kind === "base") state.baseReserve = amount;
                else state.quoteReserve = amount;
                const slot = slotFromContext(context, acc as any);
                if (slot != null) {
                    lastObservedSlot = Math.max(lastObservedSlot, slot);
                    state.lastWsSlot = slot;
                }
                state.lastWsMs = Date.now();
                pushLifinitySnapshot(state, "ws", slot ?? null);
            } catch (e) {
                logger.log("lifinity_vault_update_error", {
                    pool: state.poolIdStr,
                    role: kind,
                    err: String((e as any)?.message ?? e),
                });
            }
        });
        addSub(subId, kind === "base" ? "lifinity_base_vault" : "lifinity_quote_vault", vault);
        logWsSubscription("lifinity", state.poolIdStr, kind === "base" ? "lifinity_base_vault" : "lifinity_quote_vault");
    };

    const wireLifinityPool = async (spec: NormalizedPoolSpec): Promise<void> => {
        const state = await loadLifinityState(spec);
        if (!state) return;
        lifinityState.set(spec.poolIdStr, state);
        await subscribeLifinityVault(state, "base", state.meta.baseVault);
        await subscribeLifinityVault(state, "quote", state.meta.quoteVault);
    };

    // Main wire function (idempotent)
    const wireAll = async () => {
        meteoraState.clear();
        raydiumState.clear();
        lifinityState.clear();

        const poolSpecs = collectPoolSpecs(conf);
        for (const spec of poolSpecs) {
            const { venue, poolKind } = spec;
            const poolId = spec.poolId;
            const feeBpsHint = Number.isFinite(spec.feeBps) ? Number(spec.feeBps) : undefined;

            if (venue === "meteora" && poolKind === "dlmm") {
                await wireMeteoraPool(spec);
                continue;
            }

            if (venue === "lifinity") {
                await wireLifinityPool(spec);
                continue;
            }

            // ── Raydium CPMM
            if (venue === "raydium" && poolKind === "cpmm") {
                const meta = await getRaydiumVaultsAndDecimals(http, poolId, spec.baseMint, spec.quoteMint, feeBpsHint);
                cacheRaydiumFee(poolId, meta.feeBps);
                logger.log("fee_model_ray", {
                    pool: poolId.toBase58(),
                    fee_bps: meta.feeBps,
                    source: "onchain",
                });
                const poolKeyStr = poolId.toBase58();
                const state: RaydiumPoolState = {
                    poolId,
                    poolIdStr: poolKeyStr,
                    baseVault: meta.baseVault,
                    quoteVault: meta.quoteVault,
                    baseDecimals: meta.baseDecimals,
                    quoteDecimals: meta.quoteDecimals,
                    feeBps: meta.feeBps,
                    base: 0n,
                    quote: 0n,
                    lastPushMs: 0,
                    tradeableWhenDegradedPreferred: Boolean(spec.freshness?.tradeableWhenDegraded),
                    heartbeatGraceMs: Number.isFinite(spec.freshness?.heartbeatGraceMs)
                        ? Number(spec.freshness?.heartbeatGraceMs)
                        : undefined,
                };
                raydiumState.set(poolKeyStr, state);

                // WS: vault balances (2-arg signature)
                const subBase = await ws.onAccountChange(meta.baseVault, (acc, context) => {
                    const slot = slotFromContext(context, acc as any);
                    if (slot != null) lastObservedSlot = Math.max(lastObservedSlot, slot);
                    try {
                        state.base = decodeSplAmount(acc.data);
                        pushRaydiumSnapshot(state, "ws", slot ?? null);
                    } catch { }
                });
                addSub(subBase, "ray_base_vault", meta.baseVault);
                logWsSubscription("raydium", poolKeyStr, "ray_base_vault");

                const subQuote = await ws.onAccountChange(meta.quoteVault, (acc, context) => {
                    const slot = slotFromContext(context, acc as any);
                    if (slot != null) lastObservedSlot = Math.max(lastObservedSlot, slot);
                    try {
                        state.quote = decodeSplAmount(acc.data);
                        pushRaydiumSnapshot(state, "ws", slot ?? null);
                    } catch { }
                });
                addSub(subQuote, "ray_quote_vault", meta.quoteVault);
                logWsSubscription("raydium", poolKeyStr, "ray_quote_vault");

                // Prime via HTTP
                try {
                    const resp = await http.getMultipleAccountsInfoAndContext([meta.baseVault, meta.quoteVault], { commitment: COMMITMENT });
                    const accounts = resp?.value ?? [];
                    const primeSlot = typeof resp?.context?.slot === "number" ? resp.context.slot : undefined;
                    if (accounts[0]?.data) state.base = decodeSplAmount(accounts[0].data);
                    if (accounts[1]?.data) state.quote = decodeSplAmount(accounts[1].data);
                    const seedSlot = primeSlot ?? (lastObservedSlot || 0);
                    const syntheticPrime = !(typeof primeSlot === "number" && primeSlot > 0);
                    pushRaydiumSnapshot(state, "prime", seedSlot > 0 ? seedSlot : null, syntheticPrime);
                } catch { }

                logger.log("ws_ray_cpmm_wired", {
                    pool: poolId.toBase58(),
                    base_vault: meta.baseVault.toBase58(),
                    quote_vault: meta.quoteVault.toBase58(),
                    fee_bps: meta.feeBps,
                });
            }

            // ── Orca CLMM (Whirlpool)
            if (venue === "orca" && poolKind === "clmm") {
                const ctx = await loadOrcaContext(http, poolId, spec.baseMint, spec.quoteMint, feeBpsHint);
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
                        lastSlotHint: undefined,
                        lastWsSlot: undefined,
                        lastWsMs: undefined,
                        lastHeartbeatMs: undefined,
                    };
                    orcaState.set(poolKeyStr, poolState);
                } else {
                    poolState.ctx = ctx;
                }

                // Prime once from HTTP
                try {
                    const primeResp = await http.getAccountInfoAndContext(poolId, COMMITMENT);
                    const prime = primeResp?.value;
                    if (prime?.data) {
                        const parsed: any = ParsableWhirlpool.parse(poolId, { ...prime, owner: prime.owner, data: prime.data });
                        const sqrtRaw = parsed?.sqrtPrice ?? 0;
                        const sqrtBN = new BN(String(sqrtRaw));
                        if (!sqrtBN.isZero()) {
                            const px = computeOrcaQuotePerBaseFromSqrt(sqrtBN, ctx.decA, ctx.decB, ctx.baseIsA);
                            if (Number.isFinite(px) && px > 0) {
                                const now = Date.now();
                                const primeSlot = typeof primeResp?.context?.slot === "number" ? primeResp.context.slot : undefined;
                                const slotHintNum = Math.max(primeSlot ?? 0, latestTickArraySlot(poolState) ?? 0, lastObservedSlot || 0);
                                const slotUsed = slotHintNum > 0 ? slotHintNum : undefined;
                                const syntheticSlot = slotUsed != null && !(typeof primeSlot === "number" && primeSlot > 0);
                                const wsAtValue = now;
                                args.joiner.upsertAmms({
                                    venue: "orca",
                                    ammId: poolId.toBase58(),
                                    px,
                                    ts: now,
                                    slot: slotUsed,
                                    feeBps: ctx.feeBps,
                                    poolKind: "clmm",
                                    baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                                    quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                                    source: "prime",
                                    ws_at: wsAtValue,
                                    heartbeat_at: wsAtValue,
                                    synthetic_slot: syntheticSlot || undefined,
                                });
                    recordHeartbeatMetric({
                        venue: "orca",
                        poolId: poolId.toBase58(),
                        wsAt: wsAtValue,
                        heartbeatAt: wsAtValue,
                        source: "prime",
                        synthetic: syntheticSlot,
                        wsUrl,
                        endpointLabel: wsEndpointLabel,
                    });
                                poolState.lastPushMs = now;
                                if (slotUsed != null) {
                                    poolState.lastSlotHint = slotUsed;
                                    poolState.lastWsSlot = slotUsed;
                                }
                                poolState.lastWsMs = wsAtValue;
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
                        const slotUsed = slotHintNum > 0 ? slotHintNum : undefined;
                        const syntheticSlot = slotUsed != null && !(typeof slot === "number" && slot > 0);
                        const wsAtValue = now;
                        args.joiner.upsertAmms({
                            venue: "orca",
                            ammId: poolId.toBase58(),
                            px,
                            ts: now,
                            slot: slotUsed,
                            feeBps: ctx.feeBps,   // exact per-pool fee (feeRate/100)
                            poolKind: "clmm",
                            baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                            quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                            source: "ws",
                            ws_at: wsAtValue,
                            heartbeat_at: wsAtValue,
                            synthetic_slot: syntheticSlot || undefined,
                        });
                        recordHeartbeatMetric({
                            venue: "orca",
                            poolId: poolId.toBase58(),
                            wsAt: wsAtValue,
                            heartbeatAt: wsAtValue,
                            source: "ws",
                            synthetic: syntheticSlot,
                            wsUrl,
                            endpointLabel: wsEndpointLabel,
                        });
                        if (state) {
                            state.lastPushMs = now;
                            if (slotUsed != null) {
                                state.lastSlotHint = slotUsed;
                                state.lastWsSlot = slotUsed;
                            }
                            state.lastWsMs = wsAtValue;
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
                logWsSubscription("orca", poolKeyStr, "orca_whirlpool");

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
    const logWsState = (evt: "connect" | "disconnect" | "reconnect" | "error", error?: any) => {
        logger.log("ws_connection_state", {
            type: "ws_connection_state",
            source: "ws_markets",
            venue: "multi",
            marketOrPoolKey: "*",
            ws_url: wsUrl,
            event: evt,
            ts: Date.now(),
            error_message: error ? String((error as any)?.message ?? error) : undefined,
        });
    };
    const onOpen = () => {
        logger.log("ws_open", { wsUrl });
        logWsState("connect");
    };
    const onClose = () => {
        logger.log("ws_closed", { wsUrl });
        logWsState("disconnect");
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try {
                await clearSubs();
                await wireAll();
                logWsState("reconnect");
            } catch (e) {
                logger.log("ws_rewire_error", { err: String((e as any)?.message ?? e) });
                logWsState("error", e);
            }
        }, WS_RETRY_MS);
        reconnectTimer?.unref?.();
    };
    const onError = (err: any) => {
        logWsState("error", err);
    };
    (ws as any)._rpcWebSocket?.on?.("open", onOpen);
    (ws as any)._rpcWebSocket?.on?.("close", onClose);
    (ws as any)._rpcWebSocket?.on?.("error", onError);

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
            meteoraTimer && clearInterval(meteoraTimer);
            raydiumTimer && clearInterval(raydiumTimer);
            lifinityTimer && clearInterval(lifinityTimer);
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
            meteoraState.clear();
            raydiumState.clear();
            lifinityState.clear();
            try { (ws as any)._rpcWebSocket?.off?.("open", onOpen); } catch { }
            try { (ws as any)._rpcWebSocket?.off?.("close", onClose); } catch { }
            try { (ws as any)._rpcWebSocket?.off?.("error", onError); } catch { }
        },
    };
}
