0) What you have now (why it’s a good base)

Single‑pair, two‑venue route: Raydium CPMM ↔ Phoenix per pair (SOL/USDC in your env).

Depth‑aware EV: CPMM impact on the AMM leg, optional Phoenix L2 depth on the CLOB leg, and EV measured over a size grid; the joiner chooses the best size
𝑠
\*
s
\*
 for the current path.

Clean gating: Only trade when EV(s^*) ≥ threshold (plus safety) and expected PnL > 0.

Live, indefinite: Runs until you Ctrl‑C; .env.live is the only env it loads; live mode is enforced.

Instrumentation: JSONL events + concise “would_trade / would_not_trade” reasoning.

These are the exact properties you need to scale to many pairs/venues without rewriting core logic.

Evidence (from your last recorded run): the session summary shows 276 decisions, 0 trades, with best edge = ‑22 bps, worst = ‑30.8 bps, which is the gating doing its job when the venue spread isn’t favorable net of fees/slippage.

2025-09-09T073457780Z.summary


The dev logs also confirm the single SOL/USDC path and the decision config that was active in that session.

2025-09-09T054524Z.runtime

1) Goal (the next stage)

Make the baseline additive and scalable:

Pairs: Track N base/quote markets in parallel (e.g., SOL/USDC, SOL/USDT, ETH/USDC…).

AMMs: Plug more AMMs (Orca, Lifinity, Meteora, GooseFX…), side‑by‑side with Raydium.

Routes: Keep the two‑leg routes you have (AMM→PHX and PHX→AMM) and introduce multi‑hop/complex routes as optional modules (triangular, cross‑AMM, etc.).

Single command: pnpm live reads .env.live and a pairs.json, spins everything, and runs until stopped.

No regressions: If PAIRS_FILE is missing, the service behaves exactly as today (single pair).

2) Current repo layout (high‑level map)
repo/
├─ packages/
│  ├─ amms/           # price/reserves publishers for AMMs; adapter registry
│  ├─ phoenix/        # Phoenix book/mid publisher
│  ├─ core/ risk/ storage/ solana/   # shared libs
│
└─ services/
   └─ arb-mm/
      ├─ src/
      │  ├─ main.ts                    # runner (live, indefinite)
      │  ├─ config.ts                  # env+defaults; unified params
      │  ├─ edge/joiner.ts             # EV + size optimizer + decisions
      │  ├─ executor/live.ts           # submission (atomic two-leg)
      │  ├─ util/phoenix.ts            # Phoenix taker swap ix builder
      │  ├─ util/raydium.ts            # Raydium swap ix builder (+fee assert)
      │  ├─ tx/submit.ts               # CU/tips + signer guard + submit
      │  ├─ publishers/supervisor.ts   # starts AMM/Phoenix publishers (embedded)
      │  ├─ ... (risk, logging, feature sink)
      │
      ├─ data/ (reports, logs, live)
      └─ configs/ (recommended place for pairs.json)

3) How to run (multi‑pair by default, single‑pair if unset)

Put this in .env.live (you said you added it—great):

# Turn on multi-pair mode by pointing to your config file (path example)
PAIRS_FILE=/home/dudesoup/code/mev/services/arb-mm/configs/pairs.json
# Keep embedded publishers on
ENABLE_EMBEDDED_PUBLISHERS=1
# STILL indefinite (no run-for-minutes logic)
RUN_FOR_MINUTES=


pnpm live (root of repo).

If PAIRS_FILE is defined → multi‑pair mode.

If PAIRS_FILE is not defined → single‑pair mode (current behavior).

If your last sessions looked “not very dynamic,” it’s likely because the one pair you watched simply didn’t offer positive EV under fees. Multi‑pair + more AMMs increases surface area for edges without compromising safety. The zero‑trades day is a healthy outcome for a guarded baseline.

2025-09-09T073457780Z.summary

4) The pairs.json schema (drop‑in)

Create services/arb-mm/configs/pairs.json:

{
  "$schema": "https://example.local/arb-mm/pairs.schema.json",
  "pairs": [
    {
      "symbol": "SOL/USDC",
      "baseMint": "So11111111111111111111111111111111111111112",
      "quoteMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "phoenix": {
        "market": "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg"
      },
      "amms": [
        { "venue": "raydium", "poolId": "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" }
        // you can add: { "venue": "orca", "poolId": "..." }, ...
      ],
      "params": {
        "decisionMinBase": 0.03,
        "maxPoolTradeFrac": 0.02,
        "tradeThresholdBps": 0.3,
        "phoenixFeeBps": 2,
        "ammFeeBps": 25
      }
    }

    // Add more pairs: SOL/USDT, ETH/USDC, BONK/USDC, ...
  ]
}


Why here?

One file drives the publishers (what to subscribe to) and the router (what routes to consider).

You can override per‑pair knobs safely (min size, threshold, fees), without touching code.

5) How multi‑pair works (dataflow you can explain)

