// services/arb-mm/src/main.ts
// Boot: health + JSONL followers + EdgeJoiner (CPMM/adaptive) + optional RPC sim + live summary.
// Env-only control: SHADOW_TRADING, LIVE_TRADING, USE_RPC_SIM, etc.

import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";

// ORIGINAL logger (restored) — keeps your runtime.jsonl + tags
import { logger } from "@mev/storage";

import { loadConfig, RPC, maskUrl, stamp, resolveFeeBps } from "./config.js";
import { EdgeJoiner, type DecisionHook, type RpcSampleHook, type RpcSimFn } from "./edge/joiner.js";
import { setChainTps } from "./feature_sink.js";
import { initRisk } from "@mev/risk";
import { initAccounts } from "./accounts.js";
import { LiveExecutor } from "./executor/live.js";
import { initSessionRecorder } from "./session_recorder.js";
import { asNumber, roundN, coalesceRound } from "./util/num.js";
import { simulateRaydiumSwapFixedIn } from "./executor/sim.js";

// 🔹 ML emitters (clean schema; optional via LOG_SIM_FIELDS)
import {
  emitEdgeSnapshot,
  emitDecision,
  emitSubmittedTx,
  emitLanded,
  emitRpcSample,
} from "./ml_schema.js";

// ────────────────────────────────────────────────────────────────────────────
// JSONL follower (tail with watch+poll)
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
  ) {}

  async start() {
    await this.openAtEOF();
    this.watch();
    this.poller = setInterval(() => this.readNewBytes(), this.pollMs);
  }

  stop() {
    try {
      this.watcher?.close();
    } catch {}
    if (this.poller) clearInterval(this.poller);
    try {
      if (this.fd !== null) fs.closeSync(this.fd);
    } catch {}
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
          try {
            if (this.fd !== null) fs.closeSync(this.fd);
          } catch {}
          this.openAtEOF().catch(() => {});
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
        try {
          this.onLine(JSON.parse(line));
        } catch {}
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
/** live summary metrics */
// ────────────────────────────────────────────────────────────────────────────

const runStartedAt = new Date();
let consideredCnt = 0;
let wouldTradeCnt = 0;
let wouldNotCnt = 0;
let bestEdgeNet = -Infinity;
let worstEdgeNet = +Infinity;
let cumSimPnLQuote = 0;
let wroteSummary = false;

// Optional RPC summary counters
let rpcSamples = 0;
let rpcMsP50 = 0;
let rpcMsP95 = 0;
let rpcBlocked = 0;

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function recordDecision(wouldTrade: boolean, edgeNetBps: number, expectedPnl: number) {
  consideredCnt++;
  if (wouldTrade) {
    wouldTradeCnt++;
    cumSimPnLQuote += expectedPnl;
  } else {
    wouldNotCnt++;
  }
  if (edgeNetBps > bestEdgeNet) bestEdgeNet = edgeNetBps;
  if (edgeNetBps < worstEdgeNet) worstEdgeNet = edgeNetBps;
}

function ewma(prev: number, x: number, alpha = 0.1) {
  if (!Number.isFinite(prev) || prev <= 0) return Math.round(x);
  return Math.round(prev + (x - prev) * alpha);
}

function writeLiveSummarySync(CFG: ReturnType<typeof loadConfig>) {
  try {
    const LIVE_DIR = path.join(CFG.DATA_DIR, "live");
    ensureDir(LIVE_DIR);

    const summary: any = {
      started_at: runStartedAt.toISOString(),
      stopped_at: new Date().toISOString(),
      considered: consideredCnt,
      would_trade: wouldTradeCnt,
      would_not_trade: wouldNotCnt,
      pnl_sum: roundN(cumSimPnLQuote, 6) ?? 0,
      best_edge_bps: Number.isFinite(bestEdgeNet) ? (roundN(bestEdgeNet, 4) ?? 0) : 0,
      worst_edge_bps: Number.isFinite(worstEdgeNet) ? (roundN(worstEdgeNet, 4) ?? 0) : 0,
      threshold_bps: CFG.TRADE_THRESHOLD_BPS,
      slippage_bps: CFG.MAX_SLIPPAGE_BPS,
      trade_size_base: CFG.TRADE_SIZE_BASE,
      book_ttl_ms: CFG.BOOK_TTL_MS,
      decision_dedupe_ms: CFG.DECISION_DEDUPE_MS,
      decision_bucket_ms: CFG.DECISION_BUCKET_MS,
      min_edge_delta_bps: CFG.DECISION_MIN_EDGE_DELTA_BPS,
      allow_synth_trades: CFG.ALLOW_SYNTH_TRADES,
    };

    if (rpcSamples > 0) {
      summary.rpc = {
        samples: rpcSamples,
        p50_ms: rpcMsP50,
        p95_ms: rpcMsP95,
        blocked_due_to_deviation: rpcBlocked,
        used_swap_sim: String(process.env.USE_RAYDIUM_SWAP_SIM ?? "false"),
      };
    }

    const file = path.join(LIVE_DIR, `${stamp()}.summary.json`);
    fs.writeFileSync(file, JSON.stringify(summary, null, 2));
    wroteSummary = true;
    logger.log("arb_live_summary_written", { file, ...summary });
  } catch (e) {
    logger.log("arb_live_summary_write_error", { err: String(e) });
  }
}

// ────────────────────────────────────────────────────────────────────────────
/** main */
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const CFG = loadConfig();
  logger.log("arb boot", { rpc: maskUrl(RPC) });

  const conn = new Connection(RPC, { commitment: "processed" });
  startHealth(conn).catch(() => {});

  // risk banner
  initRisk();

  const LIVE = String(process.env.LIVE_TRADING ?? "0") === "1";
  const SHADOW = String(process.env.SHADOW_TRADING ?? "0") === "1";
  const LIVE_SIZE_BASE = Number(process.env.LIVE_SIZE_BASE ?? 0) || CFG.TRADE_SIZE_BASE;
  const LOG_ML = Boolean(CFG.LOG_SIM_FIELDS);

  let liveExec: LiveExecutor | null = null;
  let accounts: Awaited<ReturnType<typeof initAccounts>> | null = null;

  if (LIVE && !SHADOW) {
    accounts = await initAccounts(conn);
    await initSessionRecorder(conn, accounts.owner, CFG); // harmless additive
    liveExec = new LiveExecutor(conn, accounts, CFG);
    await liveExec.startPhoenix();
  } else {
    logger.log("shadow_mode", {
      note: "skip initAccounts + LiveExecutor + startPhoenix",
      live: LIVE,
      shadow: SHADOW,
    });
  }

  // Resolve authoritative fees per venue (global default + per-id override)
  const RAYDIUM_POOL = (process.env.RAYDIUM_POOL_ID ?? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2").trim();
  const PHX_MARKET   = (CFG.PHOENIX_MARKET || "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg").trim();

  const AMM_FEE_BPS = resolveFeeBps("AMM", RAYDIUM_POOL, CFG.AMM_TAKER_FEE_BPS);
  const PHX_FEE_BPS = resolveFeeBps("PHOENIX", PHX_MARKET, CFG.PHOENIX_TAKER_FEE_BPS);

  logger.log("fee_config", {
    raydium_pool: RAYDIUM_POOL, amm_fee_bps: AMM_FEE_BPS,
    phoenix_market: PHX_MARKET, phoenix_fee_bps: PHX_FEE_BPS
  });

  logger.log("edge_paths", {
    amms: CFG.AMMS_JSONL,
    phoenix: CFG.PHOENIX_JSONL,
    min_abs_bps: CFG.EDGE_MIN_ABS_BPS,
  });

  logger.log("edge_config", {
    book_ttl_ms: CFG.BOOK_TTL_MS,
    synth_width_bps: CFG.SYNTH_WIDTH_BPS,
  });

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
    enforce_dedupe: CFG.ENFORCE_DEDUPE,
    slippage_mode: CFG.ACTIVE_SLIPPAGE_MODE,
    use_pool_impact_sim: CFG.USE_POOL_IMPACT_SIM,
    use_rpc_sim: CFG.USE_RPC_SIM,
    use_raydium_swap_sim: String(process.env.USE_RAYDIUM_SWAP_SIM ?? "false"),
    cpmm_max_pool_trade_frac: CFG.CPMM_MAX_POOL_TRADE_FRAC,
    dynamic_slippage_extra_bps: CFG.DYNAMIC_SLIPPAGE_EXTRA_BPS,
    allow_synth_trades: CFG.ALLOW_SYNTH_TRADES,
    edge_follow_poll_ms: Number(process.env.EDGE_FOLLOW_POLL_MS ?? 500),
    shadow_trading: SHADOW,
  });

  // Build rpcSimFn only if we have a real payer (LIVE, non-shadow)
  const rpcSimFn: RpcSimFn | undefined = (CFG.USE_RPC_SIM && accounts && LIVE && !SHADOW)
    ? (async (input: { path: "AMM->PHX" | "PHX->AMM"; sizeBase: number; ammMid: number; }) => {
        const baseIn = (input.path === "PHX->AMM");
        const amountInAtoms = baseIn
          ? BigInt(Math.round(input.sizeBase * 1e9))               // SOL atoms
          : BigInt(Math.round(input.sizeBase * input.ammMid * 1e6)); // USDC atoms

        const out = await simulateRaydiumSwapFixedIn(conn, {
          user: (accounts as any).owner as PublicKey,
          baseIn,
          amountInBase: amountInAtoms,
          slippageBps: 50,
        });

        if (out.mode !== "cpmm-sim-success") {
          return {
            rpc_sim_mode: out.mode,
            rpc_sim_ms: (out as any).rpc_sim_ms ?? 0,
            rpc_sim_error: (out as any).reason,
          };
        }
        // We intentionally omit rpc_eff_px / rpc_price_impact_bps here.
        return {
          rpc_sim_ms: out.rpc_sim_ms,
          rpc_sim_mode: out.mode,
          rpc_units: out.rpc_units
        };
      })
    : undefined;

  const mkShadowSig = () =>
    `shadow_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;

  // safe fallback to avoid `.toFixed` on undefined
  function fillPxForPath(
    path: "PHX->AMM" | "AMM->PHX",
    d: { rpc_eff_px?: number; buy_px: number; sell_px: number }
  ) {
    const rpc = asNumber(d.rpc_eff_px);
    const sidePx = path === "PHX->AMM" ? asNumber(d.sell_px) : asNumber(d.buy_px);
    return coalesceRound(6, rpc, sidePx);
  }

  const onDecision: DecisionHook = (wouldTrade, _edgeNetBps, _expectedPnl, d) => {
    // 🔹 ML: snapshot + decision label (only if enabled)
    if (LOG_ML && d) {
      try {
        emitEdgeSnapshot({ ...d, trade_size_base: LIVE_SIZE_BASE });
        emitDecision(Boolean(wouldTrade), wouldTrade ? "edge_above_threshold" : undefined, d, _expectedPnl);
      } catch {}
    }

    // live summary counters
    try {
      recordDecision(Boolean(wouldTrade), Number(_edgeNetBps ?? 0), Number(_expectedPnl ?? 0));
    } catch {}

    if (!wouldTrade || !d) return;

    const payload = {
      path: d.path,
      size_base: LIVE_SIZE_BASE,
      buy_px: d.buy_px,
      sell_px: d.sell_px,
      notional_quote: coalesceRound(6, LIVE_SIZE_BASE * ((d.buy_px + d.sell_px) / 2)),
      phoenix: {
        market: PHX_MARKET || CFG.PHOENIX_MARKET,
        side: d.side as "buy" | "sell",
        limit_px: d.side === "buy" ? d.buy_px : d.sell_px,
      },
    };

    if (SHADOW) {
      const submitted = {
        path: payload.path,
        size_base: payload.size_base,
        buy_px: payload.buy_px,
        sell_px: payload.sell_px,
        ix_count: 0,
        cu_limit: 0,
        tip_lamports: undefined as number | undefined,
        live: false,
        shadow: true,
      };
      logger.log("submitted_tx", submitted);
      if (LOG_ML) { try { emitSubmittedTx(submitted); } catch {} }

      const fp = fillPxForPath(payload.path as "PHX->AMM" | "AMM->PHX", {
        rpc_eff_px: d.rpc_eff_px,
        buy_px: d.buy_px,
        sell_px: d.sell_px,
      });

      const landed = {
        sig: mkShadowSig(),
        slot: null as number | null,
        conf_ms: 0,
        shadow: true,
        fill_px: fp,
        filled_base: payload.size_base,
        filled_quote: coalesceRound(6, payload.size_base * fp),
      };
      logger.log("landed", landed);
      if (LOG_ML) { try { emitLanded(landed); } catch {} }
      return;
    }

    if (LIVE && liveExec) {
      void liveExec.maybeExecute(payload as any);
    }
  };

  const onRpcSample: RpcSampleHook = (s) => {
    const ms = Number(s?.ms);
    if (Number.isFinite(ms) && ms > 0) {
      rpcSamples++;
      rpcMsP50 = ewma(rpcMsP50, ms, 0.1);
      rpcMsP95 = Math.max(rpcMsP95, ms);
      if (LOG_ML) { try { emitRpcSample(ms, Boolean(s?.blocked)); } catch {} }
    }
    if (s?.blocked) rpcBlocked++;
  };

  const joiner = new EdgeJoiner(
    {
      minAbsBps: CFG.EDGE_MIN_ABS_BPS,
      waitLogMs: CFG.EDGE_WAIT_LOG_MS,
      thresholdBps: CFG.TRADE_THRESHOLD_BPS,
      flatSlippageBps: CFG.MAX_SLIPPAGE_BPS,
      tradeSizeBase: CFG.TRADE_SIZE_BASE,
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
    },
    onDecision,
    rpcSimFn,
    onRpcSample
  );

  // Feed joiner from JSONL publishers
  const POLL_MS = Number(process.env.EDGE_FOLLOW_POLL_MS ?? 500) || 500;

  const ammsFollower = new JsonlFollower(
    CFG.AMMS_JSONL,
    (obj) => {
      const ev = (obj?.event ?? obj?.name ?? obj?.type ?? "") as string;
      if (ev === "amms_price") joiner.upsertAmms(obj);
    },
    POLL_MS
  );

  const phxFollower = new JsonlFollower(
    CFG.PHOENIX_JSONL,
    (obj) => {
      const ev = (obj?.event ?? obj?.name ?? obj?.type ?? "") as string;
      if (ev === "phoenix_mid" || ev === "phoenix_l2" || ev === "phoenix_l2_empty") {
        joiner.upsertPhoenix(obj);
      }
      // Optionally harvest RPC timing from other sources that may log it
      try {
        const ms = Number(obj?.data?.rpc_sim_ms ?? obj?.rpc_sim_ms);
        if (Number.isFinite(ms)) {
          rpcSamples++;
          rpcMsP50 = ewma(rpcMsP50, ms, 0.1);
          rpcMsP95 = Math.max(rpcMsP95, ms);
          if (LOG_ML) { try { emitRpcSample(ms, Boolean(obj?.data?.guard_blocked ?? obj?.guard_blocked)); } catch {} }
        }
        const blocked = obj?.data?.guard_blocked ?? obj?.guard_blocked;
        if (blocked === true) rpcBlocked++;
      } catch {}
    },
    POLL_MS
  );

  await Promise.all([ammsFollower.start(), phxFollower.start()]);

  // Graceful shutdown + summary
  const shutdown = (signal: string) => {
    try { ammsFollower.stop(); } catch {}
    try { phxFollower.stop(); } catch {}
    if (!wroteSummary) writeLiveSummarySync(CFG);
    logger.log("arb_shutdown", { ok: true, signal });
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("beforeExit", () => { if (!wroteSummary) writeLiveSummarySync(CFG); });
  process.on("exit", () => { if (!wroteSummary) writeLiveSummarySync(CFG); });
  process.on("uncaughtException", (e) => {
    logger.log("arb_fatal", { error: String(e) });
    if (!wroteSummary) writeLiveSummarySync(CFG);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logger.log("arb_fatal", { error: String(e) });
    if (!wroteSummary) writeLiveSummarySync(CFG);
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
  } catch {}
});
