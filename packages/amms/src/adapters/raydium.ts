import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  SPL_ACCOUNT_LAYOUT,
  LIQUIDITY_STATE_LAYOUT_V4,
} from "@raydium-io/raydium-sdk";
import type { AmmAdapter, ReserveSnapshot } from "./types.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ESM-safe dirname
const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

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

function findPoolJsonPath(): string | undefined {
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
    path.resolve(__here, "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__here, "..", "..", "..", "configs", "raydium.pool.json"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return undefined;
}

async function getVaultReserves(
  conn: Connection,
  baseVault: PublicKey,
  quoteVault: PublicKey
) {
  const accs = await conn.getMultipleAccountsInfo([baseVault, quoteVault], {
    commitment: "processed" as any,
  });
  if (!accs[0]?.data || !accs[1]?.data)
    throw new Error("RaydiumAdapter: reserves missing");

  // SPL token account layout
  const baseInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[0].data);
  const quoteInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[1].data);

  // Ensure BN instances
  const base = new BN(baseInfo.amount.toString());
  const quote = new BN(quoteInfo.amount.toString());

  return { base, quote };
}

async function resolveDecimals(conn: Connection, mint: PublicKey): Promise<number> {
  const a = mint.toBase58();
  if (a === SOL) return 9;
  if (a === USDC) return 6;
  try {
    const info = await conn.getParsedAccountInfo(mint, "processed");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dec = (info.value?.data as any)?.parsed?.info?.decimals;
    if (typeof dec === "number") return dec;
  } catch {
    /* ignore */
  }
  return 9;
}

export class RaydiumAdapter implements AmmAdapter {
  id: string; // pool id (pubkey string)
  venue: "raydium" = "raydium";
  symbol: string;

  private poolId: string;
  private baseVault?: PublicKey;
  private quoteVault?: PublicKey;
  private baseMint?: PublicKey;
  private quoteMint?: PublicKey;
  private baseDecimals = 9;
  private quoteDecimals = 6;

  private conn?: Connection;
  private initialized = false;
  private feeBpsCache?: number;

  constructor(cfg: { poolId: string; symbol?: string }) {
    this.poolId = cfg.poolId;
    this.symbol = cfg.symbol ?? "SOL/USDC";
    this.id = this.poolId; // keep pure pubkey for logs/UI
  }

  setConnection(conn: Connection): void {
    this.conn = conn;
  }

  getConnection(): Connection | undefined {
    return this.conn;
  }

  /**
   * Try to load pool vaults/mints from chain (preferred), then fall back to disk JSON if provided.
   * Also derive the exact pool fee from the decoded on-chain state (no guessing).
   */
  async init(conn?: Connection): Promise<void> {
    if (conn) this.setConnection(conn);
    if (!this.conn) throw new Error("RaydiumAdapter: connection required for init");

    // 1) Preferred path — read Raydium Liquidity pool state from chain
    let loaded = false;
    try {
      const poolPk = new PublicKey(this.poolId);
      const acct = await this.conn.getAccountInfo(poolPk, "processed");
      if (!acct?.data) throw new Error("pool_account_missing");

      // Decode Raydium V4 liquidity state
      const st: any = LIQUIDITY_STATE_LAYOUT_V4.decode(acct.data);
      this.baseVault = new PublicKey(st.baseVault);
      this.quoteVault = new PublicKey(st.quoteVault);
      this.baseMint = new PublicKey(st.baseMint);
      this.quoteMint = new PublicKey(st.quoteMint);

      // Attempt to read fee from common field names in the decoded state.
      // V4 typically stores numerator/denominator in 1e6 scale.
      const num =
        Number(st.tradeFeeNumerator ?? st.swapFeeNumerator ?? st.feesNumerator ?? 0);
      const den =
        Number(st.tradeFeeDenominator ?? st.swapFeeDenominator ?? st.feesDenominator ?? 0);

      if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
        // Convert to BPS: fee = num/den ; bps = fee * 10_000
        this.feeBpsCache = (num / den) * 10_000;
      }

      loaded = true;
    } catch {
      // 2) Fallback — disk JSON (FULL keys file only)
      const poolJsonPath = findPoolJsonPath();
      if (!poolJsonPath) {
        throw new Error(
          "RaydiumAdapter: unable to discover pool from chain and no raydium.pool.json found; " +
          "set RAYDIUM_POOL_JSON_PATH to the FULL keys file."
        );
      }
      const rawAny = JSON.parse(fs.readFileSync(poolJsonPath, "utf8"));
      const raw = rawAny as DiskPoolKeys;

      if (!raw?.id || !raw.baseVault || !raw.quoteVault || !raw.baseMint || !raw.quoteMint) {
        throw new Error(
          "RaydiumAdapter: invalid pool-keys JSON. " +
          "Do not point at a mapping file; pass the FULL keys file for the specific pool."
        );
      }
      if (raw.id !== this.poolId) {
        throw new Error(
          `RaydiumAdapter: pool id mismatch (env=${this.poolId} json=${raw.id})`
        );
      }

      this.baseVault = new PublicKey(raw.baseVault);
      this.quoteVault = new PublicKey(raw.quoteVault);
      this.baseMint = new PublicKey(raw.baseMint);
      this.quoteMint = new PublicKey(raw.quoteMint);
      loaded = true;
    }

