import { ADAPTERS } from '../../amms/dist/adapters/index.js';
import type { AmmAdapter } from '../../amms/dist/adapters/base.js';
import { env } from '../../core/dist/env.js';

type PairCfg = {
    symbol: string;
    baseMint: string;
    quoteMint: string;
    phoenixMarket?: string;
    venues: { kind: string; id: string; poolKind?: 'cpmm' | 'clmm' | 'hybrid' }[];
};

/**
 * Builds AMM adapters for a pair. Supports both sync and async factories.
 */
export async function buildAdaptersForPair(
    pair: PairCfg,
    ctx: any
): Promise<AmmAdapter[]> {
    const factories = pair.venues
        .filter((v) => v.kind !== 'phoenix')
        .map((v) => ADAPTERS[v.kind](v, ctx)); // may return AmmAdapter | Promise<AmmAdapter>

    const adapters = await Promise.all(factories);
    return adapters as AmmAdapter[];
}

/**
 * Enumerate paths for a pair (AMM<->PHX and AMM<->AMM).
 */
export async function buildPathsForPair(pair: PairCfg, ctx: any) {
    const adapters = await buildAdaptersForPair(pair, ctx);
    const paths: any[] = [];

    // AMM<->PHOENIX
    if (pair.phoenixMarket && env.ROUTER_ALLOW_AMM_PHOENIX) {
        for (const a of adapters) {
            paths.push({
                legs: [
                    { kind: 'amm', adapter: a, side: 'buy' },
                    { kind: 'phoenix', marketId: pair.phoenixMarket, side: 'sell' },
                ],
                description: `${a.kind}->phoenix buy->sell`,
            });
        }
        for (const a of adapters) {
            paths.push({
                legs: [
                    { kind: 'phoenix', marketId: pair.phoenixMarket, side: 'buy' },
                    { kind: 'amm', adapter: a, side: 'sell' },
                ],
                description: `phoenix->${a.kind} buy->sell`,
            });
        }
    }

    // AMM<->AMM
    if (env.ROUTER_ALLOW_AMM_AMM) {
        for (let i = 0; i < adapters.length; i++) {
            for (let j = 0; j < adapters.length; j++) {
                if (i === j) continue;
                const a = adapters[i],
                    b = adapters[j];
                paths.push({
                    legs: [
                        { kind: 'amm', adapter: a, side: 'buy' },
                        { kind: 'amm', adapter: b, side: 'sell' },
                    ],
                    description: `${a.kind}->${b.kind} buy->sell`,
                });
            }
        }
    }

    // Multi-hop (depth 3) placeholder for future tokens/pools

    return paths;
}
