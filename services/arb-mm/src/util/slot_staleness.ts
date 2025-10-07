import { logger } from "../ml_logger.js";

export type AmmSnapshotMeta = {
    ts: number;                 // publisher timestamp (ms)
    slot?: number | null;       // publisher slot if known
    venue: string;              // "raydium" | "orca" | ...
    ammId: string;              // pool id
};

export type PhoenixClock = {
    slot?: number | null;       // latest Phoenix slot you’ve seen
    ts?: number | null;         // optional wall clock reference
};

function envInt(k: string, d: number) {
    const v = Number(process.env[k]);
    return Number.isFinite(v) ? v : d;
}

// How many slots the AMM feed is allowed to lag behind Phoenix before we ignore it.
const MAX_LAG_SLOTS = envInt("AMM_SLOT_MAX_LAG", 12);
// Hard wall-clock staleness (ms). Falls back to PRICE_STALENESS_MS if set.
const MAX_AGE_MS = envInt("AMM_SNAPSHOT_MAX_AGE_MS", envInt("PRICE_STALENESS_MS", 5000));

export function staleReason(
    s: AmmSnapshotMeta,
    clock: PhoenixClock,
    now = Date.now()
): string | null {
    const ageMs = Math.max(0, now - (s.ts || 0));
    if (ageMs > MAX_AGE_MS) return `age_ms>${MAX_AGE_MS}`;

    const ammSlot = s.slot ?? null;
    const phoSlot = clock.slot ?? null;
    if (ammSlot != null && phoSlot != null) {
        const lag = phoSlot - ammSlot;
        if (lag > MAX_LAG_SLOTS) {
            return `slot_lag>${MAX_LAG_SLOTS} (amm=${ammSlot} phoenix=${phoSlot})`;
        }
    }
    return null;
}

export function shouldIgnoreAmmSnapshot(
    s: AmmSnapshotMeta,
    clock: PhoenixClock,
    now = Date.now()
): boolean {
    const reason = staleReason(s, clock, now);
    if (reason) {
        logger.log("amm_snapshot_ignored", {
            venue: s.venue,
            ammId: s.ammId,
            reason,
            ts: s.ts,
            slot: s.slot,
            phoenix_slot: clock.slot ?? null,
        });
        return true;
    }
    return false;
}
