# MEV Program — Work Breakdown Structure & Operator Manual

*Last updated: today*

---

## TL;DR — Quick Start

```bash
# 0) From repo root
pnpm -r build

# 1) Live stream (dev hot-reload): Phoenix + AMMs + Arb joiner
pnpm live             # Stop with Ctrl-C

# 2) Live TL;DR report from the last run (if not auto-run)
pnpm report:live

# 3) Yesterday’s research loop (backtest → report → params)
pnpm daily

# 4) See optimized params to paste into .env (optional)
pnpm params:preview
```

Artifacts land here:

* **Live summaries:** `services/arb-mm/data/live/*.summary.json`
* **Backtest summaries:** `services/arb-mm/data/replay/*.summary.json`
* **Features (ML):** `services/arb-mm/data/features/sol_usdc/v1/<YYYY-MM-DD>.jsonl`
* **Daily report (human):** `services/arb-mm/data/reports/<YYYY-MM-DD>.md`
* **Optimized params (machine):** `services/arb-mm/data/params/<YYYY-MM-DD>.json`

> Tip: If `pnpm report:live` says *No live summary files*, just run it once more — the summary is written on shutdown and your terminal may return before the file scan.

---

## 1) What This System Does (High-level)

We capture cross-venue arbitrage between **Raydium CPMM** and **Phoenix** on Solana.

* **packages/amms** streams AMM midprices (and later price-impact sims).
* **packages/phoenix** streams the Phoenix top-of-book (best bid/ask) and mid.
* **services/arb-mm** joins both feeds, applies decision math (slippage + fees + fixed costs), dedupes, and emits decisions: *would\_trade* / *would\_not\_trade*.
* **Backtester** replays the same logic over logs to produce **features** for ML and **summaries** for research.
* **Daily loop** backtests yesterday, emits a markdown report + optimized parameters for tomorrow.

Everything is **flag-gated**, **lean**, and **incremental**.

---

## 2) Repository Layout

```
code/mev/
├─ packages/
│  ├─ amms/          # Raydium CPMM (Orca/Meteora later)
│  ├─ phoenix/       # Phoenix L2 (BBO, mid)
│  ├─ core/ solana/ storage/   # shared utils & logging
├─ services/
│  └─ arb-mm/        # joiner/decision + backtester + reports
├─ configs/
│  └─ markets.json   # market list (single market enabled by default)
└─ docs/
   └─ wbs.md         # this document
```

Useful logs & data inside `services/arb-mm/data/`:

* `live/` – per-session JSON summary on shutdown
* `replay/` – per-backtest JSON summary
* `features/sol_usdc/v1/` – daily JSONL features (one row per opportunity)
* `reports/` – daily markdown research notes
* `params/` – optimized thresholds/size/slippage from yesterday

---

## 3) Prerequisites

* Node.js 20+
* pnpm 9+
* A Solana RPC (we default to **Helius**; add your API key to `.env`)
* Git, build tools

Install deps the standard way:

```bash
pnpm install
pnpm -r build
```

---

## 4) Configuration (.env)

Create a `.env` at repo root. Minimal example:

```ini
# RPC (Helius recommended)
RPC_URL=https://rpc.helius.xyz/?api-key=YOUR_KEY

# Decision params (fallback defaults if omitted)
TRADE_THRESHOLD_BPS=5
MAX_SLIPPAGE_BPS=1
TRADE_SIZE_BASE=0.1      # base units (e.g., SOL)
PHOENIX_TAKER_FEE_BPS=0
AMM_TAKER_FEE_BPS=0
FIXED_TX_COST_QUOTE=0

# Dedupe & coalescing (optional)
DECISION_DEDUPE_MS=1000
DECISION_BUCKET_MS=250
DECISION_MIN_EDGE_DELTA_BPS=0.25

# Book freshness & synthetic fallback
PHOENIX_BOOK_TTL_MS=5000
ALLOW_SYNTH_TRADES=false

# Markets (single market by default via env). To use configs/markets.json, unset these.
PHOENIX_MARKET=4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg
RAYDIUM_POOL_ID_SOL_USDC=58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2

# Optional: auto-apply last optimized params on boot (does NOT edit your .env)
AUTO_APPLY_PARAMS=false
```

> To stream multiple markets later, comment out `PHOENIX_MARKET` and `RAYDIUM_POOL_ID_*` in `.env` and set `enabled: true` entries in `configs/markets.json`.

