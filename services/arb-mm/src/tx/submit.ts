// services/arb-mm/src/tx/submit.ts
import type {
    Connection,
    PublicKey,
    TransactionInstruction,
    Signer,
    AddressLookupTableAccount,
} from '@solana/web3.js';
import {
    VersionedTransaction,
    TransactionMessage,
    ComputeBudgetProgram,
} from '@solana/web3.js';

export function buildPreIxs(
    units = 400_000,
    microLamports?: number
): TransactionInstruction[] {
    const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units })
    ];
    if (typeof microLamports === 'number') {
        ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    }
    return ixs;
}

// Safety guard: only the wallet should be a signer.
function assertOnlyOwnerSigns(ixs: TransactionInstruction[], owner: PublicKey) {
    const want = owner.toBase58();
    const signers = new Set<string>();
    for (const ix of ixs) {
        for (const k of ix.keys) {
            if (k.isSigner) signers.add(k.pubkey.toBase58());
        }
    }
    const unexpected = [...signers].filter(s => s !== want);
    if (unexpected.length) {
        throw new Error(`Unexpected signer(s): ${unexpected.join(', ')}`);
    }
}

export async function submitAtomic(params: {
    connection: Connection;
    owner: Signer & { publicKey: PublicKey };
    preIxs?: TransactionInstruction[];
    phxIxs: TransactionInstruction[];
    rayIxs: TransactionInstruction[];
    only?: 'phx' | 'ray' | 'both';
    lookupTableAccounts?: AddressLookupTableAccount[];
}): Promise<string> {
    const {
        connection,
        owner,
        preIxs = buildPreIxs(),
        phxIxs,
        rayIxs,
        only = 'both',
        lookupTableAccounts = [],
    } = params;

    const body =
        only === 'phx' ? [...preIxs, ...phxIxs]
            : only === 'ray' ? [...preIxs, ...rayIxs]
                : [...preIxs, ...phxIxs, ...rayIxs];

    // Catch signer mismatches (prevents opaque “Uint8Array overrun” errors)
    assertOnlyOwnerSigns(body, owner.publicKey);

    const { blockhash } = await connection.getLatestBlockhash('finalized');
    const msgV0 = new TransactionMessage({
        payerKey: owner.publicKey,
        recentBlockhash: blockhash,
        instructions: body,
    }).compileToV0Message(lookupTableAccounts);

    const tx = new VersionedTransaction(msgV0);
    tx.sign([owner]); // exactly one signer

    const sig = await connection.sendTransaction(tx, {
        preflightCommitment: 'processed',
        maxRetries: 3,
    });
    return sig;
}
