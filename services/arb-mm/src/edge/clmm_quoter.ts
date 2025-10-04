// services/arb-mm/src/edge/clmm_quoter.ts
//
// Node >= 18 ships with global `fetch`. If you run on Node 16, uncomment this:
// import fetch from "node-fetch";

import { PublicKey, Keypair } from "@solana/web3.js";
import {
  Clmm,
  fetchMultipleMintInfos,
  type ClmmPoolInfo,
} from "@raydium-io/raydium-sdk";
import { Percentage } from "@orca-so/common-sdk";
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  swapQuoteByOutputToken,
  UseFallbackTickArray,
} from "@orca-so/whirlpools-sdk";
import { AnchorProvider } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import BN from "bn.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

import { logger } from "../ml_logger.js";
import { rpcClient } from "@mev/rpc-facade";

const ENABLE_RAYDIUM_CLMM = String(process.env.ENABLE_RAYDIUM_CLMM ?? "1").trim() !== "0";

// When provider is enabled we avoid all per-quote RPC — quotes must come from snapshots.
// Soft-guard: never throw; return { ok:false, err:"snapshot_only" } so callers can skip gracefully.
const SNAPSHOT_ONLY = String(process.env.QUOTER_SNAPSHOT_ONLY ?? "1").trim() === "1";
const ALLOW_ONCHAIN_FALLBACK = String(process.env.CLMM_ALLOW_ONCHAIN_FALLBACK ?? "1").trim() !== "0";
const ONCHAIN_CACHE_TTL_MS = Number(process.env.CLMM_ONCHAIN_CACHE_TTL_MS ?? 750);

type QuoteCacheEntry = { ts: number; result: QuoteOk };
const onchainQuoteCache = new Map<string, QuoteCacheEntry>();
const snapshotAllowLogged = new Set<string>();

function cacheKey(args: QuoteArgs): string {
  const venue = (args.venue ?? "unknown").toLowerCase();
  const sizeBucket = Math.round(args.sizeBase * 1e6) / 1e6;
  return `${venue}:${args.poolId}:${args.side}:${sizeBucket}`;
}

function getCachedQuote(key: string): QuoteOk | undefined {
  const entry = onchainQuoteCache.get(key);
  if (!entry) return undefined;
  if (nowMs() - entry.ts > ONCHAIN_CACHE_TTL_MS) {
    onchainQuoteCache.delete(key);
    return undefined;
  }
  return entry.result;
}

function rememberQuote(key: string, result: QuoteResult): void {
  if (!result.ok) return;
  onchainQuoteCache.set(key, { ts: nowMs(), result });
}

function snapshotOnlyBlock(venue: string, poolId: string, side: QuoteSide, sizeBase: number) {
  if (!SNAPSHOT_ONLY) return null;
  if (ALLOW_ONCHAIN_FALLBACK) {
    const key = `${venue}:${poolId}`;
    if (!snapshotAllowLogged.has(key)) {
      snapshotAllowLogged.add(key);
      logger.log("clmm_quote_snapshot_allow", { venue, pool: poolId });
    }
    return null;
  }
  logger.log("clmm_quote_snapshot_only_block", { venue, pool: poolId, side, size_base: sizeBase });
  return { ok: false as const, err: "snapshot_only" };
}

const RAYDIUM_CLMM_API = String(
  process.env.RAYDIUM_CLMM_API_URL ??
  "https://api.raydium.io/v2/ammV3/ammPools"
);
const raydiumConn = rpcClient;
const orcaConn = raydiumConn; // reuse the same transport for now

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const TEN = new Decimal(10);

const RATE_LIMIT_BASE_MS = Number(process.env.CLMM_RATELIMIT_BASE_MS ?? 500);
const RATE_LIMIT_MAX_MS = Number(process.env.CLMM_RATELIMIT_MAX_MS ?? 5_000);
const RATE_LIMIT_MAX_STRIKES = Number(process.env.CLMM_RATELIMIT_MAX_STRIKES ?? 6);

type RateLimitState = {
  strikes: number;
  until: number;
  logged?: boolean;
};

const rateLimitMap = new Map<string, RateLimitState>();

type QuoteSide = "buy" | "sell";

