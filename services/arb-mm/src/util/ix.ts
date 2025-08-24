// services/arb-mm/src/util/ix.ts
import {
    PublicKey,
    TransactionInstruction,
    VersionedTransaction,
    Transaction,
} from "@solana/web3.js";

function isTxIx(x: any): x is TransactionInstruction {
    return (
        x &&
        x.programId instanceof PublicKey &&
        Array.isArray(x.keys) &&
        x.data instanceof Uint8Array
    );
}

function extractIxs(x: any): TransactionInstruction[] {
    if (!x) return [];
    if (Array.isArray(x)) return x.flatMap(extractIxs);
    if (isTxIx(x)) return [x];

    // Raydium SDK “innerTransactions” shape
    if (Array.isArray(x?.innerTransactions)) {
        const out: TransactionInstruction[] = [];
        for (const itx of x.innerTransactions) {
            if (Array.isArray(itx?.instructions)) {
                out.push(...itx.instructions.filter(isTxIx));
            }
        }
        return out;
    }

    // Common wrappers
    if (Array.isArray(x?.instructions)) return x.instructions.filter(isTxIx);
    if (x?.ix) return extractIxs(x.ix);
    if (x?.ixs) return extractIxs(x.ixs);

    // If someone handed us a Transaction/VersionedTransaction, don’t guess.
    if (x instanceof Transaction || x instanceof VersionedTransaction) return [];

    return [];
}

export function toIxArray(x: any): TransactionInstruction[] {
    return extractIxs(x).filter(isTxIx);
}

export function assertIxArray(ixs: TransactionInstruction[], where = "unknown"): void {
    const bad = ixs.findIndex((ix) => !isTxIx(ix));
    if (bad !== -1) {
        const sample = ixs[bad] as any;
        const keys = sample ? Object.keys(sample) : [];
        throw new Error(`invalid_instruction_shape at index ${bad} in ${where}; keys=${keys.join(",")}`);
    }
}
