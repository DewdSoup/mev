// packages/executor/src/joiners/single_tx.ts (ONLY if you really need it compiled)
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import type { AmmAdapter } from "@mev/amms";           // ensure @mev/amms re-exports this
import type { PhoenixCtx } from "@mev/router";         // ensure @mev/router re-exports this
import { quoteLeg, buildLegIxs } from "../wherever/they/are"; // point to the real module

type Leg =
    | { kind: 'amm', venue: AmmAdapter, side: 'buy' | 'sell', baseSize: number }
    | { kind: 'phoenix', market: PhoenixCtx, side: 'buy' | 'sell', baseSize: number };

export async function buildAtomicTx(legs: [Leg, Leg], opts: {
    payer: PublicKey,
    maxSlippageBps: number,
    minOutBufferBps: number,
    cuLimit: number, cuPriceMicrolamports?: number
}) {
    const [legA, legB] = legs;

    // 1) Compute quotes (these drive minOut & PHX limit price)
    const qa = await quoteLeg(legA, opts);
    const qb = await quoteLeg(legB, opts);

    // 2) Build ix for each leg
    const ixa = await buildLegIxs(legA, qa, opts);
    const ixb = await buildLegIxs(legB, qb, opts);

    // 3) ComputeBudget ixs
    const cb = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.cuPriceMicrolamports ?? 0 }),
    ];

    // 4) Order of legs: choose by dependency (usually buy first, then sell)
    const ixs = [...cb, ...ixa.ixs, ...ixb.ixs];

    return { ixs, quotes: { qa, qb } };
}
