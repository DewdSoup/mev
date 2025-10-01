// services/arb-mm/src/syntheticPhoenix.ts
// Create a synthetic Phoenix book from a mid price.
// Full spread width controlled by PHOENIX_SYNTH_WIDTH_BPS (default 4 bps).
// Returns best_bid, best_ask, mid with source='pyth_synth'.

export type PhoenixBook = {
  best_bid: number;
  best_ask: number;
  mid: number;
  source: string;
};

function getHalfFrac(): number {
  const raw = Number(process.env.PHOENIX_SYNTH_WIDTH_BPS);
  let widthBps = Number.isFinite(raw) ? raw : 4;      // default 4 bps total spread
  widthBps = Math.max(0.5, Math.min(200, widthBps));  // clamp [0.5, 200] bps
  return (widthBps / 2) / 1e4;
}

export function synthFromMid(mid: number, _ts: number): PhoenixBook | null {
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const h = getHalfFrac();
  const bid = mid * (1 - h);
  const ask = mid * (1 + h);
  return {
    best_bid: bid,
    best_ask: ask,
    mid,
    source: "pyth_synth",
  };
}
