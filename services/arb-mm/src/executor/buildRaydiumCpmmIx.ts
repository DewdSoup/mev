// services/arb-mm/src/executor/buildRaydiumCpmmIx.ts
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  buildRaydiumSwapFixedInIx,
  SOL_MINT,
  USDC_MINT,
  DEFAULT_SOL_USDC_POOL,
} from "../util/raydium.js"; // KEEP .js (NodeNext imports)

export type BuildSwapIxParams = {
  user: PublicKey;
  baseMint?: PublicKey;
  quoteMint?: PublicKey;
  poolId?: PublicKey;
  baseIn: boolean;
  amountInBase: bigint;
  slippageBps: number;
};

export type BuildSwapIxResult =
  | { ok: true; ixs: TransactionInstruction[] }
  | { ok: false; reason: string };

export function buildRaydiumCpmmSwapIx(p: BuildSwapIxParams): BuildSwapIxResult {
  const res = buildRaydiumSwapFixedInIx({
    user: p.user,
    poolId: p.poolId ?? DEFAULT_SOL_USDC_POOL,
    baseMint: p.baseMint ?? SOL_MINT,
    quoteMint: p.quoteMint ?? USDC_MINT,
    baseIn: p.baseIn,
    amountInBase: p.amountInBase,
    slippageBps: p.slippageBps,
  });
  return res.ok ? res : { ok: false, reason: res.reason };
}
