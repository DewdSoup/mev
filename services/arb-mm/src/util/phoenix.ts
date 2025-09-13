// services/arb-mm/src/util/phoenix.ts
// Phoenix client/market bootstrap + taker swap ixs with *correct* seeding.
// Keeps full functionality while removing bad permutations (e.g. "mainnet-beta"
// URL parsing) that caused noisy runtime errors across SDK versions.

import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PublicKey as PK } from "@solana/web3.js";
import { logger } from "../ml_logger.js";

// Loosened surface types to stay SDK-version-agnostic on runtime paths
type PhoenixModule = any;
type PhoenixClient = any;
type PhoenixMarketState = any;

let _phoenixMod: PhoenixModule | null = null;
let _phoenixClient: PhoenixClient | null = null;
const _marketStateById = new Map<string, PhoenixMarketState>();

function asKey(x: string | PublicKey): string {
    return typeof x === "string" ? x : x.toBase58();
}

function listLoadedMarketKeys(client: PhoenixClient): string[] {
    try {
        const out: string[] = [];
        const container = client?.marketStates ?? client?.markets;
        if (!container) return out;
        if (typeof container.keys === "function") {
            for (const k of container.keys()) {
                if (k && typeof (k as any).toBase58 === "function") out.push((k as any).toBase58());
                else if (typeof k === "string") out.push(k);
            }
            return out;
        }
        if (typeof container === "object") {
            for (const k of Object.keys(container)) out.push(k);
        }
        return out;
    } catch {
        return [];
    }
}

async function loadPhoenixModule(): Promise<PhoenixModule> {
    if (_phoenixMod) return _phoenixMod;
    _phoenixMod = await import("@ellipsis-labs/phoenix-sdk");
    const proto =
        _phoenixMod?.Client?.prototype ??
        _phoenixMod?.default?.Client?.prototype ?? {};
    const methods = Object.getOwnPropertyNames(proto).filter(
        (k) => typeof (proto as any)[k] === "function"
    );
    logger.log("phoenix_sdk_pick", {
        from: "@ellipsis-labs/phoenix-sdk",
        exportName: "Client",
        methods,
    });
    return _phoenixMod;
}

async function getPhoenixClient(conn: Connection, seedMarkets?: (string | PublicKey)[]): Promise<PhoenixClient> {
    if (_phoenixClient) return _phoenixClient;

    const Phoenix = await loadPhoenixModule();
    const Ctor: any = Phoenix?.Client ?? Phoenix?.default?.Client;
    if (!Ctor) throw new Error("phoenix_sdk_missing_PhoenixClient");

    const seeds: PublicKey[] = [];
    for (const m of seedMarkets ?? []) {
        try { seeds.push(typeof m === "string" ? new PK(m) : m); } catch { /* ignore */ }
    }

    // Preferred: strictly (connection, seeds)
    if (seeds.length && typeof Ctor.createWithMarketAddresses === "function") {
        try {
            _phoenixClient = await Ctor.createWithMarketAddresses(conn, seeds);
            logger.log("phoenix_client_seeded", { order: "conn,seeds", seeds: seeds.map((p) => p.toBase58()) });
            return _phoenixClient;
        } catch (e: any) {
            logger.log("phoenix_client_seed_attempt_error", { order: "conn,seeds", err: String(e?.message ?? e) });
        }
    }

    // Fallbacks for older SDKs (no URL / network strings)
    _phoenixClient = typeof Ctor.create === "function" ? await Ctor.create(conn) : new Ctor(conn);
    logger.log("phoenix_client_unseeded", { note: "Client.create(connection)" });
    return _phoenixClient;
}

function tryGetMarketState(client: PhoenixClient, pk: PublicKey, idStr: string): PhoenixMarketState | null {
    try {
        const ms = client?.marketStates ?? client?.markets;
        if (!ms) return null;
        if (typeof ms.get === "function") {
            return ms.get(idStr) ?? ms.get(pk) ?? ms.get(pk.toBase58()) ?? null;
        }
        if (typeof ms === "object" && idStr in ms) return (ms as any)[idStr];
        return null;
    } catch {
        return null;
    }
}

async function ensureMarketState(client: PhoenixClient, market: string | PublicKey): Promise<PhoenixMarketState> {
    const idStr = asKey(market);
    const pk = typeof market === "string" ? new PK(market) : market;

    const cached = _marketStateById.get(idStr);
    if (cached) return cached;

    let state: any = tryGetMarketState(client, pk, idStr);

    // Try to add/refresh/resolve via whatever surfaces the SDK exposes
    if (!state && typeof client?.addMarket === "function") {
        try { await client.addMarket(pk); } catch { /* ignore */ }
        state = tryGetMarketState(client, pk, idStr);
    }
    if (!state && typeof client?.refreshMarket === "function") {
        try { await client.refreshMarket(pk, false); } catch { /* ignore */ }
        state = tryGetMarketState(client, pk, idStr);
    }
    if (!state && typeof client?.getMarketState === "function") {
        try { state = await client.getMarketState(pk); } catch { /* ignore */ }
    }
    if (!state && typeof client?.getMarket === "function") {
        try {
            const m = await client.getMarket(pk);
            state = (m as any)?.state ?? m ?? null;
        } catch { /* ignore */ }
    }

    if (!state) {
        logger.log("phoenix_market_meta_miss", {
            market: idStr,
            keys: listLoadedMarketKeys(client),
            containers: { marketStates: !!client?.marketStates, markets: !!client?.markets },
        });
        throw new Error("phoenix_market_meta_miss");
    }

    _marketStateById.set(idStr, state);
    return state;
}

