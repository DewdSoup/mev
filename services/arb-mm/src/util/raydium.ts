// services/arb-mm/src/util/raydium.ts
// Real AmmV4 swap builder that loads pre-dumped pool keys (configs/raydium.pool.json)
// Accurate minOut handling: SDK compute when available; CPMM math fallback otherwise.
// Compatible with @raydium-io/raydium-sdk 1.3.1-beta.58.

import fs from "fs";
import path from "path";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {
  Liquidity,
  MAINNET_PROGRAM_ID,
  Token,
  TokenAmount,
  Percent,
} from "@raydium-io/raydium-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export const CPMM_PROGRAM_ID = MAINNET_PROGRAM_ID.AmmV4;
export const SOL_MINT = new PublicKey(
  process.env.SOL_MINT ?? "So11111111111111111111111111111111111111112"
);
export const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
export const DEFAULT_SOL_USDC_POOL = new PublicKey(
  process.env.RAYDIUM_POOL_ID ?? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
);

function makeConn() {
  const url = process.env.RPC_URL || clusterApiUrl("mainnet-beta");
  return new Connection(url, "processed");
}

/* ───────────────────────────── Pool keys normalization ───────────────────────────── */

function normalizePoolKeys(raw: any) {
  // Accept both legacy and v4 field names; map to what SDK expects (string values).
  const out: any = { ...raw };
  if (!out.authority && raw.ammAuthority) out.authority = raw.ammAuthority;
  if (!out.openOrders && raw.ammOpenOrders) out.openOrders = raw.ammOpenOrders;
  if (!out.targetOrders && raw.ammTargetOrders) out.targetOrders = raw.ammTargetOrders;

  if (!out.baseVault && raw.poolCoinTokenAccount) out.baseVault = raw.poolCoinTokenAccount;
  if (!out.quoteVault && raw.poolPcTokenAccount) out.quoteVault = raw.poolPcTokenAccount;

  if (!out.withdrawQueue && raw.poolWithdrawQueue) out.withdrawQueue = raw.poolWithdrawQueue;
  if (!out.lpVault && raw.poolTempLpTokenAccount) out.lpVault = raw.poolTempLpTokenAccount;

  if (!out.marketProgramId && raw.serumProgramId) out.marketProgramId = raw.serumProgramId;
  if (!out.marketId && raw.serumMarket) out.marketId = raw.serumMarket;
  if (!out.marketBids && raw.serumBids) out.marketBids = raw.serumBids;
  if (!out.marketAsks && raw.serumAsks) out.marketAsks = raw.serumAsks;
  if (!out.marketEventQueue && raw.serumEventQueue) out.marketEventQueue = raw.serumEventQueue;
  if (!out.marketBaseVault && raw.serumCoinVaultAccount) out.marketBaseVault = raw.serumCoinVaultAccount;
  if (!out.marketQuoteVault && raw.serumPcVaultAccount) out.marketQuoteVault = raw.serumPcVaultAccount;
  if (!out.marketAuthority && raw.serumVaultSigner) out.marketAuthority = raw.serumVaultSigner;

  const required = [
    "id","programId","authority","openOrders","targetOrders",
    "baseVault","quoteVault",
    "marketProgramId","marketId","marketBids","marketAsks","marketEventQueue",
    "marketBaseVault","marketQuoteVault","marketAuthority",
    "baseMint","quoteMint"
  ];
  for (const k of required) if (!out[k]) throw new Error(`raydium.pool.json missing required key: ${k}`);
  return out;
}

function toPubkeyFields(obj: any) {
  // Convert expected fields from string → PublicKey for the SDK.
  const fields = [
    "id","programId","authority","openOrders","targetOrders",
    "baseVault","quoteVault","withdrawQueue","lpVault",
    "marketProgramId","marketId","marketBids","marketAsks","marketEventQueue",
    "marketBaseVault","marketQuoteVault","marketAuthority",
    "baseMint","quoteMint"
  ];
  const o: any = { ...obj };
  for (const k of fields) if (typeof o[k] === "string") o[k] = new PublicKey(o[k]);
  return o;
}

