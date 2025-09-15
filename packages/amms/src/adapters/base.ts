import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export type PoolKind = 'cpmm' | 'clmm' | 'hybrid';
export type Side = 'buy' | 'sell';

export interface QuoteRequest {
    side: Side;               // buy = buy base with quote; sell = sell base for quote
    baseSize: number;         // human units (e.g., 0.03 SOL)
    maxSlippageBps: number;
}

export interface QuoteResult {
    effPx: number;            // quote_out/base_in incl. fees & pool impact
    minOut: bigint;           // integer token units
    feeBpsApplied: number;
    poolSnapshotSlot: number;
    routeInfo?: Record<string, any>;
}

export interface SwapIxsRequest extends QuoteRequest {
    payer: PublicKey;
    minOutBufferBps: number;  // extra buffer beyond computed minOut
}

export interface SwapIxsResult {
    ixs: TransactionInstruction[];
    writeAccounts: PublicKey[];
}

export interface AmmAdapter {
    readonly kind: string;         // 'raydium' | 'orca' | ...
    readonly poolKind: PoolKind;
    readonly id: string;           // pool id
    feeBps(): Promise<number>;
    quote(req: QuoteRequest): Promise<QuoteResult>;
    buildSwapIxs(req: SwapIxsRequest): Promise<SwapIxsResult>;
    snapshotTTLms(): number;       // staleness guard
}
