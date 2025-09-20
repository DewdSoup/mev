# RPC Facade Quick Reference

The arb runner now routes all Solana JSON-RPC traffic through a shared facade with rate control, retry/backoff, and basic metrics. Use the flags below to tune behaviour or fall back when needed.

## Environment Flags

- `RPC_FACADE_LIMITER` (default `0`): set to `1` to enforce the token bucket limiter. Leave `0` if you need raw RPC during debugging.
- `RPC_FACADE_RPS` (default `8`): steady-state requests per second budget when the limiter is enabled.
- `RPC_FACADE_BURST` (default `8`): maximum burst tokens allowed before throttling.
- `RPC_FACADE_DEBOUNCE_MS` (default `5`): delay between queued requests when the limiter is draining.
- `RPC_FACADE_BLOCKHASH_TTL_MS` (default `2500`): cache lifetime for `getLatestBlockhash` responses.
- `RPC_FACADE_BATCH_DELAY_MS` / `RPC_FACADE_BATCH_MAX` (defaults `6ms` / `32`): micro-batching controls for `getMultipleAccountsInfo`.
- `RPC_FACADE_METRICS_MS` (default `30000`): emit `rpc_facade_metrics` logs every N milliseconds. Set `0` to disable periodic metrics.
- `RPC_FACADE_PASSTHROUGH` (default `0`): force the facade to bypass the limiter/backoff wrappers (useful for emergency rollbacks).
- `RPC_SENDER_URL`: optional Sender/Jito endpoint; when set, submissions will log `rpc_facade_sender_path` before falling back to standard RPC.
- `ENABLE_RAYDIUM_CLMM` (default `1`): set to `0` while on the Helius Free tier to skip Raydium CLMM quoting/building, avoiding 401 errors from Raydium's paid API endpoints.
- `ENABLE_MARKET_PROVIDER` (default `0`): when `1`, boots the new in-process `MarketStateProvider` (push + refresh cache). Supporting knobs: `MARKET_PROVIDER_REFRESH_MS`, `MARKET_PROVIDER_PHOENIX_REFRESH_MS`, `MARKET_PROVIDER_STALE_MS`, and `MARKET_PROVIDER_PHOENIX_DEPTH`.

## Warm-up

Both `services/arb-mm/src/main.ts` and `services/arb-mm/src/multipair.ts` call `rpc.warmupAccounts(...)` on boot, prefetching the configured Phoenix markets and AMM pools. To skip warm-up, unset the relevant env values or remove the pool IDs from `configs/pairs.json`.

## Rollback

To restore the legacy behaviour quickly:

1. Set `RPC_FACADE_PASSTHROUGH=1` (or `RPC_FACADE_LIMITER=0`) in your environment.
2. Restart the process – the proxied `Connection` will behave like the raw web3 client, and metrics/limiter logs will cease.

Keep the facade active for soak tests so we can validate 0 rate-limit errors and track limiter queue depth across additional AMMs and pools.
