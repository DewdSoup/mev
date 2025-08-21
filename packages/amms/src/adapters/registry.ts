import { Connection } from "@solana/web3.js";
import type { AmmAdapter } from "./adapter.js";
import { RaydiumAdapter } from "./raydium.js";

function getenv(k: string, d = "") {
  const v = process.env[k];
  return (typeof v === "string" && v.trim()) ? v.trim() : d;
}

export async function getEnabledAdapters(conn: Connection): Promise<AmmAdapter[]> {
  const list: AmmAdapter[] = [];

  // Raydium (on by default)
  if ((getenv("ENABLE_AMM_RAYDIUM", "1")) === "1") {
    const poolId = getenv("RAYDIUM_POOL_ID", getenv("RAYDIUM_POOL_ID_SOL_USDC", ""));
    if (poolId) {
      const a = new RaydiumAdapter({ poolId, symbol: "SOL/USDC" });
      if (a.init) await a.init(conn);
      list.push(a);
    }
  }

  // Future:
  // if (getenv("ENABLE_AMM_ORCA")==="1") list.push(new OrcaAdapter(...));
  // if (getenv("ENABLE_AMM_METEORA")==="1") list.push(new MeteoraAdapter(...));
  // if (getenv("ENABLE_AMM_OPENBOOK")==="1") list.push(new OpenBookAdapter(...));

  return list;
}
