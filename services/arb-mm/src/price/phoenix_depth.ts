export type Level = { price: number; size: number }; // size in BASE units

export function vwapFromLevels(levels: Level[], wantSize: number): number | null {
  if (wantSize <= 0) return null;
  let need = wantSize;
  let cost = 0;
  for (const { price, size } of levels) {
    if (need <= 0) break;
    const take = Math.min(need, size);
    cost += take * price;
    need -= take;
  }
  if (need > 1e-12) return null; // not enough depth
  return cost / wantSize;
}

/**
 * Compute IOC taker effective price by walking Phoenix L2.
 * @param side "buy" consumes asks; "sell" consumes bids.
 * @param book { bids: Level[], asks: Level[] } sorted best-first.
 * @param sizeBase trade size in BASE.
 * @returns {effPx, slippageBps, usedLevels}
 */
export function phoenixWalk(
  side: "buy" | "sell",
  book: { bids: Level[]; asks: Level[] },
  sizeBase: number,
  mid: number
) {
  const levels = side === "buy" ? book.asks : book.bids;
  const effPx = vwapFromLevels(levels, sizeBase);
  if (effPx == null) return null;
  const slippageBps = side === "buy"
    ? (effPx / mid - 1) * 1e4
    : (1 - effPx / mid) * 1e4;
  const usedLevels = levels.reduce(
    (acc, l) => {
      if (acc.need <= 0) return acc;
      const take = Math.min(acc.need, l.size);
      if (take > 0) acc.levels.push({ price: l.price, size: take });
      acc.need -= take;
      return acc;
    },
    { need: sizeBase, levels: [] as Level[] }
  ).levels;

  return { effPx, slippageBps, usedLevels };
}
