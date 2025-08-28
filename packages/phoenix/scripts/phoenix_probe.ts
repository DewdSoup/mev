// packages/phoenix/scripts/phoenix_probe.ts
// Minimal Phoenix orderbook probe using your Helius HTTP+WSS.
// Prints JSON lines with best bid/ask + mid for PHOENIX_MARKET every tick.
//
// Run (from repo root):
//   pnpm exec dotenv -e .env.live -- pnpm -C packages/phoenix tsx scripts/phoenix_probe.ts
//
// Expected output (one line per tick):
// {"event":"phoenix_probe_l2","ts":"...","market":"...","haveBid":true,"haveAsk":true,"bestBid":204.31,"bestAsk":204.33,"mid":204.32,"source":"sdk:getUiLadder"}

import { Connection, PublicKey, Commitment } from '@solana/web3.js';
import { Client } from '@ellipsis-labs/phoenix-sdk';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try to load env from repo root first (.env.live, then .env)
const repoRoot = resolve(__dirname, '../../..');
const candidateEnvPaths = [
    resolve(repoRoot, '.env.live'),
    resolve(repoRoot, '.env'),
    // fallbacks if someone runs from different CWD
    resolve(__dirname, '../../.env.live'),
    resolve(__dirname, '../../.env'),
];
for (const p of candidateEnvPaths) {
    if (fs.existsSync(p)) {
        loadEnv({ path: p });
        break;
    }
}

// --- Config from env ---
const RPC_HTTP =
    process.env.RPC_URL ||
    process.env.RPC_PRIMARY ||
    process.env.HELIUS_RPC_URL ||
    '';
const RPC_WSS =
    process.env.RPC_WSS_URL ||
    (RPC_HTTP ? RPC_HTTP.replace(/^http(s?):/, 'ws$1:') : '');
const MARKET = process.env.PHOENIX_MARKET || '';
const COMMITMENT = (process.env.TX_CONFIRM_LEVEL as Commitment) || 'confirmed';
const TICK_MS = Math.max(200, Number(process.env.PHOENIX_TICK_MS ?? 2000));

if (!RPC_HTTP) {
    throw new Error(
        'Missing RPC_HTTP: set RPC_URL or RPC_PRIMARY in .env.live/.env'
    );
}
if (!MARKET || MARKET.length < 32) {
    throw new Error(
        'Missing/invalid PHOENIX_MARKET in .env.live (e.g., SOL/USDC: 4DoNfF...)'
    );
}

// --- Build Solana connection (bind Helius WSS if provided) ---
const connection = new Connection(RPC_HTTP, {
    commitment: COMMITMENT,
    wsEndpoint: RPC_WSS || undefined,
});

// --- Phoenix client + market ---
const client = await Client.create(connection);
const marketPk = new PublicKey(MARKET);

// Critical: ensure market is added before any fetch/subscribe.
await client.addMarket(marketPk);
// Prime state once before we start ticking.
await client.refreshMarket(marketPk);

// Helper to coerce a field that could be named `price` or `px`
function firstPrice(levels: any[] | undefined): number | undefined {
    if (!Array.isArray(levels) || levels.length === 0) return undefined;
    const p = (levels[0] as any)?.price ?? (levels[0] as any)?.px;
    return typeof p === 'number' && Number.isFinite(p) ? p : undefined;
}

async function sampleOnce() {
    try {
        // Prefer aggregated ladder for clear top-of-book.
        let source = 'sdk:getUiLadder';
        let ladder: any;
        try {
            ladder = await client.getUiLadder(marketPk);
        } catch {
            // Fallback to L3 UI book if ladder ABI differs.
            source = 'sdk:getL3UiBook';
            const l3: any = await client.getL3UiBook(marketPk);
            ladder = {
                bids: Array.isArray(l3?.bids) ? l3.bids : [],
                asks: Array.isArray(l3?.asks) ? l3.asks : [],
            };
        }

        const bestBid = firstPrice(ladder?.bids);
        const bestAsk = firstPrice(ladder?.asks);
        const haveBid = typeof bestBid === 'number';
        const haveAsk = typeof bestAsk === 'number';
        const mid =
            haveBid && haveAsk ? Number(((bestBid + bestAsk) / 2).toFixed(8)) : null;

        const out = {
            event: 'phoenix_probe_l2',
            ts: new Date().toISOString(),
            market: MARKET,
            haveBid,
            haveAsk,
            bestBid: haveBid ? bestBid : null,
            bestAsk: haveAsk ? bestAsk : null,
            mid,
            source,
        };

        console.log(JSON.stringify(out));
    } catch (err: any) {
        console.error(
            JSON.stringify({
                event: 'phoenix_probe_error',
                ts: new Date().toISOString(),
                err: String(err?.message || err),
            })
        );
    }
}

async function main() {
    // Quick sanity on RPC so failures are obvious
    try {
        const [version, slot] = await Promise.all([
            connection.getVersion(),
            connection.getSlot(COMMITMENT),
        ]);
        console.error(
            JSON.stringify({
                event: 'phoenix_probe_boot',
                rpc: RPC_HTTP.replace(/\?.*$/, '?api-key=***'),
                wss_attached: Boolean(RPC_WSS),
                slot,
                version,
            })
        );
    } catch (e) {
        console.error(
            JSON.stringify({
                event: 'phoenix_probe_boot_error',
                err: String(e),
            })
        );
    }

    // First sample immediately, then interval.
    await sampleOnce();
    const h = setInterval(async () => {
        await client.refreshMarket(marketPk);
        await sampleOnce();
    }, TICK_MS);

    // Graceful exit
    process.on('SIGINT', () => {
        clearInterval(h);
        console.error(JSON.stringify({ event: 'phoenix_probe_exit' }));
        process.exit(0);
    });
}

await main();
