export type Fees = { takerBps: number; tipLamports: bigint; prioLamports: bigint };
export function evBps(proceeds: bigint, cost: bigint, feesLamports: bigint, pxQ: bigint): number {
    // returns EV in basis points of notional (pxQ)
    const pnl = Number(proceeds - cost - feesLamports);
    return 1e4 * pnl / Number(pxQ);
}
