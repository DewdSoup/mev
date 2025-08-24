// services/arb-mm/src/util/phoenix.ts
import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PublicKey as PK } from "@solana/web3.js";
import { logger } from "../ml_logger.js";

/**
 * We cache three things to keep the hot path fast:
 *  - the Phoenix TS SDK module (dynamic import once)
 *  - a single Phoenix.Client bound to our Connection (create once)
 *  - per-market state (load once, then reuse)
 *
 * All subsequent instruction builds are pure and synchronous-ish (no extra RPC).
 */

type PhoenixModule = any;
type PhoenixClient = any;
type PhoenixMarketState = any;

let _phoenixMod: PhoenixModule | null = null;
let _phoenixClient: PhoenixClient | null = null;
const _marketStateById = new Map<string, PhoenixMarketState>();

function asKey(x: string | PublicKey): string {
  return typeof x === "string" ? x : x.toBase58();
}

function summarizeState(state: any) {
  if (!state) return null;
  const keys = Object.keys(state).filter((k) => typeof (state as any)[k] !== "function");
  const summary: Record<string, any> = {};
  for (const k of keys.slice(0, 12)) summary[k] = (state as any)[k];
  return summary;
}

async function loadPhoenixModule(): Promise<PhoenixModule> {
  if (_phoenixMod) return _phoenixMod;
  _phoenixMod = await import("@ellipsis-labs/phoenix-sdk");
  // Introspect once so logs show what the SDK exposes in your env
  const methods = Object.keys((_phoenixMod?.Client?.prototype ?? {}));
  logger.log("phoenix_sdk_pick", { from: "@ellipsis-labs/phoenix-sdk", exportName: "Client", methods });
  return _phoenixMod;
}

async function getPhoenixClient(conn: Connection): Promise<PhoenixClient> {
  if (_phoenixClient) return _phoenixClient;
  const Phoenix = await loadPhoenixModule();
  // Look up the first non-empty market ID
  const envMarket =
    process.env.PHOENIX_MARKET?.trim() ||
    process.env.PHOENIX_MARKET_ID?.trim() ||
    "";
  if (envMarket) {
    if (Phoenix?.Client?.createWithMarketAddresses) {
      try {
        _phoenixClient = await Phoenix.Client.createWithMarketAddresses(conn, [new PK(envMarket)]);
        return _phoenixClient;
      } catch { /* fall through */ }
    }
    if (Phoenix?.Client?.createWithoutConfig) {
      try {
        _phoenixClient = await Phoenix.Client.createWithoutConfig(conn, [new PK(envMarket)]);
        return _phoenixClient;
      } catch { /* fall through */ }
    }
  }
  // Fallback to default create() methods
  if (Phoenix?.Client?.create) {
    _phoenixClient = await Phoenix.Client.create(conn);
  } else if (Phoenix?.default?.Client?.create) {
    _phoenixClient = await Phoenix.default.Client.create(conn);
  } else {
    throw new Error("phoenix_sdk_missing_PhoenixClient");
  }
  return _phoenixClient;
}

async function ensureMarketState(client: PhoenixClient, market: string | PublicKey): Promise<PhoenixMarketState> {
  const id = asKey(market);
  const cached = _marketStateById.get(id);
  if (cached) return cached;

  // Try common access patterns across SDK versions
  let state: any = null;

  // Some versions maintain a map keyed by base58 id
  if (client?.marketStates?.get) {
    state = client.marketStates.get(id) ?? null;
  }

  // Some versions provide getters
  if (!state && typeof client?.getMarketState === "function") {
    try {
      state = await client.getMarketState(new PK(id));
    } catch { /* ignore */ }
  }

  // Fallback: some expose getMarket() returning { state }
  if (!state && typeof client?.getMarket === "function") {
    try {
      const m = await client.getMarket(new PK(id));
      state = m?.state ?? m ?? null;
    } catch { /* ignore */ }
  }

  // If still missing, attempt to add the market manually.  This helps when
  // the client wasn't constructed with the market pre-loaded.
  if (!state && typeof (client as any)?.addMarket === "function") {
    try {
      await (client as any).addMarket(id);
      if (client?.marketStates?.get) {
        state = client.marketStates.get(id) ?? null;
      }
    } catch { /* ignore */ }
  }

  // Last resort: call refreshMarket if available
  if (!state && typeof client?.refreshMarket === "function") {
    try {
      const maybeState = await client.refreshMarket(new PK(id), false);
      state = maybeState ?? null;
    } catch { /* ignore */ }
  }

  if (!state) {
    logger.log("phoenix_market_meta_miss", { market: id, rawKeys: null });
    throw new Error("phoenix_market_meta_miss");
  }

  _marketStateById.set(id, state);
  return state;
}

/**
 * OPTIONAL boot-time warmup to hide the first-call latency entirely.
 * Call once after config is loaded, e.g. prewarmPhoenix(conn, [config.phoenix_market]).
 */
export async function prewarmPhoenix(conn: Connection, markets: (string | PublicKey)[]) {
  const client = await getPhoenixClient(conn);
  await Promise.allSettled(markets.map((m) => ensureMarketState(client, m)));
  logger.log("phoenix_cache_warm", { markets: markets.map(asKey) });
}

