// packages/amms/src/reserves.ts
// AMM publisher (adapter-based).
// - Raydium adapter enabled by default (reads reserves and emits amms_price).
// - Same JSONL shape as before so arb-mm/joiner keep working unchanged.
// - Add more venues by adding adapters and turning them on via env.

import { Connection } from "@solana/web3.js";
import { logger } from "@mev/storage";
import { getEnabledAdapters } from "./adapters/registry.js";

function getenvNum(k: string, d: number) {
  const n = Number(process.env[k]);
  return Number.isFinite(n) ? n : d;
}

function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "***");
    return url.toString();
  } catch {
    return u;
  }
}

function resolveRpc(): string {
  const fromEnv = process.env.RPC_URL?.trim() || process.env.RPC_PRIMARY?.trim();
  if (fromEnv) return fromEnv;
  const helius = process.env.HELIUS_API_KEY?.trim();
  if (helius) return `https://rpc.helius.xyz/?api-key=${helius}`;
  return "https://api.mainnet-beta.solana.com";
}

const RPC = resolveRpc();
const TICK_MS = getenvNum("AMMS_TICK_MS", 2000);

async function main() {
  logger.log("amms_boot", { rpc: maskUrl(RPC) });
  const conn = new Connection(RPC, { commitment: "processed" });

  // Build the active adapter set (Raydium by default; others later).
  const adapters = await getEnabledAdapters(conn);

  logger.log("amms_pools_loaded", {
    count: adapters.length,
    fromLocal: true,
    via: "adapter-registry",
  });

  for (const a of adapters) {
    logger.log("amms_market_match", {
      name: `${a.symbol} (${a.venue.toUpperCase()})`,
      pool: a.id.split(":")[1],
    });
  }

  // Polling loop: emit amms_price for each adapter.
  const tick = async () => {
    const now = Date.now();
    for (const a of adapters) {
      try {
        const r = await a.reservesAtoms(); // {base, quote, baseDecimals, quoteDecimals}
        const baseF = Number(r.base) / Math.pow(10, r.baseDecimals);
        const quoteF = Number(r.quote) / Math.pow(10, r.quoteDecimals);
        const px = quoteF / Math.max(1e-18, baseF);

        logger.log("amms_price", {
          ts: now,
          symbol: a.symbol,
          ammId: a.id.split(":")[1],
          baseDecimals: r.baseDecimals,
          quoteDecimals: r.quoteDecimals,
          px,
          px_str: px.toString(),
          base_int: r.base.toString(),
          quote_int: r.quote.toString(),
          tick_ms: TICK_MS,
        });
      } catch (e) {
        logger.log("amms_error", { id: a.id, err: String(e) });
      }
    }
  };

  await tick();
  setInterval(tick, TICK_MS);
  // keep process alive for dev runner
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => logger.log("amms_fatal", { err: String(e) }));