---

## 5) Running the System

### Live (dev hot-reload)

```bash
pnpm -r build
pnpm live           # Ctrl-C to stop; a summary JSON is written
pnpm report:live    # if the live script didn’t auto-run it for you
```

You should see:

* `amms_price` (every \~2s)
* `phoenix_l2` + `phoenix_mid` (every \~2s)
* `edge_report` & `would_trade`/`would_not_trade`
* On Ctrl-C: `arb_live_summary_written` and a file in `services/arb-mm/data/live/`

### Dev by service (optional)

```bash
pnpm dev:all
# or individually
pnpm dev:phoenix
pnpm dev:amms
pnpm dev:arb
```

### Daily research loop

```bash
pnpm daily
# runs: backtest (yesterday) → human report → optimized params JSON
```

Open:

* `services/arb-mm/data/reports/<YYYY-MM-DD>.md`
* `services/arb-mm/data/params/<YYYY-MM-DD>.json`

### Backtest arbitrary window

```bash
pnpm backtest -- --from 2025-08-14T00:00:00Z --to 2025-08-15T00:00:00Z
```

Outputs:

* features JSONL → `data/features/sol_usdc/v1/<YYYY-MM-DD>.jsonl`
* summary JSON → `data/replay/<stamp>.summary.json`

---

## 6) What We’ve Built So Far

* ✅ Stable tri-runner: AMMs, Phoenix, Arb joiner.
* ✅ Decision math (gross/net edge, slippage, fees, fixed costs).
* ✅ Dedupe (signature window, per-path delta, time buckets).
* ✅ Live summary on shutdown.
* ✅ Backtester mirrors live; emits features + summary.
* ✅ Daily pipeline → report + optimized params.
* ✅ Auto-apply newest params on boot (flagged).
* ✅ Params preview helper.
* ✅ Quiet shutdown (no pnpm SIGTERM spam on Ctrl-C).

---

## 7) What’s Next (Phased)

**Phase A (Now → +10 days):**

* CPMM price-impact simulator (flag `USE_POOL_IMPACT_SIM`).
* RPC simulate AMM swap (flag `USE_RPC_SIM`).
* Replay/live parity checks.
* Daily report v2: edge distro, EV by path, best/worst minutes.

**Phase B (+10 → +20 days):**

* Accounts & budgets; per-minute notional cap.
* Micro live trades (`LIVE_TRADING=1`, 0.01 SOL) with guards.
* Kill-switch on error burst / negative slippage window.

**Phase C (+20 → +30 days):**

* Nightly parameter optimizer (you already have scaffolding; we’ll expand obj/constraints).
* Tip/prio-fee advisor (bandit) — instrument first, then enable.
* Latency metrics and WS/RPC health pool.
* Add Orca/Meteora and expand to 3–5 markets.

**Beyond (after profitable):**

* Smart sizing, Jito bundles where needed, maker-lite on Phoenix, small dashboard & alerts.

---

## 8) Feature Flags & Env Toggles

| Flag / Env                    | Default | Purpose                                                                    |
| ----------------------------- | ------- | -------------------------------------------------------------------------- |
| `AUTO_APPLY_PARAMS`           | false   | At boot, override threshold/slippage/size from latest `data/params/*.json` |
| `ALLOW_SYNTH_TRADES`          | false   | Allow trades when Phoenix book is synthetic (from mid)                     |
| `PHOENIX_BOOK_TTL_MS`         | 5000    | Max age of Phoenix book before falling back to synthetic mid               |
| `DECISION_DEDUPE_MS`          | 1000    | Suppress repeated decisions within window                                  |
| `DECISION_BUCKET_MS`          | 250     | Time-bucket coalescing                                                     |
| `DECISION_MIN_EDGE_DELTA_BPS` | 0.25    | Ignore tiny edge wiggles per path                                          |
| `USE_POOL_IMPACT_SIM`         | false   | (Planned) Use CPMM impact model for effective AMM price                    |
| `USE_RPC_SIM`                 | false   | (Planned) Use on-chain simulateTransaction for effective price             |
| `LIVE_TRADING`                | 0/false | (Planned) Enable micro size live trades with guards                        |

> Only the first block of flags exists today; the "Planned" ones are introduced with the next sprints.

---

## 9) Operator: How to Read the Outputs

### Live Summary JSON (example fields)

