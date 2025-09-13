export type CpmmState = {
    kind: "cpmm";
    baseReserves: bigint;
    quoteReserves: bigint;
    feeBps: number;
};

export type ClmmState = {
    kind: "clmm";
    sqrtPriceX64: bigint;
    liquidity: bigint;
    feeBps: number;
    // optional: cached tick arrays for offline quoting
};

export type AmmState = CpmmState | ClmmState;

/**
 * Exact-in CPMM quote (k = x*y). Returns average price impact and out atoms.
 * NOTE: amountInBase is "atoms of the input mint"; when baseIn=false, it's atoms of QUOTE.
 */
export function quoteCpmmExactIn(
    s: CpmmState,
    baseIn: boolean,
    amountInBase: bigint
): { ok: true; outAtoms: bigint; priceImpactBps: number; feeBps: number } {
    const fee = s.feeBps / 10_000;
    if (baseIn) {
        const x = Number(s.baseReserves);
        const y = Number(s.quoteReserves);
        const dx = Number(amountInBase);
        const dxAfterFee = dx * (1 - fee);
        const k = x * y;
        const x1 = x + dxAfterFee;
        const y1 = k / x1;
        const dy = y - y1;
        const outAtoms = BigInt(Math.floor(dy));
        const mid = y / x;
        const eff = dy / dxAfterFee;
        const priceImpactBps = (eff / mid - 1) * 10_000;
        return { ok: true, outAtoms, priceImpactBps, feeBps: s.feeBps };
    } else {
        const x = Number(s.quoteReserves);
        const y = Number(s.baseReserves);
        const dx = Number(amountInBase);
        const dxAfterFee = dx * (1 - fee);
        const k = x * y;
        const x1 = x + dxAfterFee;
        const y1 = k / x1;
        const dy = y - y1;
        const outAtoms = BigInt(Math.floor(dy));
        const mid = y / x;
        const eff = dy / dxAfterFee;
        const priceImpactBps = (eff / mid - 1) * 10_000;
        return { ok: true, outAtoms, priceImpactBps, feeBps: s.feeBps };
    }
}

/**
 * CLMM quoting is deferred until you wire cached tick arrays or an SDK quoter.
 * We still carry feeBps in state so downstream EV math remains exact where used.
 */
export function quoteClmmExactIn(
    _s: ClmmState,
    _baseIn: boolean,
    _amountInBase: bigint
): { ok: false; reason: string } {
    return { ok: false, reason: "clmm_quote_not_wired" };
}
