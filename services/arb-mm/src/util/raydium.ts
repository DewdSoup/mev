// services/arb-mm/src/util/raydium.ts
// Raydium CPMM live swap builder using on-disk full pool keys (configs/raydium.pool.json).
// Runtime is .env-only. Hardened for Raydium SDK variants.

import fs from "fs";
import path from "path";
import BN from "bn.js";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  Liquidity,
  LiquidityPoolKeys,
  SPL_ACCOUNT_LAYOUT,
  Percent,
  Token,
  TokenAmount,
} from "@raydium-io/raydium-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// ───────────────────────────────────────────────────────────────────────────────
// Env-driven constants (safe defaults; .env overrides)
export const CPMM_PROGRAM_ID = new PublicKey(
  process.env.RAYDIUM_CPMM_PROGRAM_ID ??
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);
export const SOL_MINT = new PublicKey(
  process.env.SOL_MINT ?? "So11111111111111111111111111111111111111112"
);
export const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
export const DEFAULT_SOL_USDC_POOL = new PublicKey(
  process.env.RAYDIUM_POOL_ID ??
    "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
);

// Optional flags (default OFF)
const LOG_MINOUT = (process.env.LOG_RAYDIUM_MINOUT ?? "0") === "1";
const LOG_TOKEN_CTOR = (process.env.LOG_RAYDIUM_TOKEN_CTOR ?? "0") === "1";
const LOG_SWAP_BUILD = (process.env.LOG_RAYDIUM_SWAP_BUILD ?? "0") === "1";