type QuoteArgs = {
  poolId: string;
  side: QuoteSide;
  sizeBase: number;
  slippageBps: number;
  baseMint?: string;
  quoteMint?: string;
  feeBpsHint?: number;
  venue?: string;
  poolKind?: string;
  reserves?: {
    base: number;
    quote: number;
    baseDecimals: number;
    quoteDecimals: number;
  };
};

type QuoteOk = { ok: true; price: number; feeBps: number; meta?: Record<string, unknown> };
type QuoteErr = { ok: false; err: string; meta?: Record<string, unknown> };
export type QuoteResult = QuoteOk | QuoteErr;

// ────────────────────────────────────────────────────────────────────────────
// shared helpers
// ────────────────────────────────────────────────────────────────────────────
function clampSlippage(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 5000) return 0.5; // cap at 50%
  return x / 10_000;
}

function uiToBn(amount: number, decimals: number): BN {
  if (!(amount > 0) || !(Number.isFinite(amount))) throw new Error("invalid_amount");
  const scale = TEN.pow(decimals);
  const atoms = new Decimal(amount).mul(scale);
  if (!atoms.isFinite() || atoms.lte(0)) throw new Error("amount_underflow");
  return new BN(atoms.floor().toFixed(0));
}

function bnToUi(bn: BN, decimals: number): Decimal {
  if (!bn || bn.isNeg()) return new Decimal(0);
  return new Decimal(bn.toString()).div(TEN.pow(decimals));
}

function calcFeeBps(feeAtoms: BN | undefined, baseAtoms: BN | undefined): number {
  if (!feeAtoms || !baseAtoms || feeAtoms.isZero() || baseAtoms.isZero()) return 0;
  const fee = new Decimal(feeAtoms.toString());
  const amt = new Decimal(baseAtoms.toString());
  return fee.mul(10_000).div(amt).toNumber();
}

function cpmmBuyQuotePerBase(base: number, quote: number, wantBase: number, feeBps: number): number | undefined {
  if (!(base > 0 && quote > 0 && wantBase > 0)) return undefined;
  if (wantBase >= base * 0.999999) return undefined;
  const fee = Math.max(0, feeBps) / 10_000;
  const dqPrime = (wantBase * quote) / (base - wantBase);
  const dq = dqPrime / (1 - fee);
  if (!Number.isFinite(dq) || dq <= 0) return undefined;
  return dq / wantBase;
}

function cpmmSellQuotePerBase(base: number, quote: number, sellBase: number, feeBps: number): number | undefined {
  if (!(base > 0 && quote > 0 && sellBase > 0)) return undefined;
  const fee = Math.max(0, feeBps) / 10_000;
  const dbPrime = sellBase * (1 - fee);
  const dy = (quote * dbPrime) / (base + dbPrime);
  if (!Number.isFinite(dy) || dy <= 0) return undefined;
  return dy / sellBase;
}

function quoteFromReserves(args: QuoteArgs): QuoteResult | null {
  // CLMM pools do not follow CPMM math, so reserve-based quoting is unsafe.
  if (String(args.poolKind ?? "").toLowerCase() === "clmm") return null;
  const reserves = args.reserves;
  if (!reserves) return null;
  const { base, quote } = reserves;
  if (!(base > 0 && quote > 0) || !(args.sizeBase > 0)) return null;

  const feeBps = Number.isFinite(args.feeBpsHint) ? Number(args.feeBpsHint) : 0;
  const price = args.side === "buy"
    ? cpmmBuyQuotePerBase(base, quote, args.sizeBase, feeBps)
    : cpmmSellQuotePerBase(base, quote, args.sizeBase, feeBps);

  if (price == null || !Number.isFinite(price) || price <= 0) return null;

  return {
    ok: true,
    price,
    feeBps,
    meta: {
      source: "snapshot_cpmm",
      reserves_base: base,
      reserves_quote: quote,
      fee_bps_hint: feeBps,
    },
  } satisfies QuoteOk;
}

function nowMs(): number {
  return Date.now();
}

function rateLimitKey(venue: string, poolId: string): string {
  return `${venue.toLowerCase()}:${poolId}`;
}

function cooldownRemaining(key: string): number {
  const state = rateLimitMap.get(key);
  if (!state) return 0;
  const rem = state.until - nowMs();
  if (rem <= 0) {
    rateLimitMap.delete(key);
    return 0;
  }
  return rem;
}

