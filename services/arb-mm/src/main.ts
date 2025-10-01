// services/arb-mm/src/main.ts
// Live arbitrage runner (Raydium/Orca <-> Phoenix) with dynamic size advisory, RPC-sim awareness, and config-driven venues.
//
// This baseline:
// - Loads ONLY `.env.live` (no .env fallbacks) before anything else.
// - Forces live trading: LIVE_TRADING=1, SHADOW_TRADING=0.
// - Uses d.recommended_size_base from joiner (when present) as the execution size.
// - Passes actual AMM fee into joiner so EV includes taker fees exactly once.
// - Executor handles tx-level RPC simulation + send-gate; joiner can run without sim.
// - **NO AUTO-STOP**: runs indefinitely until SIGINT/SIGTERM. There is no "run for N minutes" logic.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import { PublicKey, Keypair } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { logger } from "@mev/storage";

import {
  EdgeJoiner,
  type DecisionHook,
  type RpcSampleHook,
  type RpcSimFn,
} from "./edge/joiner.js";
import { setChainTps } from "./feature_sink.js";
import { initRisk } from "./risk.js";
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
import { prewarmPhoenix } from "./util/phoenix.js"; // warm Phoenix cache on boot
import { MarketStateProvider } from "./market/index.js";
import { loadPairsFromEnvOrDefault } from "./registry/pairs.js";
import { rpcClient, rpc } from "@mev/rpc-facade";
import { setRpcLatencies } from "./runtime/metrics.js";
import { startWsMarkets } from "./provider/ws_markets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────────────────────────
// Load ONLY .env.live and force LIVE mode
// ────────────────────────────────────────────────────────────────────────────
(function loadExactEnvLive() {
  // Prefer repo root .env.live; fallback to service-level .env.live
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const repoEnvLive = path.resolve(repoRoot, ".env.live");
  const svcEnvLive = path.resolve(__dirname, "..", "..", ".env.live");
  const chosen = fs.existsSync(repoEnvLive) ? repoEnvLive : svcEnvLive;
  if (!fs.existsSync(chosen)) {
    console.error("[env] .env.live not found; expected at", repoEnvLive, "or", svcEnvLive);
  } else {
    dotenv.config({ path: chosen, override: true });
  }
  // Force live-only mode regardless of previous state
  process.env.LIVE_TRADING = "1";
  process.env.SHADOW_TRADING = "0";

  // Prevent config.ts from re-loading any env files (including .env)
  process.env.__ENV_LIVE_LOCKED = "1";
})();

// ────────────────────────────────────────────────────────────────────────────
/** helpers / constants */
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
function stampLocal() {
  return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}

