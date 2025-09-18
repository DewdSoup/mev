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
export async function createRaydiumClmmAdapter(conn: Connection, poolId: string): Promise<AmmAdapter> {
    // Discover pair metadata from configs (symbol & mints help with decimals and logging).
    const meta = findPairForPool(poolId) ?? {};
    const symbol = meta.symbol || "UNKNOWN/UNKNOWN";
    let _conn: Connection | undefined = conn;

    // Pre-fetch decimals (best-effort). Typical SOL/USDC defaults keep us safe if not found.
    const baseDecimals = await fetchMintDecimals(conn, meta.baseMint, 9);
    const quoteDecimals = await fetchMintDecimals(conn, meta.quoteMint, 6);

    // Best-effort mid(): computing from on-chain sqrtPriceX64 would require exact layout decode.
    // For Step 2 we can safely return NaN — publisher still emits a line (joiner ignores invalid px).
    async function mid(): Promise<number> {
        // TODO (Step 2.5/3): parse Raydium CLMM pool account layout and compute from sqrtPriceX64.
        // Return NaN for now (keeps this adapter inert but visible).
        return Number.NaN;
    }

    // Fee decode: Raydium CLMM stores feeRate in 1e6 scale (ppm). Convert to bps if available.
    // Without a layout parser, fall back to any hint injected by the registry, or env.
    async function feeBps(): Promise<number> {
        const hint = (adapter as any).__hintFeeBps;
        if (Number.isFinite(hint)) return Number(hint);
        // conservative fallbacks; will be overridden later when we wire exact decode
        const env = process.env.RAYDIUM_TRADE_FEE_BPS ?? process.env.AMM_TAKER_FEE_BPS ?? "25";
        const n = Number(env);
        return Number.isFinite(n) ? n : 25;
    }

    async function reservesAtoms(): Promise<ReserveSnapshot> {
        // DO NOT leak CLMM vault balances — they are not CPMM-compatible.
        // Return zeros with correct decimals; publisher will suppress base_int/quote_int for CLMM anyway.
        return {
            base: 0n,
            quote: 0n,
            baseDecimals,
            quoteDecimals,
        };
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
