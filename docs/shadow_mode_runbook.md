# Shadow Mode Runbook

## Environment toggles
- Shadow: set `LIVE_TRADING=0` and `SHADOW_TRADING=1` in `.env.live`; flip to `LIVE_TRADING=1`/`SHADOW_TRADING=0` for production rehearsals.
- Keep `EXEC_ALLOWED_PATH=both` (default) so the router still evaluates PHX↔AMM edges while blocking submits.
- Optional knobs for feed health:
  - `ORCA_FORCE_POLL_MS` (default 4500 ms) – waits this long after the last CLMM websocket tick before forcing an HTTP poll.
  - `AMM_SLOT_MAX_LAG` (default 12) – permitted slot gap between the network clock and an AMM snapshot before the provider considers it stale.
  - `AMM_SLOT_GAP_STRIKES` (default 3) – number of consecutive slot-gap breaches before the provider declares a pool degraded.

## Start / stop procedure
1. `pnpm --filter @mev/arb-mm dev`
2. Watch the boot banner: `LIVE_TRADING=0  SHADOW_TRADING=1` confirms the mode, and limiter settings should match `.env.live`.
3. Wait for `market_provider_tracking` followed by `market_provider_warmup` and `phoenix_client_seeded`; once `would_trade` lines appear the shadow soak is live.
4. Stop with `Ctrl+C`; logs are written under `data/runs/<timestamp>/`.

## Healthy log signatures
- `clmm_quote_snapshot_only_block` spam confirms CLMM quotes remain snapshot-only.
- `orca_force_poll` should be infrequent (≥4.5 s apart) and now includes a `slot` hint; errors on this channel should stay at zero.
- `market_provider_telemetry` should report `rateLimited:0` and avoid long runs of `degradedPools`.
- No `submit_success`, `submit_error`, or `arb_shutdown` entries should appear during shadow soaks.

## What to watch for
- Persistent `degradedPools` with `slot_gap` after the strike limit indicates the websocket fell behind; bump `ORCA_FORCE_POLL_MS` or investigate the upstream RPC.
- Any `orca_force_poll_error` or `market_provider_amm_batch_error` means the fallback HTTP path is unhappy and needs attention before the next soak.
- If the boot banner shows `LIVE_TRADING=1` unintentionally, re-run after correcting `.env.live`.

## Smoke-test sketch
- Future CI hook: spawn `pnpm --filter @mev/arb-mm dev -- --shadow-smoke` (not yet implemented) that boots, waits for a single `would_trade` in shadow mode, and exits.
- Manual alternative today: start the dev process, confirm the boot banner and one `would_trade`, then exit.
