import fs from "fs";
import path from "path";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { SPL_ACCOUNT_LAYOUT } from "@raydium-io/raydium-sdk";
import type { AmmAdapter } from "./adapter.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type DiskPoolKeys = {
  id: string;
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
};

function getenv(k: string) {
  const v = process.env[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function findPoolJsonPath(): string {
  // accept multiple env names
  const envs = [
    getenv("RAYDIUM_POOL_JSON_PATH"),
    getenv("RAYDIUM_POOL_KEYS_JSON"),
    getenv("RAYDIUM_POOLS_FILE"),
  ];
  for (const e of envs) {
    if (e && fs.existsSync(e)) return path.resolve(e);
  }
  const candidates = [
    path.resolve(process.cwd(), "configs", "raydium.pool.json"),
    path.resolve(process.cwd(), "..", "configs", "raydium.pool.json"),
    path.resolve(process.cwd(), "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__dirname, "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__dirname, "..", "..", "..", "configs", "raydium.pool.json"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(
    "RaydiumAdapter: missing full pool-keys JSON (configs/raydium.pool.json). " +
    "Set RAYDIUM_POOL_JSON_PATH or RAYDIUM_POOL_KEYS_JSON to the FULL keys file."
  );
}

async function getVaultReserves(conn: Connection, baseVault: PublicKey, quoteVault: PublicKey) {
  const accs = await conn.getMultipleAccountsInfo([baseVault, quoteVault], { commitment: "processed" as any });
  if (!accs[0]?.data || !accs[1]?.data) throw new Error("RaydiumAdapter: reserves missing");
  const baseInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[0].data);
  const quoteInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[1].data);
  return { base: new BN(baseInfo.amount), quote: new BN(quoteInfo.amount) };
}

async function resolveDecimals(conn: Connection, mint: PublicKey): Promise<number> {
  const a = mint.toBase58();
  if (a === SOL) return 9;
  if (a === USDC) return 6;
  try {
    const info = await conn.getParsedAccountInfo(mint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dec = (info.value?.data as any)?.parsed?.info?.decimals;
    if (typeof dec === "number") return dec;
  } catch { }
  return 9;
}

export class RaydiumAdapter implements AmmAdapter {
  id: string;
  venue: "raydium" = "raydium";
  symbol: string;
  mintBase: string;
  mintQuote: string;

  private poolId: string;
  private baseVault!: PublicKey;
  private quoteVault!: PublicKey;
  private baseMint!: PublicKey;
  private quoteMint!: PublicKey;
  private baseDecimals = 9;
  private quoteDecimals = 6;

  private poolJsonPath: string;
  private conn!: Connection;

  constructor(cfg: { poolId: string; symbol?: string; mintBase?: string; mintQuote?: string }) {
    this.poolId = cfg.poolId;
    this.symbol = cfg.symbol ?? "SOL/USDC";
    this.mintBase = cfg.mintBase ?? SOL;
    this.mintQuote = cfg.mintQuote ?? USDC;
    this.id = `raydium:${this.poolId}`;
    this.poolJsonPath = findPoolJsonPath();
  }

  async init(conn: Connection): Promise<void> {
    this.conn = conn;
    const rawAny = JSON.parse(fs.readFileSync(this.poolJsonPath, "utf8"));

    // the correct file is a single object with id/baseVault/quoteVault/...
    // if someone points at a map file, raw.id will be undefined
    const raw = rawAny as DiskPoolKeys;
    if (!raw?.id) {
      throw new Error(
        "RaydiumAdapter: invalid pool-keys JSON (missing 'id'). " +
        "You pointed at a mapping file; use the FULL keys file (configs/raydium.pool.json)."
      );
    }
    if (raw.id !== this.poolId) {
      throw new Error(`RaydiumAdapter: pool id mismatch (env=${this.poolId} json=${raw.id})`);
    }

    this.baseVault = new PublicKey(raw.baseVault);
    this.quoteVault = new PublicKey(raw.quoteVault);
    this.baseMint = new PublicKey(raw.baseMint);
    this.quoteMint = new PublicKey(raw.quoteMint);

    this.baseDecimals = await resolveDecimals(this.conn, this.baseMint);
    this.quoteDecimals = await resolveDecimals(this.conn, this.quoteMint);
  }

  async feeBps(): Promise<number> {
    return Number.parseFloat(process.env.AMM_TAKER_FEE_BPS ?? process.env.RAYDIUM_TRADE_FEE_BPS ?? "25");
  }

  async mid(): Promise<number> {
    const { base, quote } = await getVaultReserves(this.conn, this.baseVault, this.quoteVault);
    const baseF = Number(base.toString()) / Math.pow(10, this.baseDecimals);
    const quoteF = Number(quote.toString()) / Math.pow(10, this.quoteDecimals);
    if (baseF <= 0) throw new Error("RaydiumAdapter: zero base reserve");
    return quoteF / baseF;
  }

  async reservesAtoms() {
    const { base, quote } = await getVaultReserves(this.conn, this.baseVault, this.quoteVault);
    return {
      base: BigInt(base.toString()),
      quote: BigInt(quote.toString()),
      baseDecimals: this.baseDecimals,
      quoteDecimals: this.quoteDecimals,
    };
  }
}
