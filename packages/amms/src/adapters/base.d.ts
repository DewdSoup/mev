import { PublicKey, TransactionInstruction } from '@solana/web3.js';
export type PoolKind = 'cpmm' | 'clmm' | 'hybrid';
export type Side = 'buy' | 'sell';
export interface QuoteRequest {
    side: Side;
    baseSize: number;
    maxSlippageBps: number;
}
export interface QuoteResult {
    effPx: number;
    minOut: bigint;
    feeBpsApplied: number;
    poolSnapshotSlot: number;
    routeInfo?: Record<string, any>;
}
export interface SwapIxsRequest extends QuoteRequest {
    payer: PublicKey;
    minOutBufferBps: number;
}
export interface SwapIxsResult {
    ixs: TransactionInstruction[];
    writeAccounts: PublicKey[];
}
export interface AmmAdapter {
    readonly kind: string;
    readonly poolKind: PoolKind;
    readonly id: string;
    feeBps(): Promise<number>;
    quote(req: QuoteRequest): Promise<QuoteResult>;
    buildSwapIxs(req: SwapIxsRequest): Promise<SwapIxsResult>;
    snapshotTTLms(): number;
}
//# sourceMappingURL=base.d.ts.map