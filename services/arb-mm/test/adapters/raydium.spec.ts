import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/executor/buildRaydiumCpmmIx.js", () => ({
  buildRaydiumCpmmSwapIx: vi.fn(),
}));

const { RaydiumAdapter } = await import("../../src/adapters/raydium.js");
const { buildRaydiumCpmmSwapIx } = await import("../../src/executor/buildRaydiumCpmmIx.js");

describe("RaydiumAdapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns router sentinel when quoting", async () => {
    const resp = await RaydiumAdapter.quote({} as any, {
      poolId: "ray_pool",
      inBase: 0.1,
      direction: "baseToQuote",
      slippageBps: 25,
    });
    expect(resp).toEqual({ ok: false, err: "use_router_cpmm_math" });
  });

  it("builds swap instructions using the cpmm ix helper", async () => {
    const fakeIx = { programId: "ray" } as any;
    (buildRaydiumCpmmSwapIx as any).mockResolvedValue([fakeIx]);

    const ixs = await RaydiumAdapter.buildSwapIxs({} as any, "So11111111111111111111111111111111111111112", {
      poolId: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      inBase: 0.25,
      direction: "baseToQuote",
      slippageBps: 25,
    });

    expect(ixs).toEqual([fakeIx]);
    expect(buildRaydiumCpmmSwapIx).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: expect.anything(),
        poolId: expect.anything(),
      })
    );
  });
});
