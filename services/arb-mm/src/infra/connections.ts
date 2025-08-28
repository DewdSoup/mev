// services/arb-mm/src/infra/connections.ts
import 'dotenv/config';
import { Connection } from '@solana/web3.js';

// Accept HTTP from RPC_URL (or RPC_PRIMARY), WS is optional.
const HTTP = (process.env.RPC_URL || process.env.RPC_PRIMARY || '').trim();
const WS = process.env.RPC_WSS_URL?.trim();

if (!HTTP) throw new Error('Missing RPC_URL or RPC_PRIMARY in env');

export const RPC_HTTP = HTTP;
export const RPC_WSS = WS || ''; // keep export for callers that read it

// Build a single Connection that knows about WS endpoint.
export const connection = new Connection(HTTP, { commitment: 'processed', wsEndpoint: WS });

// If other code expects a separate "wsConn", point it at the same Connection.
export const wsConn = connection;