function resolveLiveDir(baseDataDir: string): string {
  const override = process.env.ARB_LIVE_DIR?.trim();
  if (override && override.length) {
    const resolved = path.isAbsolute(override) ? override : path.resolve(override);
    ensureDir(resolved);
    return resolved;
  }
  const fallback = path.join(baseDataDir, "live");
  ensureDir(fallback);
  return fallback;
}

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
    this.watcher = null; this.poller = null; this.fd = null;
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
    } catch {
      return 0;
    }
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
      console.log(
        `HEALTH slot=${slot} tps=${roundN(tps, 2)} version=${String((version as any)["solana-core"] ?? "unknown")}`
      );
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
let bestEdgeNet: number | null = null;
let worstEdgeNet: number | null = null;
let bestPnlQuote: number | null = null;
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
    } catch {
      /* fallthrough */
    }
  }
  try {
    const res = await conn.getParsedTokenAccountsByOwner(
      owner,
      { mint },
      "confirmed"
    );
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

function recordDecision(
  wouldTrade: boolean,
  edgeNetBps: number,
  expectedPnl: number
) {
  consideredCnt++;
  if (wouldTrade) {
    wouldTradeCnt++;
    cumSimPnLQuote += expectedPnl;
    if (Number.isFinite(expectedPnl)) {
      bestPnlQuote = bestPnlQuote == null ? expectedPnl : Math.max(bestPnlQuote, expectedPnl);
    }
  } else {
    wouldNotCnt++;
  }
  if (Number.isFinite(edgeNetBps)) {
    bestEdgeNet = bestEdgeNet == null ? edgeNetBps : Math.max(bestEdgeNet, edgeNetBps);
    worstEdgeNet = worstEdgeNet == null ? edgeNetBps : Math.min(worstEdgeNet, edgeNetBps);
  }
}

function ewma(prev: number, x: number, alpha = 0.1) {
  if (!Number.isFinite(prev) || prev <= 0) return Math.round(x);
  return Math.round(prev + (x - prev) * alpha);
}

function writeLiveSummarySync(CFG: any, mlEventsFile?: string) {
  try {
    const LIVE_DIR = resolveLiveDir(CFG.DATA_DIR);
    const file = path.join(LIVE_DIR, `arb-summary-${stampLocal()}.json`);
    const summary: any = {
      file,
      started_at: runStartedAt.toISOString(),
      stopped_at: nowIso(),
      considered: consideredCnt,
      would_trade: wouldTradeCnt,
      would_not_trade: wouldNotCnt,
      pnl_sum: roundN(cumSimPnLQuote, 6) ?? 0,
      best_edge_bps: bestEdgeNet != null ? roundN(bestEdgeNet, 4) ?? 0 : null,
      worst_edge_bps: worstEdgeNet != null ? roundN(worstEdgeNet, 4) ?? 0 : null,
      best_pnl_quote: bestPnlQuote != null ? roundN(bestPnlQuote, 6) ?? 0 : null,
      threshold_bps: String(
        process.env.TRADE_THRESHOLD_BPS ?? CFG.TRADE_THRESHOLD_BPS
      ),
      slippage_bps: String(
        process.env.MAX_SLIPPAGE_BPS ?? CFG.MAX_SLIPPAGE_BPS
      ),
      trade_size_base: String(
        process.env.LIVE_SIZE_BASE ?? CFG.TRADE_SIZE_BASE
      ),
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
  // Load config AFTER locking env (dynamic import ensures ordering)
  const { loadConfig, RPC, maskUrl, resolveFeeBps } = await import("./config.js");
  const CFG = loadConfig();

  // Explicit boot banner (live-only)
  console.log(
    [
      `BOOT rpc=${maskUrl(RPC)}`,
      `LIVE_TRADING=1`,
      `SHADOW_TRADING=0`,
      `EXEC_ALLOWED_PATH=${process.env.EXEC_ALLOWED_PATH ?? "both"}`,
      `USE_RPC_SIM=${process.env.USE_RPC_SIM ?? "(unset)"}`,
      `USE_RAYDIUM_SWAP_SIM=${process.env.USE_RAYDIUM_SWAP_SIM ?? "(unset)"}`,
      `ATOMIC_MODE=${process.env.ATOMIC_MODE ?? "none"}`,
      `ENABLE_EMBEDDED_PUBLISHERS=${process.env.ENABLE_EMBEDDED_PUBLISHERS ?? "1"}`,
    ].join("  ")
  );
  logger.log("arb boot", {
    rpc: maskUrl(RPC),
    atomic_mode: process.env.ATOMIC_MODE ?? "none",
    live_forced: true,
    env_live_locked: true,
  });

  // Embedded publishers (optional; auto when enabled)
  const providerEnabled = String(process.env.ENABLE_MARKET_PROVIDER ?? "0") === "1";
  const enableEmbedded = !providerEnabled && String(process.env.ENABLE_EMBEDDED_PUBLISHERS ?? "1") === "1";

  const sup = new PublisherSupervisor({
    enable: enableEmbedded,
    phoenixJsonl: CFG.PHOENIX_JSONL,
    ammsJsonl: CFG.AMMS_JSONL,
    freshnessMs: 3500,
    pollMs: 2000,
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
  });
  sup.start();

  // Attach WS endpoint (Phoenix publisher will poll if SDK lacks subs)
  const conn = rpcClient;

  const ENABLE_MARKET_PROVIDER = String(process.env.ENABLE_MARKET_PROVIDER ?? "0").trim() === "1";
  let marketProvider: MarketStateProvider | null = null;
  if (ENABLE_MARKET_PROVIDER) {
    try {
      marketProvider = new MarketStateProvider(conn, loadPairsFromEnvOrDefault());
      await marketProvider.start();
      logger.log("market_provider_started", {
        pools: marketProvider.getTrackedPools().length,
        markets: marketProvider.getPhoenixMarkets().length,
        refresh_ms: Number(process.env.MARKET_PROVIDER_REFRESH_MS ?? 900),
      });
    } catch (err) {
      logger.log("market_provider_start_error", { err: String((err as any)?.message ?? err) });
      marketProvider = null;
    }
  }

  const warmupKeys = new Set<string>();
  const tryPush = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed) warmupKeys.add(trimmed);
  };
  tryPush(process.env.PHOENIX_MARKET);
  tryPush(process.env.PHOENIX_MARKET_ID);
  if (String(process.env.ENABLE_RAYDIUM_CLMM ?? "1").trim() !== "0") {
    tryPush(process.env.RAYDIUM_POOL_ID);
    tryPush(process.env.RAYDIUM_POOL_ID_SOL_USDC);
  }
  tryPush(process.env.ORCA_POOL_ID);
  tryPush(process.env.RAYDIUM_CLMM_POOL_ID);

  const warmupPubkeys: PublicKey[] = [];
  for (const key of warmupKeys) {
    try {
      warmupPubkeys.push(new PublicKey(key));
    } catch (err) {
      logger.log("rpc_warmup_skip", { key, err: String((err as any)?.message ?? err) });
    }
  }
  if (warmupPubkeys.length) {
    try {
      await rpc.warmupAccounts(warmupPubkeys, "processed");
      logger.log("rpc_warmup_complete", { count: warmupPubkeys.length });
    } catch (err) {
      logger.log("rpc_warmup_error", { count: warmupPubkeys.length, err: String((err as any)?.message ?? err) });
    }
  }

  startHealth(conn).catch(() => { });
  initRisk();

  // Live-only (forced above)
  const LIVE = true;
  const SHADOW = false;
  const LIVE_SIZE_BASE = Number(process.env.LIVE_SIZE_BASE ?? 0) || CFG.TRADE_SIZE_BASE;
  const LOG_ML = Boolean(CFG.LOG_SIM_FIELDS);

  let liveExec: LiveExecutor | null = null;
  let accounts: Awaited<ReturnType<typeof initAccounts>> | null = null;

  const envOwner = tryPubkey(process.env.WALLET_PUBKEY);
  const envWsolAta = tryPubkey(process.env.WSOL_ATA);
  const envUsdcAta = tryPubkey(process.env.USDC_ATA);

  if (LIVE) {
    accounts = await initAccounts(conn);
    await initSessionRecorder(conn, (accounts as any).owner, CFG);

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
  }

  const RAYDIUM_POOL =
    (process.env.RAYDIUM_POOL_ID ?? process.env.RAYDIUM_POOL_ID_SOL_USDC ?? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2").trim();
  const PHX_MARKET =
    (CFG.PHOENIX_MARKET || process.env.PHOENIX_MARKET_ID || "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg").trim();

  // warm Phoenix caches so the first instruction build is also fast
  try { await prewarmPhoenix(conn, [PHX_MARKET]); } catch (e) { logger.log("phoenix_prewarm_error", { error: String(e) }); }

  let AMM_FEE_BPS = resolveFeeBps("AMM", RAYDIUM_POOL, CFG.AMM_TAKER_FEE_BPS);
  const PHX_FEE_BPS = resolveFeeBps("PHOENIX", PHX_MARKET, CFG.PHOENIX_TAKER_FEE_BPS);

  AMM_FEE_BPS = await tryAssertRaydiumFeeBps(conn, RAYDIUM_POOL, AMM_FEE_BPS);

  logger.log("fee_config", {
    raydium_pool: RAYDIUM_POOL,
    amm_fee_bps: AMM_FEE_BPS,
    phoenix_market: PHX_MARKET,
    phoenix_fee_bps: PHX_FEE_BPS,
  });

  logger.log("edge_paths", { amms: CFG.AMMS_JSONL, phoenix: CFG.PHOENIX_JSONL, min_abs_bps: CFG.EDGE_MIN_ABS_BPS });
  logger.log("edge_config", { book_ttl_ms: CFG.BOOK_TTL_MS, synth_width_bps: CFG.SYNTH_WIDTH_BPS });

  // Log the exact inputs used by EV (note: AMM fee now the actual fee)
  logger.log("edge_decision_config", {
    trade_threshold_bps: CFG.TRADE_THRESHOLD_BPS,
    max_slippage_bps: CFG.MAX_SLIPPAGE_BPS,
    phoenix_slippage_bps: CFG.PHOENIX_SLIPPAGE_BPS,
    trade_size_base: CFG.TRADE_SIZE_BASE,
    decision_min_base: CFG.DECISION_MIN_BASE, // ensure visible in logs
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

  // Joiner does not need tx-level rpcSim: executor handles full TX sim + gate.
  // Keep undefined here to avoid mismatched signatures.
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
  const LIVE_DIR = resolveLiveDir(CFG.DATA_DIR);
  const ML_EVENTS_OVERRIDE = process.env.ML_EVENTS_FILE?.trim();
  const ML_EVENTS_FILE = ML_EVENTS_OVERRIDE && ML_EVENTS_OVERRIDE.length
    ? (path.isAbsolute(ML_EVENTS_OVERRIDE) ? ML_EVENTS_OVERRIDE : path.resolve(ML_EVENTS_OVERRIDE))
    : path.join(LIVE_DIR, `${stampLocal()}.events.jsonl`);
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

    // Optional EV debug on both paths at static size
    if (String(process.env.DECISION_LOG_BOTH ?? "0") === "1" && LAST_BOOK && LAST_CPMM) {
      try {
        const book: PxBook = LAST_BOOK;
        const cpmm: CpmmReserves = { base: LAST_CPMM.base, quote: LAST_CPMM.quote, feeBps: AMM_FEE_BPS };
        const sizeBaseDebug = Number(process.env.LIVE_SIZE_BASE ?? 0) || CFG.TRADE_SIZE_BASE;

        const pnlPhxToAmm = pnlQuoteForSizeBase(
          { kind: "PHX->AMM", book, cpmm, maxPoolFrac: CFG.CPMM_MAX_POOL_TRADE_FRAC, lowerBase: sizeBaseDebug },
          sizeBaseDebug
        );
        const pnlAmmToPhx = pnlQuoteForSizeBase(
          { kind: "AMM->PHX", book, cpmm, maxPoolFrac: CFG.CPMM_MAX_POOL_TRADE_FRAC, lowerBase: sizeBaseDebug },
          sizeBaseDebug
        );
        logger.log("decision_dbg", {
          trade_size_base: sizeBaseDebug,
          phx_to_amm: { pnl_quote: Number(roundN(pnlPhxToAmm, 6)) },
          amm_to_phx: { pnl_quote: Number(roundN(pnlAmmToPhx, 6)) }
        });
        emitMlLocal({ ts: Date.now(), ev: "decision_dbg", size: sizeBaseDebug, pnlA: pnlPhxToAmm, pnlB: pnlAmmToPhx });
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
    const doExecute = (Boolean(_wouldTrade) && expPnl > 0 && edgeNetBps >= threshold) || forceByAbs;

    if (forceByAbs) console.log(`FORCE_EXEC absEdge=${edgeNetBps}bps >= ${execMinAbs}bps`);

    recordDecision(doExecute, edgeNetBps, expPnl);
    if (!doExecute) return;

    // Prefer recommended_size_base from joiner; fallback to LIVE_SIZE_BASE
    const execSize =
      (d.recommended_size_base && d.recommended_size_base > 0
        ? d.recommended_size_base
        : (Number(process.env.LIVE_SIZE_BASE ?? 0) || CFG.TRADE_SIZE_BASE));

    const notional = coalesceRound(6, execSize * ((d.buy_px + d.sell_px) / 2));

    // 👇 Honor joiner’s venue/pool & optional EXEC_AMM_VENUE override
    const forcing = String(process.env.EXEC_AMM_VENUE ?? "").trim().toLowerCase();
    const venueFromJoiner = (d.amm_venue ?? "").toLowerCase();
    const ammVenue = (forcing === "raydium" || forcing === "orca")
      ? forcing
      : (venueFromJoiner === "raydium" || venueFromJoiner === "orca" ? venueFromJoiner : "raydium");

    // Pick poolId by venue: use from joiner when available (esp. for Orca), else env
    const rayPoolEnv = (process.env.RAYDIUM_POOL_ID ?? process.env.RAYDIUM_POOL_ID_SOL_USDC ?? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2").trim();
    const orcaPoolEnv = (process.env.ORCA_POOL_ID ?? "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ").trim();
    const poolIdForVenue = ammVenue === "raydium" ? rayPoolEnv : (d.amm_pool_id ?? orcaPoolEnv);

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
      amm_venue: ammVenue,               // 👈 carry venue choice
      amm_pool_id: poolIdForVenue,       // 👈 explicit pool id (executor checks this first)
      amm: { pool: poolIdForVenue },     // 👈 backward-compat payload
      amm_meta: (d as any).amm_meta,     // 👈 pass-through meta if joiner provided it
      atomic: true,
    };

    console.log(
      `EXEC (EV>0) ${payload.path} base=${roundN(payload.size_base, 6)} ` +
      `notional≈${roundN(notional, 4)} mid=${roundN(LAST_PHX_MID ?? 0, 3)} venue=${ammVenue}`
    );

    // Live-only execution
    if (LIVE && liveExec) (liveExec as any)?.maybeExecute?.(payload);
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
    // NEW: export smoothed latencies to the fee logic
    setRpcLatencies(rpcMsP50, rpcMsP95);
  };

  // ──────────────────────────────────────────────────────────────────────
  // Joiner (include actual AMM fee for EV; tx-level sim handled by executor)
  // ──────────────────────────────────────────────────────────────────────
  const joiner = new EdgeJoiner(
    {
      minAbsBps: CFG.EDGE_MIN_ABS_BPS,
      waitLogMs: CFG.EDGE_WAIT_LOG_MS,
      thresholdBps: CFG.TRADE_THRESHOLD_BPS,
      flatSlippageBps: CFG.MAX_SLIPPAGE_BPS,
      tradeSizeBase: CFG.TRADE_SIZE_BASE,

      // ensure min-size is honored by the decision/size optimizer
      decisionMinBase: CFG.DECISION_MIN_BASE,
      // (aliases, harmless if unused by your joiner)
      minBase: CFG.DECISION_MIN_BASE,
      minTradeBase: CFG.DECISION_MIN_BASE,

      phoenixFeeBps: resolveFeeBps("PHOENIX", PHX_MARKET, CFG.PHOENIX_TAKER_FEE_BPS),
      ammFeeBps: AMM_FEE_BPS,
      fixedTxCostQuote: CFG.FIXED_TX_COST_QUOTE,
    },
    {
      bookTtlMs: CFG.BOOK_TTL_MS,
      activeSlippageMode: CFG.ACTIVE_SLIPPAGE_MODE,
      phoenixSlippageBps: CFG.PHOENIX_SLIPPAGE_BPS,
      cpmmMaxPoolTradeFrac: CFG.CPMM_MAX_POOL_TRADE_FRAC,
      dynamicSlippageExtraBps: CFG.DYNAMIC_SLIPPAGE_EXTRA_BPS,
      logSimFields: CFG.LOG_SIM_FIELDS,
      enforceDedupe: CFG.ENFORCE_DEDUPE,
      decisionBucketMs: CFG.DECISION_BUCKET_MS,
      decisionMinEdgeDeltaBps: CFG.DECISION_MIN_EDGE_DELTA_BPS,
      useRpcSim: CFG.USE_RPC_SIM,

      // mirrored here too, in case your joiner reads it from the “options” bag
      decisionMinBase: CFG.DECISION_MIN_BASE,
    },
    onDecision,
    rpcSimFn,
    onRpcSample
  );

  // ──────────────────────────────────────────────────────────────────────
  // WS Markets (live feed) → push AMM/Phoenix updates directly into joiner
  // ──────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────
  // WS Markets (live feed) → push AMM/Phoenix updates directly into joiner
  // ──────────────────────────────────────────────────────────────────────

  // Enable WS feed if PAIRS_JSON is present
  const useWsProvider = !!process.env.PAIRS_JSON;

  if (useWsProvider) {
    console.log("edge_input_source { source: 'ws_markets' }");
    const { startWsMarkets } = await import("./provider/ws_markets.js");
    await startWsMarkets({
      httpUrl: process.env.RPC_URL,
      wsUrl: process.env.RPC_WSS_URL || process.env.WSS_URL || process.env.WS_URL,
      pairsPath: process.env.PAIRS_JSON,
      joiner,
    });
  }


  // If provider is enabled, feed the joiner directly from in-memory snapshots
  // (disabled when WS provider is active to avoid double-feeding)
  if (providerEnabled && marketProvider && !useWsProvider) {
    console.log("edge_input_source { source: 'provider' }");
    marketProvider.subscribe((state) => {
      try {
        // AMMs → mirror "amms_price" payload and keep LAST_CPMM fresh when reserves available
        for (const s of state.amms) {
          const obj = {
            event: "amms_price",
            symbol: "SOL/USDC",
            venue: s.venue,
            ammId: s.poolId,
            poolKind: s.poolKind,
            ts: s.lastUpdateTs,
            baseDecimals: s.baseDecimals,
            quoteDecimals: s.quoteDecimals,
            px: s.price ?? undefined,
            feeBps: s.feeBps ?? undefined,
            base_vault: s.baseVault ?? undefined,
            quote_vault: s.quoteVault ?? undefined,
            base_int:
              s.baseReserveAtoms ??
              (s.baseReserve != null && s.baseDecimals != null
                ? Math.trunc(s.baseReserve * 10 ** s.baseDecimals).toString()
                : undefined),
            quote_int:
              s.quoteReserveAtoms ??
              (s.quoteReserve != null && s.quoteDecimals != null
                ? Math.trunc(s.quoteReserve * 10 ** s.quoteDecimals).toString()
                : undefined),
            base_ui: s.baseReserve ?? undefined,
            quote_ui: s.quoteReserve ?? undefined,
            slot: s.slot ?? undefined,
            source: "provider",
            validation_passed: s.price != null,
          };
          joiner.upsertAmms(obj);

          // update local CPMM view when we have reserves
          try {
            if (s.baseReserve != null && s.quoteReserve != null) {
              LAST_CPMM = { base: s.baseReserve, quote: s.quoteReserve };
            }
          } catch { /* ignore */ }
        }

        // Phoenix → mirror "phoenix_l2" payload and keep LAST_BOOK/LAST_PHX_MID fresh
        for (const p of state.phoenix) {
          const obj = {
            event: "phoenix_l2",
            ts: p.lastUpdateTs,
            market: p.market,
            symbol: p.symbol,
            best_bid: p.bestBid ?? undefined,
            best_ask: p.bestAsk ?? undefined,
            phoenix_mid: p.mid ?? undefined,
            levels_bids: p.levelsBids,
            levels_asks: p.levelsAsks,
            slot: p.slot ?? undefined,
            source: "provider",
          };
          joiner.upsertPhoenix(obj);

          try {
            const bids = (p.levelsBids ?? []).map((l) => ({ px: Number(l.px), qtyBase: Number(l.qty ?? 0) }));
            const asks = (p.levelsAsks ?? []).map((l) => ({ px: Number(l.px), qtyBase: Number(l.qty ?? 0) }));
            LAST_BOOK = { bids, asks, takerFeeBps: Number.isFinite(PHX_FEE_BPS as number) ? Number(PHX_FEE_BPS) : 0 };
            if (Number.isFinite(p.mid as number)) LAST_PHX_MID = p.mid as number;
            else if (Number.isFinite(p.bestBid as number) && Number.isFinite(p.bestAsk as number))
              LAST_PHX_MID = ((p.bestBid as number) + (p.bestAsk as number)) / 2;
          } catch { /* ignore */ }
        }
      } catch { /* swallow per-tick errors */ }
    });
  }

  // Feed joiner from JSONL publishers and maintain local state
  // (disabled when WS provider is active to avoid double-feeding)
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
        LAST_PHX_MID = Number(obj?.px ?? obj?.phoenix_mid ?? obj?.mid ?? obj?.price ?? NaN);
        joiner.upsertPhoenix(obj);
      } else if (ev === "phoenix_l2" || ev === "phoenix_l2_empty") {
        joiner.upsertPhoenix(obj);
        try {
          const bids = (obj?.levels_bids ?? []).map((l: any) => ({ px: Number(l.px), qtyBase: Number(l.qty ?? l.qtyBase ?? 0) }));
          const asks = (obj?.levels_asks ?? []).map((l: any) => ({ px: Number(l.px), qtyBase: Number(l.qty ?? l.qtyBase ?? 0) }));
          LAST_BOOK = {
            bids,
            asks,
            takerFeeBps: Number.isFinite((PHX_FEE_BPS as number)) ? Number(PHX_FEE_BPS) : 0,
          };
          if (Number.isFinite(obj?.phoenix_mid)) LAST_PHX_MID = Number(obj.phoenix_mid);
          else if (Number.isFinite(obj?.px)) LAST_PHX_MID = Number(obj.px);
          else if (Number.isFinite(obj?.best_bid) && Number.isFinite(obj?.best_ask))
            LAST_PHX_MID = (Number(obj.best_bid) + Number(obj.best_ask)) / 2;
        } catch { }
      } else {
        try {
          const ms = Number(obj?.data?.rpc_sim_ms ?? obj?.rpc_sim_ms);
          if (Number.isFinite(ms)) {
            rpcSamples++;
            rpcMsP50 = ewma(rpcMsP50, ms, 0.1);
            rpcMsP95 = Math.max(rpcMsP95, ms);
            if (LOG_ML) { try { emitRpcSample(ms, Boolean(obj?.data?.guard_blocked ?? obj?.guard_blocked)); } catch { } }
          }
          const blocked = obj?.data?.guard_blocked ?? obj?.guard_blocked;
          if (blocked === true) rpcBlocked++;
        } catch { }
      }
    },
    POLL_MS
  );

  if (!providerEnabled && !useWsProvider) {
    await Promise.all([ammsFollower.start(), phxFollower.start()]);
  } else {
    console.log(`edge_input_source { source: '${providerEnabled ? "provider" : "ws_markets"}' }`);
  }

  // NO AUTO-STOP → run indefinitely until SIGINT/SIGTERM

  // Graceful shutdown (unchanged)
  function shutdown(signal: string) {
    (async () => {
      try { ammsFollower.stop(); } catch { }
      try { phxFollower.stop(); } catch { }
      try { sup.stop(); } catch { }
      try { await marketProvider?.stop(); } catch { }

      try {
        if (accounts) {
          const ownerPk =
            tryPubkey(process.env.WALLET_PUBKEY) ?? ((accounts as any).owner as PublicKey);
          const wsolAtaHint =
            tryPubkey(process.env.WSOL_ATA) ?? (accounts as any)?.atas?.wsol;
          const usdcAtaHint =
            tryPubkey(process.env.USDC_ATA) ?? (accounts as any)?.atas?.usdc;

          END_BAL = await readBalances(conn, ownerPk, { wsol: wsolAtaHint, usdc: usdcAtaHint });
          logger.log("balances_end", END_BAL);
          console.log(`END    SOL=${END_BAL.sol}  WSOL=${END_BAL.wsol}  USDC=${END_BAL.usdc}`);
          const dsol = roundN(END_BAL.sol - (START_BAL?.sol ?? 0), 9);
          const dwsol = roundN(END_BAL.wsol - (START_BAL?.wsol ?? 0), 9);
          const dusdc = roundN(END_BAL.usdc - (START_BAL?.usdc ?? 0), 6);
          console.log(`DELTA  dSOL=${dsol}  dWSOL=${dwsol}  dUSDC=${dusdc}`);
        }
      } catch (e) {
        console.log("END BAL ERROR", e);
      }
      if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE);
      logger.log("arb_shutdown", { ok: true, signal, live_only: true });
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
    if (isRateLimitError(e)) {
      logger.log("arb_rate_limit", { error: String(e) });
      return;
    }
    logger.log("arb_fatal", { error: String(e) });
    if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    if (isRateLimitError(e)) {
      logger.log("arb_rate_limit", { error: String(e) });
      return;
    }
    logger.log("arb_fatal", { error: String(e) });
    if (!wroteSummary) writeLiveSummarySync(CFG, ML_EVENTS_FILE);
    process.exit(1);
  });
}

main().catch(async (e) => {
  if (isRateLimitError(e)) {
    logger.log("arb_rate_limit", { error: String(e) });
    return;
  }
  logger.log("arb_fatal", { error: String(e) });
  try {
    const { loadConfig } = await import("./config.js");
    const CFG = loadConfig();
    const LIVE_DIR = resolveLiveDir(CFG.DATA_DIR);
    const file = path.join(LIVE_DIR, `arb-summary-${stampLocal()}.json`);
    fs.writeFileSync(file, JSON.stringify({ error: String(e) }, null, 2));
  } catch { }
});

function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as any)?.code;
  if (code === -32429) return true;
  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  return msg.includes("429") || msg.includes("rate limited") || msg.includes("too many requests") || msg.includes("rate limit");
}
