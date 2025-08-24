// packages/phoenix/src/ensureIxArray.ts (or inline in the builder)
import { TransactionInstruction } from "@solana/web3.js";

export type PhoenixBuild =
    | TransactionInstruction
    | TransactionInstruction[]
    | { ixs?: TransactionInstruction[] }
    | { placeIxs?: TransactionInstruction[]; settleIxs?: TransactionInstruction[] };

export function ensureIxArray(x: PhoenixBuild): TransactionInstruction[] {
    if (Array.isArray(x)) return x;
    const anyx = x as any;
    if (anyx?.ixs) return anyx.ixs as TransactionInstruction[];
    const place = (anyx?.placeIxs ?? []) as TransactionInstruction[];
    const settle = (anyx?.settleIxs ?? []) as TransactionInstruction[];
    if (place.length || settle.length) return [...place, ...settle];
    return [x as TransactionInstruction];
}
