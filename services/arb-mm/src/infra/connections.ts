// services/arb-mm/src/infra/connections.ts
import "dotenv/config";
import { Connection } from "@solana/web3.js";

// Accept HTTP from RPC_URL (or RPC_PRIMARY), WS is optional.
const httpEndpointEnv: string = String(process.env.RPC_URL ?? process.env.RPC_PRIMARY ?? "").trim();
const wsEndpointEnv: string | undefined = process.env.RPC_WSS_URL?.trim();

if (!httpEndpointEnv) {
    throw new Error("Missing RPC_URL or RPC_PRIMARY in env");
}

export const RPC_HTTP: string = httpEndpointEnv;
export const RPC_WSS: string = wsEndpointEnv ?? ""; // keep export for callers that read it

// Build a single Connection that knows about the WS endpoint (if provided).
export const connection: Connection = new Connection(RPC_HTTP, {
    commitment: "processed",
    wsEndpoint: wsEndpointEnv,
});

// If other code expects a separate "wsConn", point it at the same Connection.
export const wsConn: Connection = connection;