```json
{
  "started_at": "2025-08-15T09:02:36.846Z",
  "stopped_at": "2025-08-15T09:02:48.408Z",
  "considered": 12,
  "would_trade": 12,
  "would_not_trade": 0,
  "pnl_sum": 0.416893,
  "best_edge_bps": 17.6566,
  "worst_edge_bps": 17.6566,
  "threshold_bps": 5,
  "slippage_bps": 1,
  "trade_size_base": 0.1,
  "book_ttl_ms": 5000,
  "decision_dedupe_ms": 1000
}
```

* `considered`: distinct opportunities after dedupe.
* `would_trade`: opportunities passing threshold & EV≥0.
* `pnl_sum`: simulated PnL sum (quote units) for that session.

### Daily Report (markdown)

Top lines summarize:

* Edge distribution, win-rate, EV by path.
* Best/worst 1-minute buckets.
* Parameter snapshot and suggested overrides.

### Features JSONL (for ML)

One JSON per line; includes market, AMM mid, Phoenix bid/ask/mid, bps edges, source tags, decision outputs, etc.

---

## 10) Troubleshooting

* **No live summary found** after `pnpm live`:

  * The summary writes on shutdown; run `pnpm report:live` again, or `ls services/arb-mm/data/live/`.
* **Backtest shows 0 considered**:

  * You likely didn’t stream in that UTC window. Try a window that matches when you were live.
* **SIGTERM messages on Ctrl-C**:

  * We wrapped dev runners; these should be gone. If you see messages, they’re harmless.
* **Helius errors / stalls**:

  * Check `RPC_URL` and network; switch endpoints if needed.

---

## 11) Path to \$2k–\$5k/day (Targets)

* **Per-market**: \~3–8 bps net on \$1–3M/day notional with 50–75% inclusion and controlled tips.
* **3 markets** at \~5 bps avg → \~\$3k/day.
* Requirements: good **slippage prediction**, smart **tip policy**, **low latency**, and **horizontal scale**.

**Scale discipline**

* Increase size only after 3 straight profitable days **and** inclusion > 60% with stable slippage.
* Tip/fees ≤ 30% of gross edge.

---

## 12) Change Control (Agile & Lean)

* One PR = one change; **full drop-in files** provided.
* New behavior off by default (feature flags).
* PR must include: run commands, acceptance checklist, rollback note.
* If touching decision math or logs: prove replay/live parity first.

---

## 13) Glossary

* **Edge (bps)**: relative price advantage between venues.
* **Gross vs Net Edge**: Net subtracts slippage, venue fees, and fixed costs.
* **Inclusion**: probability a submitted transaction lands in the desired slot/block.
* **Tip / prio-fee**: paid to validators/relays to improve inclusion.

---

## 14) Operator Checklists

**Verify live works**

```bash
pnpm -r build
pnpm live               # watch logs for edge_report + would_trade/would_not_trade
ls services/arb-mm/data/live/
pnpm report:live
```

**Do research for yesterday**

```bash
pnpm daily
sed -n '1,80p' services/arb-mm/data/reports/$(date -u -d 'yesterday' +%F).md
cat services/arb-mm/data/params/$(date -u -d 'yesterday' +%F).json
pnpm params:preview
```

**Backtest a custom window**

```bash
pnpm backtest -- --from 2025-08-14T00:00:00Z --to 2025-08-15T00:00:00Z
ls services/arb-mm/data/replay/
```

---

## 15) Roadmap Snapshot

* **Now → +10d**: CPMM impact sim; RPC sim; report v2; parity.
* **+10d → +20d**: Micro live with guards; budgets; kill-switch.
* **+20d → +30d**: Nightly optimizer; tip bandit; latency; 3–5 markets.
* **Post-30d**: Smart sizing; Jito bundles; maker-lite; dashboard.

---

## 16) Granular WBS (Full Gameplan to \$2–5k/day)

> This section is the *project plan*. Each phase has **tasks, file paths, flags, acceptance, commands, and risks**. New behavior is **OFF by default**.

### Phase 0 — Baseline (**✅ Completed**)

**Deliverables**

* Monorepo builds cleanly (`pnpm -r build`).
* `.env` wired into all services (Helius, Pyth, Raydium, Phoenix, decision).
* `raydium.pools.json` for SOL/USDC loaded at AMM boot.
* AMM midprices streaming from pool `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2`.
* Phoenix mid via Pyth synth fallback.
* Arb joiner emits `edge_report`.
* Orchestrator: `pnpm dev:all` stable.
* Logs JSONL & machine-parseable.

