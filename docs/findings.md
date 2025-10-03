# Findings

## Current Flow Map
- Data ingestion: `services/arb-mm/src/main.ts:730` instantiates `EdgeJoiner`, then wires `startWsMarkets` and/or `MarketStateProvider.subscribe` to push Phoenix/AMM snapshots straight into the joiner (`services/arb-mm/src/provider/ws_markets.ts:84`, `services/arb-mm/src/market/provider.ts:863`).
- Quoting & routing: `services/arb-mm/src/edge/joiner.ts:1130` builds a two-node graph across Phoenix and configured AMMs and calls adapter/local math for pricing (`services/arb-mm/src/edge/joiner.ts:944`). CLMM math still falls back to mid-price when adapters fail.
- Fees: runtime resolves taker fees from env/JSON (`services/arb-mm/src/config.ts:142`); publishers hardcode 25/30 bps fallbacks when on-chain hints missing (`services/arb-mm/src/provider/ws_markets.ts:100`, `services/arb-mm/src/provider/ws_markets.ts:143`).
- Execution: `services/arb-mm/src/executor/live.ts:252` consumes joiner payloads, rebuilds venue ixs, estimates dynamic fee/tip, and submits via `submitAtomic` (`services/arb-mm/src/tx/submit.ts:45`).
- Risk & gating: `services/arb-mm/src/risk.ts:8` tracks minute caps and error bursts; execution rechecks EV and tip budgets before send (`services/arb-mm/src/executor/live.ts:456`).
- Config & caching: `services/arb-mm/src/config.ts:20` locks env precedence; RPC facade wraps connections with limiter/backoff (`packages/rpc-facade/src/index.ts:307`). Phoenix warm-start expects snapshots under `data/cache/phoenix` (`services/arb-mm/src/edge/joiner.ts:321`).

## Pain Points Observed
- **Limiter bottleneck** – live env pins the RPC token bucket to 3 rps / 3 burst (`.env.live:252`, `.env.live:254`), while facade’s queue serialises requests (`packages/rpc-facade/src/index.ts:307`). Logs showed queues building and CLMM refreshes starved.
- **Staleness gating by wall-clock** – joiner rejects AMM states purely on `age_ms` and slot lag (`services/arb-mm/src/edge/joiner.ts:77`), so any WS hiccup >3.5s drops pools even if same slot; CLMM feeds hit this often.
- **Phoenix cache cold-start** – joiner tries to read `{market}.json` on boot (`services/arb-mm/src/edge/joiner.ts:321`) but publisher only writes snapshots when running (`packages/phoenix/src/index.ts:150`), leaving first session without L2 until live data arrives.
- **Fee handling inconsistent** – adapters/publishers default to hardcoded 25/30 bps (`services/arb-mm/src/provider/ws_markets.ts:100`, `services/arb-mm/src/adapters/manifest.ts:34`) while provider already decodes Raydium numerators (`services/arb-mm/src/market/provider.ts:1004`); router ignores per-pool program fees.
- **Routing coverage limited** – graph enumerates paths but relies on single mid reference and synchronous Phoenix book (`services/arb-mm/src/edge/joiner.ts:1148`). No slot fence ensures multi-leg coherence, and AMM→AMM disabled unless env toggled.
- **Size grid collapses to one probe** – FIXED_PROBE_BASE forces `buildSizeGrid` to return a single size (`services/arb-mm/src/edge/joiner.ts:621`, `.env.live:213`), explaining the 0.02–0.05 base logs.
- **Type safety gaps** – multiple code paths assume `PublicKey` instances (e.g., `services/arb-mm/src/executor/live.ts:140`, `services/arb-mm/src/tx/submit.ts:30`) but inputs originate as strings from configs/payloads; missing guards lead to `publicKey.toBase58` runtime errors seen in logs.
- **Balance polling noisy** – repeated `getTokenAccountBalance` calls in `sumMintBalance` retry missing ATAs each loop (`services/arb-mm/src/main.ts:268`) without caching outcomes, producing the observed “account not found” spam.

## Change Priorities (next phases)
1. Land `VenueAdapter` interface and adapter registry for Phoenix/Raydium CPMM+CLMM/Orca Whirlpool—source on-chain fee models and expose slot-aware updates.
2. Replace joiner routing with a slot-synchronised multi-hop engine (≤3 legs) that consumes adapter quotes, size grids, and fee cache.
3. Build freshness gate keyed to slot/ts TTLs; raise limiter throughput, add WS/Geyser ingestion, and persist Phoenix snapshots on shutdown.
4. Introduce global fee cache + per-venue readers, integrate precise CPMM/CLMM impact math, and expand dynamic size grids.
5. Harden execution: ATA checks, optional RPC/venue sims, dynamic priority fees, and bundle/Jito hooks behind flags.
6. Add observability (metrics/logs/alerts) and test harnesses (unit, property, replay, shadow trading) to cover math, fees, and routing regressions.

These priorities align with the requested sections 3–7 and will be implemented behind feature flags to keep current behaviour until validated.
