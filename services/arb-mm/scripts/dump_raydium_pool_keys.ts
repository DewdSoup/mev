// services/arb-mm/scripts/dump_raydium_pool_keys.ts
// Dumps full Raydium AmmV4 pool keys for a given pool id to configs/raydium.pool.json
// Compatible with @raydium-io/raydium-sdk 1.3.1-beta.58 (we use 'any' where types differ).

import fs from "fs";
import path from "path";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Liquidity, MAINNET_PROGRAM_ID } from "@raydium-io/raydium-sdk";

function env(k: string, d?: string) {
  const v = process.env[k];
  return v && v.length ? v : d;
}

async function main() {
  const RPC_URL = env("RPC_URL", clusterApiUrl("mainnet-beta"));
  const POOL_ID = new PublicKey(
    env("RAYDIUM_POOL_ID", "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2")
  );

  const connection = new Connection(RPC_URL, "confirmed");

  // Older SDKs: use a legacy helper; we fallback across known names.
  const liq: any = Liquidity;

  let poolKeys: any | null = null;
  if (typeof liq.fetchPoolKeys === "function") {
    poolKeys = await liq.fetchPoolKeys({ connection, id: POOL_ID });
  } else if (typeof liq.getAssociatedPoolKeysV4 === "function") {
    // This path needs many params; we avoid it if fetchPoolKeys exists.
    throw new Error(
      "Your SDK lacks fetchPoolKeys(). Please update SDK or provide a JSON of pool keys."
    );
  } else {
    throw new Error("No compatible Liquidity pool-keys function found.");
  }

  if (!poolKeys) {
    throw new Error("Failed to fetch pool keys");
  }

  const outDir = path.resolve(process.cwd(), "configs");
  const outPath = path.join(outDir, "raydium.pool.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(poolKeys, null, 2));
  console.log(
    `Wrote Raydium pool keys to ${outPath}\nProgram: ${MAINNET_PROGRAM_ID.AmmV4.toBase58()}`
  );
}

main().catch((e) => {
  console.error("dump_raydium_pool_keys error:", e);
  process.exit(1);
});
