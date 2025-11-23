import fs from "fs";
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { pathToFileURL } from "url";

let parseMarketsConfig: (raw: unknown, source?: string) => any[];

beforeAll(async () => {
  const candidates = [
    path.resolve(process.cwd(), "packages/phoenix/src/index.ts"),
    path.resolve(process.cwd(), "..", "packages/phoenix/src/index.ts"),
    path.resolve(process.cwd(), "..", "..", "packages/phoenix/src/index.ts"),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error("Unable to locate packages/phoenix/src/index.ts for staging tests");
  }
  const modulePath = pathToFileURL(resolved).href;
  const mod = await import(modulePath);
  parseMarketsConfig = mod.parseMarketsConfig;
});

describe("parseMarketsConfig", () => {
  it("requires phoenix and raydium ids for enabled markets", () => {
    const good = [
      {
        name: "SOL/USDC (Raydium CPMM)",
        symbol: "SOL/USDC",
        enabled: true,
        phoenix: { market: "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg" },
        raydium: { ammId: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" },
      },
    ];
    const parsed = parseMarketsConfig(good, "markets-good");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].symbol).toBe("SOL/USDC");
  });

  it("throws when an enabled entry is missing identifiers", () => {
    const bad = [
      {
        name: "Broken",
        symbol: "BROKEN/USDC",
        enabled: true,
        phoenix: {},
        raydium: {},
      },
    ];
    expect(() => parseMarketsConfig(bad, "markets-bad")).toThrow(/phoenix\.market/);
  });

  it("allows disabled placeholders", () => {
    const disabled = [
      {
        symbol: "BONK/USDC",
        enabled: false,
      },
    ];
    const parsed = parseMarketsConfig(disabled, "markets-disabled");
    expect(parsed).toHaveLength(1);
  });
});
