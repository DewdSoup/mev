CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  strategy TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  size NUMERIC NOT NULL,
  ev_bps NUMERIC NOT NULL,
  realized_bps NUMERIC,
  tip_lamports BIGINT,
  priority_fee_lamports BIGINT,
  status TEXT NOT NULL,
  reason TEXT,
  sigs TEXT[],
  details JSONB
);

CREATE TABLE IF NOT EXISTS misses (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  strategy TEXT NOT NULL,
  market TEXT NOT NULL,
  reason TEXT NOT NULL,
  model_ev_bps NUMERIC,
  tip_lamports BIGINT,
  ctx JSONB
);
