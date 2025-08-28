// packages/phoenix/src/rpc.ts
import 'dotenv/config';
import { Connection, Commitment } from '@solana/web3.js';

/**
 * Phoenix needs an HTTP endpoint, with the WS endpoint passed via config.
 * Passing a wss:// string directly as the first arg throws in @solana/web3.js.
 */
export function makePhoenixConnection(commitment: Commitment = 'processed'): Connection {
    const http =
        process.env.RPC_URL?.trim() ||
        process.env.RPC_PRIMARY?.trim() ||
        (process.env.HELIUS_API_KEY ? `https://rpc.helius.xyz/?api-key=${process.env.HELIUS_API_KEY.trim()}` : 'https://api.mainnet-beta.solana.com');

    if (!http) throw new Error('Missing RPC_URL or RPC_PRIMARY');

    const wss = process.env.RPC_WSS_URL?.trim();
    const cfg = wss ? { commitment, wsEndpoint: wss } : { commitment };

    // web3.js 1.98 expects HTTP here; WS must be in cfg.wsEndpoint
    return new Connection(http, cfg as any);
}