**Commands**

```bash
pnpm -r build
pnpm dev:all
```

### Phase 1 — Phoenix L2 Integration (**✅ Completed**)

**Goal**: Replace synth with real Phoenix L2.

**Tasks**

* Use SDK `getUiLadder`.
* Ensure `phoenix_l2_empty` never appears; emit `phoenix_l2` + `phoenix_mid`.

**Acceptance**

* `edge_report` contains `phoenix_source: "book"` and `phoenix_book_method: "sdk:getUiLadder"`.
* Stable > 30 minutes.

### Phase 2 — Decision Layer (Simulation) (**✅ MVP Complete; tuning ongoing**)

**Goal**: Compute EV with slippage/fees/fixed costs; dedupe noise; emit decisions.

**Implemented**

* Env vars: `TRADE_THRESHOLD_BPS`, `MAX_SLIPPAGE_BPS`, `TRADE_SIZE_BASE`, venue fees, fixed cost.
* Net edge & EV calculation; would\_trade / would\_not\_trade with reasons.
* Dedupe windows: signature, per-path edge delta, buckets.

**Acceptance**

* See `would_trade` and `would_not_trade` in live logs.
* Session summary written on Ctrl-C.

**Commands**

```bash
pnpm live
ls services/arb-mm/data/live/
```

### Phase 3 — Replay / Backtest (**✅ Completed**)

**Goal**: Re-run identical logic offline; produce features & summaries.

**Tasks**

* `services/arb-mm/src/replay.ts` reads JSONL logs and mirrors decision logic.
* CLI: `--from ISO` `--to ISO`; default to yesterday (via `pnpm daily`).
* Emit features per opportunity; store summary.

**Acceptance**

* Files under `data/features/.../<YYYY-MM-DD>.jsonl` and `data/replay/*.summary.json`.

**Commands**

```bash
pnpm backtest -- --from <ISO> --to <ISO>
pnpm daily
```

### Phase 4 — Execution Prep (Days 1–4)

**Goal**: Build *simulated* executors and guards.

**Tasks**

1. **CPMM price-impact simulator** (flag `USE_POOL_IMPACT_SIM=false`)

   * Path: `packages/amms/src/reserves.ts` (+ util module).
   * Compute effective AMM price for size `TRADE_SIZE_BASE` from pool reserves.
   * Log additive fields: `amm_eff_px`, `amm_price_impact_bps`.
2. **RPC simulateTransaction** (flag `USE_RPC_SIM=false`)

   * Path: `services/arb-mm/src/executor/sim.ts` (new) + wire in `main.ts`.
   * Build unsigned tx for chosen path; `simulateTransaction` to get `postTokenBalances`.
   * Log `sim_eff_px`, `sim_slippage_bps`, `compute_units`, `prioritization_fee`.
3. **Risk scaffolding (read-only)**

   * Path: `services/arb-mm/src/risk.ts` (new).
   * Implement configs for per-minute notional cap, per-venue cap, error-burst window.
   * Log planned caps (no blocking yet).

**Acceptance**

* Live logs include additive metrics when flags ON.
* Backtest ignores these fields safely (additive-only).

**Commands**

```bash
pnpm -r build
USE_POOL_IMPACT_SIM=true pnpm live
USE_RPC_SIM=true pnpm live
```

**Risks**

* None; flags off by default.

### Phase 5 — Micro Live Execution (Days 5–9)

**Goal**: Send tiny real orders safely.

**Tasks**

1. **Accounts & balances**

   * Path: `packages/solana/src/wallet.ts` (new) + `services/arb-mm/src/accounts.ts`.
   * Load USDC/SOL balances; rent & ATA checks.
2. **Guards**

   * Path: `services/arb-mm/src/risk.ts` (extend).
   * Implement: per-minute notional cap, per-path consecutive failures cap, kill-switch on error burst, TPS-aware throttle.
3. **Submit tiny trades**

   * Flag: `LIVE_TRADING=1` (size from `TRADE_SIZE_BASE` or `LIVE_SIZE_BASE`).
   * Path: `services/arb-mm/src/executor/live.ts` (new).
   * Submit only when simulated EV≥0 and guards pass; log `submitted_tx`, `landed`, `fill_px`.

**Acceptance**

