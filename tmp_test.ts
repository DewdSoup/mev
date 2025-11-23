import { recordCandidateStat, recordVenueFreshness } from './services/arb-mm/src/runtime/telemetry.ts';

const now = Date.now();
recordCandidateStat({
  ts: now,
  symbol: 'TEST/USDC',
  path: 'PHX->AMM',
  srcVenue: 'phoenix',
  dstVenue: 'raydium:pool',
  wouldTrade: false,
  edgeBps: 0.1,
  pnlQuote: 0,
  sizeBase: 0.01,
});
recordVenueFreshness({
  timestamp: now,
  byVenue: {
    raydium: {
      pools: 1,
      withHeartbeat: 1,
      missingHeartbeat: 0,
      heartbeat_age_ms_max: 10,
      heartbeat_age_ms_avg: 5,
      ws_age_ms_max: 2,
      ws_age_ms_avg: 1,
    }
  }
});
