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
  mode: "cpmm-sim-success" | "raydium-swap-ix-failed-fallback" | "cpmm-fallback+noop";
  rpc_eff_px?: number;
  rpc_price_impact_bps?: number;
  rpc_qty_out?: number;
  rpc_units?: number;
  rpc_sim_ms: number;
  logs_tail?: string[];
  reason?: string;
};

export type RaydiumSimErr = {
  mode: "cpmm-sim-error";
  reason: string;
  rpc_sim_ms?: number;
  logs_tail?: string[];
};

export type RaydiumSim = RaydiumSimOk | RaydiumSimErr;

export async function simulateRaydiumSwapFixedIn(
  conn: Connection,
  params: {
    user: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    amountInBase: bigint;
    baseIn: boolean;
    slippageBps: number;
  }
): Promise<RaydiumSim> {
  const t0 = performance.now();
  try {
    const build = buildRaydiumCpmmSwapIx({
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
        rpc_sim_ms: Math.round(performance.now() - t0),
        reason: build.reason,
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

    const simRes = await conn.simulateTransaction(vtx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
      commitment: "processed",
    });

    const ms = Math.round(performance.now() - t0);
    const parsed = parseSim(simRes.value);

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
  const tail = (v?.logs ?? []).slice(-6);
  const computeUnitsConsumed =
    (v as any)?.unitsConsumed ??
    (v as any)?.computeUnitsConsumed ??
    undefined;
  return { tail, computeUnitsConsumed };
}