* 3+ landed trades with realized slippage within +/- 1 bps of simulated median.
* No guard violations; kill-switch tested.

**Commands**

```bash
pnpm -r build
LIVE_TRADING=1 pnpm live
pnpm report:live
```

**Risks**

* Real funds; use micro-size and strict caps.

### Phase 6 — Latency & Reliability (Days 10–13)

**Goal**: Lower end-to-end latency, remove stalls.

**Tasks**

* **RPC pool & health**: rotating read endpoints; measure p50/p95 per endpoint.
* **WS persistence**: keep Phoenix/AMM sockets warm; reconnect backoff.
* **Pre-built tx skeletons**: pre-sign where possible; swap in ix data.
* **System tuning**: pin CPU, disable C-states; Node GC flags.

**Acceptance**

* p95 time from tick → decision < 80 ms on target box.
* No feed gaps > 10s during 12h run.

### Phase 7 — Market Expansion (Days 14–16)

**Goal**: Add 2–4 more markets & AMMs.

**Tasks**

* **Orca Whirlpools** and **Meteora** feeds (reuse Raydium schema `amms_price`).
* Expand `configs/markets.json` with `enabled: true` entries.
* Live summary becomes per-market aggregated (additive fields only).

**Acceptance**

* 3+ markets live; backtest can filter by `symbol`.

### Phase 8 — ML & Optimizers (Days 17–22)

**Goal**: Daily param optimizer + tip advisor.

**Tasks**

1. **Threshold/Slippage/Size Optimizer**

   * Path: `services/arb-mm/scripts/optimize_params.ts` (extend).
   * Objective: maximize Σ(EV) with bounds on turnover, variance; write `data/params/<date>.json`.
2. **Auto-apply (already built)**

   * Flag: `AUTO_APPLY_PARAMS=true` uses latest file on boot (no .env edits).
3. **Tip Advisor (instrument → bandit)**

   * Path: `services/arb-mm/src/tips.ts` (new) + additive logs `tip_suggested`.
   * Bandit over discrete tip levels conditioned on edge & mempool pressure.

**Acceptance**

* 3-day A/B shows uplift vs static params.

### Phase 9 — Observability & PnL (Days 23–25)

**Goal**: See everything quickly.

**Tasks**

* Export metrics (CSV/Parquet rollups) from JSONL; histograms for latency & slippage.
* Simple dashboard (Grafana/Redash) reading rollups.
* Alerts: feed stalls, inclusion drop, negative drift.

**Acceptance**

* One dashboard shows opportunities, inclusion %, EV, PnL, latency.

### Phase 10 — Hardening & Soak (Days 26–30)

**Goal**: Stability before scaling size.

**Tasks**

* 48h soak with conservative size; auto-restart on crash; resume clean.
* Post-mortem automation comparing day-over-day summaries; drift checks.

**Acceptance**

* Clean artifact trail; no missing summaries; profits stable.

---

## 17) Timeline (aggressive but realistic)

* **Week 1**: Phases 4–5 (sim + micro live) finished.
* **Week 2**: Phase 6 (latency) + Phase 7 (markets).
* **Week 3**: Phase 8 (optimizers & tips) + Phase 9 (observability).
* **Week 4**: Phase 10 (soak) and scale size cautiously.

---

## 18) RACI / Ownership

* **Owner (you)**: priorities, env, funding, accept/reject.
* **Agent(s)**: implement per WBS; ship drop-in files; provide commands & acceptance.
* **Reviewer**: verify live/backtest parity; check logs and summaries.

---

## 19) Risks & Mitigations

* **RPC instability** → pool & health scoring; failover quickly.
* **Unexpected slippage** → require sim + tight guards; halt on negative drift.
* **Over-tipping** → tip bandit with budget caps; track EV after tips.
* **Schema drift** → additive-only; enforce via `docs/log_contract.md`.

---

## 20) Change Control & Flags (summary)

All new features land **disabled**. Enable one at a time:

```bash
USE_POOL_IMPACT_SIM=true pnpm live
USE_RPC_SIM=true pnpm live
LIVE_TRADING=1 pnpm live
AUTO_APPLY_PARAMS=true pnpm live
```

> If anything regresses: **disable the flag** and open the live/replay summaries for diagnosis.

---

*This document is the ground truth for onboarding, operations, and planning. Keep it lean, additive, and boring to operate — while we make the strategy itself smarter every week.*
