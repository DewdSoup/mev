// services/arb-mm/src/executor/sim.ts
// Raydium CPMM fixed-in RPC simulation—timing/CU oriented.
// We only measure RPC timing/CU; effective price fields are optional.

import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  SimulatedTransactionResponse,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { buildRaydiumCpmmSwapIx, type BuildSwapIxParams } from "./buildRaydiumCpmmIx.js";

export type RaydiumSimOk = {
  mode: "cpmm-sim-success";
  rpc_units?: number;
  rpc_sim_ms: number;
  logs_tail?: string[];
  rpc_eff_px?: number;            // optional; joiner tolerates absence
  rpc_price_impact_bps?: number;  // optional
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
    /** atoms of input mint (SOL if baseIn, USDC if !baseIn) */
    amountInBase: bigint;
    baseIn: boolean;
    slippageBps: number;
    baseMint?: PublicKey;
    quoteMint?: PublicKey;
    usdcMint?: string;
    wsolMint?: string;
  }
): Promise<RaydiumSim> {
  const t0 = performance.now();

  try {
    // IMPORTANT: The builder expects amountInBase = atoms of the *input* mint.
    // Do NOT switch to amountInQuote; use baseIn to indicate the side.
    const buildArgs: BuildSwapIxParams = {
      user: params.user,
      baseIn: params.baseIn,
      amountInBase: params.amountInBase,
      slippageBps: params.slippageBps,
      // baseMint/quoteMint are accepted but currently not used by the builder
      baseMint: params.baseMint,
      quoteMint: params.quoteMint,
    };

    const build = await buildRaydiumCpmmSwapIx(buildArgs);

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
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
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
      // rpc_eff_px / rpc_price_impact_bps are optional and can be omitted
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
  const tail = (v?.logs ?? []).slice(-10);
  const computeUnitsConsumed =
    (v as any)?.unitsConsumed ??
    (v as any)?.computeUnitsConsumed ??
    (v as any)?.meta?.computeUnitsConsumed ??
    undefined;
  return { tail, computeUnitsConsumed };
}
