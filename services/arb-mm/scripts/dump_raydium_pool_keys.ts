// services/arb-mm/scripts/dump_raydium_pool_keys.ts
/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import { Liquidity } from "@raydium-io/raydium-sdk";

/** Load env with .env.live priority (service root → repo root) */
(function loadEnv() {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, ".env.live"),
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "..", "..", ".env.live"),
    path.resolve(cwd, "..", "..", ".env")
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        break;
      }
    } catch {
      /* ignore */
    }
  }
})();

function resolveRpc(): string {
  const url = process.env.RPC_URL?.trim() || process.env.RPC_PRIMARY?.trim();
  if (url) return url;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return "https://api.mainnet-beta.solana.com";
}

function b58(x: string | PublicKey): string {
  try {
    return typeof x === "string" ? new PublicKey(x).toBase58() : x.toBase58();
  } catch {
    return String(x);
  }
}

async function findPoolById(conn: Connection, id: PublicKey): Promise<any | null> {
  // Try enumerating all CPMM v4 pools (fast enough on modern RPCs)
  try {
    const pools: any[] = await (Liquidity as any).fetchAllPoolKeys(conn);
    const match = pools.find((p: any) => {
      if (!p?.id) return false;
      if (p.id instanceof PublicKey) return p.id.equals(id);
      try {
        return new PublicKey(p.id).equals(id);
      } catch {
        return false;
      }
    });
    if (match) return match;
  } catch {
    /* fall through */
  }

  // Fallback: direct by-id lookup if available
  try {
    if (typeof (Liquidity as any).fetchPoolKeysById === "function") {
      const single = await (Liquidity as any).fetchPoolKeysById(conn, id);
      if (single) return single;
    }
  } catch {
    /* ignore */
  }

  return null;
}

function resolveOutPath(): string {
  const envPath = process.env.RAYDIUM_POOL_JSON_PATH?.trim();
  if (envPath) return path.resolve(envPath);
  // default to repo-root/configs/raydium.pool.json when launched from services/arb-mm
  return path.resolve(process.cwd(), "..", "..", "configs", "raydium.pool.json");
}

async function main() {
  const arg = (process.argv[2] || "").trim();
  const poolStr = arg || (process.env.RAYDIUM_POOL_ID || "").trim();

  if (!poolStr) {
    console.error("Usage: tsx scripts/dump_raydium_pool_keys.ts <RAYDIUM_POOL_ID>");
    process.exit(1);
  }

  const rpc = resolveRpc();
  const conn = new Connection(rpc, { commitment: "processed" as Commitment });

  const poolPk = new PublicKey(poolStr);
  console.log(`ℹ️  Fetching Raydium AMM v4 pool: ${poolPk.toBase58()}`);

  let pool: any;
  try {
    pool = await findPoolById(conn, poolPk);
  } catch (e: any) {
    console.error(
      `dump_raydium_pool_keys error: failed to scan pools: ${String(e?.message ?? e)}`
    );
    process.exit(1);
  }

  if (!pool) {
    console.error(`dump_raydium_pool_keys error: pool not found on-chain: ${poolPk.toBase58()}`);
    process.exit(1);
  }

  const out = {
    id: b58(pool.id),
    baseVault: b58(pool.baseVault),
    quoteVault: b58(pool.quoteVault),
    baseMint: b58(pool.baseMint),
    quoteMint: b58(pool.quoteMint)
  };

  const outPath = resolveOutPath();
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  } catch (e: any) {
    console.error(`dump_raydium_pool_keys error: failed to write ${outPath}: ${String(e?.message ?? e)}`);
    process.exit(1);
  }

  console.log(`✅ Wrote pool keys to: ${outPath}`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(`dump_raydium_pool_keys fatal: ${String(e?.message ?? e)}`);
  process.exit(1);
});
