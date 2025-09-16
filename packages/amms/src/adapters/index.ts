import type { AmmAdapter } from "./base";
import * as ray from "./raydium";
import * as orc from "./orca";

/** Adapter factories may be sync or async */
export type AdapterFactory = (cfg: any, ctx: any) => AmmAdapter | Promise<AmmAdapter>;

/** Best-effort wrapper: supports multiple export styles per adapter module */
export const makeRaydiumAdapter: AdapterFactory = (cfg, ctx) => {
    // 1) canonical factory
    if (typeof (ray as any).makeRaydiumAdapter === "function") {
        return (ray as any).makeRaydiumAdapter(cfg, ctx);
    }
    // 2) alternate factory
    if (typeof (ray as any).createRaydiumAdapter === "function") {
        return (ray as any).createRaydiumAdapter(cfg, ctx);
    }
    // 3) class constructor
    if (typeof (ray as any).RaydiumAdapter === "function") {
        // most Raydium adapters take (cfg) only; ignore ctx if unused
        return new (ray as any).RaydiumAdapter(cfg);
    }
    throw new Error("Raydium adapter export not found");
};

export const makeOrcaAdapter: AdapterFactory = (cfg, ctx) => {
    if (typeof (orc as any).makeOrcaAdapter === "function") {
        return (orc as any).makeOrcaAdapter(cfg, ctx);
    }
    if (typeof (orc as any).createOrcaAdapter === "function") {
        return (orc as any).createOrcaAdapter(cfg, ctx);
    }
    if (typeof (orc as any).OrcaAdapter === "function") {
        return new (orc as any).OrcaAdapter(cfg);
    }
    throw new Error("Orca adapter export not found");
};

export const ADAPTERS: Record<string, AdapterFactory> = {
    raydium: makeRaydiumAdapter,
    orca: makeOrcaAdapter
};

export type { AmmAdapter };
