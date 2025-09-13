// services/arb-mm/src/boot.ts
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", ".."); // …/services/arb-mm/src → repo root

(function loadEnv() {
    if (String(process.env.__ENV_LIVE_LOCKED ?? "0") === "1") return;

    const envLive = path.resolve(REPO_ROOT, ".env.live");
    const envDot = path.resolve(REPO_ROOT, ".env");
    if (fs.existsSync(envLive)) dotenv.config({ path: envLive });
    else if (fs.existsSync(envDot)) dotenv.config({ path: envDot });
    else dotenv.config();

    process.env.__ENV_LIVE_LOCKED = "1";
})();

// Defer to main after env is loaded
import("./main.js").catch((e) => {
    console.error("[boot] failed to start main:", e?.stack || e);
});
