// services/arb-mm/src/tx/rpcSim.ts
import {
    Connection,
    VersionedTransaction,
    TransactionMessage,
    PublicKey,
} from '@solana/web3.js';

export type RpcSimResult = {
    ok: boolean;
    err?: string;
    logs?: string[];
    unitsConsumed?: number;
};

export async function rpcSimFn(
    conn: Connection,
    tx: VersionedTransaction
): Promise<RpcSimResult> {
    // IMPORTANT: we do NOT require signatures/funding to simulate
    // - use current blockhash
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');
    (tx.message as any).recentBlockhash = blockhash;

    // Empty signatures, disable sigVerify => wallet can be unfunded
    const res = await conn.simulateTransaction(tx, {
        sigVerify: false,
        commitment: 'processed',
        replaceRecentBlockhash: true,
    });

    if (res.value.err) {
        return {
            ok: false,
            err: JSON.stringify(res.value.err),
            logs: res.value.logs ?? [],
            unitsConsumed: res.value.unitsConsumed,
        };
    }
    return {
        ok: true,
        logs: res.value.logs ?? [],
        unitsConsumed: res.value.unitsConsumed,
    };
}
