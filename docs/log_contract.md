# Log / ML Contract

Authoritative reference for the JSON shapes emitted by this repo.
- All timestamps `ts` are **milliseconds since epoch (UTC)**.
- Prices:
  - Numeric fields like `px`, `best_bid`, `best_ask`, `phoenix_mid` are **numbers** rounded to **6 dp**.
  - `*_str` fields mirror the same value as **strings** rounded to **9 dp** for lossless logging.
- Adding new fields is allowed; consumers must ignore unknown fields. Renames or type changes are breaking.

---

## 1) AMMs stream (Raydium CPMM)

**Event:** `amms_price` (emitted by `packages/amms`)

```json
{
  "event": "amms_price",
  "ts": 0,
  "symbol": "SOL/USDC",
  "ammId": "58oQ...",
  "baseDecimals": 9,
  "quoteDecimals": 6,
  "px": 197.123456,
  "px_str": "197.123456789",
  "base_int": "61406439627230",
  "quote_int": "12111064516142",
  "tick_ms": 2000
}
