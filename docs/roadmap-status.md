# MEV Arbitrage Stack – Roadmap Handoff

Last updated: 2025-10-29

This document now serves two purposes:
1. Capture the completed seven-step baseline rollout.
2. Track the follow-on roadmap required to prepare the stack for the upcoming private low-latency node, modular DEX coverage, flash-loan–backed smart routing, and advanced execution/analytics.

Hand this summary to any follow-on agent so they can independently verify progress and pick up execution.

---

## Quick Status Table

| Step | Scope | Status | Notes |
| ---- | ----- | ------ | ----- |
| 1 | Config validation | ✅ Complete | Validations merged, no open action items. |
| 2 | Adapter refactor | ✅ Complete | Unified adapter manifest + helpers in place. |
| 3 | Routing abstraction | ✅ Complete | `routing/graph.ts` consolidated; tests cover two-leg permutations. |
| 4 | Executor legs | ✅ Complete | Executor consumes structured `ExecutionLeg[]` payloads. |
| 5 | Telemetry (candidate stats + venue freshness) | ✅ Complete | Telemetry now emits per-run sidecars under `<run>/telemetry/` (legacy global files kept for backward compatibility). |
| 6 | Multi-hop readiness | ✅ Complete | Latest runs show all Phoenix permutations; execution remains guarded by `ENABLE_MULTI_HOP_EXEC`. |
| 7 | Staging support | ✅ Complete | Paper-trade run captured (`data/runs/staging/2025-10-29T032424894Z/`); replay + docs in place. |

---

## Step 6 – Multi-Hop Readiness (Complete)

### Current Artifacts
- **Code:** `services/arb-mm/src/routing/graph.ts` now assigns Phoenix intent dynamically and records every permutation (`PHX->AMM`, `AMM->PHX`, `AMM->PHX->AMM`, `AMM->AMM->PHX`, etc.). `edge/joiner.ts` validates arbitrary leg orderings and emits telemetry for the real source/destination venues.
- **Feature Flags:** `.env.live` keeps `ENABLE_MULTI_HOP_ROUTES=1`, `ENABLE_MULTI_HOP_EXEC=0`, `MAX_ROUTE_LEGS=3`. Execution remains explicitly gated.
- **Tests:** `services/arb-mm/test/routes.spec.ts` asserts Phoenix-in-the-middle/tail signatures.
- **Latest run:** `data/runs/2025-10-29T002138791Z/` shows the full permutation set in `path-pairs.log` plus matching entries in `candidate-stats.jsonl`. All candidates were rejected for negative edge—expected with paper-trading enabled.

### Validation Notes
- Executor payloads already consume generic `ExecutionLeg[]`; no additional wiring required.
- Promotion to full execution only requires flipping `ENABLE_MULTI_HOP_EXEC=1` once ready for live fills.
- Continue monitoring telemetry to ensure profitability thresholds behave as expected prior to enabling execution.

---

## Step 7 – Staging Support (Complete)

### Current Artifacts
- **Env Template & Defaults:** `configs/staging.env` (and generated `.env.staging`) mirror live toggles, run in paper-trade mode (`LIVE_TRADING=0`, `ENABLE_MULTI_HOP_EXEC=0`), and point `RUNS_ROOT` to `data/runs/staging`. Launch with `pnpm staging` for a dry-run.
- **Replay Harness:** `services/arb-mm/scripts/replay_run.ts` ingests a run directory (or the latest under `data/runs/`) and emits a JSON summary: time window, path counts, best net edge per path, skip / rejection reasons, and correlated telemetry stats (read from `<run>/telemetry/`).
- **Automation:** `pnpm --filter @mev/arb-mm run staging:check` performs `tsc --noEmit`, runs the routing vitest target, and executes the replay script in one command.
- **Documentation:** `docs/staging-playbook.md` provides the staging checklist (env prep, commands, promotion gates).

### Validation Evidence
- Paper-trade run captured at `data/runs/staging/2025-10-29T032424894Z/`; replay summary recorded via `pnpm --filter @mev/arb-mm run staging:replay -- --run data/runs/staging/2025-10-29T032424894Z`.
- Telemetry sidecars confirmed under `<run>/telemetry/` for both live and staging sessions.

### Notes / Next Steps
1. Multi-hop execution remains disabled (`ENABLE_MULTI_HOP_EXEC=0`). Flip the flag when ready for live fills.
2. Consider wiring `pnpm --filter @mev/arb-mm run staging:check` into CI to guard future changes.

---

## Logs & Telemetry Reference
- **Run artifacts:** `data/runs/<ISO timestamp>/`
  - `arb-runtime.jsonl` – decision stream.
  - `path-pairs.log` – enumerated routes per snapshot.
  - `events-*.jsonl` – ML events.
- **Live telemetry:** emitted per run under `<run>/telemetry/` (legacy shared files continue to work for older sessions).
- **Config state:** `.env.live`, `configs/pairs.json`, `configs/staging.env`.

---

## Handoff Guidance for Next Agent
1. Re-run the multi-hop vitest target (`pnpm --filter @mev/arb-mm vitest run test/routes.spec.ts`) to check for regressions.
2. When new live artifacts drop, use `services/arb-mm/scripts/replay_run.ts` to summarise them and attach the JSON output to the handoff.
3. Follow the staging playbook (`docs/staging-playbook.md`) to perform a paper-trade dry-run with `.env.staging`.
4. Once staging replay results look healthy, consider enabling `ENABLE_MULTI_HOP_EXEC` for controlled trials.
5. Update this document with run IDs, replay outputs, and promotion decisions as you progress.

