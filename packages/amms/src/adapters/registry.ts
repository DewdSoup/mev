// packages/amms/src/adapters/registry.ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Connection } from "@solana/web3.js";
import { createRaydiumAdapter } from "./raydium.js";          // CPMM adapter
import { createRaydiumClmmAdapter } from "./raydium_clmm.js";  // CLMM adapter
import { createOrcaAdapter } from "./orca.js";                 // CLMM adapter
import type { AmmAdapter } from "./types.js";
import { logger } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

// ──────────────────────────────────────────────────────────────
// env helpers
// ──────────────────────────────────────────────────────────────
const getenv = (k: string, d = "") => (process.env[k] ?? d).trim();

function enabled(name: string): boolean {
  // Prefer explicit AMMS_ENABLE=list
  const raw = String(process.env.AMMS_ENABLE ?? "").toLowerCase();
  if (raw) {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return list.includes(name);
  }
  // Sensible fallbacks if AMMS_ENABLE unset
  if (name === "raydium") return true; // CPMM default-on (legacy)
  if (name === "raydium_clmm") return getenv("ENABLE_AMM_RAYDIUM_CLMM", "0") === "1";
  if (name === "orca") return getenv("ENABLE_AMM_ORCA", "0") === "1";
  return false;
}

// ──────────────────────────────────────────────────────────────
// config types
// ──────────────────────────────────────────────────────────────
type VenueCfg = {
  kind: string;       // "raydium" | "orca" | "phoenix"
  id: string;         // pool or market pubkey
  poolKind?: string;  // "cpmm" | "clmm" (when applicable)
  feeBps?: number;    // optional hint; adapter will verify on-chain
};

type PairItem = {
  symbol?: string;
  baseMint?: string;
  quoteMint?: string;
  phoenixMarket?: string;
  venues?: VenueCfg[];
};

type PairsCfg = {
  pairs?: PairItem[];
};

