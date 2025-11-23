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
    baseDecimals?: number;
    quoteDecimals?: number;
    enabled?: boolean;
    freshness?: {
        slotLagSlots?: number;
        maxAgeMs?: number;
        heartbeatGraceMs?: number;
        tradeableWhenDegraded?: boolean;
    };
};

export type PairSpec = {
    /** Human-friendly id; must be unique. */
    id: string; // e.g., "SOL/USDC:raydium<->phoenix"
    symbol?: string;
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

const NON_EMPTY_STRING = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
};

function formatErrors(source: string, errors: string[]): never {
    const header = `[pairs.json] invalid configuration (${source})`;
    const body = errors.map((e) => ` - ${e}`).join("\n");
    throw new Error(`${header}\n${body}`);
}

function normalizeFreshness(raw: any): PairAmmVenue["freshness"] | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const slotLag = Number(
        (raw as any).slotLag ??
        (raw as any).slotLagSlots ??
        (raw as any).slot_lag ??
        (raw as any).slot_lag_slots
    );
    const maxAge = Number(
        (raw as any).maxAgeMs ??
        (raw as any).max_age_ms
    );
    const heartbeat = Number(
        (raw as any).heartbeatGraceMs ??
        (raw as any).heartbeat_grace_ms ??
        (raw as any).heartbeatMs ??
        (raw as any).heartbeat_ms
    );
    const tradeable = (raw as any).tradeableWhenDegraded ?? (raw as any).tradeable_when_degraded;
    const out: PairAmmVenue["freshness"] = {};
    if (Number.isFinite(slotLag) && slotLag > 0) out.slotLagSlots = Number(slotLag);
    if (Number.isFinite(maxAge) && maxAge > 0) out.maxAgeMs = Number(maxAge);
    if (Number.isFinite(heartbeat) && heartbeat > 0) out.heartbeatGraceMs = Number(heartbeat);
    if (typeof tradeable === "boolean") out.tradeableWhenDegraded = tradeable;
    return Object.keys(out).length ? out : undefined;
}

export function parsePairsConfig(raw: unknown, source = "configs/pairs.json"): PairSpec[] {
    const arr = Array.isArray((raw as any)?.pairs) ? (raw as any).pairs : Array.isArray(raw) ? raw : null;
    if (!arr) {
        throw new Error(`[pairs.json] ${source} must be an array or an object with a "pairs" array`);
    }

    const errors: string[] = [];
    const out: PairSpec[] = [];

    arr.forEach((entry: any, index: number) => {
        const ctx = `${source}[${index}]`;
        if (!entry || typeof entry !== "object") {
            errors.push(`${ctx} must be an object`);
            return;
        }

        const baseMint = NON_EMPTY_STRING((entry as any).baseMint);
        if (!baseMint) errors.push(`${ctx}.baseMint must be a non-empty string`);

        const quoteMint = NON_EMPTY_STRING((entry as any).quoteMint);
        if (!quoteMint) errors.push(`${ctx}.quoteMint must be a non-empty string`);

        const phoenixMarket =
            NON_EMPTY_STRING((entry as any).phoenixMarket) ??
            NON_EMPTY_STRING((entry as any)?.phoenix?.market);
        if (!phoenixMarket) errors.push(`${ctx}.phoenixMarket must be a non-empty string (phoenix.market allowed)`);

        const venuesRaw = Array.isArray((entry as any).venues) ? (entry as any).venues : [];
        if (!venuesRaw.length) {
            errors.push(`${ctx}.venues must contain at least one venue entry`);
            return;
        }

        const venues: PairAmmVenue[] = [];
        venuesRaw.forEach((venueRaw: any, vIndex: number) => {
            const vCtx = `${ctx}.venues[${vIndex}]`;
            if (!venueRaw || typeof venueRaw !== "object") {
                errors.push(`${vCtx} must be an object`);
                return;
            }

            const venueKind = NON_EMPTY_STRING((venueRaw as any).kind ?? (venueRaw as any).venue);
            if (!venueKind) {
                errors.push(`${vCtx}.kind must be a non-empty string`);
                return;
            }

            const kindLower = venueKind.toLowerCase();
            const poolId = NON_EMPTY_STRING((venueRaw as any).id ?? (venueRaw as any).poolId);
            if (kindLower !== "phoenix" && !poolId) {
                errors.push(`${vCtx}.id must be provided for venue kind "${venueKind}"`);
                return;
            }

            const baseDecimalsRaw = (venueRaw as any).baseDecimals ?? (venueRaw as any).base_decimals;
            const quoteDecimalsRaw = (venueRaw as any).quoteDecimals ?? (venueRaw as any).quote_decimals;
            const feeBpsRaw = (venueRaw as any).feeBps ?? (venueRaw as any).fee_bps;

            venues.push({
                venue: kindLower,
                poolId: poolId ?? "",
                poolKind: NON_EMPTY_STRING((venueRaw as any).poolKind ?? (venueRaw as any).pool_kind) ?? undefined,
                feeBps: Number.isFinite(Number(feeBpsRaw)) ? Number(feeBpsRaw) : undefined,
                baseDecimals: Number.isFinite(Number(baseDecimalsRaw)) ? Number(baseDecimalsRaw) : undefined,
                quoteDecimals: Number.isFinite(Number(quoteDecimalsRaw)) ? Number(quoteDecimalsRaw) : undefined,
                enabled: typeof (venueRaw as any).enabled === "boolean" ? (venueRaw as any).enabled : undefined,
                freshness: normalizeFreshness((venueRaw as any).freshness),
            });
        });

        const ammVenues = venues.filter((v) => v.venue !== "phoenix" && v.poolId && v.enabled !== false);
        const primary = ammVenues[0];
        if (!primary) {
            errors.push(`${ctx}.venues must include at least one enabled non-phoenix venue`);
        }

        const id =
            NON_EMPTY_STRING((entry as any).id) ??
            NON_EMPTY_STRING((entry as any).symbol) ??
            (phoenixMarket && primary ? `${phoenixMarket}:${primary.poolId}` : null);

        if (baseMint && quoteMint && phoenixMarket && primary) {
            out.push({
                id: id ?? `${phoenixMarket}:${primary.poolId}`,
                symbol: NON_EMPTY_STRING((entry as any).symbol) ?? (id ?? `${phoenixMarket}:${primary.poolId}`),
                baseMint,
                quoteMint,
                phoenixMarket,
                ammPool: primary.poolId,
                ammVenues,
                fees: (entry as any).fees,
                sizing: (entry as any).sizing,
                adapters: { amm: primary.venue, phoenix: "phoenix" },
            });
        }
    });

    if (errors.length) {
        formatErrors(source, errors);
    }
    if (!out.length) {
        throw new Error(`[pairs.json] ${source} produced no enabled pairs after validation`);
    }
    return out;
}

export function loadPairsFromEnvOrDefault(): PairSpec[] {
    const fromEnv = process.env.PAIRS_JSON?.trim();
    if (fromEnv && fs.existsSync(fromEnv)) {
        const abs = path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
        const parsed = readJsonMaybe(abs);
        if (parsed != null) return parsePairsConfig(parsed, abs);
    }

    const defaultPath = path.resolve(process.cwd(), "configs", "pairs.json");
    if (fs.existsSync(defaultPath)) {
        const parsed = readJsonMaybe(defaultPath);
        if (parsed != null) return parsePairsConfig(parsed, defaultPath);
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
            symbol: "SOL/USDC",
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
