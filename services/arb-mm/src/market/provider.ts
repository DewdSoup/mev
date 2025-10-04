import fs from "fs";
import path from "path";
import { Connection, PublicKey, type AccountInfo, type Context } from "@solana/web3.js";
import {
  LIQUIDITY_STATE_LAYOUT_V4,
  PoolInfoLayout,
  SqrtPriceMath,
  SPL_ACCOUNT_LAYOUT,
} from "@raydium-io/raydium-sdk";
import { WHIRLPOOL_CODER, PriceMath } from "@orca-so/whirlpools-sdk";
import BN from "bn.js";

import { rpc } from "@mev/rpc-facade";
import { logger } from "../ml_logger.js";
import { loadPairsFromEnvOrDefault, type PairSpec } from "../registry/pairs.js";
import type { PairAmmVenue } from "../registry/pairs.js";
import type {
  AmmSnapshot,
  PhoenixSnapshot,
  MarketProviderState,
  MarketStateListener,
  TrackedPoolMeta,
  MarketProviderConfig,
  PoolKind,
} from "./types.js";
import { getPhoenixClient, ensurePhoenixMarketState } from "../util/phoenix.js";

const DEFAULT_REFRESH_MS = Number(process.env.MARKET_PROVIDER_REFRESH_MS ?? 600);
const DEFAULT_REFRESH_DEBOUNCE_MS = Number(
  process.env.AMM_REFRESH_DEBOUNCE_MS ??
  process.env.MARKET_PROVIDER_REFRESH_DEBOUNCE_MS ??
  150
);
const DEFAULT_AMM_BATCH_MAX = Number(process.env.AMM_BATCH_MAX_ACCOUNTS ?? 64);
const DEFAULT_PHOENIX_REFRESH_MS = Number(process.env.MARKET_PROVIDER_PHOENIX_REFRESH_MS ?? 1_000);
const DEFAULT_STALE_MS = Number(process.env.MARKET_PROVIDER_STALE_MS ?? 6_000);
const DEFAULT_SNAPSHOT_TTL_MS = Number(process.env.AMM_SNAPSHOT_TTL_MS ?? DEFAULT_STALE_MS ?? 6_000);
const DEFAULT_PHOENIX_DEPTH = Number(process.env.MARKET_PROVIDER_PHOENIX_DEPTH ?? 3);
const DEFAULT_TELEMETRY_MS = Number(process.env.MARKET_PROVIDER_TELEMETRY_MS ?? 15_000);

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

type AccountChangeHandler = (info: AccountInfo<Buffer>, slot: number | null) => void;

type PoolWatcherState = {
  meta: TrackedPoolMeta;
  stateSubId?: number;
  baseVaultSubId?: number;
  quoteVaultSubId?: number;
  baseVault?: string;
  quoteVault?: string;
};

class JsonlWriter {
  private stream: fs.WriteStream | null = null;
  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
    this.stream = fs.createWriteStream(filePath, {
      flags: "a",
      encoding: "utf8",
      mode: 0o644,
    });
  }
  write(event: string, data: unknown) {
    if (!this.stream) return;
    try {
      this.stream.write(JSON.stringify({ t: new Date().toISOString(), event, data }) + "\n");
    } catch (err) {
      logger.log("market_provider_writer_error", { event, err: String((err as any)?.message ?? err) });
    }
  }
  close() {
    try { this.stream?.end(); } catch { /* noop */ }
    this.stream = null;
  }
}

class TextWriter {
  private stream: fs.WriteStream | null = null;
  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
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
      logger.log("market_provider_text_writer_error", { err: String((err as any)?.message ?? err) });
    }
  }
  close() {
    try { this.stream?.end(); } catch { /* noop */ }
    this.stream = null;
  }
}

export class MarketStateProvider {
  private readonly conn: Connection;
  private readonly pairs: PairSpec[];
  private readonly config: Required<MarketProviderConfig>;

  private readonly listeners = new Map<number, MarketStateListener>();
  private listenerSeq = 0;

  // Phoenix SDK lacks robust type exports; treat the client as `any`.
  private phoenixClient: any = null;

  private readonly amms = new Map<string, AmmSnapshot>();
  private readonly phoenixSnapshots = new Map<string, PhoenixSnapshot>();
  private readonly trackedPools: TrackedPoolMeta[] = [];
  private readonly trackedMarkets: { market: string; symbol: string }[] = [];

  private readonly poolWatchers = new Map<string, PoolWatcherState>();
  private readonly phoenixSubs = new Map<string, number>();
  private readonly accountSubs = new Map<number, string>();
  private readonly phoenixInflight = new Map<string, Promise<void>>();

  private readonly snapshotLogBps: number;
  private readonly snapshotLogHeartbeatMs: number;
  private readonly snapshotLogLastTs = new Map<string, number>();
  private readonly phoenixLogLastTs = new Map<string, number>();
  private readonly refreshLogCooldownMs: number;
  private lastRefreshLogTs = 0;
  private readonly phoenixLogCooldownMs: number;
  private lastPhoenixLogTs = 0;

  private emitScheduled = false;

  private ammBackoffUntil = 0;
  private phoenixBackoffUntil = 0;

  private slotSubId: number | null = null;
  private ammDebounceTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private pendingSlot: number | null = null;
  private lastSlotSeen: number | null = null;
  private refreshStats: { lastDurationMs: number; rateLimited: number; errors: number; batches: number } = {
    lastDurationMs: 0,
    rateLimited: 0,
    errors: 0,
    batches: 0,
  };
  private readonly ammDegradedReasons = new Map<string, string>();
  private telemetryTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null; // retained for backwards compat (legacy callers)
  private phoenixTimer: NodeJS.Timeout | null = null;

  private ammsWriter: JsonlWriter | null = null;
  private ammsTextWriter: TextWriter | null = null;
  private phoenixWriter: JsonlWriter | null = null;

  private started = false;
  private stopping = false;

  constructor(conn: Connection, pairs?: PairSpec[], cfg?: MarketProviderConfig) {
    this.conn = conn;
    this.pairs = pairs ?? loadPairsFromEnvOrDefault();
    this.config = {
      refreshMs: cfg?.refreshMs ?? DEFAULT_REFRESH_MS,
      refreshDebounceMs: cfg?.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS,
      batchMax: cfg?.batchMax ?? DEFAULT_AMM_BATCH_MAX,
      snapshotTtlMs: cfg?.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
      phoenixRefreshMs: cfg?.phoenixRefreshMs ?? DEFAULT_PHOENIX_REFRESH_MS,
      staleMs: cfg?.staleMs ?? DEFAULT_STALE_MS,
      telemetryMs: cfg?.telemetryMs ?? DEFAULT_TELEMETRY_MS,
      phoenixDepthLevels: cfg?.phoenixDepthLevels ?? DEFAULT_PHOENIX_DEPTH,
    } as Required<MarketProviderConfig>;
    this.trackedPools = this.collectPools();
    this.trackedMarkets = this.collectMarkets();

    const logBpsRaw = Number(process.env.MARKET_PROVIDER_SNAPSHOT_LOG_BPS ?? 0.5);
    this.snapshotLogBps = Number.isFinite(logBpsRaw) && logBpsRaw >= 0 ? logBpsRaw : 0.5;

    const heartbeatRaw = Number(process.env.MARKET_PROVIDER_SNAPSHOT_LOG_HEARTBEAT_MS ?? 15_000);
    this.snapshotLogHeartbeatMs = Number.isFinite(heartbeatRaw) && heartbeatRaw >= 0 ? heartbeatRaw : 15_000;

    const refreshCooldownRaw = Number(process.env.MARKET_PROVIDER_REFRESH_LOG_COOLDOWN_MS ?? this.config.refreshMs);
    this.refreshLogCooldownMs = Number.isFinite(refreshCooldownRaw) && refreshCooldownRaw >= 0 ? refreshCooldownRaw : this.config.refreshMs;

    const phoenixCooldownRaw = Number(process.env.MARKET_PROVIDER_PHOENIX_LOG_COOLDOWN_MS ?? this.config.phoenixRefreshMs);
    this.phoenixLogCooldownMs = Number.isFinite(phoenixCooldownRaw) && phoenixCooldownRaw >= 0 ? phoenixCooldownRaw : this.config.phoenixRefreshMs;
  }

  getTrackedPools(): TrackedPoolMeta[] {
    return [...this.trackedPools];
  }

  getPhoenixMarkets(): { market: string; symbol: string }[] {
    return [...this.trackedMarkets];
  }

  getSnapshot(): MarketProviderState {
    return this.buildState();
  }

  subscribe(listener: MarketStateListener): () => void {
    const id = ++this.listenerSeq;
    this.listeners.set(id, listener);
    try {
      listener(this.buildState());
    } catch (err) {
      logger.log("market_provider_listener_error", { err: String((err as any)?.message ?? err) });
    }
    return () => this.listeners.delete(id);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      const poolDetails = this.trackedPools.map((pool) => ({
        pool: pool.poolId,
        venue: pool.venue,
        pool_kind: pool.poolKind,
        fee_hint: Number.isFinite(pool.feeHint) ? pool.feeHint : undefined,
      }));
      const marketDetails = this.trackedMarkets.map((m) => ({ market: m.market, symbol: m.symbol }));
      logger.log("market_provider_tracking", {
        pools_tracked: poolDetails.length,
        markets_tracked: marketDetails.length,
        refresh_ms: this.config.refreshMs,
        phoenix_refresh_ms: this.config.phoenixRefreshMs,
        snapshot_ttl_ms: this.config.snapshotTtlMs,
        pools: poolDetails,
        markets: marketDetails,
      });
    } catch {
      /* logging best-effort */
    }

