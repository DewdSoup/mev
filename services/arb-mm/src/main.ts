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
import { PublicKey, Keypair } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { logger } from "./ml_logger.js";

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
import type { ExecutionLeg } from "./types/execution.js";

import {
  pnlQuoteForSizeBase,
  type PhoenixBook as PxBook,
  type CpmmReserves,
} from "./executor/size.js";
import { PublisherSupervisor } from "./publishers/supervisor.js";
import { prewarmPhoenix } from "./util/phoenix.js"; // warm Phoenix cache on boot
import { MarketStateProvider } from "./market/index.js";
import { loadPairsFromEnvOrDefault } from "./registry/pairs.js";
import { setRpcLatencies } from "./runtime/metrics.js";
import { startWsMarkets } from "./provider/ws_markets.js";
import {
  ensureRaydiumFee,
  ensurePhoenixFee,
  ensureOrcaFee,
  getCachedRaydiumFee,
  getCachedPhoenixFee,
  getCachedOrcaFee,
} from "./util/fee_cache.js";
import { asPublicKey } from "./util/pubkey.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TextWriter {
  private stream: fs.WriteStream | null = null;
  constructor(private readonly filePath: string) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.stream = fs.createWriteStream(filePath, {
      flags: "a",
      encoding: "utf8",
      mode: 0o644,
    });
  }
  write(line: string) {
    if (!this.stream) return;
    try {
      this.stream.write(line + "\n");
    } catch (err) {
      logger.log("decision_log_write_error", { err: String((err as any)?.message ?? err) });
    }
  }
  close() {
    try { this.stream?.end(); } catch { /* noop */ }
    this.stream = null;
  }
}

function resolveDecisionLogPath(): string {
  const env = (process.env.EDGE_DECISIONS_TEXT ?? "").trim();
  if (env) return path.isAbsolute(env) ? env : path.resolve(env);
  const runRoot = (process.env.RUN_ROOT ?? "").trim();
  if (runRoot) return path.resolve(runRoot, "decisions.log");
  return path.resolve(process.cwd(), "data", "logs", "decisions.log");
}