Publishers (embedded by PublisherSupervisor) read pairs.json, subscribe once per Phoenix market and once per AMM pool.

They emit JSONL: phoenix_l2/mid, amms_price/reserves.

Router builds route candidates per pair:

Two‑leg: AMM → PHX, PHX → AMM (what you have now).

(Optional) Multi‑hop: adds edges and considers 3+ legs.

Joiner runs per route with the pair’s parameters:

Optimizes size (grid + optional maxima seeds).

Applies depth/impact + fees + slippage + fixed cost.

Calls LiveExecutor only if EV(s^*) passes threshold+safety.

Executor builds atomic ixs for the chosen legs and submits.

6) Adding a new pair (checklist)

Append to pairs.json with:

symbol, baseMint, quoteMint

phoenix.market

amms array with { venue, poolId } per AMM you have support for

Optional per‑pair overrides in params (e.g., higher decisionMinBase for illiquid pairs)

Update fees only if needed in .env.live or pairs.json params.

Run pnpm live (that’s it).

Verify in logs that new markets and pools are subscribed and edges are emitted.

7) Adding a new AMM (adapter pattern)

Each AMM needs two things:

QuoteSource adapter (for publishers):

Get mid price + base/quote reserves (or an equivalent that lets us compute impact).

Publish amms_price records (same shape you already have).

Swap builder (for execution):

buildSwapIxs(params): TransactionInstruction[] that takes in‑amount, min‑out, owner, pool keys.

Must accept slippage/minOut and not force extra signers.

Interface you implement (TypeScript)

// packages/amms/src/adapters/types.ts
export interface AmmQuoteSource {
  venue: "raydium" | "orca" | "lifinity" | string;
  watch(pools: string[], opts: { rpc: string; wss?: string }): Promise<void>;
  // publish amms_price jsonl as you already do
}

export interface AmmSwapBuilder {
  venue: string;
  buildSwapIxs(p: {
    user: PublicKey;
    poolId: string;
    baseIn: boolean;        // true => BASE->QUOTE, false => QUOTE->BASE
    amountInBase: bigint;   // atoms of the input mint
    slippageBps: number;    // float bps supported
  }): Promise<{ ok: true; ixs: TransactionInstruction[] } | { ok: false; reason: string }>;
}


Steps to add AMM “Orca” (example path):

Create packages/amms/src/adapters/orca.ts implementing both interfaces above.

Register it in packages/amms/src/adapters/index.ts:

import { orcaQuoteSource } from "./orca";
import { orcaSwapBuilder } from "./orca";

export const ADAPTERS = {
  quoteSources: [raydiumQuoteSource, orcaQuoteSource /* ... */],
  swapBuilders: new Map([["raydium", raydiumSwapBuilder], ["orca", orcaSwapBuilder]])
};


The publisher will now subscribe to both Raydium + Orca pools for every pair listed in pairs.json.

The router can now form routes using either AMM on either leg.

You do not remove Raydium; the new adapter is additive.

8) Adding new routes (beyond the two‑leg you have)

Think of the market as a graph: nodes = tokens; edges = executable swaps on a venue or a CLOB take. The “route” is a sequence of edges that returns to the starting token (arbitrage).

Common additions:

Cross‑AMM two‑leg: AMM‑A ↔ AMM‑B (e.g., Raydium→Orca, Orca→Raydium).
Implementation: treat Phoenix as just another edge; reuse EV and CPMM math for both legs.

Triangular (three‑asset) on one venue: e.g., USDC→SOL→BONK→USDC, all on Orca.
Implementation: add a RouteCandidate type with legs: Edge[] and a generic “compose legs” EV evaluator:

type Edge = { venue: "raydium"|"orca"|"phoenix"; action: "buy"|"sell"; poolOrMarket: string };
type RouteCandidate = { pair: string; base: string; quote: string; legs: Edge[]; sizeMode: "base"|"quote" };


Evaluate impact+fees per leg, chain the amounts, subtract fixed costs once, compute net bps.

Size search: start with the same grid and prune if any leg exceeds pool‑frac or book depth.

Multi‑hop CLOB+AMM: PHX→AMM→AMM or AMM→AMM→PHX.
Implementation: exactly like (2), but allow a PHX edge at either end.

Search strategy (keeps it fast):

Enumerate a small set of canonical patterns (2‑leg, 3‑leg triangle, 3‑leg PHX+AMM+AMM).

For each pattern, enumerate concrete routes using pairs.json + a per‑AMM “pair registry” (what pools exist).

For each route, run the same EV + size grid you already have, but “compose legs.”

Keep the top K candidates per pair, call onDecision on the best one (s^*, route^*).

9) What changes in code (non‑breaking, summarized)

services/arb-mm/src/config.ts

Add PAIRS_FILE (string) and MULTIPAIR_ENABLED (bool) read from env.

services/arb-mm/src/main.ts

