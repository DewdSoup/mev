// Lightweight shared state for RPC latency → fee bumping
let _p50 = 0;
let _p95 = 0;

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
