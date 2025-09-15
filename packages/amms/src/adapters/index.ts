import type { AmmAdapter } from './base';
import { makeRaydiumAdapter } from './raydium';   // wrap your existing code
import { makeOrcaAdapter } from './orca';         // wrap your existing code

export type AdapterFactory = (cfg: any, ctx: any) => AmmAdapter;

export const ADAPTERS: Record<string, AdapterFactory> = {
    raydium: makeRaydiumAdapter,
    orca: makeOrcaAdapter,
    // meteora: makeMeteoraAdapter,  // add later by dropping a file and one line here
};
