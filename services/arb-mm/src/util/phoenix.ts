// services/arb-mm/src/util/phoenix.ts
// Thin facade around @mev/phoenix. Works whether the package exposes named
// exports or a default object. We only surface the swap ix builder.

import * as Phoenix from "@mev/phoenix";
import type { TransactionInstruction } from "@solana/web3.js";

// Minimal surface so dependent code can type-check without relying on
// @mev/phoenix' internal type exports.
export type PhoenixSwapIxParams = any;
export type PhoenixIxBuildResult = {
  ixs: TransactionInstruction[];
  // allow extra fields without forcing downstream to depend on exact shape
  [k: string]: any;
};

// Be robust to both module shapes: default object or named exports.
const phoenixAny: any = (Phoenix as any)?.default ?? (Phoenix as any);

function resolveBuilder(mod: any) {
  return (
    mod?.buildPhoenixSwapIxs ??
    mod?.buildSwapIxs ??                    // fallback name, just in case
    mod?.default?.buildPhoenixSwapIxs ??    // double-fallback (we already handled default above)
    mod?.default?.buildSwapIxs
  );
}

const maybeBuilder = resolveBuilder(phoenixAny);
if (typeof maybeBuilder !== "function") {
  throw new Error(
    "@mev/phoenix export mismatch: expected buildPhoenixSwapIxs/buildSwapIxs"
  );
}

export const buildPhoenixSwapIxs = maybeBuilder as (
  p: PhoenixSwapIxParams
) => Promise<PhoenixIxBuildResult>;