If PAIRS_FILE exists → MultiPairSupervisor.start(pairs), else keep current single‑pair boot (unchanged).

services/arb-mm/src/pairs/registry.ts (new)

Read/validate pairs.json.

Give you: list of {symbol, phoenixMarket, amms[], params}.

packages/phoenix/src/index.ts and packages/amms/src/reserves.ts

Accept arrays of markets/pools; subscribe to all; publish to the same JSONL with market/pool tags.

services/arb-mm/src/edge/router.ts (new)

Build route candidates per pair from the registry and available venues.

For now, include just the two‑leg you have for each AMM listed + Phoenix (that alone multiplies opportunities).

Later add the multi‑hop patterns (see §8).

This structure is strictly additive. If no PAIRS_FILE, nothing changes.

10) Operating procedures (SOP)

Before shipping a new pair/venue:

Dry‑run in shadow mode (set LIVE_TRADING=0 + SHADOW_TRADING=1) until you see stable edges.

Confirm fees (on‑chain where possible; you already have tryAssertRaydiumFeeBps).

Confirm min base per pair so fixed costs don’t dominate.

Risk knobs:

Per‑minute notional cap (already present in risk)—tune per pair.

cpmmMaxPoolTradeFrac per pair (keeps you from eating the whole pool).

RPC deviation guard (if you turn on sim) with a tight RPC_SIM_TOL_BPS.

Observability:

Watch edge_report, would_trade, would_not_trade, phoenix_l2, amms_price.

Per‑pair summary files in data/live/ after shutdown are your P&L audit trail.

2025-09-09T073457780Z.summary

11) “How‑to” quick pages you can give any agent
A) Add a token pair

Edit services/arb-mm/configs/pairs.json, append a new object with mints, Phoenix market, and AMM pools.

If pair needs a different min size, put it in params.decisionMinBase.

pnpm live. Verify you see phoenix_l2 and amms_price for that pair in logs.

B) Add a new AMM

Implement AmmQuoteSource (publisher) + AmmSwapBuilder (executor) under packages/amms/src/adapters/<venue>.ts.

Register both in the adapter registry; add pools in pairs.json under that venue.

pnpm live. Verify you get amms_price for the new pools and routes include that AMM.

C) Add a route type (e.g., cross‑AMM two‑leg)

In edge/router.ts, add a pattern enumerator that yields route candidates using two AMMs listed for the pair.

In joiner, add evForRoute() which composes 2 legs with the same math you already use per leg.

Re‑use the size grid; call onDecision with the best route.

12) Definition of “baseline is good to scale”

Functional: multi‑pair two‑leg routes working; no changes to single‑pair path.

Safety: per‑pair min‑base respected; max‑pool‑frac respected; fee sanity checks pass.

Operability: one command pnpm live starts everything; logs are uniform across pairs/venues.

Extensibility: adding a pair or an AMM is a config + adapter task—no core rewrites.

13) Work Breakdown Structure (first 1–2 sprints)

Sprint A – Multi‑pair foundation (keep today’s routes)

pairs.json schema + loader (registry)

Teach publishers to accept arrays (multi‑market/pool)

Main: detect PAIRS_FILE → MultiPairSupervisor → start joiners per pair+AMM (2 routes per pair)

Logging: include pair.symbol, venue, pool/market tags on all events

Soak test on 3–5 liquid pairs; tune per‑pair decisionMinBase

Sprint B – Add 1–2 AMMs

Implement new AMM adapter (quote+swap)

Add to pairs.json; run multi‑pair across 2 AMMs

Validate EV and minOut across venues; tune fee overrides where needed

Sprint C – Cross‑AMM two‑leg routes

Router enumerates AMM‑A↔AMM‑B routes per pair

Joiner composes legs; size grid reused

Execution remains single atomic tx if same signer; otherwise split (guarded)

Sprint D – Triangular (optional, per pair)

Triangular enumerator (limit to top N triangles per pair)

Compose three legs; ensure pool frac + depth constraints per leg

Per‑route EV + size; route ranking & decision gating

14) Why you aren’t seeing “lots of action” yet

You were running one pair and one AMM vs. Phoenix; spreads often aren’t big enough to beat 25 bps AMM fee + slippage + fixed costs. Your run summary confirms that the engine correctly refused negative EV, which is exactly what a reliable baseline should do. Scaling to more pairs + more AMMs is what increases edge frequency without loosening your safety bars.

2025-09-09T073457780Z.summary

TL;DR

Keep the current runner as‑is for single‑pair.

Add PAIRS_FILE to .env.live and a pairs.json to turn on multi‑pair.

Add AMMs by writing one small adapter (quotes + swap builder).

Add new routes in the router with the same EV+size calculus you already trust.

Always additive; never replace what’s working.

If you want, I can provide the exact pairs.json template filled with SOL/USDC + space for your next 4 pairs, and the adapter skeleton for Orca to copy into packages/amms/src/adapters/orca.ts.