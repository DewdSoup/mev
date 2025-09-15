// services/arb-mm/src/executor/orca_quoter.ts
// Conservative Orca CLMM quoter helper used by the joiner.
// Goals:
//  - Be best-effort and conservative (never overpromise liquidity).
//  - Prefer using an AMMs publisher cache if available (no heavy onchain parsing).
//  - Avoid generating extra RPC noise (no aggressive onchain fetches by default).
//
// Exports:
//   orcaAvgBuyQuotePerBase(ammId, sizeBase, flatSlippageBps)
//   orcaAvgSellQuotePerBase(ammId, sizeBase, flatSlippageBps)
//
// Return shape:
//   { ok: boolean, price?: number, reason?: string }

import fs from "fs";
import path from "path";
import { logger } from "../ml_logger.js";

export type OrcaQuoteResult =
    | { ok: true; price: number }
    | { ok: false; reason?: string };

const CACHE_PATH =
    process.env.ORCA_QUOTER_CACHE?.trim() ||
    path.resolve(process.cwd(), "data/orca_quoter_cache.json");

function safeParseJson<T = any>(p: string): T | undefined {
    try {
        if (!fs.existsSync(p)) return undefined;
        const raw = fs.readFileSync(p, "utf8");
        return JSON.parse(raw) as T;
    } catch (err) {
        const e = err as any;
        logger.log("orca_quoter_cache_error", { path: p, err: String(e?.message ?? e) });
        return undefined;
    }
}

/** Basic CPMM approx for a CLMM snapshot — conservative fallback */
function cpmmBuyQuotePerBase(
    base: number,
    quote: number,
    wantBase: number,
    feeBps: number
): number | undefined {
    if (!(base > 0 && quote > 0 && wantBase > 0)) return undefined;
    const fee = Math.max(0, feeBps) / 10_000;
    if (wantBase >= base * (1 - 1e-9)) return undefined;
    const dqPrime = (wantBase * quote) / (base - wantBase);
    const dq = dqPrime / (1 - fee);
    if (!Number.isFinite(dq)) return undefined;
    return dq / wantBase;
}
function cpmmSellQuotePerBase(
    base: number,
    quote: number,
    sellBase: number,
    feeBps: number
): number | undefined {
    if (!(base > 0 && quote > 0 && sellBase > 0)) return undefined;
    const fee = Math.max(0, feeBps) / 10_000;
    const dbPrime = sellBase * (1 - fee);
    const dy = (quote * dbPrime) / (base + dbPrime);
    if (!Number.isFinite(dy)) return undefined;
    return dy / sellBase;
}

/**
 * Try to load cached pool snapshot (expected shape):
 * {
 *   "<ammId>": { base: number, quote: number, baseDecimals?: number, quoteDecimals?: number, feeBps?: number, px?: number }
 * }
 */
function loadCache(): Record<string, any> | undefined {
    const j = safeParseJson<Record<string, any>>(CACHE_PATH);
    if (!j) return undefined;
    return j;
}

export async function orcaAvgBuyQuotePerBase(
    ammId: string,
    sizeBase: number,
    flatSlippageBps: number
): Promise<OrcaQuoteResult> {
    if (!ammId || !(sizeBase > 0)) return { ok: false, reason: "invalid_input" };

    const cache = loadCache();
    const entry = cache?.[ammId];
    if (!entry) return { ok: false, reason: "no_cache" };

    const feeBps = Number.isFinite(Number(entry.feeBps))
        ? Number(entry.feeBps)
        : Number(
            process.env.ORCA_TRADE_FEE_BPS ??
            process.env.AMM_TAKER_FEE_BPS ??
            30
        );

    const extra =
        Math.max(0, Number(process.env.ORCA_QUOTER_EXTRA_BPS ?? 2)) / 10_000;

    // Prefer CPMM approx when reserves exist (still conservative)
    const base = Number(entry.base);
    const quote = Number(entry.quote);
    if (base > 0 && quote > 0) {
        const q = cpmmBuyQuotePerBase(
            base,
            quote,
            Math.max(
                sizeBase,
                Number(process.env.MIN_ORCA_BASE_SIZE ?? 0.000001)
            ),
            feeBps
        );
        if (!q || !Number.isFinite(q))
            return { ok: false, reason: "cant_quote_from_cache" };
        return { ok: true, price: q * (1 + extra) };
    }

    // Fallback: `px` only (no reserves) → conservative fee-upside on cost
    const px = Number(entry.px ?? entry.px_str);
    if (!Number.isFinite(px) || px <= 0)
        return { ok: false, reason: "bad_cache" };

    // For a BUY on AMM (we receive BASE), cost per BASE ≈ px * (1 + fee + buffer)
    const fee = Math.max(0, feeBps) / 10_000;
    const price = px * (1 + fee) * (1 + extra);
    return Number.isFinite(price) && price > 0
        ? { ok: true, price }
        : { ok: false, reason: "px_only_bad" };
}

export async function orcaAvgSellQuotePerBase(
    ammId: string,
    sizeBase: number,
    flatSlippageBps: number
): Promise<OrcaQuoteResult> {
    if (!ammId || !(sizeBase > 0)) return { ok: false, reason: "invalid_input" };

    const cache = loadCache();
    const entry = cache?.[ammId];
    if (!entry) return { ok: false, reason: "no_cache" };

    const feeBps = Number.isFinite(Number(entry.feeBps))
        ? Number(entry.feeBps)
        : Number(
            process.env.ORCA_TRADE_FEE_BPS ??
            process.env.AMM_TAKER_FEE_BPS ??
            30
        );

    const extra =
        Math.max(0, Number(process.env.ORCA_QUOTER_EXTRA_BPS ?? 2)) / 10_000;

    // Prefer CPMM approx when reserves exist
    const base = Number(entry.base);
    const quote = Number(entry.quote);
    if (base > 0 && quote > 0) {
        const q = cpmmSellQuotePerBase(
            base,
            quote,
            Math.max(
                sizeBase,
                Number(process.env.MIN_ORCA_BASE_SIZE ?? 0.000001)
            ),
            feeBps
        );
        if (!q || !Number.isFinite(q))
            return { ok: false, reason: "cant_quote_from_cache" };
        return { ok: true, price: q * (1 - extra) };
    }

    // Fallback: `px` only → conservative downside from fee
    const px = Number(entry.px ?? entry.px_str);
    if (!Number.isFinite(px) || px <= 0)
        return { ok: false, reason: "bad_cache" };

    // For a SELL on AMM (we give BASE), proceeds per BASE ≈ px * (1 - fee - buffer)
    const fee = Math.max(0, feeBps) / 10_000;
    const price = px * (1 - fee) * (1 - extra);
    return Number.isFinite(price) && price > 0
        ? { ok: true, price }
        : { ok: false, reason: "px_only_bad" };
}
