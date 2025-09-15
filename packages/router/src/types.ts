import { AmmAdapter, QuoteResult, Side } from '../../amms/src/adapters/base';

export type Leg =
    | { kind: 'amm', adapter: AmmAdapter, side: Side, baseSize: number, maxSlippageBps: number }
    | { kind: 'phoenix', marketId: string, side: Side, baseSize: number, maxSlippageBps: number };

export interface Path {
    legs: Leg[];             // 2 or 3 legs
    description: string;     // e.g., "orca->phoenix sell", "raydium->orca buy->sell"
}

export interface PathQuote {
    path: Path;
    legQuotes: (QuoteResult | { effPx: number })[]; // phoenix leg uses BBO effPx at quote time
    estPnlBps: number;
}
