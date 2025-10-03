import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadExactEnvLive() {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
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

  process.env.LIVE_TRADING = "1";
  process.env.SHADOW_TRADING = "0";
  process.env.__ENV_LIVE_LOCKED = "1";
  if (process.env.SKIP_BALANCE_READS == null) {
    process.env.SKIP_BALANCE_READS = "1";
  }
}

loadExactEnvLive();

await import("./main.js");
