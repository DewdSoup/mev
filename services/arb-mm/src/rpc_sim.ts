// services/arb-mm/src/rpc_sim.ts
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { buildRaydiumCpmmSwapIx } from "./executor/buildRaydiumCpmmIx.js";

export type SimIn = {
  user: PublicKey;
  baseIn: boolean;           // true SOL->USDC, false USDC->SOL
  amountInAtoms: bigint;     // atoms of *input* mint
  slippageBps: number;
};

export async function simRaydiumFixedInTx(
  conn: Connection,
  p: SimIn
) {
  const build = await buildRaydiumCpmmSwapIx({
    user: p.user,
    baseIn: p.baseIn,
    amountInBase: p.amountInAtoms,
    slippageBps: p.slippageBps,
  });
  if (!build.ok) return { ok: false as const, reason: build.reason };

  const { blockhash } = await conn.getLatestBlockhash("processed");
  const msg = new TransactionMessage({
    payerKey: p.user,
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

  return {
    ok: !sim.value?.err,
    err: sim.value?.err ?? null,
    logs_tail: (sim.value?.logs ?? []).slice(-8),
    units:
      (sim as any)?.value?.computeUnitsConsumed ??
      (sim as any)?.value?.unitsConsumed ??
      (sim as any)?.value?.meta?.computeUnitsConsumed ??
      undefined,
  };
}

// Normalize whatever main.ts passes into a SimIn
function normalizeInput(input: any): SimIn {
  // If input already looks like SimIn, return it
  if (input && input.user && typeof input.baseIn === "boolean" && input.amountInAtoms != null) {
    return {
      user: input.user as PublicKey,
      baseIn: Boolean(input.baseIn),
      amountInAtoms: BigInt(input.amountInAtoms),
      slippageBps: Number(input.slippageBps ?? 50),
    };
  }

  // Else, derive from edge/exec-style payload
  const user: PublicKey = input?.user ?? input?.payer ?? input?.owner;
  const path: string = input?.path ?? "";
  const baseIn = path === "PHX->AMM"; // baseIn true => SOL input
  const px = input?.sell_px ?? input?.buy_px ?? input?.phoenix?.limit_px ?? 0;

  // amountInAtoms is atoms of *input* mint
  const size_base = Number(input?.size_base ?? 0);
  const amountInAtoms = baseIn
    ? BigInt(Math.round(size_base * 1e9))       // SOL atoms
    : BigInt(Math.round(size_base * px * 1e6)); // USDC atoms

  return {
    user,
    baseIn,
    amountInAtoms,
    slippageBps: Number(input?.slippageBps ?? 50),
  };
}

/**
 * Back-compat factory used by src/main.ts.
 * - Accepts (conn) or (conn, opts) to satisfy "Expected 1 arg" sites.
 * - Returns a callable (input)=>Promise<...>, with a .simRaydiumFixedInTx method too.
 */
export function makeRpcSim(conn: Connection, _opts?: any) {
  const fn = (input: any) => simRaydiumFixedInTx(conn, normalizeInput(input));
  (fn as any).simRaydiumFixedInTx = (p: SimIn) => simRaydiumFixedInTx(conn, p);
  return fn as any;
}