Keep all modifications ASCII, observe repository coding standards, and coordinate feature-flag toggles (`ENABLE_MULTI_HOP_EXEC`, etc.) prior to live testing.

---

## Phase 2 – Modular Venue Expansion & Smart Routing

Objective: make the system DEX-agnostic and ready to scale across many venues/tokens while staying within latency budgets.

### Deliverables
1. **Extended Pair & Venue Registry**
   - `configs/pairs.json` supports per-pair fields: `maxLegs`, `maxPhoenix`, `allowedVenues`, `minSizeBase`, `maxSizeBase`, `priorityWeight`, `flashLoanEligible`.
   - Loader surfaces the config and exposes a typed API (`services/arb-mm/src/registry/pairs.ts`).
   - Definition of done: joiner/executor read these settings; configuration change triggers behaviour change without code edits.
2. **Venue Modules**
   - Each DEX adapter (Raydium, Orca, Meteora, Lifinity, future) implements a uniform interface for quote + instruction building, including metadata needed for flash loans (e.g., token accounts, vaults, swap keys).
   - Definition of done: integration test builds a synthetic multi-leg bundle for each venue using mocked liquidity.
3. **Pair Scheduler & Resource Budget**
   - Priority queue to allocate CPU/quote budget per pair; metrics exported to telemetry (`telemetry/pair-metrics.jsonl`).
   - Definition of done: staging run shows per-pair candidate counts and ensures no single pair starves the rest.
4. **Heuristic Pruning**
   - Liquidity floor, staleness cutoffs, adaptive edge thresholds configurable per venue/pair.
   - Memoized quote cache for snapshot reuse.
   - Definition of done: replay script summary includes counts of pruned candidates by reason.

## Phase 3 – Flash-Loan Atomic Execution Engine

Objective: build end-to-end support for atomic flash-loan bundles that size themselves optimally and execute multi-leg paths instantly.

### Deliverables
1. **ExecutionLeg Extensions**
   - Add `FlashLoanLeg` type with lender program, loan amount, and repayment metadata (`services/arb-mm/src/types/execution.ts`).
   - Joiner marks routes requiring flash liquidity; executor understands the new leg.
   - Definition of done: unit test constructs an instruction sequence containing loan, swaps, repayment.
2. **Atomic Transaction Builder**
   - Stepwise builder that assembles all leg instructions, ATA creations, loan requests, and repayments with deterministic ordering.
   - Support for template-based assembly so new venues/pairs plug in seamlessly.
   - Definition of done: staging replay can simulate an atomic bundle offline (no live send).
3. **Optimal Flash-Loan Sizing**
   - Adaptive sizing policy calculates target size by walking AMM math (reserves, fee curves) until marginal profit ≤ threshold.
   - Policy considers wallet balance vs flash loan limit; returns both size and whether loan is required.
   - Definition of done: telemetry records recommended size, marginal edge at cut-off, and whether flash loan was triggered.
4. **Latency Guardrails**
   - Profiling hooks measure planner time per path; budget enforcement aborts strategies exceeding thresholds.
   - Definition of done: candidate telemetry includes `planning_ms` and confirms compliance with configured limits.

## Phase 4 – Priority Execution, Analytics & ML Signals

Objective: ensure transactions land first and continuously improve performance via telemetry and machine learning.

### Deliverables
1. **Priority Fee Engine**
   - Integrate Jito (or equivalent) submission path with feature flag.
   - Implement dynamic tip estimator (initial heuristic + data logging). Telemetry captures tip paid, inclusion slot, success rate.
   - Definition of done: live/staging run logs `priority_fee_summary` entries; flag swap toggles path.
2. **Comprehensive Telemetry**
   - Log win/loss, missed opportunities by reason, simulated vs realized PnL, route depth success.
   - Output to structured files under `<run>/telemetry/` (e.g., `decision-summary.jsonl`, `missed-opportunities.jsonl`).
   - Definition of done: replay script aggregates these stats and highlights top failure modes.
3. **ML-Ready Dataset**
   - Curate a dataset (Parquet/JSONL) containing features per decision for training: state snapshot, path metadata, outcome, latency, fees.
   - Provide schema documentation and initial notebook (or script) for model experiments.
   - Definition of done: dataset exported post-run and replay script validates schema integrity.
4. **Predictive / Trend Analytics (Stretch)**
   - Optional future milestone: train a model to score path profitability or predict conditions for high-value routes.
   - Definition of done: prototype model evaluated offline; recommendations fed back into routing thresholds under a feature flag.

---

## Phase 5 – Private Node Integration (Deferred until hardware ready)

Objective: swap to the private low-latency feed with minimal friction once it is available.

### Deliverables
1. `.env.private` & docs describing required secrets, toggles, and swap procedure.
2. Provider abstraction (`RPC_PROVIDER=public|private`) with latency/uptime telemetry.
3. Shadow mode run that compares public vs private feed outputs over the same timeframe.
4. Decision latency report highlighting improvement with private data.

Record run IDs and telemetry references when these items are implemented.
