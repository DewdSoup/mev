// services/arb-mm/src/routing/graph.ts
// Route graph helpers for multi-leg arbitrage paths.

import type { PairSpec, PairAmmVenue } from "../registry/pairs.js";

export type PhoenixIntent = "buy" | "sell";

export type RouteNodeRef =
  | { kind: "phx"; market: string; intent?: PhoenixIntent }
  | { kind: "amm"; venue: string; poolId: string };

export type TwoLegRoute = {
  path: "PHX->AMM" | "AMM->PHX" | "AMM->AMM";
  src: RouteNodeRef;
  dst: RouteNodeRef;
};

export function makeRouteKey(route: TwoLegRoute): string {
  return makeRouteKeyFromParts(route.path, route.src, route.dst);
}

export type RouteSignature = {
  path: string;
  nodes: RouteNodeRef[];
};

export function makeRouteKeyFromNodes(
  path: string,
  nodes: RouteNodeRef[]
): string {
  const nodeParts = nodes.map((node) =>
    node.kind === "phx"
      ? `phx:${node.market}${node.intent ? `:${node.intent}` : ""}`
      : `amm:${node.venue}:${node.poolId}`
  );
  return `${path}|${nodeParts.join("|")}`;
}

export function makeRouteKeyFromParts(
  path: TwoLegRoute["path"],
  src: RouteNodeRef,
  dst: RouteNodeRef
): string {
  const srcKey = src.kind === "phx"
    ? `phx:${src.market}`
    : `amm:${src.venue}:${src.poolId}`;
  const dstKey = dst.kind === "phx"
    ? `phx:${dst.market}`
    : `amm:${dst.venue}:${dst.poolId}`;
  return `${path}|${srcKey}|${dstKey}`;
}

function normalizeMaxLegs(raw?: number): number {
  if (!Number.isFinite(raw as number)) return 2;
  const n = Math.floor(Number(raw));
  // Hard guard at 8 legs to keep combinatorics bounded; can be raised if needed.
  return Math.max(2, Math.min(n, 8));
}

function nodeKeyFromRef(node: RouteNodeRef): string {
  if (node.kind === "phx") {
    const suffix = node.intent ? `:${node.intent}` : "";
    return `phx:${node.market}${suffix}`;
  }
  return `amm:${node.venue}:${node.poolId}`;
}

function nodeKeyFromDyn<AmmSnap extends { venue: string; ammId: string }>(node: DynamicRouteNode<AmmSnap>): string {
  if (node.kind === "phx") {
    const suffix = node.intent ? `:${node.intent}` : "";
    return `phx:${node.market}${suffix}`;
  }
  return `amm:${node.amm.venue}:${node.amm.ammId}`;
}

function assignPhoenixIntent<T extends { kind: "phx" | "amm"; intent?: PhoenixIntent }>(chain: T[]): T[] {
  if (chain.length === 0) return chain.slice();
  let action: PhoenixIntent = chain.length % 2 === 0 ? "buy" : "sell";
  return chain.map((node) => {
    const currentAction = action;
    action = action === "buy" ? "sell" : "buy";
    if (node.kind !== "phx") return node;
    if (node.intent === currentAction) return node;
    return { ...node, intent: currentAction };
  });
}

function isSameAmmRef(a: RouteNodeRef, b: RouteNodeRef): boolean {
  return a.kind === "amm" &&
    b.kind === "amm" &&
    a.venue === b.venue &&
    a.poolId === b.poolId;
}

function isSameAmmDyn<AmmSnap extends { venue: string; ammId: string }>(a: DynamicRouteNode<AmmSnap>, b: DynamicRouteNode<AmmSnap>): boolean {
  return a.kind === "amm" &&
    b.kind === "amm" &&
    a.amm.venue === b.amm.venue &&
    a.amm.ammId === b.amm.ammId;
}

function venueEnabled(venue: PairAmmVenue): boolean {
  return venue.enabled !== false;
}

