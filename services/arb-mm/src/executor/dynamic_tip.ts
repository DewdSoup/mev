// services/arb-mm/src/executor/dynamic_tip.ts
import type { AppConfig } from "../config.js";

/**
 * Returns total lamports tip to attach to the tx (not microLamports-per-CU).
 * - If TIP_MODE="fixed" and SUBMIT_TIP_LAMPORTS>0, returns that (capped).
 * - Else computes: ceil(units * TIP_MICROLAMPORTS_PER_CU / 1e6) * TIP_MULTIPLIER, capped.
 */
export function computeTipLamports(
  cfg: AppConfig,
  unitsConsumed?: number
): number {
  if (cfg.TIP_MODE === "fixed" && cfg.SUBMIT_TIP_LAMPORTS > 0) {
    return Math.min(cfg.SUBMIT_TIP_LAMPORTS, cfg.TIP_MAX_LAMPORTS);
    }
  if (!unitsConsumed || unitsConsumed <= 0) return 0;

  const base = Math.floor((unitsConsumed * cfg.TIP_MICROLAMPORTS_PER_CU) / 1_000_000);
  const withMult = Math.ceil(base * cfg.TIP_MULTIPLIER);
  return Math.min(withMult, cfg.TIP_MAX_LAMPORTS);
}
