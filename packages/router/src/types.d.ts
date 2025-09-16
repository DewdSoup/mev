import { AmmAdapter, QuoteResult, Side } from '../../amms/dist/adapters/base';
export type Leg = {
    kind: 'amm';
    adapter: AmmAdapter;
    side: Side;
    baseSize: number;
    maxSlippageBps: number;
} | {
    kind: 'phoenix';
    marketId: string;
    side: Side;
    baseSize: number;
    maxSlippageBps: number;
};
export interface Path {
    legs: Leg[];
    description: string;
}
export interface PathQuote {
    path: Path;
    legQuotes: (QuoteResult | {
        effPx: number;
    })[];
    estPnlBps: number;
}
//# sourceMappingURL=types.d.ts.map