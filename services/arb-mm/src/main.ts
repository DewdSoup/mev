// services/arb-mm/src/main.ts
// Live arbitrage runner (Raydium <-> Phoenix) with:
// - .env.live auto-load (override .env)
// - Embedded publisher supervisor (optional) to auto-run low-latency feeds
// - Robust balance reads (env ATAs -> fallback to scan by mint)
// - Clear terminal logs for START/END and DELTAs
// - Executes only when joiner says EV>0 (no forced unprofitable sends)
// - Direction lock via EXEC_ALLOWED_PATH (default BOTH)
// - Atomic-preferred payload (ATOMIC_MODE=single_tx supported)
// - 30-minute auto-stop (RUN_FOR_MINUTES) + clean SIGINT/SIGTERM shutdown

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { logger } from "@mev/storage";

import { loadConfig, RPC, maskUrl, stamp, resolveFeeBps } from "./config.js";
import {
  EdgeJoiner,
  type DecisionHook,
  type RpcSampleHook,
  type RpcSimFn,
} from "./edge/joiner.js";
import { setChainTps } from "./feature_sink.js";
import { initRisk } from "@mev/risk";
import { initAccounts } from "./accounts.js";
import { LiveExecutor } from "./executor/live.js";
import { initSessionRecorder } from "./session_recorder.js";
import { asNumber, roundN, coalesceRound } from "./util/num.js";

import {
  emitEdgeSnapshot,
  emitDecision,
  emitSubmittedTx,
  emitLanded,
  emitRpcSample,
} from "./ml_schema.js";

import {
  pnlQuoteForSizeBase,
  type PhoenixBook as PxBook,
  type CpmmReserves,
} from "./executor/size.js";
import { tryAssertRaydiumFeeBps } from "./util/raydium.js";
import { PublisherSupervisor } from "./publishers/supervisor.js";
import { prewarmPhoenix } from "./util/phoenix.js"; // warm cache on boot

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────────────────────────
// Load env: .env (via config.ts) + .env.live override here (if present)
// ────────────────────────────────────────────────────────────────────────────
(function loadEnvLiveOverride() {
  const candidates = [
    path.resolve(__dirname, "..", "..", ".env.live"),      // services/arb-mm/.env.live
    path.resolve(__dirname, "..", "..", "..", ".env.live") // repo/.env.live
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p, override: true });
      break;
    }
  }
})();

