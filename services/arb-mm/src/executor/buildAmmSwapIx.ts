// services/arb-mm/src/executor/buildAmmSwapIx.ts
import type { PublicKey, TransactionInstruction, Connection } from "@solana/web3.js";
import { buildRaydiumSwapIx } from "../util/raydium.js";          // <-- use util version
import { buildOrcaWhirlpoolSwapIx } from "./buildOrcaWhirlpoolIx.js";

export type AmmBuildResult =
    | { ok: true; ixs: TransactionInstruction[] }
    | { ok: false; reason: string };

export async function buildAmmSwapIx(params: {
    connection?: Connection;
    venue: "raydium" | "orca";
    user: PublicKey;
    poolId?: string;                 // optional (Raydium util reads env/disk)
    baseIn: boolean;                 // true => BASE->QUOTE ; false => QUOTE->BASE
    amountInAtoms: bigint;           // atoms of the *input* mint
    slippageBps: number;
}): Promise<AmmBuildResult> {
    if (params.venue === "raydium") {
        const out = await buildRaydiumSwapIx({
            user: params.user,
            baseIn: params.baseIn,
            amountInBase: params.amountInAtoms,
            slippageBps: params.slippageBps,
        });
        return out.ok ? { ok: true, ixs: out.ixs } : { ok: false, reason: out.reason };
    } else {
        return await buildOrcaWhirlpoolSwapIx({
            connection: params.connection,
            user: params.user,
            poolId: params.poolId ?? String(process.env.ORCA_POOL_ID ?? ""),
            baseIn: params.baseIn,
            amountInAtoms: params.amountInAtoms,
            slippageBps: params.slippageBps,
        });
    }
}
