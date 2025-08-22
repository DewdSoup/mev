// packages/phoenix/src/index.ts
// Phoenix L2 publisher with robust .env loading, Helius-first RPC, SDK multi-path L2,
// optional WS subscribe, and Pyth fallback (Hermes).
// Adds top-N depth arrays (levels_bids/levels_asks) for depth-walking on the consumer side.
//
// Emits:
//   - phoenix_l2 { ts, market, symbol, best_bid/best_ask, phoenix_mid, tick_ms, source, levels_*? }
//   - phoenix_mid { ts, market, symbol, px, px_str, best_bid?, best_ask?, tick_ms, source }
//   - phoenix_l2_empty { ts, market, symbol, haveBid, haveAsk, tick_ms, source }

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Client, type MarketState } from "@ellipsis-labs/phoenix-sdk";
import { logger } from "@mev/storage";

// ── Load .env from repo root ────────────────────────────────────────────────
function loadRootEnv() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(process.cwd(), "..", "..", "..", ".env"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      return;
    }
  }
  dotenv.config();
}
loadRootEnv();

// ── Env helpers ─────────────────────────────────────────────────────────────
function parseMsEnv(v: string | undefined, def = 2000, min = 200, max = 60000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function parseIntEnv(v: string | undefined, def = 1, min = 1, max = 50) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function parseBoolEnv(v: string | undefined, def = true) {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

// ── RPC: Helius-first ──────────────────────────────────────────────────────
function resolveRpc(): string {
  const primary = process.env.RPC_PRIMARY?.trim();
  if (primary) return primary;
  const heliusKey = process.env.HELIUS_API_KEY?.trim();
  if (heliusKey) return `https://rpc.helius.xyz/?api-key=${heliusKey}`;
  return clusterApiUrl("mainnet-beta");
}
function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "***");
    return url.toString();
  } catch {
    return u;
  }
}
const RPC = resolveRpc();

const TICK_MS = parseMsEnv(process.env.PHOENIX_TICK_MS, 2000, 200, 60000);
const L2_FETCH_DEPTH = parseIntEnv(process.env.PHOENIX_L2_DEPTH, 12, 1, 50);
const PUBLISH_DEPTH = parseIntEnv(process.env.PHOENIX_DEPTH_LEVELS, L2_FETCH_DEPTH, 1, 50);
const TRY_WS = parseBoolEnv(process.env.PHOENIX_WS_ENABLED, true);

// ── Config models ───────────────────────────────────────────────────────────
type MarketCfg = {
  symbol: string;
  phoenix?: { market: string };
  pyth_price_id?: string;
};

function loadMarketsConfig(): MarketCfg[] | null {
  const candidates = [
    path.resolve(process.cwd(), "configs/markets.json"),
    path.resolve(process.cwd(), "..", "..", "configs", "markets.json"),
    path.resolve(process.cwd(), "..", "..", "..", "configs", "markets.json"),
    path.resolve(process.cwd(), "..", "..", "..", "packages", "phoenix", "configs", "markets.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const arr = JSON.parse(fs.readFileSync(p, "utf8")) as MarketCfg[];
      if (Array.isArray(arr) && arr.length) return arr;
    } catch { /* ignore */ }
  }
  return null;
}

// ── SDK Client helpers ──────────────────────────────────────────────────────
async function makeClient(conn: Connection): Promise<Client> {
  const anyClient = Client as any;
  if (typeof anyClient.create === "function") return await anyClient.create(conn);
  return new anyClient(conn) as Client;
}

type MaybeBbo = {
  bestBid?: number;
  bestAsk?: number;
  source: string;
  bids?: Array<{ px: number; qty: number }>;
  asks?: Array<{ px: number; qty: number }>;
};

