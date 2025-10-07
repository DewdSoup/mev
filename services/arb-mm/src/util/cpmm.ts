import Decimal from "decimal.js";

const ONE = new Decimal(1);
const MAX_FRACTION = new Decimal(0.999999999);

function toDecimal(value: number): Decimal | null {
  if (!Number.isFinite(value)) return null;
  return new Decimal(value);
}

export function cpmmBuyQuotePerBase(base: number, quote: number, wantBase: number, feeBps: number): number | undefined {
  if (!(base > 0 && quote > 0 && wantBase > 0)) return undefined;

  const x = toDecimal(base);
  const y = toDecimal(quote);
  const dx = toDecimal(wantBase);
  if (!x || !y || !dx) return undefined;

  if (dx.greaterThanOrEqualTo(x.mul(MAX_FRACTION))) return undefined;

  const fee = new Decimal(Math.max(0, feeBps)).div(10_000);
  const oneMinusFee = ONE.minus(fee);
  if (oneMinusFee.lte(0)) return undefined;

  const denominator = x.minus(dx);
  if (denominator.lte(0)) return undefined;

  const dqPrime = dx.mul(y).div(denominator);
  if (!dqPrime.isFinite() || dqPrime.lte(0)) return undefined;

  const dq = dqPrime.div(oneMinusFee);
  if (!dq.isFinite() || dq.lte(0)) return undefined;

  const avgQuotePerBase = dq.div(dx);
  return avgQuotePerBase.isFinite() && avgQuotePerBase.gt(0) ? avgQuotePerBase.toNumber() : undefined;
}

export function cpmmSellQuotePerBase(base: number, quote: number, sellBase: number, feeBps: number): number | undefined {
  if (!(base > 0 && quote > 0 && sellBase > 0)) return undefined;

  const x = toDecimal(base);
  const y = toDecimal(quote);
  const dx = toDecimal(sellBase);
  if (!x || !y || !dx) return undefined;

  const fee = new Decimal(Math.max(0, feeBps)).div(10_000);
  const oneMinusFee = ONE.minus(fee);
  if (oneMinusFee.lte(0)) return undefined;

  const dxPrime = dx.mul(oneMinusFee);
  if (!dxPrime.isFinite() || dxPrime.lte(0)) return undefined;

  const denominator = x.plus(dxPrime);
  if (denominator.lte(0)) return undefined;

  const dy = y.mul(dxPrime).div(denominator);
  if (!dy.isFinite() || dy.lte(0)) return undefined;

  const avgQuotePerBase = dy.div(dx);
  return avgQuotePerBase.isFinite() && avgQuotePerBase.gt(0) ? avgQuotePerBase.toNumber() : undefined;
}