function loadPoolKeysFromDisk(): any {
  const p = path.resolve(process.cwd(), "configs", "raydium.pool.json");
  if (!fs.existsSync(p)) throw new Error(`Missing configs/raydium.pool.json. Create it before running live.`);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return toPubkeyFields(normalizePoolKeys(raw));
}

/* ───────────────────────────── Helpers: reserves & fees ───────────────────────────── */

function toBigIntLike(v: any): bigint {
  if (v == null) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.floor(v));
  if (typeof v === "string") return BigInt(v);
  if (typeof v?.toString === "function") return BigInt(v.toString());
  return 0n;
}

/** Try multiple common field names across SDK variants to extract reserves in atoms. */
function extractReserves(poolInfo: any): { base: bigint; quote: bigint } | null {
  const candidatesBase = ["baseReserve","baseAmount","coinReserve","coinAmount","baseTotal"];
  const candidatesQuote = ["quoteReserve","quoteAmount","pcReserve","pcAmount","quoteTotal"];
  let base = 0n, quote = 0n;
  for (const k of candidatesBase) { if (poolInfo?.[k] != null) { base = toBigIntLike(poolInfo[k]); break; } }
  for (const k of candidatesQuote){ if (poolInfo?.[k] != null) { quote = toBigIntLike(poolInfo[k]); break; } }
  if (base > 0n && quote > 0n) return { base, quote };
  return null;
}

/** Extract trade fee in BPS (basis points) from poolInfo.fees or top-level fields. */
function extractFeeBps(poolInfo: any): number | null {
  // common patterns
  const f = poolInfo?.fees ?? poolInfo;
  // exact bps field
  if (typeof f?.tradeFeeBps === "number") return Math.max(0, Math.floor(f.tradeFeeBps));
  // numerator/denominator
  const num = f?.tradeFeeNumerator ?? f?.tradeFee?.numerator ?? f?.tradeFeeRate?.numerator;
  const den = f?.tradeFeeDenominator ?? f?.tradeFee?.denominator ?? f?.tradeFeeRate?.denominator;
  if (num != null && den) {
    const n = Number(num), d = Number(den);
    if (isFinite(n) && isFinite(d) && d > 0) return Math.max(0, Math.floor((n * 10000) / d));
  }
  // decimal rate (0.xx)
  const rate = f?.tradeFeeRate;
  if (typeof rate === "number" && isFinite(rate)) return Math.max(0, Math.floor(rate * 10000));
  return null;
}

/** CPMM dy = y - k/(x+dx_eff), with fee applied on input. All in atoms (bigint). */
function cpmmMinOutAtoms(params: {
  baseIn: boolean;
  dxAtoms: bigint;
  reserves: { base: bigint; quote: bigint };
  feeBps: number;
  slippageBps: number;
}): bigint {
  const { baseIn, dxAtoms, reserves, feeBps, slippageBps } = params;
  const x0 = baseIn ? reserves.base : reserves.quote; // input reserve
  const y0 = baseIn ? reserves.quote : reserves.base; // output reserve
  if (dxAtoms <= 0n || x0 <= 0n || y0 <= 0n) return 0n;

  // Apply fee on input: dx_eff = floor(dx * (10000 - feeBps) / 10000)
  const dxEff = (dxAtoms * BigInt(10000 - Math.max(0, feeBps))) / 10000n;

  // dy = y0 - floor( (x0*y0) / (x0 + dxEff) )
  const k = x0 * y0;
  const denom = x0 + dxEff;
  if (denom === 0n) return 0n;
  const yAfter = k / denom;
  const dy = y0 > yAfter ? (y0 - yAfter) : 0n;

  // Apply slippage buffer: floor(dy * (10000 - slippageBps) / 10000)
  const dyMin = (dy * BigInt(10000 - Math.max(0, slippageBps))) / 10000n;
  return dyMin > 0n ? dyMin : 0n;
}