function extractPx(lvl: any): number | undefined {
  if (!lvl) return undefined;
  if (typeof lvl.price === "number") return lvl.price;
  if (typeof lvl.uiPrice === "number") return lvl.uiPrice;
  if (typeof lvl.price?.toNumber === "function") return lvl.price.toNumber();
  if (typeof lvl?.toNumber === "function") return lvl.toNumber();
  return undefined;
}
function extractQty(lvl: any): number | undefined {
  if (!lvl) return undefined;
  if (typeof lvl.quantity === "number") return lvl.quantity;
  if (typeof lvl.uiQuantity === "number") return lvl.uiQuantity;
  if (typeof lvl.quantity?.toNumber === "function") return lvl.quantity.toNumber();
  if (typeof lvl?.baseLots?.toNumber === "function" && typeof lvl?.lotSize === "number") {
    return lvl.baseLots.toNumber() * lvl.lotSize;
  }
  return undefined;
}
function mapDepthSide(sideArr: any[] | undefined, max: number) {
  const out: Array<{ px: number; qty: number }> = [];
  if (!Array.isArray(sideArr)) return out;
  for (const lvl of sideArr.slice(0, max)) {
    const px = extractPx(lvl);
    const qty = extractQty(lvl);
    if (typeof px === "number" && px > 0 && typeof qty === "number" && qty > 0) {
      out.push({ px, qty });
    }
  }
  return out;
}

// Helper: await if promise-like, else return directly
async function maybeAwait<T>(v: T): Promise<T extends Promise<infer U> ? U : T> {
  if (v && typeof (v as any).then === "function") {
    return await (v as any);
  }
  return v as any;
}

// Try a set of SDK methods that exist in different versions.
async function trySdkL2(client: any, marketStr: string, marketPk: PublicKey): Promise<MaybeBbo | null> {
  // 0) getUiLadder / getLadder
  for (const method of ["getUiLadder", "getLadder"] as const) {
    const f = (client as any)[method];
    if (typeof f === "function") {
      try {
        let ladder = f.length >= 2 ? f.call(client, marketStr, L2_FETCH_DEPTH) : f.call(client, marketStr);
        ladder = await maybeAwait(ladder);
        const bids = mapDepthSide((ladder as any)?.bids, PUBLISH_DEPTH);
        const asks = mapDepthSide((ladder as any)?.asks, PUBLISH_DEPTH);
        const bestBid = bids[0]?.px ?? extractPx((ladder as any)?.bestBid);
        const bestAsk = asks[0]?.px ?? extractPx((ladder as any)?.bestAsk);
        if (bestBid || bestAsk) return { bestBid, bestAsk, source: `sdk:${method}`, bids, asks };
      } catch (e) {
        logger.log("phoenix_warn", { stage: method, err: String(e), market: marketStr });
      }
    }
  }

  // 1) getL2 (try string then PublicKey)
  if (typeof (client as any).getL2 === "function") {
    try {
      const l2s = await maybeAwait((client as any).getL2(marketStr, L2_FETCH_DEPTH));
      const bids = mapDepthSide(l2s?.bids, PUBLISH_DEPTH);
      const asks = mapDepthSide(l2s?.asks, PUBLISH_DEPTH);
      const bestBid = bids[0]?.px;
      const bestAsk = asks[0]?.px;
      if (bestBid || bestAsk) return { bestBid, bestAsk, source: "sdk:getL2:str", bids, asks };
    } catch {}
    try {
      const l2p = await maybeAwait((client as any).getL2(marketPk, L2_FETCH_DEPTH));
      const bids = mapDepthSide(l2p?.bids, PUBLISH_DEPTH);
      const asks = mapDepthSide(l2p?.asks, PUBLISH_DEPTH);
      const bestBid = bids[0]?.px;
      const bestAsk = asks[0]?.px;
      if (bestBid || bestAsk) return { bestBid, bestAsk, source: "sdk:getL2:pk", bids, asks };
    } catch (e) {
      logger.log("phoenix_warn", { stage: "getL2", err: String(e), market: marketStr });
    }
  }

  // 2) getBbo (fallback, no depth)
  if (typeof (client as any).getBbo === "function") {
    try {
      const bboS = await maybeAwait((client as any).getBbo(marketStr));
      const bestBid = typeof bboS?.bestBid === "number" ? bboS.bestBid : extractPx(bboS?.bestBid);
      const bestAsk = typeof bboS?.bestAsk === "number" ? bboS.bestAsk : extractPx(bboS?.bestAsk);
      if (bestBid || bestAsk) return { bestBid, bestAsk, source: "sdk:getBbo:str" };
    } catch {}
    try {
      const bboP = await maybeAwait((client as any).getBbo(marketPk));
      const bestBid = typeof bboP?.bestBid === "number" ? bboP.bestBid : extractPx(bboP?.bestBid);
      const bestAsk = typeof bboP?.bestAsk === "number" ? bboP.bestAsk : extractPx(bboP?.bestAsk);
      if (bestBid || bestAsk) return { bestBid, bestAsk, source: "sdk:getBbo:pk" };
    } catch (e) {
      logger.log("phoenix_warn", { stage: "getBbo", err: String(e), market: marketStr });
    }
  }

  // 3) refreshMarket and inspect OB (depth capable)
  try {
    let ms: MarketState | undefined;
    try { ms = await maybeAwait((client as any).refreshMarket(marketStr, false)); } catch {}
    if (!ms) { try { ms = await maybeAwait((client as any).refreshMarket(marketPk, false)); } catch {} }
    if (ms) {
      const ob: any = (ms as any)?.orderBook ?? (ms as any)?.book ?? undefined;
      const bidsRaw: any[] =
        (Array.isArray(ob?.bids) ? ob.bids :
        Array.isArray(ob?.book?.bids) ? ob.book.bids : []) as any[];
      const asksRaw: any[] =
        (Array.isArray(ob?.asks) ? ob.asks :
        Array.isArray(ob?.book?.asks) ? ob.book.asks : []) as any[];
      const bids = mapDepthSide(bidsRaw, PUBLISH_DEPTH);
      const asks = mapDepthSide(asksRaw, PUBLISH_DEPTH);
      const bestBid = bids[0]?.px;
      const bestAsk = asks[0]?.px;
      if (bestBid || bestAsk) return { bestBid, bestAsk, source: "refreshMarket:orderBook", bids, asks };
    }
  } catch (e) {
    logger.log("phoenix_warn", { stage: "refreshMarket_inspect", err: String(e), market: marketStr });
  }

  return null;
}

