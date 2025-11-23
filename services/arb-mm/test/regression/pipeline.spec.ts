import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";

import { EdgeJoiner } from "../../src/edge/joiner.js";
import { logger } from "../../src/ml_logger.js";
import type { SlipMode } from "../../src/config.js";
import { getAdapter } from "../../src/adapters/index.js";

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures");
const RAYDIUM_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

const baseParams = {
  minAbsBps: 0,
  waitLogMs: 10_000,
  thresholdBps: 0,
  flatSlippageBps: 50,
  tradeSizeBase: 0.05,
  decisionMinBase: 0.01,
  minBase: 0.01,
  minTradeBase: 0.01,
  phoenixFeeBps: 2,
  ammFeeBps: 25,
  fixedTxCostQuote: 0,
};

const baseCfg = {
  bookTtlMs: 2_000,
  activeSlippageMode: "flat" as SlipMode,
  phoenixSlippageBps: 0,
  cpmmMaxPoolTradeFrac: 0.25,
  dynamicSlippageExtraBps: 0,
  logSimFields: false,
  enforceDedupe: false,
  decisionBucketMs: 0,
  decisionMinEdgeDeltaBps: 0,
  useRpcSim: false,
  decisionMinBase: 0.01,
};

function readJsonl(file: string) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("joiner + adapter regression fixtures", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    originalEnv.PAIRS_JSON = process.env.PAIRS_JSON;
    originalEnv.AMMS_ENABLE = process.env.AMMS_ENABLE;
    originalEnv.RAYDIUM_POOL_JSON_PATH = process.env.RAYDIUM_POOL_JSON_PATH;

    process.env.PAIRS_JSON = path.resolve(process.cwd(), "configs", "pairs.json");
    process.env.AMMS_ENABLE = "raydium";
    process.env.RAYDIUM_POOL_JSON_PATH = path.resolve(process.cwd(), "configs", "raydium.pool.json");
  });

  afterAll(() => {
    if (originalEnv.PAIRS_JSON == null) delete process.env.PAIRS_JSON; else process.env.PAIRS_JSON = originalEnv.PAIRS_JSON;
    if (originalEnv.AMMS_ENABLE == null) delete process.env.AMMS_ENABLE; else process.env.AMMS_ENABLE = originalEnv.AMMS_ENABLE;
    if (originalEnv.RAYDIUM_POOL_JSON_PATH == null) delete process.env.RAYDIUM_POOL_JSON_PATH; else process.env.RAYDIUM_POOL_JSON_PATH = originalEnv.RAYDIUM_POOL_JSON_PATH;
  });

  it("generates deterministic decisions and builds adapter instructions", async () => {
    const logs: { event: string; payload?: any }[] = [];
    const logSpy = vi.spyOn(logger, "log").mockImplementation((event, payload) => {
      logs.push({ event, payload });
    });

    const decisions: any[] = [];
    const joiner = new EdgeJoiner(
      baseParams,
      baseCfg,
      (wouldTrade, edgeBps, pnl, details) => {
        decisions.push({ wouldTrade, edgeBps, pnl, details });
      },
      undefined,
      undefined
    );

    const phoenixLines = readJsonl(path.join(FIXTURE_DIR, "phoenix-feed.jsonl"));
    for (const entry of phoenixLines) joiner.upsertPhoenix(entry);

    const ammsLines = readJsonl(path.join(FIXTURE_DIR, "amms-feed.jsonl"));
    for (const entry of ammsLines) joiner.upsertAmms(entry);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const evalCount = logs.filter((l) => l.event === "candidate_evaluated").length;
    const tradeCount = logs.filter((l) => l.event === "would_trade").length;
    const rejectCount = logs.filter((l) => l.event === "would_not_trade").length;

    expect(evalCount).toBeGreaterThanOrEqual(2);
    expect(tradeCount).toBeGreaterThan(0);
    expect(rejectCount).toBeGreaterThan(0);

    const winning = decisions.find((d) => d.wouldTrade && d.details?.path === "PHX->AMM");
    expect(winning).toBeTruthy();
    expect(winning?.details?.amm_pool_id).toBe(RAYDIUM_POOL);
    expect(Array.isArray(winning?.details?.legs)).toBe(true);

    const adapter = getAdapter("raydium");
    expect(adapter?.kind).toBe("raydium");

    if (adapter && winning?.details) {
      const ammLeg = (winning.details.legs as any[]).find((leg) => leg.kind === "amm");
      expect(ammLeg).toBeTruthy();
      const instructions = await adapter.buildSwapIxs(
        {} as any,
        "So11111111111111111111111111111111111111112",
        {
          poolId: ammLeg.poolId,
          inBase: ammLeg.sizeBase,
          direction: ammLeg.direction === "quoteToBase" ? "quoteToBase" : "baseToQuote",
          slippageBps: 50,
          baseMint: ammLeg.baseMint ?? undefined,
          quoteMint: ammLeg.quoteMint ?? undefined,
        }
      );
      expect(Array.isArray(instructions)).toBe(true);
    }

    joiner.close();
    logSpy.mockRestore();
  });
});
