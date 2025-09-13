// packages/risk/src/index.ts
// Minimal, fast, dependency-free risk scaffolding usable across services.
// - Loads caps from env with sane defaults
// - Tracks rolling per-minute quote notional
// - Tracks simple "error burst" counter
// - Tiny, Apple-simple API (no moving parts)

export type RiskCaps = {
  /** Max total quote notional allowed per minute across all venues. */
  perMinNotionalQuote: number;
  /** Optional: per-venue cap (0 = disabled). */
  perVenueNotionalQuote: number;
  /** How many consecutive "errors" before we start soft-blocking. (0 = disabled) */
  errorBurstMax: number;
};

export type RiskSnapshot = {
  ts: string;
  minuteKey: string;
  totalQuoteThisMinute: number;
  perVenueQuoteThisMinute: Record<string, number>;
  consecutiveErrors: number;
  caps: RiskCaps;
};

export type RiskEvent =
  | { type: "decision"; venue: string; quoteSize: number }
  | { type: "error" }
  | { type: "ok" };

function minuteKeyUTC(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes()
  ).padStart(2, "0")}Z`;
}

export class RiskManager {
  private caps: RiskCaps;
  private minuteKey: string = minuteKeyUTC();
  private totalQuoteThisMinute = 0;
  private perVenueQuoteThisMinute: Record<string, number> = {};
  private consecutiveErrors = 0;

  constructor(caps: RiskCaps) {
    this.caps = { ...caps };
  }

  /** Returns immutable view of internal counters + caps (for logging/telemetry). */
  snapshot(): RiskSnapshot {
    return {
      ts: new Date().toISOString(),
      minuteKey: this.minuteKey,
      totalQuoteThisMinute: this.totalQuoteThisMinute,
      perVenueQuoteThisMinute: { ...this.perVenueQuoteThisMinute },
      consecutiveErrors: this.consecutiveErrors,
      caps: { ...this.caps },
    };
  }

  /** Update caps dynamically (hot-change via env refresh if you want). */
  setCaps(next: Partial<RiskCaps>): void {
    this.caps = { ...this.caps, ...next };
  }

  /** Feed events: decisions (pre-trade reservation), ok/errors (post action). */
  register(ev: RiskEvent): void {
    this.rollMinuteIfNeeded();

    if (ev.type === "decision") {
      const v = ev.venue ?? "default";
      this.totalQuoteThisMinute += Math.max(0, ev.quoteSize || 0);
      this.perVenueQuoteThisMinute[v] =
        (this.perVenueQuoteThisMinute[v] || 0) + Math.max(0, ev.quoteSize || 0);
      return;
    }

    if (ev.type === "error") {
      this.consecutiveErrors++;
      return;
    }

    // ev.type === "ok"
    this.consecutiveErrors = 0;
  }

  /** True if we're under all caps and not in an error burst condition. */
  canProceed(preview: { venue: string; quoteSize: number }): {
    ok: boolean;
    reason?: string;
  } {
    this.rollMinuteIfNeeded();

    // error burst soft-block
    if (this.caps.errorBurstMax > 0 && this.consecutiveErrors >= this.caps.errorBurstMax) {
      return { ok: false, reason: "error-burst" };
    }

    // per-minute total
    const totalPreview = this.totalQuoteThisMinute + Math.max(0, preview.quoteSize || 0);
    if (this.caps.perMinNotionalQuote > 0 && totalPreview > this.caps.perMinNotionalQuote) {
      return { ok: false, reason: "cap-total-per-minute" };
    }

    // per-venue per-minute
    const v = preview.venue || "default";
    const venueNow = (this.perVenueQuoteThisMinute[v] || 0) + Math.max(0, preview.quoteSize || 0);
    if (this.caps.perVenueNotionalQuote > 0 && venueNow > this.caps.perVenueNotionalQuote) {
      return { ok: false, reason: "cap-venue-per-minute" };
    }

    return { ok: true };
  }

  private rollMinuteIfNeeded(now: Date = new Date()): void {
    const key = minuteKeyUTC(now);
    if (key !== this.minuteKey) {
      this.minuteKey = key;
      this.totalQuoteThisMinute = 0;
      this.perVenueQuoteThisMinute = {};
      // do not reset consecutiveErrors on minute roll — it is burst-oriented
    }
  }
}

/** Read caps from env with safe defaults; all numeric envs accept ints/floats. */
export function loadRiskCapsFromEnv(
  env: Record<string, string | undefined> = process.env
): RiskCaps {
  const n = (x: unknown, d: number): number => {
    const v = Number(x);
    return Number.isFinite(v) ? v : d;
  };
  return {
    perMinNotionalQuote: n(env.RISK_PER_MIN_NOTIONAL_QUOTE, 10_000), // quote units (e.g., USDC)
    perVenueNotionalQuote: n(env.RISK_PER_VENUE_NOTIONAL_QUOTE, 0), // 0 = disabled
    errorBurstMax: n(env.RISK_ERROR_BURST_MAX, 0), // 0 = disabled
  };
}

/** Small factory. */
export function makeRisk(caps?: Partial<RiskCaps>): RiskManager {
  const base = loadRiskCapsFromEnv();
  return new RiskManager({ ...base, ...(caps || {}) });
}

/**
 * Compatibility helper for services that just want a one-liner at boot.
 * Logs current caps (using console.log-level) so it always appears in JSONL.
 */
export function initRisk(): RiskManager {
  const rm = makeRisk();
  // Light log for visibility, matches your existing boot banner style.
  // (Do not import @mev/storage here to keep this package pure/reusable.)
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: "risk_caps",
      ts: new Date().toISOString(),
      caps: rm.snapshot().caps,
    })
  );
  return rm;
}
