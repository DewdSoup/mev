import { PublicKey } from '@solana/web3.js';
import { ADAPTERS } from '../../amms/src/adapters';
import { AmmAdapter } from '../../amms/src/adapters/base';
import { env } from '../../core/src/env';

type PairCfg = {
    symbol: string, baseMint: string, quoteMint: string, phoenixMarket?: string,
    venues: { kind: string, id: string, poolKind?: 'cpmm' | 'clmm' | 'hybrid' }[]
};

export function buildAdaptersForPair(pair: PairCfg, ctx: any): AmmAdapter[] {
    return pair.venues
        .filter(v => v.kind !== 'phoenix')
        .map(v => ADAPTERS[v.kind](v, ctx));
}

export function buildPathsForPair(pair: PairCfg, ctx: any) {
    const adapters = buildAdaptersForPair(pair, ctx);
    const paths: any[] = [];

    // AMM<->PHOENIX
    if (pair.phoenixMarket && env.ROUTER_ALLOW_AMM_PHOENIX) {
        for (const a of adapters) paths.push({ legs: [{ kind: 'amm', adapter: a, side: 'buy' }, { kind: 'phoenix', marketId: pair.phoenixMarket, side: 'sell' }], description: `${a.kind}->phoenix buy->sell` });
        for (const a of adapters) paths.push({ legs: [{ kind: 'phoenix', marketId: pair.phoenixMarket, side: 'buy' }, { kind: 'amm', adapter: a, side: 'sell' }], description: `phoenix->${a.kind} buy->sell` });
    }

    // AMM<->AMM
    if (env.ROUTER_ALLOW_AMM_AMM) {
        for (let i = 0; i < adapters.length; i++) {
            for (let j = 0; j < adapters.length; j++) {
                if (i === j) continue;
                const a = adapters[i], b = adapters[j];
                paths.push({ legs: [{ kind: 'amm', adapter: a, side: 'buy' }, { kind: 'amm', adapter: b, side: 'sell' }], description: `${a.kind}->${b.kind} buy->sell` });
            }
        }
    }

    // Multi-hop (depth 3) — activates when router sees more tokens/pools later
    // Keep placeholder; when you add more pairs with shared tokens, emit 3-leg cycles.

    return paths;
}
