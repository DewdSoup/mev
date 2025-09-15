import { Connection, VersionedTransaction, Commitment } from '@solana/web3.js';
import { env } from '../../core/src/env';

export type SimResult = {
    ok: boolean;
    err?: string;
    logs?: string[];
    unitsConsumed?: number;
    rpcEffPx?: number | null;
};

export async function simulateAtomicTx(conn: Connection, vtx: VersionedTransaction, accountsToInspect: string[] = [], commitment: Commitment = 'processed'): Promise<SimResult> {
    const cfg: any = {
        replaceRecentBlockhash: true,
        sigVerify: false,
        commitment,
    };
    if (accountsToInspect.length) {
        cfg.accounts = { addresses: accountsToInspect, encoding: 'jsonParsed' };
    }
    const res: any = await (conn as any).simulateTransaction(vtx, cfg);
    const value = res?.value ?? res;
    const logs = value?.logs ?? [];
    const err = value?.err ?? null;
    const unitsConsumed = value?.unitsConsumed;

    // Optional: parse pre/post balances for effPx (if both ATAs present and no err)
    // Keep null if not derivable here; we usually take effPx from our quoters.
    const rpcEffPx = null;

    if (err) {
        const reason = typeof err === 'string' ? err : JSON.stringify(err);
        return { ok: false, err: reason, logs, unitsConsumed, rpcEffPx };
    }
    return { ok: true, logs, unitsConsumed, rpcEffPx };
}
