#!/usr/bin/env tsx
import fs from "fs";
import path from "path";

const cwd = process.cwd();
const repoRoot = cwd.includes(`${path.sep}services${path.sep}arb-mm`)
  ? path.resolve(cwd, "..")
  : cwd;

const dataEnv = process.env.DATA_DIR?.trim();
const dataDir = dataEnv
  ? (path.isAbsolute(dataEnv) ? dataEnv : path.join(repoRoot, dataEnv))
  : path.join(repoRoot, "data", "arb");

const paramsDir = path.join(dataDir, "params");

type Best = Partial<{
  TRADE_THRESHOLD_BPS: number;
  MAX_SLIPPAGE_BPS: number;
  TRADE_SIZE_BASE: number;
}>;

function findLatestParams(): { file?: string; best?: Best } {
  try {
    if (!fs.existsSync(paramsDir)) return {};
    const files = fs.readdirSync(paramsDir).filter(f => f.endsWith(".json"));
    if (files.length === 0) return {};
    const latest = files
      .map(f => path.join(paramsDir, f))
      .map(p => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a,b) => b.m - a.m)[0]!.p;
    const json = JSON.parse(fs.readFileSync(latest, "utf8"));
    return { file: latest, best: json?.best };
  } catch {
    return {};
  }
}

(function main() {
  const { file, best } = findLatestParams();
  if (!file || !best) {
    console.log("(no params found) Looked in:", path.relative(repoRoot, paramsDir));
    process.exit(0);
  }
  const thr = best.TRADE_THRESHOLD_BPS;
  const slip = best.MAX_SLIPPAGE_BPS;
  const size = best.TRADE_SIZE_BASE;

  if (typeof thr !== "number" || typeof slip !== "number" || typeof size !== "number") {
    console.log(`(latest params incomplete) ${path.relative(repoRoot, file)}`);
    if (typeof thr !== "number") console.log("# missing: TRADE_THRESHOLD_BPS");
    if (typeof slip !== "number") console.log("# missing: MAX_SLIPPAGE_BPS");
    if (typeof size !== "number") console.log("# missing: TRADE_SIZE_BASE");
    process.exit(0);
  }

  console.log(`TRADE_THRESHOLD_BPS=${thr}`);
  console.log(`MAX_SLIPPAGE_BPS=${slip}`);
  console.log(`TRADE_SIZE_BASE=${size}`);
})();
