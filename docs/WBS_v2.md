Phase 0 — Foundation Lock (CI, tests, reproducibility) (Do this first; no runtime change)

Goal: Make correctness provable and repeatable.

Tasks

Deterministic environment

Add a minimal Dockerfile + devcontainer (Node LTS you pinned + build-essentials) and a “dry-run” make target that builds with native bigint-buffer only.

Gate postinstall to fail if the native path isn’t used (detect pure-JS fallback).

CI

GitHub Actions: matrix on Node 18/20; jobs = pnpm -r build, unit tests, typecheck, lint.

Unit tests (CPMM & fees)

Property tests for minOut: fee-less invariant (x·y), then fee/slippage application; BigInt/BN parity tests.

Golden tests for venue fees (Raydium, Phoenix), tip math, and fixed cost accounting.

Replay parity test

Single “golden day” fixture; assert backtest == live decisions byte-for-byte (ignoring timestamps).

Acceptance

CI green on main; Docker build succeeds; tests > 90% lines for AMM math and fee/slippage/tip.

Backtest parity: ≥ 99.9% identical decisions on the fixture day.

Abort guards

If any pure-JS bigint is detected in CI, job fails.

Phase 1 — Phoenix L2 (✅ done)

Keep as-is. Acceptance stays: 30+ mins stable, phoenix_source: "book" via getUiLadder.

Phase 2 — Decision Layer (Simulation) (✅ MVP; tighten metrics)

Goal: Decisions match realized outcomes within tight error bounds.

Add acceptance metrics (no behavior change yet)

Log predicted vs realized slippage error distribution for landed trades.

Net EV calibration: median(|EV_pred – EV_real|) ≤ 2 bps; 95th ≤ 5 bps over 3 days (micro size).

Abort guards

If realized EV histogram skews negative for two consecutive sessions, auto-drop LIVE_TRADING to 0 and mark session red.

Phase 3 — Replay / Backtest (✅ done; add invariants)

Goal: Bit-exact reproducibility.

Acceptance (tightened)

Decision parity ≥ 99.9% for fixture day.

Feature rows non-decreasing (no schema breaks) across 3 consecutive days.

Phase 4 — Execution Prep (Simulators & Guards) (Days 1–4; flags OFF by default)

Goal: Measure before moving size.

Tasks

CPMM price-impact simulator (existing)

Emit amm_eff_px, amm_price_impact_bps for trade size; ensure unit-safe BigInt→BN conversions only at SDK boundary.

RPC simulateTransaction (existing)

Log sim_eff_px, sim_slippage_bps, compute_units, prioritization_fee.

Risk scaffolding (read-only → blocking)

Per-minute notional cap, per-path consecutive-fail cap, TPS throttle, kill-switch (read-only today, block tomorrow).

Acceptance

With flags ON, all additive fields present in live logs; backtest ignores them gracefully.

CPMM vs RPC-sim slippage delta: median ≤ 1 bps, 95th ≤ 3 bps (micro size).

Abort guards

If RPC-sim fails > 5% in a session, auto-disable USE_RPC_SIM and mark session amber.

Phase 5 — Micro Live Execution (Days 5–9; tiny size)

Goal: Land small orders safely; prove EV calibration.

Tasks

Preflight hardening: SOL/USDC balances + ATAs; refuse send on missing ATA or low SOL.

Guards ON (blocking): notional cap/minute, consecutive-fail cap, error-burst kill-switch, TPS throttle.

Execution: Send only when (a) EV≥0 after all fees/slippage/tip, (b) sim (if enabled) passes, (c) guards pass.

Acceptance

≥ 3 landed trades with |slippage_pred – slippage_real| median ≤ 1 bps.

Zero guard violations; kill-switch manually tested (inject 3 synthetic errors).

Session summary written; report shows realized P&L ≥ 0 with micro notional.

Abort guards

Any session with 2+ land_error from the same cause → auto-pause.

Phase 6 — Latency & Reliability I (Core) (Days 10–12)

Goal: Cut decision→send critical path; eliminate stalls.

Tasks

RPC pool with health scoring: rotate providers; record p50/p95 latency and error rate; prefer lowest p95.

Warm sockets: persistent Phoenix/AMM streams with exponential backoff and jitter; detect gaps.

Tx pipeline: cache blockhash; pre-build compute-budget ixs; avoid unnecessary serialization; parallelize reserve fetch & tip calc.

Acceptance

p95 tick→decision < 80 ms, p95 decision→submit < 40 ms on target box.

No feed gaps > 10s during a 12-hour run.

Abort guards

If p95 decision→submit exceeds 80 ms for > 30 min, auto-drop to shadow.

Phase 7 — Jito & Inclusion Control (Days 13–14)

Goal: Deterministic inclusion under load, with safe fallback.

Tasks

Add Jito submit path with runtime fallback to RPC if bundle fails pre-slot.

