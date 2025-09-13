// packages/amms/src/adapters/registry.ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Connection } from "@solana/web3.js";
import { createRaydiumAdapter } from "./raydium.js";
import { createOrcaAdapter } from "./orca.js";
import type { AmmAdapter } from "./types.js";
import { logger } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

const getenv = (k: string, d = "") => (process.env[k] ?? d).trim();

function enabled(name: string): boolean {
  const raw = String(process.env.AMMS_ENABLE ?? "").toLowerCase();
  if (raw) {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return list.includes(name);
  }
  if (name === "raydium") return true;
  if (name === "orca") return getenv("ENABLE_AMM_ORCA", "0") === "1";
  return false;
}

type PairsCfg = {
  pairs: {
    symbol?: string;
    venues?: { kind: string; id: string }[];
  }[];
};

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const k = path.resolve(p);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

function pairsJsonCandidates(): string[] {
  const envPairs = getenv("PAIRS_JSON") || getenv("AMMS_PAIRS_JSON");
  const repoRoot = path.resolve(__here, "../../../.."); // .../packages/amms/src/adapters -> repo root

  return unique(
    [
      envPairs,
      path.resolve(process.cwd(), "configs/pairs.json"),
      path.resolve(process.cwd(), "packages/amms/configs/pairs.json"),
      path.resolve(process.cwd(), "..", "configs/pairs.json"),
      path.resolve(process.cwd(), "..", "..", "configs/pairs.json"),
      path.join(repoRoot, "configs/pairs.json"),
    ].filter(Boolean)
  );
}

/**
 * Read pairs.json and return both Raydium & Orca pool ids, preferring the SOL/USDC entry.
 * Also honors PAIRS_JSON / AMMS_PAIRS_JSON envs for an explicit file path.
 */
function readPairsJson(): Record<"raydium" | "orca", string | undefined> {
  const candidates = pairsJsonCandidates();

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as PairsCfg;

      // 1) Prefer the SOL/USDC pair and aggregate both venues
      for (const pair of raw?.pairs ?? []) {
        const sym = (pair.symbol ?? "").toUpperCase();
        if (sym !== "SOL/USDC") continue;

        let r: string | undefined;
        let o: string | undefined;
        for (const v of pair.venues ?? []) {
          const kind = (v.kind ?? "").toLowerCase();
          if (kind === "raydium" && !r) r = v.id;
          if (kind === "orca" && !o) o = v.id;
        }
        if (r || o) {
          return { raydium: r, orca: o };
        }
      }

      // 2) Fallback: first seen of each venue across all pairs
      let r: string | undefined;
      let o: string | undefined;
      for (const pair of raw?.pairs ?? []) {
        for (const v of pair.venues ?? []) {
          const kind = (v.kind ?? "").toLowerCase();
          if (kind === "raydium" && !r) r = v.id;
          if (kind === "orca" && !o) o = v.id;
          if (r && o) break;
        }
        if (r && o) break;
      }
      return { raydium: r, orca: o };
    } catch {
      /* ignore and try next */
    }
  }
  return { raydium: undefined, orca: undefined };
}

function resolvePools() {
  // Accept all common env names
  const raydiumPool =
    getenv("RAYDIUM_POOL") ||
    getenv("RAYDIUM_POOL_ID") ||
    getenv("RAYDIUM_POOL_ID_SOL_USDC") ||
    getenv("AMMS_RAYDIUM_POOL");

  const orcaPool =
    getenv("ORCA_POOL") ||
    getenv("ORCA_POOL_ID") ||
    getenv("AMMS_ORCA_POOL") ||
    getenv("AMMS_ORCA_POOL_ID");

  // If envs are absent, try configs/pairs.json
  const fromPairs = readPairsJson();

  const raydium =
    raydiumPool ||
    fromPairs.raydium ||
    (enabled("raydium") ? "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" : "");

  const orca =
    orcaPool ||
    fromPairs.orca ||
    (enabled("orca") ? "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ" : "");

  return { raydiumPool: raydium, orcaPool: orca };
}

/** Returns ready-to-use adapters (what reserves.ts expects). */
export async function getEnabledAdapters(conn: Connection): Promise<AmmAdapter[]> {
  const { raydiumPool, orcaPool } = resolvePools();
  const out: AmmAdapter[] = [];

  if (enabled("raydium") && raydiumPool) {
    const a = await createRaydiumAdapter(conn, raydiumPool);
    out.push(a);
    logger.log("amms_market_match", { name: `${a.symbol} (RAYDIUM)`, pool: a.id });
  } else {
    logger.log("amms_adapter_disabled", { venue: "raydium" });
  }

  if (enabled("orca") && orcaPool) {
    const a = await createOrcaAdapter(conn, orcaPool);
    out.push(a);
    logger.log("amms_market_match", { name: `${a.symbol} (ORCA)`, pool: a.id });
  } else {
    logger.log("amms_adapter_disabled", { venue: "orca" });
  }

  logger.log("amms_pools_loaded", {
    count: out.length,
    total: out.length,
    fromLocal: false,
    via: "adapter-registry",
  });

  return out;
}

// Back-compat shim
export async function buildAdapters(conn: Connection, _cfg?: { raydiumPool?: string; orcaPool?: string }) {
  return getEnabledAdapters(conn);
}
