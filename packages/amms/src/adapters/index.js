// These match what your compiler hints said exists:
//   - Raydium: `RaydiumAdapter` (class / constructor)
//   - Orca:    `createOrcaAdapter` (factory returning AmmAdapter)
import { RaydiumAdapter } from './raydium';
import { createOrcaAdapter } from './orca';
export const makeRaydiumAdapter = (cfg, ctx) => new RaydiumAdapter(cfg, ctx);
export const makeOrcaAdapter = (cfg, ctx) => createOrcaAdapter(cfg, ctx);
export const ADAPTERS = {
    raydium: makeRaydiumAdapter,
    orca: makeOrcaAdapter,
    // Add more like: meteora: makeMeteoraAdapter,
};
