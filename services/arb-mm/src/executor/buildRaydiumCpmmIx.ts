// services/arb-mm/src/executor/buildRaydiumCpmmIx.ts
import type { TransactionInstruction, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// Internal Raydium helper (kept as-is)
import { buildRaydiumSwapFixedInIx } from "../util/raydium.js";

export type BuildSwapIxParams = {
  user: PublicKey;
  baseIn: boolean;          // true => input is base mint (SOL in SOL/USDC)
  amountInBase: bigint;     // atoms of *input* mint (SOL if baseIn, USDC if !baseIn)
  slippageBps: number;

  // Optional hints (threaded through if present)
  baseMint?: PublicKey;
  quoteMint?: PublicKey;
  poolId?: PublicKey;
};

export type BuildSwapIxResult =
  | { ok: true; ixs: TransactionInstruction[] }
  | { ok: false; reason: string };

/**
 * Defensive wrapper around Raydium CPMM swap fixed-in builder.
 * - Always provides BOTH BN sides: amountInBase & amountInQuote (other side = 0).
 * - Adds common aliases some wrappers probe (amountIn, inAmount*, fixedSide, minOut*).
 * - Calls the util via `as any` to bypass TS shape friction (BN vs bigint).
 */
export async function buildRaydiumCpmmSwapIx(
  p: BuildSwapIxParams
): Promise<BuildSwapIxResult> {
  try {
    const zeroBN = new BN(0);
    const inAmtBN = new BN(p.amountInBase.toString());

    const amountInBaseBN = p.baseIn ? inAmtBN : zeroBN;
    const amountInQuoteBN = p.baseIn ? zeroBN : inAmtBN;

    // Provide both BN and alias fields so no `.isZero` on undefined
    const args: Record<string, unknown> = {
      // identity
      user: p.user,
      owner: p.user,      // common alias
      payer: p.user,      // seen in some wrappers

      // direction + slippage
      baseIn: p.baseIn,
      slippageBps: p.slippageBps,
      slippage: p.slippageBps, // some helpers read `slippage`

      // canonical BN amounts (both sides present)
      amountInBase: amountInBaseBN,
      amountInQuote: amountInQuoteBN,

      // useful aliases many wrappers probe
      inAmountBase: amountInBaseBN,
      inAmountQuote: amountInQuoteBN,
      amountIn: inAmtBN,
      inAmount: inAmtBN,
      fixedSide: "in",

      // min-out placeholders so `.isZero()` is safe if checked
      minOutBase: zeroBN,
      minOutQuote: zeroBN,
      minAmountOut: zeroBN,
    };

    if (p.baseMint) (args as any).baseMint = p.baseMint;
    if (p.quoteMint) (args as any).quoteMint = p.quoteMint;
    if (p.poolId) (args as any).poolId = p.poolId;

    // Call through as-any to avoid BN vs bigint TS friction
    const util = buildRaydiumSwapFixedInIx as any;

    // 1) Normal shape
    let res: any;
    try {
      res = await util(args);
    } catch (e: any) {
      // 2) Retry with extra aliases if some wrapper was picky
      res = await util({
        ...args,
        // redundant aliases to placate stricter branches
        amountInBN: inAmtBN,
        inAmountBN: inAmtBN,
      });
    }

    if (res?.ok && Array.isArray(res.ixs)) {
      return { ok: true, ixs: res.ixs as TransactionInstruction[] };
    }
    if (Array.isArray(res)) {
      // some helpers just return an ix array
      return { ok: true, ixs: res as TransactionInstruction[] };
    }

    return {
      ok: false,
      reason:
        "raydium_swap_ix_build_failed: " +
        String(res?.reason ?? "unknown return shape"),
    };
  } catch (e: any) {
    return {
      ok: false,
      reason: `raydium_swap_ix_build_failed: ${e?.message ?? String(e)}`,
    };
  }
}
