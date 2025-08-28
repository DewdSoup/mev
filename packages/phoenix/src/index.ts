// packages/phoenix/src/index.ts
// Phoenix L2 publisher with SDK L3 fallback (aggregates L3 → L2)
// Emits:
//   phoenix_l2  { ts, market, symbol, best_bid, best_ask, phoenix_mid, tick_ms, source, levels_bids?, levels_asks? }
//   phoenix_mid { ts, market, symbol, px, px_str, best_bid?, best_ask?, tick_ms, source }
//   phoenix_l2_empty { ts, market, symbol, haveBid, haveAsk, tick_ms, source }

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import * as PhoenixSDK from "@ellipsis-labs/phoenix-sdk";
import { logger } from "@mev/storage";
import { makePhoenixConnection } from "./rpc.js";

type MarketState = any;

// ── env load ──────────────────────────────────────────────────────────────────
(function loadRootEnv() {
  const c = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), ".env.live"),
    path.resolve(process.cwd(), "packages/phoenix/.env"),
  ];
  for (const p of c) if (fs.existsSync(p)) { dotenv.config({ path: p }); break; }
  dotenv.config();
})();

// ── helpers ───────────────────────────────────────────────────────────────────
const numOr = (v: string | undefined, d: number) => {
  const n = Number(v); return Number.isFinite(n) ? n : d;
};
const boolOr = (v: string | undefined, d: boolean) => {
  if (v == null) return d;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
};
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ── RPC resolve (for logging/masking only) ────────────────────────────────────
function resolveRpcForMask(): string {
  const primary = process.env.RPC_PRIMARY?.trim() || process.env.RPC_URL?.trim();
  if (primary) return primary;
  const heliusKey = process.env.HELIUS_API_KEY?.trim();
  if (heliusKey) return `https://rpc.helius.xyz/?api-key=${heliusKey}`;
  return "https://api.mainnet-beta.solana.com";
}
function maskUrl(u: string) {
  try {
    const url = new URL(u);
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "***");
    return url.toString();
  } catch { return u; }
}

const RPC_MASK = resolveRpcForMask();
const COMMITMENT: Commitment = "processed";

const TICK_MS = clamp(numOr(process.env.PHOENIX_TICK_MS, 2000), 100, 60000);
const L2_FETCH_DEPTH = clamp(numOr(process.env.PHOENIX_L2_DEPTH, 10), 1, 50);
const PUBLISH_DEPTH = clamp(numOr(process.env.PHOENIX_DEPTH_LEVELS, L2_FETCH_DEPTH), 1, 50);
const TRY_WS = boolOr(process.env.PHOENIX_WS_ENABLED, true);

// ── config file (optional) ────────────────────────────────────────────────────
type MarketCfg = { symbol: string; phoenix?: { market: string } };
function loadMarketsConfig(): MarketCfg[] | null {
  const cands = [
    path.resolve(process.cwd(), "configs/markets.json"),
    path.resolve(process.cwd(), "packages/phoenix/configs/markets.json"),
  ];
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) {
        const arr = JSON.parse(fs.readFileSync(p, "utf8")) as MarketCfg[];
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch {/* ignore */ }
  }
  return null;
}

// ── client bootstrap ─────────────────────────────────────────────────────────
async function makeClient(conn: Connection, seedMarkets: string[] = []): Promise<any> {
  const mod: any = PhoenixSDK;
  const Ctor: any = mod?.Client ?? mod?.default?.Client;
  if (!Ctor) throw new Error("phoenix_sdk_missing_Client");

  const seeds = seedMarkets
    .map(s => { try { return new PublicKey(s); } catch { return null; } })
    .filter(Boolean) as PublicKey[];

  // Known-good seeding path: (connection, seeds)
  if (seeds.length && typeof Ctor.createWithMarketAddresses === "function") {
    try {
      const client = await (Ctor as any).createWithMarketAddresses(conn, seeds);
      logger.log("phoenix_client_seeded", { order: "conn,seeds", seeds: seedMarkets });
      return client;
    } catch (e: any) {
      logger.log("phoenix_client_seed_attempt_error", { order: "conn,seeds", err: String(e?.message ?? e) });
    }
    logger.log("phoenix_client_seed_all_failed", { seeds: seedMarkets });
  }

  // Fallback (older SDKs)
  const client = typeof Ctor.create === "function" ? await Ctor.create(conn) : new Ctor(conn);
  logger.log("phoenix_client_unseeded", { note: "Client.create(connection)" });
  return client;
}