/* ───────────────────────────── Builder ───────────────────────────── */

type BuildParams = {
  user: PublicKey;
  poolId: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseIn: boolean;       // true = SOL->USDC; false = USDC->SOL
  amountInBase: bigint;  // atoms of *input* mint for this swap
  slippageBps: number;
};
export type CpmmIxBuildResult =
  | { ok: true; ixs: TransactionInstruction[] }
  | { ok: false; reason: string };

export async function buildRaydiumSwapFixedInIxAsync(
  params: BuildParams
): Promise<CpmmIxBuildResult> {
  try {
    const connection = makeConn();
    const poolKeys = loadPoolKeysFromDisk();

    // Tokens (decimals: SOL 9, USDC 6) — object-form for SDK compatibility
    const baseToken = new (Token as any)({ mint: params.baseMint, decimals: 9, symbol: "SOL", name: "SOL" });
    const quoteToken = new (Token as any)({ mint: params.quoteMint, decimals: 6, symbol: "USDC", name: "USDC" });

    const inToken  = params.baseIn ? baseToken : quoteToken;
    const outToken = params.baseIn ? quoteToken : baseToken;

    const amountIn = new TokenAmount(inToken, params.amountInBase.toString(), true);

    // ATAs (pass actual PublicKeys; do NOT use inToken.mint due to SDK typing)
    const ataIn  = getAssociatedTokenAddressSync(params.baseIn ? SOL_MINT : USDC_MINT, params.user);
    const ataOut = getAssociatedTokenAddressSync(params.baseIn ? USDC_MINT : SOL_MINT, params.user);

    // Pool info (for slippage calc / CPMM fallback)
    const poolInfo = await (Liquidity as any).fetchInfo({ connection, poolKeys });

    // Try SDK compute first (variant-safe)
    let amountOutMin: any = undefined;
    try {
      const out = (Liquidity as any).computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn,
        currencyOut: outToken,
        slippage: new Percent(params.slippageBps, 10_000),
      });
      amountOutMin = out?.minAmountOut ?? out?.amountOutWithSlippage ?? out?.amountOut;
    } catch { /* defer to CPMM fallback */ }

    // CPMM fallback: exact dy from reserves & fee (no shortcuts)
    if (!amountOutMin) {
      const reserves = extractReserves(poolInfo);
      if (!reserves) return { ok: false, reason: "missing_pool_reserves" };

      const feeBps = extractFeeBps(poolInfo);
      if (feeBps == null) return { ok: false, reason: "missing_trade_fee" };

      const dyMinAtoms = cpmmMinOutAtoms({
        baseIn: params.baseIn,
        dxAtoms: params.amountInBase,
        reserves,
        feeBps,
        slippageBps: params.slippageBps,
      });
      if (dyMinAtoms <= 0n) return { ok: false, reason: "min_out_zero" };

      amountOutMin = new TokenAmount(outToken, dyMinAtoms.toString(), true);
    }

    // Build instruction(s)
    const { innerTransactions } = await (Liquidity as any).makeSwapInstructionSimple({
      connection,
      poolKeys,
      userKeys: {
        owner: params.user,
        tokenAccounts: [{ pubkey: ataIn }, { pubkey: ataOut }],
      },
      amountIn,
      amountOutMin,
      fixedSide: "in",
      makeTxVersion: undefined,
    });

    const ixs: TransactionInstruction[] = innerTransactions?.[0]?.instructions ?? [];
    if (!ixs.length) return { ok: false, reason: "raydium_sdk_returned_no_instructions" };

    return { ok: true, ixs };
  } catch (e: any) {
    return { ok: false, reason: `raydium_swap_build_error: ${String(e?.message ?? e)}` };
  }
}
