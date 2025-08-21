/* services/arb-mm/src/executor/size.ts */
import { strict as assert } from 'assert';

export type BookLevel = { px: number; qtyBase: number }; // qty in BASE units
export type PhoenixBook = {
  bids: BookLevel[]; // descending px
  asks: BookLevel[]; // ascending px
  takerFeeBps: number; // usually 0 in your config
  lotSizeBase?: number; // optional: snap sizes to lot multiples if provided
};

export type CpmmReserves = {
  base: number;   // in BASE units (float; we use min sizes so double precision is fine)
  quote: number;  // in QUOTE units
  feeBps: number; // e.g. 25
};

/** Walk an orderbook side and return total QUOTE for Δ base. */
function walkBookCost(side: 'ask' | 'bid', book: PhoenixBook, baseQty: number): number {
  let need = baseQty;
  let acc = 0;
  const levels = side === 'ask' ? book.asks : book.bids;
  for (const { px, qtyBase } of levels) {
    if (need <= 0) break;
    const take = Math.min(need, qtyBase);
    acc += take * px;
    need -= take;
  }
  if (need > 0) return Infinity; // not enough depth under your current slippage window
  const feeMul = 1 + (book.takerFeeBps / 10_000) * (side === 'ask' ? 1 : -1); // add fee to buys, subtract from sells
  return acc * feeMul;
}

/** CPMM: sell BASE into pool -> receive QUOTE out */
function cpmmSellBaseGetQuoteOut(r: CpmmReserves, baseIn: number): { quoteOut: number } {
  if (baseIn <= 0) return { quoteOut: 0 };
  const gamma = 1 - r.feeBps / 10_000;
  const x = r.base, y = r.quote;
  const k = x * y;
  const xEff = x + baseIn * gamma;
  const quoteOut = y - k / xEff;
  if (!Number.isFinite(quoteOut) || quoteOut <= 0) return { quoteOut: 0 };
  return { quoteOut };
}

/** CPMM: buy BASE from pool (swap QUOTE in) -> target BASE out */
function cpmmBuyBaseGetQuoteIn(r: CpmmReserves, baseOut: number): { quoteIn: number } {
  if (baseOut <= 0) return { quoteIn: 0 };
  const gamma = 1 - r.feeBps / 10_000;
  const x = r.base, y = r.quote;
  assert(baseOut < x * 0.999999, 'cpmm: baseOut too large');
  const k = x * y;
  const denom = x - baseOut;
  const qEff = k / denom - y; // effective quote added to pool after fee
  const quoteIn = qEff / gamma;
  if (!Number.isFinite(quoteIn) || quoteIn <= 0) return { quoteIn: Infinity };
  return { quoteIn };
}

export type PathKind = 'PHX->AMM' | 'AMM->PHX';

export interface SizeOptInputs {
  kind: PathKind;
  book: PhoenixBook;
  cpmm: CpmmReserves;
  maxPoolFrac: number;      // e.g. 0.02
  lowerBase: number;        // e.g. 0.0002
  upperBaseCap?: number;    // optional absolute cap in BASE
  snapBase?: (v: number) => number; // optional lot snapping
}

/** Expected PnL in QUOTE for a given BASE size. Positive -> trade. */
export function pnlQuoteForSizeBase(inp: SizeOptInputs, baseSize: number): number {
  const { kind, book, cpmm } = inp;

  if (baseSize <= 0) return -Infinity;

  if (kind === 'PHX->AMM') {
    // Buy BASE on Phoenix (cost), sell BASE into AMM (revenue)
    const costQuote = walkBookCost('ask', book, baseSize);
    if (!Number.isFinite(costQuote)) return -Infinity;
    const { quoteOut } = cpmmSellBaseGetQuoteOut(cpmm, baseSize);
    if (!Number.isFinite(quoteOut)) return -Infinity;
    return quoteOut - costQuote;
  } else {
    // AMM->PHX: Buy BASE from AMM (cost), sell BASE on Phoenix (revenue)
    const { quoteIn } = cpmmBuyBaseGetQuoteIn(cpmm, baseSize);
    if (!Number.isFinite(quoteIn)) return -Infinity;
    const revenueQuote = walkBookCost('bid', book, baseSize);
    if (!Number.isFinite(revenueQuote)) return -Infinity;
    return revenueQuote - quoteIn;
  }
}

/** Golden-section search over BASE size in [low, high] maximizing PnL. */
export function optimizeSize(inp: SizeOptInputs, probes: number): { bestBase: number; bestPnl: number } {
  const capByPool = inp.cpmm.base * inp.maxPoolFrac;
  const hi0 = Math.max(inp.lowerBase * 4, Math.min(capByPool, inp.upperBaseCap ?? Number.POSITIVE_INFINITY));
  let lo = inp.lowerBase;
  let hi = Math.max(hi0, lo * 2);

  // snap function if provided (Phoenix lot size)
  const snap = (v: number) => (inp.snapBase ? inp.snapBase(Math.max(inp.lowerBase, v)) : v);

  // Golden section coefficients
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = pnlQuoteForSizeBase(inp, snap(c));
  let fd = pnlQuoteForSizeBase(inp, snap(d));

  for (let i = 0; i < probes; i++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = pnlQuoteForSizeBase(inp, snap(c));
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = pnlQuoteForSizeBase(inp, snap(d));
    }
  }

  // pick the better endpoint
  const cSnap = snap(c), dSnap = snap(d);
  const candidates: Array<[number, number]> = [
    [cSnap, pnlQuoteForSizeBase(inp, cSnap)],
    [dSnap, pnlQuoteForSizeBase(inp, dSnap)],
    [snap(inp.lowerBase), pnlQuoteForSizeBase(inp, snap(inp.lowerBase))],
  ];
  candidates.sort((x, y) => y[1] - x[1]);
  const [bestBase, bestPnl] = candidates[0];

  return { bestBase, bestPnl };
}