// Optional WS subscription (best-effort): per market
async function tryAttachWs(
  client: any,
  marketStr: string,
  marketPk: PublicKey,
  setWs: (bbo: { bid?: number; ask?: number } | null) => void
) {
  if (!TRY_WS) return;
  const candidates = ["subscribeL2", "subscribeToL2", "subscribeToMarket", "onMarketUpdate"];

  for (const fn of candidates) {
    const f = client?.[fn];
    if (typeof f !== "function") continue;

    const cb = (l2: any) => {
      try {
        const bid = Array.isArray(l2?.bids) && l2.bids[0] ? extractPx(l2.bids[0]) : undefined;
        const ask = Array.isArray(l2?.asks) && l2.asks[0] ? extractPx(l2.asks[0]) : undefined;
        if (bid || ask) setWs({ bid, ask });
      } catch {}
    };

    try {
      try { await f.call(client, marketStr, L2_FETCH_DEPTH, cb); } catch {}
      try { await f.call(client, marketStr, cb, L2_FETCH_DEPTH); } catch {}
      try { await f.call(client, marketStr, cb); } catch {}
      try { await f.call(client, marketPk, L2_FETCH_DEPTH, cb); } catch {}
      try { await f.call(client, marketPk, cb, L2_FETCH_DEPTH); } catch {}
      try { await f.call(client, marketPk, cb); } catch {}
      logger.log("phoenix_ws_attach_attempted", { method: fn, market: marketStr });
    } catch (e) {
      logger.log("phoenix_warn", { stage: "ws_attach", method: fn, err: String(e), market: marketStr });
    }
  }
}