// ── extractors & L3→L2 aggregation ───────────────────────────────────────────
type Level = { px: number; qty: number };
type MaybeBbo = {
  bestBid?: number;
  bestAsk?: number;
  bids?: Level[];
  asks?: Level[];
  source: string;
};

// Accept many shapes: {price,size}, {price,quantity}, tuple [price,size], BN-ish, etc.
function pxFrom(l: any): number | undefined {
  if (l == null) return;
  if (Array.isArray(l)) {
    const v = Number(l[0]);
    return Number.isFinite(v) ? v : undefined;
  }
  const v =
    typeof l.uiPrice === "number" ? l.uiPrice :
      typeof l.price === "number" ? l.price :
        typeof l.px === "number" ? l.px :
          (typeof l.price?.toNumber === "function" ? l.price.toNumber() :
            (typeof l?.toNumber === "function" ? l.toNumber() : undefined));
  return Number.isFinite(v) ? v : undefined;
}
function qtyFrom(l: any): number | undefined {
  if (l == null) return;
  if (Array.isArray(l)) {
    const v = Number(l[1]);
    return Number.isFinite(v) ? v : undefined;
  }
  const v =
    typeof l.uiQuantity === "number" ? l.uiQuantity :
      typeof l.quantity === "number" ? l.quantity :
        typeof l.uiSize === "number" ? l.uiSize :
          typeof l.size === "number" ? l.size :
            (typeof l.quantity?.toNumber === "function" ? l.quantity.toNumber() :
              (typeof l.baseLots?.toNumber === "function" && typeof l?.lotSize === "number"
                ? l.baseLots.toNumber() * l.lotSize
                : (typeof l.sizeLots === "number" && typeof l.lotSize === "number"
                  ? l.sizeLots * l.lotSize
                  : undefined)));
  return Number.isFinite(v) ? v : undefined;
}

// aggregate arbitrary L3 rows into L2 levels
function l3ToL2(levels: any[] | undefined, side: "bids" | "asks", depth: number): Level[] {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  const m = new Map<number, number>();
  for (const row of levels) {
    const px = pxFrom(row);
    const qty = qtyFrom(row);
    if (!Number.isFinite(px) || !Number.isFinite(qty)) continue;
    m.set(px!, (m.get(px!) ?? 0) + (qty as number));
  }
  let arr = [...m.entries()].map(([px, qty]) => ({ px, qty }));
  arr.sort((a, b) => side === "bids" ? b.px - a.px : a.px - b.px);
  return arr.slice(0, depth);
}

