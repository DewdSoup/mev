import { Connection, PublicKey } from "@solana/web3.js";
import type { AccountInfo } from "@solana/web3.js";
import {
  AccountLayout,
  MintLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import Decimal from "decimal.js";

import { cpmmBuyQuotePerBase, cpmmSellQuotePerBase } from "./cpmm.js";
import { cacheLifinityFee } from "./fee_cache.js";
import { callWithRetry } from "./rpc_backoff.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export const LIFINITY_PROGRAM_ID = new PublicKey(
  process.env.LIFINITY_PROGRAM_ID ?? "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c"
);

const ZERO_PUBKEY = new PublicKey(Buffer.alloc(32));

type LifinityFeesRaw = {
  tradeFeeNumerator: bigint;
  tradeFeeDenominator: bigint;
  ownerTradeFeeNumerator: bigint;
  ownerTradeFeeDenominator: bigint;
  ownerWithdrawFeeNumerator: bigint;
  ownerWithdrawFeeDenominator: bigint;
  hostFeeNumerator: bigint;
  hostFeeDenominator: bigint;
};

type LifinityAccountRaw = {
  authority: PublicKey;
  baseDecimals: number;
  quoteDecimals?: number;
  tokenProgramId: PublicKey;
  tokenAAccount: PublicKey;
  tokenBAccount: PublicKey;
  poolMint: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  feeAccount: PublicKey;
  oracleMainAccount?: PublicKey;
  oracleSubAccount?: PublicKey;
  oraclePcAccount?: PublicKey;
  fees: LifinityFeesRaw;
};

export function decodeLifinityAmmAccount(data: Buffer): LifinityAccountRaw {
  let offset = 0;
  const ensure = (size: number) => {
    if (offset + size > data.length) {
      throw new Error("lifinity: amm account truncated");
    }
  };
  const readPubkey = (): PublicKey => {
    ensure(32);
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };
  const skipPubkey = () => {
    ensure(32);
    offset += 32;
  };
  const readU64 = (): bigint => {
    ensure(8);
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };
  const readU8 = (): number => {
    ensure(1);
    const value = data[offset];
    offset += 1;
    return value;
  };

  // Read initializer/authority, discard remaining setup fields.
  const authority = readPubkey(); // initializerKey
  skipPubkey(); // initializerDepositTokenAccount
  skipPubkey(); // initializerReceiveTokenAccount
  readU64(); // initializerAmount
  readU64(); // takerAmount
  readU8(); // isInitialized
  readU8(); // bumpSeed
  readU8(); // freezeTrade
  readU8(); // freezeDeposit
  readU8(); // freezeWithdraw

  const baseDecimalsLegacy = readU8();
  const quoteDecimalsLegacy = readU8();
  // Lifinity v2 stores additional ramp parameters after the legacy decimals hints.
  // Skip the remaining 7 bytes to realign with the account layout for vault/pubkey fields.
  ensure(7);
  offset += 7;

  const tokenProgramId = readPubkey();
  const tokenAAccount = readPubkey();
  const tokenBAccount = readPubkey();
  const poolMint = readPubkey();
  const tokenAMint = readPubkey();
  const tokenBMint = readPubkey();
  const feeAccount = readPubkey();
  const oracleMainAccount = readPubkey();
  const oracleSubAccount = readPubkey();
  const oraclePcAccount = readPubkey();

  const fees: LifinityFeesRaw = {
    tradeFeeNumerator: readU64(),
    tradeFeeDenominator: readU64(),
    ownerTradeFeeNumerator: readU64(),
    ownerTradeFeeDenominator: readU64(),
    ownerWithdrawFeeNumerator: readU64(),
    ownerWithdrawFeeDenominator: readU64(),
    hostFeeNumerator: readU64(),
    hostFeeDenominator: readU64(),
  };

  return {
    authority,
    baseDecimals: baseDecimalsLegacy,
    quoteDecimals: quoteDecimalsLegacy,
    tokenProgramId,
    tokenAAccount,
    tokenBAccount,
    poolMint,
    tokenAMint,
    tokenBMint,
    feeAccount,
    oracleMainAccount: oracleMainAccount.equals(ZERO_PUBKEY) ? undefined : oracleMainAccount,
    oracleSubAccount: oracleSubAccount.equals(ZERO_PUBKEY) ? undefined : oracleSubAccount,
    oraclePcAccount: oraclePcAccount.equals(ZERO_PUBKEY) ? undefined : oraclePcAccount,
    fees,
  };
}

