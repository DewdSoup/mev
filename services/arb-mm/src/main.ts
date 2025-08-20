// services/arb-mm/src/main.ts
// Boot: health + JSONL followers + EdgeJoiner (CPMM/adaptive) + optional RPC sim + live summary.
// Env-only control: SHADOW_TRADING, LIVE_TRADING, USE_RPC_SIM, etc.

import fs from "fs";
import path from "path";
import { Connection } from "@solana/web3.js";

// ORIGINAL logger (restored) — keeps your runtime.jsonl + tags
import { logger } from "@mev/storage";

import { loadConfig, RPC, maskUrl, stamp } from "./config.js";
import { EdgeJoiner, type DecisionHook, type RpcSampleHook } from "./edge/joiner.js";
import { makeRpcSim } from "./rpc_sim.js";
import { setChainTps } from "./feature_sink.js";
import { initRisk } from "@mev/risk";
import { initAccounts } from "./accounts.js";
import { LiveExecutor } from "./executor/live.js";
import { initSessionRecorder } from "./session_recorder.js";

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
        tps: Number(tps.toFixed(2)),
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
      pnl_sum: Number(cumSimPnLQuote.toFixed(6)),
      best_edge_bps: Number.isFinite(bestEdgeNet) ? Number(bestEdgeNet.toFixed(4)) : 0,
      worst_edge_bps: Number.isFinite(worstEdgeNet) ? Number(worstEdgeNet.toFixed(4)) : 0,
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

  if (LIVE && !SHADOW) {
    const accounts = await initAccounts(conn);
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
    phoenix_taker_fee_bps: CFG.PHOENIX_TAKER_FEE_BPS,
    amm_taker_fee_bps: CFG.AMM_TAKER_FEE_BPS,
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

  const rpcSimFn = makeRpcSim(conn, CFG.USE_RPC_SIM);
  const mkShadowSig = () =>
    `shadow_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;

  function fillPxForPath(
    path: "PHX->AMM" | "AMM->PHX",
    d: { rpc_eff_px?: number; buy_px: number; sell_px: number }
  ) {
    if (d.rpc_eff_px && Number.isFinite(d.rpc_eff_px)) return Number(d.rpc_eff_px.toFixed(6));
    return Number((path === "PHX->AMM" ? d.sell_px : d.buy_px).toFixed(6));
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
      notional_quote: Number((LIVE_SIZE_BASE * ((d.buy_px + d.sell_px) / 2)).toFixed(6)),
      phoenix: {
        market: CFG.PHOENIX_MARKET,
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
        filled_quote: Number((payload.size_base * fp).toFixed(6)),
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
      phoenixFeeBps: CFG.PHOENIX_TAKER_FEE_BPS,
      ammFeeBps: CFG.AMM_TAKER_FEE_BPS,
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
      try {
        const ms = Number(obj?.data?.rpc_sim_ms ?? obj?.rpc_sim_ms);
        if (Number.isFinite(ms)) {
          rpcSamples++;
          rpcMsP50 = ewma(rpcMsP50, ms, 0.1);
          rpcMsP95 = Math.max(rpcMsP95, ms);
          // ML sim result from stream too
          if (LOG_ML) { emitRpcSample(ms, Boolean(obj?.data?.guard_blocked ?? obj?.guard_blocked)); }
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
    try {
      ammsFollower.stop();
    } catch {}
    try {
      phxFollower.stop();
    } catch {}
    if (!wroteSummary) writeLiveSummarySync(CFG);
    logger.log("arb_shutdown", { ok: true, signal });
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("beforeExit", () => {
    if (!wroteSummary) {
      const CFG = loadConfig();
      writeLiveSummarySync(CFG);
    }
  });
  process.on("exit", () => {
    if (!wroteSummary) {
      const CFG = loadConfig();
      writeLiveSummarySync(CFG);
    }
  });
  process.on("uncaughtException", (e) => {
    logger.log("arb_fatal", { error: String(e) });
    if (!wroteSummary) {
      const CFG = loadConfig();
      writeLiveSummarySync(CFG);
    }
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logger.log("arb_fatal", { error: String(e) });
    if (!wroteSummary) {
      const CFG = loadConfig();
      writeLiveSummarySync(CFG);
    }
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