// ── depth fetcher (tries UI ladder → L2 → L3UI → L3 → refreshMarket) ─────────
async function fetchDepth(client: any, market: PublicKey, depth: number): Promise<MaybeBbo> {
  // 1) getUiLadder (L2)
  if (typeof client?.getUiLadder === "function") {
    try {
      const lad = await client.getUiLadder(market, depth);
      const bids = l3ToL2(lad?.bids, "bids", depth); // safe even if already L2
      const asks = l3ToL2(lad?.asks, "asks", depth);
      const bestBid = bids[0]?.px, bestAsk = asks[0]?.px;
      if (Number.isFinite(bestBid) || Number.isFinite(bestAsk))
        return { bestBid, bestAsk, bids, asks, source: "sdk:getUiLadder" };
    } catch { }
  }

  // 2) getL2
  if (typeof client?.getL2 === "function") {
    try {
      const lad = await client.getL2(market, depth);
      const bids = l3ToL2(lad?.bids, "bids", depth);
      const asks = l3ToL2(lad?.asks, "asks", depth);
      const bestBid = bids[0]?.px, bestAsk = asks[0]?.px;
      if (Number.isFinite(bestBid) || Number.isFinite(bestAsk))
        return { bestBid, bestAsk, bids, asks, source: "sdk:getL2" };
    } catch { }
  }

  // 3) getL3UiBook
  if (typeof client?.getL3UiBook === "function") {
    try {
      const book = await client.getL3UiBook(market);
      const bids = l3ToL2(book?.bids, "bids", depth);
      const asks = l3ToL2(book?.asks, "asks", depth);
      const bestBid = bids[0]?.px, bestAsk = asks[0]?.px;
      if (Number.isFinite(bestBid) || Number.isFinite(bestAsk))
        return { bestBid, bestAsk, bids, asks, source: "sdk:getL3UiBook(agg)" };
    } catch { }
  }

  // 4) getL3Book
  if (typeof client?.getL3Book === "function") {
    try {
      const book = await client.getL3Book(market);
      const bids = l3ToL2(book?.bids, "bids", depth);
      const asks = l3ToL2(book?.asks, "asks", depth);
      const bestBid = bids[0]?.px, bestAsk = asks[0]?.px;
      if (Number.isFinite(bestBid) || Number.isFinite(bestAsk))
        return { bestBid, bestAsk, bids, asks, source: "sdk:getL3Book(agg)" };
    } catch { }
  }

  // 5) refreshMarket → read any embedded book shape
  try {
    const ms: MarketState = typeof client?.refreshMarket === "function"
      ? await client.refreshMarket(market, false)
      : undefined;
    const ob: any = (ms as any)?.orderBook ?? (ms as any)?.book ?? {};
    const bids = l3ToL2(ob?.bids, "bids", depth);
    const asks = l3ToL2(ob?.asks, "asks", depth);
    const bestBid = bids[0]?.px, bestAsk = asks[0]?.px;
    return { bestBid, bestAsk, bids, asks, source: "sdk:refreshMarket(agg)" };
  } catch {
    return { source: "none" };
  }
}

// ── optional WS (best-effort; polling still runs) ────────────────────────────
async function tryAttachWs(client: any, market: PublicKey, onKick: () => void): Promise<boolean> {
  if (!TRY_WS) return false;
  try {
    if (typeof client?.subscribeToMarket === "function") {
      await client.subscribeToMarket(market);
      if (typeof client?.onMarketUpdate === "function") client.onMarketUpdate(market, onKick);
      logger.log("phoenix_ws_subscribed", { via: "subscribeToMarket" });
      return true;
    }
  } catch { /* fall through */ }
  try {
    if (typeof client?.subscribeToL2 === "function") {
      await client.subscribeToL2(market);
      logger.log("phoenix_ws_subscribed", { via: "subscribeToL2" });
      return true;
    }
  } catch { /* fall through */ }
  try {
    if (typeof client?.subscribeL2 === "function") {
      await client.subscribeL2(market);
      logger.log("phoenix_ws_subscribed", { via: "subscribeL2" });
      return true;
    }
  } catch { /* fall through */ }
  logger.log("phoenix_ws_unavailable", { note: "polling only" });
  return false;
}

