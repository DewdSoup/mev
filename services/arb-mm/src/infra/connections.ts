// services/arb-mm/src/infra/connections.ts
import "dotenv/config";
import type { Connection } from "@solana/web3.js";
import { rpcClient, rpc, RPC_HTTP_ENDPOINT, RPC_WS_ENDPOINT } from "@mev/rpc-facade";

export const RPC_HTTP: string = RPC_HTTP_ENDPOINT;
export const RPC_WSS: string = RPC_WS_ENDPOINT;

export const connection: Connection = rpcClient;
export const wsConn: Connection = rpcClient;

// Expose the facade for callers that need warmup/metrics without importing from new path yet.
export const rpcFacade = rpc;
