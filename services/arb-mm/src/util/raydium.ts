// services/arb-mm/src/util/raydium.ts
// Raydium CPMM live swap builder using on-disk full pool keys (configs/raydium.pool.json).
// Runtime is .env-only. No CLI flags, no guessing.

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

// Optional flags (all default OFF)
const LOG_MINOUT = (process.env.LOG_RAYDIUM_MINOUT ?? "0") === "1";

// ───────────────────────────────────────────────────────────────────────────────
// Pool JSON discovery: multiple sane locations + optional .env override
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

// On-disk JSON shape (matches your full keys file)
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

  // Build then assert via unknown to bypass overly strict SDK typings.
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
// RPC resolver: .env first, then Helius key, then cluster default
function resolveRpc(): string {
  const fromEnv = process.env.RPC_URL?.trim();
  if (fromEnv) return fromEnv;
  const helius = process.env.HELIUS_API_KEY?.trim();
  if (helius) return `https://rpc.helius.xyz/?api-key=${helius}`;
  return clusterApiUrl("mainnet-beta");
}

// Token accounts list for Raydium SDK (with programId included)
async function fetchUserTokenAccounts(conn: Connection, owner: PublicKey) {
  const resp = await conn.getTokenAccountsByOwner(
    owner,
    { programId: TOKEN_PROGRAM_ID },
    "processed"
  );
  return resp.value.map(({ pubkey, account }) => ({
    pubkey,
    programId: TOKEN_PROGRAM_ID,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
  }));
}

// ───────────────────────────────────────────────────────────────────────────────
// CPMM math for minOut (exact formula using current vault balances).

const BPS = 10_000n;

/** Read base/quote vault reserves (atoms) at 'processed' to minimize latency. */
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

/** Integer BPS multiply: floor(x * (BPS - bps) / BPS). */
function applyBpsDown(x: BN, bps: number): BN {
  const b = BigInt(Math.max(0, Math.min(10_000, Math.ceil(bps))));
  const xb = x.mul(new BN(Number(BPS - b)));
  return xb.div(new BN(Number(BPS)));
}

/** CPMM out = (dx*(1-fee) * y) / (x + dx*(1-fee))  with integer math */
function cpmmExpectedOut({
  dx,
  x,
  y,
  feeBps,
}: {
  dx: BN; // input atoms
  x: BN; // input-side reserve
  y: BN; // output-side reserve
  feeBps: number;
}): BN {
  const dxLessFee = applyBpsDown(dx, feeBps);
  const numerator = dxLessFee.mul(y);
  const denominator = x.add(dxLessFee);
  if (denominator.isZero()) throw new Error("cpmm_denominator_zero");
  return numerator.div(denominator);
}

/** Compute minOut BN given current vault reserves + env slippage. */
async function computeMinOutBn(opts: {
  conn: Connection;
  pool: LiquidityPoolKeys;
  baseIn: boolean;
  amountIn: BN;
  slippageBps: number; // from .env (MAX_SLIPPAGE_BPS)
}): Promise<{
  expectedOut: BN;
  minOut: BN;
  usedFeeBps: number;
  usedSlipBps: number;
}> {
  const { conn, pool, baseIn, amountIn, slippageBps } = opts;

  // Try to get a fee override from env (default 25 bps which is Raydium CPMM standard).
  const feeBpsEnv = Number.parseFloat(process.env.RAYDIUM_TRADE_FEE_BPS ?? "25");
  const dynamicExtra = Number.parseFloat(process.env.DYNAMIC_SLIPPAGE_EXTRA_BPS ?? "0");
  const bufferBps = Number.parseFloat(process.env.RAYDIUM_MINOUT_BUFFER_BPS ?? "0");
  const usedSlip = Math.max(0, slippageBps + dynamicExtra + bufferBps);

  const { base, quote } = await getVaultReserves(conn, pool);
  const x = baseIn ? base : quote;
  const y = baseIn ? quote : base;

  const expectedOut = cpmmExpectedOut({
    dx: amountIn,
    x,
    y,
    feeBps: feeBpsEnv,
  });

  const minOut = applyBpsDown(expectedOut, usedSlip);

  if (LOG_MINOUT) {
    // eslint-disable-next-line no-console
    console.log("raydium_min_out", {
      pool: pool.id.toBase58?.() ?? "unknown",
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

// ───────────────────────────────────────────────────────────────────────────────
// Public builder API

export type CpmmIxBuildResult =
  | { ok: true; ixs: TransactionInstruction[] }
  | { ok: false; reason: string };

export async function buildRaydiumSwapFixedInIx(params: {
  user: PublicKey;
  baseIn: boolean;         // true => input is base mint (SOL in SOL/USDC)
  amountInBase: bigint;    // atoms of INPUT mint (executor passes correct side)
  slippageBps: number;     // enforced via on-chain threshold & decision/risk
}): Promise<CpmmIxBuildResult> {
  try {
    // Load full keys and sanity-check env pool id
    const disk = readPoolJson();
    const envAmm = (process.env.RAYDIUM_POOL_ID ?? "").trim();
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

    // Compute minOut using current vault reserves (exact CPMM math).
    const { minOut } = await computeMinOutBn({
      conn,
      pool: poolKeys,
      baseIn: params.baseIn,
      amountIn,
      slippageBps: params.slippageBps,
    });

    // Raydium simple builder — pass both threshold field names (SDK variant-safe).
    const { innerTransactions } = await (Liquidity as any).makeSwapInstructionSimple({
      connection: conn,
      poolKeys,
      userKeys: {
        tokenAccounts: tokenAccounts as any,
        owner: params.user,
        payer: params.user,
      },
      amountIn,
      fixedSide: "in",
      otherAmountThreshold: minOut, // v5+ name
      amountOutMin: minOut,         // older name; harmless on newer when cast as any
    } as any);

    const ixs: TransactionInstruction[] = [];
    for (const itx of innerTransactions ?? []) {
      for (const ix of itx.instructions ?? []) ixs.push(ix);
    }
    if (!ixs.length) {
      return {
        ok: false,
        reason:
          "raydium_swap_build_error: makeSwapInstructionSimple returned no instructions",
      };
    }

    return { ok: true, ixs };
  } catch (e: any) {
    return {
      ok: false,
      reason: `raydium_swap_ix_build_failed: ${String(e?.message ?? e)}`,
    };
  }
}
