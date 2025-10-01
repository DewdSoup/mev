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
import { ParsableWhirlpool, PriceMath } from "@orca-so/whirlpools-sdk";
import BN from "bn.js";
import Decimal from "decimal.js";

import { logger } from "../ml_logger.js";
import type { EdgeJoiner } from "../edge/joiner.js";

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
const ORCA_FORCE_POLL_MS = Math.max(1500, Number(process.env.ORCA_FORCE_POLL_MS ?? 2500)); // force a refresh if no WS within this window

function getenv(k: string) { const v = process.env[k]; return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function envTrue(k: string, d = false) {
    const v = String(process.env[k] ?? "").trim().toLowerCase();
    if (!v) return d;
    return v === "1" || v === "true" || v === "yes";
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
    const feeBps =
        Number.isFinite(Number(feeBpsHint)) ? Number(feeBpsHint) :
            Number.isFinite(Number(process.env.RAYDIUM_TRADE_FEE_BPS)) ? Number(process.env.RAYDIUM_TRADE_FEE_BPS) :
                25;
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

    // Orca: feeRate is "hundredths of a basis point"
    // => 30 bps = 3000, 4 bps = 400, etc.
    const feeRateHundredths = Number(parsed.feeRate ?? NaN);
    const feeBps =
        Number.isFinite(feeRateHundredths) ? (feeRateHundredths / 100) :
            (Number.isFinite(Number(feeBpsHint)) ? Number(feeBpsHint) :
                Number.isFinite(Number(process.env.ORCA_TRADE_FEE_BPS)) ? Number(process.env.ORCA_TRADE_FEE_BPS) :
                    30);

    return { whirlpool, tokenMintA, tokenMintB, decA, decB, baseIsA, feeBps };
}

function computeOrcaQuotePerBaseFromSqrt(
    sqrtPriceX64: BN,
    decA: number,
    decB: number,
    baseIsA: boolean
): number {
    // A in B (Decimal-ish)
    const priceAB = PriceMath.sqrtPriceX64ToPrice(sqrtPriceX64, decA, decB);
    const p = Number(priceAB.toString());
    if (!Number.isFinite(p) || p <= 0) return NaN;
    // We want QUOTE per BASE
    return baseIsA ? (1 / p) : p;
}

// ────────────────────────────────────────────────────────────────────────────

export async function startWsMarkets(args: {
    httpUrl?: string;
    wsUrl?: string;
    pairsPath?: string;
    joiner: EdgeJoiner;
}): Promise<void> {
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
        return;
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
    setInterval(() => { http.getSlot(COMMITMENT).catch(() => undefined); }, KEEPALIVE_MS).unref?.();

    // ── Per-pool freshness state (for Orca forced refreshes)
    const orcaState = new Map<string, { ctx: OrcaContext; lastPushMs: number }>();

    // Force-poll any Orca pool that hasn't had a WS tick within ORCA_FORCE_POLL_MS
    setInterval(async () => {
        const now = Date.now();
        for (const { ctx, lastPushMs } of orcaState.values()) {
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

                args.joiner.upsertAmms({
                    venue: "orca",
                    ammId: ctx.whirlpool.toBase58(),
                    px,
                    ts: now,
                    slot: lastObservedSlot || undefined,
                    feeBps: ctx.feeBps,
                    poolKind: "clmm",
                    baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                    quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                    source: "ws+poll",
                });
                orcaState.set(ctx.whirlpool.toBase58(), { ctx, lastPushMs: now });
            } catch (e) {
                logger.log("orca_force_poll_error", { pool: ctx.whirlpool.toBase58(), err: String((e as any)?.message ?? e) });
            }
        }
    }, Math.min(ORCA_FORCE_POLL_MS, 2000)).unref?.();

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
                const state = { base: 0n, quote: 0n };

                const push = (now: number) => {
                    if (state.base <= 0n || state.quote <= 0n) return;
                    const baseUi = atomsToUi(state.base, meta.baseDecimals);
                    const quoteUi = atomsToUi(state.quote, meta.quoteDecimals);
                    const px = quoteUi > 0 && baseUi > 0 ? (quoteUi / baseUi) : NaN;
                    if (!Number.isFinite(px) || !(px > 0)) return;
                    args.joiner.upsertAmms({
                        venue: "raydium",
                        ammId: poolId.toBase58(),
                        px,
                        ts: now,
                        slot: lastObservedSlot || undefined,
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
                const subBase = await ws.onAccountChange(meta.baseVault, (acc) => {
                    try { state.base = decodeSplAmount(acc.data); push(Date.now()); } catch { }
                });
                addSub(subBase, "ray_base_vault", meta.baseVault);

                const subQuote = await ws.onAccountChange(meta.quoteVault, (acc) => {
                    try { state.quote = decodeSplAmount(acc.data); push(Date.now()); } catch { }
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
                                args.joiner.upsertAmms({
                                    venue: "orca",
                                    ammId: poolId.toBase58(),
                                    px,
                                    ts: Date.now(),
                                    slot: lastObservedSlot || undefined,
                                    feeBps: ctx.feeBps,
                                    poolKind: "clmm",
                                    baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                                    quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                                    source: "prime",
                                });
                                orcaState.set(poolId.toBase58(), { ctx, lastPushMs: Date.now() });
                            }
                        }
                    }
                } catch { }

                // WS: whirlpool account (2-arg signature)
                const subId = await ws.onAccountChange(poolId, (acc) => {
                    try {
                        const parsed: any = ParsableWhirlpool.parse(poolId, { ...acc, owner: acc.owner, data: acc.data });
                        const sqrtRaw = parsed?.sqrtPrice ?? 0;
                        const sqrtBN = new BN(String(sqrtRaw));
                        if (sqrtBN.isZero()) return;

                        const px = computeOrcaQuotePerBaseFromSqrt(sqrtBN, ctx.decA, ctx.decB, ctx.baseIsA);
                        if (!Number.isFinite(px) || px <= 0) return;

                        const now = Date.now();
                        args.joiner.upsertAmms({
                            venue: "orca",
                            ammId: poolId.toBase58(),
                            px,
                            ts: now,
                            slot: lastObservedSlot || undefined,
                            feeBps: ctx.feeBps,   // exact per-pool fee (feeRate/100)
                            poolKind: "clmm",
                            baseDecimals: ctx.baseIsA ? ctx.decA : ctx.decB,
                            quoteDecimals: ctx.baseIsA ? ctx.decB : ctx.decA,
                            source: "ws",
                        });
                        orcaState.set(poolId.toBase58(), { ctx, lastPushMs: now });
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
    (ws as any)._rpcWebSocket?.on?.("open", () => {
        logger.log("ws_open", { wsUrl });
    });
    (ws as any)._rpcWebSocket?.on?.("close", async () => {
        logger.log("ws_closed", { wsUrl });
        setTimeout(async () => {
            try {
                await clearSubs();
                await wireAll();
            } catch (e) {
                logger.log("ws_rewire_error", { err: String((e as any)?.message ?? e) });
            }
        }, WS_RETRY_MS);
    });

    await wireAll();
    logger.log("ws_provider_ready", { httpUrl, wsUrl, pairsPath });
}
