// services/arb-mm/src/tx/rpcSim.ts
// RPC simulation for fully-built VersionedTransactions.
// Returns CU usage, logs, and error (if any).

import { Connection, VersionedTransaction } from "@solana/web3.js";

export type RpcTxSimResult = {
    ok: boolean;
    err?: string;
    unitsConsumed?: number;
    logs?: string[];
    returnData?: { programId: string; data: string } | null;
};

export async function rpcSimTx(
    conn: Connection,
    tx: VersionedTransaction,
    opts?: { commitment?: "processed" | "confirmed" | "finalized"; sigVerify?: boolean }
): Promise<RpcTxSimResult> {
    try {
        const commitment = opts?.commitment ?? "processed";
        const sigVerify = opts?.sigVerify ?? true;
        const res = await conn.simulateTransaction(tx, { commitment, sigVerify });

        const value: any = res?.value ?? {};
        const ok = !value?.err;
        const err = value?.err ? (typeof value.err === "string" ? value.err : JSON.stringify(value.err)) : undefined;
        const unitsConsumed = Number(value?.unitsConsumed ?? undefined);
        const logs = Array.isArray(value?.logs) ? value.logs : undefined;

        let returnData: RpcTxSimResult["returnData"] = null;
        if (value?.returnData?.data && value?.returnData?.programId) {
            returnData = {
                programId: String(value.returnData.programId),
                data: Array.isArray(value.returnData.data) ? value.returnData.data.join(",") : String(value.returnData.data),
            };
        }

        return { ok, err, unitsConsumed: Number.isFinite(unitsConsumed) ? unitsConsumed : undefined, logs, returnData };
    } catch (e: any) {
        return { ok: false, err: String(e?.message ?? e) };
    }
}

// Named export used by executor per earlier wiring note
export const rpcSimFn = rpcSimTx;
