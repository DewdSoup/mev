#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Phoenix WS prewarm probe.
 * Usage:
 *   RPC_URL=... RPC_WSS_URL=... PHOENIX_MARKET=... pnpm tsx services/arb-mm/scripts/probe-phx-ws.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { prewarmPhoenix } from "../src/util/phoenix.ts";

const RPC = (process.env.RPC_URL || process.env.RPC_PRIMARY || "https://api.mainnet-beta.solana.com").trim();
const WS = process.env.RPC_WSS_URL?.trim();
const conn = new Connection(RPC, { commitment: "processed", wsEndpoint: WS });

const market =
    process.env.PHOENIX_MARKET ||
    process.env.PHOENIX_MARKET_ID ||
    "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";

console.log("[probe-phx-ws] rpc=", RPC, " ws=", WS || "(none)", " market=", market);
await prewarmPhoenix(conn, [new PublicKey(market)]);
console.log("[probe-phx-ws] prewarm complete");
process.exit(0);
