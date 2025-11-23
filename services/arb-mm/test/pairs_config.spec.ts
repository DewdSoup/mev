import { describe, it, expect } from "vitest";

import { parsePairsConfig } from "../src/registry/pairs.js";

const baseValidConfig = {
  pairs: [
    {
      id: "SOL/USDC",
      symbol: "SOL/USDC",
      baseMint: "So11111111111111111111111111111111111111112",
      quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      phoenixMarket: "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg",
      venues: [
        { kind: "phoenix", id: "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg" },
        {
          kind: "raydium",
          id: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
          feeBps: 25,
          poolKind: "cpmm",
          freshness: { slotLagSlots: 10 },
        },
        {
          kind: "orca",
          id: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ",
          enabled: false,
        },
      ],
      fees: { phoenixTakerBps: 2, ammTakerBps: 25 },
      sizing: { decisionMinBase: 0.01 },
    },
  ],
};

describe("parsePairsConfig", () => {
  it("normalises a valid configuration", () => {
    const parsed = parsePairsConfig(baseValidConfig, "test");
    expect(parsed).toHaveLength(1);
    const pair = parsed[0];
    expect(pair.symbol).toBe("SOL/USDC");
    expect(pair.ammVenues).toHaveLength(1);
    expect(pair.ammVenues[0].venue).toBe("raydium");
    expect(pair.ammVenues[0].feeBps).toBe(25);
    expect(pair.ammVenues[0].freshness?.slotLagSlots).toBe(10);
    expect(pair.adapters?.amm).toBe("raydium");
  });

  it("throws when required top-level fields are missing", () => {
    const bad = {
      pairs: [
        {
          quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          phoenix: { market: "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg" },
          venues: [{ kind: "raydium", id: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" }],
        },
      ],
    };
    expect(() => parsePairsConfig(bad, "bad-config")).toThrow(/bad-config\[0\]\.baseMint/);
  });

  it("throws when no enabled non-phoenix venues are present", () => {
    const badVenues = {
      pairs: [
        {
          baseMint: "So11111111111111111111111111111111111111112",
          quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          phoenixMarket: "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg",
          venues: [{ kind: "phoenix", id: "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg" }],
        },
      ],
    };
    expect(() => parsePairsConfig(badVenues, "no-amm")).toThrow(/no-amm\[0\]\.venues/);
  });
});