// ── Pyth fallback (Hermes) ─────────────────────────────────────────────────
async function fetchPythMid(pythId: string | undefined): Promise<number | undefined> {
  if (!pythId) return undefined;
  try {
    const url = `https://hermes.pyth.network/api/latest_price_feeds?ids[]=${encodeURIComponent(pythId)}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`pyth_http_${res.status}`);
    const arr: any = await res.json();
    const item = Array.isArray(arr) ? arr[0] : null;
    const px = item?.price?.price ?? item?.ema_price?.price;
    const expo = item?.price?.expo ?? item?.ema_price?.expo;
    if (typeof px === "string" || typeof px === "number") {
      const n = Number(px);
      if (Number.isFinite(n) && typeof expo === "number") {
        const m = n * Math.pow(10, expo); // expo is negative for USD pairs
        return Number(m);
      }
    }
  } catch (e) {
    logger.log("phoenix_warn", { stage: "pyth_http", err: String(e), pyth: (pythId ?? "").slice(0, 10) + "..." });
  }
  return undefined;
}

// ── Emitters ────────────────────────────────────────────────────────────────
function fmtPx(n: number | undefined): { px?: number; px_str?: string } {
  if (typeof n !== "number" || !Number.isFinite(n)) return {};
  const px = Number(n.toFixed(6));
  const px_str = n.toFixed(9);
  return { px, px_str };
}

function publishL2(
  symbol: string,
  marketStr: string,
  bestBid: number,
  bestAsk: number,
  meta: Record<string, unknown> = {}
) {
  const bidFmt = fmtPx(bestBid);
  const askFmt = fmtPx(bestAsk);
  const mid = (bestBid + bestAsk) / 2;
  logger.log("phoenix_l2", {
    ts: Date.now(),
    market: marketStr,
    symbol,
    best_bid: bidFmt.px,
    best_bid_str: bidFmt.px_str,
    best_ask: askFmt.px,
    best_ask_str: askFmt.px_str,
    phoenix_mid: Number(mid.toFixed(6)),
    tick_ms: TICK_MS,
    ...meta, // may include source + levels_bids/levels_asks
  });
}

function publishMid(
  symbol: string,
  marketStr: string,
  bestBid?: number,
  bestAsk?: number,
  meta: Record<string, unknown> = {}
) {
  if (typeof bestBid !== "number" || typeof bestAsk !== "number") return;
  const mid = (bestBid + bestAsk) / 2;
  const bidFmt = fmtPx(bestBid);
  const askFmt = fmtPx(bestAsk);
  const midFmt = fmtPx(mid);

  logger.log("phoenix_mid", {
    ts: Date.now(),
    market: marketStr,
    symbol,
    ...midFmt,
    best_bid: bidFmt.px,
    best_bid_str: bidFmt.px_str,
    best_ask: askFmt.px,
    best_ask_str: askFmt.px_str,
    tick_ms: TICK_MS,
    ...meta,
  });
}

// ── Per-market runner ───────────────────────────────────────────────────────
async function runMarket(client: any, symbol: string, marketStr: string, pythId?: string) {
  const marketPk = new PublicKey(marketStr);

  // One-time “loaded”
  try {
    let ms: MarketState | undefined;
    try { ms = await (client as any).refreshMarket?.(marketStr, false); } catch {}
    if (!ms) { try { ms = await (client as any).refreshMarket?.(marketPk, false); } catch {} }
    const ob: any = (ms as any)?.orderBook ?? (ms as any)?.book ?? undefined;
    const hasBids =
      !!((Array.isArray(ob?.bids) && ob.bids.length > 0) ||
        (Array.isArray(ob?.book?.bids) && ob.book.bids.length > 0));
    const hasAsks =
      !!((Array.isArray(ob?.asks) && ob.asks.length > 0) ||
        (Array.isArray(ob?.book?.asks) && ob.book.asks.length > 0));
    logger.log("phoenix_loaded", { id: marketStr, name: symbol, hasBids, hasAsks });
  } catch (err) {
    logger.log("phoenix_error", { stage: "refresh_market", market: symbol, err: String(err) });
  }

  // Try to attach WS (best-effort)
  let wsBbo: { bid?: number; ask?: number } | null = null;
  tryAttachWs(client, marketStr, marketPk, (bbo) => { wsBbo = bbo; }).catch(() => {});

  const tick = async () => {
    // WS snapshot
    if (wsBbo && (typeof wsBbo.bid === "number" && typeof wsBbo.ask === "number")) {
      const bid = wsBbo.bid!;
      const ask = wsBbo.ask!;
      publishL2(symbol, marketStr, bid, ask, { source: "sdk:ws-l2" });
      publishMid(symbol, marketStr, bid, ask, { source: "sdk:ws-l2" });
      return;
    }

    // Sync SDK paths
    let got: MaybeBbo | null = null;
    try {
      got = await trySdkL2(client, marketStr, marketPk);
    } catch (e) {
      logger.log("phoenix_warn", { stage: "trySdkL2", err: String(e), market: marketStr });
    }

    if (got && typeof got.bestBid === "number" && typeof got.bestAsk === "number") {
      const meta: Record<string, unknown> = { source: got.source };
      if (Array.isArray(got.bids)) meta.levels_bids = got.bids;
      if (Array.isArray(got.asks)) meta.levels_asks = got.asks;
      publishL2(symbol, marketStr, got.bestBid, got.bestAsk, meta);
      publishMid(symbol, marketStr, got.bestBid, got.bestAsk, { source: got.source });
      return;
    }

    // Empty + Pyth fallback
    logger.log("phoenix_l2_empty", {
      ts: Date.now(),
      market: marketStr,
      symbol,
      haveBid: false,
      haveAsk: false,
      tick_ms: TICK_MS,
      source: "none",
    });

    const pythPx = await fetchPythMid(pythId);
    if (typeof pythPx === "number" && Number.isFinite(pythPx)) {
      const n = Number(pythPx.toFixed(6));
      logger.log("phoenix_mid", {
        ts: Date.now(),
        market: marketStr,
        symbol,
        px: n,
        px_str: pythPx.toFixed(9),
        tick_ms: TICK_MS,
        source: "pyth",
        pyth_id: pythId,
      });
    }
  };

  // run once now, then interval
  tick().catch((e) => logger.log("phoenix_warn", { stage: "initial_tick", err: String(e), market: marketStr }));
  setInterval(() => {
    tick().catch((e) => logger.log("phoenix_warn", { stage: "tick", err: String(e), market: marketStr }));
  }, TICK_MS);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  logger.log("phoenix_boot", { rpc: maskUrl(RPC) });
  const conn = new Connection(RPC, { commitment: "processed" });
  let client: any;

  try {
    client = await makeClient(conn);
  } catch (e) {
    logger.log("phoenix_error", { stage: "client_create", err: String(e) });
    setInterval(() => {}, 1 << 30);
    return;
  }

  // ENV-FIRST single market
  const envMarket = (process.env.PHOENIX_MARKET ?? "").trim();
  if (envMarket) {
    await runMarket(client, "SOL/USDC", envMarket, (process.env.PYTH_PRICE_ID_SOL_USDC ?? "").trim() || undefined);
    setInterval(() => {}, 1 << 30);
    return;
  }

  // CONFIG multi-market
  const cfg = loadMarketsConfig();
  if (cfg && cfg.length) {
    const markets = cfg
      .filter(m => m.phoenix?.market)
      .map(m => ({ symbol: m.symbol, market: m.phoenix!.market, pyth: m.pyth_price_id }));

    if (markets.length) {
      for (const m of markets) runMarket(client, m.symbol, m.market, m.pyth).catch((e) => logger.log("phoenix_fatal_market", { symbol: m.symbol, err: String(e) }));
      setInterval(() => {}, 1 << 30);
      return;
    }
  }

  // Default single market (SOL/USDC)
  await runMarket(client, "SOL/USDC", "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg", (process.env.PYTH_PRICE_ID_SOL_USDC ?? "").trim() || undefined);

  // keep alive
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => logger.log("phoenix_fatal", { err: String(e) }));

// ────────────────────────────────────────────────────────────────────────────
// Export atomic taker builder for arb-mm (lives in ./atomic.ts)
export {
  buildPhoenixSwapIxs,
  type PhoenixSwapIxParams,
  type PhoenixIxBuildResult,
} from "./atomic.js";
