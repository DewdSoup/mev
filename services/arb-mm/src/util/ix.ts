// services/arb-mm/src/util/ix.ts
import type { TransactionInstruction } from "@solana/web3.js";

export function toIxArray(maybe: any): TransactionInstruction[] {
    if (!maybe) return [];
    if (Array.isArray(maybe)) return maybe.filter(Boolean);
    if (typeof maybe === "object") {
        // Accept common shapes from helpers
        if (Array.isArray((maybe as any).ixs)) return (maybe as any).ixs.filter(Boolean);
        if (Array.isArray((maybe as any).instructions)) return (maybe as any).instructions.filter(Boolean);
    }
    return [];
}

export function assertIxArray(ixs: any, label = "ixs"): asserts ixs is TransactionInstruction[] {
    if (!Array.isArray(ixs)) {
        throw new Error(`${label}_not_array`);
    }
    for (let i = 0; i < ixs.length; i++) {
        const ix: any = ixs[i];
        if (!ix || typeof ix !== "object" || !("programId" in ix) || !Array.isArray(ix.keys)) {
            throw new Error(`${label}[${i}]_not_instruction`);
        }
    }
}
