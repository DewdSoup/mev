// packages/amms/src/adapters/orca.ts
// Orca Whirlpool adapter: decode Whirlpool account, read vaults, and expose mid/reserves.
// For CLMMs, the true mid must come from sqrtPrice (Q64.64). Vault ratios are NOT price.

import { Connection, PublicKey } from "@solana/web3.js";
import type { AmmAdapter, ReserveSnapshot } from "./types.js";
import {
    WHIRLPOOL_CODER,
    type WhirlpoolData,
} from "@orca-so/whirlpools-sdk";

// Common mints (override via env if needed)
const WSOL_MINT = new PublicKey(
    process.env.WSOL_MINT ?? "So11111111111111111111111111111111111111112"
);
const USDC_MINT = new PublicKey(
    process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

/** Convert Q64.64 sqrt price (as bigint) → atoms ratio (tokenB atoms per tokenA atom). */
function atomsRatioFromSqrtQ64_64(sqrtX64: bigint): number {
    // price_atoms = (sqrtX64^2) / 2^128
    const sq = sqrtX64 * sqrtX64; // 256-bit bigint
    const ONE_128 = 1n << 128n;
    const intPart = sq / ONE_128;
    const fracPart = sq % ONE_128;
    return Number(intPart) + Number(fracPart) / Number(ONE_128);
}

/** Read & decode Whirlpool account via the SDK coder. */
async function readWhirlpool(
    conn: Connection,
    poolPk: PublicKey
): Promise<WhirlpoolData> {
    const acct = await conn.getAccountInfo(poolPk, "processed");
    if (!acct?.data) throw new Error("orca_whirlpool_not_found");
    const decoded = WHIRLPOOL_CODER.decode("Whirlpool", acct.data) as WhirlpoolData;
    if (!decoded) throw new Error("orca_whirlpool_decode_failed");
    return decoded;
}

/** Resolve SPL Mint decimals with fast-paths for WSOL/USDC. */
async function resolveMintDecimals(conn: Connection, mint: PublicKey): Promise<number> {
    const a = mint.toBase58();
    if (a === WSOL_MINT.toBase58()) return 9;
    if (a === USDC_MINT.toBase58()) return 6;

    // Try parsed RPC first
    try {
        const info = await conn.getParsedAccountInfo(mint, "processed");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dec = (info.value?.data as any)?.parsed?.info?.decimals;
        if (typeof dec === "number") return dec;
    } catch {
        /* fall through */
    }

    // Fallback: raw layout — decimals at byte 44 for SPL Mint
    try {
        const raw = await conn.getAccountInfo(mint, "processed");
        if (raw?.data && raw.data.length >= 45) return raw.data.readUInt8(44);
    } catch {
        /* ignore */
    }

    // Last resort
    return 9;
}

type CachedPoolData = {
    tokenMintA: PublicKey;
    tokenMintB: PublicKey;
    tokenVaultA: PublicKey;
    tokenVaultB: PublicKey;
    baseIsA: boolean; // true if A==WSOL & B==USDC (or if inferred that A is base)
    baseDecimals: number;
    quoteDecimals: number;
};

/**
 * Build an Orca Whirlpool adapter for a given pool.
 * - Keeps symbol "SOL/USDC" for downstream compatibility.
 * - Orients base (WSOL) & quote (USDC) regardless of A/B order on-chain.
 */
export async function createOrcaAdapter(
    conn: Connection,
    poolId: string
): Promise<AmmAdapter> {
    const poolPk = new PublicKey(poolId);

    // Cache immutable pool data and orientation after first fetch
    let cached: CachedPoolData | undefined;

    async function ensureCache(): Promise<CachedPoolData> {
        if (cached) return cached;

        const w = await readWhirlpool(conn, poolPk);

        const aMint = w.tokenMintA;
        const bMint = w.tokenMintB;

        const aIsWsol = aMint.equals(WSOL_MINT);
        const bIsWsol = bMint.equals(WSOL_MINT);
        const aIsUsdc = aMint.equals(USDC_MINT);
        const bIsUsdc = bMint.equals(USDC_MINT);

        // Prefer exact SOL/USDC orientation when those mints are present.
        const baseIsA =
            (aIsWsol && bIsUsdc) ? true :
                (aIsUsdc && bIsWsol) ? false :
                    true; // default A as base

        const baseMint = baseIsA ? aMint : bMint;
        const quoteMint = baseIsA ? bMint : aMint;

        const [baseDecimals, quoteDecimals] = await Promise.all([
            resolveMintDecimals(conn, baseMint),
            resolveMintDecimals(conn, quoteMint),
        ]);

        cached = {
            tokenMintA: w.tokenMintA,
            tokenMintB: w.tokenMintB,
            tokenVaultA: w.tokenVaultA,
            tokenVaultB: w.tokenVaultB,
            baseIsA,
            baseDecimals,
            quoteDecimals,
        };
        return cached;
    }

    const adapter: AmmAdapter = {
        symbol: "SOL/USDC",
        venue: "orca",
        id: poolId,

        /** Raw vault balances as atoms (still useful for telemetry but NOT for price). */
        async reservesAtoms(): Promise<ReserveSnapshot> {
            const c = await ensureCache();

            // Pick vaults in base/quote order for reporting
            const baseVault = c.baseIsA ? c.tokenVaultA : c.tokenVaultB;
            const quoteVault = c.baseIsA ? c.tokenVaultB : c.tokenVaultA;

            const accs = await conn.getMultipleAccountsInfo(
                [baseVault, quoteVault],
                { commitment: "processed" }
            );
            if (!accs[0]?.data || !accs[1]?.data) throw new Error("orca_vaults_missing");

            // SPL Token Account amount at offset 64 (u64 little-endian)
            const base = accs[0].data.readBigUInt64LE(64);
            const quote = accs[1].data.readBigUInt64LE(64);

            return {
                base,
                quote,
                baseDecimals: c.baseDecimals,
                quoteDecimals: c.quoteDecimals,
            };
        },

        /**
         * CLMM mid from sqrtPriceX64 (QUOTE per BASE, UI units).
         * Derivation:
         *  - atoms ratio  (quote_atoms / base_atoms)  = (sqrt^2) / 2^128
         *  - UI ratio     (QUOTE per BASE)            = atoms_ratio * 10^(baseDecimals - quoteDecimals)
         *  - If base == tokenB on-chain, invert atoms_ratio first.
         */
        async mid(): Promise<number> {
            const c = await ensureCache();
            const w = await readWhirlpool(conn, poolPk);
            const sqrt = BigInt(w.sqrtPrice.toString());

            // atoms ratio of "B per A" in the on-chain ordering
            const atomsBperA = atomsRatioFromSqrtQ64_64(sqrt);

            // We want atomsQuote per atomsBase
            const atomsQuotePerAtomsBase = c.baseIsA ? atomsBperA : (atomsBperA > 0 ? 1 / atomsBperA : 0);

            // Convert to UI units (USDC per SOL)
            const scale = Math.pow(10, c.baseDecimals - c.quoteDecimals); // 10^(9-6)=1000
            const px = atomsQuotePerAtomsBase * scale;

            return Number.isFinite(px) && px > 0 ? px : 0;
        },
    };

    return adapter;
}
