// packages/amms/src/adapters/raydium_clmm.ts
// Minimal Raydium CLMM adapter for the AMM publisher.
// Goal (Step 2 of the plan):
// - Emit poolKind: "clmm" lines behind a flag, without altering execution.
// - Provide feeBps() if we can, else fall back.
// - Provide mid() best-effort (optional). Safe to return NaN — publisher will still emit a line.
// - Return reservesAtoms() as 0n/0n (CLMM vaults aren't CPMM-usable), but with correct decimals.
//
// Notes:
// - We read configs/pairs.json to discover symbol/baseMint/quoteMint for poolId.
// - We fetch mint decimals on-chain (cached).
// - This keeps venue label "raydium" + poolKind "clmm" to avoid touching AMMS_ENABLE elsewhere.
//
// Enable via ENV:
//   AMMS_ENABLE=raydium,orca
//   ENABLE_RAYDIUM_CLMM=1

import type { Connection, PublicKey } from "@solana/web3.js";
import { PublicKey as PK } from "@solana/web3.js";
import { PoolInfoLayout, SqrtPriceMath, AmmConfigLayout } from "@raydium-io/raydium-sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { AmmAdapter, ReserveSnapshot } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

// ──────────────────────────────────────────────────────────────
// ENV / helpers
// ──────────────────────────────────────────────────────────────
const getenv = (k: string, d = "") => (process.env[k] ?? d).trim();
const lower = (s: any) => String(s ?? "").trim().toLowerCase();

type PairVenue = { kind: string; id: string; poolKind?: string };
type PairItem = {
    symbol?: string;
    baseMint?: string;
    quoteMint?: string;
    venues?: PairVenue[];
};
type PairsCfg = { pairs?: PairItem[] };

function pairsJsonCandidates(): string[] {
    const envPairs = getenv("PAIRS_JSON") || getenv("AMMS_PAIRS_JSON");
    const repoRoot = path.resolve(__here, "../../../.."); // repo root from packages/amms/src/adapters
    return [
        envPairs,
        path.resolve(process.cwd(), "configs/pairs.json"),
        path.resolve(process.cwd(), "..", "configs/pairs.json"),
        path.resolve(process.cwd(), "..", "..", "configs/pairs.json"),
        path.join(repoRoot, "configs/pairs.json"),
    ].filter(Boolean) as string[];
}

function readJsonMaybe<T = any>(p: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; }
}

function findPairForPool(poolId: string): { symbol?: string; baseMint?: string; quoteMint?: string } | undefined {
    for (const p of pairsJsonCandidates()) {
        if (!p || !fs.existsSync(p)) continue;
        const j = readJsonMaybe<PairsCfg>(p);
        if (!j?.pairs?.length) continue;
        for (const pair of j.pairs) {
            for (const v of pair.venues ?? []) {
                if (lower(v.kind) === "raydium" && String(v.id).trim() === poolId) {
                    return { symbol: pair.symbol, baseMint: pair.baseMint, quoteMint: pair.quoteMint };
                }
            }
        }
        break; // stop at first usable file
    }
    return undefined;
}

const mintDecCache = new Map<string, number>();

// ──────────────────────────────────────────────────────────────
// Raydium CLMM helpers (API + on-chain state)
// ──────────────────────────────────────────────────────────────

const STATE_REFRESH_MS = Number(process.env.RAYDIUM_CLMM_REFRESH_MS ?? 1_000);
async function fetchMintDecimals(conn: Connection, mint: string | PublicKey | undefined, fallback?: number): Promise<number> {
    if (!mint) return fallback ?? 9;
    const key = typeof mint === "string" ? mint : mint.toBase58();
    const hit = mintDecCache.get(key);
    if (typeof hit === "number") return hit;
    try {
        const info = await conn.getParsedAccountInfo(typeof mint === "string" ? new PK(mint) : mint, "confirmed");
        const dec = Number((info.value as any)?.data?.parsed?.info?.decimals ?? NaN);
        if (Number.isFinite(dec)) {
            mintDecCache.set(key, dec);
            return dec;
        }
    } catch { /* noop */ }
    return fallback ?? 9;
}

// ──────────────────────────────────────────────────────────────
// Adapter
// ──────────────────────────────────────────────────────────────
type ClmmStateSnapshot = {
    price: number;
    feeBps: number;
    baseDecimals: number;
    quoteDecimals: number;
    ts: number;
};