export type LifinityPoolMeta = {
  poolId: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  poolMint: PublicKey;
  feeAccount: PublicKey;
  authority: PublicKey;
  tokenProgram: PublicKey;
  raw: LifinityAccountRaw;
  oracleMain?: PublicKey;
  oracleSub?: PublicKey;
  oraclePc?: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  feeBps: number;
  baseIsTokenA: boolean;
};

export type LifinitySnapshot = {
  poolId: PublicKey;
  ts: number;
  slot?: number;
  baseReserve: bigint;
  quoteReserve: bigint;
  meta: LifinityPoolMeta;
  vaultSource?: string;
};

const metaCache = new Map<string, LifinityPoolMeta>();
const snapshotCache = new Map<string, LifinitySnapshot>();
const mintDecimalsCache = new Map<string, number>();
const configDecimalHints = new Map<string, number>();

function normalizeDecimalHint(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  if (num < 0) return undefined;
  if (!Number.isInteger(num)) return undefined;
  return num;
}

function recordConfigDecimalHint(mint: PublicKey, hint?: number): void {
  const normalized = normalizeDecimalHint(hint);
  if (normalized == null) return;
  configDecimalHints.set(mint.toBase58(), normalized);
}

function envDecimalOverride(mintKey: string): number | undefined {
  const env = process.env[`MINT_DECIMALS__${mintKey}`];
  if (env == null || env.trim() === "") return undefined;
  return normalizeDecimalHint(env);
}

function toBigInt(value: BN | bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value.toString());
}

function decodeTokenAmount(data: Buffer): bigint {
  const decoded = AccountLayout.decode(data);
  const raw = decoded.amount as unknown;
  if (typeof raw === "bigint") return raw;
  if (BN.isBN(raw)) return BigInt((raw as BN).toString(10));
  if (typeof raw === "number") return BigInt(raw);
  if (typeof raw === "string") return BigInt(raw);
  if (raw && typeof raw === "object" && typeof (raw as { length?: number }).length === "number") {
    const view = Uint8Array.from(raw as any);
    let x = 0n;
    for (let i = 0; i < view.length; i++) {
      x |= BigInt(view[i] ?? 0) << (8n * BigInt(i));
    }
    return x;
  }
  throw new Error("lifinity: unsupported token amount encoding");
}

async function getMintDecimals(
  connection: Connection,
  mint: PublicKey,
  hint?: number
): Promise<number> {
  const key = mint.toBase58();
  if (mintDecimalsCache.has(key)) {
    return mintDecimalsCache.get(key)!;
  }

  recordConfigDecimalHint(mint, hint);
  const envOverride = envDecimalOverride(key);

  let decimals: number | undefined;
  try {
    const info = await connection.getParsedAccountInfo(mint, "processed");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (info.value as any)?.data?.parsed?.info?.decimals;
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      decimals = parsed;
    }
  } catch { /* ignore parsed fallback errors */ }

  if (decimals == null) {
    const info = await connection.getAccountInfo(mint, "processed");
    if (info?.data?.length) {
      try {
        const mintDecoded = MintLayout.decode(info.data);
        const raw = (mintDecoded as any)?.decimals;
        if (typeof raw === "number" && Number.isFinite(raw)) {
          decimals = raw;
        }
      } catch { /* ignore decode errors */ }
    }
  }

  if (decimals == null) {
    const fallback = configDecimalHints.get(key) ?? envOverride;
    if (fallback != null) {
      mintDecimalsCache.set(key, fallback);
      return fallback;
    }
    throw new Error(`lifinity: decimals unavailable for ${mint.toBase58()}`);
  }

  mintDecimalsCache.set(key, decimals);
  return decimals;
}

