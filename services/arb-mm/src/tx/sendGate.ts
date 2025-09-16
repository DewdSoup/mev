// services/arb-mm/src/tx/sendGate.ts
// "Are we allowed to broadcast?" guard.
// Skips sends when USE_RPC_SIM=1, or when SOL balance is below threshold.

import { Connection, PublicKey } from "@solana/web3.js";

type GateOpts = {
    env?: NodeJS.ProcessEnv;
    owner: PublicKey;
    minLamports?: number; // override
};

export async function canActuallySendNow(
    conn: Connection,
    opts: GateOpts
): Promise<boolean> {
    const env = opts.env ?? process.env;

    // Explicit sim-only mode wins.
    const USE_RPC_SIM = String(env.USE_RPC_SIM ?? "").trim().toLowerCase();
    if (USE_RPC_SIM === "1" || USE_RPC_SIM === "true" || USE_RPC_SIM === "yes") {
        return false;
    }

    // Default threshold: 0.01 SOL (adjust via SENDGATE_MIN_SOL_LAMPORTS)
    const defaultMin = 10_000_000; // 0.01 SOL
    const minLamports = Number(env.SENDGATE_MIN_SOL_LAMPORTS ?? opts.minLamports ?? defaultMin);
    const bal = await conn.getBalance(opts.owner, "confirmed").catch(() => 0);

    if (!Number.isFinite(minLamports) || minLamports <= 0) {
        // No minimum configured → allow send (as long as not in sim-only mode).
        return true;
    }
    return bal >= minLamports;
}