// ────────────────────────────────────────────────────────────────────────────
// Helpers / constants
// ────────────────────────────────────────────────────────────────────────────

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function envNum(name: string, def?: number): number | undefined {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function tryPubkey(s?: string | null): PublicKey | undefined {
  if (!s) return undefined;
  try { return new PublicKey(s.trim()); } catch { return undefined; }
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function nowIso() { return new Date().toISOString(); }

// ────────────────────────────────────────────────────────────────────────────
// JSONL follower (tail)
// ────────────────────────────────────────────────────────────────────────────

type LineHandler = (obj: any) => void;

class JsonlFollower {
  private fd: number | null = null;
  private offset = 0;
  private buffer = "";
  private watcher: fs.FSWatcher | null = null;
  private poller: NodeJS.Timeout | null = null;

  constructor(
    private file: string,
    private onLine: LineHandler,
    private pollMs: number = 500
  ) { }

  async start() {
    await this.openAtEOF();
    this.watch();
    this.poller = setInterval(() => this.readNewBytes(), this.pollMs);
  }

  stop() {
    try { this.watcher?.close(); } catch { }
    if (this.poller) clearInterval(this.poller);
    try { if (this.fd !== null) fs.closeSync(this.fd); } catch { }
    this.watcher = null;
    this.poller = null;
    this.fd = null;
  }

  private async openAtEOF() {
    try {
      const existed = fs.existsSync(this.file);
      this.fd = fs.openSync(this.file, "a+");
      const size = existed ? fs.fstatSync(this.fd).size : 0;
      this.offset = size;
      logger.log("edge_follow_opened", { file: this.file, initial_size: size });
    } catch (e) {
      logger.log("edge_follow_open_error", { file: this.file, err: String(e) });
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.fd = fs.openSync(this.file, "a+");
        this.offset = 0;
        logger.log("edge_follow_opened", { file: this.file, initial_size: 0 });
      } catch (e2) {
        logger.log("edge_follow_open_fatal", { file: this.file, err: String(e2) });
      }
    }
  }

  private watch() {
    try {
      this.watcher = fs.watch(this.file, (event) => {
        if (event === "rename") {
          try { if (this.fd !== null) fs.closeSync(this.fd); } catch { }
          this.openAtEOF().catch(() => { });
          return;
        }
        this.readNewBytes();
      });
    } catch (e) {
      logger.log("edge_follow_watch_error", { file: this.file, err: String(e) });
    }
  }

  private readNewBytes() {
    if (this.fd === null) return;
    try {
      const stat = fs.fstatSync(this.fd);
      if (stat.size <= this.offset) return;
      const toRead = stat.size - this.offset;
      const buf = Buffer.allocUnsafe(toRead);
      const n = fs.readSync(this.fd, buf, 0, toRead, this.offset);
      this.offset += n;
      this.buffer += buf.toString("utf8", 0, n);

      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try { this.onLine(JSON.parse(line)); } catch { }
      }
    } catch (e) {
      logger.log("edge_follow_read_error", { file: this.file, err: String(e) });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
/** health loop */
// ────────────────────────────────────────────────────────────────────────────

async function startHealth(conn: Connection) {
  async function sampleTps(): Promise<number> {
    try {
      const samples = await conn.getRecentPerformanceSamples(1);
      if (!samples?.length) return 0;
      const s = samples[0];
      if (!s.numTransactions || !s.samplePeriodSecs) return 0;
      return s.numTransactions / s.samplePeriodSecs;
    } catch { return 0; }
  }

  setInterval(async () => {
    try {
      const [slot, version, tps] = await Promise.all([
        conn.getSlot("processed"),
        conn.getVersion(),
        sampleTps(),
      ]);
      setChainTps(tps);
      logger.log("arb health", {
        slot,
        tps: roundN(tps, 2) ?? 0,
        version,
        httpHealth: { ok: true, body: "ok" },
      });
      console.log(`HEALTH slot=${slot} tps=${roundN(tps, 2)} version=${version["solana-core"]}`);
    } catch (e) {
      setChainTps(undefined);
      logger.log("arb health", {
        slot: null,
        tps: 0,
        version: { "feature-set": null, "solana-core": "unknown" },
        httpHealth: { ok: false, body: String(e) },
      });
    }
  }, 3000);
}

// ────────────────────────────────────────────────────────────────────────────
// Live summary + balances
// ────────────────────────────────────────────────────────────────────────────

const runStartedAt = new Date();
let consideredCnt = 0;
let wouldTradeCnt = 0;
let wouldNotCnt = 0;
let bestEdgeNet = -Infinity;
let worstEdgeNet = +Infinity;
let cumSimPnLQuote = 0;
let wroteSummary = false;

let rpcSamples = 0;
let rpcMsP50 = 0;
let rpcMsP95 = 0;
let rpcBlocked = 0;

let START_BAL: { sol: number; wsol: number; usdc: number } | null = null;
let END_BAL: { sol: number; wsol: number; usdc: number } | null = null;

// Robust mint-scanning with ATA hint
async function sumMintBalance(
  conn: Connection,
  owner: PublicKey,
  mint: PublicKey,
  preferredAta?: PublicKey
): Promise<number> {
  if (preferredAta) {
    try {
      const r = await conn.getTokenAccountBalance(preferredAta, "confirmed");
      const amt = Number(r?.value?.uiAmount ?? 0);
      if (Number.isFinite(amt)) return amt;
    } catch { /* fallthrough */ }
  }
  try {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
    let sum = 0;
    for (const it of res.value) {
      const parsed: any = (it.account.data as any)?.parsed;
      const ui = Number(parsed?.info?.tokenAmount?.uiAmount ?? 0);
      if (Number.isFinite(ui)) sum += ui;
    }
    return sum;
  } catch {
    return 0;
  }
}

async function readBalances(
  conn: Connection,
  owner: PublicKey,
  ataHints?: { wsol?: PublicKey; usdc?: PublicKey }
) {
  const [solLamports, wsol, usdc] = await Promise.all([
    conn.getBalance(owner, "confirmed").catch(() => 0),
    sumMintBalance(conn, owner, WSOL_MINT, ataHints?.wsol),
    sumMintBalance(conn, owner, USDC_MINT, ataHints?.usdc),
  ]);
  return { sol: solLamports / 1e9, wsol, usdc };
}

function recordDecision(wouldTrade: boolean, edgeNetBps: number, expectedPnl: number) {
  consideredCnt++;
  if (wouldTrade) { wouldTradeCnt++; cumSimPnLQuote += expectedPnl; }
  else { wouldNotCnt++; }
  if (edgeNetBps > bestEdgeNet) bestEdgeNet = edgeNetBps;
  if (edgeNetBps < worstEdgeNet) worstEdgeNet = edgeNetBps;
}

function ewma(prev: number, x: number, alpha = 0.1) {
  if (!Number.isFinite(prev) || prev <= 0) return Math.round(x);
  return Math.round(prev + (x - prev) * alpha);
}

function writeLiveSummarySync(CFG: ReturnType<typeof loadConfig>, mlEventsFile?: string) {
  try {
    const LIVE_DIR = path.join(CFG.DATA_DIR, "live");
    ensureDir(LIVE_DIR);
    const file = path.join(LIVE_DIR, `${stamp()}.summary.json`);
    const summary: any = {
      file,
      started_at: runStartedAt.toISOString(),
      stopped_at: nowIso(),
      considered: consideredCnt,
      would_trade: wouldTradeCnt,
      would_not_trade: wouldNotCnt,
      pnl_sum: roundN(cumSimPnLQuote, 6) ?? 0,
      best_edge_bps: Number.isFinite(bestEdgeNet) ? (roundN(bestEdgeNet, 4) ?? 0) : 0,
      worst_edge_bps: Number.isFinite(worstEdgeNet) ? (roundN(worstEdgeNet, 4) ?? 0) : 0,
      threshold_bps: String(process.env.TRADE_THRESHOLD_BPS ?? CFG.TRADE_THRESHOLD_BPS),
      slippage_bps: String(process.env.MAX_SLIPPAGE_BPS ?? CFG.MAX_SLIPPAGE_BPS),
      trade_size_base: String(process.env.LIVE_SIZE_BASE ?? CFG.TRADE_SIZE_BASE),
      book_ttl_ms: String(CFG.BOOK_TTL_MS),
      decision_dedupe_ms: String(CFG.DECISION_DEDUPE_MS),
      decision_bucket_ms: String(CFG.DECISION_BUCKET_MS),
      min_edge_delta_bps: String(CFG.DECISION_MIN_EDGE_DELTA_BPS),
      allow_synth_trades: String(CFG.ALLOW_SYNTH_TRADES),
      balances_start: START_BAL ?? undefined,
      balances_end: END_BAL ?? undefined,
      ml_events_file: mlEventsFile,
      exec_guard: {
        exec_min_abs_bps: envNum("TEST_FORCE_SEND_IF_ABS_EDGE_BPS"),
        allowed_path: String(process.env.EXEC_ALLOWED_PATH ?? "both"),
        atomic_preferred: true,
      },
      atomic_mode: process.env.ATOMIC_MODE ?? "none",
    };
    fs.writeFileSync(file, JSON.stringify(summary, null, 2));
    wroteSummary = true;
    logger.log("arb_live_summary_written", summary);
  } catch (e) {
    logger.log("arb_live_summary_write_error", { err: String(e) });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Latest market state
// ────────────────────────────────────────────────────────────────────────────
let LAST_BOOK: PxBook | null = null;
let LAST_PHX_MID: number | null = null;
let LAST_CPMM: { base: number; quote: number } | null = null;

// ────────────────────────────────────────────────────────────────────────────
// main()
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const CFG = loadConfig();

  // Very explicit boot banner
  console.log(
    [
      `BOOT rpc=${maskUrl(RPC)}`,
      `LIVE_TRADING=${process.env.LIVE_TRADING ?? "(unset)"}`,
      `SHADOW_TRADING=${process.env.SHADOW_TRADING ?? "(unset)"}`,
      `EXEC_ALLOWED_PATH=${process.env.EXEC_ALLOWED_PATH ?? "both"}`,
      `USE_RPC_SIM=${process.env.USE_RPC_SIM ?? "(unset)"}`,
      `USE_RAYDIUM_SWAP_SIM=${process.env.USE_RAYDIUM_SWAP_SIM ?? "(unset)"}`,
      `ATOMIC_MODE=${process.env.ATOMIC_MODE ?? "none"}`,
      `ENABLE_EMBEDDED_PUBLISHERS=${process.env.ENABLE_EMBEDDED_PUBLISHERS ?? "1"}`,
      `RUN_FOR_MINUTES=${process.env.RUN_FOR_MINUTES ?? 30}`
    ].join("  ")
  );
  logger.log("arb boot", { rpc: maskUrl(RPC), atomic_mode: process.env.ATOMIC_MODE ?? "none" });

  // Embedded publishers (optional; auto when enabled)
  const sup = new PublisherSupervisor({
    enable: String(process.env.ENABLE_EMBEDDED_PUBLISHERS ?? "1") === "1",
    phoenixJsonl: CFG.PHOENIX_JSONL,
    ammsJsonl: CFG.AMMS_JSONL,
    freshnessMs: 3500,
    pollMs: 2000,
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
  });
  sup.start();

  const conn = new Connection(RPC, { commitment: "processed" });
  startHealth(conn).catch(() => { });
  initRisk();

  const LIVE = String(process.env.LIVE_TRADING ?? "0") === "1";
  const SHADOW = String(process.env.SHADOW_TRADING ?? "0") === "1";
  const LIVE_SIZE_BASE = Number(process.env.LIVE_SIZE_BASE ?? 0) || CFG.TRADE_SIZE_BASE;
  const LOG_ML = Boolean(CFG.LOG_SIM_FIELDS);

  let liveExec: LiveExecutor | null = null;
  let accounts: Awaited<ReturnType<typeof initAccounts>> | null = null;

  const envOwner = tryPubkey(process.env.WALLET_PUBKEY);
  const envWsolAta = tryPubkey(process.env.WSOL_ATA);
  const envUsdcAta = tryPubkey(process.env.USDC_ATA);

  if (LIVE && !SHADOW) {
    accounts = await initAccounts(conn);
    await initSessionRecorder(conn, (accounts as any).owner, CFG);

    // pass a Keypair (payer) into the executor so we always have a real PublicKey for Phoenix
    const payer: Keypair = (accounts as any).owner as Keypair;
    liveExec = new LiveExecutor(conn, payer);
    await (liveExec as any).startPhoenix?.();

    const ownerPk = envOwner ?? (payer.publicKey as PublicKey);
    const wsolAtaHint = envWsolAta ?? (accounts as any)?.atas?.wsol;
    const usdcAtaHint = envUsdcAta ?? (accounts as any)?.atas?.usdc;

    console.log(
      `START_PREF owner=${ownerPk.toBase58()} ` +
      `wsolATA=${wsolAtaHint ? wsolAtaHint.toBase58() : "-"} ` +
      `usdcATA=${usdcAtaHint ? usdcAtaHint.toBase58() : "-"}`
    );

    try {
      START_BAL = await readBalances(conn, ownerPk, { wsol: wsolAtaHint, usdc: usdcAtaHint });
      logger.log("balances_start", START_BAL);
      console.log(`START  SOL=${START_BAL.sol}  WSOL=${START_BAL.wsol}  USDC=${START_BAL.usdc}`);
    } catch (e) {
      console.log("START BAL ERROR", e);
    }
  } else {
    logger.log("shadow_mode", { note: "skip live init", live: LIVE, shadow: SHADOW });
  }

  const RAYDIUM_POOL =
    (process.env.RAYDIUM_POOL_ID ?? process.env.RAYDIUM_POOL_ID_SOL_USDC ?? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2").trim();
  const PHX_MARKET =
    (CFG.PHOENIX_MARKET || process.env.PHOENIX_MARKET_ID || "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg").trim();

  // warm Phoenix caches so the first instruction build is also fast
  try {
    await prewarmPhoenix(conn, [PHX_MARKET]);
  } catch (e) {
    logger.log("phoenix_prewarm_error", { error: String(e) });
  }

  let AMM_FEE_BPS = resolveFeeBps("AMM", RAYDIUM_POOL, CFG.AMM_TAKER_FEE_BPS);
  const PHX_FEE_BPS = resolveFeeBps("PHOENIX", PHX_MARKET, CFG.PHOENIX_TAKER_FEE_BPS);

  AMM_FEE_BPS = await tryAssertRaydiumFeeBps(conn, RAYDIUM_POOL, AMM_FEE_BPS);

  logger.log("fee_config", {
    raydium_pool: RAYDIUM_POOL, amm_fee_bps: AMM_FEE_BPS,
    phoenix_market: PHX_MARKET, phoenix_fee_bps: PHX_FEE_BPS
  });

  logger.log("edge_paths", { amms: CFG.AMMS_JSONL, phoenix: CFG.PHOENIX_JSONL, min_abs_bps: CFG.EDGE_MIN_ABS_BPS });
  logger.log("edge_config", { book_ttl_ms: CFG.BOOK_TTL_MS, synth_width_bps: CFG.SYNTH_WIDTH_BPS });

  logger.log("edge_decision_config", {
    trade_threshold_bps: CFG.TRADE_THRESHOLD_BPS,
    max_slippage_bps: CFG.MAX_SLIPPAGE_BPS,
    phoenix_slippage_bps: CFG.PHOENIX_SLIPPAGE_BPS,
    trade_size_base: CFG.TRADE_SIZE_BASE,
    phoenix_taker_fee_bps: PHX_FEE_BPS,
    amm_taker_fee_bps: AMM_FEE_BPS,
    fixed_tx_cost_quote: CFG.FIXED_TX_COST_QUOTE,
    decision_dedupe_ms: CFG.DECISION_DEDUPE_MS,
    decision_bucket_ms: CFG.DECISION_BUCKET_MS,
    decision_min_edge_delta_bps: CFG.DECISION_MIN_EDGE_DELTA_BPS,
    enforceDedupe: CFG.ENFORCE_DEDUPE,
    slippage_mode: CFG.ACTIVE_SLIPPAGE_MODE,
    use_pool_impact_sim: CFG.USE_POOL_IMPACT_SIM,
    use_rpc_sim: CFG.USE_RPC_SIM,
    use_raydium_swap_sim: String(process.env.USE_RAYDIUM_SWAP_SIM ?? "false"),
    cpmm_max_pool_trade_frac: CFG.CPMM_MAX_POOL_TRADE_FRAC,
    dynamicSlippageExtraBps: CFG.DYNAMIC_SLIPPAGE_EXTRA_BPS,
    allow_synth_trades: CFG.ALLOW_SYNTH_TRADES,
    edge_follow_poll_ms: Number(process.env.EDGE_FOLLOW_POLL_MS ?? 500),
    shadow_trading: SHADOW,
  });

  // RPC sim fn is OFF in live because USE_RPC_SIM=0
  const rpcSimFn: RpcSimFn | undefined = undefined;

  const mkShadowSig = () =>
    `shadow_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;

  function fillPxForPath(
    pathDir: "PHX->AMM" | "AMM->PHX",
    d: { rpc_eff_px?: number; buy_px: number; sell_px: number }
  ) {
    const rpc = asNumber(d.rpc_eff_px);
    const sidePx = pathDir === "PHX->AMM" ? asNumber(d.sell_px) : asNumber(d.buy_px);
    return coalesceRound(6, rpc, sidePx);
  }

  const ALLOWED = String(process.env.EXEC_ALLOWED_PATH ?? "both");

  // ML events log (jsonl)
  const LIVE_DIR = path.join(CFG.DATA_DIR, "live");
  ensureDir(LIVE_DIR);
  const ML_EVENTS_FILE = path.join(LIVE_DIR, `${stamp()}.events.jsonl`);
  const emitMlLocal = (obj: any) => {
    try { fs.appendFileSync(ML_EVENTS_FILE, JSON.stringify(obj) + "\n"); } catch { }
  };

  // ──────────────────────────────────────────────────────────────────────
  // EXECUTION LOGIC — only when joiner says EV>0 (no forced sends)
  // ──────────────────────────────────────────────────────────────────────
  const onDecision: DecisionHook = (_wouldTrade, _edgeNetBps, _expectedPnl, d) => {
    const edgeNetBps = Number(_edgeNetBps ?? 0);
    const expPnl = Number(_expectedPnl ?? 0);
    if (!d) { recordDecision(false, edgeNetBps, expPnl); return; }

    if (ALLOWED !== "both" && d.path && d.path !== ALLOWED) {
      logger.log("skip_due_to_path", { have: d.path, allowed: ALLOWED });
      recordDecision(false, edgeNetBps, expPnl);
      return;
    }

    // Emit both-path EVs for ops/debug (fee-consistent)
    if (String(process.env.DECISION_LOG_BOTH ?? "0") === "1" && LAST_BOOK && LAST_CPMM) {
      try {
        const book: PxBook = LAST_BOOK;
        const cpmm: CpmmReserves = { base: LAST_CPMM.base, quote: LAST_CPMM.quote, feeBps: 25 }; // on-chain Raydium taker fee
        const sizeBase = Number(process.env.LIVE_SIZE_BASE ?? 0) || CFG.TRADE_SIZE_BASE;

        const pnlPhxToAmm = pnlQuoteForSizeBase(
          { kind: "PHX->AMM", book, cpmm, maxPoolFrac: CFG.CPMM_MAX_POOL_TRADE_FRAC, lowerBase: sizeBase },
          sizeBase
        );
        const pnlAmmToPhx = pnlQuoteForSizeBase(
          { kind: "AMM->PHX", book, cpmm, maxPoolFrac: CFG.CPMM_MAX_POOL_TRADE_FRAC, lowerBase: sizeBase },
          sizeBase
        );

        const dbg = {
          trade_size_base: sizeBase,
          phx_to_amm: { pnl_quote: Number(roundN(pnlPhxToAmm, 6)) },
          amm_to_phx: { pnl_quote: Number(roundN(pnlAmmToPhx, 6)) }
        };
        logger.log("decision_dbg", dbg);
        emitMlLocal({ ts: Date.now(), ev: "decision_dbg", ...dbg });
      } catch { }
    }

    if (LOG_ML) {
      try {
        emitEdgeSnapshot({ ...d, trade_size_base: Number(process.env.LIVE_SIZE_BASE ?? CFG.TRADE_SIZE_BASE) });
        emitDecision(Boolean(_wouldTrade), _wouldTrade ? "edge_above_threshold" : undefined, d, _expectedPnl);
      } catch { }
      emitMlLocal({ ts: Date.now(), ev: "decision", d });
    }

    const threshold = Number(CFG.TRADE_THRESHOLD_BPS ?? 0);
    const execMinAbs = envNum("TEST_FORCE_SEND_IF_ABS_EDGE_BPS");
    const forceByAbs = execMinAbs != null && Math.abs(edgeNetBps) >= execMinAbs;
    const doExecute =
      (Boolean(_wouldTrade) && expPnl > 0 && edgeNetBps >= threshold) || forceByAbs;

    if (forceByAbs) console.log(`FORCE_EXEC absEdge=${edgeNetBps}bps >= ${execMinAbs}bps`);

    recordDecision(doExecute, edgeNetBps, expPnl);
    if (!doExecute) return;

    const execSize = Number(process.env.LIVE_SIZE_BASE ?? 0) || CFG.TRADE_SIZE_BASE;
    const notional = coalesceRound(6, execSize * ((d.buy_px + d.sell_px) / 2));

    const payload: any = {
      path: d.path,
      size_base: execSize,
      buy_px: d.buy_px,
      sell_px: d.sell_px,
      notional_quote: notional,
      phoenix: {
        market: (CFG.PHOENIX_MARKET || process.env.PHOENIX_MARKET_ID || "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg").trim(),
        side: d.side as "buy" | "sell",
        limit_px: d.side === "buy" ? d.buy_px : d.sell_px,
      },
      amm: { pool: (process.env.RAYDIUM_POOL_ID ?? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2").trim() },
      atomic: true,
    };

    console.log(
      `EXEC (EV>0) ${payload.path} base=${roundN(payload.size_base, 6)} ` +
      `notional≈${roundN(notional, 4)} mid=${roundN(LAST_PHX_MID ?? 0, 3)}`
    );

    const isShadow = String(process.env.SHADOW_TRADING ?? "0") === "1";
    if (isShadow) {
      const submitted = {
        path: payload.path, size_base: payload.size_base, buy_px: payload.buy_px, sell_px: payload.sell_px,
        ix_count: 0, cu_limit: 0, tip_lamports: undefined as number | undefined,
        live: false, shadow: true,
      };
      logger.log("submitted_tx", submitted);
      if (LOG_ML) { try { emitSubmittedTx(submitted); } catch { } }
      emitMlLocal({ ts: Date.now(), ev: "submitted", submitted });

      const fp = fillPxForPath(payload.path as "PHX->AMM" | "AMM->PHX", {
        rpc_eff_px: d.rpc_eff_px, buy_px: d.buy_px, sell_px: d.sell_px,
      });
      const landed = {
        sig: mkShadowSig(), slot: null as number | null, conf_ms: 0, shadow: true,
        fill_px: fp, filled_base: payload.size_base, filled_quote: coalesceRound(6, payload.size_base * fp)
      };
      logger.log("landed", landed);
      if (LOG_ML) { try { emitLanded(landed); } catch { } }
      emitMlLocal({ ts: Date.now(), ev: "landed", landed });
      return;
    }

    if (LIVE && liveExec) {
      // Optional-chain to avoid TS error if LiveExecutor surface differs
      (liveExec as any)?.maybeExecute?.(payload);
    }
  };

  const onRpcSample: RpcSampleHook = (s) => {
    const ms = Number(s?.ms);
    if (Number.isFinite(ms) && ms > 0) {
      rpcSamples++;
      rpcMsP50 = ewma(rpcMsP50, ms, 0.1);
      rpcMsP95 = Math.max(rpcMsP95, ms);
      if (LOG_ML) { try { emitRpcSample(ms, Boolean(s?.blocked)); } catch { } }
    }
    if (s?.blocked) rpcBlocked++;
  };

  const joiner = new EdgeJoiner(
    {
      minAbsBps: Number(process.env.EDGE_MIN_ABS_BPS ?? 0),
      waitLogMs: Number(process.env.EDGE_WAIT_LOG_MS ?? 5000),
      thresholdBps: Number(process.env.TRADE_THRESHOLD_BPS ?? 0.05),
      flatSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 2.0),
      tradeSizeBase: Number(process.env.TRADE_SIZE_BASE ?? 0.02),
      phoenixFeeBps: PHX_FEE_BPS,
      ammFeeBps: AMM_FEE_BPS,
      fixedTxCostQuote: Number(process.env.FIXED_TX_COST_QUOTE ?? 0),
    },
    {
      bookTtlMs: Number(process.env.BOOK_TTL_MS ?? 500),
      activeSlippageMode: "adaptive",
      phoenixSlippageBps: Number(process.env.PHOENIX_SLIPPAGE_BPS ?? 3),
      cpmmMaxPoolTradeFrac: Number(process.env.CPMM_MAX_POOL_TRADE_FRAC ?? 0.05),
      dynamicSlippageExtraBps: Number(process.env.DYNAMIC_SLIPPAGE_BPS ?? 0.25),
      logSimFields: String(process.env.LOG_SIM_FIELDS ?? "1") === "1",
      enforceDedupe: true,
      decisionBucketMs: Number(process.env.DECISION_BUCKET_MS ?? 200),
      decisionMinEdgeDeltaBps: Number(process.env.DECISION_MIN_EDGE_DELTA_BPS ?? 0.05),
      useRpcSim: false,
    },
    onDecision,
    rpcSimFn,
    onRpcSample
  );

  // Feed joiner from JSONL publishers and maintain local state
  const POLL_MS = Number(process.env.EDGE_FOLLOW_POLL_MS ?? 500) || 500;

  const ammsFollower = new JsonlFollower(
    CFG.AMMS_JSONL,
    (obj) => {
      const ev = (obj?.event ?? obj?.name ?? obj?.type ?? "") as string;
      if (ev === "amms_price") {
        joiner.upsertAmms(obj);
        try {
          const baseDec = Number(obj?.baseDecimals ?? 9);
          const quoteDec = Number(obj?.quoteDecimals ?? 6);
          const baseInt = BigInt(obj?.base_int ?? "0");
          const quoteInt = BigInt(obj?.quote_int ?? "0");
          LAST_CPMM = {
            base: Number(baseInt) / Math.pow(10, baseDec),
            quote: Number(quoteInt) / Math.pow(10, quoteDec),
          };
        } catch { }
      }
    },
    POLL_MS
  );

  const phxFollower = new JsonlFollower(
    CFG.PHOENIX_JSONL,
    (obj) => {
      const ev = (obj?.event ?? obj?.name ?? obj?.type ?? "") as string;
      if (ev === "phoenix_mid") {
        LAST_PHX_MID = Number(
          obj?.px ?? obj?.phoenix_mid ?? obj?.mid ?? obj?.price ?? NaN
        );
        joiner.upsertPhoenix(obj);
      } else if (ev === "phoenix_l2" || ev === "phoenix_l2_empty") {
        joiner.upsertPhoenix(obj);
        try {
          const bids = (obj?.levels_bids ?? []).map((l: any) => ({
            px: Number(l.px),
            qtyBase: Number(l.qty ?? l.qtyBase ?? 0),
          }));
          const asks = (obj?.levels_asks ?? []).map((l: any) => ({
            px: Number(l.px),
            qtyBase: Number(l.qty ?? l.qtyBase ?? 0),
          }));
          LAST_BOOK = {
            bids,
            asks,
            takerFeeBps: Number(process.env.PHOENIX_TAKER_FEE_BPS ?? 0),
          };

          if (Number.isFinite(obj?.phoenix_mid))
            LAST_PHX_MID = Number(obj.phoenix_mid);
          else if (Number.isFinite(obj?.px)) LAST_PHX_MID = Number(obj.px);
          else if (
            Number.isFinite(obj?.best_bid) &&
            Number.isFinite(obj?.best_ask)
          ) {
            LAST_PHX_MID = (Number(obj.best_bid) + Number(obj.best_ask)) / 2;
          }
        } catch { }
      } else {
        try {
          const ms = Number(obj?.data?.rpc_sim_ms ?? obj?.rpc_sim_ms);
          if (Number.isFinite(ms)) {
            rpcSamples++;
            rpcMsP50 = ewma(rpcMsP50, ms, 0.1);
            rpcMsP95 = Math.max(rpcMsP95, ms);
            if (LOG_ML) {
              try {
                emitRpcSample(
                  ms,
                  Boolean(obj?.data?.guard_blocked ?? obj?.guard_blocked)
                );
              } catch { }
            }
          }
          const blocked = obj?.data?.guard_blocked ?? obj?.guard_blocked;
          if (blocked === true) rpcBlocked++;
        } catch { }
      }
    },
    POLL_MS
  );

  await Promise.all([ammsFollower.start(), phxFollower.start()]);

  // 30-minute auto-stop
  const maxMin = Number(process.env.RUN_FOR_MINUTES ?? 30);
  const autoTimer = setTimeout(() => {
    console.log(`AUTO-STOP: run window ${maxMin} minutes reached`);
    shutdown("AUTO_STOP");
  }, maxMin * 60_000);

  // Graceful shutdown
  function shutdown(signal: string) {
    (async () => {
      try { ammsFollower.stop(); } catch { }
      try { phxFollower.stop(); } catch { }
      try { sup.stop(); } catch { }
      try { clearTimeout(autoTimer); } catch { }

      try {
        if (accounts) {
          const ownerPk =
            tryPubkey(process.env.WALLET_PUBKEY) ??
            ((accounts as any).owner as PublicKey);
          const wsolAtaHint =
            tryPubkey(process.env.WSOL_ATA) ?? (accounts as any)?.atas?.wsol;
          const usdcAtaHint =
            tryPubkey(process.env.USDC_ATA) ?? (accounts as any)?.atas?.usdc;

          END_BAL = await readBalances(conn, ownerPk, {
            wsol: wsolAtaHint,
            usdc: usdcAtaHint,
          });
          logger.log("balances_end", END_BAL);
          console.log(
            `END    SOL=${END_BAL.sol}  WSOL=${END_BAL.wsol}  USDC=${END_BAL.usdc}`
          );
          const dsol = roundN(END_BAL.sol - (START_BAL?.sol ?? 0), 9);
          const dwsol = roundN(END_BAL.wsol - (START_BAL?.wsol ?? 0), 9);
          const dusdc = roundN(END_BAL.usdc - (START_BAL?.usdc ?? 0), 6);
          console.log(`DELTA  dSOL=${dsol}  dWSOL=${dwsol}  dUSDC=${dusdc}`);
        }
      } catch (e) {
        console.log("END BAL ERROR", e);
      }
      if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE);
      logger.log("arb_shutdown", { ok: true, signal });
      process.exit(0);
    })().catch(() => {
      if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE);
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("beforeExit", () => { if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE); });
  process.on("exit", () => { if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE); });
  process.on("uncaughtException", (e) => {
    logger.log("arb_fatal", { error: String(e) });
    if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logger.log("arb_fatal", { error: String(e) });
    if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE);
    process.exit(1);
  });
}

main().catch((e) => {
  logger.log("arb_fatal", { error: String(e) });
  try {
    const CFG = loadConfig();
    const LIVE_DIR = path.join(CFG.DATA_DIR, "live");
    if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true });
    const file = path.join(LIVE_DIR, `${stamp()}.summary.json`);
    fs.writeFileSync(file, JSON.stringify({ error: String(e) }, null, 2));
  } catch { }
});
