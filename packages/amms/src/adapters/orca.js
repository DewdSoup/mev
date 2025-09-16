// packages/amms/src/adapters/orca.ts
// Orca Whirlpool adapter: decode Whirlpool account, read vaults, and expose mid/reserves/fee.
// For CLMMs, the true mid must come from sqrtPrice (Q64.64). Vault ratios are NOT price.
import { PublicKey } from "@solana/web3.js";
import { WHIRLPOOL_CODER } from "@orca-so/whirlpools-sdk";
// Common mints (override via env if needed)
const WSOL_MINT = new PublicKey(process.env.WSOL_MINT ?? "So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey(process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/** Convert Q64.64 sqrt price (as bigint) → atoms ratio (tokenB atoms per tokenA atom). */
function atomsRatioFromSqrtQ64_64(sqrtX64) {
    const sq = sqrtX64 * sqrtX64; // 256-bit bigint
    const ONE_128 = 1n << 128n;
    const intPart = sq / ONE_128;
    const fracPart = sq % ONE_128;
    return Number(intPart) + Number(fracPart) / Number(ONE_128);
}
/** Read & decode Whirlpool account via the SDK coder. */
async function readWhirlpool(conn, poolPk) {
    const acct = await conn.getAccountInfo(poolPk, "processed");
    if (!acct?.data)
        throw new Error("orca_whirlpool_not_found");
    const decoded = WHIRLPOOL_CODER.decode("Whirlpool", acct.data);
    if (!decoded)
        throw new Error("orca_whirlpool_decode_failed");
    return decoded;
}
/** Resolve SPL Mint decimals with fast-paths for WSOL/USDC. */
async function resolveMintDecimals(conn, mint) {
    const a = mint.toBase58();
    if (a === WSOL_MINT.toBase58())
        return 9;
    if (a === USDC_MINT.toBase58())
        return 6;
    // Try parsed RPC first
    try {
        const info = await conn.getParsedAccountInfo(mint, "processed");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dec = info.value?.data?.parsed?.info?.decimals;
        if (typeof dec === "number")
            return dec;
    }
    catch { /* fall through */ }
    // Fallback: raw layout — decimals at byte 44 for SPL Mint
    try {
        const raw = await conn.getAccountInfo(mint, "processed");
        if (raw?.data && raw.data.length >= 45)
            return raw.data.readUInt8(44);
    }
    catch { /* ignore */ }
    return 9; // last resort
}
export async function createOrcaAdapter(conn, poolId) {
    const poolPk = new PublicKey(poolId);
    let cached;
    async function ensureCache() {
        if (cached)
            return cached;
        const w = await readWhirlpool(conn, poolPk);
        const aMint = w.tokenMintA;
        const bMint = w.tokenMintB;
        const aIsWsol = aMint.equals(WSOL_MINT);
        const bIsWsol = bMint.equals(WSOL_MINT);
        const aIsUsdc = aMint.equals(USDC_MINT);
        const bIsUsdc = bMint.equals(USDC_MINT);
        // Prefer exact SOL/USDC orientation when those mints are present.
        const baseIsA = (aIsWsol && bIsUsdc) ? true :
            (aIsUsdc && bIsWsol) ? false :
                true; // default A as base
        const baseMint = baseIsA ? aMint : bMint;
        const quoteMint = baseIsA ? bMint : aMint;
        const [baseDecimals, quoteDecimals] = await Promise.all([
            resolveMintDecimals(conn, baseMint),
            resolveMintDecimals(conn, quoteMint),
        ]);
        // feeRate is hundredths of a basis point (e.g., 3000 -> 30 bps)
        const feeBps = Number(w.feeRate ?? 0) / 100;
        cached = {
            tokenMintA: w.tokenMintA,
            tokenMintB: w.tokenMintB,
            tokenVaultA: w.tokenVaultA,
            tokenVaultB: w.tokenVaultB,
            baseIsA,
            baseDecimals,
            quoteDecimals,
            feeBps: Number.isFinite(feeBps) && feeBps > 0 ? feeBps : undefined,
        };
        return cached;
    }
    const adapter = {
        symbol: "SOL/USDC",
        venue: "orca",
        id: poolId,
        async feeBps() {
            const c = await ensureCache();
            if (c.feeBps && c.feeBps > 0)
                return c.feeBps;
            return Number(process.env.ORCA_TRADE_FEE_BPS ?? process.env.AMM_TAKER_FEE_BPS ?? 30);
        },
        // For CLMMs: publish vault balances only for telemetry if you really need to.
        // We’ll still compute price purely from sqrtPrice.
        async reservesAtoms() {
            const c = await ensureCache();
            // Report empty reserves to discourage CPMM usage downstream for Orca (price comes from mid()).
            return {
                base: 0n,
                quote: 0n,
                baseDecimals: c.baseDecimals,
                quoteDecimals: c.quoteDecimals,
            };
        },
        /** CLMM mid from sqrtPriceX64 (QUOTE per BASE, UI units). */
        async mid() {
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
