import { Connection, PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";

import type { AmmAdapter, QuoteResp } from "./types.js";
import {
  getCachedLifinitySnapshot,
  lifinityQuoteFromSnapshot,
  refreshLifinitySnapshot,
  toUi,
} from "../util/lifinity.js";
import { buildLifinitySwapIx } from "../executor/buildLifinityIx.js";

const DEFAULT_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS ?? 50);

function toAtoms(value: number, decimals: number): bigint {
  const dec = new Decimal(value);
  if (!dec.isFinite() || dec.lte(0)) return 0n;
  const scaled = dec.mul(new Decimal(10).pow(decimals)).floor();
  return BigInt(scaled.toFixed(0));
}

export const LifinityAdapter: AmmAdapter = {
  kind: "lifinity",

  async quote(conn: Connection, req): Promise<QuoteResp> {
    try {
      const poolId = new PublicKey(req.poolId);
      const baseMint = req.baseMint ? new PublicKey(req.baseMint) : undefined;
      const quoteMint = req.quoteMint ? new PublicKey(req.quoteMint) : undefined;

      let snapshot = getCachedLifinitySnapshot(poolId);
      if (!snapshot) {
        snapshot = await refreshLifinitySnapshot({
          connection: conn,
          poolId,
          expectedBaseMint: baseMint,
          expectedQuoteMint: quoteMint,
        });
      }

      const result = lifinityQuoteFromSnapshot({
        snapshot,
        sizeBase: req.inBase,
        direction: req.direction,
      });

      if (!result.ok) {
        return { ok: false, err: result.err };
      }

      return { ok: true, price: result.price, feeBps: result.feeBps };
    } catch (err: any) {
      return { ok: false, err: String(err?.message ?? err) };
    }
  },

  async buildSwapIxs(conn, userB58, req, meta) {
    const user = new PublicKey(userB58);
    const poolId = new PublicKey(req.poolId);
    const baseMint = req.baseMint ? new PublicKey(req.baseMint) : undefined;
    const quoteMint = req.quoteMint ? new PublicKey(req.quoteMint) : undefined;

    const snapshot = await refreshLifinitySnapshot({
      connection: conn,
      poolId,
      expectedBaseMint: baseMint,
      expectedQuoteMint: quoteMint,
    });

    const baseDecimals = snapshot.meta.baseDecimals;
    const quoteDecimals = snapshot.meta.quoteDecimals;

    const slippageBps = Math.max(
      0,
      Number(req.slippageBps ?? DEFAULT_SLIPPAGE_BPS)
    );

    const sizeBase = req.inBase;
    if (!(sizeBase > 0)) {
      throw new Error("lifinity: invalid swap size");
    }

    const quoteResult = lifinityQuoteFromSnapshot({
      snapshot,
      sizeBase,
      direction: req.direction,
    });
    if (!quoteResult.ok) {
      throw new Error(quoteResult.err);
    }

    const price = quoteResult.price;
    const baseIn = req.direction === "baseToQuote";

    const amountIn = baseIn
      ? toAtoms(sizeBase, baseDecimals)
      : toAtoms(sizeBase * price, quoteDecimals);

    const expectedOutUi = baseIn ? sizeBase * price : sizeBase;
    const minOutUi = expectedOutUi * (1 - slippageBps / 10_000);
    const minOut = toAtoms(
      baseIn ? minOutUi : minOutUi,
      baseIn ? quoteDecimals : baseDecimals
    );

    const { ixs } = await buildLifinitySwapIx({
      connection: conn,
      user,
      poolSnapshot: snapshot,
      baseIn,
      amountIn,
      minimumOut: minOut,
    });

    if (!ixs?.length) {
      throw new Error("lifinity: builder returned no instructions");
    }

    return ixs;
  },
};
