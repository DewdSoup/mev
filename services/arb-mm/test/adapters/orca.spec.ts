import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/executor/orca_quoter.js", () => ({
  orcaAvgSellQuotePerBase: vi.fn(),
  orcaAvgBuyQuotePerBase: vi.fn(),
}));

vi.mock("../../src/executor/buildOrcaWhirlpoolIx.js", () => ({
  buildOrcaWhirlpoolSwapIx: vi.fn(),
}));

const { OrcaAdapter } = await import("../../src/adapters/orca.js");
const { orcaAvgSellQuotePerBase, orcaAvgBuyQuotePerBase } = await import("../../src/executor/orca_quoter.js");
const { buildOrcaWhirlpoolSwapIx } = await import("../../src/executor/buildOrcaWhirlpoolIx.js");

describe("OrcaAdapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns quoted price for baseToQuote requests", async () => {
    (orcaAvgSellQuotePerBase as any).mockResolvedValue({ ok: true, price: 187.12 });

    const resp = await OrcaAdapter.quote({} as any, {
      poolId: "orca_pool",
      inBase: 0.5,
      direction: "baseToQuote",
      slippageBps: 25,
    });

    expect(resp).toEqual(
      expect.objectContaining({
        ok: true,
        price: 187.12,
      })
    );
    expect(orcaAvgSellQuotePerBase).toHaveBeenCalledWith("orca_pool", expect.any(Number), expect.any(Number));
  });

  it("propagates quoter failure messages", async () => {
    (orcaAvgBuyQuotePerBase as any).mockResolvedValue({ ok: false, reason: "no-liquidity" });

    const resp = await OrcaAdapter.quote({} as any, {
      poolId: "orca_pool",
      inBase: 0.25,
      direction: "quoteToBase",
      slippageBps: 30,
    });

    expect(resp).toEqual({ ok: false, err: "no-liquidity" });
    expect(orcaAvgBuyQuotePerBase).toHaveBeenCalled();
  });

  it("builds swap instructions via the ix helper", async () => {
    const fakeIx = { programId: "orca" } as any;
    (buildOrcaWhirlpoolSwapIx as any).mockResolvedValue({ ok: true, ixs: [fakeIx] });

    const ixs = await OrcaAdapter.buildSwapIxs({} as any, "So11111111111111111111111111111111111111112", {
      poolId: "orca_pool",
      inBase: 0.1,
      direction: "baseToQuote",
      slippageBps: 25,
    });

    expect(Array.isArray(ixs)).toBe(true);
    expect(ixs).toHaveLength(1);
    expect(buildOrcaWhirlpoolSwapIx).toHaveBeenCalledWith(
      expect.objectContaining({
        poolId: "orca_pool",
        baseIn: true,
      })
    );
  });
});