function markRateLimited(key: string): void {
  const prev = rateLimitMap.get(key);
  const strikes = Math.min((prev?.strikes ?? 0) + 1, RATE_LIMIT_MAX_STRIKES);
  const wait = Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * Math.pow(2, strikes - 1));
  rateLimitMap.set(key, { strikes, until: nowMs() + wait, logged: false });
}

function clearRateLimit(key: string): void {
  rateLimitMap.delete(key);
}

function shouldSkipForCooldown(key: string): { active: boolean; remaining: number } {
  const remaining = cooldownRemaining(key);
  if (remaining <= 0) return { active: false, remaining: 0 };
  const state = rateLimitMap.get(key);
  if (state && !state.logged) {
    logger.log("clmm_quote_cooldown", { key, wait_ms: remaining, strikes: state.strikes });
    state.logged = true;
  }
  return { active: true, remaining };
}

function isRateLimitError(err: any): boolean {
  const msg = String((err?.message ?? err) ?? "").toLowerCase();
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
}

function strEq(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ────────────────────────────────────────────────────────────────────────────
// Raydium CLMM support
// ────────────────────────────────────────────────────────────────────────────

type ApiClmmPoolsStats = {
  volume: number;
  volumeFee: number;
  feeA: number;
  feeB: number;
  feeApr: number;
  rewardApr: { A: number; B: number; C: number };
  apr: number;
  priceMin: number;
  priceMax: number;
};

type ApiClmmConfig = {
  id: string;
  index: number;
  protocolFeeRate: number;
  tradeFeeRate: number;
  tickSpacing: number;
  fundFeeRate: number;
  fundOwner: string;
  description: string;
};

type ApiClmmPoolsItem = {
  id: string;
  mintProgramIdA: string;
  mintProgramIdB: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  mintDecimalsA: number;
  mintDecimalsB: number;
  ammConfig: ApiClmmConfig;
  rewardInfos: { mint: string; programId: string }[];
  tvl: number;
  day: ApiClmmPoolsStats;
  week: ApiClmmPoolsStats;
  month: ApiClmmPoolsStats;
  lookupTableAccount: string;
  [key: string]: unknown;
};

type Cached<T> = { ts: number; value: T };
const API_CACHE_TTL_MS = Number(process.env.RAYDIUM_CLMM_API_TTL_MS ?? 60_000);
const POOL_INFO_TTL_MS = Number(process.env.RAYDIUM_CLMM_POOLINFO_TTL_MS ?? 5_000);
const TICK_ARRAY_TTL_MS = Number(process.env.RAYDIUM_CLMM_TICKARRAY_TTL_MS ?? 3_000);
const EPOCH_TTL_MS = Number(process.env.CLMM_EPOCH_TTL_MS ?? 15_000);
const MINTINFO_TTL_MS = Number(process.env.CLMM_MINTINFO_TTL_MS ?? 600_000);

let apiCache: Cached<Map<string, ApiClmmPoolsItem>> | null = null;
const poolInfoCache = new Map<string, Cached<ClmmPoolInfo>>();
const tickArrayCache = new Map<string, Cached<Record<string, any>>>();
let epochCache: Cached<any> | null = null;
const mintInfoCache = new Map<string, Cached<any>>();
const inflightPromises = new Map<string, Promise<any>>();

async function loadApiPool(poolId: string): Promise<ApiClmmPoolsItem> {
  const now = Date.now();
  if (!apiCache || now - apiCache.ts > API_CACHE_TTL_MS) {
    const res = await fetch(RAYDIUM_CLMM_API);
    if (!res.ok) throw new Error(`raydium_clmm_api_${res.status}`);
    const json: any = await res.json();
    const list: ApiClmmPoolsItem[] = Array.isArray(json?.data) ? json.data : [];
    apiCache = { ts: now, value: new Map(list.map((item) => [String(item.id), item])) };
  }
  const hit = apiCache.value.get(poolId);
  if (!hit) throw new Error(`raydium_clmm_pool_not_found_${poolId}`);
  return hit;
}

async function withInflight<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflightPromises.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fetcher().finally(() => inflightPromises.delete(key));
  inflightPromises.set(key, promise);
  return promise;
}