// ──────────────────────────────────────────────────────────────
// pairs.json discovery
// ──────────────────────────────────────────────────────────────
function unique(xs: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = path.resolve(x);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

function pairsJsonCandidates(): string[] {
  const envPairs = getenv("PAIRS_JSON") || getenv("AMMS_PAIRS_JSON");
  const repoRoot = path.resolve(__here, "../../../.."); // repo root
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

function readJsonMaybe(p: string): PairsCfg | undefined {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; }
}

// ──────────────────────────────────────────────────────────────
// load ALL pools for (pref) SOL/USDC, else everything
// ──────────────────────────────────────────────────────────────
type PoolSel = {
  venue: "raydium" | "orca";
  poolKind?: "cpmm" | "clmm";
  id: string;
  feeBps?: number;
  from: string;
};

function loadPoolsFromPairsJson(): PoolSel[] {
  const picks = pairsJsonCandidates();
  const out: PoolSel[] = [];
  let selectedFile: string | null = null;

  for (const p of picks) {
    if (!fs.existsSync(p)) continue;
    const j = readJsonMaybe(p);
    if (!j?.pairs?.length) continue;

    selectedFile = p;

    // 1) Prefer SOL/USDC rows
    const solusdc = j.pairs.filter((x) => (x.symbol ?? "").toUpperCase() === "SOL/USDC");
    const rows = solusdc.length ? solusdc : j.pairs;

    for (const pair of rows) {
      for (const v of pair.venues ?? []) {
        const kind = (v.kind ?? "").toLowerCase();
        if (kind !== "raydium" && kind !== "orca") continue;
        const pk = (v.poolKind ?? "").toLowerCase() as "cpmm" | "clmm" | "";
        out.push({
          venue: kind as "raydium" | "orca",
          poolKind: pk || undefined,
          id: v.id,
          feeBps: Number.isFinite(v.feeBps as number) ? Number(v.feeBps) : undefined,
          from: p,
        });
      }
    }
    // stop at the first usable file
    break;
  }

  // Add env fallbacks as *additional* pools (non-blocking)
  const envRay = getenv("RAYDIUM_POOL_ID") || getenv("RAYDIUM_POOL_ID_SOL_USDC");
  if (envRay) out.push({ venue: "raydium", poolKind: "cpmm", id: envRay, from: "env" });

  const envRayClmm = getenv("RAYDIUM_CLMM_POOL_ID");
  if (envRayClmm) out.push({ venue: "raydium", poolKind: "clmm", id: envRayClmm, from: "env" });

  const envOrc = getenv("ORCA_POOL_ID");
  if (envOrc) out.push({ venue: "orca", poolKind: "clmm", id: envOrc, from: "env" });

  // de-dupe by (venue,id)
  const seen = new Set<string>();
  const dedup: PoolSel[] = [];
  for (const it of out) {
    const k = `${it.venue}:${it.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }

  logger.log("amms_registry_config_loaded", {
    candidates: picks,
    selected_file: selectedFile,
    pools_found: dedup.length,
  });

  return dedup;
}

// ──────────────────────────────────────────────────────────────
// adapter tagging helper (no behavior change; metadata only)
// ──────────────────────────────────────────────────────────────
function tagAdapter(a: AmmAdapter, venue: "raydium" | "orca", poolKind: "cpmm" | "clmm", feeHint?: number) {
  // Keep venue canonical; add poolKind for downstream consumers.
  (a as any).venue = venue;             // ensure it's "raydium" or "orca"
  (a as any).poolKind = poolKind;       // <-- NEW: tagged here
  if (feeHint != null && Number.isFinite(feeHint)) {
    (a as any).__hintFeeBps = Number(feeHint);
  }
  return a;
}

// ──────────────────────────────────────────────────────────────
// adapter build
// ──────────────────────────────────────────────────────────────
export async function getEnabledAdapters(conn: Connection): Promise<AmmAdapter[]> {
  const pools = loadPoolsFromPairsJson();

  const out: AmmAdapter[] = [];
  let built = 0, skipped = 0, errored = 0;

  for (const p of pools) {
    try {
      if (p.venue === "raydium") {
        if ((p.poolKind ?? "cpmm") === "cpmm") {
          if (!enabled("raydium")) {
            skipped++;
            logger.log("amms_adapter_disabled", { venue: "raydium", id: p.id });
            continue;
          }
          const a = await createRaydiumAdapter(conn, p.id);
          tagAdapter(a, "raydium", "cpmm", p.feeBps);
          out.push(a);
          built++;
          logger.log("amms_market_match", { name: `${a.symbol} (RAYDIUM-CPMM)`, pool: a.id, fee_hint_bps: p.feeBps });
          continue;
        } else if ((p.poolKind ?? "clmm") === "clmm") {
          if (!enabled("raydium_clmm")) {
            skipped++;
            logger.log("amms_adapter_disabled", { venue: "raydium_clmm", id: p.id });
            continue;
          }
          const a = await createRaydiumClmmAdapter(conn, p.id);
          tagAdapter(a, "raydium", "clmm", p.feeBps);
          out.push(a);
          built++;
          logger.log("amms_market_match", { name: `${a.symbol} (RAYDIUM-CLMM)`, pool: a.id, fee_hint_bps: p.feeBps });
          continue;
        }
        skipped++;
        logger.log("amms_adapter_skipped", { reason: "raydium_pool_kind_unknown", venue: "raydium", poolKind: p.poolKind ?? "unknown", id: p.id });
        continue;
      }

      if (p.venue === "orca") {
        if ((p.poolKind ?? "clmm") !== "clmm") {
          skipped++;
          logger.log("amms_adapter_skipped", { reason: "orca_pool_kind_unsupported", venue: "orca", poolKind: p.poolKind ?? "unknown", id: p.id });
          continue;
        }
        if (!enabled("orca")) {
          skipped++;
          logger.log("amms_adapter_disabled", { venue: "orca", id: p.id });
          continue;
        }
        const a = await createOrcaAdapter(conn, p.id);
        tagAdapter(a, "orca", "clmm", p.feeBps);
        out.push(a);
        built++;
        logger.log("amms_market_match", { name: `${a.symbol} (ORCA-CLMM)`, pool: a.id, fee_hint_bps: p.feeBps });
        continue;
      }

      skipped++;
      logger.log("amms_adapter_skipped", { reason: "unknown_venue", venue: p.venue, id: p.id });
    } catch (e) {
      errored++;
      logger.log("amms_adapter_error", { venue: p.venue, id: p.id, error: String(e) });
    }
  }

  logger.log("amms_pools_loaded", {
    count: out.length,
    built,
    skipped,
    errored,
    via: "adapter-registry:multi",
  });

  return out;
}

// Back-compat shim
export async function buildAdapters(conn: Connection) {
  return getEnabledAdapters(conn);
}
