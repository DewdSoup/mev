export function computeTipLamports(evAbsUsd: number, slotLoad: number, cfg: any): number {
    const { alpha, beta, gamma, maxPct, maxLamports, usdPerLamport } = cfg;
    const share = alpha * evAbsUsd;
    let lam = (share / usdPerLamport) + beta * slotLoad + gamma;
    lam = Math.max(cfg.floor, Math.min(lam, maxLamports));
    return Math.floor(lam);
  }
  