Where we are (right now)

Live-capable SOL/USDC arb is running (Raydium CPMM ↔ Phoenix L2).

Publishers:

packages/amms/src/reserves.ts streams Raydium vault balances → mid price.

packages/phoenix streams Phoenix mid & L2 (stable via getUiLadder).

Decision layer:

EdgeJoiner computes edges (fees/slippage aware).

Dynamic size optimizer (uses latest Phoenix book + Raydium reserves).

Optional RPC swap sim (Raydium) to sanity-check price impact.

Guards (dedupe, TTL, basic risk counters).

Execution:

LiveExecutor sends micro orders when criteria are met.

Session summaries write start/end balances (SOL, wSOL, USDC) so you see net movement.

ML-friendly logs for decisions, RPC latency, submitted/landed fills.

You can already run micro live, observe, and tweak with env flags.

Repository structure (kept simple & scalable)
mev/
├─ .env / .env.live / .env.shadow            # run profiles
├─ package.json (workspace scripts)
├─ tsconfig*.json
├─ packages/
│  ├─ amms/                                  # AMM adapters & publishers
│  │  ├─ src/reserves.ts                     # Raydium CPMM reader (live)
│  │  └─ src/adapters/*                      # (scaffold) orca/meteora/openbook
│  ├─ phoenix/                               # Phoenix L2 publisher
│  ├─ core/                                  # math, numerics, invariants
│  ├─ risk/                                  # guardrails & policy
│  ├─ storage/                               # logger & JSONL sinks
│  └─ solana/                                # web3 helpers, builders
├─ services/
│  └─ arb-mm/
│     ├─ src/main.ts                         # live runner (joiner, exec, summary)
│     ├─ src/edge/*                          # EdgeJoiner logic
│     ├─ src/executor/
│     │  ├─ live.ts                          # spot execution (current)
│     │  ├─ sim.ts                           # RPC sim helpers
│     │  ├─ size.ts                          # dynamic size optimizer
│     │  └─ flashloan/*                      # (new track) flash-loan executor
│     ├─ src/ml_schema.ts                    # ML event emitters (snapshots, etc.)
│     ├─ src/util/*                          # num utils, raydium helpers
│     └─ data/sessions                       # runtime summaries & logs
└─ configs/
   ├─ markets.json                           # (optional) multi-market config
   └─ params/YYYY-MM-DD.json                 # (later) optimizer outputs


The flash-loan executor will live under services/arb-mm/src/executor/flashloan/ and stays flag-gated so it never interferes with spot execution.

Phased roadmap (flash-loan moved earlier)

Each phase = Objective → Tasks → Deliverables → Acceptance/DoD.
You can progress linearly and earn early with flash loans once the MVP guardrails pass.

Phase A — One-Hour Micro Live Soak (you’re here)

Objective: Prove end-to-end sending + logging + balance snapshots with micro size.

Tasks

Run pnpm live for ~1h with tiny size (LIVE_SIZE_BASE=0.001).

If you want to force a couple sends while staying tiny:

TEST_FORCE_SEND_IF_ABS_EDGE_BPS=0.40

TEST_MAX_SENDS=2

Deliverables

data/live/<ts>.summary.json with balances_start / balances_end.

JSONL logs for amms/phoenix/arb.

DoD

≥1 landed send (real or forced).

No fatal errors; summary written.

Phase 0 — Foundation & Repro (no Docker required yet)

Objective: Correctness you can trust; predictable replays.

Tasks

Unit tests: CPMM invariant (x*y fee-less), fee+slip application, tip/fixed-cost math.

Golden tests: Raydium & Phoenix fees on known IDs.

Replay parity: a “golden day” fixture; decision parity check.

Deliverables

packages/core/__tests__/*, services/arb-mm/__tests__/*.

pnpm test green; pnpm backtest supports --from/--to.

DoD

90% line coverage on AMM math + fee/tip paths.

Fixture parity ≥ 99.9% decisions (ignore timestamps).

(Optional later: minimal Dockerfile + GitHub Actions matrix — not blocking early cashflow.)

Phase 1 — Phoenix L2 Stability (✅ keep)

Objective: Stable Phoenix mid/L2 with low jitter.

DoD

30+ mins stable, phoenix_source="book" via getUiLadder; no gaps >10s.

Phase 2 — Decision Calibration & ML Metrics

Objective: Decisions match realized outcomes; log calibration metrics.

Tasks

Log pred vs realized slippage per landed trade.

Compute EV_pred vs EV_real and emit to ML logs.

Deliverables

ML records: edge_snapshot, decision, submitted_tx, landed, rpc_sample.

Tiny analysis script to compute median(|EV_pred – EV_real|).

DoD

Over 3 micro days: median error ≤ 2 bps, p95 ≤ 5 bps.

Abort guard: two sessions with negative EV drift → auto set LIVE_TRADING=0.

Phase 2.5 — Flash-Loan MVP (Shadow → Dry-Run → Micro Live)

Objective: Enable capital-light arbitrage by borrowing intra-tx and repaying atomically.

Design (Solana-friendly, safe)

Option A — True atomic (preferred):
Use a protocol that supports flash loans (e.g., Kamino / marginfi / Solend if available and permissionless).
This typically requires a flash-loan receiver program (your tiny on-chain program) that:

receives the borrowed funds,

executes your swap legs via CPI (Raydium/Orca/etc.),

repays the loan + fee in the same transaction,

enforces invariants (no under-repay, no negative balances).

Option B — Bundle-atomic via Jito (backup):
Encode borrow → swap(s) → repay as a single transaction if lender allows, or as a bundle if their interface supports it. Bundles aim for all-or-nothing inclusion; still treat as non-atomic fallback and guard carefully.

Tasks

Create flash-loan executor module (client side) + minimal receiver program (Anchor or raw Rust), gated by:

ENABLE_FLASH_LOAN=1

FLASH_PROVIDER=kamino|marginfi|solend (as supported)

FLASH_MAX_NOTIONAL, FLASH_FAIL_CLOSE=true

Add full pre-sim pipeline: pessimistic slip, compute budget estimation, repay check.

Shadow mode first: simulate full path; no sends.

Dry-run “real tx build” without broadcasting (log the full plan).

Micro live after passing sims.

Deliverables

services/arb-mm/src/executor/flashloan/* (client)

programs/flash_receiver/* (tiny on-chain borrower; one entrypoint that takes encoded legs & repays)

Unit tests: bad path (leg fail), fee spike, under-repay → must revert.

DoD

Shadow: pass full-path sim for ≥ 100 candidate ops with zero under-repay.

Micro live: ≥ 1 clean, profitable flash-loan trade; logs show borrow → legs → repay with positive EV after all fees.

Spot executor unaffected (isolated queue, rate limits).

Why now? This lets you trade with minimal upfront capital, staying micro while we harden everything else.

Phase 3 — Backtest Tightening

Objective: Bit-exact reproducibility; schema stability.

DoD

Parity ≥ 99.9% on fixture day.

Feature rows non-decreasing across 3 days (no schema breaks).

Phase 4 — Simulators & Guards (Additive; default OFF)

Objective: Measure thoroughly; enforce guardrails before size.

Tasks

CPMM impact simulator (already present) logs amm_eff_px, amm_price_impact_bps.

RPC simulateTransaction logs sim_eff_px, sim_slippage_bps, compute_units, prioritization_fee.

Risk scaffolding:

Per-minute notional caps,

Consecutive-fail caps,

Error-burst kill-switch,

TPS throttle,

(For flash loans) repay-invariant guard and provider health.

Deliverables

Extra fields in logs; backtest ignores gracefully.

DoD

CPMM vs RPC-sim slip delta: median ≤ 1 bps, p95 ≤ 3 bps (micro).

Abort guard: RPC-sim fails > 5% → auto disable USE_RPC_SIM.

Phase 5 — Micro Live (Spot + Flash) with Blocking Guards

Objective: Land small orders safely using either wallet balance or flash-loan path.

Tasks

Preflight strict: SOL/USDC & ATAs; refuse send if low SOL or missing ATA.

Guards ON (blocking): notional/min, consecutive fails, error bursts, TPS throttle.

Execution criteria:

EV≥0 after all fees/slip/tip/flash-fee,

sim (if enabled) passes,

guards pass,

for flash-path: repay-invariant proven in pre-sim.

Deliverables

Session summary includes guard stats (+ flash-loan stats: borrow fee, repay delta).

DoD

≥ 3 landed trades (any mix of spot/flash-loan) with median |slippage_pred – slippage_real| ≤ 1 bps.

Zero guard violations; manual kill-switch works.

Session P&L ≥ 0 with micro notional.

Phase 6 — Latency & Reliability I (Core)

Objective: Cut decision→submit; avoid stalls.

Tasks

RPC pool w/ health scoring (p50/p95 latency, error rate).

Warm, persistent Phoenix/AMM sockets w/ backoff+jitter; gap detection.

TX pipeline: cached blockhash, prebuilt compute budget ixs, parallel reserve fetch & tip calc.

DoD

p95 tick→decision < 80 ms, p95 decision→submit < 40 ms.

No feed gaps > 10 s during 12-hour run.

Abort guard: >80 ms for >30 min → drop to shadow.

Phase 7 — Inclusion Control (Jito)

Objective: Deterministic inclusion with clean fallback.

Tasks

Jito submit path; fallback to RPC if bundle fails pre-slot.

Log target vs actual slot; in-block hit rate.

Tip policy staged: static → microlamports/CU → dynamic bands (rules first, ML later).

DoD

≥ 90% land in targeted block window when Jito enabled.

No increase in land_error vs RPC baseline in 6-hour A/B.

Abort guard: bundle rejection >5% w/o RPC success → disable Jito.

Phase 8 — Venue Expansion (Adapters: Orca, Meteora, OpenBook)

Objective: Parallel venues w/o code sprawl.

Tasks

Adapter interface (price(), quoteFixedIn(), minOut(), feeBps(), buildSwapIx()).

Implement Orca Whirlpools, Meteora, OpenBook.

Single JSON for per-pool overrides; config-driven enablement.

Deliverables

packages/amms/src/adapters/{raydium,orca,meteora,openbook}.ts

Adapter unit tests for CPMM/curve math parity.

DoD

3+ markets live; one decision layer picks best path.

Backtest filterable by symbol & venue.

Any adapter failing parity → stays disabled.

Phase 9 — Latency & Reliability II (Pre-signing, CPU, GC)

Objective: Shave last 10–20 ms.

Tasks

Prebuild & cache v0 message skeletons; mutate ix data only.

Tune Node GC (pause/throughput); pin to cores; host C-state tuning.

Fast path for unchanged accounts to skip rebuild.

DoD

p95 decision→submit < 25 ms for 6 hours.

No increase in invalid-blockhash or signature-mismatch.

Phase 10 — Advanced Strategies (flag-gated micro)

Objective: Add high-EV tracks safely.

Tracks

Same-pool backrun (Raydium): detect inbound swaps; atomic bundle to capture impact.
DoD: ≥5 executed backruns, positive realized EV; no adverse selection spikes.

Cross-venue backrun/arb: leverage price impact on A → act on B; enforce minOut on both legs.
DoD: ≥10 executed trades; median EV error ≤ 3 bps.

JIT-LP / fee farming (venue-dependent): temporary LP during bursts; controlled inventory.
DoD: measurable fee capture with bounded inventory drift.

Global Abort Guard: 2 net-neg sessions in a row → auto-disable that track.

Phase 11 — ML & Optimizers (offline → shadow → live)

Objective: Data-driven tuning with no regressions.

Tasks

Daily param optimizer (offline): threshold/slippage/size under turnover & variance constraints → write dated JSON.

Shadow-apply: compute “what would have happened” without changing behavior.

Bandit tip advisor (shadow): tip bands by edge & mempool pressure; log tip_suggested vs tip_used.

Deliverables

services/arb-mm/scripts/optimize_params.ts

Params snapshots: configs/params/YYYY-MM-DD.json.

DoD

3-day shadow A/B shows uplift in expected EV & inclusion% w/o increased land errors.

Then flip AUTO_APPLY_PARAMS=true.

Phase 12 — Observability & PnL

Objective: See everything quickly.

Tasks

Roll JSONL → daily CSV/Parquet; scripts for histograms (latency, slippage, inclusion, EV vs PnL).

One dashboard: opportunities, inclusion %, EV calibration, realized PnL, latency, guard trips, error codes.

Alerts: feed stall, inclusion drop, negative drift, kill-switch.

DoD

One dashboard answers: Why no trades? Why loss? Where’s latency?

On-call checklist with exact commands.

Phase 13 — Soak & Scale (rolling 7 days)

Objective: Increase notional safely.

Tasks

Ramp: 1× → 2× → 4×; advance only if:

Positive PnL 2 days in a row,

EV error within targets,

Inclusion ≥ 85%.

Daily post-mortem automation; drift checks.

DoD

48-hour soak at 2× with no reds; 7-day run with stable positive PnL.

Abort guard: any day with net-neg PnL and degraded EV calibration → auto-halve size.

Production Definition of Done (money-on checklist)

Repro/Correctness: tests ≥ 90% on math/fees/slippage/tips; replay parity ≥ 99.9%.

Latency: p95 tick→decision < 80 ms; p95 decision→submit < 25–40 ms.

Inclusion: Jito path improves hit rate; robust RPC fallback; in-block ≥ 90% in A/B.

Calibration: 3-day live micro EV error median ≤ 2 bps, p95 ≤ 5 bps.

Risk: guards ON; kill-switch verified; error-burst protection working.

Observability: single dashboard + alerts; daily summaries & balance deltas.

Scalability: multi-venue via adapters; strategies isolated via flags; config-driven enablement.

ML: optimizer proven in shadow; then auto-applied.

Flash-Loan: isolated executor with strict repay invariant; ≥1 clean profitable atomic sequence in live micro.

Ops simplicity: “Apple-simple” commands (pnpm live, pnpm shadow, pnpm report:live:*).