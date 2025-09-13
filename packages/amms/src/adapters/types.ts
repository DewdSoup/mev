// packages/amms/src/adapters/types.ts
import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

export type AmmVenue = "raydium" | "orca" | "lifinity" | "meteora" | string;

export type ReserveSnapshot = {
    /** raw atom balances (BigInt) */
    base: bigint;
    quote: bigint;
    /** REQUIRED by src/reserves.ts (number, not bigint) */
    baseDecimals: number;
    quoteDecimals: number;
};

/**
 * Minimal surface required by src/reserves.ts:
 *   - symbol, venue, id, reservesAtoms()
 * Forward-compat hooks are optional (fees, mid, publisher, swap builder, connection helpers).
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

    /** Connection setter for runtime injection */
    setConnection?(conn: Connection): void;

    /** Connection getter for debugging */
    getConnection?(): Connection | undefined;

    /** REQUIRED by src/reserves.ts */
    reservesAtoms(): Promise<ReserveSnapshot>;

    /** Optional helpers */
    feeBps?(): Promise<number>;
    mid?(): Promise<number>;

    /** Optional venue-native publisher */
    startPublisher?(args: {
        connectionUrl: string;
        poolId: string;
        baseMint?: string;
        quoteMint?: string;
        outJsonl: string;
        tickMs: number;
    }): Promise<void>;

    /** Optional venue-native swap builder (not used by src/reserves.ts) */
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