export async function createRaydiumClmmAdapter(conn: Connection, poolId: string): Promise<AmmAdapter> {
    // Discover pair metadata from configs (symbol & mints help with decimals and logging).
    const meta = findPairForPool(poolId) ?? {};
    const symbol = meta.symbol || "UNKNOWN/UNKNOWN";
    let _conn: Connection | undefined = conn;

    let stateCache: ClmmStateSnapshot | null = null;
    let inflightState: Promise<ClmmStateSnapshot> | null = null;
    let configFeeCache: number | null = null;

    async function resolveConfigFee(layout: any): Promise<number | null> {
        if (configFeeCache != null) return configFeeCache;
        if (!_conn) return null;
        try {
            const configPk = layout?.ammConfig;
            if (!configPk) return null;
            const configInfo = await _conn.getAccountInfo(configPk, "confirmed");
            if (!configInfo?.data) return null;
            const decoded = AmmConfigLayout.decode(configInfo.data) as any;
            const rate = decoded?.tradeFeeRate;
            const fee = Number(rate);
            if (Number.isFinite(fee) && fee > 0) {
                configFeeCache = Math.round(fee * 10_000);
                return configFeeCache;
            }
        } catch {
            // swallow, fall through to env fallback
        }
        return null;
    }

    async function fetchState(force = false): Promise<ClmmStateSnapshot> {
        if (!_conn) throw new Error("raydium_clmm_no_connection");
        const now = Date.now();
        const cached = stateCache;
        if (!force && cached && now - cached.ts <= STATE_REFRESH_MS) return cached;
        if (inflightState) return inflightState;

        const pending: Promise<ClmmStateSnapshot> = (async () => {
            const info = await _conn!.getAccountInfo(new PK(poolId), "confirmed");
            if (!info?.data) throw new Error("raydium_clmm_account_missing");

            const layout = PoolInfoLayout.decode(info.data) as any;

            const mintA = layout.mintA.toBase58();
            const mintB = layout.mintB.toBase58();
            const decimalsA = layout.mintDecimalsA;
            const decimalsB = layout.mintDecimalsB;
            const sqrtPrice = layout.sqrtPriceX64;

            const priceAB = SqrtPriceMath
                .sqrtPriceX64ToPrice(sqrtPrice, decimalsA, decimalsB)
                .toNumber();
            if (!(priceAB > 0)) throw new Error("raydium_clmm_price_invalid");

            const baseMint = (meta.baseMint ?? "").trim();
            const quoteMint = (meta.quoteMint ?? "").trim();
            const baseIsA = baseMint && baseMint === mintA;
            const baseIsB = baseMint && baseMint === mintB;

            let price = priceAB;
            let baseDecimals = decimalsA;
            let quoteDecimals = decimalsB;

            if (baseIsB) {
                price = priceAB > 0 ? 1 / priceAB : Number.NaN;
                baseDecimals = decimalsB;
                quoteDecimals = decimalsA;
            } else if (!baseIsA && baseMint) {
                // Base mint not matched; keep layout ordering to avoid accidental inversion.
                baseDecimals = decimalsA;
                quoteDecimals = decimalsB;
            }

            const configFee = await resolveConfigFee(layout);
            const feeBps = configFee ?? Number(process.env.RAYDIUM_TRADE_FEE_BPS ?? process.env.AMM_TAKER_FEE_BPS ?? 25);

            stateCache = {
                price,
                feeBps,
                baseDecimals,
                quoteDecimals,
                ts: now,
            };
            return stateCache;
        })();

        inflightState = pending.then((value) => {
            inflightState = null;
            return value;
        }).catch((err) => {
            inflightState = null;
            throw err;
        });

        return inflightState!;
    }

    // Pre-fetch decimals (best-effort). Typical SOL/USDC defaults keep us safe if not found.
    const baseDecimals = await fetchMintDecimals(conn, meta.baseMint, 9);
    const quoteDecimals = await fetchMintDecimals(conn, meta.quoteMint, 6);

    // Best-effort mid(): computing from on-chain sqrtPriceX64 would require exact layout decode.
    // For Step 2 we can safely return NaN — publisher still emits a line (joiner ignores invalid px).
    async function mid(): Promise<number> {
        try {
            const state = await fetchState();
            return Number.isFinite(state.price) && state.price > 0 ? state.price : Number.NaN;
        } catch {
            return Number.NaN;
        }
    }

    // Fee decode: Raydium CLMM stores feeRate in 1e6 scale (ppm). Convert to bps when available.
    async function feeBps(): Promise<number> {
        const hint = (adapter as any).__hintFeeBps;
        if (Number.isFinite(hint)) return Number(hint);
        try {
            const state = await fetchState();
            if (Number.isFinite(state.feeBps) && state.feeBps > 0) return state.feeBps;
        } catch { /* fall back to env */ }
        const env = process.env.RAYDIUM_TRADE_FEE_BPS ?? process.env.AMM_TAKER_FEE_BPS ?? "25";
        const n = Number(env);
        return Number.isFinite(n) ? n : 25;
    }

    async function reservesAtoms(): Promise<ReserveSnapshot> {
        try {
            const state = await fetchState();
            return {
                base: 0n,
                quote: 0n,
                baseDecimals: state.baseDecimals ?? baseDecimals,
                quoteDecimals: state.quoteDecimals ?? quoteDecimals,
            };
        } catch {
            return {
                base: 0n,
                quote: 0n,
                baseDecimals,
                quoteDecimals,
            };
        }
    }

    const adapter: AmmAdapter = {
        symbol,
        venue: "raydium",        // keep venue unified; poolKind disambiguates
        id: poolId,
        // Not part of the interface, but read by the publisher for schema richness:
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        poolKind: "clmm",

        async init(c: Connection) { _conn = c; },
        setConnection(c: Connection) { _conn = c; },
        getConnection() { return _conn; },

        async reservesAtoms() { return reservesAtoms(); },
        async feeBps() { return feeBps(); },
        async mid() { return mid(); },

        // Optional venue-native publisher/builder hooks are not needed for the publisher step
    };

    return adapter;
}
