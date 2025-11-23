import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

function loadExactEnvLive() {
  const repoEnvLive = path.resolve(repoRoot, ".env.live");
  const svcEnvLive = path.resolve(__dirname, "..", ".env.live");
  const explicit = process.env.DOTENV_CONFIG_PATH
    ? path.resolve(process.env.DOTENV_CONFIG_PATH)
    : null;

  const chosen = (() => {
    if (explicit && fs.existsSync(explicit)) return explicit;
    if (fs.existsSync(repoEnvLive)) return repoEnvLive;
    if (fs.existsSync(svcEnvLive)) return svcEnvLive;
    return null;
  })();

  if (chosen) {
    dotenvConfig({ path: chosen, override: true });
  } else {
    dotenvConfig();
    console.error("[env] .env.live not found; expected at", repoEnvLive, "or", svcEnvLive);
  }

  if (process.env.LIVE_TRADING == null || process.env.LIVE_TRADING.trim() === "") {
    process.env.LIVE_TRADING = "1";
  }
  if (process.env.SHADOW_TRADING == null || process.env.SHADOW_TRADING.trim() === "") {
    process.env.SHADOW_TRADING = "0";
  }
  process.env.__ENV_LIVE_LOCKED = "1";
  if (process.env.SKIP_BALANCE_READS == null) {
    process.env.SKIP_BALANCE_READS = "1";
  }
}

loadExactEnvLive();

function resolvePairsPath(): string | null {
  const fromEnv = process.env.PAIRS_JSON?.trim();
  if (fromEnv) {
    const abs = path.isAbsolute(fromEnv) ? fromEnv : path.resolve(fromEnv);
    if (fs.existsSync(abs)) return abs;
  }

  const candidates = [
    path.resolve(repoRoot, "configs", "pairs.json"),
    path.resolve(__dirname, "..", "configs", "pairs.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function shouldRunMultipair(): boolean {
  const override = String(process.env.ARB_RUNNER ?? "").trim().toLowerCase();
  if (override === "single") return false;
  if (override === "multi") return true;

  const pairsPath = resolvePairsPath();
  if (!pairsPath) return false;

  try {
    const raw = JSON.parse(fs.readFileSync(pairsPath, "utf8"));
    const norm = Array.isArray(raw?.pairs) ? raw.pairs : Array.isArray(raw) ? raw : [];
    if (!norm.length) return false;

    if (norm.length > 1) return true;

    const venues = Array.isArray(norm[0]?.venues) ? norm[0].venues : [];
    const ammVenues = venues.filter(
      (v: any) => v && String(v.kind ?? v.venue ?? "").toLowerCase() !== "phoenix",
    );
    return ammVenues.length > 1;
  } catch {
    return false;
  }
}

const target = shouldRunMultipair() ? "./multipair.js" : "./main.js";

if (!process.env.QUIET_BOOT) {
  const mode = target.includes("multi") ? "multipair" : "single";
  console.log(`[boot] runner=${mode}`);
}

await import(target);
