// packages/amms/src/reserves.ts
// AMM reserves & mid-price publisher (JSONL + console), multi-adapter.
// Uses adapter.mid() for price when available; publishes exact per-pool feeBps.
// Now emits poolKind when available and hides vault ints for any CLMM.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Connection } from "@solana/web3.js";
import { getEnabledAdapters } from "./adapters/registry.js";
import type { AmmAdapter, ReserveSnapshot } from "./adapters/types.js";
import { logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

// Bootstrap env from closest .env.live / .env (idempotent)
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
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = val;
      }
      break;
    } catch { /* noop */ }
  }
})();

const getenv = (k: string, d?: string) => process.env[k] ?? d ?? "";
const RPC_URL = getenv("RPC_URL", getenv("HELIUS_RPC") || getenv("RPC") || "").trim();
const TICK_MS = Math.max(250, Number(getenv("AMMS_TICK_MS", "1000")) || 1000);

// ───────────────────────────────────────────────────────────────
// Unified path resolver: write under services/arb-mm/data/reports/amms
// Honors ARB_DATA_DIR / ARB_REPORTS_DIR / EDGE_AMMS_JSONL if provided.
// ───────────────────────────────────────────────────────────────
function resolveOutPath(): string {
  // Highest precedence: explicit file path override
  const explicit = getenv("EDGE_AMMS_JSONL", "").trim();
  if (explicit) {
    fs.mkdirSync(path.dirname(explicit), { recursive: true });
    return explicit;
  }

  // Compute defaults relative to repo root
  const repoRoot = path.resolve(__here, "..", "..", ".."); // from packages/amms/src → repo
  const ammsDirHint = getenv("AMMS_DATA_DIR");
  const ammsDir = ammsDirHint
    ? (path.isAbsolute(ammsDirHint) ? ammsDirHint : path.resolve(process.cwd(), ammsDirHint))
    : path.join(repoRoot, "data", "amms");

  fs.mkdirSync(ammsDir, { recursive: true });
  return path.join(ammsDir, "runtime.jsonl");
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
  end() {
    this.stream.end();
  }
}

function priceFromReserves(r: ReserveSnapshot): number {
  const base = Number(r.base), quote = Number(r.quote);
  if (!(base > 0 && quote > 0)) return NaN;
  const baseF = base / 10 ** r.baseDecimals;
  const quoteF = quote / 10 ** r.quoteDecimals;
  return quoteF / baseF;
}

async function snapshotToPayload(a: AmmAdapter, r: ReserveSnapshot) {
  // Prefer adapter.mid(); fallback to reserve ratio only if needed.
  let px = NaN;
  try {
    if (typeof (a as any).mid === "function") {
      const m = await (a as any).mid();
      if (Number.isFinite(m) && m > 0) px = m;
    }
  } catch { /* noop */ }
  if (!Number.isFinite(px) || px <= 0) px = priceFromReserves(r);

  // Exact per-pool fee if adapter supports it; else conservative env fallback.
  let feeBps = Number.NaN;
  let feeSource = "fallback_env";
  try {
    if (typeof (a as any).feeBps === "function") {
      const fb = await (a as any).feeBps();
      if (Number.isFinite(fb) && fb > 0) {
        feeBps = fb;
        feeSource = "onchain_or_adapter";
      }
    }
  } catch { /* noop */ }
  if (!Number.isFinite(feeBps) || feeBps <= 0) {
    const venue = String(a.venue).toLowerCase();
    if (venue === "raydium")
      feeBps = Number(process.env.RAYDIUM_TRADE_FEE_BPS ?? process.env.AMM_TAKER_FEE_BPS ?? 25);
    else if (venue === "orca")
      feeBps = Number(process.env.ORCA_TRADE_FEE_BPS ?? process.env.AMM_TAKER_FEE_BPS ?? 30);
    else feeBps = Number(process.env.AMM_TAKER_FEE_BPS ?? 25);
  }

  const poolKind: string | undefined = (() => {
    const pk = (a as any)?.poolKind;
    if (!pk) return undefined;
    const v = String(pk).trim().toLowerCase();
    return v || undefined;
  })();

  const payload: any = {
    symbol: (a as any)?.symbol ?? "UNKNOWN/UNKNOWN",
    venue: (a as any)?.venue ?? "unknown",
    ammId: (a as any)?.id ?? "",
    poolKind, // 👈 include when available ("cpmm" | "clmm" | "hybrid")
    ts: Date.now(),
    baseDecimals: r.baseDecimals,
    quoteDecimals: r.quoteDecimals,
    px,
    px_str: String(px),
    feeBps,
    fee_source: feeSource,
    tick_ms: TICK_MS,
    validation_passed: Number.isFinite(px) && px > 0,
  };

  // Hide vault ints for ANY CLMM to prevent CPMM misuse downstream.
  const isClmm = (poolKind === "clmm");
  if (!isClmm) {
    payload.base_int = r.base.toString();
    payload.quote_int = r.quote.toString();
  }

  return payload;
}

async function main() {
  const conn = new Connection(
    RPC_URL || "https://api.mainnet-beta.solana.com",
    { commitment: "confirmed" }
  );

  const outPath = resolveOutPath();
  const writer = new JsonlWriter(outPath);

  writer.writeEnvelope("amms_boot", {
    rpc: RPC_URL || "https://api.mainnet-beta.solana.com",
    out_path: outPath,
  });

  let adapters: AmmAdapter[] = [];
  try {
    adapters = await getEnabledAdapters(conn);
  } catch (e: any) {
    console.error("Adapter registry error", String(e?.stack || e?.message || e));
  }
  if (adapters.length === 0) {
    writer.writeEnvelope("amms_fatal_error", { error: "no_valid_adapters" });
    console.error("No AMM adapters enabled — exiting");
    return;
  }

  // Inject connection if adapter wants it
  for (const a of adapters) (a as any).setConnection?.(conn);

  let active = true;
  const end = () => { active = false; writer.end(); };
  process.on("SIGINT", end);
  process.on("SIGTERM", end);

  while (active) {
    const t0 = Date.now();
    const slotNow = await conn.getSlot("processed").catch(() => undefined);
    await Promise.allSettled(
      adapters.map(async (a) => {
        try {
          const r = await a.reservesAtoms();
          const payload = await snapshotToPayload(a, r);
          if (slotNow != null) (payload as any).slot = slotNow; // add slot
          writer.writeEnvelope("amms_price", payload);
          if (payload.validation_passed) logger.log("amms_price", payload);
        } catch (e: any) {
          logger.log("amms_adapter_error", {
            venue: (a as any)?.venue ?? "unknown",
            id: (a as any)?.id ?? "",
            error: String(e?.message ?? e),
          });
        }
      })
    );
    const sleep = TICK_MS - (Date.now() - t0);
    if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
  }
}

main().catch((e) =>
  console.log("amms_fatal", { err: String(e?.stack || e?.message || e) })
);
