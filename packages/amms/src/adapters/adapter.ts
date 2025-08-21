import type { PublicKey, TransactionInstruction, Connection } from "@solana/web3.js";

export type Venue = "raydium" | "orca" | "meteora" | "openbook";

export interface AmmAdapter {
  id: string;              // e.g. "raydium:<poolId>"
  venue: Venue;
  symbol: string;          // "SOL/USDC"
  mintBase: string;        // base mint
  mintQuote: string;       // quote mint

  init?(conn: Connection): Promise<void> | void;

  feeBps(): Promise<number>;
  mid(): Promise<number>;

  reservesAtoms(): Promise<{
    base: bigint;
    quote: bigint;
    baseDecimals: number;
    quoteDecimals: number;
  }>;

  // Optional: live swap builder (not used by publisher)
  buildSwapIx?(params: {
    user: PublicKey;
    baseIn: boolean;
    amountInBaseAtoms: bigint;
    slippageBps: number;
    conn: Connection;
  }): Promise<TransactionInstruction[]>;
}