Log inclusion target vs actual slot; compute in-block hit rate.

Tip policy staged: static → microLamports/compute-unit → dynamic bands (still rules-based; ML later).

Acceptance

≥ 90% of live sends land within the targeted block window when Jito enabled.

No increase in land_error vs RPC baseline during a 6-hour A/B.

Abort guards

If bundle rejection > 5% with no RPC fallback success, auto-disable Jito for session.

Phase 8 — Market/AMM Expansion (Raydium → +2 venues) (Days 15–18)

Goal: Parallel, interchangeable venues without code sprawl.

Tasks

Unify AMM adapter interface: price(), quoteFixedIn(), minOut(), feeBps(), buildSwapIx().

Add Orca Whirlpools and Meteora adapters; keep Raydium as reference.

Config-driven enablement; per-pool fee/slippage overrides from a single JSON.

Acceptance

3+ markets live; single decision layer chooses the best path.

Backtest filterable by symbol and venue.

Abort guards

Any adapter that can’t prove CPMM/curve math parity (unit tests) stays disabled.

Phase 9 — Latency & Reliability II (Pre-signing, CPU, GC) (Days 19–20)

Goal: Shave the last 10–20 ms.

Tasks

Pre-build & cache v0 message skeletons; only mutate ix data on send.

Node flags: tune GC pause/throughput; pin process to cores; disable CPU C-states on the box.

Fast path for “unchanged accounts” to skip rebuild.

Acceptance

p95 decision→submit < 25 ms sustained for 6 hours.

No increase in invalid-blockhash or signature-mismatch errors.

Phase 10 — Advanced Strategies (flag-gated; micro size) (Days 21–24)

Goal: Add high-EV paths without destabilizing the core.

Tracks (independent flags)

Same-pool backrun

Detect inbound Raydium swaps (log or memcmp); build atomic bundle to capture price impact.

Acceptance: ≥ 5 executed backruns with positive realized EV; no adverse selection spikes.

Cross-venue backrun/arb

Use AMM A price impact as signal for AMM B; ensure both legs’ minOut applied.

Acceptance: ≥ 10 executed cross-venue trades; median EV error ≤ 3 bps.

Flash-loan liquidations (Kamino/marginfi, etc.)

Separate executor with strict invariant checks; no interference with arb path.

Acceptance: 1+ clean liquidation with full accounting logged.

Abort guards

Any strategy exceeding 2 consecutive net-neg sessions disables itself automatically.

Phase 11 — ML & Optimizers (offline → shadow → live) (Days 25–28)

Goal: Data-driven tuning without regressions.

Tasks

Param optimizer (offline)

Daily job: optimize threshold/slippage/size under turnover & variance constraints; write dated params JSON.

Shadow-apply

Engine reads the file, computes “what would have happened,” but doesn’t change behavior.

Bandit tip advisor (shadow)

Discrete tip bands conditioned on edge & mempool pressure; log tip_suggested vs tip_used.

Acceptance

3-day shadow A/B shows uplift in expected EV and inclusion% with no increase in land errors.

Flip AUTO_APPLY_PARAMS=true only after shadow success.

Phase 12 — Observability & PnL (Days 29–30)

Goal: See everything, quickly.

Tasks

Roll up JSONL → daily CSV/Parquet; quick scripts for histograms (latency, slippage, inclusion, EV vs PnL).

Single dashboard: opportunities, inclusion %, EV calibration, realized PnL, latency, guard trips, error codes.

Alerts: feed stall, inclusion drop, negative drift, kill-switch trip.

Acceptance

1 dashboard answers: Why didn’t we trade? Why did we lose? Where’s the latency?

On-call checklist for common reds with exact commands.

Phase 13 — Soak & Scale (size ramp) (7-day rolling)

Goal: Increase notional safely.

Tasks

Ramp plan: 1× → 2× → 4× notional; advance only if (a) positive PnL 2 days running, (b) EV error within targets, (c) inclusion ≥ 85%.

Daily post-mortem automation comparing summaries; drift checks.

Acceptance

48-hour soak at 2× without reds; 7-day run with stable positive PnL.

Abort guards

Any day with net-neg PnL and degraded EV calibration → auto-halve size.

Global Standards (enforced every phase)

Native bigint paths only; CI blocks pure-JS fallback.

Unit-safe numerics end-to-end; conversions only at SDK boundary.

No silent catches; every error carries reproduction context.

Apple-simple UX: one runner, clear flags, sensible defaults, exhaustive logs.

Quick “Definition of Done” per objective

Correctness: CPMM + fees + slippage + fixed costs match realized within stated bps bands.

Latency: Hard p95 budgets met before enabling larger size.

Inclusion: Jito path improves hit rate with clean fallback.

Scale: Multi-venue via one adapter interface; strategy flags isolate risk.

Repro: Backtest parity ≥ 99.9%; CI green; Docker build clean.