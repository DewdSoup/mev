// services/arb-mm/src/types/execution.ts
// Shared execution plan types for joiner → executor handoff.

export type PhoenixExecutionLeg = {
  kind: "phoenix";
  market: string;
  side: "buy" | "sell";
  sizeBase: number;
  limitPx: number;
  slippageBps?: number;
};

export type AmmExecutionLeg = {
  kind: "amm";
  venue: string;
  poolId: string;
  poolKind?: string;
  direction: "baseToQuote" | "quoteToBase";
  sizeBase: number;
  refPx: number;
  baseMint?: string;
  quoteMint?: string;
  label?: string;
};

export type ExecutionLeg = PhoenixExecutionLeg | AmmExecutionLeg;

export type ExecutionPlan = {
  legs: ExecutionLeg[];
};
