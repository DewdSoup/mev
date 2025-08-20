// services/arb-mm/scripts/daily_if_needed.ts
// ESM-safe. If yesterday's report/params are missing, run the daily pipeline.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, "..", "data");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const PARAMS_DIR = path.join(DATA_DIR, "params");

function yesterUtfDate(): string {
  const now = new Date();
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  y.setUTCDate(y.getUTCDate() - 1);
  const yyyy = y.getUTCFullYear();
  const mm = String(y.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(y.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const day = yesterUtfDate();
const reportFile = path.join(REPORTS_DIR, `${day}.md`);
const paramsFile = path.join(PARAMS_DIR, `${day}.json`);

const haveReport = exists(reportFile);
const haveParams = exists(paramsFile);

if (haveReport && haveParams) {
  console.log(
    `daily_if_needed: ok — yesterday already done (${path.relative(
      process.cwd(),
      reportFile
    )}, ${path.relative(process.cwd(), paramsFile)})`
  );
  process.exit(0);
}

console.log(
  `daily_if_needed: missing ${
    !haveReport && !haveParams ? "report+params" : !haveReport ? "report" : "params"
  } for ${day} → running "pnpm daily"...`
);

const res = spawnSync("pnpm", ["run", "daily"], {
  stdio: "inherit",
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
});

process.exit(res.status == null ? 1 : res.status);
