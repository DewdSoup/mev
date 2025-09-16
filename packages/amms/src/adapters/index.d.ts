import type { AmmAdapter } from './base';
export type AdapterFactory = (cfg: any, ctx: any) => AmmAdapter;
export declare const makeRaydiumAdapter: AdapterFactory;
export declare const makeOrcaAdapter: AdapterFactory;
export declare const ADAPTERS: Record<string, AdapterFactory>;
export type { AmmAdapter };
//# sourceMappingURL=index.d.ts.map