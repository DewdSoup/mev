import { ComputeBudgetProgram, PublicKey, TransactionInstruction, VersionedTransaction, Connection } from '@solana/web3.js';
import { env } from '../../core/src/env';
import type { Leg } from '../../router/src/types';
import type { AmmAdapter, QuoteResult } from '../../amms/src/adapters/base';

// You already have Phoenix code — expose helpers that return ixs + limit price protection.
async function buildPhoenixLegIxs(leg: any, quotePx: number, payer: PublicKey): Promise<{ ixs: TransactionInstruction[], writeAccounts: PublicKey[] }> {
    // Implement with your Phoenix SDK: IOC taker, limit = quotePx * (1 +/- slippage)
    // Return the ixs and any writable accounts Phoenix needs.
    return { ixs: [], writeAccounts: [] };
}

export async function buildAtomicVtx(
    conn: Connection,
    payer: PublicKey,
    legs: Leg[],
    legQuotes: (QuoteResult | { effPx: number })[],
    cuLimit: number,
    cuPriceMicrolamports: number | undefined
): Promise<{ ixs: TransactionInstruction[], writeAccounts: PublicKey[] }> {

    const cb = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicrolamports ?? 0 }),
    ];

    const ixs: TransactionInstruction[] = [...cb];
    const writeSet: Set<string> = new Set();

    for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (leg.kind === 'amm') {
            const adapter = leg.adapter as AmmAdapter;
            const q = legQuotes[i] as QuoteResult;
            const minOutBufBps = Number(process.env.AMM_MINOUT_BASE_BPS ?? 2);
            const res = await adapter.buildSwapIxs({
                side: leg.side, baseSize: leg.baseSize, maxSlippageBps: leg.maxSlippageBps,
                payer, minOutBufferBps: minOutBufBps
            });
            ixs.push(...res.ixs);
            res.writeAccounts.forEach(a => writeSet.add(a.toBase58()));
        } else {
            const qPx = (legQuotes[i] as any).effPx;
            const res = await buildPhoenixLegIxs(leg, qPx, payer);
            ixs.push(...res.ixs);
            res.writeAccounts.forEach(a => writeSet.add(a.toBase58()));
        }
    }
    return { ixs, writeAccounts: Array.from(writeSet).map(s => new PublicKey(s)) };
}
