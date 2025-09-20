// services/arb-mm/src/registry/pairs.ts
// Tiny registry loader for scalable, additive pairs/venues.
// Reads PAIRS_JSON (if provided). Falls back to env-based SOL/USDC pair.

import fs from "fs";
import path from "path";

export type PairAmmVenue = {
    venue: string;
    poolId: string;
    poolKind?: string;
    feeBps?: number;
};

export type PairSpec = {
    /** Human-friendly id; must be unique. */
    id: string; // e.g., "SOL/USDC:raydium<->phoenix"
    baseMint: string; // e.g., WSOL mint
    quoteMint: string; // e.g., USDC mint
    phoenixMarket: string; // phoenix market pubkey
    /**
     * Primary AMM pool id maintained for backwards compatibility with
     * single-venue flows. Always mirrors the first entry in `ammVenues`.
     */
    ammPool: string;
    /**
     * All AMM venues allowed for this pair. The first element represents
     * the legacy/default venue.
     */
    ammVenues: PairAmmVenue[];
    /** Optional overrides / tunables per pair */
    fees?: {
        phoenixTakerBps?: number;
        ammTakerBps?: number;
        fixedTxCostQuote?: number;
    };
    sizing?: {
        /** hard floor applied at decision-time */
        decisionMinBase?: number;
        /** default probe seed / legacy size */
        tradeSizeBase?: number;
        /** pool impact guard (fraction of base reserve) */
        cpmmMaxPoolTradeFrac?: number;
    };
    /** Future: adapter names when you add Orca/Jupiter etc. */
    adapters?: {
        amm?: "raydium" | "orca" | string;
        phoenix?: "phoenix"; // keep for symmetry
    };
};

function readJsonMaybe(absPath: string): any | undefined {
    try {
        const raw = fs.readFileSync(absPath, "utf8");
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

function normalizePairsJson(raw: any): PairSpec[] | undefined {
    const arr = Array.isArray(raw?.pairs) ? raw.pairs : Array.isArray(raw) ? raw : undefined;
    if (!arr || !arr.length) return undefined;

    const out: PairSpec[] = [];
    for (const entry of arr) {
        if (!entry) continue;
        const baseMint = String(entry.baseMint ?? "").trim();
        const quoteMint = String(entry.quoteMint ?? "").trim();
        const phoenixMarket = String(entry.phoenixMarket ?? entry.phoenix?.market ?? "").trim();
        const venues: PairAmmVenue[] = [];
        const venusArr = Array.isArray(entry.venues) ? entry.venues : [];
        for (const v of venusArr) {
            if (!v || String(v.kind ?? "").toLowerCase() === "phoenix") continue;
            const poolId = String(v.id ?? v.poolId ?? "").trim();
            if (!poolId) continue;
            venues.push({
                venue: String(v.kind ?? v.venue ?? "").toLowerCase(),
                poolId,
                poolKind: typeof v.poolKind === "string" ? v.poolKind : typeof v.pool_kind === "string" ? v.pool_kind : undefined,
                feeBps: typeof v.feeBps === "number" ? v.feeBps : typeof v.fee_bps === "number" ? v.fee_bps : undefined,
            });
        }

        const primary = venues[0];
        if (!baseMint || !quoteMint || !phoenixMarket || !primary) continue;

        out.push({
            id: String(entry.id ?? entry.symbol ?? `${phoenixMarket}:${primary.poolId}`),
            baseMint,
            quoteMint,
            phoenixMarket,
            ammPool: primary.poolId,
            ammVenues: venues,
            fees: entry.fees,
            sizing: entry.sizing,
            adapters: { amm: primary.venue, phoenix: "phoenix" },
        });
    }

    return out.length ? out : undefined;
}

export function loadPairsFromEnvOrDefault(): PairSpec[] {
    const fromEnv = process.env.PAIRS_JSON?.trim();
    if (fromEnv && fs.existsSync(fromEnv)) {
        const abs = path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
        const parsed = readJsonMaybe(abs);
        const normalized = normalizePairsJson(parsed);
        if (normalized && normalized.length) return normalized;
    }

    const defaultPath = path.resolve(process.cwd(), "configs", "pairs.json");
    if (fs.existsSync(defaultPath)) {
        const parsed = readJsonMaybe(defaultPath);
        const normalized = normalizePairsJson(parsed);
        if (normalized && normalized.length) return normalized;
    }

    // Fallback: single SOL/USDC via env (your current baseline)
    const phoenixMarket =
        process.env.PHOENIX_MARKET?.trim() ||
        process.env.PHOENIX_MARKET_ID?.trim() ||
        "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";
    const ammPool =
        process.env.RAYDIUM_POOL_ID?.trim() ||
        process.env.RAYDIUM_POOL_ID_SOL_USDC?.trim() ||
        "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

    const baseMint =
        process.env.WSOL_MINT?.trim() ||
        "So11111111111111111111111111111111111111112";
    const quoteMint =
        process.env.USDC_MINT?.trim() ||
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    const defaultVenue: PairAmmVenue = {
        venue: String(process.env.DEFAULT_AMM_VENUE ?? "raydium").toLowerCase(),
        poolId: ammPool,
    };

    return [
        {
            id: "SOL/USDC:raydium<->phoenix",
            baseMint,
            quoteMint,
            phoenixMarket,
            ammPool,
            ammVenues: [defaultVenue],
            fees: {
                phoenixTakerBps: Number(process.env.PHOENIX_TAKER_FEE_BPS ?? 2),
                ammTakerBps: Number(process.env.AMM_TAKER_FEE_BPS ?? 25),
                fixedTxCostQuote: Number(process.env.FIXED_TX_COST_QUOTE ?? 0.0006),
            },
            sizing: {
                decisionMinBase: Number(process.env.DECISION_MIN_BASE ?? 0.03),
                tradeSizeBase: Number(process.env.TRADE_SIZE_BASE ?? 0.03),
                cpmmMaxPoolTradeFrac: Number(process.env.CPMM_MAX_POOL_TRADE_FRAC ?? 0.02),
            },
            adapters: { amm: defaultVenue.venue, phoenix: "phoenix" },
        },
    ];
}
