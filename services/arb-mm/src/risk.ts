import { logger } from "@mev/storage";

type Caps = {
  perMinNotionalQuote: number;   // e.g. 50
  perVenueNotionalQuote: number; // (unused for now; reserved)
  errorBurstMax: number;         // e.g. 3
};

let caps: Caps;
let minuteWindowStart = Date.now();
let minuteNotional = 0;

// Hard guards state
const perPathConsecFails = new Map<string, number>();
let errorTimestamps: number[] = []; // rolling window
let killSwitch = false;

// Config (env)
const GUARD_PER_MIN = Number(process.env.GUARD_PER_MIN_NOTIONAL_QUOTE ?? 0);
const GUARD_CONSEC = Number(process.env.GUARD_CONSEC_FAILS_PATH ?? 0);
const GUARD_ERR_MAX = Number(process.env.GUARD_ERROR_BURST_MAX ?? 0);
const GUARD_ERR_SECS = Number(process.env.GUARD_ERROR_BURST_SECS ?? 30);
const GUARD_MIN_TPS = Number(process.env.GUARD_MIN_CHAIN_TPS ?? 0);
const GUARD_DISABLE = String(process.env.GUARD_DISABLE ?? "0").toLowerCase() === "1";
const ERR_LATCH     = String(process.env.GUARD_ERR_LATCH ?? "0").toLowerCase() === "1";

// Optional: allow starting latched via env (default false)
const KILL_SWITCH_START =
  String(process.env.KILL_SWITCH_START ?? "0").toLowerCase() === "1";

export function initRisk() {
  caps = {
    perMinNotionalQuote: Number(process.env.RISK_PER_MIN_NOTIONAL_QUOTE ?? 0),
    perVenueNotionalQuote: Number(process.env.RISK_PER_VENUE_NOTIONAL_QUOTE ?? 0),
    errorBurstMax: Number(process.env.RISK_ERROR_BURST_MAX ?? 0),
  };
  killSwitch = KILL_SWITCH_START;
  logger.log("risk_caps", { ...caps, kill_switch_start: KILL_SWITCH_START, err_latch: ERR_LATCH });

  setInterval(() => {
    const now = Date.now();

    // minute window reset
    if (now - minuteWindowStart >= 60_000) {
      minuteWindowStart = now;
      minuteNotional = 0;
      // decay consecutive failures per path (soft reset each minute)
      for (const k of perPathConsecFails.keys())
        perPathConsecFails.set(k, Math.max(0, (perPathConsecFails.get(k) || 0) - 1));
    }

    // prune error window & auto-clear kill-switch if not latched
    errorTimestamps = errorTimestamps.filter(t => now - t <= Math.max(1, GUARD_ERR_SECS) * 1000);
    if (!ERR_LATCH && killSwitch && errorTimestamps.length < Math.max(1, GUARD_ERR_MAX)) {
      killSwitch = false;
      logger.log("kill_switch_off", { reason: "quiet_window", window_secs: GUARD_ERR_SECS });
    }

    logger.log("risk_utilization", {
      per_min_used_quote: Number(minuteNotional.toFixed(4)),
      per_min_cap_quote: caps.perMinNotionalQuote,
      guard_cfg: {
        per_min_quote: GUARD_PER_MIN,
        consec_fails: GUARD_CONSEC,
        err_burst_max: GUARD_ERR_MAX,
        err_burst_secs: GUARD_ERR_SECS,
        min_chain_tps: GUARD_MIN_TPS,
        disabled: GUARD_DISABLE,
        err_latch: ERR_LATCH,
      },
    });
  }, 15_000);
}

/** Call on would_trade to track read-only utilization */
export function noteDecision(notionalQuote: number) {
  const now = Date.now();
  if (now - minuteWindowStart >= 60_000) {
    minuteWindowStart = now;
    minuteNotional = 0;
  }
  if (Number.isFinite(notionalQuote) && notionalQuote > 0) {
    minuteNotional += notionalQuote;
  }
}

export function noteConsecutiveResult(pathId: string, success: boolean) {
  const cur = perPathConsecFails.get(pathId) || 0;
  perPathConsecFails.set(pathId, success ? 0 : cur + 1);
}

export function noteError() {
  const now = Date.now();
  errorTimestamps.push(now);
  const windowStart = now - Math.max(1, GUARD_ERR_SECS) * 1000;
  errorTimestamps = errorTimestamps.filter(t => t >= windowStart);

  if (GUARD_ERR_MAX > 0 && errorTimestamps.length >= GUARD_ERR_MAX) {
    if (ERR_LATCH) {
      killSwitch = true;
      logger.log("kill_switch_on", { reason: "error_burst", window_secs: GUARD_ERR_SECS, count: errorTimestamps.length, latched: true });
    } else {
      logger.log("error_burst_window", { reason: "error_burst", window_secs: GUARD_ERR_SECS, count: errorTimestamps.length, latched: false });
    }
  }
}

export function killSwitchActive() { return killSwitch; }
export function resetKillSwitch() { killSwitch = false; logger.log("kill_switch_off", { reason: "manual_reset" }); }

// Hard-guard entrypoint (call right before sending)
export function guardCheck(input: {
  pathId: string;
  notionalQuote: number;
  currentTps?: number;
}): { ok: true } | { ok: false; reason: string; value?: number; limit?: number } {
  if (GUARD_DISABLE) return { ok: true };

  if (killSwitch) return { ok: false, reason: "kill_switch_active" };

  // Per-minute notional (LIVE guard)
  if (GUARD_PER_MIN > 0) {
    const now = Date.now();
    if (now - minuteWindowStart >= 60_000) {
      minuteWindowStart = now; minuteNotional = 0;
    }
    const next = minuteNotional + (Number.isFinite(input.notionalQuote) ? input.notionalQuote : 0);
    if (next > GUARD_PER_MIN) {
      return { ok: false, reason: "per_min_notional", value: next, limit: GUARD_PER_MIN };
    }
  }

  // Per-path consecutive failure cap
  if (GUARD_CONSEC > 0) {
    const cur = perPathConsecFails.get(input.pathId) || 0;
    if (cur >= GUARD_CONSEC) {
      return { ok: false, reason: "consecutive_fails", value: cur, limit: GUARD_CONSEC };
    }
  }

  // Error burst (windowed — does not latch unless GUARD_ERR_LATCH=1)
  if (GUARD_ERR_MAX > 0) {
    const now = Date.now();
    const windowStart = now - Math.max(1, GUARD_ERR_SECS) * 1000;
    const cnt = errorTimestamps.filter(t => t >= windowStart).length;
    if (cnt >= GUARD_ERR_MAX) {
      return { ok: false, reason: "error_burst", value: cnt, limit: GUARD_ERR_MAX };
    }
  }

  // TPS-aware throttle
  if (GUARD_MIN_TPS > 0 && Number.isFinite(input.currentTps as number)) {
    const tps = Number(input.currentTps);
    if (tps > 0 && tps < GUARD_MIN_TPS) {
      logger.log("tps_throttle", { tps, min: GUARD_MIN_TPS });
      return { ok: false, reason: "tps_throttle", value: tps, limit: GUARD_MIN_TPS };
    }
  }

  return { ok: true };
}
