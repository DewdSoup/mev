import { describe, it, expect } from "vitest";

import {
  enumerateRoutes,
  enumerateRoutePlans,
  buildTwoLegRoutes,
  buildRouteSignatures,
  makeRouteKeyFromParts,
  makeRouteKeyFromNodes,
  type DynamicRouteNode,
} from "../src/routing/graph.js";
import type { PairSpec } from "../src/registry/pairs.js";

type DummyAmm = { venue: string; ammId: string };

const PHX_MARKET = "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg";

const phoenixNode: DynamicRouteNode<DummyAmm> = {
  kind: "phx",
  id: "phoenix",
  feeBps: 2,
  market: PHX_MARKET,
};
const ammNode = (venue: string, id: string): DynamicRouteNode<DummyAmm> => ({
  kind: "amm",
  id: `${venue}:${id}`,
  feeBps: 25,
  amm: { venue, ammId: id },
});

describe("enumerateRoutes", () => {
  it("emits PHX<->AMM permutations and skips AMM->AMM when disabled", () => {
    const nodes = [phoenixNode, ammNode("raydium", "ray"), ammNode("orca", "orc")];
    const routes = enumerateRoutes(nodes, { includeAmmAmm: false });
    const labels = routes.map((r) => `${r.nodes[0].kind}->${r.nodes[1].kind}:${r.path}`);

    expect(labels).toContain("phx->amm:PHX->AMM");
    expect(labels).toContain("amm->phx:AMM->PHX");
    expect(labels.some((label) => label.includes("AMM->AMM"))).toBe(false);
  });

  it("includes AMM->AMM routes when enabled", () => {
    const nodes = [phoenixNode, ammNode("raydium", "ray"), ammNode("orca", "orc")];
    const routes = enumerateRoutes(nodes, { includeAmmAmm: true });
    const ammToAmm = routes.filter((r) => r.path === "AMM->AMM");
    expect(ammToAmm).toHaveLength(2); // ray->orca and orca->ray
  });
});

describe("buildTwoLegRoutes", () => {
  const pair: PairSpec = {
    id: "SOL/USDC",
    symbol: "SOL/USDC",
    baseMint: "So11111111111111111111111111111111111111112",
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    phoenixMarket: PHX_MARKET,
    ammPool: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
    ammVenues: [
      { venue: "raydium", poolId: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" },
      { venue: "orca", poolId: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ" },
    ],
    adapters: { amm: "raydium", phoenix: "phoenix" },
  };

  it("produces forward and reverse PHX routes per pool", () => {
    const routes = buildTwoLegRoutes([pair]);
    const keys = new Set(routes.map((r) => makeRouteKeyFromParts(r.path, r.src, r.dst)));
    expect(keys.has("PHX->AMM|phx:4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg|amm:raydium:58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2")).toBe(true);
    expect(keys.has("AMM->PHX|amm:orca:HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ|phx:4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg")).toBe(true);
  });

  it("includes ordered AMM->AMM permutations", () => {
    const routes = buildTwoLegRoutes([pair]);
    const ammRoutes = routes.filter((r) => r.path === "AMM->AMM");
    const labels = ammRoutes.map((r) => makeRouteKeyFromParts(r.path, r.src, r.dst));
    expect(labels).toContain("AMM->AMM|amm:raydium:58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2|amm:orca:HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ");
    expect(labels).toContain("AMM->AMM|amm:orca:HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ|amm:raydium:58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
  });
});

describe("multi-hop routes", () => {
  const pair: PairSpec = {
    id: "SOL/USDC",
    symbol: "SOL/USDC",
    baseMint: "So11111111111111111111111111111111111111112",
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    phoenixMarket: PHX_MARKET,
    ammPool: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
    ammVenues: [
      { venue: "raydium", poolId: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" },
      { venue: "orca", poolId: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ" },
    ],
    adapters: { amm: "raydium", phoenix: "phoenix" },
  };

  it("emits three-leg signatures when requested", () => {
    const signatures = buildRouteSignatures([pair], { maxLegs: 3 });
    const keys = new Set(
      signatures
        .filter((sig) => sig.nodes.length === 3)
        .map((sig) => makeRouteKeyFromNodes(sig.path, sig.nodes))
    );
    expect(keys.has("PHX->AMM->AMM|phx:4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg:sell|amm:raydium:58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2|amm:orca:HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ")).toBe(true);
    expect(keys.has("AMM->AMM->PHX|amm:raydium:58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2|amm:orca:HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ|phx:4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg:sell")).toBe(true);
    expect(keys.has("AMM->PHX->AMM|amm:raydium:58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2|phx:4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg:buy|amm:orca:HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ")).toBe(true);
  });

  it("enumerates three-leg plans when enabled", () => {
    const nodes = [phoenixNode, ammNode("raydium", "ray"), ammNode("orca", "orc")];
    const plans = enumerateRoutePlans(nodes, { includeAmmAmm: true, maxLegs: 3 });
    const chains = plans
      .filter((plan) => plan.nodes.length === 3)
      .map((plan) => plan.path);
    expect(chains).toContain("PHX->AMM->AMM");
    expect(chains).toContain("AMM->AMM->PHX");
    expect(chains).toContain("AMM->PHX->AMM");

    const phxAnchor = plans.find((plan) => plan.path === "PHX->AMM->AMM");
    expect(phxAnchor?.nodes[0]?.kind).toBe("phx");
    expect(phxAnchor?.nodes[0]?.intent).toBe("sell");

    const phxTail = plans.find((plan) => plan.path === "AMM->AMM->PHX");
    expect(phxTail?.nodes[2]?.kind).toBe("phx");
    expect(phxTail?.nodes[2]?.intent).toBe("sell");

    const phxMiddle = plans.find((plan) => plan.path === "AMM->PHX->AMM");
    expect(phxMiddle?.nodes[1]?.kind).toBe("phx");
    expect(phxMiddle?.nodes[1]?.intent).toBe("buy");
  });
});
