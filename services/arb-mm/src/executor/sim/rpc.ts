// services/arb-mm/src/executor/sim/rpc.ts
// Safe utilities for parsing balances from RPC getTransaction/simulate results.
// Never calls .toFixed() on possibly-undefined values; always returns numbers or undefined.

import type { TokenBalance } from "@solana/web3.js";
import { asNumber, isFiniteNum, roundN } from "../../util/num.js";

export type MintTuple = {
  baseMint: string;
  quoteMint: string;
  baseDecimals?: number;
  quoteDecimals?: number;
};

function parseUiAmount(tb?: TokenBalance): number | undefined {
  if (!tb) return undefined;
  const uta = (tb as TokenBalance).uiTokenAmount as any;
  if (!uta) return undefined;

  // 1) uiAmount when present and finite
  if (typeof uta.uiAmount === "number" && Number.isFinite(uta.uiAmount)) {
    return uta.uiAmount;
  }

  // 2) uiAmountString when present
  if (uta.uiAmountString != null) {
    const n = Number(uta.uiAmountString);
    if (Number.isFinite(n)) return n;
  }

  // 3) Fallback: amount / 10^decimals
  if (uta.amount != null && uta.decimals != null) {
    const n = Number(uta.amount) / Math.pow(10, uta.decimals);
    if (Number.isFinite(n)) return n;
  }

  return undefined;
}

function byMint(mint: string) {
  return (t: TokenBalance) => t.mint === mint;
}

export function uiAmountFromBalance(tb?: TokenBalance): number | undefined {
  return parseUiAmount(tb);
}

export type RpcSimSummary = {
  ok: boolean;
  /** Effective price (quote/base), rounded to 6, if both deltas are finite. */
  eff_px?: number;
  /** Post - pre amounts (wallet deltas). */
  base_delta?: number;
  quote_delta?: number;
  /** Optional debug info */
  mode?: string;
  error?: string;
};

/**
 * Summarize token balance deltas into an effective price.
 * Accepts arrays shaped like getTransaction meta {pre,post} or simulated equivalents.
 */
export function summarizeBalances(
  pre: TokenBalance[] | undefined,
  post: TokenBalance[] | undefined,
  mints: MintTuple,
  mode = "rpc-sim"
): RpcSimSummary {
  try {
    const preArr = Array.isArray(pre) ? pre : [];
    const postArr = Array.isArray(post) ? post : [];

    const preBase  = parseUiAmount(preArr.find(byMint(mints.baseMint)));
    const preQuote = parseUiAmount(preArr.find(byMint(mints.quoteMint)));
    const postBase  = parseUiAmount(postArr.find(byMint(mints.baseMint)));
    const postQuote = parseUiAmount(postArr.find(byMint(mints.quoteMint)));

    const dBase = asNumber(postBase)  !== undefined && asNumber(preBase)  !== undefined ? (postBase as number)  - (preBase as number)  : undefined;
    const dQuote = asNumber(postQuote) !== undefined && asNumber(preQuote) !== undefined ? (postQuote as number) - (preQuote as number) : undefined;

    const absBase  = asNumber(dBase)  !== undefined ? Math.abs(dBase  as number) : undefined;
    const absQuote = asNumber(dQuote) !== undefined ? Math.abs(dQuote as number) : undefined;

    let effPx: number | undefined;
    if (isFiniteNum(absBase) && absBase > 0 && isFiniteNum(absQuote)) {
      effPx = roundN(absQuote / absBase, 6);
    }

    return {
      ok: isFiniteNum(effPx),
      eff_px: effPx,
      base_delta: roundN(dBase, 6),
      quote_delta: roundN(dQuote, 6),
      mode,
    };
  } catch (e: any) {
    return { ok: false, mode, error: String(e?.message ?? e) };
  }
}
