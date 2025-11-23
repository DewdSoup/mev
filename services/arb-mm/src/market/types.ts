export type AmmVenue = "raydium" | "orca" | "meteora" | "lifinity";
export type PoolKind = "cpmm" | "clmm" | "dlmm";

export interface AmmSnapshot {
  poolId: string;
  venue: AmmVenue;
  poolKind: PoolKind;
  price: number | null;
  feeBps: number | null;
  baseDecimals: number;
  quoteDecimals: number;
  /** optional raw vault pubkeys for CPMM pools */
  baseVault?: string;
  quoteVault?: string;
  /** UI reserves (converted using decimals) */
  baseReserve?: number | null;
  quoteReserve?: number | null;
  baseReserveUi?: number | null;
  quoteReserveUi?: number | null;
  /** raw atom balances as strings to avoid precision loss */
  baseReserveAtoms?: string | null;
  quoteReserveAtoms?: string | null;
  reserves?: { base: number; quote: number; baseDecimals: number; quoteDecimals: number } | null;
  lastUpdateTs: number;
  ageMs?: number;
  slot?: number | null;
  heartbeatAt?: number | null;
  heartbeatSlot?: number | null;
  wsAt?: number | null;
  syntheticSlot?: boolean;
  tradeableWhenDegraded?: boolean;
  source?: string | null;
  stale?: boolean;
  degraded?: boolean;
  degradedReason?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface PhoenixLevel {
  px: number;
  qty: number;
}

export interface PhoenixSnapshot {
  market: string;
  symbol: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  levelsBids: PhoenixLevel[];
  levelsAsks: PhoenixLevel[];
  lastUpdateTs: number;
  ageMs?: number;
  slot?: number | null;
  stale?: boolean;
  degraded?: boolean;
  degradedReason?: string | null;
}

export interface MarketProviderState {
  amms: AmmSnapshot[];
  phoenix: PhoenixSnapshot[];
}

export interface MarketProviderSnapshot extends MarketProviderState {}

export type MarketStateListener = (state: MarketProviderState) => void;

export interface TrackedPoolMeta {
  poolId: string;
  venue: AmmVenue;
  poolKind: PoolKind;
  feeHint?: number;
  freshness?: {
    slotLagSlots?: number;
    maxAgeMs?: number;
    heartbeatGraceMs?: number;
    tradeableWhenDegraded?: boolean;
  };
  baseMint?: string;
  quoteMint?: string;
  baseDecimalsHint?: number;
  quoteDecimalsHint?: number;
}

export interface MarketProviderConfig {
  refreshMs?: number;
  phoenixRefreshMs?: number;
  staleMs?: number;
  phoenixDepthLevels?: number;
  refreshDebounceMs?: number;
  batchMax?: number;
  snapshotTtlMs?: number;
  telemetryMs?: number;
}
