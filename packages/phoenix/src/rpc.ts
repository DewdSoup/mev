// packages/phoenix/src/rpc.ts
import { Commitment, Connection, clusterApiUrl } from "@solana/web3.js";

function pickHttpRpc(): string {
    const env =
        process.env.RPC_PRIMARY?.trim() ||
        process.env.RPC_URL?.trim();
    if (env) return env;

    const helius = process.env.HELIUS_API_KEY?.trim();
    if (helius) return `https://rpc.helius.xyz/?api-key=${helius}`;

    return clusterApiUrl("mainnet-beta");
}

export function makePhoenixConnection(commitment: Commitment = "processed"): Connection {
    const http = pickHttpRpc();
    const ws = process.env.RPC_WSS_URL?.trim();

    // Connection accepts an options object with wsEndpoint.
    // We keep it minimal; commitment comes from caller.
    const conn = new Connection(http, { commitment, wsEndpoint: ws });

    return conn;
}
