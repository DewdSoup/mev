// services/arb-mm/src/executor/buildRaydiumCpmmIx.ts
// Thin wrapper around util/raydium, preserving legacy param/result shapes used by live/sim/rpc_sim.
// Permissive: allows extra fields (e.g., baseMint) to avoid excess property errors.

import { PublicKey } from "@solana/web3.js";
import { buildRaydiumSwapIx, type CpmmIxBuildResult } from "../util/raydium.js";

export type BuildSwapIxParams = {
  user: PublicKey;
  baseIn: boolean;           // true => input is base; false => input is quote
  amountInBase: bigint;      // atoms of the INPUT mint (preferred)
  slippageBps: number;       // MAX_SLIPPAGE_BPS (plus any dynamic buffer applied upstream)

  // Common optional/extraneous fields tolerated by callers:
  amountInAtoms?: bigint;    // alias some call sites use
  dir?: "BASE->QUOTE" | "QUOTE->BASE";
  baseMint?: PublicKey;
  quoteMint?: PublicKey;
  poolId?: PublicKey;

  // Future-proof: allow any other keys without tripping excess property checks
  [extra: string]: unknown;
};

export async function buildRaydiumCpmmSwapIx(
  p: BuildSwapIxParams
): Promise<CpmmIxBuildResult> {
  // Derive direction from `dir` if provided
  const derivedBaseIn =
    typeof p.dir === "string" ? (p.dir === "BASE->QUOTE") : p.baseIn;

  // Prefer amountInBase; fall back to amountInAtoms if present
  const amt =
    (p.amountInBase ?? p.amountInAtoms) as bigint | undefined;

  if (amt === undefined) {
    return { ok: false, reason: "raydium_swap_build_error: missing amountInBase/amountInAtoms" };
  }

  return buildRaydiumSwapIx({
    user: p.user,
    baseIn: derivedBaseIn,
    amountInBase: amt,
    slippageBps: p.slippageBps,
  });
}