    if (!loaded || !this.baseMint || !this.quoteMint) {
      throw new Error("RaydiumAdapter: failed to resolve pool keys");
    }

    this.baseDecimals = await resolveDecimals(this.conn, this.baseMint);
    this.quoteDecimals = await resolveDecimals(this.conn, this.quoteMint);

    // If on-chain fee wasn't discovered (fallback case), keep undefined here
    // and let feeBps() below use only as a fallback to env.
    this.initialized = true;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  /** Exact pool fee if known (from state), else fallback to env (never a hard-coded venue default). */
  async feeBps(): Promise<number> {
    await this.ensureInitialized();
    if (this.feeBpsCache && Number.isFinite(this.feeBpsCache) && this.feeBpsCache > 0) {
      return this.feeBpsCache;
    }
    return Number.parseFloat(
      process.env.RAYDIUM_TRADE_FEE_BPS ??
      process.env.AMM_TAKER_FEE_BPS ??
      "25"
    );
  }

  /** Mid from current vault balances (y/x) */
  async mid(): Promise<number> {
    await this.ensureInitialized();
    if (!this.conn || !this.baseVault || !this.quoteVault) {
      throw new Error("RaydiumAdapter: not properly initialized");
    }

    const { base, quote } = await getVaultReserves(
      this.conn,
      this.baseVault,
      this.quoteVault
    );
    const baseF = Number(base.toString()) / Math.pow(10, this.baseDecimals);
    const quoteF = Number(quote.toString()) / Math.pow(10, this.quoteDecimals);
    if (baseF <= 0) throw new Error("RaydiumAdapter: zero base reserve");
    return quoteF / baseF;
  }

  /** REQUIRED by src/reserves.ts */
  async reservesAtoms(): Promise<ReserveSnapshot> {
    await this.ensureInitialized();
    if (!this.conn || !this.baseVault || !this.quoteVault) {
      throw new Error("RaydiumAdapter: not properly initialized");
    }

    const { base, quote } = await getVaultReserves(
      this.conn,
      this.baseVault,
      this.quoteVault
    );
    return {
      base: BigInt(base.toString()),
      quote: BigInt(quote.toString()),
      baseDecimals: this.baseDecimals,
      quoteDecimals: this.quoteDecimals,
    };
  }
}

/**
 * Factory used by registry/builders. Ensures the adapter is initialized before returning.
 */
export async function createRaydiumAdapter(
  conn: Connection,
  poolId: string,
  symbol = "SOL/USDC"
): Promise<AmmAdapter> {
  const a = new RaydiumAdapter({ poolId, symbol });
  a.setConnection(conn);
  await a.init();
  return a;
}