    this.ammsWriter = new JsonlWriter(resolveAmmsPath());
    this.ammsTextWriter = new TextWriter(resolveAmmsTextPath());
    this.phoenixWriter = new JsonlWriter(resolvePhoenixPath());

    await this.warmupAccounts();
    await this.refreshAmms(true, null, "warm_start");
    await this.refreshPhoenix(true);

    this.setupSubscriptions();
    this.startSlotListener();

    if (this.config.telemetryMs > 0) {
      this.telemetryTimer = setInterval(() => {
        if (this.stopping) return;
        this.emitTelemetry();
      }, this.config.telemetryMs);
      if (typeof this.telemetryTimer?.unref === "function") this.telemetryTimer.unref();
    }

    this.phoenixTimer = setInterval(() => {
      if (this.stopping) return;
      void this.refreshPhoenix();
    }, this.config.phoenixRefreshMs);
    // optional: allow process to exit cleanly if nothing else is pending
    if (typeof this.phoenixTimer?.unref === "function") this.phoenixTimer.unref();
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;

    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.phoenixTimer) clearInterval(this.phoenixTimer);
    if (this.ammDebounceTimer) clearTimeout(this.ammDebounceTimer);
    this.refreshTimer = null;
    this.phoenixTimer = null;
    this.ammDebounceTimer = null;

    // NEW: clean up the slot-change subscription
    if (this.slotSubId != null) {
      try { await this.conn.removeSlotChangeListener(this.slotSubId); } catch { /* noop */ }
      this.slotSubId = null;
    }

    const subs = Array.from(this.accountSubs.keys());
    await Promise.all(
      subs.map(async (id) => {
        try {
          await this.conn.removeAccountChangeListener(id);
        } catch (err) {
          logger.log("market_provider_ws_remove_error", { id, err: String((err as any)?.message ?? err) });
        }
      })
    );
    this.accountSubs.clear();
    this.poolWatchers.clear();
    this.phoenixSubs.clear();
    this.phoenixInflight.clear();

    try {
      await this.phoenixClient?.disconnect();
    } catch { /* noop */ }
    this.phoenixClient = null;

    this.ammsWriter?.close();
    this.ammsTextWriter?.close();
    this.ammsTextWriter = null;
    this.phoenixWriter?.close();

    this.started = false;
    this.stopping = false;
  }

  private collectPools(): TrackedPoolMeta[] {
    const enableRaydiumClmm = String(process.env.ENABLE_AMM_RAYDIUM_CLMM ?? process.env.ENABLE_RAYDIUM_CLMM ?? "1").trim() !== "0";
    const enableOrcaClmm = String(process.env.ENABLE_AMM_ORCA ?? "0").trim() === "1";
    const seen = new Set<string>();
    const out: TrackedPoolMeta[] = [];

    const push = (venue: PairAmmVenue) => {
      const rawPool = (venue.poolId ?? "").trim();
      if (!rawPool) return;
      if ((venue as any).enabled === false) return;

      const venueName = String(((venue as any).kind ?? venue.venue ?? "")).toLowerCase();
      if (venueName !== "raydium" && venueName !== "orca") return;

      const poolKind = String((venue.poolKind ?? "")).toLowerCase();
      if (poolKind === "clmm") {
        if (venueName === "raydium" && !enableRaydiumClmm) return;
        if (venueName === "orca" && !enableOrcaClmm) return;
      }
      if (poolKind !== "cpmm" && poolKind !== "clmm") return;

      const key = `${venueName}:${rawPool}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        poolId: rawPool,
        venue: venueName as "raydium" | "orca",
        poolKind: poolKind as PoolKind,
        feeHint: typeof venue.feeBps === "number" ? venue.feeBps : undefined,
      });
    };

    for (const pair of this.pairs) {
      for (const venue of pair.ammVenues ?? []) push(venue);
    }

    return out;
  }

  private collectMarkets(): { market: string; symbol: string }[] {
    const seen = new Set<string>();
    const out: { market: string; symbol: string }[] = [];
    for (const pair of this.pairs) {
      const market = (pair.phoenixMarket ?? "").trim();
      if (!market) continue;
      if (seen.has(market)) continue;
      seen.add(market);
      const symbol = (pair as any).symbol ?? pair.id ?? "";
      out.push({ market, symbol });
    }
    return out;
  }

  private setupSubscriptions(): void {
    for (const pool of this.trackedPools) this.ensurePoolSubscriptions(pool);
    for (const { market, symbol } of this.trackedMarkets) this.ensurePhoenixSubscription(market, symbol);
  }

  private ensurePoolSubscriptions(pool: TrackedPoolMeta): void {
    let state = this.poolWatchers.get(pool.poolId);
    if (!state) {
      state = { meta: pool };
      this.poolWatchers.set(pool.poolId, state);
    }

    if (!state.stateSubId) {
      const pk = new PublicKey(pool.poolId);
      state.stateSubId = this.addAccountSub(`pool:${pool.poolId}`, pk, (info, slot) => {
        this.handlePoolAccountUpdate(pool, info, slot);
      });
    }

    const snap = this.amms.get(pool.poolId);
    if (snap) this.ensurePoolVaultSubscriptions(state, snap);
  }

  private ensurePoolVaultSubscriptions(state: PoolWatcherState, snap: AmmSnapshot): void {
    const poolId = state.meta.poolId;

    const baseVault = snap.baseVault ?? null;
    if (baseVault && baseVault !== state.baseVault) {
      void this.removeAccountSub(state.baseVaultSubId);
      state.baseVault = baseVault;
      state.baseVaultSubId = this.addAccountSub(`vault:${poolId}:base`, new PublicKey(baseVault), (info, slot) => {
        this.handleVaultAccount(state.meta, "base", info, slot);
      });
    } else if (!baseVault && state.baseVaultSubId) {
      void this.removeAccountSub(state.baseVaultSubId);
      state.baseVaultSubId = undefined;
      state.baseVault = undefined;
    }

    const quoteVault = snap.quoteVault ?? null;
    if (quoteVault && quoteVault !== state.quoteVault) {
      void this.removeAccountSub(state.quoteVaultSubId);
      state.quoteVault = quoteVault;
      state.quoteVaultSubId = this.addAccountSub(`vault:${poolId}:quote`, new PublicKey(quoteVault), (info, slot) => {
        this.handleVaultAccount(state.meta, "quote", info, slot);
      });
    } else if (!quoteVault && state.quoteVaultSubId) {
      void this.removeAccountSub(state.quoteVaultSubId);
      state.quoteVaultSubId = undefined;
      state.quoteVault = undefined;
    }
  }

  private handleVaultAccount(
    pool: TrackedPoolMeta,
    which: "base" | "quote",
    info: AccountInfo<Buffer>,
    slot: number | null
  ): void {
    if (pool.poolKind === "cpmm") {
      this.handleRaydiumCpmmVault(pool, which, info, slot);
      return;
    }
    if (pool.poolKind === "clmm") {
      this.handleClmmVault(pool, which, info, slot);
    }
  }

  private ensurePhoenixSubscription(market: string, symbol: string): void {
    if (this.phoenixSubs.has(market)) return;
    const pk = new PublicKey(market);
    const subId = this.addAccountSub(`phoenix:${market}`, pk, (_info, slot) => {
      void this.refreshPhoenixMarket(market, symbol, slot);
    });
    this.phoenixSubs.set(market, subId);
  }

  private addAccountSub(label: string, pubkey: PublicKey, handler: AccountChangeHandler): number {
    const id = this.conn.onAccountChange(
      pubkey,
      (accountInfo: AccountInfo<Buffer>, ctx: Context) => {
        const slot = typeof ctx?.slot === "number" ? ctx.slot : null;
        try {
          handler(accountInfo, slot);
        } catch (err) {
          logger.log("market_provider_ws_handler_error", { label, err: String((err as any)?.message ?? err) });
        }
      },
      "confirmed"
    );
    this.accountSubs.set(id, label);
    return id;
  }

  private async removeAccountSub(id?: number): Promise<void> {
    if (!id) return;
    if (!this.accountSubs.has(id)) return;
    this.accountSubs.delete(id);
    try {
      await this.conn.removeAccountChangeListener(id);
    } catch (err) {
      logger.log("market_provider_ws_remove_error", { id, err: String((err as any)?.message ?? err) });
    }
  }

  private requestEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      this.emitState();
    });
  }

  private commitAmmSnapshot(pool: TrackedPoolMeta, snap: AmmSnapshot, slot: number | null): void {
    const prev = this.amms.get(pool.poolId);
    const now = Date.now();
    snap.lastUpdateTs = now;
    snap.slot = slot ?? snap.slot ?? null;
    snap.degraded = false;
    snap.degradedReason = null;
    snap.ageMs = 0;
    const ttl = this.config.snapshotTtlMs;
    snap.stale = ttl ? (Date.now() - (snap.lastUpdateTs ?? 0) > ttl) : false;

    this.clearAmmDegraded(pool.poolId);
    this.amms.set(pool.poolId, snap);
    this.ammsWriter?.write("amms_price", serializeAmmSnapshot(snap));
    try {
      const slotStr = snap.slot != null ? ` slot=${snap.slot}` : "";
      const feeStr = snap.feeBps != null ? ` fee_bps=${snap.feeBps}` : "";
      const priceStr = snap.price != null ? `${snap.price}` : "NaN";
      this.ammsTextWriter?.write(
        `${new Date(now).toISOString()} venue=${snap.venue} pool=${pool.poolId} price=${priceStr}${slotStr}${feeStr}`
      );
    } catch {
      /* best-effort */
    }
    this.logAmmSnapshotChange(pool, prev ?? null, snap);
    this.requestEmit();
  }

  private logAmmSnapshotChange(pool: TrackedPoolMeta, prev: AmmSnapshot | null, snap: AmmSnapshot): void {
    const poolId = pool.poolId;
    const now = Date.now();
    const lastLogged = this.snapshotLogLastTs.get(poolId) ?? 0;
    const heartbeatDue = this.snapshotLogHeartbeatMs > 0 && now - lastLogged >= this.snapshotLogHeartbeatMs;

    const reasons: string[] = [];
    if (!prev) reasons.push("initial");

    const prevSlot = prev?.slot ?? null;
    if (snap.slot != null && snap.slot !== prevSlot) reasons.push("slot");

    if (snap.feeBps != null && snap.feeBps !== (prev?.feeBps ?? null)) reasons.push("fee");

    let priceDeltaBps: number | null = null;
    if (
      prev?.price != null && prev.price > 0 &&
      snap.price != null && snap.price > 0
    ) {
      priceDeltaBps = Math.abs((snap.price / prev.price) - 1) * 10_000;
      if (priceDeltaBps >= this.snapshotLogBps) {
        reasons.push(`price_${priceDeltaBps.toFixed(3)}bps`);
      }
    } else if (prev && prev?.price !== snap.price) {
      reasons.push("price_change");
    }

    const prevTs = prev?.lastUpdateTs ?? 0;
    if (!prev && !reasons.length) reasons.push("initial");
    if (prevTs && now - prevTs > this.snapshotLogHeartbeatMs * 2 && !reasons.length) {
      reasons.push("resync");
    }
    if (heartbeatDue && !reasons.length) reasons.push("heartbeat");

    if (!reasons.length) return;

    this.snapshotLogLastTs.set(poolId, now);

    const payload: Record<string, unknown> = {
      pool: poolId,
      venue: snap.venue,
      pool_kind: snap.poolKind,
      slot: snap.slot ?? null,
      reasons,
    };

    if (snap.feeBps != null && Number.isFinite(snap.feeBps)) payload.fee_bps = snap.feeBps;
    if (snap.price != null && Number.isFinite(snap.price)) payload.price = snap.price;
    if (priceDeltaBps != null && Number.isFinite(priceDeltaBps)) {
      payload.price_delta_bps = Number(priceDeltaBps.toFixed(4));
    }

    const slotLag = this.lastSlotSeen != null && snap.slot != null
      ? this.lastSlotSeen - snap.slot
      : null;
    if (slotLag != null && Number.isFinite(slotLag)) payload.slot_lag = slotLag;

    const baseReserve = typeof snap.baseReserve === "number" && Number.isFinite(snap.baseReserve)
      ? snap.baseReserve
      : typeof snap.baseReserveUi === "number" && Number.isFinite(snap.baseReserveUi)
        ? snap.baseReserveUi
        : undefined;
    if (baseReserve !== undefined) payload.base_reserve = baseReserve;

    const quoteReserve = typeof snap.quoteReserve === "number" && Number.isFinite(snap.quoteReserve)
      ? snap.quoteReserve
      : typeof snap.quoteReserveUi === "number" && Number.isFinite(snap.quoteReserveUi)
        ? snap.quoteReserveUi
        : undefined;
    if (quoteReserve !== undefined) payload.quote_reserve = quoteReserve;

    logger.log("market_provider_snapshot", payload);
  }

  private logPhoenixSnapshotChange(prev: PhoenixSnapshot | null, snap: PhoenixSnapshot): void {
    const market = snap.market;
    const now = Date.now();
    const lastLogged = this.phoenixLogLastTs.get(market) ?? 0;
    const heartbeatDue = this.snapshotLogHeartbeatMs > 0 && now - lastLogged >= this.snapshotLogHeartbeatMs;

    const reasons: string[] = [];
    if (!prev) reasons.push("initial");

    const deltas: Record<string, number> = {};

    if (
      prev?.bestBid != null && prev.bestBid > 0 &&
      snap.bestBid != null && snap.bestBid > 0
    ) {
      const delta = Math.abs((snap.bestBid / prev.bestBid) - 1) * 10_000;
      if (delta >= this.snapshotLogBps) {
        reasons.push(`bid_${delta.toFixed(3)}bps`);
        deltas.bid_delta_bps = Number(delta.toFixed(4));
      }
    } else if (prev && prev?.bestBid !== snap.bestBid) {
      reasons.push("bid_change");
    }

    if (
      prev?.bestAsk != null && prev.bestAsk > 0 &&
      snap.bestAsk != null && snap.bestAsk > 0
    ) {
      const delta = Math.abs((snap.bestAsk / prev.bestAsk) - 1) * 10_000;
      if (delta >= this.snapshotLogBps) {
        reasons.push(`ask_${delta.toFixed(3)}bps`);
        deltas.ask_delta_bps = Number(delta.toFixed(4));
      }
    } else if (prev && prev?.bestAsk !== snap.bestAsk) {
      reasons.push("ask_change");
    }

    if (
      prev?.mid != null && prev.mid > 0 &&
      snap.mid != null && snap.mid > 0
    ) {
      const delta = Math.abs((snap.mid / prev.mid) - 1) * 10_000;
      if (delta >= this.snapshotLogBps) {
        reasons.push(`mid_${delta.toFixed(3)}bps`);
        deltas.mid_delta_bps = Number(delta.toFixed(4));
      }
    } else if (prev && prev?.mid !== snap.mid) {
      reasons.push("mid_change");
    }

    if (heartbeatDue && !reasons.length) reasons.push("heartbeat");
    if (!reasons.length) return;

    this.phoenixLogLastTs.set(market, now);

    const payload: Record<string, unknown> = {
      market,
      symbol: snap.symbol,
      slot: snap.slot ?? null,
      reasons,
    };

    if (snap.bestBid != null && Number.isFinite(snap.bestBid)) payload.best_bid = snap.bestBid;
    if (snap.bestAsk != null && Number.isFinite(snap.bestAsk)) payload.best_ask = snap.bestAsk;
    if (snap.mid != null && Number.isFinite(snap.mid)) payload.mid = snap.mid;

    if (snap.levelsBids?.[0]?.qty != null && Number.isFinite(snap.levelsBids[0].qty)) {
      payload.best_bid_qty = snap.levelsBids[0].qty;
    }
    if (snap.levelsAsks?.[0]?.qty != null && Number.isFinite(snap.levelsAsks[0].qty)) {
      payload.best_ask_qty = snap.levelsAsks[0].qty;
    }

    Object.assign(payload, deltas);

    logger.log("market_provider_phoenix_snapshot", payload);
  }

  private setAmmDegraded(poolId: string, reason: string): void {
    this.ammDegradedReasons.set(poolId, reason);
  }

  private clearAmmDegraded(poolId: string): void {
    if (this.ammDegradedReasons.has(poolId)) {
      this.ammDegradedReasons.delete(poolId);
    }
  }

  private startSlotListener(): void {
    if (this.slotSubId != null) return;
    try {
      this.slotSubId = this.conn.onSlotChange((slotUpdate) => {
        if (this.stopping) return;
        const slot = typeof slotUpdate?.slot === "number" ? slotUpdate.slot : null;
        this.lastSlotSeen = slot ?? this.lastSlotSeen;
        const type = String((slotUpdate as any)?.type ?? "");
        this.scheduleAmmRefresh(slot, type || "slot");
        // If the last applied slot is far behind, flag degraded to allow a single HTTP backfill
        if (slot != null) {
          for (const [poolId, snap] of this.amms) {
            const lagOk = Number(process.env.AMM_SLOT_MAX_LAG ?? 8);
            if (snap.slot != null && slot - snap.slot > lagOk) {
              this.setAmmDegraded(poolId, "slot_gap");
            }
          }
        }
      });
    } catch (err) {
      logger.log("market_provider_slot_sub_error", { err: String((err as any)?.message ?? err) });
      this.slotSubId = null;
    }
  }

  private scheduleAmmRefresh(slot: number | null, reason: string): void {
    this.pendingSlot = slot ?? this.pendingSlot ?? null;
    if (this.refreshInFlight) return;
    if (this.ammDebounceTimer) return;
    this.ammDebounceTimer = setTimeout(() => {
      this.ammDebounceTimer = null;
      const targetSlot = this.pendingSlot;
      this.pendingSlot = null;
      // WS-first: only hit HTTP batch if we are degraded or missing pools
      const needHttp =
        Array.from(this.ammDegradedReasons.values()).length > 0 ||
        this.amms.size === 0;

      void this.refreshAmms(needHttp /*force*/, targetSlot, reason);
    }, this.config.refreshDebounceMs);
    if (typeof this.ammDebounceTimer?.unref === "function") this.ammDebounceTimer.unref();
  }

  private async fetchAccountsChunked(keys: PublicKey[], label: string): Promise<Map<string, AccountInfo<Buffer> | null>> {
    const out = new Map<string, AccountInfo<Buffer> | null>();
    if (!keys.length) return out;
    for (let i = 0; i < keys.length; i += this.config.batchMax) {
      const slice = keys.slice(i, i + this.config.batchMax);
      try {
        const infos = await this.conn.getMultipleAccountsInfo(slice, { commitment: "confirmed" });

        this.refreshStats.batches += 1;
        for (let j = 0; j < slice.length; j += 1) {
          const key = slice[j];
          out.set(key.toBase58(), infos?.[j] ?? null);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String((err as any)?.message ?? err));
        (error as any).batchLabel = label;
        throw error;
      }
    }
    return out;
  }

  private handlePoolAccountUpdate(pool: TrackedPoolMeta, info: AccountInfo<Buffer>, slot: number | null): void {
    if (!info?.data) return;
    try {
      if (pool.venue === "raydium" && pool.poolKind === "cpmm") {
        this.handleRaydiumCpmmState(pool, info, slot);
        return;
      }
      if (pool.venue === "raydium" && pool.poolKind === "clmm") {
        this.handleRaydiumClmmState(pool, info, slot);
        return;
      }
      if (pool.venue === "orca" && pool.poolKind === "clmm") {
        this.handleOrcaClmmState(pool, info, slot);
      }
    } catch (err) {
      logger.log("market_provider_pool_ws_error", {
        pool: pool.poolId,
        venue: pool.venue,
        kind: pool.poolKind,
        err: String((err as any)?.message ?? err),
      });
    }
  }

  private handleRaydiumCpmmState(pool: TrackedPoolMeta, info: AccountInfo<Buffer>, slot: number | null): void {
    const state: any = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);
    const baseVault = new PublicKey(state.baseVault).toBase58();
    const quoteVault = new PublicKey(state.quoteVault).toBase58();
    const baseDecimals = Number(state.coinDecimals ?? 9);
    const quoteDecimals = Number(state.pcDecimals ?? 6);

    const prev = this.amms.get(pool.poolId);
    let feeBps = pool.feeHint ?? prev?.feeBps ?? null;
    if (feeBps == null) {
      const num = Number(state.tradeFeeNumerator ?? state.swapFeeNumerator ?? 0);
      const den = Number(state.tradeFeeDenominator ?? state.swapFeeDenominator ?? 0);
      if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
        feeBps = (num / den) * 10_000;
      }
    }

    const baseReserve = prev?.baseReserve ?? null;
    const quoteReserve = prev?.quoteReserve ?? null;
    const price = baseReserve != null && quoteReserve != null && baseReserve > 0
      ? quoteReserve / baseReserve
      : prev?.price ?? null;

    const snap: AmmSnapshot = {
      poolId: pool.poolId,
      venue: pool.venue,
      poolKind: pool.poolKind,
      price,
      feeBps,
      baseDecimals,
      quoteDecimals,
      baseVault,
      quoteVault,
      baseReserve,
      quoteReserve,
      lastUpdateTs: Date.now(),
      slot: slot ?? prev?.slot ?? null,
      stale: false,
    };
    this.commitAmmSnapshot(pool, snap, slot ?? prev?.slot ?? null);
    const watcher = this.poolWatchers.get(pool.poolId);
    if (watcher) this.ensurePoolVaultSubscriptions(watcher, snap);
  }

  private handleRaydiumCpmmVault(
    pool: TrackedPoolMeta,
    which: "base" | "quote",
    info: AccountInfo<Buffer>,
    slot: number | null,
  ): void {
    const snap = this.amms.get(pool.poolId);
    if (!snap) return;
    const decoded: any = SPL_ACCOUNT_LAYOUT.decode(info.data);
    const amount = new BN(decoded.amount.toString());
    const decimals = which === "base" ? snap.baseDecimals : snap.quoteDecimals;
    const reserve = amount.toNumber() / 10 ** decimals;
    const atomsStr = amount.toString();

    const next: AmmSnapshot = {
      ...snap,
      lastUpdateTs: Date.now(),
      slot: slot ?? snap.slot ?? null,
      stale: false,
    };
    if (which === "base") {
      next.baseReserve = reserve;
      next.baseReserveUi = reserve;
      next.baseReserveAtoms = atomsStr;
    } else {
      next.quoteReserve = reserve;
      next.quoteReserveUi = reserve;
      next.quoteReserveAtoms = atomsStr;
    }

    this.commitAmmSnapshot(pool, next, slot ?? snap.slot ?? null);
  }

  private handleClmmVault(
    pool: TrackedPoolMeta,
    which: "base" | "quote",
    info: AccountInfo<Buffer>,
    slot: number | null,
  ): void {
    const snap = this.amms.get(pool.poolId);
    if (!snap) return;
    const decoded: any = SPL_ACCOUNT_LAYOUT.decode(info.data);
    const amount = new BN(decoded.amount.toString());
    const atomsStr = amount.toString();
    const decimals = which === "base" ? snap.baseDecimals : snap.quoteDecimals;
    const reserve = amount.toNumber() / 10 ** decimals;

    const next: AmmSnapshot = {
      ...snap,
      lastUpdateTs: Date.now(),
      slot: slot ?? snap.slot ?? null,
      stale: false,
    };

    if (which === "base") {
      next.baseReserve = reserve;
      next.baseReserveUi = reserve;
      next.baseReserveAtoms = atomsStr;
    } else {
      next.quoteReserve = reserve;
      next.quoteReserveUi = reserve;
      next.quoteReserveAtoms = atomsStr;
    }

    this.commitAmmSnapshot(pool, next, slot ?? snap.slot ?? null);
  }

  private handleRaydiumClmmState(pool: TrackedPoolMeta, info: AccountInfo<Buffer>, slot: number | null): void {
    const state: any = PoolInfoLayout.decode(info.data);
    const mintA = new PublicKey(state.mintA.mint);
    const mintB = new PublicKey(state.mintB.mint);
    const decimalsA = Number(state.mintA.decimals ?? 0);
    const decimalsB = Number(state.mintB.decimals ?? 0);

    const prev = this.amms.get(pool.poolId);

    const baseMint = this.findBaseMint(pool.poolId) ?? mintA;
    const baseIsA = baseMint.equals(mintA);
    const baseDecimals = baseIsA ? decimalsA : decimalsB;
    const quoteDecimals = baseIsA ? decimalsB : decimalsA;

    const vaultA = new PublicKey(state.vaultA).toBase58();
    const vaultB = new PublicKey(state.vaultB).toBase58();
    const baseVault = baseIsA ? vaultA : vaultB;
    const quoteVault = baseIsA ? vaultB : vaultA;

    const sqrtPrice = new BN(state.sqrtPriceX64.toString());
    const priceAB = SqrtPriceMath.sqrtPriceX64ToPrice(sqrtPrice, decimalsA, decimalsB).toNumber();
    const priceBA = priceAB > 0 ? 1 / priceAB : null;
    let price = baseIsA ? priceBA ?? priceAB : priceAB;
    if (price != null && price < 1 && priceBA && priceAB) {
      price = Math.max(priceAB, priceBA);
    }

    const feeBps = pool.feeHint ?? prev?.feeBps ?? (Number.isFinite(state.tradeFeeRate) ? Number(state.tradeFeeRate) * 10_000 : null);
    const snap: AmmSnapshot = {
      poolId: pool.poolId,
      venue: pool.venue,
      poolKind: pool.poolKind,
      price,
      feeBps,
      baseDecimals,
      quoteDecimals,
      baseVault,
      quoteVault,
      baseReserve: prev?.baseReserve ?? null,
      quoteReserve: prev?.quoteReserve ?? null,
      lastUpdateTs: Date.now(),
      slot: slot ?? prev?.slot ?? null,
      stale: false,
    };

    this.commitAmmSnapshot(pool, snap, slot ?? prev?.slot ?? null);
    const watcher = this.poolWatchers.get(pool.poolId);
    if (watcher) this.ensurePoolVaultSubscriptions(watcher, snap);
  }

  private handleOrcaClmmState(pool: TrackedPoolMeta, info: AccountInfo<Buffer>, slot: number | null): void {
    const whirlpool = WHIRLPOOL_CODER.decode("Whirlpool", info.data) as any;

    const mintA = new PublicKey(whirlpool.tokenMintA);
    const mintB = new PublicKey(whirlpool.tokenMintB);

    const prev = this.amms.get(pool.poolId);

    const decimalsA = Number(whirlpool.tokenMintDecimalsA ?? 9);
    const decimalsB = Number(whirlpool.tokenMintDecimalsB ?? 6);

    const baseMint = this.findBaseMint(pool.poolId) ?? mintA;
    const baseIsA = baseMint.equals(mintA);
    const baseDecimals = baseIsA ? decimalsA : decimalsB;
    const quoteDecimals = baseIsA ? decimalsB : decimalsA;
    const vaultA = new PublicKey(whirlpool.tokenVaultA).toBase58();
    const vaultB = new PublicKey(whirlpool.tokenVaultB).toBase58();
    const baseVault = baseIsA ? vaultA : vaultB;
    const quoteVault = baseIsA ? vaultB : vaultA;

    const priceAB = PriceMath.sqrtPriceX64ToPrice(
      whirlpool.sqrtPrice,
      decimalsA,
      decimalsB
    ).toNumber();
    const priceBA = priceAB > 0 ? 1 / priceAB : null;
    let price = baseIsA ? priceBA ?? priceAB : priceAB;
    if (price != null && price < 1 && priceBA && priceAB) {
      price = Math.max(priceAB, priceBA);
    }

    const feeBps = pool.feeHint ?? prev?.feeBps ?? (Number.isFinite(whirlpool.feeRate) ? Number(whirlpool.feeRate) / 100 : null);
    const snap: AmmSnapshot = {
      poolId: pool.poolId,
      venue: pool.venue,
      poolKind: pool.poolKind,
      price,
      feeBps,
      baseDecimals,
      quoteDecimals,
      baseVault,
      quoteVault,
      baseReserve: prev?.baseReserve ?? null,
      quoteReserve: prev?.quoteReserve ?? null,
      lastUpdateTs: Date.now(),
      slot: slot ?? prev?.slot ?? null,
      stale: false,
    };

    this.commitAmmSnapshot(pool, snap, slot ?? prev?.slot ?? null);
    const watcher = this.poolWatchers.get(pool.poolId);
    if (watcher) this.ensurePoolVaultSubscriptions(watcher, snap);
  }

  private async refreshPhoenixMarket(market: string, symbol: string, slot: number | null, forceClient = false): Promise<void> {
    if (!this.phoenixClient || forceClient) {
      try {
        this.phoenixClient = await getPhoenixClient(this.conn, [market]);
      } catch (err) {
        logger.log("market_provider_phoenix_connect_error", { err: String((err as any)?.message ?? err) });
        this.phoenixClient = null;
        return;
      }
    }

    if (this.phoenixInflight.has(market)) {
      try {
        await this.phoenixInflight.get(market);
      } catch {
        // already logged inside inflight handler
      }
      return;
    }

    const task = (async () => {
      try {
        const pk = new PublicKey(market);
        const state = await ensurePhoenixMarketState(this.phoenixClient!, pk);

        let ladder: any = null;
        if (state && typeof state.getUiLadder === "function") {
          ladder = state.getUiLadder(this.config.phoenixDepthLevels);
        }
        if (!ladder && typeof this.phoenixClient?.getUiLadder === "function") {
          ladder = await this.phoenixClient!.getUiLadder(pk, this.config.phoenixDepthLevels);
        }

        if (!ladder || (!ladder.bids && !ladder.asks)) {
          logger.log("market_provider_phoenix_empty_ladder", { market });
          return;
        }

        const toQty = (value: any): number | null => {
          if (value == null) return null;
          if (typeof value === "number") return value;
          if (typeof value === "string") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
          }
          if (typeof value === "object") {
            if (typeof value.toNumber === "function") {
              const parsed = Number(value.toNumber());
              return Number.isFinite(parsed) ? parsed : null;
            }
            if (typeof value.valueOf === "function") {
              const parsed = Number(value.valueOf());
              return Number.isFinite(parsed) ? parsed : null;
            }
          }
          const coerced = Number(value);
          return Number.isFinite(coerced) ? coerced : null;
        };

        const bids = (ladder.bids ?? []).map((b: any) => ({
          px: Number(b.price ?? b.px ?? b[0]),
          qty: toQty(b.size ?? b.quantity ?? b.qty ?? b[1]) ?? 0,
        }));
        const asks = (ladder.asks ?? []).map((a: any) => ({
          px: Number(a.price ?? a.px ?? a[0]),
          qty: toQty(a.size ?? a.quantity ?? a.qty ?? a[1]) ?? 0,
        }));
        const bestBid = bids.length ? bids[0].px : null;
        const bestAsk = asks.length ? asks[0].px : null;
        const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
        const prev = this.phoenixSnapshots.get(market);
        const snap: PhoenixSnapshot = {
          market,
          symbol,
          bestBid,
          bestAsk,
          mid,
          levelsBids: bids,
          levelsAsks: asks,
          lastUpdateTs: Date.now(),
          slot: slot ?? prev?.slot ?? null,
          stale: false,
        };
        this.phoenixSnapshots.set(market, snap);
        this.phoenixWriter?.write("phoenix_mid", serializePhoenixMid(snap));
        this.phoenixWriter?.write("phoenix_l2", serializePhoenixL2(snap));
        this.logPhoenixSnapshotChange(prev ?? null, snap);
        this.requestEmit();
      } catch (err) {
        const isRateLimit = this.isRateLimitError(err);
        logger.log("market_provider_phoenix_error", {
          market,
          err: String((err as any)?.message ?? err),
          rate_limited: isRateLimit || undefined,
        });
        if (isRateLimit) this.scheduleBackoff("phoenix", this.config.phoenixRefreshMs * 2);
      }
    })();

    const wrapped = task.finally(() => {
      if (this.phoenixInflight.get(market) === wrapped) {
        this.phoenixInflight.delete(market);
      }
    });
    this.phoenixInflight.set(market, wrapped);
    try {
      await wrapped;
    } catch {
      // already logged
    }
  }

  private async warmupAccounts(): Promise<void> {
    const keys: PublicKey[] = [];
    for (const pool of this.trackedPools) keys.push(new PublicKey(pool.poolId));
    for (const { market } of this.trackedMarkets) keys.push(new PublicKey(market));
    if (!keys.length) return;
    try {
      await rpc.warmupAccounts(keys, "confirmed");
      logger.log("market_provider_warmup", { count: keys.length });
    } catch (err) {
      logger.log("market_provider_warmup_error", { count: keys.length, err: String((err as any)?.message ?? err) });
    }
  }

  private async refreshAmms(force = false, slot: number | null = null, reason = "scheduled"): Promise<void> {
    // If not forced and all AMM snapshots are fresh, don't touch RPC HTTP.
    if (!force) {
      const now = Date.now();
      let allFresh = this.trackedPools.length > 0;
      for (const pool of this.trackedPools) {
        const s = this.amms.get(pool.poolId);
        if (!s) { allFresh = false; break; }
        const age = now - (s.lastUpdateTs ?? 0);
        if (age > this.config.snapshotTtlMs) { allFresh = false; break; }
      }
      if (allFresh) {
        this.updateSnapshotHealth();
        this.emitState();
        this.maybeLogRefreshSummary(reason, slot ?? null, { skipped: true });
        return;
      }
    }

    if (this.refreshInFlight && !force) return;

    const now = Date.now();
    if (!force && now < this.ammBackoffUntil) {
      this.updateSnapshotHealth();
      return;
    }

    const task = (async () => {
      const start = Date.now();
      this.refreshStats = { lastDurationMs: 0, rateLimited: 0, errors: 0, batches: 0 };

      if (!this.trackedPools.length) {
        this.updateSnapshotHealth();
        this.refreshStats.lastDurationMs = Date.now() - start;
        return;
      }

      const poolKeys = this.trackedPools.map((pool) => new PublicKey(pool.poolId));
      const poolInfoMap = new Map<string, AccountInfo<Buffer> | null>();

      try {
        const fetched = await this.fetchAccountsChunked(poolKeys, "amm_pools");
        fetched.forEach((info, key) => poolInfoMap.set(key, info));
      } catch (err) {
        const info = err as any;
        const msg = String(info?.message ?? info);
        const isRateLimit = this.isRateLimitError(err);
        this.refreshStats.errors += 1;
        if (isRateLimit) this.refreshStats.rateLimited += 1;
        logger.log("market_provider_amm_batch_error", {
          label: info?.batchLabel ?? "amm_pools",
          err: msg,
          rate_limited: isRateLimit || undefined,
          reason,
        });
        if (isRateLimit) this.scheduleBackoff("amm", this.config.refreshMs * 2);
        this.updateSnapshotHealth();
        this.refreshStats.lastDurationMs = Date.now() - start;
        return;
      }

      const vaultFetch = new Map<string, { pool: TrackedPoolMeta; which: "base" | "quote" }>();

      for (const pool of this.trackedPools) {
        const key = pool.poolId;
        const info = poolInfoMap.get(key);
        if (!info?.data) {
          this.setAmmDegraded(key, "pool_missing");
          logger.log("market_provider_amm_missing", { pool: key, venue: pool.venue, kind: pool.poolKind });
          continue;
        }

        try {
          if (pool.venue === "raydium" && pool.poolKind === "cpmm") {
            this.handleRaydiumCpmmState(pool, info, slot);
          } else if (pool.venue === "raydium" && pool.poolKind === "clmm") {
            this.handleRaydiumClmmState(pool, info, slot);
          } else if (pool.venue === "orca" && pool.poolKind === "clmm") {
            this.handleOrcaClmmState(pool, info, slot);
          }
        } catch (err) {
          const isRateLimit = this.isRateLimitError(err);
          this.refreshStats.errors += 1;
          if (isRateLimit) this.refreshStats.rateLimited += 1;
          this.setAmmDegraded(key, isRateLimit ? "rate_limited" : "decode_error");
          logger.log("market_provider_amm_error", {
            pool: key,
            venue: pool.venue,
            kind: pool.poolKind,
            err: String((err as any)?.message ?? err),
            rate_limited: isRateLimit || undefined,
            reason,
          });
          continue;
        }

        const snap = this.amms.get(pool.poolId);
        if (snap) {
          if (snap.baseVault) {
            vaultFetch.set(snap.baseVault, { pool, which: "base" });
          }
          if (snap.quoteVault) {
            vaultFetch.set(snap.quoteVault, { pool, which: "quote" });
          }
        }
      }

      if (vaultFetch.size) {
        try {
          const vaultInfos = await this.fetchAccountsChunked(
            Array.from(vaultFetch.keys()).map((k) => new PublicKey(k)),
            "amm_vaults"
          );
          vaultInfos.forEach((info, key) => {
            const meta = vaultFetch.get(key);
            if (!meta) return;
            if (!info?.data) {
              this.setAmmDegraded(meta.pool.poolId, "vault_missing");
              return;
            }
            try {
              this.handleVaultAccount(meta.pool, meta.which, info, slot);
            } catch (err) {
              const isRateLimit = this.isRateLimitError(err);
              if (isRateLimit) this.refreshStats.rateLimited += 1;
              this.refreshStats.errors += 1;
              this.setAmmDegraded(meta.pool.poolId, isRateLimit ? "rate_limited" : "vault_error");
              logger.log("market_provider_vault_error", {
                pool: meta.pool.poolId,
                which: meta.which,
                err: String((err as any)?.message ?? err),
                rate_limited: isRateLimit || undefined,
              });
            }
          });
        } catch (err) {
          const info = err as any;
          const msg = String(info?.message ?? info);
          const isRateLimit = this.isRateLimitError(err);
          if (isRateLimit) this.refreshStats.rateLimited += 1;
          this.refreshStats.errors += 1;
          logger.log("market_provider_vault_batch_error", {
            label: info?.batchLabel ?? "amm_vaults",
            err: msg,
            rate_limited: isRateLimit || undefined,
            reason,
          });
          if (isRateLimit) this.scheduleBackoff("amm", this.config.refreshMs * 2);
        }
      }

      this.updateSnapshotHealth();
      this.refreshStats.lastDurationMs = Date.now() - start;
      this.emitState();
    })();

    this.refreshInFlight = task;
    try {
      await task;
    } finally {
      this.refreshInFlight = null;
      if (this.pendingSlot != null) {
        // WS-first: we only reschedule if we were degraded and still need HTTP
        const stillDegraded = this.ammDegradedReasons.size > 0 || this.amms.size === 0;
        const pending = this.pendingSlot;
        this.pendingSlot = null;
        if (stillDegraded) this.scheduleAmmRefresh(pending, "pending");
      }
      this.maybeLogRefreshSummary(reason, slot ?? null);
    }

    for (const pool of this.trackedPools) this.ensurePoolSubscriptions(pool);
  }

  private async refreshPhoenix(force = false): Promise<void> {
    if (!this.trackedMarkets.length) {
      this.maybeLogPhoenixSummary("no_markets", { skipped: true, force: true });
      return;
    }
    if (!force && Date.now() < this.phoenixBackoffUntil) {
      this.maybeLogPhoenixSummary("backoff", { skipped: true });
      return;
    }
    if (!this.phoenixClient || force) {
      try {
        const seeds = this.trackedMarkets.map(({ market }) => market);
        this.phoenixClient = await getPhoenixClient(this.conn, seeds);
      } catch (err) {
        const msg = String((err as any)?.message ?? err);
        logger.log("market_provider_phoenix_connect_error", { err: msg });
        this.phoenixClient = null;
        this.scheduleBackoff("phoenix", this.config.phoenixRefreshMs * 2);
        this.maybeLogPhoenixSummary("connect_error", { error: msg, force: true });
        return;
      }
    }

    const start = Date.now();

    await Promise.all(
      this.trackedMarkets.map(({ market, symbol }) =>
        this.refreshPhoenixMarket(market, symbol, null, force)
      )
    );
    this.maybeLogPhoenixSummary(force ? "forced" : "scheduled", { duration_ms: Date.now() - start });
    for (const { market, symbol } of this.trackedMarkets) this.ensurePhoenixSubscription(market, symbol);
    this.updateSnapshotHealth();
    this.emitState();
  }

  private async refreshOneAmm(pool: TrackedPoolMeta, force: boolean): Promise<AmmSnapshot | null> {
    if (pool.venue === "raydium" && pool.poolKind === "cpmm") return this.refreshRaydiumCpmm(pool, force);
    if (pool.venue === "raydium" && pool.poolKind === "clmm") return this.refreshRaydiumClmm(pool, force);
    if (pool.venue === "orca" && pool.poolKind === "clmm") return this.refreshOrcaClmm(pool, force);
    return null;
  }

  private async refreshRaydiumCpmm(pool: TrackedPoolMeta, force: boolean): Promise<AmmSnapshot | null> {
    const meta = this.amms.get(pool.poolId);
    const poolPk = new PublicKey(pool.poolId);

    const now = Date.now();
    if (!force && meta && meta.baseReserve != null && meta.quoteReserve != null && now - meta.lastUpdateTs < this.config.refreshMs * 3) {
      return null;
    }

    let baseVaultPk: PublicKey;
    let quoteVaultPk: PublicKey;
    let baseDecimals: number;
    let quoteDecimals: number;
    let feeBps = pool.feeHint ?? meta?.feeBps ?? null;

    const needPoolReload =
      !meta ||
      force ||
      meta.baseDecimals == null ||
      meta.quoteDecimals == null ||
      meta.baseReserve == null ||
      !meta.baseVault ||
      !meta.quoteVault;

    if (needPoolReload) {
      const info = await this.conn.getAccountInfo(poolPk, "confirmed");
      if (!info?.data) throw new Error("raydium_cpmm_account_missing");
      const state: any = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);
      baseVaultPk = new PublicKey(state.baseVault);
      quoteVaultPk = new PublicKey(state.quoteVault);
      baseDecimals = Number(state.coinDecimals ?? 9);
      quoteDecimals = Number(state.pcDecimals ?? 6);
      if (feeBps == null) {
        const num = Number(state.tradeFeeNumerator ?? state.swapFeeNumerator ?? 0);
        const den = Number(state.tradeFeeDenominator ?? state.swapFeeDenominator ?? 0);
        if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
          feeBps = (num / den) * 10_000;
        }
      }
    } else {
      if (!meta.baseVault || !meta.quoteVault) throw new Error("raydium_cpmm_vault_meta_missing");
      baseVaultPk = new PublicKey(meta.baseVault);
      quoteVaultPk = new PublicKey(meta.quoteVault);
      baseDecimals = meta.baseDecimals;
      quoteDecimals = meta.quoteDecimals;
      if (feeBps == null) feeBps = meta.feeBps ?? null;
    }

    const vaults = await this.conn.getMultipleAccountsInfo([baseVaultPk, quoteVaultPk]);
    if (!vaults[0]?.data || !vaults[1]?.data) throw new Error("raydium_cpmm_vault_fetch_failed");
    const baseInfo: any = SPL_ACCOUNT_LAYOUT.decode(vaults[0].data);
    const quoteInfo: any = SPL_ACCOUNT_LAYOUT.decode(vaults[1].data);
    const baseAmount = new BN(baseInfo.amount.toString());
    const quoteAmount = new BN(quoteInfo.amount.toString());

    const baseAtomsStr = baseAmount.toString();
    const quoteAtomsStr = quoteAmount.toString();
    const baseReserveUi = Number(baseAmount.toString()) / 10 ** baseDecimals;
    const quoteReserveUi = Number(quoteAmount.toString()) / 10 ** quoteDecimals;
    const price = baseReserveUi > 0 ? quoteReserveUi / baseReserveUi : null;

    return {
      poolId: pool.poolId,
      venue: pool.venue,
      poolKind: pool.poolKind,
      price,
      feeBps,
      baseDecimals,
      quoteDecimals,
      baseVault: baseVaultPk.toBase58(),
      quoteVault: quoteVaultPk.toBase58(),
      baseReserve: baseReserveUi,
      quoteReserve: quoteReserveUi,
      baseReserveUi,
      quoteReserveUi,
      baseReserveAtoms: baseAtomsStr,
      quoteReserveAtoms: quoteAtomsStr,
      lastUpdateTs: Date.now(),
      slot: null,
    };
  }

  private async refreshRaydiumClmm(pool: TrackedPoolMeta, force: boolean): Promise<AmmSnapshot | null> {
    const prev = this.amms.get(pool.poolId);
    const now = Date.now();
    if (!force && prev && now - prev.lastUpdateTs < this.config.refreshMs * 3) {
      return null;
    }

    const info = await this.conn.getAccountInfo(new PublicKey(pool.poolId), "confirmed");
    if (!info?.data) throw new Error("raydium_clmm_account_missing");
    const state: any = PoolInfoLayout.decode(info.data);

    const mintA = new PublicKey(state.mintA.mint);
    const mintB = new PublicKey(state.mintB.mint);
    const decimalsA = Number(state.mintA.decimals ?? 0);
    const decimalsB = Number(state.mintB.decimals ?? 0);

    const baseMint = this.findBaseMint(pool.poolId) ?? mintA;
    const baseIsA = baseMint.equals(mintA);
    const baseDecimals = baseIsA ? decimalsA : decimalsB;
    const quoteDecimals = baseIsA ? decimalsB : decimalsA;

    const sqrtPrice = new BN(state.sqrtPriceX64.toString());
    const rawPrice = SqrtPriceMath.sqrtPriceX64ToPrice(sqrtPrice, decimalsA, decimalsB).toNumber();
    const price = baseIsA ? rawPrice : rawPrice > 0 ? 1 / rawPrice : null;

    const feeBps = pool.feeHint ?? (Number.isFinite(state.tradeFeeRate) ? Number(state.tradeFeeRate) * 10_000 : null);

    const vaultAPk = new PublicKey(state.vaultA);
    const vaultBPk = new PublicKey(state.vaultB);
    const vaultInfos = await this.conn.getMultipleAccountsInfo([vaultAPk, vaultBPk], { commitment: "confirmed" });
    if (!vaultInfos[0]?.data || !vaultInfos[1]?.data) throw new Error("raydium_clmm_vault_missing");
    const vaultAInfo: any = SPL_ACCOUNT_LAYOUT.decode(vaultInfos[0].data);
    const vaultBInfo: any = SPL_ACCOUNT_LAYOUT.decode(vaultInfos[1].data);
    const amountA = new BN(vaultAInfo.amount.toString());
    const amountB = new BN(vaultBInfo.amount.toString());

    const baseAmount = baseIsA ? amountA : amountB;
    const quoteAmount = baseIsA ? amountB : amountA;
    const baseAtomsStr = baseAmount.toString();
    const quoteAtomsStr = quoteAmount.toString();
    const baseReserveUi = Number(baseAtomsStr) / 10 ** baseDecimals;
    const quoteReserveUi = Number(quoteAtomsStr) / 10 ** quoteDecimals;

    return {
      poolId: pool.poolId,
      venue: pool.venue,
      poolKind: pool.poolKind,
      price,
      feeBps,
      baseDecimals,
      quoteDecimals,
      baseVault: (baseIsA ? vaultAPk : vaultBPk).toBase58(),
      quoteVault: (baseIsA ? vaultBPk : vaultAPk).toBase58(),
      baseReserve: baseReserveUi,
      quoteReserve: quoteReserveUi,
      baseReserveUi,
      quoteReserveUi,
      baseReserveAtoms: baseAtomsStr,
      quoteReserveAtoms: quoteAtomsStr,
      lastUpdateTs: Date.now(),
      slot: null,
    };
  }

  private findBaseMint(_pool: string): PublicKey | null {
    for (const pair of this.pairs) {
      for (const venue of pair.ammVenues ?? []) {
        if ((venue.poolId ?? "").trim() === _pool) {
          if (pair.baseMint) return new PublicKey(pair.baseMint);
        }
      }
    }
    return null;
  }

  private async refreshOrcaClmm(pool: TrackedPoolMeta, force: boolean): Promise<AmmSnapshot | null> {
    const prev = this.amms.get(pool.poolId);
    const now = Date.now();
    if (!force && prev && now - prev.lastUpdateTs < this.config.refreshMs * 3) {
      return null;
    }

    const info = await this.conn.getAccountInfo(new PublicKey(pool.poolId), "confirmed");
    if (!info?.data) throw new Error("orca_whirlpool_missing");
    const whirlpool = WHIRLPOOL_CODER.decode("Whirlpool", info.data) as any;

    const mintA = new PublicKey(whirlpool.tokenMintA);
    const mintB = new PublicKey(whirlpool.tokenMintB);

    const decimalsA = Number(whirlpool.tokenMintDecimalsA ?? 9);
    const decimalsB = Number(whirlpool.tokenMintDecimalsB ?? 6);

    const baseMint = this.findBaseMint(pool.poolId) ?? mintA;
    const baseIsA = baseMint.equals(mintA);
    const baseDecimals = baseIsA ? decimalsA : decimalsB;
    const quoteDecimals = baseIsA ? decimalsB : decimalsA;

    const priceAB = PriceMath.sqrtPriceX64ToPrice(whirlpool.sqrtPrice, decimalsA, decimalsB).toNumber();
    const price = baseIsA ? priceAB : priceAB > 0 ? 1 / priceAB : null;

    const feeBps = pool.feeHint ?? (Number.isFinite(whirlpool.feeRate) ? Number(whirlpool.feeRate) / 100 : null);

    const vaultAPk = new PublicKey(whirlpool.tokenVaultA);
    const vaultBPk = new PublicKey(whirlpool.tokenVaultB);
    const vaultInfos = await this.conn.getMultipleAccountsInfo([vaultAPk, vaultBPk], { commitment: "confirmed" });
    if (!vaultInfos[0]?.data || !vaultInfos[1]?.data) throw new Error("orca_whirlpool_vault_missing");
    const vaultAInfo: any = SPL_ACCOUNT_LAYOUT.decode(vaultInfos[0].data);
    const vaultBInfo: any = SPL_ACCOUNT_LAYOUT.decode(vaultInfos[1].data);
    const amountA = new BN(vaultAInfo.amount.toString());
    const amountB = new BN(vaultBInfo.amount.toString());

    const baseAmount = baseIsA ? amountA : amountB;
    const quoteAmount = baseIsA ? amountB : amountA;
    const baseAtomsStr = baseAmount.toString();
    const quoteAtomsStr = quoteAmount.toString();
    const baseReserveUi = Number(baseAtomsStr) / 10 ** baseDecimals;
    const quoteReserveUi = Number(quoteAtomsStr) / 10 ** quoteDecimals;

    return {
      poolId: pool.poolId,
      venue: pool.venue,
      poolKind: pool.poolKind,
      price,
      feeBps,
      baseDecimals,
      quoteDecimals,
      baseVault: (baseIsA ? vaultAPk : vaultBPk).toBase58(),
      quoteVault: (baseIsA ? vaultBPk : vaultAPk).toBase58(),
      baseReserve: baseReserveUi,
      quoteReserve: quoteReserveUi,
      baseReserveUi,
      quoteReserveUi,
      baseReserveAtoms: baseAtomsStr,
      quoteReserveAtoms: quoteAtomsStr,
      lastUpdateTs: Date.now(),
      slot: null,
    };
  }

  private async resolveMintDecimals(mint: PublicKey): Promise<number> {
    if (mint.equals(SOL_MINT)) return 9;
    if (mint.equals(USDC_MINT)) return 6;
    try {
      const info = await this.conn.getParsedAccountInfo(mint, "confirmed");
      const dec = (info.value as any)?.data?.parsed?.info?.decimals;
      if (typeof dec === "number") return dec;
    } catch { /* noop */ }
    return 9;
  }

  private markStaleness(): void {
    const now = Date.now();
    for (const snap of this.amms.values()) {
      const stale = now - snap.lastUpdateTs > this.config.staleMs;
      if (stale && !snap.stale) logger.log("market_provider_snapshot_stale", { venue: snap.venue, pool: snap.poolId });
      snap.stale = stale;
    }
    for (const snap of this.phoenixSnapshots.values()) {
      const stale = now - snap.lastUpdateTs > this.config.staleMs;
      if (stale && !snap.stale) logger.log("market_provider_snapshot_stale", { venue: "phoenix", market: snap.market });
      snap.stale = stale;
    }
  }

  // Add these methods to the MarketStateProvider class

  private updateSnapshotHealth(): void {
    this.markStaleness();

    const now = Date.now();

    // Update degraded status and age for AMM snapshots
    for (const [poolId, snap] of this.amms) {
      const degradedReason = this.ammDegradedReasons.get(poolId);
      snap.degraded = !!degradedReason;
      snap.degradedReason = degradedReason || null;
      snap.ageMs = now - snap.lastUpdateTs;

      // Check if snapshot exceeds TTL and should be marked stale
      if (this.config.snapshotTtlMs && snap.ageMs > this.config.snapshotTtlMs) {
        snap.stale = true;
      }
    }

    // Update age for Phoenix snapshots
    for (const snap of this.phoenixSnapshots.values()) {
      snap.ageMs = now - snap.lastUpdateTs;

      // Phoenix snapshots don't have degraded status currently, but set age
      if (this.config.snapshotTtlMs && snap.ageMs > this.config.snapshotTtlMs) {
        snap.stale = true;
      }
    }
  }

  private summarizeAmmHealth(): { total: number; stale: number; degraded: number; healthy: number; missing: number } {
    const now = Date.now();
    const ttl = this.config.snapshotTtlMs;
    const tracked = this.trackedPools;
    const trackedSet = new Set(tracked.map((pool) => pool.poolId));

    let stale = 0;
    let missing = 0;
    for (const pool of tracked) {
      const snap = this.amms.get(pool.poolId);
      if (!snap) {
        missing += 1;
        stale += 1;
        continue;
      }
      const age = now - (snap.lastUpdateTs ?? 0);
      const isStale = snap.stale || (ttl > 0 && age > ttl);
      if (isStale) stale += 1;
    }

    let degraded = 0;
    for (const poolId of this.ammDegradedReasons.keys()) {
      if (trackedSet.has(poolId)) degraded += 1;
    }

    const total = tracked.length;
    const healthy = Math.max(total - stale - degraded, 0);
    return { total, stale, degraded, healthy, missing };
  }

  private summarizePhoenixHealth(): { total: number; stale: number; healthy: number; missing: number } {
    const now = Date.now();
    const ttl = this.config.staleMs;
    const tracked = this.trackedMarkets;

    let stale = 0;
    let missing = 0;
    for (const { market } of tracked) {
      const snap = this.phoenixSnapshots.get(market);
      if (!snap) {
        missing += 1;
        stale += 1;
        continue;
      }
      const age = now - (snap.lastUpdateTs ?? 0);
      const isStale = snap.stale || (ttl > 0 && age > ttl);
      if (isStale) stale += 1;
    }

    const total = tracked.length;
    const healthy = Math.max(total - stale, 0);
    return { total, stale, healthy, missing };
  }

  private maybeLogRefreshSummary(reason: string, slot: number | null, extra: Record<string, unknown> = {}): void {
    const now = Date.now();
    const forceLog = ((extra as any)?.force === true);
    if (!forceLog && this.refreshLogCooldownMs > 0 && now - this.lastRefreshLogTs < this.refreshLogCooldownMs) {
      return;
    }
    this.lastRefreshLogTs = now;

    const ammHealth = this.summarizeAmmHealth();
    const payload: Record<string, unknown> = {
      reason,
      slot: slot ?? null,
      batches: this.refreshStats.batches,
    };

    if (this.refreshStats.lastDurationMs) payload.duration_ms = this.refreshStats.lastDurationMs;
    if (this.refreshStats.errors) payload.errors = this.refreshStats.errors;
    if (this.refreshStats.rateLimited) payload.rate_limited = this.refreshStats.rateLimited;

    payload.pools_tracked = ammHealth.total;
    payload.pools_healthy = Math.max(ammHealth.total - ammHealth.stale - ammHealth.degraded, 0);
    if (ammHealth.stale) payload.pools_stale = ammHealth.stale;
    if (ammHealth.degraded) payload.pools_degraded = ammHealth.degraded;
    if (ammHealth.missing) payload.pools_missing = ammHealth.missing;

    const extras = { ...extra };
    delete (extras as any).force;
    if (Object.keys(extras).length) Object.assign(payload, extras);

    logger.log("market_provider_refresh", payload);
  }

  private maybeLogPhoenixSummary(reason: string, extra: Record<string, unknown> = {}): void {
    const now = Date.now();
    const forceLog = ((extra as any)?.force === true);
    if (!forceLog && this.phoenixLogCooldownMs > 0 && now - this.lastPhoenixLogTs < this.phoenixLogCooldownMs) {
      return;
    }
    this.lastPhoenixLogTs = now;

    const health = this.summarizePhoenixHealth();
    const payload: Record<string, unknown> = {
      reason,
      markets_tracked: health.total,
      markets_healthy: health.healthy,
    };
    if (health.stale) payload.markets_stale = health.stale;
    if (health.missing) payload.markets_missing = health.missing;

    const extras = { ...extra };
    delete (extras as any).force;
    if (Object.keys(extras).length) Object.assign(payload, extras);

    logger.log("market_provider_phoenix_refresh", payload);
  }

  private emitTelemetry(): void {
    const now = Date.now();
    const totalAmms = this.amms.size;
    const totalPhoenix = this.phoenixSnapshots.size;
    const ammHealth = this.summarizeAmmHealth();
    const phoenixHealth = this.summarizePhoenixHealth();
    const staleAmms = ammHealth.stale;
    const degradedAmms = ammHealth.degraded;
    const stalePhoenix = phoenixHealth.stale;

    // Subscription counts
    const activeSubs = this.accountSubs.size;
    const activePoolWatchers = this.poolWatchers.size;
    const activePhoenixSubs = this.phoenixSubs.size;

    // Degraded pool details
    const trackedPoolSet = new Set(this.trackedPools.map((p) => p.poolId));
    const degradedPools = Array.from(this.ammDegradedReasons.entries())
      .filter(([poolId]) => trackedPoolSet.has(poolId))
      .map(([poolId, reason]) => ({ poolId, reason }));

    // Calculate backoff times remaining
    const ammBackoffMs = this.ammBackoffUntil > now ? this.ammBackoffUntil - now : 0;
    const phoenixBackoffMs = this.phoenixBackoffUntil > now ? this.phoenixBackoffUntil - now : 0;

    const telemetryData = {
      timestamp: now,
      slot: this.lastSlotSeen,
      amms: {
        total: totalAmms,
        tracked: ammHealth.total,
        stale: staleAmms,
        degraded: degradedAmms,
        healthy: Math.max(ammHealth.total - staleAmms - degradedAmms, 0),
        missing: ammHealth.missing,
      },
      phoenix: {
        total: totalPhoenix,
        tracked: phoenixHealth.total,
        stale: stalePhoenix,
        healthy: Math.max(phoenixHealth.total - stalePhoenix, 0),
        missing: phoenixHealth.missing,
      },
      subscriptions: {
        accounts: activeSubs,
        poolWatchers: activePoolWatchers,
        phoenix: activePhoenixSubs
      },
      refreshStats: { ...this.refreshStats },
      degradedPools,
      backoff: {
        amm: ammBackoffMs,
        phoenix: phoenixBackoffMs
      },
      inflightOperations: {
        refreshInFlight: !!this.refreshInFlight,
        phoenixInflight: this.phoenixInflight.size
      }
    };

    logger.log("market_provider_telemetry", telemetryData);
  }

  private emitState(): void {
    const state = this.buildState();
    for (const [, listener] of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        logger.log("market_provider_listener_error", { err: String((err as any)?.message ?? err) });
      }
    }
  }

  private buildState(): MarketProviderState {
    return {
      amms: Array.from(this.amms.values()).map((snap) => ({ ...snap })),
      phoenix: Array.from(this.phoenixSnapshots.values()).map((snap) => ({
        ...snap,
        levelsBids: snap.levelsBids.map((lvl) => ({ ...lvl })),
        levelsAsks: snap.levelsAsks.map((lvl) => ({ ...lvl })),
      })),
    };
  }

  private isRateLimitError(err: unknown): boolean {
    if (!err) return false;
    const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
    return msg.includes("429") || msg.includes("rate limit");
  }

  private scheduleBackoff(kind: "amm" | "phoenix", baseMs: number): void {
    const base = Math.max(baseMs, kind === "amm" ? this.config.refreshMs : this.config.phoenixRefreshMs);
    const delay = Math.max(base, 2000);
    const until = Date.now() + delay;
    if (kind === "amm") this.ammBackoffUntil = until;
    else this.phoenixBackoffUntil = until;
    logger.log(`market_provider_${kind}_backoff`, { delay_ms: delay });
  }
}

function resolveAmmsPath(): string {
  const env = (process.env.EDGE_AMMS_JSONL ?? "").trim();
  if (env) {
    fs.mkdirSync(path.dirname(env), { recursive: true });
    return env;
  }
  const runRoot = (process.env.RUN_ROOT ?? "").trim();
  if (runRoot) {
    const resolved = path.resolve(process.cwd(), runRoot, "amms-feed.jsonl");
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }
  const fallback = path.resolve(process.cwd(), "data", "logs", "amms", "feed.jsonl");
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  return fallback;
}

function resolveAmmsTextPath(): string {
  const env = (process.env.EDGE_AMMS_TEXT ?? "").trim();
  if (env) {
    fs.mkdirSync(path.dirname(env), { recursive: true });
    return env;
  }
  const runRoot = (process.env.RUN_ROOT ?? "").trim();
  if (runRoot) {
    const resolved = path.resolve(process.cwd(), runRoot, "amms-prices.log");
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }
  const fallback = path.resolve(process.cwd(), "data", "logs", "amms", "prices.log");
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  return fallback;
}

function resolvePhoenixPath(): string {
  const env = (process.env.EDGE_PHOENIX_JSONL ?? "").trim();
  if (env) {
    fs.mkdirSync(path.dirname(env), { recursive: true });
    return env;
  }
  const runRoot = (process.env.RUN_ROOT ?? "").trim();
  if (runRoot) {
    const resolved = path.resolve(process.cwd(), runRoot, "phoenix-feed.jsonl");
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }
  const fallback = path.resolve(process.cwd(), "data", "logs", "phoenix", "feed.jsonl");
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  return fallback;
}

function serializeAmmSnapshot(snap: AmmSnapshot) {
  return {
    symbol: "SOL/USDC",
    venue: snap.venue,
    ammId: snap.poolId,
    poolKind: snap.poolKind,
    ts: snap.lastUpdateTs,
    baseDecimals: snap.baseDecimals,
    quoteDecimals: snap.quoteDecimals,
    px: snap.price ?? undefined,
    px_str: snap.price != null ? String(snap.price) : undefined,
    feeBps: snap.feeBps ?? undefined,
    fee_source: snap.feeBps != null ? "provider" : undefined,
    tick_ms: DEFAULT_REFRESH_MS,
    slot: snap.slot ?? undefined,
    base_vault: snap.baseVault ?? undefined,
    quote_vault: snap.quoteVault ?? undefined,
    source: "provider",
    validation_passed: snap.price != null,
    base_ui: snap.baseReserveUi ?? snap.baseReserve ?? undefined,
    quote_ui: snap.quoteReserveUi ?? snap.quoteReserve ?? undefined,
    base_int: snap.baseReserveAtoms ?? (snap.baseReserve != null
      ? String(Math.trunc((snap.baseReserve ?? 0) * 10 ** snap.baseDecimals))
      : undefined),
    quote_int: snap.quoteReserveAtoms ?? (snap.quoteReserve != null
      ? String(Math.trunc((snap.quoteReserve ?? 0) * 10 ** snap.quoteDecimals))
      : undefined),
  };
}

function serializePhoenixMid(snap: PhoenixSnapshot) {
  return {
    ts: snap.lastUpdateTs,
    market: snap.market,
    symbol: snap.symbol,
    px: snap.mid,
    px_str: snap.mid != null ? snap.mid.toFixed(12) : undefined,
    best_bid: snap.bestBid ?? undefined,
    best_ask: snap.bestAsk ?? undefined,
    tick_ms: DEFAULT_PHOENIX_REFRESH_MS,
    slot: snap.slot ?? undefined,
    source: "provider",
  };
}

function serializePhoenixL2(snap: PhoenixSnapshot) {
  return {
    ts: snap.lastUpdateTs,
    market: snap.market,
    symbol: snap.symbol,
    best_bid: snap.bestBid ?? undefined,
    best_bid_str: snap.bestBid != null ? snap.bestBid.toFixed(12) : undefined,
    best_ask: snap.bestAsk ?? undefined,
    best_ask_str: snap.bestAsk != null ? snap.bestAsk.toFixed(12) : undefined,
    phoenix_mid: snap.mid ?? undefined,
    tick_ms: DEFAULT_PHOENIX_REFRESH_MS,
    source: "provider",
    slot: snap.slot ?? undefined,
    levels_bids: snap.levelsBids,
    levels_asks: snap.levelsAsks,
  };
}
