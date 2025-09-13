// services/arb-mm/src/executor/size.ts
// Size optimizer + EV helpers used by the joiner and debug paths.
// All exports have explicit types for --isolatedDeclarations compatibility.

export type DepthLevel = { px: number; qtyBase: number };

export type PhoenixBook = {
  bids: DepthLevel[];        // highest px first preferred, but we sort defensively
  asks: DepthLevel[];        // lowest px first preferred, but we sort defensively
  takerFeeBps: number;       // applied to QUOTE leg
};

export type CpmmReserves = {
  base: number;              // BASE reserve (e.g., SOL)
  quote: number;             // QUOTE reserve (e.g., USDC)
  feeBps: number;            // taker fee in bps
};

// ────────────────────────────────────────────────────────────────────────────
// Internals (explicit return types for isolated declarations)
// ────────────────────────────────────────────────────────────────────────────

function sortBids(bids: DepthLevel[]): DepthLevel[] {
  return [...bids].filter(l => l.px > 0 && l.qtyBase > 0).sort((a, b) => b.px - a.px);
}
function sortAsks(asks: DepthLevel[]): DepthLevel[] {
  return [...asks].filter(l => l.px > 0 && l.qtyBase > 0).sort((a, b) => a.px - b.px);
}

function phoenixSellAvgPx(book: PhoenixBook, sizeBase: number): number | undefined {
  if (!(sizeBase > 0)) return undefined;
  const fee = Math.max(0, book.takerFeeBps) / 10_000;
  const ladder = sortBids(book.bids);
  if (ladder.length === 0) return undefined;

  let rem = sizeBase;
  let notional = 0;
  for (const { px, qtyBase } of ladder) {
    const take = Math.min(rem, qtyBase);
    notional += take * px;
    rem -= take;
    if (rem <= 1e-12) break;
  }
  if (rem > 1e-12) return undefined;      // not enough depth
  const receivedQuote = notional * (1 - fee);
  return receivedQuote / sizeBase;         // QUOTE per BASE received
}

function phoenixBuyAvgPx(book: PhoenixBook, sizeBase: number): number | undefined {
  if (!(sizeBase > 0)) return undefined;
  const fee = Math.max(0, book.takerFeeBps) / 10_000;
  const ladder = sortAsks(book.asks);
  if (ladder.length === 0) return undefined;

  let rem = sizeBase;
  let notional = 0;
  for (const { px, qtyBase } of ladder) {
    const take = Math.min(rem, qtyBase);
    notional += take * px;
    rem -= take;
    if (rem <= 1e-12) break;
  }
  if (rem > 1e-12) return undefined;      // not enough depth
  const paidQuote = notional * (1 + fee);
  return paidQuote / sizeBase;             // QUOTE per BASE paid
}

function cpmmBuyQuotePerBase(xBase: number, yQuote: number, wantBase: number, feeBps: number): number | undefined {
  if (!(xBase > 0 && yQuote > 0 && wantBase > 0)) return undefined;
  const fee = Math.max(0, feeBps) / 10_000;
  if (wantBase >= xBase * (1 - 1e-9)) return undefined;
  const dqPrime = (wantBase * yQuote) / (xBase - wantBase);
  const dq = dqPrime / (1 - fee);
  if (!Number.isFinite(dq)) return undefined;
  return dq / wantBase; // avg QUOTE per BASE paid
}

function cpmmSellQuotePerBase(xBase: number, yQuote: number, sellBase: number, feeBps: number): number | undefined {
  if (!(xBase > 0 && yQuote > 0 && sellBase > 0)) return undefined;
  const fee = Math.max(0, feeBps) / 10_000;
  const dbPrime = sellBase * (1 - fee);
  const dy = (yQuote * dbPrime) / (xBase + dbPrime);
  if (!Number.isFinite(dy)) return undefined;
  return dy / sellBase; // avg QUOTE per BASE received
}

