import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";

import { logger } from "../ml_logger.js";

import type { QuoteResult } from "./clmm_quoter.js";

import {
  atomsToDecimal,
  DLMM_BIN_ARRAY_HORIZON,
  DLMM_MIN_SLIPPAGE_BPS,
  getDlmmBinArrays,
  getDlmmInstance,
  getMintDecimals,
  toPublicKeyLike,
} from "../util/meteora_dlmm.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export interface DlmmQuoteArgs {
  poolId: string;
  side: "buy" | "sell";
  sizeBase: number;
  slippageBps: number;
  baseMint?: string;
  quoteMint?: string;
}

function computeFeeBps(fee: BN | undefined, base: BN | undefined): number {
  if (!fee || !base || fee.isZero() || base.isZero()) return 0;
  const feeDec = new Decimal(fee.toString());
  const baseDec = new Decimal(base.toString());
  return feeDec.mul(10_000).div(baseDec).toNumber();
}

export async function quoteDlmm(args: DlmmQuoteArgs): Promise<QuoteResult> {
  try {
    if (!(args.sizeBase > 0)) {
      return { ok: false, err: "invalid_size" };
    }

    const poolId = args.poolId;
    const instance = await getDlmmInstance(poolId);

    const configuredBaseMint = args.baseMint ? new PublicKey(args.baseMint) : null;
    const tokenXMint = toPublicKeyLike(instance.lbPair?.tokenXMint ?? instance.tokenXMint);
    const tokenYMint = toPublicKeyLike(instance.lbPair?.tokenYMint ?? instance.tokenYMint);

    const baseIsX = configuredBaseMint ? configuredBaseMint.equals(tokenXMint) : true;
    const baseMint = baseIsX ? tokenXMint : tokenYMint;
    const quoteMint = baseIsX ? tokenYMint : tokenXMint;

    const [baseDecimals, quoteDecimals] = await Promise.all([
      getMintDecimals(baseMint),
      getMintDecimals(quoteMint),
    ]);

    const sizeBaseDec = new Decimal(args.sizeBase);
    if (!sizeBaseDec.isFinite() || sizeBaseDec.lte(0)) {
      return { ok: false, err: "invalid_size" };
    }

    const inAtoms = new BN(sizeBaseDec.mul(new Decimal(10).pow(baseDecimals)).floor().toString());
    if (inAtoms.isZero()) {
      return { ok: false, err: "size_underflow" };
    }

    const slippageBps = Math.max(DLMM_MIN_SLIPPAGE_BPS, Math.round(Math.max(0, args.slippageBps ?? 0)));
    const allowedSlippage = new BN(slippageBps);

    const swapForY = args.side === "sell" ? baseIsX : !baseIsX;

    const binArraysResult = await getDlmmBinArrays({
      poolId,
      swapForY,
      horizon: DLMM_BIN_ARRAY_HORIZON,
      allowStale: true,
    });

    if (!binArraysResult.ok) {
      const errorMeta: Record<string, unknown> = {
        source: "dlmm_quoter",
        swap_for_y: swapForY,
        state_fresh: binArraysResult.stateFresh ?? null,
        state_age_ms: binArraysResult.stateAgeMs ?? null,
        failure_count: binArraysResult.failureCount ?? 0,
      };
      if (binArraysResult.stateFresh === false) {
        errorMeta.degraded = true;
        errorMeta.degraded_reason = "state_stale";
      }
      return { ok: false, err: binArraysResult.err, meta: errorMeta };
    }

    const dlmm = binArraysResult.instance ?? instance;
    const binArrays = binArraysResult.binArrays;
    if (!Array.isArray(binArrays) || binArrays.length === 0) {
      return {
        ok: false,
        err: "bin_arrays_empty",
        meta: {
          source: "dlmm_quoter",
          swap_for_y: swapForY,
          state_fresh: binArraysResult.stateFresh,
          state_age_ms: binArraysResult.stateAgeMs,
        },
      };
    }

    const ageMsRounded = Number.isFinite(binArraysResult.ageMs)
      ? Math.round(binArraysResult.ageMs)
      : null;
    const stateAgeMsRounded = Number.isFinite(binArraysResult.stateAgeMs)
      ? Math.round(binArraysResult.stateAgeMs)
      : null;

    const baseMeta: Record<string, unknown> = {
      source: args.side === "sell" ? "meteora_dlmm_swap" : "meteora_dlmm_swap_exact_out",
      swap_for_y: swapForY,
      bin_arrays_age_ms: ageMsRounded,
      bin_arrays_fresh: binArraysResult.fresh,
      bin_arrays_len: binArrays.length,
      bin_arrays_failure_count: binArraysResult.failureCount ?? 0,
      bin_arrays_stale_reason: binArraysResult.staleReason ?? null,
      bin_arrays_source: binArraysResult.fresh ? "fresh" : "cache",
      bin_arrays_horizon: DLMM_BIN_ARRAY_HORIZON,
      state_fresh: binArraysResult.stateFresh,
      state_age_ms: stateAgeMsRounded,
      slippage_bps: slippageBps,
      size_base: args.sizeBase,
      size_atoms: inAtoms.toString(),
      base_decimals: baseDecimals,
      quote_decimals: quoteDecimals,
    };

    const degradedReason = !binArraysResult.stateFresh
      ? "state_stale"
      : !binArraysResult.fresh
        ? binArraysResult.staleReason ?? "bin_arrays_stale"
        : undefined;
    if (degradedReason) {
      baseMeta.degraded = true;
      baseMeta.degraded_reason = degradedReason;
    }

    if (args.side === "sell") {
      const quote = dlmm.swapQuote(inAtoms, swapForY, allowedSlippage, binArrays);
      const usedIn = quote.consumedInAmount ?? inAtoms;
      if (!quote.outAmount || quote.outAmount.isZero()) {
        return { ok: false, err: "no_liquidity", meta: baseMeta };
      }

      const inUi = atomsToDecimal(usedIn, baseDecimals);
      const outUi = atomsToDecimal(quote.outAmount, quoteDecimals);
      if (inUi.isZero() || outUi.isZero()) {
        return { ok: false, err: "zero_quote", meta: baseMeta };
      }

      const avgPrice = outUi.div(inUi).toNumber();
      const feeBps = computeFeeBps(quote.fee, usedIn);

      return {
        ok: true,
        price: avgPrice,
        feeBps,
        meta: {
          ...baseMeta,
          consumed_in_atoms: usedIn.toString(),
          out_atoms: quote.outAmount.toString(),
          protocol_fee_atoms: quote.protocolFee?.toString?.(),
          price_impact: quote.priceImpact?.toString?.(),
          end_price: quote.endPrice?.toString?.(),
        },
      };
    }

    const outAtoms = inAtoms;
    const quote = dlmm.swapQuoteExactOut(outAtoms, swapForY, allowedSlippage, binArrays);
    const inAmount = quote.inAmount;
    if (!inAmount || inAmount.isZero()) {
      return { ok: false, err: "no_liquidity", meta: baseMeta };
    }

    const inUi = atomsToDecimal(inAmount, quoteDecimals);
    const outUi = atomsToDecimal(outAtoms, baseDecimals);
    if (inUi.isZero() || outUi.isZero()) {
      return { ok: false, err: "zero_quote", meta: baseMeta };
    }

    const avgPrice = inUi.div(outUi).toNumber();
    const feeBps = computeFeeBps(quote.fee, inAmount);

    return {
      ok: true,
      price: avgPrice,
      feeBps,
      meta: {
        ...baseMeta,
        in_atoms: inAmount.toString(),
        out_atoms: outAtoms.toString(),
        protocol_fee_atoms: quote.protocolFee?.toString?.(),
        price_impact: quote.priceImpact?.toString?.(),
        max_in_atoms: quote.maxInAmount?.toString?.(),
      },
    };
  } catch (err) {
    logger.log("meteora_dlmm_quote_error", {
      pool: args.poolId,
      side: args.side,
      err: String((err as any)?.message ?? err),
    });
    return { ok: false, err: String((err as any)?.message ?? err) };
  }
}
