import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import * as PhoenixSDK from "@ellipsis-labs/phoenix-sdk";

type AnyClient = any;

function resolveRpc(): string {
  // Prefer RPC_URL; fall back to RPC_PRIMARY; else derive Helius from key; else mainnet-beta.
  const direct = process.env.RPC_URL?.trim();
  if (direct) return direct;
  const primary = process.env.RPC_PRIMARY?.trim();
  if (primary) return primary;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://rpc.helius.xyz/?api-key=${key}`;
  return clusterApiUrl("mainnet-beta");
}

function fmt(n: unknown): number | undefined {
  const x = typeof n === "number" ? n
    : (typeof (n as any)?.uiPrice === "number" ? (n as any).uiPrice
      : (typeof (n as any)?.price === "number" ? (n as any).price
        : (typeof (n as any)?.price?.toNumber === "function" ? (n as any).price.toNumber()
          : (typeof (n as any)?.toNumber === "function" ? (n as any).toNumber()
            : undefined))));
  return typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(6)) : undefined;
}

async function makeClient(conn: Connection, marketStr: string): Promise<AnyClient> {
  const mod: any = PhoenixSDK;
  const Ctor: any = mod?.Client ?? mod?.default?.Client;
  if (!Ctor) throw new Error("phoenix_sdk_missing_Client");

  // Seed with market if createWithMarketAddresses exists (some SDK builds need this).
  const pk = new PublicKey(marketStr);
  if (typeof Ctor.createWithMarketAddresses === "function") {
    try { return await Ctor.createWithMarketAddresses(conn, [pk], "mainnet-beta"); } catch { }
    try { return await Ctor.createWithMarketAddresses(conn, "mainnet-beta", [pk]); } catch { }
  }
  return typeof Ctor.create === "function" ? await Ctor.create(conn) : new Ctor(conn);
}

async function main() {
  const MARKET = (process.env.PHOENIX_MARKET ?? "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg").trim();
  const RPC = resolveRpc();
  const conn = new Connection(RPC, { commitment: "processed" });
  const client: AnyClient = await makeClient(conn, MARKET);

  const has = (k: string) => typeof client[k] === "function";
  console.log("phoenix-sdk methods:", {
    getUiLadder: has("getUiLadder"),
    getLadder: has("getLadder"),
    getL2: has("getL2"),
    getBbo: has("getBbo"),
    refreshMarket: has("refreshMarket"),
  });

  // 1) getUiLadder / getLadder
  for (const m of ["getUiLadder", "getLadder"] as const) {
    if (!has(m)) continue;
    try {
      const ladder: any = client[m].length >= 2 ? await client[m](MARKET, 5) : await client[m](MARKET);
      const bestBid = fmt(ladder?.bids?.[0] ?? ladder?.bestBid);
      const bestAsk = fmt(ladder?.asks?.[0] ?? ladder?.bestAsk);
      if (bestBid || bestAsk) {
        console.log(JSON.stringify({
          src: `sdk:${m}`,
          bestBid, bestAsk,
          bids: Array.isArray(ladder?.bids) ? ladder.bids.length : 0,
          asks: Array.isArray(ladder?.asks) ? ladder.asks.length : 0
        }));
        return;
      }
    } catch (e: any) {
      console.log(`${m} error:`, String(e?.message ?? e));
    }
  }

  // 2) getL2
  if (has("getL2")) {
    try {
      const l2: any = await client.getL2(MARKET, 5);
      const bestBid = fmt(l2?.bids?.[0]);
      const bestAsk = fmt(l2?.asks?.[0]);
      if (bestBid || bestAsk) {
        console.log(JSON.stringify({
          src: "sdk:getL2",
          bestBid, bestAsk,
          bids: Array.isArray(l2?.bids) ? l2.bids.length : 0,
          asks: Array.isArray(l2?.asks) ? l2.asks.length : 0
        }));
        return;
      }
    } catch (e: any) {
      console.log("getL2 error:", String(e?.message ?? e));
    }
  }

  // 3) getBbo
  if (has("getBbo")) {
    try {
      const bbo: any = await client.getBbo(MARKET);
      const bestBid = fmt(bbo?.bestBid);
      const bestAsk = fmt(bbo?.bestAsk);
      if (bestBid || bestAsk) {
        console.log(JSON.stringify({ src: "sdk:getBbo", bestBid, bestAsk }));
        return;
      }
    } catch (e: any) {
      console.log("getBbo error:", String(e?.message ?? e));
    }
  }

  // 4) refreshMarket + inspect order book
  if (has("refreshMarket")) {
    try {
      const ms: any = await client.refreshMarket(MARKET, false);
      const ob: any = ms?.orderBook ?? ms?.book ?? {};
      const bidsArr: any[] = Array.isArray(ob?.bids) ? ob.bids : (Array.isArray(ob?.book?.bids) ? ob.book.bids : []);
      const asksArr: any[] = Array.isArray(ob?.asks) ? ob.asks : (Array.isArray(ob?.book?.asks) ? ob.book.asks : []);
      const bestBid = fmt(bidsArr?.[0]);
      const bestAsk = fmt(asksArr?.[0]);
      console.log(JSON.stringify({
        src: "refreshMarket:inspect",
        bids: bidsArr.length,
        asks: asksArr.length,
        bestBid, bestAsk
      }));
      return;
    } catch (e: any) {
      console.log("refreshMarket error:", String(e?.message ?? e));
    }
  }

  console.log(JSON.stringify({ src: "none", reason: "no usable SDK method produced BBO" }));
}

main().catch((e) => {
  console.error("fatal:", e?.message ?? String(e));
  process.exit(1);
});