function computeFeeBps(raw: LifinityFeesRaw): number {
  const tradeNum = toBigInt(raw.tradeFeeNumerator);
  const tradeDen = toBigInt(raw.tradeFeeDenominator);
  const ownerNum = toBigInt(raw.ownerTradeFeeNumerator);
  const ownerDen = toBigInt(raw.ownerTradeFeeDenominator);
  if (tradeDen === 0n) return 0;
  const ownerPortion = ownerDen === 0n ? 0n : (ownerNum * tradeDen) / ownerDen;
  const combined = Number(tradeNum + ownerPortion) / Number(tradeDen);
  return Number.isFinite(combined) ? Math.max(0, Math.round(combined * 10_000)) : 0;
}

export async function loadLifinityPoolMeta(args: {
  connection: Connection;
  poolId: PublicKey;
  expectedBaseMint?: PublicKey;
  expectedQuoteMint?: PublicKey;
  baseDecimalsHint?: number;
  quoteDecimalsHint?: number;
}): Promise<LifinityPoolMeta> {
  const key = args.poolId.toBase58();
  const cached = metaCache.get(key);
  if (cached) return cached;

  const info = await args.connection.getAccountInfo(args.poolId, "processed");
  if (!info) throw new Error(`lifinity: pool ${key} missing`);

  const decoded = decodeLifinityAmmAccount(info.data);

  const tokenAMint = decoded.tokenAMint;
  const tokenBMint = decoded.tokenBMint;

  let baseIsTokenA = true;
  if (args.expectedBaseMint) {
    if (args.expectedBaseMint.equals(tokenBMint)) baseIsTokenA = false;
  } else if (args.expectedQuoteMint) {
    if (args.expectedQuoteMint.equals(tokenAMint)) baseIsTokenA = false;
  }

  const baseMint = baseIsTokenA ? tokenAMint : tokenBMint;
  const quoteMint = baseIsTokenA ? tokenBMint : tokenAMint;
  const baseVault = baseIsTokenA ? decoded.tokenAAccount : decoded.tokenBAccount;
  const quoteVault = baseIsTokenA ? decoded.tokenBAccount : decoded.tokenAAccount;

  const [baseDecimals, quoteDecimals] = await Promise.all([
    getMintDecimals(args.connection, baseMint, args.baseDecimalsHint),
    getMintDecimals(args.connection, quoteMint, args.quoteDecimalsHint),
  ]);

  const meta: LifinityPoolMeta = {
    poolId: args.poolId,
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    poolMint: decoded.poolMint,
    feeAccount: decoded.feeAccount,
    authority: decoded.authority,
    tokenProgram: decoded.tokenProgramId,
    raw: decoded,
    oracleMain: decoded.oracleMainAccount,
    oracleSub: decoded.oracleSubAccount,
    oraclePc: decoded.oraclePcAccount,
    baseDecimals,
    quoteDecimals,
    feeBps: computeFeeBps(decoded.fees),
    baseIsTokenA,
  };

  metaCache.set(key, meta);
  cacheLifinityFee(args.poolId, meta.feeBps);
  return meta;
}

type VaultCandidate = { base: PublicKey; quote: PublicKey; source: string };

