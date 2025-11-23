// services/arb-mm/src/adapters/helpers.ts
// Shared utilities for venue adapters (env helpers, canonical mint ids).

export const WSOL_MINT = (process.env.WSOL_MINT ?? "So11111111111111111111111111111111111111112").trim();
export const USDC_MINT = (process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").trim();

export function envNum(name: string, def?: number): number | undefined {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
