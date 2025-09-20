// services/arb-mm/src/multipair.ts
// Multi-pair, additive orchestrator (keeps single-pair main.ts untouched).
//
// - Loads ONLY .env.live, forces LIVE mode.
// - Spawns one joiner pipeline per PairSpec (Phoenix <-> AMM).
// - Fans out JSONL feed lines to the right pipeline by market/pool ids.
// - Executes with the same LiveExecutor payload shape you already use.
// - Runs indefinitely; Ctrl-C to stop.

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
import { roundN, coalesceRound } from "./util/num.js";
import { tryAssertRaydiumFeeBps } from "./util/raydium.js";
import { PublisherSupervisor } from "./publishers/supervisor.js";
import { prewarmPhoenix } from "./util/phoenix.js";
import { loadPairsFromEnvOrDefault, type PairSpec } from "./registry/pairs.js";
import { MarketStateProvider } from "./market/index.js";
import { rpcClient, rpc } from "@mev/rpc-facade";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────────────────────────
// Load ONLY .env.live and force LIVE mode
// ────────────────────────────────────────────────────────────────────────────
(function loadExactEnvLive() {
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const repoEnvLive = path.resolve(repoRoot, ".env.live");
    const svcEnvLive = path.resolve(__dirname, "..", "..", ".env.live");
    const chosen = fs.existsSync(repoEnvLive) ? repoEnvLive : svcEnvLive;
    if (!fs.existsSync(chosen)) {
        console.error("[env] .env.live not found; expected at", repoEnvLive, "or", svcEnvLive);
    } else {
        dotenv.config({ path: chosen, override: true });
    }
    process.env.LIVE_TRADING = "1";
    process.env.SHADOW_TRADING = "0";
    process.env.__ENV_LIVE_LOCKED = "1";
})();

const ewma = (prev: number, x: number, a = 0.1) => (!Number.isFinite(prev) || prev <= 0 ? Math.round(x) : Math.round(prev + (x - prev) * a));

// Lightweight JSONL tailer (local to this file)
type LineHandler = (obj: any) => void;
class JsonlFollower {
    private fd: number | null = null;
    private offset = 0; private buffer = "";
    private poller: NodeJS.Timeout | null = null;

