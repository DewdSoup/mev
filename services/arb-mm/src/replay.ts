// services/arb-mm/src/replay.ts
// Offline replay/backtest from JSONL logs (AMMs + Phoenix).
// - Reads runtime.jsonl from packages/amms + packages/phoenix
// - Reconstructs Phoenix book (real or synthetic from mid with TTL)
// - Applies the same slippage/threshold/fee decision math as main.ts
// - Emits per-opportunity logs + ML features + a summary JSON
//
// Defaults:
//   • If --from/--to are omitted, uses “yesterday” (UTC 00:00 → today UTC 00:00).
//   • Decision dedupe + coalescing to avoid double counting noisy states.
// Optional CLI: --from ISO --to ISO
//
// pnpm backtest  -> tsx src/replay.ts

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { logger } from "@mev/storage";
import { synthFromMid } from "./syntheticPhoenix.js";
import { emitFeature, featureFromEdgeAndDecision } from "./feature_sink.js";

// ── Small helpers ───────────────────────────────────────────────────────────
function round(n: number, p = 6) {
  return Number.isFinite(n) ? Number(n.toFixed(p)) : n;
}

// ── Load root .env ──────────────────────────────────────────────────────────
function loadRootEnv() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(process.cwd(), "..", "..", "..", ".env"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { dotenv.config({ path: p }); return; }
  }
  dotenv.config();
}
loadRootEnv();

