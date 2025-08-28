// packages/phoenix/src/atomic.ts
// Phoenix taker swap (TransactionInstruction[]), resilient to SDK variants.

import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as Phoenix from "@ellipsis-labs/phoenix-sdk";

export type PhoenixSwapIxParams = {
  connection: Connection;
  market: string;         // market public key (string)
  trader: PublicKey;      // payer/owner
  side: "bid" | "ask";    // bid = buy base (spend quote), ask = sell base (receive quote)
  inAmount: number;       // UI units: quote if bid, base if ask
};

export type PhoenixIxBuildResult =
  | { ok: true; ixs: TransactionInstruction[] }
  | { ok: false; reason: string };

async function ensureState(client: any, mktAddr: string): Promise<any | null> {
  const pk = new PublicKey(mktAddr);

  const fromMaps = () => {
    const ms = client?.marketStates ?? client?.markets;
    if (!ms) return null;
    if (typeof ms.get === "function") {
      return ms.get(mktAddr) ?? ms.get(pk) ?? ms.get(pk.toBase58()) ?? null;
    }
    if (typeof ms === "object" && mktAddr in ms) return (ms as any)[mktAddr];
    return null;
  };

  let mkt = fromMaps();
  if (!mkt && typeof client?.addMarket === "function") {
    try { await client.addMarket(pk); } catch { }
    mkt = fromMaps();
  }
  if (!mkt && typeof client?.refreshMarket === "function") {
    try { await client.refreshMarket(pk, false); } catch { }
    mkt = fromMaps();
  }
  if (!mkt && typeof client?.getMarketState === "function") {
    try { mkt = await client.getMarketState(pk); } catch { }
  }
  if (!mkt && typeof client?.getMarket === "function") {
    try { const m = await client.getMarket(pk); mkt = (m as any)?.state ?? m ?? null; } catch { }
  }
  return mkt ?? null;
}

export async function buildPhoenixSwapIxs(p: PhoenixSwapIxParams): Promise<PhoenixIxBuildResult> {
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
    const mktAddr = String(p.market);
    const mkt = await ensureState(client, mktAddr);
    if (!mkt) return { ok: false, reason: "phoenix_market_state_missing" };

    const SideEnum = (Phoenix as any).Side ?? {};
    const sideEnum = p.side === "bid" ? (SideEnum.Bid ?? 0) : (SideEnum.Ask ?? 1);

    // 1) Market-level getSwapTransaction
    if (typeof (mkt as any)?.getSwapTransaction === "function") {
      const tx = await (mkt as any).getSwapTransaction({
        side: sideEnum,
        inAmount: p.inAmount,
        trader: p.trader,
      });
      const ixs: TransactionInstruction[] = (tx?.instructions ?? []) as TransactionInstruction[];
      if (ixs.length > 0) return { ok: true, ixs };
    }

    // 2) Client-level getSwapTransaction
    if (typeof (client as any)?.getSwapTransaction === "function") {
      const tx = await (client as any).getSwapTransaction({
        market: new PublicKey(mktAddr),
        side: sideEnum,
        inAmount: p.inAmount,
        trader: p.trader,
      });
      const ixs: TransactionInstruction[] = (tx?.instructions ?? []) as TransactionInstruction[];
      if (ixs.length > 0) return { ok: true, ixs };
    }

    // 3) Client-level getSwapIxs
    if (typeof (client as any)?.getSwapIxs === "function") {
      const res = await (client as any).getSwapIxs({
        market: new PublicKey(mktAddr),
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

    // 4) Market-level getSwapIxs
    if (typeof (mkt as any)?.getSwapIxs === "function") {
      const res = await (mkt as any).getSwapIxs({
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

    return { ok: false, reason: "phoenix_swap_helper_unavailable_in_sdk" };
  } catch (e: any) {
    return { ok: false, reason: `phoenix_swap_ix_build_failed: ${e?.message ?? String(e)}` };
  }
}