export function buildTwoLegRoutes(pairs: PairSpec[]): TwoLegRoute[] {
  const routes: TwoLegRoute[] = [];
  const dedupe = new Set<string>();

  for (const pair of pairs) {
    const market = pair.phoenixMarket?.trim();
    if (!market) continue;

    const phxRef: RouteNodeRef = { kind: "phx", market };
    const venues = (pair.ammVenues ?? []).filter(venueEnabled);

    for (const venue of venues) {
      const ammRef: RouteNodeRef = {
        kind: "amm",
        venue: venue.venue,
        poolId: venue.poolId,
      };

      const routeForward: TwoLegRoute = { path: "PHX->AMM", src: phxRef, dst: ammRef };
      const routeReverse: TwoLegRoute = { path: "AMM->PHX", src: ammRef, dst: phxRef };

      for (const route of [routeForward, routeReverse]) {
        const key = makeRouteKey(route);
        if (!dedupe.has(key)) {
          dedupe.add(key);
          routes.push(route);
        }
      }
    }

    // AMM->AMM permutations (excluding self)
    for (let i = 0; i < venues.length; i++) {
      for (let j = 0; j < venues.length; j++) {
        if (i === j) continue;
        const src = venues[i];
        const dst = venues[j];
        const srcRef: RouteNodeRef = { kind: "amm", venue: src.venue, poolId: src.poolId };
        const dstRef: RouteNodeRef = { kind: "amm", venue: dst.venue, poolId: dst.poolId };
        const route: TwoLegRoute = { path: "AMM->AMM", src: srcRef, dst: dstRef };
        const key = makeRouteKey(route);
        if (!dedupe.has(key)) {
          dedupe.add(key);
          routes.push(route);
        }
      }
    }
  }

  return routes;
}

function describePathFromNodes(nodes: RouteNodeRef[]): string {
  return nodes
    .map((node) => (node.kind === "phx" ? "PHX" : "AMM"))
    .join("->");
}

export function buildRouteSignatures(
  pairs: PairSpec[],
  options: { maxLegs?: number; maxPhoenix?: number } = {}
): RouteSignature[] {
  const maxLegs = normalizeMaxLegs(options.maxLegs);
  const maxPhoenix = Math.max(0, Math.floor(options.maxPhoenix ?? 1));
  const signatures: RouteSignature[] = [];
  const dedupe = new Set<string>();

  for (const pair of pairs) {
    const market = pair.phoenixMarket?.trim();
    if (!market) continue;

    const phoenixNode: RouteNodeRef = { kind: "phx", market };
    const venues = (pair.ammVenues ?? []).filter(venueEnabled);
    const ammRefs = venues.map((venue) => ({
      kind: "amm" as const,
      venue: venue.venue,
      poolId: venue.poolId,
    }));

    const nodes: RouteNodeRef[] = [phoenixNode, ...ammRefs];

    const backtrack = (
      chain: RouteNodeRef[],
      usedAmms: Set<string>,
      phoenixCount: number
    ) => {
      if (chain.length >= 2) {
        const decorated = assignPhoenixIntent(chain);
        const path = describePathFromNodes(decorated);
        const key = makeRouteKeyFromNodes(path, decorated);
        if (!dedupe.has(key)) {
          const first = decorated[0];
          const last = decorated[decorated.length - 1];
          if (!(first.kind === "amm" && last.kind === "amm" && isSameAmmRef(first, last))) {
            dedupe.add(key);
            signatures.push({ path, nodes: decorated });
          }
        }
      }

      if (chain.length >= maxLegs) return;

      for (const node of nodes) {
        const last = chain[chain.length - 1];
        if (last && node.kind === last.kind && nodeKeyFromRef(node) === nodeKeyFromRef(last)) continue;

        if (node.kind === "phx" && phoenixCount >= maxPhoenix) continue;

        if (node.kind === "amm") {
          const key = nodeKeyFromRef(node);
          if (usedAmms.has(key)) continue;
          usedAmms.add(key);
          chain.push(node);
          backtrack(chain, usedAmms, phoenixCount);
          chain.pop();
          usedAmms.delete(key);
        } else {
          chain.push(node);
          backtrack(chain, usedAmms, phoenixCount + 1);
          chain.pop();
        }
      }
    };

    for (const start of nodes) {
      const usedAmms = new Set<string>();
      const startIsAmm = start.kind === "amm";
      if (startIsAmm) usedAmms.add(nodeKeyFromRef(start));
      const initialPhoenix = start.kind === "phx" ? 1 : 0;
      if (initialPhoenix > maxPhoenix) continue;
      backtrack([start], usedAmms, initialPhoenix);
    }
  }

  return signatures;
}