export async function prewarmPhoenix(conn: Connection, markets: (string | PublicKey)[]): Promise<void> {
    const client = await getPhoenixClient(conn, markets);
    const results = await Promise.allSettled(markets.map((m) => ensureMarketState(client, m)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    logger.log("phoenix_cache_warm", { markets: markets.map(asKey), ok, fail });
}

/**
 * Build Phoenix taker swap instructions.
 * side: "buy" (Bid)  → inAmount is QUOTE UI (USDC)
 * side: "sell" (Ask) → inAmount is BASE UI (SOL)
 */
export async function buildPhoenixSwapIxs(params: {
    connection: Connection;
    owner: PublicKey;
    market: string | PublicKey;
    side: "buy" | "sell";
    sizeBase: number;
    limitPx?: number;
    slippageBps?: number;
}): Promise<{ ixs: TransactionInstruction[]; reason?: string; debug?: any }> {
    const { connection, owner, market, side, sizeBase, limitPx, slippageBps } = params;

    const ownerPk: PublicKey | undefined =
        (owner as any)?.toBuffer ? owner as PublicKey : (owner as any)?.publicKey;

    if (!ownerPk || typeof (ownerPk as any).toBuffer !== "function") {
        const reason = "owner_public_key_missing";
        logger.log("phoenix_build_error", { reason });
        return { ixs: [], reason };
    }

    try {
        const Phoenix = await loadPhoenixModule();
        const client = await getPhoenixClient(connection, [market as any]);
        const state = await ensureMarketState(client, market);

        const Side = Phoenix.Side ?? (Phoenix as any).Side ?? {};
        const sideEnum: number = side === "sell" ? (Side.Ask ?? 1) : (Side.Bid ?? 0);

        // For "buy", most SDKs expect inAmount denominated in QUOTE UI (≈ sizeBase * limitPx).
        const inAmountUi: number =
            side === "sell"
                ? Number(sizeBase)
                : Number(sizeBase) * Math.max(0, Number(limitPx ?? 0));

        const slip: number = Math.max(0, Number(slippageBps ?? 50)) / 10_000;

        let tx: any | null = null;

        // (1) Preferred: packet → instruction (when exposed on state)
        if (typeof state?.getSwapOrderPacket === "function" && typeof state?.createSwapInstruction === "function") {
            try {
                const packet = state.getSwapOrderPacket({ side: sideEnum, inAmount: inAmountUi, slippage: slip });
                const ix = state.createSwapInstruction(packet, ownerPk);
                tx = { instructions: [ix] };
            } catch { /* proceed */ }
        }

        // (2) Market-level getSwapTransaction
        if (!tx && typeof state?.getSwapTransaction === "function") {
            try {
                tx = await state.getSwapTransaction({ side: sideEnum, inAmount: inAmountUi, trader: ownerPk });
            } catch { /* proceed */ }
        }

        // (3) Client-level getSwapTransaction(market,args)
        if (!tx && typeof client?.getSwapTransaction === "function") {
            try {
                tx = await client.getSwapTransaction(new PK(asKey(market)), { side: sideEnum, inAmount: inAmountUi, trader: ownerPk });
            } catch { /* proceed */ }
        }

        // (4) Client-level getSwapIxs
        if (!tx && typeof (client as any)?.getSwapIxs === "function") {
            try {
                const res = await (client as any).getSwapIxs.call(client, {
                    market: new PK(asKey(market)),
                    side: sideEnum,
                    inAmount: inAmountUi,
                    trader: ownerPk,
                });
                const ixs = Array.isArray(res) ? res : res?.ixs ?? res?.instructions ?? [];
                if (Array.isArray(ixs) && ixs.length) tx = { instructions: ixs };
            } catch { /* proceed */ }
        }

        if (!tx) {
            const debug = { marketKeys: listLoadedMarketKeys(client) };
            return { ixs: [], reason: "phoenix_swap_helper_unavailable_in_sdk", debug };
        }

        const ixs: TransactionInstruction[] = (tx?.instructions ?? tx?.ixs ?? []).filter(Boolean);
        if (!ixs.length) return { ixs: [], reason: "phoenix_no_order_ix_generated" };
        return { ixs };
    } catch (err: any) {
        const reason = err?.message ?? String(err);
        logger.log("phoenix_build_error", { reason });
        return { ixs: [], reason };
    }
}

export function _resetPhoenixCachesForTest(): void {
    _phoenixMod = null;
    _phoenixClient = null;
    _marketStateById.clear();
}
