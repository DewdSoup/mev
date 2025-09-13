// services/arb-mm/src/registry/pairs.ts
// Tiny registry loader for scalable, additive pairs/venues.
// Reads PAIRS_JSON (if provided). Falls back to env-based SOL/USDC pair.

import fs from "fs";
import path from "path";

export type PairSpec = {
    /** Human-friendly id; must be unique. */
    id: string; // e.g., "SOL/USDC:raydium<->phoenix"
    baseMint: string; // e.g., WSOL mint
    quoteMint: string; // e.g., USDC mint
    phoenixMarket: string; // phoenix market pubkey
    ammPool: string; // AMM pool id (Raydium CPMM for now)
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
        amm?: "raydium"; // future: "orca", "jupiter", ...
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

export function loadPairsFromEnvOrDefault(): PairSpec[] {
    const p = process.env.PAIRS_JSON?.trim();
    if (p && fs.existsSync(p)) {
        const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
        const j = readJsonMaybe(abs);
        if (Array.isArray(j) && j.length > 0) return j as PairSpec[];
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

    return [
        {
            id: "SOL/USDC:raydium<->phoenix",
            baseMint,
            quoteMint,
            phoenixMarket,
            ammPool,
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
            adapters: { amm: "raydium", phoenix: "phoenix" },
        },
    ];
}
