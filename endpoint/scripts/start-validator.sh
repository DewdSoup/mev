#!/usr/bin/env bash
set -euo pipefail
umask 077
ulimit -n 1000000 || true

LOG="$HOME/endpoint/logs/validator.log"
mkdir -p "$(dirname "$LOG")"

BIN="$(command -v agave-validator || command -v solana-validator)"

# External IP (GCE metadata if present, otherwise ipify)
PUBIP="$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip \
  || curl -sf https://api.ipify.org || echo 0.0.0.0)"

exec "$BIN" \
  --identity "$HOME/endpoint/config/keys/validator-keypair.json" \
  --no-voting \
  --ledger "$HOME/endpoint/data/ledger" \
  --accounts "$HOME/endpoint/data/accounts" \
  --snapshots "$HOME/endpoint/data/snapshots" \
  --gossip-host "$PUBIP" \
  --gossip-port 8001 \
  --dynamic-port-range 8002-8020 \
  --entrypoint entrypoint.mainnet-beta.solana.com:8001 \
  --entrypoint entrypoint2.mainnet-beta.solana.com:8001 \
  --entrypoint entrypoint3.mainnet-beta.solana.com:8001 \
  --expected-genesis-hash 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d \
  --rpc-bind-address 127.0.0.1 \
  --rpc-port 8899 \
  --private-rpc \
  --full-rpc-api \
  >>"$LOG" 2>&1
