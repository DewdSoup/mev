# Staging Playbook

This guide walks through preparing a staging environment, replaying captured runs, and validating multi-hop behaviour before enabling live execution.

---

## 1. Prepare a staging env file

1. Either reference the template directly or create a copy:
   - Quick start (no file copy): `pnpm exec dotenv -e configs/staging.env -- pnpm live`
   - Customised flow: `cp configs/staging.env .env.staging`
2. If you create your own copy, update any secrets you care about:
   - RPC variables default to the public mainnet endpoint—replace them only if you have a dedicated staging key.
   - `KEYPAIR_PATH` can stay empty while `LIVE_TRADING=0`; provide a throw-away wallet only when you intend to send real transactions.
   - Optional `JITO_KEYPAIR_PATH` is available for bundle testing.
3. Leave `LIVE_TRADING=0` and `ENABLE_MULTI_HOP_EXEC=0` while testing. Multi-hop enumeration stays enabled via `ENABLE_MULTI_HOP_ROUTES=1`.
4. `RUNS_ROOT` already points at `./data/runs/staging`; each run will spawn its own timestamped folder (logs + telemetry).

---

## 2. Pre-flight validation

Run the staging check from the arb-mm workspace. It compiles, runs vitest, and replays the latest run artifacts.

```bash
pnpm --filter @mev/arb-mm run staging:check
```

You can supply a specific run directory to the replay step if needed:

```bash
pnpm --filter @mev/arb-mm run staging:replay -- --run data/runs/2025-10-29T002138791Z
```

The replay script emits a JSON summary with:
- Time window covered by the run.
- Path counts and top net edge per path.
- Rejection / skip reasons.
- Candidate stats sourced from `data/telemetry/candidate-stats.jsonl`.

Save these summaries alongside staging sign-off notes.

---

## 3. Launch a staging session

Once the checks pass:

```bash
pnpm exec dotenv -e .env.staging -- pnpm live
```

Key points:
- Keep `LIVE_TRADING=0` so no real trades are sent.
- Logs and telemetry land inside the timestamped run directory under `data/runs/staging/`.
- `path-pairs.log` plus `arb-runtime.jsonl` capture the multi-hop decisions for later replay.

Stop the session with `Ctrl+C` and re-run the replay script to document the outcome.

---

## 4. Promotion checklist

Before enabling `ENABLE_MULTI_HOP_EXEC=1` in staging or production:

1. Ensure recent replays show healthy path coverage (`AMM->PHX`, `AMM->PHX->AMM`, etc.).
2. Verify skip reasons are expected (e.g., negative edges during staging).
3. Confirm telemetry files continue to record candidate stats.
4. Update `docs/roadmap-status.md` with the new run ID and outcomes.

Only after this checklist is green should you consider toggling execution flags or pointing `.env.live` at the staging configuration.
