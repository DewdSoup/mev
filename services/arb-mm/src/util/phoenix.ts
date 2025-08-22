// services/arb-mm/src/util/phoenix.ts
// Thin facade: re-export Phoenix taker builder + types from @mev/phoenix
// so arb-mm has zero direct dependency on the Phoenix SDK. This keeps
// execution code modular and lets the phoenix package evolve independently.

export {
    buildPhoenixSwapIxs,
    type PhoenixSwapIxParams,
    type PhoenixIxBuildResult,
  } from "@mev/phoenix";