/**
 * Build a Phoenix swap (IOC) instruction list with a fully cached hot path.
 * This mirrors your existing executor expectation: on success we return { ixs },
 * on failure we still return an object with an empty ixs[] plus a reason for logging.
 */
export async function buildPhoenixSwapIxs(params: {
  connection: Connection;
  owner: PublicKey;
  market: string | PublicKey;
  side: "buy" | "sell";      // 'buy'/'sell' in BASE terms
  sizeBase: number;          // base amount in UI units
  // These are logged for traceability; guardrails remain on your decision engine.
  limitPx?: number;          // optional (unused here; swap helper handles best price IOC)
  slippageBps?: number;      // optional (unused here)
}): Promise<{ ixs: TransactionInstruction[]; reason?: string; debug?: any }> {
  const { connection, owner, market, side, sizeBase, limitPx, slippageBps } = params;
  const marketId = asKey(market);

  // Accept either a PublicKey (with .toBuffer) or an object with publicKey.toBuffer
  const hasDirectToBuffer = owner && typeof (owner as any).toBuffer === "function";
  const hasNestedToBuffer =
    owner &&
    (owner as any)?.publicKey &&
    typeof (owner as any).publicKey.toBuffer === "function";
  if (!hasDirectToBuffer && !hasNestedToBuffer) {
    const reason = "owner_public_key_missing";
    logger.log("phoenix_build_error", { reason });
    return { ixs: [], reason };
  }

  logger.log("phoenix_build_params", {
    market: marketId,
    side,
    sizeBase,
    limitPx,
    slippageBps,
  });

  try {
    const Phoenix = await loadPhoenixModule();
    const client = await getPhoenixClient(connection);
    const state = await ensureMarketState(client, market);

    // Side mapping: selling BASE => place an Ask; buying BASE => place a Bid
    const sideEnum = side === "sell" ? Phoenix.Side.Ask : Phoenix.Side.Bid;

    // Try each helper in order; catch errors and fall back
    let tx: any | null = null;
    if (typeof state?.getSwapTransaction === "function") {
      try {
        tx = await state.getSwapTransaction({
          side: sideEnum,
          inAmount: sizeBase,
          trader: owner,
        });
      } catch (e) {
        logger.log("phoenix_build_method_error", {
          method: "market.getSwapTransaction",
          error: (e as any)?.message ?? String(e),
        });
        tx = null;
      }
    }
    if (!tx && typeof client?.getSwapTransaction === "function") {
      try {
        tx = await client.getSwapTransaction(new PK(marketId), {
          side: sideEnum,
          inAmount: sizeBase,
          trader: owner,
        });
      } catch (e) {
        logger.log("phoenix_build_method_error", {
          method: "client.getSwapTransaction",
          error: (e as any)?.message ?? String(e),
        });
        tx = null;
      }
    }
    if (!tx && typeof (client as any)?.getSwapIxs === "function") {
      try {
        const res = await (client as any).getSwapIxs.call(client, {
          market: new PK(marketId),
          side: sideEnum,
          inAmount: sizeBase,
          trader: owner,
        });
        const ixs = Array.isArray(res)
          ? res
          : res?.ixs
            ? res.ixs
            : res?.instructions
              ? res.instructions
              : [];
        if (ixs.length > 0) {
          tx = { instructions: ixs };
        }
      } catch (e) {
        logger.log("phoenix_build_method_error", {
          method: "client.getSwapIxs",
          error: (e as any)?.message ?? String(e),
        });
        tx = null;
      }
    }
    if (!tx && typeof state?.createSwapInstruction === "function") {
      try {
        const ix = await state.createSwapInstruction({
          side: sideEnum,
          inAmount: sizeBase,
          trader: owner,
        });
        tx = { instructions: [ix] };
      } catch (e) {
        logger.log("phoenix_build_method_error", {
          method: "market.createSwapInstruction",
          error: (e as any)?.message ?? String(e),
        });
        tx = null;
      }
    }
    if (!tx) {
      const debug = {
        haveLots: !!state?.ticksPerBaseLot,
        haveTicks: !!state?.ticksPerBaseUnit,
        metaSummary: summarizeState(state),
      };
      logger.log("phoenix_build_result_shape", {
        type: "object",
        hasIxsField: false,
        isArray: false,
        keys: ["ok", "reason", "debug"],
      });
      return {
        ixs: [],
        reason: "phoenix_swap_helper_unavailable_in_sdk",
        debug,
      };
    }

    const ixs: TransactionInstruction[] = (tx?.instructions ?? tx?.ixs ?? []).filter(Boolean);

    logger.log("phoenix_build_result_shape", {
      type: "object",
      hasIxsField: Array.isArray(ixs),
      isArray: false,
      keys: ["ixs"],
    });

    if (!ixs.length) {
      return { ixs: [], reason: "phoenix_no_order_ix_generated" };
    }
    return { ixs };
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    logger.log("phoenix_build_error", { reason });
    return { ixs: [], reason };
  }
}

/** For tests / manual resets if needed */
export function _resetPhoenixCachesForTest() {
  _phoenixMod = null;
  _phoenixClient = null;
  _marketStateById.clear();
}
