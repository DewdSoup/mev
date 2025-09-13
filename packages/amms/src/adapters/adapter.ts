import type {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

export type AmmVenue = "raydium" | "orca" | "lifinity" | "meteora" | string;

export type ReserveSnapshot = {
  base: bigint;
  quote: bigint;
  /** REQUIRED so src/reserves.ts can use them as numbers */
  baseDecimals: number;
  quoteDecimals: number;
};

/**
 * Back-compat with src/reserves.ts:
 *   - symbol, venue, id, reservesAtoms()
 *
 * Forward-compat hooks are optional (publisher/swap).
 */
export interface AmmAdapter {
  /** e.g. "SOL/USDC" */
  symbol: string;

  /** e.g. "raydium" | "orca" */
  venue: AmmVenue;

  /** pool id (pubkey string) */
  id: string;

  /** Optional one-time initializer */
  init?(conn: Connection): Promise<void>;

  /** REQUIRED by src/reserves.ts */
  reservesAtoms(): Promise<ReserveSnapshot>;

  /** Optional helpers */
  feeBps?(): Promise<number>;
  mid?(): Promise<number>;

  /** Optional venue-native publisher (not used in baseline) */
  startPublisher?(args: {
    connectionUrl: string;
    poolId: string;
    baseMint?: string;
    quoteMint?: string;
    outJsonl: string;
    tickMs: number;
  }): Promise<void>;

  /** Optional venue-native swap builder (not used in AMMs process) */
  buildSwapIx?(args: {
    user: PublicKey;
    /** true => BASE->QUOTE, false => QUOTE->BASE */
    baseIn: boolean;
    /** atoms of the input mint (base if baseIn, else quote) */
    amountInBaseAtoms: bigint;
    poolId: string;
    slippageBps: number;
  }): Promise<
    | { ok: true; ixs: TransactionInstruction[] }
    | { ok: false; reason: string }
  >;
}
