import { createReadStream } from 'node:fs';
import { writeFile, mkdir, stat } from 'node:fs/promises';

// CJS ↔ ESM interop: import as namespaces/defaults, then destructure
import * as StreamJson from 'stream-json';
import * as StreamChain from 'stream-chain';
import * as StreamValuesMod from 'stream-json/streamers/StreamValues.js'; // note .js

const { parser } = StreamJson;
const { chain } = StreamChain;
const { streamValues } = StreamValuesMod;

const RAW = 'packages/amms/configs/.tmp/raydium.raw.json';
const OUT = 'packages/amms/configs/raydium.pools.json';

// Canonical mints
const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11Dg1GJ3xJEhGk';

const norm = (s) => (s ?? '').toLowerCase();

const looksSOLUSDC = (o) => {
  const nameSym = `${norm(o.symbol)} ${norm(o.name)}`;
  if (nameSym.includes('sol') && nameSym.includes('usdc')) return true;
  const bm = o.baseMint ?? o.base_mint;
  const qm = o.quoteMint ?? o.quote_mint;
  return (bm === SOL && qm === USDC) || (bm === USDC && qm === SOL);
};

const asPool = (o) => ({
  id:            o.id ?? o.amm_id ?? o.ammId ?? o.pool_id ?? null,
  ammId:         o.ammId ?? o.amm_id ?? o.id ?? o.pool_id ?? null,
  baseMint:      o.baseMint ?? o.base_mint ?? null,
  quoteMint:     o.quoteMint ?? o.quote_mint ?? null,
  baseDecimals:  o.baseDecimals ?? o.base_decimals ?? null,
  quoteDecimals: o.quoteDecimals ?? o.quote_decimals ?? null,
  baseVault:     o.baseVault ?? o.base_vault ?? null,
  quoteVault:    o.quoteVault ?? o.quote_vault ?? null,
  symbol:        o.symbol ?? null,
  name:          o.name ?? null
});

async function main() {
  const st = await stat(RAW).catch(() => null);
  if (!st) {
    console.error(`RAW not found: ${RAW}. Fetch it first.`);
    process.exit(1);
  }

  const found = [];
  const seen = new Set();

  function maybeCollect(obj) {
    if (!obj || typeof obj !== 'object') return;

    // “pool-like” sanity
    const hasMints =
      (obj.baseMint || obj.base_mint) &&
      (obj.quoteMint || obj.quote_mint);

    if (!hasMints && !obj.symbol && !obj.name) return;
    if (!looksSOLUSDC(obj)) return;

    const pool = asPool(obj);
    const key = pool.ammId || pool.id;
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(pool);
  }

  await new Promise((resolve, reject) => {
    const pipeline = chain([
      createReadStream(RAW),
      parser(),          // generic JSON tokenizer
      streamValues()     // emits {key, value} for each value encountered
    ]);

    pipeline.on('data', ({ value }) => {
      // Try the current node
      maybeCollect(value);

      // Common Raydium shapes
      for (const key of ['official', 'unOfficial', 'pools']) {
        const v = value?.[key];
        if (Array.isArray(v)) v.forEach(maybeCollect);
      }

      const liq = value?.liquidity;
      if (liq && typeof liq === 'object' && Array.isArray(liq.pools)) {
        liq.pools.forEach(maybeCollect);
      }
    });

    pipeline.once('end', resolve);
    pipeline.once('error', reject);
  });

  await mkdir('packages/amms/configs', { recursive: true });
  await writeFile(OUT, JSON.stringify(found, null, 2));
  console.log(`WROTE ${OUT} with ${found.length} pool(s).`);
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
