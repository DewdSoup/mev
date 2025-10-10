// Lightweight shared state for RPC latency → fee bumping
let _p50 = 0;
let _p95 = 0;

type HeartbeatMetric = {
    venue: string;
    poolId: string;
    lastHeartbeatMs?: number;
    lastWsMs?: number;
    lastSource?: string;
    synthetic?: boolean;
};

const heartbeatMap = new Map<string, HeartbeatMetric>();

export function setRpcLatencies(p50Ms: number, p95Ms: number) {
    if (Number.isFinite(p50Ms)) _p50 = Math.max(0, Math.round(p50Ms));
    if (Number.isFinite(p95Ms)) _p95 = Math.max(0, Math.round(p95Ms));
}

export function getRpcP95Ms(): number {
    return _p95;
}

export function getRpcP50Ms(): number {
    return _p50;
}

export function recordHeartbeatMetric(input: {
    venue: string;
    poolId: string;
    heartbeatAt?: number | null;
    wsAt?: number | null;
    source?: string | null;
    synthetic?: boolean;
}): void {
    const key = `${input.venue}:${input.poolId}`;
    const existing = heartbeatMap.get(key) ?? { venue: input.venue, poolId: input.poolId };
    if (input.heartbeatAt != null && Number.isFinite(input.heartbeatAt)) {
        existing.lastHeartbeatMs = Number(input.heartbeatAt);
    }
    if (input.wsAt != null && Number.isFinite(input.wsAt)) {
        existing.lastWsMs = Number(input.wsAt);
    }
    if (typeof input.source === "string" && input.source) {
        existing.lastSource = input.source;
    }
    if (typeof input.synthetic === "boolean") {
        existing.synthetic = input.synthetic;
    }
    heartbeatMap.set(key, existing);
}

export function summarizeHeartbeatByVenue(now = Date.now()): {
    byVenue: Record<string, {
        pools: number;
        withHeartbeat: number;
        missingHeartbeat: number;
        heartbeat_age_ms_max: number | null;
        heartbeat_age_ms_avg: number | null;
        ws_age_ms_max: number | null;
        ws_age_ms_avg: number | null;
    }>;
    pools: HeartbeatMetric[];
} {
    const venueAccum = new Map<string, {
        pools: number;
        withHeartbeat: number;
        missingHeartbeat: number;
        heartbeatAges: number[];
        wsAges: number[];
    }>();

    const pools: HeartbeatMetric[] = [];

    for (const metric of heartbeatMap.values()) {
        const hbAge = metric.lastHeartbeatMs != null ? Math.max(0, now - metric.lastHeartbeatMs) : null;
        const wsAge = metric.lastWsMs != null ? Math.max(0, now - metric.lastWsMs) : null;

        let bucket = venueAccum.get(metric.venue);
        if (!bucket) {
            bucket = { pools: 0, withHeartbeat: 0, missingHeartbeat: 0, heartbeatAges: [], wsAges: [] };
            venueAccum.set(metric.venue, bucket);
        }

        bucket.pools += 1;
        if (hbAge != null) {
            bucket.withHeartbeat += 1;
            bucket.heartbeatAges.push(hbAge);
        } else {
            bucket.missingHeartbeat += 1;
        }
        if (wsAge != null) bucket.wsAges.push(wsAge);

        pools.push({ ...metric });
    }

    const byVenue: Record<string, {
        pools: number;
        withHeartbeat: number;
        missingHeartbeat: number;
        heartbeat_age_ms_max: number | null;
        heartbeat_age_ms_avg: number | null;
        ws_age_ms_max: number | null;
        ws_age_ms_avg: number | null;
    }> = {};

    for (const [venue, bucket] of venueAccum.entries()) {
        const hbMax = bucket.heartbeatAges.length ? Math.max(...bucket.heartbeatAges) : null;
        const hbAvg = bucket.heartbeatAges.length
            ? Math.round(bucket.heartbeatAges.reduce((acc, v) => acc + v, 0) / bucket.heartbeatAges.length)
            : null;
        const wsMax = bucket.wsAges.length ? Math.max(...bucket.wsAges) : null;
        const wsAvg = bucket.wsAges.length
            ? Math.round(bucket.wsAges.reduce((acc, v) => acc + v, 0) / bucket.wsAges.length)
            : null;

        byVenue[venue] = {
            pools: bucket.pools,
            withHeartbeat: bucket.withHeartbeat,
            missingHeartbeat: bucket.missingHeartbeat,
            heartbeat_age_ms_max: hbMax,
            heartbeat_age_ms_avg: hbAvg,
            ws_age_ms_max: wsMax,
            ws_age_ms_avg: wsAvg,
        };
    }

    return { byVenue, pools };
}

export function clearHeartbeatMetrics(): void {
    heartbeatMap.clear();
}
