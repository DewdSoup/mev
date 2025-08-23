// services/arb-mm/src/rpc_sim.ts
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { buildRaydiumCpmmSwapIx } from "./executor/buildRaydiumCpmmIx.js";

const WSOL_MINT = new PublicKey(process.env.WSOL_MINT!);
const USDC_MINT = new PublicKey(process.env.USDC_MINT!);
const RAYDIUM_POOL_ID = new PublicKey(process.env.RAYDIUM_POOL_ID!);

export type SimIn = {
  user: PublicKey;
  baseIn: boolean;           // true: SOL->USDC, false: USDC->SOL
  amountInAtoms: bigint;     // atoms of *input* mint
  slippageBps: number;       // used to shape minOut if you want, we’ll keep 1 atom for sim
};

export async function simRaydiumFixedInTx(conn: Connection, p: SimIn) {
  const inMint = p.baseIn ? WSOL_MINT : USDC_MINT;
  const outMint = p.baseIn ? USDC_MINT : WSOL_MINT;

  // For simulation we don’t want minOut to block the path; use 1 atom.
  const ixs = await buildRaydiumCpmmSwapIx({
    connection: conn,
    owner: p.user,
    poolId: RAYDIUM_POOL_ID,
    inMint,
    outMint,
    amountIn: p.amountInAtoms,
    amountOutMin: 1n,
  });

  const { blockhash } = await conn.getLatestBlockhash("processed");
  const msg = new TransactionMessage({
    payerKey: p.user,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ...ixs,
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
  if (input && input.user && typeof input.baseIn === "boolean" && input.amountInAtoms != null) {
    return {
      user: input.user as PublicKey,
      baseIn: Boolean(input.baseIn),
      amountInAtoms: BigInt(input.amountInAtoms),
      slippageBps: Number(input.slippageBps ?? 50),
    };
  }
  const user: PublicKey = input?.user ?? input?.payer ?? input?.owner;
  const path: string = input?.path ?? "";
  const baseIn = path === "PHX->AMM";
  const px = Number(input?.sell_px ?? input?.buy_px ?? input?.phoenix?.limit_px ?? 0);
  const size_base = Number(input?.size_base ?? 0);
  const amountInAtoms = baseIn
    ? BigInt(Math.round(size_base * 1e9))       // SOL atoms
    : BigInt(Math.round(size_base * px * 1e6)); // USDC atoms
  return { user, baseIn, amountInAtoms, slippageBps: Number(input?.slippageBps ?? 50) };
}

/** Back-compat factory used by main.ts. */
export function makeRpcSim(conn: Connection, _opts?: any) {
  const fn = (input: any) => simRaydiumFixedInTx(conn, normalizeInput(input));
  (fn as any).simRaydiumFixedInTx = (p: SimIn) => simRaydiumFixedInTx(conn, p);
  return fn as any;
}