function collectVaultCandidates(meta: LifinityPoolMeta): VaultCandidate[] {
  const candidates: VaultCandidate[] = [];
  const seen = new Set<string>();
  const add = (base: PublicKey, quote: PublicKey, source: string) => {
    const key = `${base.toBase58()}|${quote.toBase58()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ base, quote, source });
  };

  add(meta.baseVault, meta.quoteVault, "meta");
  add(meta.raw.tokenAAccount, meta.raw.tokenBAccount, "raw_order");
  add(meta.raw.tokenBAccount, meta.raw.tokenAAccount, "raw_order_flipped");

  const tokenProgram = meta.tokenProgram ?? TOKEN_PROGRAM_ID;
  try {
    const ataTokenA = getAssociatedTokenAddressSync(
      meta.raw.tokenAMint,
      meta.authority,
      true,
      tokenProgram
    );
    const ataTokenB = getAssociatedTokenAddressSync(
      meta.raw.tokenBMint,
      meta.authority,
      true,
      tokenProgram
    );
    if (meta.baseIsTokenA) {
      add(ataTokenA, ataTokenB, "ata_base_token_a");
      add(ataTokenB, ataTokenA, "ata_flipped");
    } else {
      add(ataTokenB, ataTokenA, "ata_base_token_b");
      add(ataTokenA, ataTokenB, "ata_flipped");
    }
  } catch {
    /* ignore ATA derivation errors */
  }

  return candidates;
}

export async function refreshLifinitySnapshot(args: {
  connection: Connection;
  poolId: PublicKey;
  expectedBaseMint?: PublicKey;
  expectedQuoteMint?: PublicKey;
  baseDecimalsHint?: number;
  quoteDecimalsHint?: number;
  slot?: number;
}): Promise<LifinitySnapshot> {
  const meta = await loadLifinityPoolMeta(args);
  const candidates = collectVaultCandidates(meta);

  let baseInfo: AccountInfo<Buffer> | null = null;
  let quoteInfo: AccountInfo<Buffer> | null = null;
  let resolved: VaultCandidate | null = null;

  const poolLabel = `lifinity_get_vaults_${meta.poolId.toBase58()}`;

  for (const candidate of candidates) {
    const infos = await callWithRetry(
      () =>
        args.connection.getMultipleAccountsInfo(
          [candidate.base, candidate.quote],
          "processed"
        ),
      { label: poolLabel }
    );
    const [maybeBase, maybeQuote] = infos ?? [];
    if (maybeBase && maybeQuote) {
      baseInfo = maybeBase;
      quoteInfo = maybeQuote;
      resolved = candidate;
      break;
    }
  }

  if (!baseInfo || !quoteInfo || !resolved) {
    throw new Error(`lifinity: vaults missing for ${args.poolId.toBase58()}`);
  }

  if (!resolved.base.equals(meta.baseVault) || !resolved.quote.equals(meta.quoteVault)) {
    meta.baseVault = resolved.base;
    meta.quoteVault = resolved.quote;
    metaCache.set(args.poolId.toBase58(), meta);
  }

  const baseReserve = decodeTokenAmount(baseInfo.data);
  const quoteReserve = decodeTokenAmount(quoteInfo.data);

  const snapshot: LifinitySnapshot = {
    poolId: args.poolId,
    ts: Date.now(),
    slot: args.slot,
    baseReserve,
    quoteReserve,
    meta,
    vaultSource: resolved.source,
  };

  snapshotCache.set(args.poolId.toBase58(), snapshot);
  return snapshot;
}

export function getCachedLifinitySnapshot(poolId: PublicKey): LifinitySnapshot | undefined {
  return snapshotCache.get(poolId.toBase58());
}

export function toUi(amount: bigint, decimals: number): number {
  if (amount === 0n) return 0;
  const dec = new Decimal(amount.toString());
  return dec.div(new Decimal(10).pow(decimals)).toNumber();
}

export function lifinityQuoteFromSnapshot(args: {
  snapshot: LifinitySnapshot;
  sizeBase: number;
  direction: "baseToQuote" | "quoteToBase";
}): { ok: true; price: number; feeBps: number } | { ok: false; err: string } {
  const { snapshot, sizeBase, direction } = args;
  if (!(sizeBase > 0)) return { ok: false, err: "invalid_size" };

  const base = toUi(snapshot.baseReserve, snapshot.meta.baseDecimals);
  const quote = toUi(snapshot.quoteReserve, snapshot.meta.quoteDecimals);
  if (!(base > 0) || !(quote > 0)) return { ok: false, err: "invalid_reserves" };

  const feeBps = snapshot.meta.feeBps ?? 0;
  const price = direction === "baseToQuote"
    ? cpmmSellQuotePerBase(base, quote, sizeBase, feeBps)
    : (() => {
        const q = cpmmBuyQuotePerBase(base, quote, sizeBase, feeBps);
        return q != null && q > 0 ? 1 / q : null;
      })();

  if (price == null || !Number.isFinite(price) || !(price > 0)) {
    return { ok: false, err: "lifinity_cpmm_math_failed" };
  }

  return { ok: true, price, feeBps };
}
