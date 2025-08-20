import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Client } from "@ellipsis-labs/phoenix-sdk";

const MARKET = new PublicKey(process.env.PHOENIX_MARKET ?? "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg");
const RPC = process.env.RPC_PRIMARY?.trim()
  ?? (process.env.HELIUS_API_KEY ? `https://rpc.helius.xyz/?api-key=${process.env.HELIUS_API_KEY}` : clusterApiUrl("mainnet-beta"));

(async () => {
  const conn = new Connection(RPC, { commitment: "processed" });
  const anyClient = Client as any;
  const client = typeof anyClient.create === "function" ? await anyClient.create(conn) : new anyClient(conn);

  const has = (k: string) => typeof (client as any)[k] === "function";

  console.log("phoenix-sdk methods:", {
    getL2: has("getL2"),
    getBbo: has("getBbo"),
    refreshMarket: has("refreshMarket"),
    subscribeL2: has("subscribeL2"),
    subscribeToL2: has("subscribeToL2"),
    subscribeToMarket: has("subscribeToMarket"),
    onMarketUpdate: has("onMarketUpdate"),
  });

  try {
    if (has("getL2")) {
      const l2 = await (client as any).getL2(MARKET, 1);
      console.log("getL2(1):", JSON.stringify(l2));
    }
  } catch(e){ console.log("getL2 error:", String(e)); }

  try {
    if (has("getBbo")) {
      const bbo = await (client as any).getBbo(MARKET);
      console.log("getBbo():", JSON.stringify(bbo));
    }
  } catch(e){ console.log("getBbo error:", String(e)); }

  try {
    if (has("refreshMarket")) {
      const ms = await (client as any).refreshMarket(MARKET, false);
      const ob:any = (ms as any)?.orderBook ?? (ms as any)?.book ?? {};
      console.log("refreshMarket(false) bids_len/asks_len:", (ob.bids?.length ?? 0), (ob.asks?.length ?? 0));
    }
  } catch(e){ console.log("refreshMarket error:", String(e)); }
})();
