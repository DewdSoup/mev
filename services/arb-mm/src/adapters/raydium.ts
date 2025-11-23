// services/arb-mm/src/adapters/raydium.ts
// Raydium CPMM adapter (executor handles swap ix; quoting stays local).

import { PublicKey } from "@solana/web3.js";

import { buildRaydiumCpmmSwapIx } from "../executor/buildRaydiumCpmmIx.js";
import type { AmmAdapter, QuoteResp } from "./types.js";
import { USDC_MINT, WSOL_MINT } from "./helpers.js";

const DEFAULT_REF_PRICE = Number(process.env.RAY_REF_PX ?? 1);
const DEFAULT_MINOUT_BUFFER_BPS = Math.max(0, Number(process.env.RAYDIUM_MINOUT_BUFFER_BPS ?? 0));

export const RaydiumAdapter: AmmAdapter = {
  kind: "raydium",

  async quote(_conn, _req): Promise<QuoteResp> {
    return { ok: false, err: "use_router_cpmm_math" };
  },

  async buildSwapIxs(conn, userB58, req) {
    const user = new PublicKey(userB58);
    const baseIn = req.direction === "baseToQuote";

    const inMint = new PublicKey(baseIn ? WSOL_MINT : USDC_MINT);
    const outMint = new PublicKey(baseIn ? USDC_MINT : WSOL_MINT);

    const refPx = DEFAULT_REF_PRICE > 0 ? DEFAULT_REF_PRICE : 1;
    const amountInAtoms = baseIn
      ? BigInt(Math.floor(req.inBase * 1e9))
      : BigInt(Math.floor(req.inBase * Math.max(1, refPx) * 1e6));

    const amountOutMin = (() => {
      const BPS = 10_000n;
      if (baseIn) {
        const quoteAtoms = BigInt(Math.floor(req.inBase * Math.max(1, refPx) * 1e6));
        return (quoteAtoms * (BPS - BigInt(DEFAULT_MINOUT_BUFFER_BPS))) / BPS;
      }
      const baseAtoms = BigInt(Math.floor((req.inBase / Math.max(1, refPx)) * 1e9));
      return (baseAtoms * (BPS - BigInt(DEFAULT_MINOUT_BUFFER_BPS))) / BPS;
    })();

    const ixs = await buildRaydiumCpmmSwapIx({
      connection: conn,
      owner: user,
      poolId: new PublicKey(req.poolId),
      inMint,
      outMint,
      amountIn: amountInAtoms,
      amountOutMin,
    });

    if (!Array.isArray(ixs) || !ixs.length) {
      throw new Error("raydium_cpmm_ix_builder_failed");
    }

    return ixs;
  },
};
