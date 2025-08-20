#!/usr/bin/env tsx
/**
 * Grid-search yesterday's features to pick (TRADE_THRESHOLD_BPS, MAX_SLIPPAGE_BPS, TRADE_SIZE_BASE).
 * Robust to replay.ts writing features under the run day:
 *  - Prefer <YYYY-MM-DD=yesterday>.jsonl
 *  - Else try today's file
 *  - Else pick the latest by mtime in the features dir
 * Writes: services/arb-mm/data/params/<YYYY-MM-DD>.json (date = logical "yesterday")
 */
import fs from "fs";
import path from "path";

const repoRoot = process.cwd();
const dataDir = process.env.DATA_DIR?.trim() || "services/arb-mm/data";
const featuresDir = path.join(repoRoot, dataDir, "features", "sol_usdc", "v1");
const paramsDir = path.join(repoRoot, dataDir, "params");

type Feature = Partial<{
  absBps: number;
  expected_pnl: number;       // quote units
  slippage_bps: number;
  trade_size_base: number;
}>;

function ydayDateStr(): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate()-1); d.setUTCHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}
function todayDateStr(): string {
  const d = new Date(); d.setUTCHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}
function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }

function pickFeatureFile(): { logicalDate: string; filePath: string } {
  const yday = ydayDateStr();
  const today = todayDateStr();
  const ydayFp = path.join(featuresDir, `${yday}.jsonl`);
  if (fs.existsSync(ydayFp) && fs.statSync(ydayFp).size > 0) {
    return { logicalDate: yday, filePath: ydayFp };
  }
  const todayFp = path.join(featuresDir, `${today}.jsonl`);
  if (fs.existsSync(todayFp) && fs.statSync(todayFp).size > 0) {
    return { logicalDate: yday, filePath: todayFp }; // logical “yesterday”, but using today’s features file
  }
  // fallback: latest by mtime
  if (!fs.existsSync(featuresDir)) {
    throw new Error(`features directory not found: ${path.relative(repoRoot, featuresDir)}`);
  }
  const files = fs.readdirSync(featuresDir).filter(f => f.endsWith(".jsonl"));
  if (files.length === 0) {
    throw new Error(`no features files found in ${path.relative(repoRoot, featuresDir)}`);
  }
  const latest = files
    .map(f => {
      const p = path.join(featuresDir, f);
      return { p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a,b) => b.mtime - a.mtime)[0]!.p;
  return { logicalDate: yday, filePath: latest };
}

function loadFeatures(fp: string): Feature[] {
  const text = fs.readFileSync(fp, "utf8");
  const rows: Feature[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch {}
  }
  return rows;
}

const thresholds = [2,3,4,5,6,8,10];
const slips = [0.5,1,1.5,2];
const sizes = [0.05,0.1,0.2];

function score(rows: Feature[], thr: number, maxSlip: number, size: number) {
  let total = 0;
  let count = 0;
  for (const r of rows) {
    const abs = typeof r.absBps === "number" ? r.absBps : 0;
    const slip = typeof r.slippage_bps === "number" ? r.slippage_bps : 0;
    if (abs >= thr && slip <= maxSlip + 1e-9) {
      let ev = typeof r.expected_pnl === "number" ? r.expected_pnl : 0;
      if (typeof r.trade_size_base === "number" && r.trade_size_base > 0) {
        ev *= (size / r.trade_size_base);
      }
      total += ev;
      count++;
    }
  }
  return { total, count };
}

(function main() {
  ensureDir(paramsDir);
  const { logicalDate, filePath } = pickFeatureFile();
  const rows = loadFeatures(filePath);

  let best = { thr: 0, slip: 0, size: 0, total: -Infinity, count: 0 };
  for (const thr of thresholds)
    for (const slip of slips)
      for (const size of sizes) {
        const { total, count } = score(rows, thr, slip, size);
        if (total > best.total) best = { thr, slip, size, total, count };
      }

  const out = {
    date: logicalDate, // still key by “yesterday”
    best: {
      TRADE_THRESHOLD_BPS: best.thr,
      MAX_SLIPPAGE_BPS: best.slip,
      TRADE_SIZE_BASE: best.size,
      objective_total_expected_pnl: Number.isFinite(best.total) ? Number(best.total.toFixed(9)) : null,
      contributing_rows: best.count
    },
    grid: { thresholds, slips, sizes },
    source_features: path.relative(repoRoot, filePath),
    generated_at: new Date().toISOString()
  };

  const outPath = path.join(paramsDir, `${logicalDate}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`Optimized params written: ${path.relative(repoRoot, outPath)} (from ${path.relative(repoRoot, filePath)})`);
})();