const decisionsWriter = new TextWriter(resolveDecisionLogPath());
process.once("beforeExit", () => decisionsWriter.close());
process.once("SIGINT", () => decisionsWriter.close());
process.once("SIGTERM", () => decisionsWriter.close());

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
  return asPublicKey(s ?? undefined);
}
const warnedKeys = new Set<string>();
const missingAtaCache = new Set<string>();
function warnOnce(key: string, fn: () => void) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  fn();
}
const SKIP_BALANCE_READS = String(process.env.SKIP_BALANCE_READS ?? "1") === "1";
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
    this.poller.unref?.();
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
function startHealth(conn: Connection): () => void {
  let stopped = false;

  const sampleTps = async (): Promise<number> => {
    try {
      const samples = await conn.getRecentPerformanceSamples(1);
      if (!samples?.length) return 0;
      const s = samples[0];
      if (!s.numTransactions || !s.samplePeriodSecs) return 0;
      return s.numTransactions / s.samplePeriodSecs;
    } catch {
      return 0;
    }
  };

  const timer = setInterval(async () => {
    if (stopped) return;
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
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
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
  preferredAta?: string | PublicKey
): Promise<number> {
  if (SKIP_BALANCE_READS) return 0;
  const ataPk = asPublicKey(preferredAta);
  if (ataPk) {
    const ataKey = ataPk.toBase58();
    if (!missingAtaCache.has(ataKey)) {
      try {
        const r = await conn.getTokenAccountBalance(ataPk, "confirmed");
        const amt = Number(r?.value?.uiAmount ?? 0);
        if (Number.isFinite(amt)) return amt;
      } catch (err) {
        missingAtaCache.add(ataKey);
        warnOnce(`missing_ata_${ataKey}`, () =>
          logger.log("missing_ata", { ata: ataKey, mint: mint.toBase58(), err: String((err as any)?.message ?? err) })
        );
      }
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
  if (SKIP_BALANCE_READS) {
    return { sol: 0, wsol: 0, usdc: 0 };
  }
  const ownerPk = asPublicKey(owner) ?? owner;
  const [solLamports, wsol, usdc] = await Promise.all([
    conn.getBalance(ownerPk, "confirmed").catch(() => 0),
    sumMintBalance(conn, ownerPk, WSOL_MINT, ataHints?.wsol),
    sumMintBalance(conn, ownerPk, USDC_MINT, ataHints?.usdc),
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

  if (!process.env.PAIRS_JSON || !process.env.PAIRS_JSON.trim()) {
    const defaultPairs = path.resolve(process.cwd(), "configs", "pairs.json");
    if (fs.existsSync(defaultPairs)) process.env.PAIRS_JSON = defaultPairs;
  }

  const PAIRS = loadPairsFromEnvOrDefault();
  if (PAIRS.length) {
    logger.log("arb_pairs_loaded", {
      count: PAIRS.length,
      pairs: PAIRS.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        venues: (p.ammVenues ?? []).map((v) => `${v.venue}:${v.poolId}`),
      })),
    });
  }

  logger.log("arb_limiter_config", {
    limiter_enabled: String(process.env.RPC_FACADE_LIMITER ?? "1"),
    rps: Number(process.env.RPC_FACADE_RPS ?? "NaN"),
    burst: Number(process.env.RPC_FACADE_BURST ?? "NaN"),
    backoff_max_concurrency: Number(process.env.RPC_BACKOFF_MAX_CONCURRENCY ?? "NaN"),
  });

  const boolFromEnv = (value: string | undefined, defaultVal: boolean): boolean => {
    if (value == null) return defaultVal;
    const s = value.trim().toLowerCase();
    if (!s) return defaultVal;
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return defaultVal;
  };

  const LIVE = boolFromEnv(process.env.LIVE_TRADING, true);
  const SHADOW = !LIVE && boolFromEnv(process.env.SHADOW_TRADING, true);
  const EXEC_MODE = String(process.env.EXEC_MODE ?? (LIVE ? "LIVE" : "SIM_ONLY")).trim().toUpperCase();
  const SIM_ONLY = EXEC_MODE === "SIM_ONLY";

  // Explicit boot banner (live-only)
  console.log(
    [
      `BOOT rpc=${maskUrl(RPC)}`,
      `LIVE_TRADING=${LIVE ? 1 : 0}`,
      `SHADOW_TRADING=${SHADOW ? 1 : 0}`,
      `EXEC_MODE=${EXEC_MODE}`,
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
    live_forced: LIVE,
    exec_mode: EXEC_MODE,
    env_live_locked: true,
  });

  // Embedded publishers (optional; auto when enabled)
  const providerEnabled = String(process.env.ENABLE_MARKET_PROVIDER ?? "0") === "1";
  const enableEmbedded = String(process.env.ENABLE_EMBEDDED_PUBLISHERS ?? "1") === "1";

  const sup = new PublisherSupervisor({
    enable: enableEmbedded,
    phoenixJsonl: CFG.PHOENIX_JSONL,
    ammsJsonl: CFG.AMMS_JSONL,
    freshnessMs: 3500,
    pollMs: 2000,
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
  });
  sup.start();

  const { rpcClient, rpc } = await import("@mev/rpc-facade");

  // Attach WS endpoint (Phoenix publisher will poll if SDK lacks subs)
  const conn = rpcClient;

  const ENABLE_MARKET_PROVIDER = String(process.env.ENABLE_MARKET_PROVIDER ?? "0").trim() === "1";
  let marketProvider: MarketStateProvider | null = null;
  if (ENABLE_MARKET_PROVIDER) {
    try {
      marketProvider = new MarketStateProvider(conn, PAIRS);
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
  if (PAIRS.length) {
    const enableRaydiumClmm = String(process.env.ENABLE_RAYDIUM_CLMM ?? "1").trim() !== "0";
    for (const pair of PAIRS) {
      tryPush(pair.phoenixMarket);
      tryPush(pair.ammPool);
      for (const venue of pair.ammVenues ?? []) {
        if (!venue || venue.enabled === false) continue;
        const venueName = String(venue.venue ?? "").toLowerCase();
        if (!enableRaydiumClmm && venueName === "raydium" && String(venue.poolKind ?? "").toLowerCase() === "clmm") {
          continue;
        }
        tryPush(venue.poolId);
      }
    }
  } else {
    tryPush(process.env.PHOENIX_MARKET);
    tryPush(process.env.PHOENIX_MARKET_ID);
    if (String(process.env.ENABLE_RAYDIUM_CLMM ?? "1").trim() !== "0") {
      tryPush(process.env.RAYDIUM_POOL_ID);
      tryPush(process.env.RAYDIUM_POOL_ID_SOL_USDC);
    }
    tryPush(process.env.ORCA_POOL_ID);
    tryPush(process.env.RAYDIUM_CLMM_POOL_ID);
  }

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

  const stopHealth = startHealth(conn);
  initRisk();

  // Live-only (forced via env flags above)
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
    const wsolAtaHint = asPublicKey(envWsolAta ?? (accounts as any)?.atas?.wsol);
    const usdcAtaHint = asPublicKey(envUsdcAta ?? (accounts as any)?.atas?.usdc);

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
  const ORCA_POOL =
    (process.env.ORCA_POOL_ID ?? process.env.ORCA_POOL ?? "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ").trim();
  const PHX_MARKET =
    (CFG.PHOENIX_MARKET || process.env.PHOENIX_MARKET_ID || "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg").trim();

  // warm Phoenix caches so the first instruction build is also fast
  try { await prewarmPhoenix(conn, [PHX_MARKET]); } catch (e) { logger.log("phoenix_prewarm_error", { error: String(e) }); }

  let AMM_FEE_BPS = resolveFeeBps("AMM", RAYDIUM_POOL, CFG.AMM_TAKER_FEE_BPS);
  const cachedRayFee = getCachedRaydiumFee(RAYDIUM_POOL);
  if (cachedRayFee != null) AMM_FEE_BPS = cachedRayFee;
  AMM_FEE_BPS = await ensureRaydiumFee(conn, RAYDIUM_POOL, AMM_FEE_BPS);
  process.env.RAYDIUM_TRADE_FEE_BPS = String(AMM_FEE_BPS);
  logger.log("fee_model_ray", {
    pool: RAYDIUM_POOL,
    fee_bps: AMM_FEE_BPS,
    source: "onchain",
  });

  let ORCA_FEE_FALLBACK = Number(process.env.ORCA_TRADE_FEE_BPS ?? CFG.AMM_TAKER_FEE_BPS);
  if (!Number.isFinite(ORCA_FEE_FALLBACK) || ORCA_FEE_FALLBACK <= 0) ORCA_FEE_FALLBACK = AMM_FEE_BPS;
  let ORCA_FEE_BPS = resolveFeeBps("AMM", ORCA_POOL, ORCA_FEE_FALLBACK);
  const cachedOrcaFee = getCachedOrcaFee(ORCA_POOL);
  if (cachedOrcaFee != null) ORCA_FEE_BPS = cachedOrcaFee;
  ORCA_FEE_BPS = await ensureOrcaFee(conn, ORCA_POOL, ORCA_FEE_BPS);
  process.env.ORCA_TRADE_FEE_BPS = String(ORCA_FEE_BPS);
  logger.log("fee_model_orca", {
    pool: ORCA_POOL,
    fee_bps: ORCA_FEE_BPS,
    source: "onchain",
  });

  let PHX_FEE_BPS = resolveFeeBps("PHOENIX", PHX_MARKET, CFG.PHOENIX_TAKER_FEE_BPS);
  const cachedPhxFee = getCachedPhoenixFee(PHX_MARKET);
  if (cachedPhxFee != null) PHX_FEE_BPS = cachedPhxFee;
  PHX_FEE_BPS = await ensurePhoenixFee(conn, PHX_MARKET, PHX_FEE_BPS);
  process.env.PHOENIX_TAKER_FEE_BPS = String(PHX_FEE_BPS);
  logger.log("fee_model_phx", {
    market: PHX_MARKET,
    fee_bps: PHX_FEE_BPS,
    source: "onchain",
  });

  logger.log("fee_config", {
    raydium_pool: RAYDIUM_POOL,
    amm_fee_bps: AMM_FEE_BPS,
    orca_pool: ORCA_POOL,
    orca_fee_bps: ORCA_FEE_BPS,
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

  let attemptCounter = 0;
  const nextAttemptId = () => `att_${Date.now().toString(36)}_${(attemptCounter++).toString(36)}`;
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
    try {
      const line = `${new Date().toISOString()} would_trade=${Boolean(_wouldTrade)} edge_bps=${edgeNetBps.toFixed(4)} pnl=${expPnl.toFixed(6)} ` +
        (d ? `path=${d.path} amm=${d.amm_venue ?? "?"} buy_px=${Number(d.buy_px ?? NaN).toFixed(6)} sell_px=${Number(d.sell_px ?? NaN).toFixed(6)} size=${Number(d.recommended_size_base ?? NaN).toFixed(6)}`
          : "decision=idle");
      decisionsWriter.write(line);
    } catch {
      /* best-effort logging */
    }
    if (!d) { recordDecision(false, edgeNetBps, expPnl); return; }

    const execSize =
      (d.recommended_size_base && d.recommended_size_base > 0
        ? d.recommended_size_base
        : (Number(process.env.LIVE_SIZE_BASE ?? 0) || CFG.TRADE_SIZE_BASE));
    const notional = coalesceRound(6, execSize * ((d.buy_px + d.sell_px) / 2));
    const legs = Array.isArray((d as any).legs) ? (d.legs as ExecutionLeg[]) : [];
    const phoenixLeg = legs.find((leg) => leg.kind === "phoenix") as any;
    const firstAmmLeg = legs.find((leg) => leg.kind === "amm") as any;
    const forcing = String(process.env.EXEC_AMM_VENUE ?? "").trim().toLowerCase();
    const venueFromJoiner = (d.amm_venue ?? firstAmmLeg?.venue ?? "").toLowerCase();
    const ammVenue = (forcing === "raydium" || forcing === "orca")
      ? forcing
      : (venueFromJoiner === "raydium" || venueFromJoiner === "orca" ? venueFromJoiner : "raydium");
    const rayPoolEnv = (process.env.RAYDIUM_POOL_ID ?? process.env.RAYDIUM_POOL_ID_SOL_USDC ?? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2").trim();
    const orcaPoolEnv = (process.env.ORCA_POOL_ID ?? "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ").trim();
    const poolIdHint = d.amm_pool_id ?? firstAmmLeg?.poolId;
    const poolIdForVenue = ammVenue === "raydium" ? (poolIdHint ?? rayPoolEnv) : (poolIdHint ?? orcaPoolEnv);
    const legsCount = legs.length;
    const attemptId = nextAttemptId();
    const threshold = Number(CFG.TRADE_THRESHOLD_BPS ?? 0);

    if (ALLOWED !== "both" && d.path && d.path !== ALLOWED) {
      logger.log("skip_due_to_path", { have: d.path, allowed: ALLOWED });
      recordDecision(false, edgeNetBps, expPnl);
      try {
        logger.log("opportunity_blocked", {
          attempt_id: attemptId,
          exec_mode: EXEC_MODE,
          path: d.path,
          size_base: roundN(execSize, 6),
          expected_pnl_quote: Number(roundN(expPnl, 6)),
          edge_net_bps: Number(roundN(edgeNetBps, 4)),
          edge_gross_bps: (d as any)?.edge_bps_gross != null ? Number(roundN((d as any).edge_bps_gross, 4)) : undefined,
          thresholds: {
            trade_threshold_bps: threshold,
            min_net_profit_bps: Number(process.env.MIN_NET_PROFIT_BPS ?? (CFG as any)?.MIN_NET_PROFIT_BPS ?? "") || undefined,
            min_profitable_bps: Number(process.env.MIN_PROFITABLE_BPS ?? (CFG as any)?.MIN_PROFITABLE_BPS ?? "") || undefined,
            pnl_safety_bps: Number(process.env.PNL_SAFETY_BPS ?? 0),
          },
          reason: "path_filtered",
        });
      } catch { }
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

    const execMinAbs = envNum("TEST_FORCE_SEND_IF_ABS_EDGE_BPS");
    const forceByAbs = execMinAbs != null && Math.abs(edgeNetBps) >= execMinAbs;
    const doExecute = (Boolean(_wouldTrade) && expPnl > 0 && edgeNetBps >= threshold) || forceByAbs;

    if (forceByAbs) console.log(`FORCE_EXEC absEdge=${edgeNetBps}bps >= ${execMinAbs}bps`);

    recordDecision(doExecute, edgeNetBps, expPnl);
    try {
      logger.log("opportunity_debug_marker", {
        attempt_id: attemptId,
        exec_mode: EXEC_MODE,
        path: d.path,
        do_execute: doExecute,
        edge_net_bps: Number(roundN(edgeNetBps, 4)),
        expected_pnl_quote: Number(roundN(expPnl, 6)),
        decision_reason: (d as any)?.decision_reason ?? (expPnl <= 0 ? "negative_expected_pnl" : undefined),
      });
    } catch { /* marker is best-effort */ }
    if (!doExecute) {
      const minNetProfitBps = Number(process.env.MIN_NET_PROFIT_BPS ?? (CFG as any)?.MIN_NET_PROFIT_BPS ?? NaN);
      const minProfitableBps = Number(process.env.MIN_PROFITABLE_BPS ?? (CFG as any)?.MIN_PROFITABLE_BPS ?? NaN);
      const pnlSafetyBps = Number(process.env.PNL_SAFETY_BPS ?? 0);
      const reason = (d as any)?.decision_reason ?? (expPnl <= 0 ? "negative_expected_pnl" : "edge_below_threshold");
      try {
        logger.log("opportunity_blocked", {
          attempt_id: attemptId,
          exec_mode: EXEC_MODE,
          path: d.path,
          size_base: roundN(execSize, 6),
          expected_pnl_quote: Number(roundN(expPnl, 6)),
          edge_net_bps: Number(roundN(edgeNetBps, 4)),
          edge_gross_bps: (d as any)?.edge_bps_gross != null ? Number(roundN((d as any).edge_bps_gross, 4)) : undefined,
          thresholds: {
            trade_threshold_bps: threshold,
            min_net_profit_bps: Number.isFinite(minNetProfitBps) ? minNetProfitBps : undefined,
            min_profitable_bps: Number.isFinite(minProfitableBps) ? minProfitableBps : undefined,
            pnl_safety_bps: pnlSafetyBps,
          },
          reason,
        });
      } catch { }
      return;
    }

    const payload: any = {
      path: d.path,
      size_base: execSize,
      buy_px: d.buy_px,
      sell_px: d.sell_px,
      notional_quote: notional,
      amm_venue: ammVenue,               // 👈 carry venue choice
      amm_pool_id: poolIdForVenue,       // 👈 explicit pool id (executor checks this first)
      amm: { pool: poolIdForVenue },     // 👈 backward-compat payload
      amm_meta: (d as any).amm_meta,     // 👈 pass-through meta if joiner provided it
      legs,
      atomic: true,
    };

    if (phoenixLeg) {
      payload.phoenix = {
        market: String(phoenixLeg.market ?? (CFG.PHOENIX_MARKET || process.env.PHOENIX_MARKET_ID || "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg")).trim(),
        side: (phoenixLeg.side ?? d.side) as "buy" | "sell",
        limit_px: (phoenixLeg.side ?? d.side) === "buy" ? d.buy_px : d.sell_px,
      };
    } else if (d.side) {
      payload.phoenix = {
        market: (CFG.PHOENIX_MARKET || process.env.PHOENIX_MARKET_ID || "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg").trim(),
        side: d.side as "buy" | "sell",
        limit_px: d.side === "buy" ? d.buy_px : d.sell_px,
      };
    }

    if (d.path === "AMM->AMM") {
      const joinerDstVenue = String(d.amm_dst_venue ?? "").toLowerCase();
      const dstVenue = joinerDstVenue === "raydium" || joinerDstVenue === "orca"
        ? joinerDstVenue
        : (joinerDstVenue ? joinerDstVenue : (ammVenue === "raydium" ? "orca" : "raydium"));
      const dstPoolEnv = dstVenue === "raydium" ? rayPoolEnv : orcaPoolEnv;
      const dstPoolId = String(d.amm_dst_pool_id ?? "").trim() || dstPoolEnv;
      payload.amm_dst_venue = dstVenue;
      payload.amm_dst_pool_id = dstPoolId;
      payload.amm_dst = { pool: dstPoolId };
      if ((d as any)?.amm_dst_meta) payload.amm_dst_meta = (d as any).amm_dst_meta;
    }

    const attemptMeta = {
      attempt_id: attemptId,
      exec_mode: EXEC_MODE,
      path: payload.path,
      size_base: roundN(execSize, 6),
      expected_pnl_quote: Number(roundN(expPnl, 6)),
      edge_bps: Number(roundN(edgeNetBps, 4)),
      amm_venue: ammVenue,
      amm_pool_id: poolIdForVenue,
      notional_quote: notional,
      legs: legsCount,
    };
    try {
      logger.log("opportunity_attempt", attemptMeta);
    } catch { /* logging best-effort */ }
    payload.attempt_id = attemptId;
    payload.expected_pnl_quote = expPnl;
    payload.edge_bps = edgeNetBps;
    payload.exec_mode = EXEC_MODE;

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

      phoenixFeeBps: PHX_FEE_BPS,
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
  // Market inputs (WS, provider, JSONL fallback)
  // ──────────────────────────────────────────────────────────────────────
  const inputSources: string[] = [];
  const useWsProvider = !!process.env.PAIRS_JSON;
  const providerFeedAmmsWhenWs = String(process.env.PROVIDER_FEED_AMMS_WITH_WS ?? process.env.PROVIDER_FEED_AMMS_WHEN_WS ?? "0").trim() === "1";
  const providerIncludeAmms = !useWsProvider || providerFeedAmmsWhenWs;
  let wsHandle: Awaited<ReturnType<typeof startWsMarkets>> | null = null;

  if (useWsProvider) {
    inputSources.push("ws_markets");
    const { startWsMarkets } = await import("./provider/ws_markets.js");
    wsHandle = await startWsMarkets({
      httpUrl: process.env.RPC_URL,
      wsUrl: process.env.RPC_WSS_URL || process.env.WSS_URL || process.env.WS_URL,
      pairsPath: process.env.PAIRS_JSON,
      joiner,
      provider: marketProvider ?? undefined,
    });
  }

  if (providerEnabled && marketProvider) {
    inputSources.push(
      useWsProvider && !providerIncludeAmms ? "provider(phoenix)" : "provider"
    );
    marketProvider.subscribe((state) => {
      try {
        if (providerIncludeAmms) {
          for (const s of state.amms) {
            const price = typeof s.price === "number" && Number.isFinite(s.price) && s.price > 0 ? s.price : undefined;
            const validationPassed = price != null;
            if (!validationPassed && typeof s.price === "number" && Number.isNaN(s.price)) {
              logger.log("amm_price_invalid_nan", {
                venue: s.venue,
                pool: s.poolId,
                pool_kind: s.poolKind,
              });
            }
            const obj = {
              event: "amms_price",
              symbol: "SOL/USDC",
              venue: s.venue,
              ammId: s.poolId,
              poolKind: s.poolKind,
              ts: s.lastUpdateTs,
              baseDecimals: s.baseDecimals,
              quoteDecimals: s.quoteDecimals,
              px: price,
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
              heartbeat_at: s.heartbeatAt ?? undefined,
              heartbeat_slot: s.heartbeatSlot ?? undefined,
              ws_at: s.wsAt ?? undefined,
              synthetic_slot: typeof s.syntheticSlot === "boolean" ? s.syntheticSlot : undefined,
              tradeable_when_degraded: typeof s.tradeableWhenDegraded === "boolean" ? s.tradeableWhenDegraded : undefined,
              source: s.source ?? "provider",
              validation_passed: validationPassed,
            };
            joiner.upsertAmms(obj);

            try {
              if (s.baseReserve != null && s.quoteReserve != null) {
                LAST_CPMM = { base: s.baseReserve, quote: s.quoteReserve };
              }
            } catch { /* ignore */ }
          }
        } else {
          for (const s of state.amms) {
            try {
              if (s.baseReserve != null && s.quoteReserve != null) {
                LAST_CPMM = { base: s.baseReserve, quote: s.quoteReserve };
              }
            } catch { /* ignore */ }
          }
        }

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

  let followersStarted = false;
  if (!useWsProvider && (!providerEnabled || !marketProvider)) {
    inputSources.push("jsonl_followers");
    await Promise.all([ammsFollower.start(), phxFollower.start()]);
    followersStarted = true;
  }

  if (inputSources.length) {
    console.log(`edge_input_source { sources: [${inputSources.join(", ")}] }`);
  }

  let shuttingDown = false;
  const shutdown = async (tag: string, err?: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      logger.log("arb_shutdown_start", {
        tag,
        error: err ? String((err as any)?.message ?? err) : undefined,
      });
    } catch { }

    try { stopHealth(); } catch { }

    try { await wsHandle?.close(); } catch (e) {
      logger.log("arb_shutdown_ws_error", { err: String((e as any)?.message ?? e) });
    }

    try { joiner.close(); } catch { }
    try { sup.stop(); } catch { }
    try { await marketProvider?.stop(); } catch { }
    if (followersStarted) {
      try { ammsFollower.stop(); } catch { }
      try { phxFollower.stop(); } catch { }
    }

    if (!SKIP_BALANCE_READS && accounts) {
      try {
        const ownerPk = envOwner ?? ((accounts as any).owner as PublicKey);
        const wsolAtaHintSafe = asPublicKey(envWsolAta ?? (accounts as any)?.atas?.wsol ?? process.env.WSOL_ATA);
        const usdcAtaHintSafe = asPublicKey(envUsdcAta ?? (accounts as any)?.atas?.usdc ?? process.env.USDC_ATA);
        END_BAL = await readBalances(conn, ownerPk, {
          wsol: wsolAtaHintSafe ?? undefined,
          usdc: usdcAtaHintSafe ?? undefined,
        });
        logger.log("balances_end", END_BAL);
      } catch (e) {
        logger.log("balances_end_error", { err: String((e as any)?.message ?? e) });
      }
    }

    if (!wroteSummary) {
      try { writeLiveSummarySync(CFG, ML_EVENTS_FILE); wroteSummary = true; } catch { }
    }

    logger.log("arb_shutdown", { ok: !err, tag, live_only: true });
    process.exit(err ? 1 : 0);
  };

  ["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
    process.on(sig, () => {
      void shutdown(sig as NodeJS.Signals);
    });
  });

  process.on("uncaughtException", (e) => {
    if (isRateLimitError(e)) {
      logger.log("arb_rate_limit", { error: String(e) });
      return;
    }
    console.error(e);
    void shutdown("uncaughtException", e);
  });

  process.on("unhandledRejection", (reason) => {
    if (isRateLimitError(reason)) {
      logger.log("arb_rate_limit", { error: String(reason) });
      return;
    }
    console.error(reason);
    void shutdown("unhandledRejection", reason);
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
