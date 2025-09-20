// services/arb-mm/src/registry/poolGraph.ts
// Pool graph + route enumerator sourced from configs/pairs.json.
// Provides modular building blocks for future multi-venue path planning.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PAIRS_PATH = path.resolve(__dirname, "..", "..", "..", "configs", "pairs.json");

export type VenueConfig = {
  kind: string;
  id: string;
  poolKind?: string;
  feeBps?: number;
};

export type PairConfig = {
  symbol: string;
  baseMint: string;
  quoteMint: string;
  phoenixMarket?: string;
  venues: VenueConfig[];
};

export type PoolNode = {
  id: string;
  symbol: string;
  venue: string;
  poolId: string;
  poolKind?: string;
  role: "phoenix" | "amm";
  feeBps?: number;
};

export type RouteLeg =
  | {
      type: "phoenix";
      market: string;
      side: "buy" | "sell";
      feeBps?: number;
    }
  | {
      type: "amm";
      venue: string;
      poolId: string;
      poolKind?: string;
      side: "buy" | "sell";
      feeBps?: number;
    };

export type RouteSpec = {
  id: string;
  symbol: string;
  baseMint: string;
  quoteMint: string;
  pathKind: "PHX->AMM" | "AMM->PHX" | "AMM->AMM";
  legs: [RouteLeg, RouteLeg];
};

export type PoolGraph = {
  pairs: PairConfig[];
  nodes: PoolNode[];
};

function readJsonMaybe(filePath: string): any | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function loadPairsConfig(): PairConfig[] {
  const override = process.env.PAIRS_JSON?.trim();
  const candidatePaths = [
    override,
    DEFAULT_PAIRS_PATH,
  ].filter(Boolean) as string[];

  for (const rel of candidatePaths) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
    if (!fs.existsSync(abs)) continue;
    const data = readJsonMaybe(abs);
    const pairs = Array.isArray(data?.pairs) ? data.pairs : Array.isArray(data) ? data : undefined;
    if (Array.isArray(pairs)) {
      return pairs as PairConfig[];
    }
  }

  return [];
}

export function buildPoolGraph(pairs: PairConfig[]): PoolGraph {
  const nodes: PoolNode[] = [];

  pairs.forEach((pair, pairIdx) => {
    const venues = Array.isArray(pair.venues) ? pair.venues : [];

    // include phoenix venue derived from either venues[] or phoenixMarket fallback
    const phoenixVenues = venues.filter((v) => v.kind.toLowerCase() === "phoenix");
    if (!phoenixVenues.length && pair.phoenixMarket) {
      phoenixVenues.push({ kind: "phoenix", id: pair.phoenixMarket });
    }

    for (const v of phoenixVenues) {
      const nodeId = `${pair.symbol}|phoenix:${v.id}|${pairIdx}`;
      nodes.push({
        id: nodeId,
        symbol: pair.symbol,
        venue: v.kind.toLowerCase(),
        poolId: v.id,
        role: "phoenix",
        feeBps: v.feeBps,
      });
    }

    for (const v of venues.filter((v) => v.kind.toLowerCase() !== "phoenix")) {
      const venue = v.kind.toLowerCase();
      const nodeId = `${pair.symbol}|${venue}:${v.id}|${pairIdx}`;
      nodes.push({
        id: nodeId,
        symbol: pair.symbol,
        venue,
        poolId: v.id,
        poolKind: v.poolKind,
        role: "amm",
        feeBps: v.feeBps,
      });
    }
  });

  return { pairs, nodes };
}

export function enumerateRoutes(pairs: PairConfig[]): RouteSpec[] {
  const graph = buildPoolGraph(pairs);
  const routes: RouteSpec[] = [];
  const seen = new Set<string>();

  for (const pair of graph.pairs) {
    const venues = Array.isArray(pair.venues) ? pair.venues : [];
    const phoenixEntries = venues.filter((v) => v.kind.toLowerCase() === "phoenix");
    if (!phoenixEntries.length && pair.phoenixMarket) {
      phoenixEntries.push({ kind: "phoenix", id: pair.phoenixMarket });
    }

    const ammEntries = venues.filter((v) => v.kind.toLowerCase() !== "phoenix");

    for (const phx of phoenixEntries) {
      for (const amm of ammEntries) {
        const ammVenue = amm.kind.toLowerCase();
        const phxId = phx.id;
        const ammId = amm.id;

        const keyForward = `${pair.symbol}|phx:${phxId}->${ammVenue}:${ammId}`;
        if (!seen.has(keyForward)) {
          seen.add(keyForward);
          routes.push({
            id: keyForward,
            symbol: pair.symbol,
            baseMint: pair.baseMint,
            quoteMint: pair.quoteMint,
            pathKind: "PHX->AMM",
            legs: [
              { type: "phoenix", market: phxId, side: "sell", feeBps: phx.feeBps },
              { type: "amm", venue: ammVenue, poolId: ammId, poolKind: amm.poolKind, side: "buy", feeBps: amm.feeBps },
            ],
          });
        }

        const keyReverse = `${pair.symbol}|${ammVenue}:${ammId}->phx:${phxId}`;
        if (!seen.has(keyReverse)) {
          seen.add(keyReverse);
          routes.push({
            id: keyReverse,
            symbol: pair.symbol,
            baseMint: pair.baseMint,
            quoteMint: pair.quoteMint,
            pathKind: "AMM->PHX",
            legs: [
              { type: "amm", venue: ammVenue, poolId: ammId, poolKind: amm.poolKind, side: "sell", feeBps: amm.feeBps },
              { type: "phoenix", market: phxId, side: "buy", feeBps: phx.feeBps },
            ],
          });
        }
      }
    }

    // AMM <-> AMM combinations (ordered, skip identical pool ids)
    for (let i = 0; i < ammEntries.length; i++) {
      for (let j = 0; j < ammEntries.length; j++) {
        if (i === j) continue;
        const src = ammEntries[i];
        const dst = ammEntries[j];
        if (src.id === dst.id && src.kind === dst.kind) continue;
        const srcVenue = src.kind.toLowerCase();
        const dstVenue = dst.kind.toLowerCase();
        const key = `${pair.symbol}|${srcVenue}:${src.id}->${dstVenue}:${dst.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({
          id: key,
          symbol: pair.symbol,
          baseMint: pair.baseMint,
          quoteMint: pair.quoteMint,
          pathKind: "AMM->AMM",
          legs: [
            { type: "amm", venue: srcVenue, poolId: src.id, poolKind: src.poolKind, side: "sell", feeBps: src.feeBps },
            { type: "amm", venue: dstVenue, poolId: dst.id, poolKind: dst.poolKind, side: "buy", feeBps: dst.feeBps },
          ],
        });
      }
    }
  }

  return routes;
}
