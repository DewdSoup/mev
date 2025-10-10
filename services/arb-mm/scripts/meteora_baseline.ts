import fs from "fs";
import path from "path";

function usage(): never {
  console.error("Usage: pnpm --filter @mev/arb-mm meteora:baseline [run-dir]");
  console.error("If no run directory is supplied, data/runs/latest is used.");
  process.exit(1);
}

async function main() {
  const runDirArg = process.argv[2];
  if (runDirArg === "--help" || runDirArg === "-h") usage();

  const runPathInput = runDirArg ?? path.join("data", "runs", "latest");
  const candidateDirs = [
    path.resolve(process.cwd(), runPathInput),
    path.resolve(process.cwd(), "..", "..", runPathInput),
  ];

  let runDir: string | null = null;
  for (const candidate of candidateDirs) {
    if (fs.existsSync(candidate)) {
      runDir = candidate;
      break;
    }
  }

  if (!runDir) {
    console.error(`Run directory not found: tried ${candidateDirs.join(", ")}`);
    process.exit(2);
  }

  const logFile = path.join(runDir, "arb-runtime.log");
  if (!fs.exists(logFile)) {
    console.error(`No arb-runtime.log found at ${logFile}`);
    process.exit(2);
  }

  const contents = fs.readFileSync(logFile, "utf8");
  const swapMatches = contents.match(/meteora_dlmm_swap\b/g) ?? [];
  const exactOutMatches = contents.match(/meteora_dlmm_swap_exact_out\b/g) ?? [];
  const candidateMatches = contents.match(/"src":"meteora:/g) ?? [];

  if (!swapMatches.length || !exactOutMatches.length) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          reason: "missing_meteora_swap_logs",
          meteora_dlmm_swap: swapMatches.length,
          meteora_dlmm_swap_exact_out: exactOutMatches.length,
          candidate_src_meteora: candidateMatches.length,
          logFile,
        },
        null,
        2,
      ),
    );
    process.exit(3);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        runDir,
        logFile,
        meteora_dlmm_swap: swapMatches.length,
        meteora_dlmm_swap_exact_out: exactOutMatches.length,
        candidate_src_meteora: candidateMatches.length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error({ ok: false, err: String(err?.message ?? err) });
  process.exit(99);
});
