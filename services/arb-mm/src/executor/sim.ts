// services/arb-mm/src/executor/sim.ts
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  SimulatedTransactionResponse,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { buildRaydiumCpmmSwapIx } from "./buildRaydiumCpmmIx.js";

export type RaydiumSimOk = {
  mode: "cpmm-sim-success";
  rpc_units?: number;
  rpc_sim_ms: number;
  logs_tail?: string[];
};
export type RaydiumSimErr = {
  mode: "cpmm-sim-error" | "raydium-swap-ix-failed-fallback";
  reason: string;
  rpc_sim_ms?: number;
  logs_tail?: string[];
};
export type RaydiumSim = RaydiumSimOk | RaydiumSimErr;

export async function simulateRaydiumSwapFixedIn(
  conn: Connection,
  params: {
    user: PublicKey;
    amountInBase: bigint; // atoms of *input* mint
    baseIn: boolean;
    slippageBps: number;
    baseMint?: PublicKey;
    quoteMint?: PublicKey;
  }
): Promise<RaydiumSim> {
  const t0 = performance.now();
  try {
    const build = await buildRaydiumCpmmSwapIx({
      user: params.user,
      baseMint: params.baseMint,
      quoteMint: params.quoteMint,
      baseIn: params.baseIn,
      amountInBase: params.amountInBase,
      slippageBps: params.slippageBps,
    });

    if (!build.ok) {
      return {
        mode: "raydium-swap-ix-failed-fallback",
        reason: build.reason,
        rpc_sim_ms: Math.round(performance.now() - t0),
      };
    }

    const { blockhash } = await conn.getLatestBlockhash("processed");
    const msg = new TransactionMessage({
      payerKey: params.user,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ...build.ixs,
      ],
    }).compileToV0Message();

    const vtx = new VersionedTransaction(msg);
    const sim = await conn.simulateTransaction(vtx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
      commitment: "processed",
    });

    const ms = Math.round(performance.now() - t0);
    const parsed = parseSim(sim.value);

    if (sim.value?.err) {
      return {
        mode: "cpmm-sim-error",
        reason:
          typeof sim.value.err === "string"
            ? sim.value.err
            : JSON.stringify(sim.value.err),
        rpc_sim_ms: ms,
        logs_tail: parsed.tail,
      };
    }

    return {
      mode: "cpmm-sim-success",
      rpc_units: parsed.computeUnitsConsumed ?? undefined,
      rpc_sim_ms: ms,
      logs_tail: parsed.tail,
    };
  } catch (e: any) {
    return {
      mode: "cpmm-sim-error",
      reason: String(e?.message ?? e),
      rpc_sim_ms: Math.round(performance.now() - t0),
    };
  }
}

function parseSim(v: SimulatedTransactionResponse) {
  const tail = (v?.logs ?? []).slice(-8);
  const computeUnitsConsumed =
    (v as any)?.unitsConsumed ??
    (v as any)?.computeUnitsConsumed ??
    (v as any)?.meta?.computeUnitsConsumed ??
    undefined;
  return { tail, computeUnitsConsumed };
}
