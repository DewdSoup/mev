// packages/phoenix/src/atomic.ts
// Phoenix taker "swap" builder using @ellipsis-labs/phoenix-sdk.
// Returns TransactionInstructions to compose atomically with other legs.
//
// Notes on SDK compatibility:
// - Some SDK versions key client.marketStates by *string* (address), not PublicKey.
// - Some versions expose swap helpers on the *client*, others on the *market* object.
//   We probe multiple shapes defensively and normalize to TransactionInstruction[].

import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as Phoenix from "@ellipsis-labs/phoenix-sdk";

export type PhoenixSwapIxParams = {
  connection: Connection;
  market: string;         // market public key (string address)
  trader: PublicKey;      // payer/owner
  side: "bid" | "ask";    // bid = buy base (spend quote), ask = sell base (receive quote)
  inAmount: number;       // UI units: quote (USDC) if bid, base (SOL) if ask
};

export type PhoenixIxBuildResult =
  | { ok: true; ixs: TransactionInstruction[] }
  | { ok: false; reason: string };

export async function buildPhoenixSwapIxs(p: PhoenixSwapIxParams): Promise<PhoenixIxBuildResult> {
  // Ensure we have a valid trader PublicKey before calling the SDK.  If the caller
  // passes an undefined or string value, fall back to the WALLET_PUBKEY env var.
  if (!p.trader || typeof (p.trader as any).toBuffer !== "function") {
    const fallback = process.env.WALLET_PUBKEY;
    if (fallback) {
      p.trader = new PublicKey(fallback);
    } else {
      return { ok: false, reason: "owner_public_key_missing" };
    }
  }

  try {
    const client = await (Phoenix as any).Client.create(p.connection);

    // IMPORTANT: map is keyed by *string* (market address), not PublicKey
    const mktAddr = String(p.market);
    const mkt = (client.marketStates?.get?.(mktAddr)) ?? null;
    if (!mkt) return { ok: false, reason: "phoenix_market_state_missing" };

    // Normalize side across SDKs
    const SideEnum = (Phoenix as any).Side ?? {};
    const sideEnum = p.side === "bid" ? (SideEnum.Bid ?? 0) : (SideEnum.Ask ?? 1);

    // Probe various SDK helper shapes and normalize to TransactionInstruction[]
    // 1) Market-level "getSwapTransaction" (some SDKs)
    const maybeGetSwapTx = (mkt as any)?.getSwapTransaction;
    if (typeof maybeGetSwapTx === "function") {
      const tx = await maybeGetSwapTx.call(mkt, {
        side: sideEnum,
        inAmount: p.inAmount,
        trader: p.trader,
      });
      const ixs: TransactionInstruction[] = (tx?.instructions ?? []) as TransactionInstruction[];
      if (ixs.length > 0) return { ok: true, ixs };
    }

    // 2) Client-level "getSwapTransaction" (other SDKs)
    const maybeClientSwapTx = (client as any)?.getSwapTransaction;
    if (typeof maybeClientSwapTx === "function") {
      const tx = await maybeClientSwapTx.call(client, {
        market: new PublicKey(mktAddr),
        side: sideEnum,
        inAmount: p.inAmount,
        trader: p.trader,
      });
      const ixs: TransactionInstruction[] = (tx?.instructions ?? []) as TransactionInstruction[];
      if (ixs.length > 0) return { ok: true, ixs };
    }

    // 3) Client-level "getSwapIxs" that returns instructions directly
    const maybeClientSwapIxs = (client as any)?.getSwapIxs;
    if (typeof maybeClientSwapIxs === "function") {
      const res = await maybeClientSwapIxs.call(client, {
        market: new PublicKey(mktAddr),
        side: sideEnum,
        inAmount: p.inAmount,
        trader: p.trader,
      });
      // Accept common shapes: array, {ixs}, {instructions}
      const ixs: TransactionInstruction[] =
        (Array.isArray(res) ? res :
          res?.ixs ? res.ixs :
            res?.instructions ? res.instructions : []) as TransactionInstruction[];
      if (ixs.length > 0) return { ok: true, ixs };
    }

    // 4) Market-level "getSwapIxs"
    const maybeMarketSwapIxs = (mkt as any)?.getSwapIxs;
    if (typeof maybeMarketSwapIxs === "function") {
      const res = await maybeMarketSwapIxs.call(mkt, {
        side: sideEnum,
        inAmount: p.inAmount,
        trader: p.trader,
      });
      const ixs: TransactionInstruction[] =
        (Array.isArray(res) ? res :
          res?.ixs ? res.ixs :
            res?.instructions ? res.instructions : []) as TransactionInstruction[];
      if (ixs.length > 0) return { ok: true, ixs };
    }

    // If we reached here, this SDK build doesn't expose a swap helper we recognize.
    return { ok: false, reason: "phoenix_swap_helper_unavailable_in_sdk" };
  } catch (e: any) {
    return { ok: false, reason: `phoenix_swap_ix_build_failed: ${e?.message ?? String(e)}` };
  }
}
