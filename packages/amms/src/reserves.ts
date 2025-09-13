// packages/amms/src/reserves.ts
// AMM reserves & mid-price publisher (JSONL + console), multi-adapter.
// For CPMMs (Raydium) price can come from reserves; for CLMMs (Orca) it must come from sqrtPrice.
// This version uses adapter.mid() when available; falls back to reserve ratio only if needed.
// NEW: publish exact per-pool feeBps in the payload (no venue-default guesses downstream).

import fs from "fs";
import path from "path";
import { Connection } from "@solana/web3.js";
import { getEnabledAdapters } from "./adapters/registry.js";
import type { AmmAdapter, ReserveSnapshot } from "./adapters/types.js";
import { logger } from "./logger.js";

// ────────────────────────────────────────────────────────────────────────────
// Minimal dotenv loader so this process sees repo-root .env.live / .env
(function bootstrapEnv() {
  if ((globalThis as any).__AMMS_ENV_BOOTSTRAPPED__) return;
  (globalThis as any).__AMMS_ENV_BOOTSTRAPPED__ = true;

  const candidates = [
    process.env.DOTENV_PATH,
    path.resolve(process.cwd(), "../../.env.live"),
    path.resolve(process.cwd(), "../.env.live"),
    path.resolve(process.cwd(), ".env.live"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../.env"),
    path.resolve(process.cwd(), ".env"),
  ].filter(Boolean) as string[];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const txt = fs.readFileSync(file, "utf8");
      for (const rawLine of txt.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2];
        // strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = val;
      }
      // Stop at first file found
      break;
    } catch {
      /* ignore and try next */
    }
  }
})();
// ────────────────────────────────────────────────────────────────────────────

const getenv = (k: string, d?: string) => process.env[k] ?? d ?? "";

const RPC_URL = getenv("RPC_URL", getenv("HELIUS_RPC") || getenv("RPC") || "").trim();
const TICK_MS = Math.max(250, Number(getenv("AMMS_TICK_MS", "1000")) || 1000);

// Where to write JSONL (the arb follower tails this file)
function resolveOutPath(): string {
  const p =
    getenv("EDGE_AMMS_JSONL") ||
    path.resolve(process.cwd(), "logs", "runtime.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

class JsonlWriter {
  private stream: fs.WriteStream;
  constructor(private filePath: string) {
    this.stream = fs.createWriteStream(filePath, {
      flags: "a",
      encoding: "utf8",
      mode: 0o644,
    });
  }
  writeEnvelope(event: string, data: any) {
    this.stream.write(JSON.stringify({ t: new Date().toISOString(), event, data }) + "\n");
  }
  end() { this.stream.end(); }
}

// Compute CPMM mid price (QUOTE per 1 BASE) from reserves
function priceFromReserves(r: ReserveSnapshot): number {
  const base = Number(r.base);
  const quote = Number(r.quote);
  if (!(base > 0 && quote > 0)) return NaN;
  const baseF = base / 10 ** r.baseDecimals;
  const quoteF = quote / 10 ** r.quoteDecimals;
  return quoteF / baseF;
}

async function snapshotToPayload(a: AmmAdapter, r: ReserveSnapshot) {
  // Prefer adapter.mid() (works for CLMM & CPMM). Fallback: ratio from reserves.
  let px = NaN;
  try {
    if (typeof (a as any).mid === "function") {
      const m = await (a as any).mid();
      if (Number.isFinite(m) && m > 0) px = m;
    }
  } catch {
    /* ignore and fall back */
  }
  if (!Number.isFinite(px) || px <= 0) {
    px = priceFromReserves(r);
  }

  // Exact per-pool fee if adapter supports it; else conservative env fallback.
  let feeBps = Number.NaN;
  try {
    if (typeof (a as any).feeBps === "function") {
      const fb = await (a as any).feeBps();
      if (Number.isFinite(fb) && fb > 0) feeBps = fb;
    }
  } catch {
    /* ignored */
  }
  if (!Number.isFinite(feeBps) || feeBps <= 0) {
    const venue = String(a.venue).toLowerCase();
    if (venue === "raydium") feeBps = Number(process.env.RAYDIUM_TRADE_FEE_BPS ?? process.env.AMM_TAKER_FEE_BPS ?? 25);
    else if (venue === "orca") feeBps = Number(process.env.ORCA_TRADE_FEE_BPS ?? process.env.AMM_TAKER_FEE_BPS ?? 30);
    else feeBps = Number(process.env.AMM_TAKER_FEE_BPS ?? 25);
  }

  const payload: any = {
    symbol: a.symbol,
    venue: a.venue,
    ammId: a.id,
    ts: Date.now(),
    baseDecimals: r.baseDecimals,
    quoteDecimals: r.quoteDecimals,
    px,
    px_str: String(px),
    feeBps,
    tick_ms: TICK_MS,
    validation_passed: Number.isFinite(px) && px > 0 && r.base > 0n && r.quote > 0n,
  };

  // For CLMMs (Orca), vault totals are not CPMM "reserves" and mislead downstream logic.
  // Do NOT include base_int/quote_int so the joiner skips CPMM impact math for Orca.
  if (String(a.venue).toLowerCase() !== "orca") {
    payload.base_int = r.base.toString();
    payload.quote_int = r.quote.toString();
  }

  return payload;
}

async function main() {
  const conn = new Connection(RPC_URL || "https://api.mainnet-beta.solana.com", { commitment: "confirmed" });
  logger.log("amms_boot", { rpc: RPC_URL || "https://api.mainnet-beta.solana.com" });

  const outPath = resolveOutPath();
  const writer = new JsonlWriter(outPath);
  writer.writeEnvelope("amms_boot", { rpc: RPC_URL || "https://api.mainnet-beta.solana.com" });

  let adapters: AmmAdapter[] = [];
  try {
    adapters = await getEnabledAdapters(conn);
  } catch (e: any) {
    const err = String(e?.stack || e?.message || e);
    console.error("Adapter registry error", err);
  }

  if (adapters.length === 0) {
    writer.writeEnvelope("amms_fatal_error", { error: "no_valid_adapters" });
    console.error("No AMM adapters enabled — exiting");
    return;
  }

  // Inject connection if adapter needs it
  for (const a of adapters) (a as any).setConnection?.(conn);

  let active = true;
  process.on("SIGINT", () => { active = false; writer.end(); });
  process.on("SIGTERM", () => { active = false; writer.end(); });

  while (active) {
    const now = Date.now();
    const jobs = adapters.map(async (a) => {
      try {
        const r = await a.reservesAtoms();
        const payload = await snapshotToPayload(a, r);
        writer.writeEnvelope("amms_price", payload);
        if (payload.validation_passed) {
          logger.log("amms_price", payload);
        }
      } catch (e: any) {
        logger.log("amms_adapter_error", { venue: a.venue, id: a.id, error: String(e?.message ?? e) });
      }
    });

    await Promise.allSettled(jobs);

    const sleep = TICK_MS - (Date.now() - now);
    if (sleep > 0) {
      await new Promise((r) => setTimeout(r, sleep));
    }
  }
}

main().catch((e) => {
  const err = String(e?.stack || e?.message || e);
  console.log("amms_fatal", { err });
});
