import type { AmmAdapter } from './types';
import { raydiumAdapter } from './raydium';
import { orcaAdapter } from './orca';
// (Phoenix is handled as orderbook leg; you’ll already have builder/quote for that side)

const adapters: AmmAdapter[] = [raydiumAdapter, orcaAdapter];

export function getAdapter(kind: string): AmmAdapter | undefined {
    return adapters.find(a => a.kind === (kind as any));
}
