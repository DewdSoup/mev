import { Connection } from "@solana/web3.js";
import type { AmmAdapter, ReserveSnapshot } from "./types.js";
export declare class RaydiumAdapter implements AmmAdapter {
    id: string;
    venue: "raydium";
    symbol: string;
    private poolId;
    private baseVault?;
    private quoteVault?;
    private baseMint?;
    private quoteMint?;
    private baseDecimals;
    private quoteDecimals;
    private conn?;
    private initialized;
    private feeBpsCache?;
    constructor(cfg: {
        poolId: string;
        symbol?: string;
    });
    setConnection(conn: Connection): void;
    getConnection(): Connection | undefined;
    /**
     * Try to load pool vaults/mints from chain (preferred), then fall back to disk JSON if provided.
     * Also derive the exact pool fee from the decoded on-chain state (no guessing).
     */
    init(conn?: Connection): Promise<void>;
    private ensureInitialized;
    /** Exact pool fee if known (from state), else fallback to env (never a hard-coded venue default). */
    feeBps(): Promise<number>;
    /** Mid from current vault balances (y/x) */
    mid(): Promise<number>;
    /** REQUIRED by src/reserves.ts */
    reservesAtoms(): Promise<ReserveSnapshot>;
}
/**
 * Factory used by registry/builders. Ensures the adapter is initialized before returning.
 */
export declare function createRaydiumAdapter(conn: Connection, poolId: string, symbol?: string): Promise<AmmAdapter>;
//# sourceMappingURL=raydium.d.ts.map