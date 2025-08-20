// services/arb-mm/src/util/num.ts

/** True only for JS numbers that are finite. */
export function isFiniteNum(x: unknown): x is number {
    return typeof x === "number" && Number.isFinite(x);
  }

  /** Convert to number if finite; otherwise undefined. */
  export function asNumber(x: unknown): number | undefined {
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  }

  /** Round to p decimals without using toFixed on the input. Returns undefined if non-finite. */
  export function roundN(x: unknown, p = 6): number | undefined {
    const n = asNumber(x);
    if (n === undefined) return undefined;
    const m = 10 ** p;
    return Math.round(n * m) / m;
  }

  /** Round first finite among xs; else 0. */
  export function coalesceRound(p: number, ...xs: unknown[]): number {
    for (const x of xs) {
      const n = asNumber(x);
      if (n !== undefined) {
        const m = 10 ** p;
        return Math.round(n * m) / m;
      }
    }
    return 0;
  }

  /** Format with toFixed safely; empty string if non-finite. */
  export function safeFixed(x: unknown, p = 6): string {
    const n = asNumber(x);
    return n === undefined ? "" : n.toFixed(p);
  }