function calcAtSize(
  kind: "AMM->PHX" | "PHX->AMM",
  sizeBase: number,
  book: PhoenixBook,
  cpmm: CpmmReserves
): { buyPx: number; sellPx: number; pnlQuote: number; bpsNet: number } | undefined {
  if (!(sizeBase > 0)) return undefined;

  if (kind === "AMM->PHX") {
    const buyPxAmm = cpmmBuyQuotePerBase(cpmm.base, cpmm.quote, sizeBase, cpmm.feeBps);
    const sellPxPhx = phoenixSellAvgPx(book, sizeBase);
    if (buyPxAmm == null || sellPxPhx == null) return undefined;
    const pnl = (sellPxPhx - buyPxAmm) * sizeBase;
    const bpsNet = (sellPxPhx / buyPxAmm - 1) * 10_000;
    return { buyPx: buyPxAmm, sellPx: sellPxPhx, pnlQuote: pnl, bpsNet };
  } else {
    const buyPxPhx = phoenixBuyAvgPx(book, sizeBase);
    const sellPxAmm = cpmmSellQuotePerBase(cpmm.base, cpmm.quote, sizeBase, cpmm.feeBps);
    if (buyPxPhx == null || sellPxAmm == null) return undefined;
    const pnl = (sellPxAmm - buyPxPhx) * sizeBase;
    const bpsNet = (sellPxAmm / buyPxPhx - 1) * 10_000;
    return { buyPx: buyPxPhx, sellPx: sellPxAmm, pnlQuote: pnl, bpsNet };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export function pnlQuoteForSizeBase(
  input: {
    kind: "AMM->PHX" | "PHX->AMM";
    book: PhoenixBook;
    cpmm: CpmmReserves;
    maxPoolFrac: number;    // cap on BASE delta against cpmm.base
    lowerBase: number;      // unused here but kept for call-site parity
  },
  sizeBase: number
): number {
  const maxSize = input.cpmm.base * Math.max(0, Math.min(1, input.maxPoolFrac));
  if (!(sizeBase > 0) || sizeBase > maxSize) return Number.NEGATIVE_INFINITY;
  const ev = calcAtSize(input.kind, sizeBase, input.book, input.cpmm);
  return ev ? ev.pnlQuote : Number.NEGATIVE_INFINITY;
}

export type SizeOptInputs = {
  kind: "AMM->PHX" | "PHX->AMM";
  book: PhoenixBook;
  cpmm: CpmmReserves;
  maxPoolFrac: number;
  lowerBase: number;
  upperBaseCap?: number;    // optional (respect exactOptionalPropertyTypes)
};

export function optimizeSize(
  inp: SizeOptInputs,
  probes?: number
): { bestBase: number; bestPnl: number; bestBpsNet: number } {
  const steps = Math.max(5, Math.min(25, Math.trunc(Number.isFinite(Number(probes)) ? Number(probes) : 9)));

  const poolCap = inp.cpmm.base * Math.max(0, Math.min(1, inp.maxPoolFrac));
  const floor = Math.max(1e-9, inp.lowerBase);
  const cap = Math.max(floor, Math.min(poolCap, inp.upperBaseCap != null ? inp.upperBaseCap : poolCap));

  if (!(cap > floor)) return { bestBase: 0, bestPnl: Number.NEGATIVE_INFINITY, bestBpsNet: Number.NEGATIVE_INFINITY };

  const ratio = Math.pow(cap / floor, 1 / Math.max(1, steps - 1));

  let bestBase = 0;
  let bestPnl = Number.NEGATIVE_INFINITY;
  let bestBpsNet = Number.NEGATIVE_INFINITY;

  let v = floor;
  for (let i = 0; i < steps; i++) {
    const ev = calcAtSize(inp.kind, v, inp.book, inp.cpmm);
    if (ev && ev.pnlQuote > bestPnl) {
      bestPnl = ev.pnlQuote;
      bestBase = v;
      bestBpsNet = ev.bpsNet;
    }
    v = v * ratio;
  }

  return { bestBase, bestPnl, bestBpsNet };
}
