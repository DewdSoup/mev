Agent Onboarding / Work Prompt (Master Template, v3)
Mission
Build a modular, production-grade MEV/arbitrage system on Solana that is:

Apple-simple to operate, advanced under the hood (few moving parts).

Lean & incremental (small, safe steps; no risky rewrites).

Scalable & extensible (multi-market, ML-assisted optimization).

Realistic & profitable (no luck; measurable EV uplift).

Compliant (neutral/beneficial strategies; no predatory stuff).

I’m a hard worker and will do the grind. Optimize for reliability, clarity, and testability so we can scale to $2–5k/day and beyond.

Development Rules (Non-negotiable)
Full Scripts – Always request and return the entire updated file (drop-in), not a diff. Include absolute file paths.

Commands – Provide exact shell commands to build, run, verify, and roll back.

Incremental – One feature at a time; keep changes minimal; verify in logs before moving on.

Logs First – Show before/after log samples that prove success.

No Regression – Do not break anything that already works. Additive changes only.

Focus – If something fails, fix it first. Don’t start new work with known red.

Flags – New behavior OFF by default behind env flags; defaults stay stable.

Schemas/Paths – Don’t rename/remove existing fields or move files. Additive only (see docs/log_contract.md).

Ask for Files – If I didn’t supply full current files you need to edit, ask for them before coding.

Repo Snapshot (context)
bash
Copy
Edit
code/mev/
├─ packages/
│  ├─ amms/          # Raydium CPMM (Orca/Meteora later) → emits amms_price
│  ├─ phoenix/       # Phoenix L2 (BBO + mid) → emits phoenix_l2 / phoenix_mid
│  ├─ core/ solana/ storage/
├─ services/
│  └─ arb-mm/        # joiner/decision, backtester, reports
├─ configs/
│  └─ markets.json   # market list (single market enabled by default)
└─ docs/
   └─ wbs.md         # WBS & Operator Manual (ground truth)
Stable Data Locations
Live summaries → services/arb-mm/data/live/*.summary.json

Replay summaries → services/arb-mm/data/replay/*.summary.json

Features (ML) → services/arb-mm/data/features/sol_usdc/v1/<YYYY-MM-DD>.jsonl

Reports → services/arb-mm/data/reports/<YYYY-MM-DD>.md

Params → services/arb-mm/data/params/<YYYY-MM-DD>.json

Current Capabilities (baseline you must keep working)
Tri-runner (AMMs, Phoenix, Arb joiner) with hot-reload.

Decision math: gross/net edge, slippage, fees, fixed costs; de-dupe (signature window, per-path delta, time buckets).

Live summary auto-write on shutdown.

Backtester mirrors live; features & summaries emitted.

Daily pipeline: backtest → markdown report → optimized params.

Auto-apply latest params on boot (flagged, OFF by default).

Quiet shutdown (no SIGTERM spam).

Operator Runbook (don’t change defaults without a flag)
bash
Copy
Edit
pnpm -r build
pnpm live                 # dev hot-reload; Ctrl-C writes live summary
pnpm report:live          # TL;DR for last live session

pnpm daily                # backtest(yday) -> report -> optimized params
pnpm params:preview       # prints newest params as .env lines

# Arbitrary backtest window:
pnpm backtest -- --from 2025-08-14T00:00:00Z --to 2025-08-15T00:00:00Z
Common flags to keep OFF by default:

AUTO_APPLY_PARAMS=true (optional: use newest params at boot)

Engineering Principles
Modular: Add venues/pairs without touching the core joiner.

Performance-aware: allocation-light hot path; async logging; reuse objects.

Observability: metrics & summaries; parity checks (live ↔ replay).

Safety: guardrails, feature flags, kill-switch; live trading gated.

ML / Optimization Track (high level)
Features: edge_gross/net, width, imbalance, reserves deltas, TPS, cadence, time-of-day, inclusion outcome.

Models: inclusion (logistic), slippage (regression), decision policy (threshold optimizer), tip bandit (later).

Loop: replay → optimize thresholds/slippage/size (+ tips later) → write data/params/*.json → optional AUTO_APPLY_PARAMS=true at next boot.

Compliance Note
We focus on arbitrage and strategies that improve market efficiency or provide liquidity. Anything sensitive (front/back-run) must be scoped, compliant, and explicitly approved.

Deliverables (Every Assignment)
Full drop-in files (absolute paths).

Run & verify commands (copy-paste).

Acceptance checklist (objective & testable).

Rollback & risk notes (how to revert safely).

Flags/config (new behavior must be opt-in).

Reference Commands
bash
Copy
Edit
pnpm -r build
pnpm live
ls services/arb-mm/data/live/
pnpm report:live
pnpm backtest -- --from <ISO> --to <ISO>
pnpm daily
pnpm params:preview
Examples of Safe Incremental Tasks
CPMM price-impact sim (USE_POOL_IMPACT_SIM=false) → log effective AMM price.

RPC simulateTransaction (USE_RPC_SIM=false) → compare to ladder-based price.

Report v2 (additive) → edge distribution, EV by path, best/worst minutes.

Tip advisor scaffold (TIP_ADVISOR=false) → log candidate tip levels.

Orca Whirlpools feed (same amms_price shape), behind config.

📌 Owner-Provided Next Steps & To-Do (You fill this for each agent)
Treat everything above as stable context. The block below is the only scope for this assignment.

Goal / Outcome
What result do we want? (e.g., “Improve net-EV accuracy by ≥1 bps via CPMM impact sim.”)

Scope & Flags

Target modules/paths: <paths>

New flags (default OFF): <FLAG_NAMES>

Data/log changes: additive only (see docs/log_contract.md)

Files to Request Before Editing

/abs/path/to/file1.ts

/abs/path/to/file2.ts
(Agent must request full current files before coding.)

Deliverables

Full drop-in files (absolute paths)

Run & verify commands

Acceptance checklist

Rollback instructions

Short notes on perf & future hooks

Acceptance Criteria

Build passes: pnpm -r build

Live: see <expected logs> within <N> seconds

Replay: window <from,to> yields <expected summary deltas>

No schema/path breaks; live summary written on Ctrl-C

(If new features) features JSONL includes <new fields>

Run & Verify (copy/paste)

bash
Copy
Edit
pnpm -r build
pnpm live
pnpm report:live
pnpm backtest -- --from <ISO> --to <ISO>
Risks & Rollback

Risks: <list>

Rollback: restore <paths>, keep <FLAGS>=false

