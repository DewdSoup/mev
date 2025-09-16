import {
    ComputeBudgetProgram,
    PublicKey,
    TransactionInstruction,
    Connection,
} from '@solana/web3.js';
import type { Leg } from '../../router/dist/types.js';
import type { AmmAdapter } from '../../amms/dist/adapters/base.js';

// Minimal local shape for leg quotes we actually consume
type QuoteResult = {
    effPx?: number; // effective price if precomputed
    ixs?: TransactionInstruction[];
    writeAccounts?: PublicKey[];
};

function envNum(name: string, def?: number): number | undefined {
    const v = process.env[name];
    if (v == null || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

// You already have Phoenix code — expose helpers that return ixs + limit price protection.
async function buildPhoenixLegIxs(
    _leg: any,
    _quotePx: number,
    _payer: PublicKey
): Promise<{ ixs: TransactionInstruction[]; writeAccounts: PublicKey[] }> {
    // Implement with your Phoenix SDK: IOC taker, limit = quotePx * (1 +/- slippage)
    // Return the ixs and any writable accounts Phoenix needs.
    return { ixs: [], writeAccounts: [] };
}

export async function buildAtomicVtx(
    _conn: Connection,
    payer: PublicKey,
    legs: Leg[],
    legQuotes: (QuoteResult | { effPx: number })[],
    cuLimit: number,
    cuPriceMicrolamports: number | undefined
): Promise<{ ixs: TransactionInstruction[]; writeAccounts: PublicKey[] }> {
    const cb = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: cuPriceMicrolamports ?? 0,
        }),
    ];

    const ixs: TransactionInstruction[] = [...cb];
    const writeSet: Set<string> = new Set();

    // Fallback to env without depending on typed `env.*`
    const minOutBufBps =
        envNum('AMM_MINOUT_BASE_BPS') ??
        envNum('RAYDIUM_MINOUT_BUFFER_BPS') ??
        2;

    for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (leg.kind === 'amm') {
            const adapter = leg.adapter as AmmAdapter;

            // Adapter builds its own swap with provided params
            const res = await (adapter as any).buildSwapIxs({
                side: (leg as any).side,
                baseSize: (leg as any).baseSize,
                maxSlippageBps: (leg as any).maxSlippageBps,
                payer,
                minOutBufferBps: minOutBufBps,
            });

            ixs.push(...((res?.ixs as TransactionInstruction[]) ?? []));
            (res?.writeAccounts ?? []).forEach((a: PublicKey) =>
                writeSet.add(a.toBase58())
            );
        } else {
            const qPx = (legQuotes[i] as any).effPx;
            const res = await buildPhoenixLegIxs(leg, qPx, payer);
            ixs.push(...res.ixs);
            res.writeAccounts.forEach((a) => writeSet.add(a.toBase58()));
        }
    }

    return {
        ixs,
        writeAccounts: Array.from(writeSet).map((s) => new PublicKey(s)),
    };
}