async function fetchPoolInfo(poolId: string): Promise<ClmmPoolInfo> {
  const now = Date.now();
  const cached = poolInfoCache.get(poolId);
  if (cached && now - cached.ts <= POOL_INFO_TTL_MS) return cached.value;

  return withInflight(`poolinfo:${poolId}`, async () => {
    const apiPool = await loadApiPool(poolId);
    const infos = await Clmm.fetchMultiplePoolInfos({
      connection: raydiumConn,
      poolKeys: [apiPool],
      chainTime: Math.floor(Date.now() / 1000),
    });
    const wrap = infos?.[poolId];
    if (!wrap?.state) throw new Error("raydium_clmm_pool_info_missing");
    const state: ClmmPoolInfo = wrap.state;
    poolInfoCache.set(poolId, { ts: Date.now(), value: state });
    return state;
  });
}

async function fetchTickArrays(poolId: string, poolInfo: ClmmPoolInfo): Promise<Record<string, any>> {
  const now = Date.now();
  const cached = tickArrayCache.get(poolId);
  if (cached && now - cached.ts <= TICK_ARRAY_TTL_MS) return cached.value;

  return withInflight(`tick:${poolId}`, async () => {
    const map = await Clmm.fetchMultiplePoolTickArrays({
      connection: raydiumConn,
      poolKeys: [poolInfo],
      batchRequest: true,
    });
    const perPool = map?.[poolId];
    if (!perPool || Object.keys(perPool).length === 0) throw new Error("raydium_clmm_tick_arrays_missing");
    tickArrayCache.set(poolId, { ts: Date.now(), value: perPool });
    return perPool;
  });
}

async function fetchEpochInfo(): Promise<any> {
  const now = Date.now();
  if (epochCache && now - epochCache.ts <= EPOCH_TTL_MS) return epochCache.value;
  return withInflight("epoch", async () => {
    const info = await raydiumConn.getEpochInfo();
    epochCache = { ts: Date.now(), value: info };
    return info;
  });
}

async function fetchMintInfos(mints: PublicKey[]): Promise<Record<string, any>> {
  const need: PublicKey[] = [];
  const now = Date.now();
  for (const mint of mints) {
    const key = mint.toBase58();
    const cached = mintInfoCache.get(key);
    if (!cached || now - cached.ts > MINTINFO_TTL_MS) need.push(mint);
  }
  if (need.length) {
    const fetched = await fetchMultipleMintInfos({ connection: raydiumConn, mints: need });
    const stamp = Date.now();
    for (const [mint, info] of Object.entries(fetched ?? {})) {
      mintInfoCache.set(mint, { ts: stamp, value: info });
    }
  }
  const out: Record<string, any> = {};
  for (const mint of mints) {
    const key = mint.toBase58();
    const cached = mintInfoCache.get(key);
    if (cached) out[key] = cached.value;
  }
  return out;
}

function resolveOrientation(poolInfo: ClmmPoolInfo, baseMint?: string, _quoteMint?: string) {
  const mintA = poolInfo.mintA.mint.toBase58();
  const mintB = poolInfo.mintB.mint.toBase58();
  const baseIsA = baseMint ? strEq(baseMint, mintA) : true;
  const baseIsB = baseMint ? strEq(baseMint, mintB) : false;
  if (!baseIsA && !baseIsB) {
    // fallback: assume mintA is base
    return {
      baseIsA: true,
      baseMintPk: poolInfo.mintA.mint,
      quoteMintPk: poolInfo.mintB.mint,
      baseDecimals: poolInfo.mintA.decimals,
      quoteDecimals: poolInfo.mintB.decimals,
    };
  }
  if (baseIsA) {
    return {
      baseIsA: true,
      baseMintPk: poolInfo.mintA.mint,
      quoteMintPk: poolInfo.mintB.mint,
      baseDecimals: poolInfo.mintA.decimals,
      quoteDecimals: poolInfo.mintB.decimals,
    };
  }
  return {
    baseIsA: false,
    baseMintPk: poolInfo.mintB.mint,
    quoteMintPk: poolInfo.mintA.mint,
    baseDecimals: poolInfo.mintB.decimals,
    quoteDecimals: poolInfo.mintA.decimals,
  };
}