    constructor(private file: string, private onLine: LineHandler, private pollMs = 500) { }
    async start() {
        await this.openAtEOF();
        this.poller = setInterval(() => this.readNewBytes(), this.pollMs);
    }
    stop() { try { if (this.poller) clearInterval(this.poller); } catch { } try { if (this.fd !== null) fs.closeSync(this.fd); } catch { } }
    private async openAtEOF() {
        const existed = fs.existsSync(this.file);
        this.fd = fs.openSync(this.file, "a+");
        const size = existed ? fs.fstatSync(this.fd).size : 0;
        this.offset = size;
        logger.log("mp.follow_open", { file: this.file, initial_size: size });
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
            logger.log("mp.follow_err", { file: this.file, err: String(e) });
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-pair pipeline
// ────────────────────────────────────────────────────────────────────────────
class PairPipeline {
    private joiner: EdgeJoiner;
    private rpcSamples = 0;
    private rpcMsP50 = 0;
    private rpcMsP95 = 0;
    private rpcBlocked = 0;
    private ammVenueByPool = new Map<string, { venue: string; poolKind?: string; feeBps?: number }>();

    constructor(
        private pair: PairSpec,
        private conn: Connection,
        private cfg: any,
        private resolveFeeBps: (kind: "AMM" | "PHOENIX", id: string | undefined, fallback: number) => number,
        private liveExec: LiveExecutor | null,
    ) {
        const enableRaydiumClmm = String(process.env.ENABLE_RAYDIUM_CLMM ?? "1").trim() !== "0";
        // Resolve fees (pair overrides -> JSON/ENV -> defaults)
        const ammFeeInit = this.resolveFeeBps("AMM", pair.ammPool, cfg.AMM_TAKER_FEE_BPS);
        const phxFeeInit = this.resolveFeeBps("PHOENIX", pair.phoenixMarket, cfg.PHOENIX_TAKER_FEE_BPS);
        // NOTE: try to assert Raydium fee from chain if flag is set; we do it async
        (async () => {
            try {
                const fixed = await tryAssertRaydiumFeeBps(this.conn, pair.ammPool, ammFeeInit);
                if (fixed !== ammFeeInit) this._ammFeeBps = fixed;
            } catch { }
        })();

        this._ammFeeBps = ammFeeInit;
        this._phxFeeBps = phxFeeInit;

        for (const venue of pair.ammVenues ?? []) {
            if (venue?.enabled === false) continue;
            if (!enableRaydiumClmm && String(venue.venue).toLowerCase() === "raydium" && String(venue.poolKind).toLowerCase() === "clmm") continue;
            const poolId = String(venue.poolId ?? "").trim();
            if (!poolId) continue;
            if (!this.ammVenueByPool.has(poolId)) {
                this.ammVenueByPool.set(poolId, {
                    venue: String(venue.venue ?? pair.adapters?.amm ?? "raydium").toLowerCase(),
                    poolKind: venue.poolKind,
                    feeBps: venue.feeBps,
                });
            }
        }
        if (!this.ammVenueByPool.has(pair.ammPool)) {
            this.ammVenueByPool.set(pair.ammPool, {
                venue: String(pair.adapters?.amm ?? "raydium").toLowerCase(),
            });
        }

        // Construct joiner with pair-scoped params
        const J = new EdgeJoiner(
            {
                minAbsBps: cfg.EDGE_MIN_ABS_BPS,
                waitLogMs: cfg.EDGE_WAIT_LOG_MS,
                thresholdBps: cfg.TRADE_THRESHOLD_BPS,
                flatSlippageBps: cfg.MAX_SLIPPAGE_BPS,
                tradeSizeBase: pair.sizing?.tradeSizeBase ?? cfg.TRADE_SIZE_BASE,
                decisionMinBase: pair.sizing?.decisionMinBase ?? cfg.DECISION_MIN_BASE,
                phoenixFeeBps: this._phxFeeBps,
                ammFeeBps: this._ammFeeBps,
                fixedTxCostQuote: pair.fees?.fixedTxCostQuote ?? cfg.FIXED_TX_COST_QUOTE,
            },
            {
                bookTtlMs: cfg.BOOK_TTL_MS,
                activeSlippageMode: cfg.ACTIVE_SLIPPAGE_MODE,
                phoenixSlippageBps: cfg.PHOENIX_SLIPPAGE_BPS,
                cpmmMaxPoolTradeFrac: pair.sizing?.cpmmMaxPoolTradeFrac ?? cfg.CPMM_MAX_POOL_TRADE_FRAC,
                dynamicSlippageExtraBps: cfg.DYNAMIC_SLIPPAGE_EXTRA_BPS,
                logSimFields: cfg.LOG_SIM_FIELDS,
                enforceDedupe: cfg.ENFORCE_DEDUPE,
                decisionBucketMs: cfg.DECISION_BUCKET_MS,
                decisionMinEdgeDeltaBps: cfg.DECISION_MIN_EDGE_DELTA_BPS,
                useRpcSim: cfg.USE_RPC_SIM,
                // also expose decisionMinBase in options for belt-and-suspenders
                decisionMinBase: pair.sizing?.decisionMinBase ?? cfg.DECISION_MIN_BASE,
            },
            this._onDecision,
            undefined, // rpcSimFn (off for now in live)
            this._onRpcSample
        );

        this.joiner = J;
    }

    private _ammFeeBps: number;
    private _phxFeeBps: number;

    // Filtered feed from AMMs publisher
    upsertAmmsIfMatch(obj: any) {
        const ev = (obj?.event ?? obj?.name ?? obj?.type ?? "") as string;
        const id = obj?.ammId ?? obj?.pool ?? obj?.id ?? obj?.pool_id;
        if (!id) return;
        const meta = this.ammVenueByPool.get(String(id));
        if (!meta) return;
        if (meta.poolKind && obj.poolKind == null && obj.pool_kind == null) {
            obj.poolKind = meta.poolKind;
        }
        if (meta.feeBps != null && obj.feeBps == null && obj.fee_bps == null) {
            obj.feeBps = meta.feeBps;
        }
        // The joiner expects canonical amms_price payloads; we forward as‑is.
        this.joiner.upsertAmms(obj);
    }

    // Filtered feed from Phoenix publisher
    upsertPhoenixIfMatch(obj: any) {
        const ev = (obj?.event ?? obj?.name ?? obj?.type ?? "") as string;
        const mkt = obj?.market ?? obj?.market_id ?? obj?.id;
        if (!mkt || String(mkt) !== this.pair.phoenixMarket) return;
        this.joiner.upsertPhoenix(obj);
    }

    private _onRpcSample: RpcSampleHook = (s) => {
        const ms = Number(s?.ms);
        if (Number.isFinite(ms) && ms > 0) {
            this.rpcSamples++;
            this.rpcMsP50 = ewma(this.rpcMsP50, ms, 0.1);
            this.rpcMsP95 = Math.max(this.rpcMsP95, ms);
        }
        if (s?.blocked) this.rpcBlocked++;
    };

    private _onDecision: DecisionHook = (wouldTrade, edgeNetBps, expectedPnl, d) => {
        if (!d) return;

        // Allowed path gate (optional)
        const ALLOWED = String(process.env.EXEC_ALLOWED_PATH ?? "both");
        if (ALLOWED !== "both" && d.path && d.path !== ALLOWED) return;

        // final EV gate already applied in joiner; we only execute when wouldTrade=true
        if (!wouldTrade) return;

        const sizeBase =
            (d.recommended_size_base && d.recommended_size_base > 0
                ? d.recommended_size_base
                : (Number(process.env.LIVE_SIZE_BASE ?? 0) || this.cfg.TRADE_SIZE_BASE));

        const notional = coalesceRound(6, sizeBase * ((d.buy_px + d.sell_px) / 2));

        const srcPoolId = d.amm_pool_id ?? this.pair.ammPool;
        const srcVenue = String(d.amm_venue ?? this.ammVenueByPool.get(srcPoolId)?.venue ?? this.pair.adapters?.amm ?? "raydium").toLowerCase();
        const srcMeta = (d as any).amm_meta ?? this.ammVenueByPool.get(srcPoolId);

        const payload: any = {
            path: d.path,
            size_base: sizeBase,
            buy_px: d.buy_px,
            sell_px: d.sell_px,
            notional_quote: notional,
            atomic: true,
            pair: this.pair.id,
            amm_venue: srcVenue,
            amm_pool_id: srcPoolId,
            amm: {
                pool: srcPoolId,
                venue: srcVenue,
                meta: srcMeta,
            },
            amm_meta: srcMeta,
        };

        if (d.path === "AMM->AMM") {
            if (d.amm_dst_pool_id) {
                const dstVenue = String(d.amm_dst_venue ?? this.ammVenueByPool.get(d.amm_dst_pool_id)?.venue ?? "raydium").toLowerCase();
                const dstMeta = (d as any).amm_dst_meta ?? this.ammVenueByPool.get(d.amm_dst_pool_id);
                payload.amm_dst = {
                    pool: d.amm_dst_pool_id,
                    venue: dstVenue,
                    meta: dstMeta,
                };
                payload.amm_dst_meta = dstMeta;
            }
        } else {
            payload.phoenix = {
                market: this.pair.phoenixMarket,
                side: d.side as "buy" | "sell",
                limit_px: d.side === "buy" ? d.buy_px : d.sell_px,
            };
        }

        // Execute (same engine, same atomic mode)
        if (this.liveExec) (this.liveExec as any)?.maybeExecute?.(payload);
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────────────────
async function main() {
    const { loadConfig, RPC, maskUrl, resolveFeeBps } = await import("./config.js");
    const CFG = loadConfig();

    const PAIRS = loadPairsFromEnvOrDefault();

    console.log(
        [
            `BOOT rpc=${maskUrl(RPC)}`,
            `LIVE_TRADING=1`,
            `SHADOW_TRADING=0`,
            `PAIRS=${PAIRS.map(p => p.id).join(", ") || "(default SOL/USDC)"}`,
            `EXEC_ALLOWED_PATH=${process.env.EXEC_ALLOWED_PATH ?? "both"}`,
            `ATOMIC_MODE=${process.env.ATOMIC_MODE ?? "single_tx"}`,
            `ENABLE_EMBEDDED_PUBLISHERS=${process.env.ENABLE_EMBEDDED_PUBLISHERS ?? "1"}`,
        ].join("  ")
    );
    logger.log("arb-multipair boot", { rpc: maskUrl(RPC), pairs: PAIRS.map(p => p.id) });

    // Embedded publishers (optional; same as single-process live)
    const sup = new PublisherSupervisor({
        enable: String(process.env.ENABLE_EMBEDDED_PUBLISHERS ?? "1") === "1",
        phoenixJsonl: CFG.PHOENIX_JSONL,
        ammsJsonl: CFG.AMMS_JSONL,
        freshnessMs: 3500,
        pollMs: 2000,
        repoRoot: path.resolve(__dirname, "..", "..", ".."),
    });
    sup.start();

    // Network + health
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
    const enableRaydiumClmm = String(process.env.ENABLE_RAYDIUM_CLMM ?? "1").trim() !== "0";
    for (const pair of PAIRS) {
        warmupKeys.add(pair.phoenixMarket);
        warmupKeys.add(pair.ammPool);
        for (const venue of pair.ammVenues ?? []) {
            if (venue?.enabled === false) continue;
            if (!enableRaydiumClmm && String(venue.venue).toLowerCase() === "raydium" && String(venue.poolKind).toLowerCase() === "clmm") continue;
            if (venue.poolId) warmupKeys.add(venue.poolId);
        }
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

    initRisk();
    (async function startHealth() {
        const sampleTps = async () => {
            try {
                const s = (await conn.getRecentPerformanceSamples(1))?.[0];
                return s && s.numTransactions && s.samplePeriodSecs ? s.numTransactions / s.samplePeriodSecs : 0;
            } catch { return 0; }
        };
        setInterval(async () => {
            try {
                const [slot, version, tps] = await Promise.all([conn.getSlot("processed"), conn.getVersion(), sampleTps()]);
                setChainTps(tps);
                logger.log("arb health", { slot, tps: roundN(tps, 2) ?? 0, version, httpHealth: { ok: true, body: "ok" } });
                console.log(`HEALTH slot=${slot} tps=${roundN(tps, 2)} version=${version["solana-core"]}`);
            } catch {
                setChainTps(undefined);
            }
        }, 3000);
    })().catch(() => { });

    // Accounts + executor (shared)
    const accounts = await initAccounts(conn);
    await initSessionRecorder(conn, (accounts as any).owner, CFG);
    const payer: Keypair = (accounts as any).owner as Keypair;
    const exec = new LiveExecutor(conn, payer);
    await (exec as any).startPhoenix?.();

    // Prewarm phoenix caches for all markets
    try { await prewarmPhoenix(conn, PAIRS.map(p => p.phoenixMarket)); } catch { }

    // Build pipelines
    const pipelines = PAIRS.map(p => new PairPipeline(p, conn, CFG, resolveFeeBps, exec));

    // Fan-out feeds to pipelines by id
    const ammsFollower = new JsonlFollower(
        CFG.AMMS_JSONL,
        (obj) => {
            for (const pipe of pipelines) pipe.upsertAmmsIfMatch(obj);
        },
        Number(process.env.EDGE_FOLLOW_POLL_MS ?? 500) || 500
    );
    const phxFollower = new JsonlFollower(
        CFG.PHOENIX_JSONL,
        (obj) => {
            for (const pipe of pipelines) pipe.upsertPhoenixIfMatch(obj);
        },
        Number(process.env.EDGE_FOLLOW_POLL_MS ?? 500) || 500
    );

    await Promise.all([ammsFollower.start(), phxFollower.start()]);

    // Run indefinitely; graceful exit
    function shutdown(signal: string) {
        (async () => {
            try { ammsFollower.stop(); } catch { }
            try { phxFollower.stop(); } catch { }
            try { sup.stop(); } catch { }
            try { await marketProvider?.stop(); } catch { }
            logger.log("arb-multipair_shutdown", { ok: true, signal });
            process.exit(0);
        })().catch(() => process.exit(0));
    }
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("uncaughtException", (e) => { logger.log("arb-multipair_fatal", { error: String(e) }); process.exit(1); });
    process.on("unhandledRejection", (e) => { logger.log("arb-multipair_fatal", { error: String(e) }); process.exit(1); });
}

main().catch((e) => {
    logger.log("arb-multipair_fatal", { error: String(e) });
    process.exit(1);
});
