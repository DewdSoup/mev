# CPMM Quote Helpers

These helpers back every Raydium CPMM snapshot quote in the joiner, size optimiser, and Orca fallbacks.

We assume constant-product reserves `x` (base) and `y` (quote) with taker fee `f` (in decimal form) applied to the input leg.

- **Buy (want base)**: remove `Δx` from reserves, solve `k = x · y = (x - Δx) · (y + Δy)` and pay `Δy_raw = y·Δx / (x - Δx)`. The user must gross this up by `(1 - f)` to cover fees, so `Δy = Δy_raw / (1 - f)`. The average quote per base is `Δy / Δx`.
- **Sell (provide base)**: the pool receives `Δx_raw = Δx · (1 - f)` and the user withdraws quote `Δy = y·Δx_raw / (x + Δx_raw)`. The average quote per base received is `Δy / Δx`.

Guards in `services/arb-mm/src/util/cpmm.ts` reject trades that drain ≥ 99.9999 % of the pool or produce non-finite results, keeping the helpers conservative.

Any future CPMM integration should import `cpmmBuyQuotePerBase` / `cpmmSellQuotePerBase` from `../util/cpmm.js` to avoid diverging math.
