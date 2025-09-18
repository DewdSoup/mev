#!/usr/bin/env bash
set -u
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PHX_DIR="$ROOT/data/phoenix"
LIVE_DIR="$ROOT/data/arb/live"

PHX_LAST=$(ls -1t "$PHX_DIR"/runtime*.jsonl 2>/dev/null | head -1 || true)
LAST_EVENTS=$(ls -1t "$LIVE_DIR"/arb-events-*.jsonl 2>/dev/null | head -1 || true)

echo "== WS STATUS =="
if [[ -n "${PHX_LAST}" ]]; then
  tail -n 200 "$PHX_LAST" 2>/dev/null \
    | egrep 'phoenix_ws_attach|phoenix_ws_unavailable|sdk:getUiLadder' \
    | tail -n 5 || echo "no WS markers yet"
else
  echo "no phoenix log yet"
fi

if [[ -n "${LAST_EVENTS}" ]]; then
  echo "== EV SNAPSHOT (last would_not_trade) =="
  awk '/"would_not_trade"/{line=$0} END{print line}' "$LAST_EVENTS" \
    | egrep -o '"edge_bps_net":-?[0-9.]+|"amm_price_impact_bps":-?[0-9.]+|"fees_bps":\{[^}]+\}' \
    || echo "no would_not_trade yet"

  echo "== TX STATUS =="
  egrep -E 'submitted_tx|landed|submit_error|land_error' "$LAST_EVENTS" | tail -n 3 || echo "no tx yet"

  echo "== AMM IMPACT AVG (last 200 lines) =="
  tail -n 200 "$LAST_EVENTS" \
    | grep -o '"amm_price_impact_bps":[^,]*' \
    | awk -F: '{s+=$2;c++} END{if(c) printf "avg_amm_impact_bps=%.3f over %d\n", s/c, c; else print "no data"}'
else
  echo "no events yet"
fi