export type DynamicRouteNode<AmmSnap> =
  | { kind: "phx"; id: string; feeBps: number; market: string; intent?: PhoenixIntent }
  | { kind: "amm"; id: string; feeBps: number; amm: AmmSnap };

export type RoutePlan<AmmSnap> = {
  path: string;
  nodes: DynamicRouteNode<AmmSnap>[];
};

export function enumerateRoutes<AmmSnap extends { venue: string; ammId: string }>(
  nodes: DynamicRouteNode<AmmSnap>[],
  options: { includeAmmAmm: boolean }
): RoutePlan<AmmSnap>[] {
  return enumerateRoutePlans(nodes, {
    includeAmmAmm: options.includeAmmAmm,
    maxLegs: 2,
  });
}

export function enumerateRoutePlans<AmmSnap extends { venue: string; ammId: string }>(
  nodes: DynamicRouteNode<AmmSnap>[],
  options: { includeAmmAmm: boolean; maxLegs?: number; maxRoutes?: number; maxPhoenix?: number }
): RoutePlan<AmmSnap>[] {
  const includeAmmAmm = options.includeAmmAmm;
  const maxLegs = normalizeMaxLegs(options.maxLegs);
  const maxPhoenix = Math.max(0, Math.floor(options.maxPhoenix ?? 1));
  const out: RoutePlan<AmmSnap>[] = [];
  const dedupe = new Set<string>();
  const maxRoutesOpt = options.maxRoutes;
  const maxRoutes = Number.isFinite(maxRoutesOpt as number)
    ? Math.max(1, Math.min(20000, Math.floor(Number(maxRoutesOpt))))
    : undefined;
  let routeBudget = maxRoutes ?? Number.POSITIVE_INFINITY;
  let exhausted = false;

  const hasAmmAmmEdge = (chain: DynamicRouteNode<AmmSnap>[]): boolean => {
    for (let idx = 0; idx < chain.length - 1; idx++) {
      if (chain[idx].kind === "amm" && chain[idx + 1].kind === "amm") {
        return true;
      }
    }
    return false;
  };

  const tryRecordRoute = (chain: DynamicRouteNode<AmmSnap>[]): boolean => {
    if (routeBudget <= 0) {
      exhausted = true;
      return true;
    }
    const decorated = assignPhoenixIntent(chain);
    const path = describePathFromNodes(decorated.map((node) =>
      node.kind === "phx"
        ? { kind: "phx", market: node.market } as RouteNodeRef
        : { kind: "amm", venue: node.amm.venue, poolId: node.amm.ammId } as RouteNodeRef
    ));
    const key = decorated
      .map((node) => nodeKeyFromDyn(node))
      .join("|");
    if (dedupe.has(`${path}|${key}`)) return false;
    const first = decorated[0];
    const last = decorated[decorated.length - 1];
    if (first.kind === "amm" && last.kind === "amm" && isSameAmmDyn(first, last)) {
      return false;
    }
    dedupe.add(`${path}|${key}`);
    out.push({ path, nodes: decorated });
    routeBudget -= 1;
    if (routeBudget <= 0) {
      exhausted = true;
    }
    return routeBudget <= 0;
  };

  const backtrack = (
    chain: DynamicRouteNode<AmmSnap>[],
    usedAmms: Set<string>,
    phoenixCount: number
  ) => {
    if (routeBudget <= 0) {
      exhausted = true;
      return;
    }

    if (chain.length >= 2) {
      if (!includeAmmAmm && hasAmmAmmEdge(chain)) {
        const includesPhoenix = chain.some((node) => node.kind === "phx");
        if (includesPhoenix) {
          if (tryRecordRoute(chain)) return;
        }
      } else {
        if (tryRecordRoute(chain)) return;
      }
    }

    if (chain.length >= maxLegs) return;
    if (routeBudget <= 0) {
      exhausted = true;
      return;
    }

    for (const node of nodes) {
      if (routeBudget <= 0) {
        exhausted = true;
        return;
      }
      const last = chain[chain.length - 1];
      if (last && node.kind === last.kind && nodeKeyFromDyn(node) === nodeKeyFromDyn(last)) continue;

      if (node.kind === "phx" && phoenixCount >= maxPhoenix) continue;

      if (node.kind === "amm") {
        const key = nodeKeyFromDyn(node);
        if (usedAmms.has(key)) continue;
        usedAmms.add(key);
        chain.push(node);
        backtrack(chain, usedAmms, phoenixCount);
        chain.pop();
        usedAmms.delete(key);
      } else {
        chain.push(node);
        backtrack(chain, usedAmms, phoenixCount + 1);
        chain.pop();
      }
    }
  };

  const cloneNode = (node: DynamicRouteNode<AmmSnap>): DynamicRouteNode<AmmSnap> => {
    return node.kind === "phx"
      ? { kind: "phx", id: node.id, feeBps: node.feeBps, market: node.market }
      : { kind: "amm", id: node.id, feeBps: node.feeBps, amm: node.amm };
  };

  const ensureUniqueAmms = (chain: DynamicRouteNode<AmmSnap>[]): boolean => {
    const seen = new Set<string>();
    for (const node of chain) {
      if (node.kind !== "amm") continue;
      const key = nodeKeyFromDyn(node);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  };

  const maybeRecordChain = (chain: DynamicRouteNode<AmmSnap>[]) => {
    if (routeBudget <= 0) {
      exhausted = true;
      return;
    }
    if (chain.length < 2 || chain.length > maxLegs) return;
    const phoenixInChain = chain.reduce(
      (count, node) => count + (node.kind === "phx" ? 1 : 0),
      0
    );
    if (phoenixInChain > maxPhoenix) return;
    if (!ensureUniqueAmms(chain)) return;
    if (!includeAmmAmm && hasAmmAmmEdge(chain)) {
      const includesPhoenix = chain.some((node) => node.kind === "phx");
      if (!includesPhoenix) return;
      if (tryRecordRoute(chain)) return;
      return;
    }
    tryRecordRoute(chain);
  };

  const phoenixNode = nodes.find((node) => node.kind === "phx");
  if (phoenixNode) {
    const ammNodes = nodes.filter((node): node is Extract<DynamicRouteNode<AmmSnap>, { kind: "amm" }> => node.kind === "amm");
    for (const src of ammNodes) {
      maybeRecordChain([cloneNode(phoenixNode), cloneNode(src)]);
      maybeRecordChain([cloneNode(src), cloneNode(phoenixNode)]);

      if (maxLegs >= 3) {
        for (const dst of ammNodes) {
          if (dst === src) continue;
          maybeRecordChain([cloneNode(phoenixNode), cloneNode(src), cloneNode(dst)]);
          maybeRecordChain([cloneNode(src), cloneNode(phoenixNode), cloneNode(dst)]);
          maybeRecordChain([cloneNode(src), cloneNode(dst), cloneNode(phoenixNode)]);
        }
      }
    }
  }

  for (const start of nodes) {
    if (routeBudget <= 0) {
      exhausted = true;
      break;
    }
    const usedAmms = new Set<string>();
    if (start.kind === "amm") usedAmms.add(nodeKeyFromDyn(start));
    const initialPhoenix = start.kind === "phx" ? 1 : 0;
    if (initialPhoenix > maxPhoenix) continue;
    backtrack([start], usedAmms, initialPhoenix);
  }

  const result = out as RoutePlan<AmmSnap>[] & { __budgetExhausted?: boolean };
  result.__budgetExhausted = Boolean(maxRoutes) && exhausted;
  return result;
}