export async function quoteRaydiumClmm(args: QuoteArgs): Promise<QuoteResult> {
  const local = quoteFromReserves(args);
  if (local) return local;

  const key = cacheKey(args);
  const cached = getCachedQuote(key);
  if (cached) {
    logger.log("clmm_quote_cache_hit", { venue: args.venue ?? "raydium", pool: args.poolId, side: args.side, size_base: args.sizeBase });
    return cached;
  }

  // Soft block in snapshot-only mode
  {
    const soft = snapshotOnlyBlock(args.venue ?? "raydium", args.poolId, args.side, args.sizeBase);
    if (soft) return soft;
  }

  try {
    if (!ENABLE_RAYDIUM_CLMM && (args.venue ?? "raydium").toLowerCase() === "raydium") {
      return { ok: false, err: "raydium_clmm_disabled" };
    }
    if (!(args.sizeBase > 0)) return { ok: false, err: "size_not_positive" };

    const poolInfo = await fetchPoolInfo(args.poolId);
    const tickArrays = await fetchTickArrays(args.poolId, poolInfo);
    const epochInfo = await fetchEpochInfo();

    const { baseIsA, baseMintPk, baseDecimals, quoteDecimals } = resolveOrientation(
      poolInfo,
      args.baseMint,
      args.quoteMint
    );

    const token2022Mints: PublicKey[] = [];
    if (poolInfo.mintA.programId.equals(TOKEN_2022_PROGRAM_ID)) token2022Mints.push(poolInfo.mintA.mint);
    if (poolInfo.mintB.programId.equals(TOKEN_2022_PROGRAM_ID)) token2022Mints.push(poolInfo.mintB.mint);
    const token2022Infos = token2022Mints.length ? await fetchMintInfos(token2022Mints) : {};

    const slippage = clampSlippage(args.slippageBps);

    if (args.side === "sell") {
      const amountIn = uiToBn(args.sizeBase, baseDecimals);
      const computeOut = Clmm.computeAmountOut({
        poolInfo,
        tickArrayCache: tickArrays,
        baseMint: baseMintPk,
        amountIn,
        slippage,
        priceLimit: undefined,
        token2022Infos,
        epochInfo,
        catchLiquidityInsufficient: true,
      });
      const realInAtoms: BN = computeOut.realAmountIn.amount;
      const outAtoms: BN = computeOut.amountOut.amount;
      if (realInAtoms.isZero() || outAtoms.isZero()) return { ok: false, err: "raydium_clmm_zero_result" };

      const inUi = bnToUi(realInAtoms, baseDecimals);
      const outUi = bnToUi(outAtoms, quoteDecimals);
      if (inUi.lte(0) || outUi.lte(0)) return { ok: false, err: "raydium_clmm_invalid_ratio" };

      const price = outUi.div(inUi).toNumber();
      if (!Number.isFinite(price) || price <= 0) return { ok: false, err: "raydium_clmm_price_nan" };

      const feeBps =
        calcFeeBps(computeOut.fee, realInAtoms) ||
        args.feeBpsHint ||
        Math.round((poolInfo.ammConfig?.tradeFeeRate ?? 0) * 10_000);

      const meta = {
        mode: "computeAmountOut",
        priceImpactBps: (() => {
          try {
            const exec = new Decimal(computeOut.executionPrice.toString());
            const mid = baseIsA
              ? new Decimal(poolInfo.currentPrice.toString())
              : new Decimal(1).div(poolInfo.currentPrice.toString());
            return exec.div(mid).minus(1).mul(10_000).toNumber();
          } catch {
            return undefined;
          }
        })(),
        usedTickArrays: Object.keys(tickArrays ?? {}).length,
      };

      const quoteResult: QuoteResult = { ok: true, price, feeBps, meta };
      rememberQuote(key, quoteResult);
      return quoteResult;
    }

    // BUY: need exact-out (base out, quote in)
    const amountOut = uiToBn(args.sizeBase, baseDecimals);
    const computeIn = Clmm.computeAmountIn({
      poolInfo,
      tickArrayCache: tickArrays,
      baseMint: baseMintPk,
      amountOut,
      slippage,
      priceLimit: undefined,
      token2022Infos,
      epochInfo,
    });

    const inAtoms: BN = computeIn.amountIn.amount;
    const realOutAtoms: BN = computeIn.realAmountOut.amount;
    if (inAtoms.isZero() || realOutAtoms.isZero()) return { ok: false, err: "raydium_clmm_zero_result" };

    const inUi = bnToUi(inAtoms, quoteDecimals);
    const outUi = bnToUi(realOutAtoms, baseDecimals);
    if (inUi.lte(0) || outUi.lte(0)) return { ok: false, err: "raydium_clmm_invalid_ratio" };

    const price = inUi.div(outUi).toNumber();
    if (!Number.isFinite(price) || price <= 0) return { ok: false, err: "raydium_clmm_price_nan" };

    const feeBps =
      calcFeeBps(computeIn.fee, inAtoms) ||
      args.feeBpsHint ||
      Math.round((poolInfo.ammConfig?.tradeFeeRate ?? 0) * 10_000);

    const meta = {
      mode: "computeAmountIn",
      priceImpactBps: (() => {
        try {
          const exec = new Decimal(computeIn.executionPrice.toString());
          const mid = baseIsA
            ? new Decimal(poolInfo.currentPrice.toString())
            : new Decimal(1).div(poolInfo.currentPrice.toString());
          return exec.div(mid).minus(1).mul(10_000).toNumber();
        } catch {
          return undefined;
        }
      })(),
      usedTickArrays: Object.keys(tickArrays ?? {}).length,
    };

    const quoteResult: QuoteResult = { ok: true, price, feeBps, meta };
    rememberQuote(key, quoteResult);
    return quoteResult;
  } catch (err: any) {
    if (isRateLimitError(err)) {
      logger.log("raydium_clmm_rate_limited", {
        pool: args.poolId,
        side: args.side,
        err: String(err?.message ?? err),
      });
      return { ok: false, err: "rate_limited" };
    }
    logger.log("raydium_clmm_quote_error", {
      pool: args.poolId,
      side: args.side,
      size_base: args.sizeBase,
      err: String(err?.message ?? err)
    },
    );
    return { ok: false, err: String(err?.message ?? err) };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Orca Whirlpool support
// ────────────────────────────────────────────────────────────────────────────

class ReadonlyWallet {
  constructor(public publicKey: PublicKey) { }
  get payer(): Keypair { return Keypair.generate(); }
  async signTransaction<T>(tx: T): Promise<T> { return tx; }
  async signAllTransactions<T>(txs: T[]): Promise<T[]> { return txs; }
}

let orcaCtxCache: Promise<{ ctx: WhirlpoolContext; programId: PublicKey }> | null = null;
let orcaClientCache: Promise<ReturnType<typeof buildWhirlpoolClient>> | null = null;
const ORCA_ABSURD_IMPACT_BPS = Number(process.env.ORCA_ABSURD_IMPACT_BPS ?? 100_000);

async function getOrcaContext(): Promise<{ ctx: WhirlpoolContext; client: ReturnType<typeof buildWhirlpoolClient>; programId: PublicKey }> {
  if (!orcaCtxCache) {
    orcaCtxCache = (async () => {
      const programIdStr = String(
        process.env.ORCA_WHIRLPOOL_PROGRAM_ID ?? process.env.ORCA_PROGRAM_ID ?? ""
      ).trim();
      const fallbackProgram = "whirLb9pD8Yuj9THidbDscK2y3pAC9hRP9hk7xTzSEn";
      const programId = new PublicKey(programIdStr || fallbackProgram);
      const wallet = new ReadonlyWallet(Keypair.generate().publicKey);
      const provider = new AnchorProvider(orcaConn, wallet as any, AnchorProvider.defaultOptions());
      const ctx = WhirlpoolContext.withProvider(provider, programId);
      return { ctx, programId };
    })();
  }
  const { ctx, programId } = await orcaCtxCache;
  if (!orcaClientCache) {
    orcaClientCache = Promise.resolve(buildWhirlpoolClient(ctx));
  }
  const client = await orcaClientCache;
  return { ctx, client, programId };
}

const whirlpoolCache = new Map<string, Cached<any>>();
const WHIRLPOOL_TTL_MS = Number(process.env.ORCA_WHIRLPOOL_TTL_MS ?? 4_000);

async function getWhirlpool(poolId: string) {
  const now = Date.now();
  const cached = whirlpoolCache.get(poolId);
  if (cached && now - cached.ts <= WHIRLPOOL_TTL_MS) return cached.value;

  const { client } = await getOrcaContext();
  const whirlpool = await client.getPool(new PublicKey(poolId));
  whirlpoolCache.set(poolId, { ts: Date.now(), value: whirlpool });
  return whirlpool;
}

export async function quoteOrcaWhirlpool(args: QuoteArgs): Promise<QuoteResult> {
  const local = quoteFromReserves(args);
  if (local) return local;

  const key = cacheKey(args);
  const cached = getCachedQuote(key);
  if (cached) {
    logger.log("clmm_quote_cache_hit", { venue: args.venue ?? "orca", pool: args.poolId, side: args.side, size_base: args.sizeBase });
    return cached;
  }

  // Soft block in snapshot-only mode
  {
    const soft = snapshotOnlyBlock(args.venue ?? "orca", args.poolId, args.side, args.sizeBase);
    if (soft) return soft;
  }

  try {
    if (!(args.sizeBase > 0)) return { ok: false, err: "size_not_positive" };
    const whirlpool = await getWhirlpool(args.poolId);
    const data = whirlpool.getData();
    const tokenA = whirlpool.getTokenAInfo();
    const tokenB = whirlpool.getTokenBInfo();

    const baseIsA = args.baseMint ? strEq(args.baseMint, tokenA.mint.toBase58()) : true;
    const baseIsB = args.baseMint ? strEq(args.baseMint, tokenB.mint.toBase58()) : false;

    const baseToken = baseIsA ? tokenA : baseIsB ? tokenB : tokenA;
    const quoteToken = baseIsA ? tokenB : tokenA;

    const baseDecimals = baseToken.decimals;
    const quoteDecimals = quoteToken.decimals;

    const amountBN = uiToBn(args.sizeBase, baseDecimals);
    if (amountBN.isZero()) return { ok: false, err: "orca_amount_underflow" };

    const { ctx, programId } = await getOrcaContext();
    const slippage = Percentage.fromFraction(Math.max(0, Math.round(args.slippageBps)), 10_000);

    if (args.side === "sell") {
      const inputMint = baseToken.mint;
      const quote = await swapQuoteByInputToken(
        whirlpool,
        inputMint,
        amountBN,
        slippage,
        programId,
        ctx.fetcher,
        undefined,
        UseFallbackTickArray.Situational
      );

      const inAtoms = quote.estimatedAmountIn;
      const outAtoms = quote.estimatedAmountOut;
      if (inAtoms.isZero() || outAtoms.isZero()) return { ok: false, err: "orca_zero_result" };

      const inUi = bnToUi(inAtoms, baseDecimals);
      const outUi = bnToUi(outAtoms, quoteDecimals);
      const price = outUi.div(inUi).toNumber();
      if (!Number.isFinite(price) || price <= 0) return { ok: false, err: "orca_price_nan" };

      const feeBps = calcFeeBps(quote.estimatedFeeAmount, inAtoms) || args.feeBpsHint || 0;

      const meta = {
        priceImpactBps: (() => {
          try {
            const sqrtPrice = new Decimal(data.sqrtPrice.toString());
            const currentPrice = sqrtPrice.pow(2).div(new Decimal(2).pow(128));
            const execPrice = outUi.div(inUi);
            return execPrice.div(currentPrice).minus(1).mul(10_000).toNumber();
          } catch {
            return undefined;
          }
        })(),
        estimatedEndTick: quote.estimatedEndTickIndex,
      };

      const impact = typeof meta.priceImpactBps === "number" ? meta.priceImpactBps : null;
      if (impact != null && Math.abs(impact) > ORCA_ABSURD_IMPACT_BPS) {
        logger.log("orca_whirlpool_quote_rejected", {
          pool: args.poolId,
          side: args.side,
          size_base: args.sizeBase,
          reason: "absurd_price_impact",
          price_impact_bps: impact,
          estimated_end_tick: meta.estimatedEndTick,
        });
        return {
          ok: false,
          err: "missing_tick_array",
          meta: {
            priceImpactBps: impact,
            estimatedEndTick: meta.estimatedEndTick,
          },
        };
      }

      const quoteResult: QuoteResult = { ok: true, price, feeBps, meta };
      rememberQuote(key, quoteResult);
      return quoteResult;
    }

    // BUY: need exact-out (base out)
    const outputMint = baseToken.mint;
    const quote = await swapQuoteByOutputToken(
      whirlpool,
      outputMint,
      amountBN,
      slippage,
      programId,
      ctx.fetcher,
      undefined,
      UseFallbackTickArray.Situational
    );

    const inAtoms = quote.estimatedAmountIn;
    const outAtoms = quote.estimatedAmountOut;
    if (inAtoms.isZero() || outAtoms.isZero()) return { ok: false, err: "orca_zero_result" };

    const inUi = bnToUi(inAtoms, quoteDecimals);
    const outUi = bnToUi(outAtoms, baseDecimals);
    const price = inUi.div(outUi).toNumber();
    if (!Number.isFinite(price) || price <= 0) return { ok: false, err: "orca_price_nan" };

    const feeBps = calcFeeBps(quote.estimatedFeeAmount, inAtoms) || args.feeBpsHint || 0;

    const meta = {
      priceImpactBps: (() => {
        try {
          const sqrtPrice = new Decimal(data.sqrtPrice.toString());
          const currentPrice = sqrtPrice.pow(2).div(new Decimal(2).pow(128));
          const execPrice = inUi.div(outUi);
          return execPrice.div(currentPrice).minus(1).mul(10_000).toNumber();
        } catch {
          return undefined;
        }
      })(),
      estimatedEndTick: quote.estimatedEndTickIndex,
    };

    const impact = typeof meta.priceImpactBps === "number" ? meta.priceImpactBps : null;
    if (impact != null && Math.abs(impact) > ORCA_ABSURD_IMPACT_BPS) {
      logger.log("orca_whirlpool_quote_rejected", {
        pool: args.poolId,
        side: args.side,
        size_base: args.sizeBase,
        reason: "absurd_price_impact",
        price_impact_bps: impact,
        estimated_end_tick: meta.estimatedEndTick,
      });
      return {
        ok: false,
        err: "missing_tick_array",
        meta: {
          priceImpactBps: impact,
          estimatedEndTick: meta.estimatedEndTick,
        },
      };
    }

    const quoteResult: QuoteResult = { ok: true, price, feeBps, meta };
    rememberQuote(key, quoteResult);
    return quoteResult;
  } catch (err: any) {
    if (isRateLimitError(err)) {
      logger.log("orca_whirlpool_rate_limited", {
        pool: args.poolId,
        side: args.side,
        err: String(err?.message ?? err),
      });
      return { ok: false, err: "rate_limited" };
    }
    logger.log("orca_whirlpool_quote_error", {
      pool: args.poolId,
      side: args.side,
      size_base: args.sizeBase,
      err: String(err?.message ?? err),
    });
    return { ok: false, err: String(err?.message ?? err) };
  }
}

// Convenience dispatcher for future pool types
const HANDLERS: Record<string, (args: QuoteArgs) => Promise<QuoteResult>> = {
  "raydium:clmm": quoteRaydiumClmm,
  "orca:clmm": quoteOrcaWhirlpool,
};

export async function quoteClmm(args: QuoteArgs & { venue: string; poolKind?: string }): Promise<QuoteResult> {
  const key = `${args.venue.toLowerCase()}:${String(args.poolKind ?? "clmm").toLowerCase()}`;
  const handler = HANDLERS[key];
  if (!handler) return { ok: false, err: `unsupported_clmm_handler_${key}` };

  const rlKey = rateLimitKey(args.venue, args.poolId);
  const cooldown = shouldSkipForCooldown(rlKey);
  if (cooldown.active) {
    return {
      ok: false,
      err: "rate_limited_cooldown",
      meta: { wait_ms: cooldown.remaining },
    };
  }

  let res: QuoteResult;
  try {
    res = await handler(args);
  } catch (err) {
    const msg = String((err as any)?.message ?? err);
    if (isRateLimitError(err)) {
      markRateLimited(rlKey);
      logger.log("clmm_quote_handler_error", { venue: args.venue, pool: args.poolId, side: args.side, err: msg, rate_limited: true });
      return { ok: false, err: "rate_limited", meta: { source: "handler_throw" } };
    }
    logger.log("clmm_quote_handler_error", { venue: args.venue, pool: args.poolId, side: args.side, err: msg });
    return { ok: false, err: msg };
  }
  if (!res.ok && res.err === "rate_limited") {
    markRateLimited(rlKey);
    return res;
  }
  if (res.ok) clearRateLimit(rlKey);
  return res;
}
