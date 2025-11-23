import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";

import { EdgeJoiner } from "../src/edge/joiner.js";
import type { SlipMode } from "../src/config.js";

const RAYDIUM_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const PHOENIX_MARKET = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

const originalPairsJson = process.env.PAIRS_JSON;
const originalAmmsEnable = process.env.AMMS_ENABLE;

beforeEach(() => {
  process.env.PAIRS_JSON = path.resolve(process.cwd(), "configs", "pairs.json");
  process.env.AMMS_ENABLE = "raydium";
});

afterEach(() => {
  if (originalPairsJson == null) delete process.env.PAIRS_JSON;
  else process.env.PAIRS_JSON = originalPairsJson;

  if (originalAmmsEnable == null) delete process.env.AMMS_ENABLE;
  else process.env.AMMS_ENABLE = originalAmmsEnable;
});

function pushSnapshots(joiner: EdgeJoiner, phoenix: { bid: number; ask: number }, ammPrice: number) {
  const now = Date.now();
  joiner.upsertPhoenix({
    event: "phoenix_l2",
    ts: now,
    market: PHOENIX_MARKET,
    symbol: "SOL/USDC",
    best_bid: phoenix.bid,
    best_ask: phoenix.ask,
    phoenix_mid: (phoenix.bid + phoenix.ask) / 2,
    levels_bids: [{ px: phoenix.bid, qty: 50 }],
    levels_asks: [{ px: phoenix.ask, qty: 50 }],
    slot: 100,
  });

  const baseReserve = 5_000;
  const quoteReserve = ammPrice * baseReserve;
  const baseAtoms = BigInt(Math.round(baseReserve * 1e9));
  const quoteAtoms = BigInt(Math.round(quoteReserve * 1e6));

  joiner.upsertAmms({
    event: "amms_price",
    ts: now,
    venue: "raydium",
    ammId: RAYDIUM_POOL,
    poolKind: "cpmm",
    px: ammPrice,
    baseDecimals: 9,
    quoteDecimals: 6,
    base_int: baseAtoms.toString(),
    quote_int: quoteAtoms.toString(),
    feeBps: 25,
    symbol: "SOL/USDC",
    slot: 100,
  });
}

describe("joiner/executor deterministic flow", () => {
  it("produces an executable payload when Phoenix->AMM spread is positive", async () => {
    const decisions: any[] = [];
    const executions: any[] = [];

    const joiner = new EdgeJoiner(
      baseParams,
      baseCfg,
      (wouldTrade, edgeBps, pnl, details) => {
        decisions.push({ wouldTrade, edgeBps, pnl, details });
        if (wouldTrade && details && pnl > 0) {
          executions.push({ edgeBps, pnl, details });
        }
      },
      undefined,
      undefined
    );

    pushSnapshots(joiner, { bid: 187.2, ask: 187.25 }, 188.0);
    await tick();

    expect(decisions.length).toBeGreaterThan(0);
    const exec = executions.find((e) => e.details?.amm_pool_id === RAYDIUM_POOL);
    expect(exec).toBeTruthy();
    expect(exec?.edgeBps).toBeGreaterThan(0);
    expect(exec?.pnl).toBeGreaterThan(0);
    expect(exec?.details?.path).toBe("PHX->AMM");
    expect(Array.isArray(exec?.details?.legs)).toBe(true);
    const legs = exec?.details?.legs ?? [];
    expect(legs[0]).toMatchObject({ kind: "phoenix", side: "buy" });
    expect(legs[1]).toMatchObject({ kind: "amm", venue: "raydium", direction: "baseToQuote" });

    joiner.close();
  });

  it("skips execution when expected pnl is negative", async () => {
    const executions: any[] = [];

    const joiner = new EdgeJoiner(
      baseParams,
      baseCfg,
      (wouldTrade, _edgeBps, pnl, details) => {
        if (wouldTrade && details && pnl > 0) {
          executions.push(details);
        }
      },
      undefined,
      undefined
    );

    pushSnapshots(joiner, { bid: 188.5, ask: 188.6 }, 188.0);
    await tick();

    expect(executions).toHaveLength(0);
    joiner.close();
  });
});