// ── single market loop ────────────────────────────────────────────────────────
async function runMarket(client: any, symbol: string, marketStr: string) {
  const market = new PublicKey(marketStr);

  try {
    // Prefer addMarket first, then refresh; ensures state existence across SDKs
    if (typeof client?.addMarket === "function") await client.addMarket(market);
    if (typeof client?.refreshMarket === "function") await client.refreshMarket(market, false);
  } catch {/* ignore */ }

  let kick = true;
  const wsAttached = await tryAttachWs(client, market, () => (kick = true)).catch(() => false);

  logger.log("phoenix_boot", { rpc: maskUrl(RPC_MASK), ws_attached: wsAttached });

  while (true) {
    try {
      const depth = await fetchDepth(client, market, L2_FETCH_DEPTH);
      const ts = Date.now();

      const best_bid = depth.bestBid ?? NaN;
      const best_ask = depth.bestAsk ?? NaN;
      const mid =
        Number.isFinite(best_bid) && Number.isFinite(best_ask) ? (best_bid + best_ask) / 2
          : Number.isFinite(best_bid) ? best_bid
            : Number.isFinite(best_ask) ? best_ask
              : NaN;

      if (Number.isFinite(best_bid) || Number.isFinite(best_ask)) {
        const levels_bids = (depth.bids ?? []).slice(0, PUBLISH_DEPTH);
        const levels_asks = (depth.asks ?? []).slice(0, PUBLISH_DEPTH);

        logger.log("phoenix_l2", {
          ts,
          market: market.toBase58(),
          symbol,
          best_bid,
          best_bid_str: Number.isFinite(best_bid) ? best_bid.toFixed(12) : undefined,
          best_ask,
          best_ask_str: Number.isFinite(best_ask) ? best_ask.toFixed(12) : undefined,
          phoenix_mid: Number.isFinite(mid) ? mid : undefined,
          tick_ms: TICK_MS,
          source: depth.source,
          levels_bids,
          levels_asks,
        });

        logger.log("phoenix_mid", {
          ts,
          market: market.toBase58(),
          symbol,
          px: Number.isFinite(mid) ? mid : undefined,
          px_str: Number.isFinite(mid) ? mid.toFixed(12) : undefined,
          best_bid: Number.isFinite(best_bid) ? best_bid : undefined,
          best_ask: Number.isFinite(best_ask) ? best_ask : undefined,
          tick_ms: TICK_MS,
          source: depth.source,
        });
      } else {
        logger.log("phoenix_l2_empty", {
          ts,
          market: market.toBase58(),
          symbol,
          haveBid: false,
          haveAsk: false,
          tick_ms: TICK_MS,
          source: depth.source,
        });
      }
    } catch (e: any) {
      logger.log("phoenix_poll_error", { market: marketStr, error: String(e?.message ?? e) });
    }

    kick = false;
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Use the RPC helper that attaches wsEndpoint when RPC_WSS_URL is set (Helius)
  const conn = makePhoenixConnection(COMMITMENT);

  const cfg = loadMarketsConfig();
  const envMarket = (process.env.PHOENIX_MARKET ?? "").trim();

  const seed: string[] = [];
  if (envMarket) seed.push(envMarket);
  (cfg ?? []).forEach(m => { if (m.phoenix?.market) seed.push(m.phoenix.market); });

  let client: any;
  try {
    client = await makeClient(conn, seed);
  } catch (e) {
    logger.log("phoenix_error", { stage: "client_create", err: String(e) });
    setInterval(() => { }, 1 << 30);
    return;
  }

  if (envMarket) {
    await runMarket(client, "SOL/USDC", envMarket);
    setInterval(() => { }, 1 << 30);
    return;
  }

  if (cfg && cfg.length) {
    const mkts = cfg.filter(m => m.phoenix?.market).map(m => ({
      symbol: m.symbol ?? "UNK",
      market: m.phoenix!.market,
    }));
    if (mkts.length) {
      for (const m of mkts) runMarket(client, m.symbol, m.market).catch(e =>
        logger.log("phoenix_fatal_market", { symbol: m.symbol, err: String(e) })
      );
      setInterval(() => { }, 1 << 30);
      return;
    }
  }

  // default single market
  await runMarket(client, "SOL/USDC", "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg");
  setInterval(() => { }, 1 << 30);
}

main().catch((e) => logger.log("phoenix_fatal", { err: String(e) }));

// keep atomic exports
export {
  buildPhoenixSwapIxs,
  type PhoenixSwapIxParams,
  type PhoenixIxBuildResult,
} from "./atomic.js";
