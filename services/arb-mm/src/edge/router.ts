export type Venue = "raydium" | "orca" | "meteora" | "lifinity" | "phoenix";
export type Pair = {
    symbol: string;
    baseMint: string;
    quoteMint: string;
    phoenixMarket: string;
    venues: { kind: Venue; id: string }[];
};

export type Route = {
    id: string;
    pair: Pair;
    legs: (
        | { kind: "amm"; venue: Exclude<Venue, "phoenix">; poolId: string; side: "buy" | "sell" }
        | { kind: "phoenix"; market: string; side: "buy" | "sell" }
    )[];
};

export function buildTwoLegRoutes(pairs: Pair[]): Route[] {
    const routes: Route[] = [];
    for (const pair of pairs) {
        const hasPhx = pair.venues.some(v => v.kind === "phoenix");
        if (!hasPhx) continue;
        const phx = pair.venues.find(v => v.kind === "phoenix")!;
        for (const amm of pair.venues.filter(v => v.kind !== "phoenix")) {
            // AMM -> PHX
            routes.push({
                id: `${pair.symbol}|${amm.kind}:${amm.id}|AMM->PHX`,
                pair,
                legs: [
                    { kind: "amm", venue: amm.kind as any, poolId: amm.id, side: "sell" }, // sell BASE on AMM → QUOTE
                    { kind: "phoenix", market: phx.id, side: "buy" },                      // buy BASE on PHX with QUOTE
                ],
            });
            // PHX -> AMM
            routes.push({
                id: `${pair.symbol}|${amm.kind}:${amm.id}|PHX->AMM`,
                pair,
                legs: [
                    { kind: "phoenix", market: phx.id, side: "sell" },                     // sell BASE on PHX → QUOTE
                    { kind: "amm", venue: amm.kind as any, poolId: amm.id, side: "buy" },  // buy BASE on AMM with QUOTE
                ],
            });
        }
    }
    return routes;
}
