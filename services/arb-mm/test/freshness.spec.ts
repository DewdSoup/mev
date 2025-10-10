import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

let joinerModule: any;
let metricsModule: any;
const originalSlotLag = process.env.AMM_SLOT_MAX_LAG__METEORA;
const originalHeartbeatSoft = process.env.AMM_HEARTBEAT_SOFT_MS__METEORA;

beforeAll(async () => {
  process.env.AMM_SLOT_MAX_LAG__METEORA = "80";
  process.env.AMM_HEARTBEAT_SOFT_MS__METEORA = "20000";
  joinerModule = await import("../src/edge/joiner.js");
  metricsModule = await import("../src/runtime/metrics.js");
});

afterAll(() => {
  if (originalSlotLag == null) delete process.env.AMM_SLOT_MAX_LAG__METEORA;
  else process.env.AMM_SLOT_MAX_LAG__METEORA = originalSlotLag;
  if (originalHeartbeatSoft == null) delete process.env.AMM_HEARTBEAT_SOFT_MS__METEORA;
  else process.env.AMM_HEARTBEAT_SOFT_MS__METEORA = originalHeartbeatSoft;
});

beforeEach(() => {
  metricsModule.clearHeartbeatMetrics();
});

describe("venue-aware freshness overrides", () => {
  it("respects per-venue slot skew overrides", () => {
    const {
      resolveSlotLagLimit,
      checkAmmFreshness,
      resolveSnapshotAgeLimit,
    } = joinerModule;
    expect(resolveSlotLagLimit("meteora")).toBe(80);
    const now = Date.now();
    const ok = checkAmmFreshness(
      { ts: now - 100, slot: 180, venue: "meteora", ammId: "pool" },
      260,
      now,
      resolveSlotLagLimit("meteora"),
      resolveSnapshotAgeLimit("meteora"),
      undefined,
    );
    expect(ok.ok).toBe(true);

    const stale = checkAmmFreshness(
      { ts: now - 100, slot: 178, venue: "meteora", ammId: "pool" },
      260,
      now,
      resolveSlotLagLimit("meteora"),
      resolveSnapshotAgeLimit("meteora"),
      undefined,
    );
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("slot_skew>80");
  });

  it("treats recent heartbeat snapshots as soft stale instead of degraded", () => {
    const {
      resolveHeartbeatGraceMs,
      isSoftStaleEligible,
      checkAmmFreshness,
      resolveSlotLagLimit,
      resolveSnapshotAgeLimit,
    } = joinerModule;
    const now = Date.now();
    const freshness = checkAmmFreshness(
      { ts: now - 1000, slot: 170, venue: "meteora", ammId: "pool" },
      260,
      now,
      resolveSlotLagLimit("meteora"),
      resolveSnapshotAgeLimit("meteora"),
      undefined,
    );
    expect(freshness.ok).toBe(false);
    const heartbeatSnapshot: any = {
      venue: "meteora",
      ammId: "pool",
      px: 1,
      ts: now - 1000,
      feeBps: 10,
      tradeableWhenDegraded: true,
      heartbeatAt: now - 500,
      wsAt: now - 450,
    };
    const graceMs = resolveHeartbeatGraceMs("meteora");
    expect(isSoftStaleEligible(heartbeatSnapshot, freshness.reason!, now, graceMs, true)).toBe(true);
  });
});

describe("heartbeat metrics", () => {
  it("aggregates per-venue heartbeat ages", () => {
    const { recordHeartbeatMetric, summarizeHeartbeatByVenue } = metricsModule;
    const now = Date.now();
    recordHeartbeatMetric({
      venue: "meteora",
      poolId: "pool-a",
      heartbeatAt: now - 400,
      wsAt: now - 200,
      source: "heartbeat",
      synthetic: true,
    });
    recordHeartbeatMetric({
      venue: "meteora",
      poolId: "pool-b",
      wsAt: now - 100,
      source: "ws",
    });

    const summary = summarizeHeartbeatByVenue(now);
    expect(summary.byVenue.meteora.pools).toBe(2);
    expect(summary.byVenue.meteora.withHeartbeat).toBe(1);
    expect(summary.byVenue.meteora.heartbeat_age_ms_max).toBeGreaterThanOrEqual(400);
    expect(summary.byVenue.meteora.ws_age_ms_max).toBeGreaterThanOrEqual(100);
  });
});
