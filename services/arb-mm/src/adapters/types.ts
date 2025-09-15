import type { Connection, PublicKey, TransactionInstruction, AddressLookupTableAccount } from '@solana/web3.js';

export type VenueKind = 'raydium' | 'orca' | 'phoenix';
export type PoolKind = 'cpmm' | 'clmm' | 'orderbook';

export type Direction = 'baseToQuote' | 'quoteToBase';

export type QuoteReq = {
    inBase: number;         // size in BASE units (UI)
    direction: Direction;
    slippageBps: number;
    poolId: string;
    baseMint: string;
    quoteMint: string;
};

export type QuoteRes = {
    ok: boolean;
    outQuote?: number;      // UI
    feeBps?: number;
    minOut?: number;        // UI (after slippage/fee buffer)
    reason?: string;
    // opaque details adapter may pass to builder:
    meta?: Record<string, any>;
};

export type BuildIxRes = {
    ixs: TransactionInstruction[];
    alts?: AddressLookupTableAccount[];
};

export interface AmmAdapter {
    kind: VenueKind;
    supports(poolKind?: PoolKind): boolean;
    quote(conn: Connection, req: QuoteReq): Promise<QuoteRes>;
    buildSwapIxs(conn: Connection, req: QuoteReq, meta?: any): Promise<BuildIxRes>;
}