// ───────────────────────────────────────────────────────────────────────────────
// Pool JSON discovery
function findPoolJsonPath(): string {
  const envPath = process.env.RAYDIUM_POOL_JSON_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath);
  const candidates = [
    path.resolve(process.cwd(), "configs", "raydium.pool.json"),
    path.resolve(process.cwd(), "..", "configs", "raydium.pool.json"),
    path.resolve(process.cwd(), "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__dirname, "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__dirname, "..", "..", "..", "configs", "raydium.pool.json"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return "";
}
const POOL_JSON_PATH = findPoolJsonPath();

type DiskPoolKeys = {
  id: string;
  programId: string;
  authority: string;
  openOrders: string;
  targetOrders: string;
  baseVault: string;
  quoteVault: string;
  withdrawQueue: string;
  lpVault: string;
  baseMint: string;
  quoteMint: string;
  marketProgramId: string;
  marketId: string;
  marketBids: string;
  marketAsks: string;
  marketEventQueue: string;
  marketBaseVault: string;
  marketQuoteVault: string;
  marketAuthority?: string;
  lpMint?: string;
  version: 4 | 5 | number;
};

function readPoolJson(): DiskPoolKeys {
  if (!POOL_JSON_PATH) {
    throw new Error(
      "raydium_swap_build_error: Missing configs/raydium.pool.json. " +
        "Set RAYDIUM_POOL_JSON_PATH in .env or place the file in repo root configs/."
    );
  }
  const raw = fs.readFileSync(POOL_JSON_PATH, "utf8");
  const j = JSON.parse(raw) as DiskPoolKeys;

  const req = [
    "id",
    "programId",
    "authority",
    "openOrders",
    "targetOrders",
    "baseVault",
    "quoteVault",
    "withdrawQueue",
    "lpVault",
    "baseMint",
    "quoteMint",
    "marketProgramId",
    "marketId",
    "marketBids",
    "marketAsks",
    "marketEventQueue",
    "marketBaseVault",
    "marketQuoteVault",
    "version",
  ] as const;
  for (const k of req) {
    // @ts-ignore
    if (!j[k]) throw new Error(`raydium_pool_json_invalid: missing ${k}`);
  }
  return j;
}

function toPoolKeys(d: DiskPoolKeys): LiquidityPoolKeys {
  const v = (d.version === 5 ? 5 : 4) as 4 | 5;
  const out = {
    id: new PublicKey(d.id),
    baseMint: new PublicKey(d.baseMint),
    quoteMint: new PublicKey(d.quoteMint),
    lpMint: new PublicKey(d.lpMint ?? d.baseMint), // not used by swap, satisfies type
    version: v,
    programId: new PublicKey(d.programId),
    authority: new PublicKey(d.authority),
    openOrders: new PublicKey(d.openOrders),
    targetOrders: new PublicKey(d.targetOrders),
    baseVault: new PublicKey(d.baseVault),
    quoteVault: new PublicKey(d.quoteVault),

    marketProgramId: new PublicKey(d.marketProgramId),
    marketId: new PublicKey(d.marketId),
    marketBids: new PublicKey(d.marketBids),
    marketAsks: new PublicKey(d.marketAsks),
    marketEventQueue: new PublicKey(d.marketEventQueue),
    marketBaseVault: new PublicKey(d.marketBaseVault),
    marketQuoteVault: new PublicKey(d.marketQuoteVault),

    withdrawQueue: new PublicKey(d.withdrawQueue),
    lpVault: new PublicKey(d.lpVault),

    ...(d.marketAuthority ? { marketAuthority: new PublicKey(d.marketAuthority) } : {}),
  } as unknown as LiquidityPoolKeys;
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// RPC
function resolveRpc(): string {
  const fromEnv = process.env.RPC_URL?.trim() || process.env.RPC_PRIMARY?.trim();
  if (fromEnv) return fromEnv;
  const helius = process.env.HELIUS_API_KEY?.trim();
  if (helius) return `https://rpc.helius.xyz/?api-key=${helius}`;
  return clusterApiUrl("mainnet-beta");
}

async function fetchUserTokenAccounts(conn: Connection, owner: PublicKey) {
  const resp = await conn.getTokenAccountsByOwner(
    owner,
    { programId: TOKEN_PROGRAM_ID },
    "processed"
  );
  return resp.value.map(({ pubkey, account }) => ({
    pubkey,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
  }));
}

// Fetch token decimals (fast path for SOL/USDC; fallback to parsed mint)
async function resolveMintDecimals(conn: Connection, mint: PublicKey): Promise<number> {
  if (mint.equals(SOL_MINT)) return 9;
  if (mint.equals(USDC_MINT)) return 6;
  try {
    const info = await conn.getParsedAccountInfo(mint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dec = (info.value?.data as any)?.parsed?.info?.decimals;
    if (typeof dec === "number") return dec;
  } catch (_) {
    // ignore
  }
  return 9;
}

// ───────────────────────────────────────────────────────────────────────────────
// CPMM math & minOut
const BPS = 10_000n;

async function getVaultReserves(
  conn: Connection,
  pool: LiquidityPoolKeys
): Promise<{ base: BN; quote: BN }> {
  const accs = await conn.getMultipleAccountsInfo(
    [pool.baseVault, pool.quoteVault],
    { commitment: "processed" as any }
  );
  if (!accs[0]?.data || !accs[1]?.data)
    throw new Error("raydium_pool_reserves_missing");

  const baseInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[0].data);
  const quoteInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[1].data);
  return { base: new BN(baseInfo.amount), quote: new BN(quoteInfo.amount) };
}

function applyBpsDown(x: BN, bps: number): BN {
  const b = BigInt(Math.max(0, Math.min(10_000, Math.ceil(bps))));
  const xb = x.mul(new BN(Number(BPS - b)));
  return xb.div(new BN(Number(BPS)));
}

function cpmmExpectedOut({
  dx,
  x,
  y,
  feeBps,
}: {
  dx: BN;
  x: BN;
  y: BN;
  feeBps: number;
}): BN {
  const dxLessFee = applyBpsDown(dx, feeBps);
  const numerator = dxLessFee.mul(y);
  const denominator = x.add(dxLessFee);
  if (denominator.isZero()) throw new Error("cpmm_denominator_zero");
  return numerator.div(denominator);
}

async function computeMinOutBn(opts: {
  conn: Connection;
  pool: LiquidityPoolKeys;
  baseIn: boolean;
  amountIn: BN;
  slippageBps: number;
}): Promise<{
  expectedOut: BN;
  minOut: BN;
  usedFeeBps: number;
  usedSlipBps: number;
}> {
  const { conn, pool, baseIn, amountIn, slippageBps } = opts;
  const feeBpsEnv = Number.parseFloat(process.env.RAYDIUM_TRADE_FEE_BPS ?? "25");
  const dynamicExtra = Number.parseFloat(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? "0");
  const bufferBps = Number.parseFloat(process.env.RAYDIUM_MINOUT_BUFFER_BPS ?? "0");
  const baseSlip = Number.isFinite(slippageBps) ? slippageBps : Number(process.env.AMM_MINOUT_BASE_BPS ?? 50);
  const usedSlip = Math.max(0, baseSlip + dynamicExtra + bufferBps);

  const { base, quote } = await getVaultReserves(conn, pool);
  const x = baseIn ? base : quote;
  const y = baseIn ? quote : base;

  const expectedOut = cpmmExpectedOut({ dx: amountIn, x, y, feeBps: feeBpsEnv });
  const minOut = applyBpsDown(expectedOut, usedSlip);

  if (LOG_MINOUT) {
    // eslint-disable-next-line no-console
    console.log("raydium_min_out", {
      pool: (pool as any).id?.toBase58?.() ?? "unknown",
      dir: baseIn ? "BASE->QUOTE" : "QUOTE->BASE",
      amountIn: amountIn.toString(),
      reserves: { base: base.toString(), quote: quote.toString() },
      expectedOut: expectedOut.toString(),
      minOut: minOut.toString(),
      fee_bps: feeBpsEnv,
      slip_bps: usedSlip,
      note: "cpmm_reserves+env_fee",
    });
  }

  return { expectedOut, minOut, usedFeeBps: feeBpsEnv, usedSlipBps: usedSlip };
}

// Build Percent from bps as integer ppm (handles 50.25 bps safely)
function percentFromBpsFloat(bps: number): Percent {
  const numeratorPpm = Math.round(bps * 100); // e.g. 50.25 bps => 5025
  return new Percent(numeratorPpm.toString(), "1000000");
}

// Use the **diagnosed** Token constructor: (programId, mint, decimals, symbol?, name?)
function makeSdkToken(mint: PublicKey, decimals: number, symbol: string): Token {
  const tok = new (Token as any)(TOKEN_PROGRAM_ID, mint, decimals, symbol, symbol);
  if (LOG_TOKEN_CTOR) {
    // eslint-disable-next-line no-console
    console.log("raydium_token_ctor_variant", {
      symbol,
      address: mint.toBase58(),
      used: "programId,mint,decimals,symbol,name",
    });
  }
  return tok as Token;
}

// ───────────────────────────────────────────────────────────────────────────────
// Public builder API

export type CpmmIxBuildResult =
  | { ok: true; ixs: TransactionInstruction[] }
  | { ok: false; reason: string };

// Tries multiple argument shapes for makeSwapInstructionSimple to support CPMM/CLMM variants.
async function tryBuildSwapIxCompat(argsBase: any) {
  const tries: Array<{ label: string; patch: Record<string, any> }> = [
    // CPMM-style
    { label: "amountOutMin+slippage", patch: { amountOutMin: argsBase._minOutTA, slippage: argsBase._slipPercent } },
    { label: "amountOutMin only",     patch: { amountOutMin: argsBase._minOutTA } },
    // CLMM-style
    { label: "otherAmountThreshold+slippage", patch: { otherAmountThreshold: argsBase._minOutTA, slippage: argsBase._slipPercent } },
    { label: "otherAmountThreshold only",     patch: { otherAmountThreshold: argsBase._minOutTA } },
    // Belt-and-suspenders
    { label: "both+slippage", patch: { amountOutMin: argsBase._minOutTA, otherAmountThreshold: argsBase._minOutTA, slippage: argsBase._slipPercent } },
  ];

  let lastErr: unknown;

  for (const t of tries) {
    try {
      const built = await (Liquidity as any).makeSwapInstructionSimple({
        connection: argsBase.connection,
        poolKeys: argsBase.poolKeys,
        userKeys: argsBase.userKeys,
        fixedSide: "in",
        amountIn: argsBase.amountIn,
        tokenIn: argsBase.tokenIn,
        tokenOut: argsBase.tokenOut,
        ...t.patch,
      });

      const ixs: TransactionInstruction[] = [];
      for (const itx of built?.innerTransactions ?? []) {
        for (const ix of itx?.instructions ?? []) ixs.push(ix);
      }
      if (ixs.length) {
        if (LOG_SWAP_BUILD) {
          // eslint-disable-next-line no-console
          console.log("raydium_swap_build_variant", { used: t.label, ixs: ixs.length });
        }
        return { ok: true as const, ixs };
      }
      lastErr = new Error("no_instructions_returned");
      if (LOG_SWAP_BUILD) {
        // eslint-disable-next-line no-console
        console.warn("raydium_swap_build_variant_empty", { used: t.label });
      }
    } catch (e) {
      lastErr = e;
      if (LOG_SWAP_BUILD) {
        // eslint-disable-next-line no-console
        console.warn("raydium_swap_build_variant_failed", {
          used: t.label,
          err: (e as any)?.message ?? String(e),
        });
      }
    }
  }
  return { ok: false as const, reason: `raydium_swap_ix_build_failed: ${String((lastErr as any)?.message ?? lastErr)}` };
}

export async function buildRaydiumSwapIx(params: {
  user: PublicKey;
  baseIn: boolean;         // true => input is base mint (SOL in SOL/USDC)
  amountInBase: bigint;    // atoms of INPUT mint
  slippageBps: number;     // may be fractional (e.g., 50.25)
}): Promise<CpmmIxBuildResult> {
  try {
    const disk = readPoolJson();
    const envAmm =
      (process.env.RAYDIUM_POOL_ID ?? process.env.RAYDIUM_POOL_ID_SOL_USDC ?? "").trim();
    if (envAmm && envAmm !== disk.id) {
      return {
        ok: false,
        reason: `raydium_swap_build_error: pool id mismatch (env=${envAmm} json=${disk.id})`,
      };
    }
    const poolKeys = toPoolKeys(disk);

    const rpc = resolveRpc();
    const conn = new Connection(rpc, { commitment: "processed" });
    const tokenAccounts = await fetchUserTokenAccounts(conn, params.user);
    const amountIn = new BN(params.amountInBase.toString());

    // decimals -> Token -> TokenAmount for SDK .toFixed() usage
    const [baseDecimals, quoteDecimals] = await Promise.all([
      resolveMintDecimals(conn, poolKeys.baseMint),
      resolveMintDecimals(conn, poolKeys.quoteMint),
    ]);

    const baseToken  = makeSdkToken(poolKeys.baseMint,  baseDecimals,  "BASE");
    const quoteToken = makeSdkToken(poolKeys.quoteMint, quoteDecimals, "QUOTE");

    const tokenIn  = params.baseIn ? baseToken : quoteToken;
    const tokenOut = params.baseIn ? quoteToken : baseToken;

    const { minOut, usedSlipBps } = await computeMinOutBn({
      conn,
      pool: poolKeys,
      baseIn: params.baseIn,
      amountIn,
      slippageBps: params.slippageBps,
    });

    // TokenAmount (raw atom units)
    const amountInTA = new TokenAmount(tokenIn, amountIn.toString(), true);
    const minOutTA   = new TokenAmount(tokenOut, minOut.toString(), true);
    const slipPercent = percentFromBpsFloat(usedSlipBps);

    const baseArgs = {
      connection: conn,
      poolKeys,
      userKeys: { tokenAccounts: tokenAccounts as any, owner: params.user, payer: params.user },
      fixedSide: "in",
      amountIn: amountInTA,
      tokenIn,
      tokenOut,
      _minOutTA: minOutTA,
      _slipPercent: slipPercent,
    };

    const built = await tryBuildSwapIxCompat(baseArgs);
    if (!built.ok) return built;

    return { ok: true, ixs: built.ixs };
  } catch (e: any) {
    const msg = e?.stack || e?.message || String(e);
    return { ok: false, reason: `raydium_swap_ix_build_failed: ${msg}` };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// ★ On-chain fee sanity (best-effort). Returns resolved fee_bps.
// ───────────────────────────────────────────────────────────────────────────────
// util/raydium.ts
export async function tryAssertRaydiumFeeBps(
  connection: Connection,
  poolId: string,
  configuredFeeBps: number
): Promise<number> {
  const wantAssert = process.env.RAYDIUM_ASSERT_FEE === "1";
  if (!wantAssert) return configuredFeeBps;

  try {
    // use the same disk json as the swap builder
    const disk = readPoolJson();
    if (disk.id !== poolId) {
      console.warn("[raydium_fee_check] poolId mismatch env/json", { env: poolId, json: disk.id });
    }
    const poolKeys = toPoolKeys(disk); // full keys with programId, vaults, etc.

    const info = await Liquidity.fetchInfo({ connection, poolKeys });
    const s: any = (info as any)?.state ?? (info as any) ?? {};
    let onchainBps: number | null = null;

    if (typeof s.tradeFeeRate === "number") onchainBps = Math.round(s.tradeFeeRate * 10_000);
    else if (typeof s.swapFeeRate === "number") onchainBps = Math.round(s.swapFeeRate * 10_000);
    else if (typeof s.feeRate === "number") onchainBps = Math.round(s.feeRate);
    else if (typeof s.swapFeeNumerator === "number" && typeof s.swapFeeDenominator === "number" && s.swapFeeDenominator > 0) {
      onchainBps = Math.round((s.swapFeeNumerator / s.swapFeeDenominator) * 10_000);
    }

    if (onchainBps != null && Number.isFinite(onchainBps)) {
      if (onchainBps !== configuredFeeBps) {
        console.warn("[raydium_fee_mismatch] overriding", configuredFeeBps, "→", onchainBps);
        return onchainBps;
      }
      console.info("[raydium_fee_ok]", onchainBps);
      return onchainBps;
    }

    console.warn("[raydium_fee_unknown] keeping configured fee", configuredFeeBps);
    return configuredFeeBps;
  } catch (e) {
    console.warn("[raydium_fee_check_failed] keeping configured fee", configuredFeeBps, String(e));
    return configuredFeeBps;
  }
}