// ── Env & config ────────────────────────────────────────────────────────────
function parseFloatEnv(v: string | undefined, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function parseMsEnv(v: string | undefined, def = 5000, min = 0, max = 600000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function parseBoolEnv(v: string | undefined, def = false) {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}
function resolvePathCandidates(rel: string) {
  const cwd = process.cwd();
  return [
    path.resolve(cwd, rel),
    path.resolve(cwd, "..", "..", rel),
    path.resolve(cwd, "../../..", rel),
  ];
}
function firstExistingPathOrDefault(relOrAbs: string): string {
  if (path.isAbsolute(relOrAbs)) return relOrAbs;
  const candidates = resolvePathCandidates(relOrAbs);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}

const AMMS_JSONL = firstExistingPathOrDefault(
  process.env.EDGE_AMMS_JSONL ?? "packages/amms/logs/runtime.jsonl"
);
const PHOENIX_JSONL = firstExistingPathOrDefault(
  process.env.EDGE_PHOENIX_JSONL ?? "packages/phoenix/logs/runtime.jsonl"
);

// Decision math (mirror main.ts)
const BOOK_TTL_MS         = parseMsEnv(process.env.PHOENIX_BOOK_TTL_MS, 5000);
const TRADE_THRESHOLD_BPS = parseFloatEnv(process.env.TRADE_THRESHOLD_BPS, 5);
const MAX_SLIPPAGE_BPS    = parseFloatEnv(process.env.MAX_SLIPPAGE_BPS, 1);
const TRADE_SIZE_BASE     = parseFloatEnv(process.env.TRADE_SIZE_BASE, 0.1);
const PHOENIX_FEE_BPS     = parseFloatEnv(process.env.PHOENIX_TAKER_FEE_BPS, 0);
const AMM_FEE_BPS         = parseFloatEnv(process.env.AMM_TAKER_FEE_BPS, 0);
const FIXED_TX_COST_QUOTE = parseFloatEnv(process.env.FIXED_TX_COST_QUOTE, 0);

// Decision dedupe / coalescing
const DECISION_DEDUPE_MS = parseMsEnv(process.env.DECISION_DEDUPE_MS, 1000, 0, 600000);
const DECISION_BUCKET_MS = parseMsEnv(process.env.DECISION_BUCKET_MS, 250, 0, 600000);
const DECISION_MIN_EDGE_DELTA_BPS = parseFloatEnv(process.env.DECISION_MIN_EDGE_DELTA_BPS, 0.25);

// (optional) allow trades off synthetic Phoenix (pyth) book
const ALLOW_SYNTH_TRADES = parseBoolEnv(process.env.ALLOW_SYNTH_TRADES, false);

// ── IO helpers ──────────────────────────────────────────────────────────────
function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out: any[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

function nnum(x: any): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function nstrNum(x: any): number | undefined {
  if (typeof x === "string") {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function extractTs(obj: any): number | undefined {
  const d = obj?.data ?? obj;
  const candidates = [
    obj?.ts, d?.ts, obj?.time_ms, d?.time_ms, obj?.timestamp, d?.timestamp,
    typeof obj?.time === "string" ? Date.parse(obj.time) : undefined,
    typeof d?.time === "string" ? Date.parse(d.time) : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string") {
      const t = Date.parse(c);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

// ── Types ───────────────────────────────────────────────────────────────────
type Ev =
  | { ts: number; typ: "amm"; px: number }
  | { ts: number; typ: "phxBook"; bid: number; ask: number; src: string }
  | { ts: number; typ: "phxMid"; px: number };

type PhoenixBookTS = { best_bid: number; best_ask: number; mid: number; source: string; ts: number; book_method?: string; };
type Mid = { px: number; ts: number };

// ── Parse event → Ev ────────────────────────────────────────────────────────
function toEv(obj: any, seqBase: number): Ev | null {
  const ev = (obj?.event ?? obj?.name ?? obj?.type ?? "") as string;
  const d = (obj?.data ?? obj) as any;

  const tMaybe = extractTs(obj);
  const ts: number = Number.isFinite(tMaybe as number) ? (tMaybe as number) : seqBase;

  if (ev === "amms_price") {
    const px = nnum(d?.px) ?? nstrNum(d?.px_str);
    if (typeof px === "number" && px > 0) return { ts, typ: "amm", px };
  }
  if (ev === "phoenix_l2") {
    const bid = nnum(d?.best_bid) ?? nstrNum(d?.best_bid_str);
    const ask = nnum(d?.best_ask) ?? nstrNum(d?.best_ask_str);
    if (typeof bid === "number" && typeof ask === "number") {
      return { ts, typ: "phxBook", bid, ask, src: d?.source ?? "book" };
    }
  }
  if (ev === "phoenix_mid") {
    const px = nnum(d?.px) ?? nstrNum(d?.px_str);
    if (typeof px === "number" && px > 0) return { ts, typ: "phxMid", px };
  }
  return null;
}

// ── Book freshness ──────────────────────────────────────────────────────────
function getFreshBook(book: PhoenixBookTS | null, mid: Mid | undefined, now: number): PhoenixBookTS | null {
  if (book && now - book.ts <= BOOK_TTL_MS) return book;
  if (mid) {
    const synth = synthFromMid(mid.px, now);
    if (synth) return { ...synth, ts: now, source: (synth as any).source ?? "synth" };
  }
  return null;
}

// ── Decision math (mirror main.ts) ─────────────────────────────────────────
function decide(
  ammMid: number,
  book: PhoenixBookTS,
  thresholdBps: number,
  slippageBps: number,
  tradeSizeBase: number,
  phoenixFeeBps: number,
  ammFeeBps: number,
  fixedTxCostQuote: number
) {
  const slip = slippageBps / 10_000;
  const phxFee = phoenixFeeBps / 10_000;
  const ammFee = ammFeeBps / 10_000;

  const buyEff  = (px: number, fee: number) => px * (1 + slip) * (1 + fee);
  const sellEff = (px: number, fee: number) => px * (1 - slip) * (1 - fee);

  // A: AMM -> PHX
  const buyA   = buyEff(ammMid, ammFee);
  const sellA  = sellEff(book.best_bid, phxFee);
  const bpsA   = ((sellA / buyA) - 1) * 10_000;
  const pnlA   = (sellA - buyA) * tradeSizeBase - fixedTxCostQuote;

  // B: PHX -> AMM
  const buyB   = buyEff(book.best_ask, phxFee);
  const sellB  = sellEff(ammMid, ammFee);
  const bpsB   = ((sellB / buyB) - 1) * 10_000;
  const pnlB   = (sellB - buyB) * tradeSizeBase - fixedTxCostQuote;

  const bpsGrossA = (book.best_bid / ammMid - 1) * 10_000; // visibility only
  const bpsGrossB = (ammMid / book.best_ask - 1) * 10_000;

  const chooseA = bpsA >= bpsB;
  const best = chooseA
    ? { path: "AMM->PHX" as const, side: "sell" as const, buyPx: buyA, sellPx: sellA, edgeBpsNet: bpsA, edgeBpsGross: bpsGrossA, expectedPnl: pnlA }
    : { path: "PHX->AMM" as const, side: "buy"  as const, buyPx: buyB, sellPx: sellB, edgeBpsNet: bpsB, edgeBpsGross: bpsGrossB, expectedPnl: pnlB };

  const wouldTrade = best.edgeBpsNet >= thresholdBps && best.expectedPnl >= 0;

  return {
    ...best,
    wouldTrade,
  };
}

// ── File utils for outputs ──────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), "data");

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function dayStr(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ── CLI (optional) ─────────────────────────────────────────────────────────
type CLI = {
  from?: number;
  to?: number;
};
function parseArgs(): CLI {
  const args = process.argv.slice(2);
  function val(k: string): string | undefined {
    const i = args.findIndex(a => a === `--${k}` || a.startsWith(`--${k}=`));
    if (i === -1) return undefined;
    return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
  }
  function iso(s?: string): number | undefined {
    if (!s) return undefined;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : undefined;
  }
  return {
    from: iso(val("from")),
    to: iso(val("to")),
  };
}
const CLI = parseArgs();

function defaultYesterdayUTC(): { from: number; to: number } {
  const now = new Date();
  const todayMidnightUTC = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0
  );
  return { from: todayMidnightUTC - 24 * 3600_000, to: todayMidnightUTC };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const ammsRaw = readJsonl(AMMS_JSONL);
  const phxRaw  = readJsonl(PHOENIX_JSONL);

  // Pull last timestamps just for display
  const ammsLastTs = ammsRaw.map(extractTs).filter((x): x is number => typeof x === "number").pop() ?? 0;
  const phxLastTs  = phxRaw.map(extractTs).filter((x): x is number => typeof x === "number").pop() ?? 0;
  logger.log("replay_info", {
    amms_last_update: ammsLastTs ? new Date(ammsLastTs).toISOString() : null,
    phoenix_last_update: phxLastTs ? new Date(phxLastTs).toISOString() : null,
  });
  console.log(`AMMs last update: ${ammsLastTs ? new Date(ammsLastTs).toISOString() : "N/A"}`);
  console.log(`Phoenix last update: ${phxLastTs ? new Date(phxLastTs).toISOString() : "N/A"}`);

  // Convert to typed events with monotonic fallback timestamps
  const evs: Ev[] = [];
  let seq = 0;
  for (const r of ammsRaw)  { const e = toEv(r, ++seq); if (e?.typ === "amm")     evs.push(e); }
  for (const r of phxRaw)   { const e = toEv(r, ++seq); if (e)                    evs.push(e); }

  evs.sort((a, b) => a.ts - b.ts);

  // Default to yesterday unless CLI overrides
  const def = defaultYesterdayUTC();
  const from = CLI.from ?? def.from;
  const to   = CLI.to   ?? def.to;

  logger.log("replay_config", {
    window_from: new Date(from).toISOString(),
    window_to: new Date(to).toISOString(),
    book_ttl_ms: BOOK_TTL_MS,
    decision_dedupe_ms: DECISION_DEDUPE_MS,
    decision_bucket_ms: DECISION_BUCKET_MS,
    min_edge_delta_bps: DECISION_MIN_EDGE_DELTA_BPS,
    allow_synth_trades: ALLOW_SYNTH_TRADES,
  });
  console.log(
    `Replay window: ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`
  );
  console.log(
    `Replay config: dedupe_ms=${DECISION_DEDUPE_MS}, bucket_ms=${DECISION_BUCKET_MS}, min_edge_delta_bps=${DECISION_MIN_EDGE_DELTA_BPS}, allow_synth_trades=${ALLOW_SYNTH_TRADES}`
  );

  // State
  let amm: Mid | undefined;
  let phxMid: Mid | undefined;
  let phxBook: PhoenixBookTS | null = null;

  // Metrics
  let considered = 0;
  let wouldTradeCnt = 0;
  let wouldNotCnt   = 0;
  let bestEdge = -Infinity;
  let worstEdge = +Infinity;
  let pnlSum = 0;

  // Dedupe state:
  const recentSigTs = new Map<string, number>(); // signature → lastTs
  const lastByPath = new Map<"AMM->PHX" | "PHX->AMM", { edgeNet: number; ts: number }>();
  let lastBucket = -1;
  let lastPath: "AMM->PHX" | "PHX->AMM" | "" = "";

  // Feature file (by run-day)
  const runTs = Date.now();
  const featDir = path.join(DATA_DIR, "features", "sol_usdc", "v1");
  ensureDir(featDir);
  const featFile = path.join(featDir, `${dayStr(runTs)}.jsonl`);
  // feature_sink.ts will append per emitFeature()

  // Iterate
  let iter = 0;
  for (const e of evs) {
    if (e.ts < from || e.ts > to) continue;

    if (e.typ === "amm") {
      amm = { px: e.px, ts: e.ts };
    } else if (e.typ === "phxMid") {
      phxMid = { px: e.px, ts: e.ts };
    } else if (e.typ === "phxBook") {
      phxBook = {
        best_bid: e.bid,
        best_ask: e.ask,
        mid: (e.bid + e.ask) / 2,
        source: "book",
        ts: e.ts,
        book_method: e.src,
      };
    }

    if (!amm) continue;
    const book = getFreshBook(phxBook, phxMid, e.ts);
    if (!book) continue;

    // Signature of state (rounded)
    const sig = `${amm.px.toFixed(6)}|${book.best_bid.toFixed(6)}|${book.best_ask.toFixed(6)}`;
    if (DECISION_DEDUPE_MS > 0) {
      const seenAt = recentSigTs.get(sig);
      if (typeof seenAt === "number" && (e.ts - seenAt) < DECISION_DEDUPE_MS) {
        continue; // skip identical state seen recently
      }
      recentSigTs.set(sig, e.ts);
      // periodic prune
      if ((++iter & 0x3ff) === 0) { // every 1024 iterations
        const cutoff = e.ts - DECISION_DEDUPE_MS - 1;
        for (const [k, t] of recentSigTs) if (t < cutoff) recentSigTs.delete(k);
      }
    }

    // Compute decision
    const d = decide(
      amm.px,
      book,
      TRADE_THRESHOLD_BPS,
      MAX_SLIPPAGE_BPS,
      TRADE_SIZE_BASE,
      PHOENIX_FEE_BPS,
      AMM_FEE_BPS,
      FIXED_TX_COST_QUOTE
    );

    // Optional: synth book gating for trades (still record edge)
    const isSynth = (book.source ?? "").toLowerCase().includes("synth");
    const allowTradeThisTick = !isSynth || ALLOW_SYNTH_TRADES;

    // Per-path edge delta coalescing within window
    if (DECISION_DEDUPE_MS > 0) {
      const prev = lastByPath.get(d.path);
      if (prev && (e.ts - prev.ts) < DECISION_DEDUPE_MS) {
        const smallChange = Math.abs(d.edgeBpsNet - prev.edgeNet) < DECISION_MIN_EDGE_DELTA_BPS;
        if (smallChange) {
          continue; // skip tiny edge wiggles on same path within the window
        }
      }
      lastByPath.set(d.path, { edgeNet: d.edgeBpsNet, ts: e.ts });
    }

    // Bucket coalescing (optional)
    if (DECISION_BUCKET_MS > 0) {
      const bucket = Math.floor(e.ts / DECISION_BUCKET_MS);
      const sameBucket = bucket === lastBucket;
      const samePath = d.path === lastPath;
      if (sameBucket && samePath) {
        continue;
      }
      lastBucket = bucket;
      lastPath = d.path;
    }

    considered++;

    // Mirror edge report
    const toPhoenixSellBps = (amm.px / book.best_bid - 1) * 10_000;
    const toPhoenixBuyBps  = (book.best_ask / amm.px - 1) * 10_000;
    const absBps = Math.max(Math.abs(toPhoenixSellBps), Math.abs(toPhoenixBuyBps));

    logger.log("replay_edge", {
      symbol: "SOL/USDC",
      amm_mid: round(amm.px),
      phoenix_bid: round(book.best_bid),
      phoenix_ask: round(book.best_ask),
      phoenix_mid: round(book.mid),
      phoenix_source: book.source,
      phoenix_book_method: book.book_method ?? "unknown",
      toPhoenixSellBps: round(toPhoenixSellBps, 4),
      toPhoenixBuyBps: round(toPhoenixBuyBps, 4),
      absBps: round(absBps, 4),
    });

    // Decide whether to emit trade/not_trade (respecting synth gating)
    const wouldTrade = d.wouldTrade && allowTradeThisTick;

    if (wouldTrade) {
      wouldTradeCnt++;
      pnlSum += d.expectedPnl;
      logger.log("replay_would_trade", {
        symbol: "SOL/USDC",
        path: d.path,
        side: d.side,
        trade_size_base: TRADE_SIZE_BASE,
        threshold_bps: TRADE_THRESHOLD_BPS,
        slippage_bps: MAX_SLIPPAGE_BPS,
        phoenix_source: book.source,
        phoenix_book_method: book.book_method ?? "unknown",
        buy_px: round(d.buyPx),
        sell_px: round(d.sellPx),
        edge_bps_net: round(d.edgeBpsNet, 4),
        expected_pnl: round(d.expectedPnl, 6),
        fees_bps: { phoenix: PHOENIX_FEE_BPS, amm: AMM_FEE_BPS },
        fixed_tx_cost_quote: FIXED_TX_COST_QUOTE,
        reason: "edge above threshold",
      });
    } else {
      wouldNotCnt++;
      const reason =
        !allowTradeThisTick ? "synth_book_disallowed" :
        d.expectedPnl < 0 ? "negative expected pnl after fees/slippage" :
        "edge below threshold";
      logger.log("replay_would_not_trade", {
        symbol: "SOL/USDC",
        path: d.path,
        side: d.side,
        trade_size_base: TRADE_SIZE_BASE,
        threshold_bps: TRADE_THRESHOLD_BPS,
        slippage_bps: MAX_SLIPPAGE_BPS,
        phoenix_source: book.source,
        phoenix_book_method: book.book_method ?? "unknown",
        buy_px: round(d.buyPx),
        sell_px: round(d.sellPx),
        edge_bps_net: round(d.edgeBpsNet, 4),
        expected_pnl: round(d.expectedPnl, 6),
        fees_bps: { phoenix: PHOENIX_FEE_BPS, amm: AMM_FEE_BPS },
        fixed_tx_cost_quote: FIXED_TX_COST_QUOTE,
        reason,
      });
    }

    if (d.edgeBpsNet > bestEdge) bestEdge = d.edgeBpsNet;
    if (d.edgeBpsNet < worstEdge) worstEdge = d.edgeBpsNet;

    // Emit ML feature row (aligns with live sink)
    emitFeature(
      featureFromEdgeAndDecision(
        {
          symbol: "SOL/USDC",
          amm_mid: round(amm.px),
          phoenix_bid: round(book.best_bid),
          phoenix_ask: round(book.best_ask),
          phoenix_mid: round(book.mid),
          toPhoenixSellBps: round(toPhoenixSellBps, 4),
          toPhoenixBuyBps: round(toPhoenixBuyBps, 4),
          absBps: round(absBps, 4),
          phoenix_source: book.source,
          phoenix_book_method: book.book_method,
          book_ttl_ms: BOOK_TTL_MS,
        },
        {
          path: d.path,
          side: d.side,
          edge_bps_gross: round(d.edgeBpsGross, 4),
          buy_px: round(d.buyPx),
          sell_px: round(d.sellPx),
          expected_pnl: round(d.expectedPnl, 6),
          threshold_bps: TRADE_THRESHOLD_BPS,
          slippage_bps: MAX_SLIPPAGE_BPS,
          trade_size_base: TRADE_SIZE_BASE,
          would_trade: wouldTrade,
        }
      )
    );
  }

  // Summary
  const summary = {
    considered,
    would_trade: wouldTradeCnt,
    would_not_trade: wouldNotCnt,
    pnl_sum: round(pnlSum, 6),
    best_edge_bps: Number.isFinite(bestEdge) ? round(bestEdge, 4) : 0,
    worst_edge_bps: Number.isFinite(worstEdge) ? round(worstEdge, 4) : 0,
    threshold_bps: TRADE_THRESHOLD_BPS,
    slippage_bps: MAX_SLIPPAGE_BPS,
    trade_size_base: TRADE_SIZE_BASE,
    book_ttl_ms: BOOK_TTL_MS,
    decision_dedupe_ms: DECISION_DEDUPE_MS,
    decision_bucket_ms: DECISION_BUCKET_MS,
    min_edge_delta_bps: DECISION_MIN_EDGE_DELTA_BPS,
    allow_synth_trades: ALLOW_SYNTH_TRADES,
  };

  const replayDir = path.join(DATA_DIR, "replay");
  ensureDir(replayDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
  const summaryFile = path.join(replayDir, `${stamp}.summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

  console.log("──────────────────────────────────────────────────");
  console.log(`Replay window: ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);
  console.log(`Considered: ${considered} | WOULD_TRADE: ${wouldTradeCnt} | WOULD_NOT: ${wouldNotCnt}`);
  console.log(`pnl_sum: ${summary.pnl_sum} | best_edge_bps: ${summary.best_edge_bps} | worst_edge_bps: ${summary.worst_edge_bps}`);
  console.log(`Features → ${path.relative(process.cwd(), path.join(DATA_DIR, "features", "sol_usdc", "v1", `${dayStr(Date.now())}.jsonl`))}`);
  console.log(`Summary  → ${path.relative(process.cwd(), summaryFile)}`);
  console.log("──────────────────────────────────────────────────");
}

main().catch((e) => logger.log("replay_fatal", { error: String(e) }));
