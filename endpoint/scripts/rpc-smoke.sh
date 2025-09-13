#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://127.0.0.1:8899}"
REQ='{"jsonrpc":"2.0","id":1,"method":"getVersion"}'
curl -sS -H 'Content-Type: application/json' -d "$REQ" "$URL" | jq .
