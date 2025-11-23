// services/arb-mm/src/adapters/orca.ts
// Orca Whirlpool adapter (quotes via local quoter helpers, build via ix builder).

import { PublicKey } from "@solana/web3.js";

import { buildOrcaWhirlpoolSwapIx } from "../executor/buildOrcaWhirlpoolIx.js";
import { orcaAvgBuyQuotePerBase, orcaAvgSellQuotePerBase } from "../executor/orca_quoter.js";
import type { AmmAdapter, QuoteResp } from "./types.js";
import { envNum } from "./helpers.js";

const DEFAULT_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS ?? 50);

export const OrcaAdapter: AmmAdapter = {
  kind: "orca",

  async quote(_conn, req): Promise<QuoteResp> {
    try {
      const size = Math.max(1e-9, req.inBase);
      const slip = Math.max(0, req.slippageBps);
      const quoter = req.direction === "baseToQuote" ? orcaAvgSellQuotePerBase : orcaAvgBuyQuotePerBase;
      const result = await quoter(req.poolId, size, slip);

      if (result.ok) {
        return {
          ok: true,
          price: result.price,
          feeBps: envNum("ORCA_TRADE_FEE_BPS") ?? envNum("AMM_TAKER_FEE_BPS") ?? 30,
        };
      }
      return { ok: false, err: (result as any).reason ?? "orca_quoter_failed" };
    } catch (err: any) {
      return { ok: false, err: String(err?.message ?? err) };
    }
  },

  async buildSwapIxs(conn, userB58, req, _meta = undefined) {
    const user = new PublicKey(userB58);
    const baseIn = req.direction === "baseToQuote";
    const referencePx = Number(process.env.ORCA_REF_PX ?? 0);

    const amountInAtoms = (() => {
      if (baseIn) {
        return BigInt(Math.floor(req.inBase * 1e9));
      }
      const px = referencePx > 0 ? referencePx : 1;
      const quoteUi = req.inBase * px;
      return BigInt(Math.floor(quoteUi * 1e6));
    })();

    const built = await buildOrcaWhirlpoolSwapIx({
      connection: conn,
      user,
      poolId: req.poolId,
      baseIn,
      amountInAtoms,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });

    if (!(built && (built as any).ok === true && Array.isArray((built as any).ixs) && (built as any).ixs.length)) {
      const reason = (built as any)?.reason ?? "orca_whirlpool_ix_builder_failed";
      throw new Error(String(reason));
    }

    return (built as any).ixs;
  },
};
