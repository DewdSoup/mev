#!/usr/bin/env bash
set -euo pipefail

stamp() { date -u +"%Y-%m-%dT%H%M%S%3NZ"; }

LIVE_MODE=${LIVE_MODE:-default}
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
RUNS_ROOT=${RUNS_ROOT:-$REPO_ROOT/data/runs}
RUNS_ROOT=$(python -c 'import os,sys;print(os.path.abspath(sys.argv[1] if len(sys.argv)>1 else "."))' "$RUNS_ROOT")
mkdir -p "$RUNS_ROOT"

DEFAULT_RUN=0
if [ -n "${RUN_ROOT:-}" ]; then
  RUNTIME_ROOT="$RUN_ROOT"
elif [ -n "${SINGLE_RUNTIME_DIR:-}" ]; then
  RUNTIME_ROOT="$SINGLE_RUNTIME_DIR"
else
  DEFAULT_RUN=1
  RUN_ID=${RUN_ID:-$(stamp)}
  RUNTIME_ROOT="$RUNS_ROOT/$RUN_ID"
fi

# Normalize to absolute paths so downstream processes never write to '/...'
RUNTIME_ROOT=$(python -c 'import os,sys;print(os.path.abspath(sys.argv[1] if len(sys.argv)>1 else "."))' "$RUNTIME_ROOT")
RUN_ROOT="$RUNTIME_ROOT"
SINGLE_RUNTIME_DIR="$RUNTIME_ROOT"
export RUN_ROOT
export SINGLE_RUNTIME_DIR
export RUNTIME_ROOT

if [ -z "${TELEMETRY_DIR:-}" ]; then
  TELEMETRY_DIR="$RUNTIME_ROOT/telemetry"
fi
export TELEMETRY_DIR

PATH_PAIRS_LOG=${PATH_PAIRS_LOG:-$RUNTIME_ROOT/path-pairs.log}
export PATH_PAIRS_LOG

RUN_ID=${RUN_ID:-$(basename "$RUNTIME_ROOT")}
mkdir -p "$RUNTIME_ROOT"
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

log_note() {
  local msg="$1"
  printf '[live%s] %s\n' "${LIVE_MODE:+:$LIVE_MODE}" "$msg"
}

if [ "$DEFAULT_RUN" -eq 1 ]; then
  if [ "${ARCHIVE_LEGACY_LOGS:-1}" != "0" ] && [ -d "$REPO_ROOT/data/logs" ]; then
    LEGACY_LOGS="$RUNS_ROOT/legacy-logs-$(stamp)"
    mv "$REPO_ROOT/data/logs" "$LEGACY_LOGS"
    log_note "archived existing data/logs to $LEGACY_LOGS"
  fi

  if [ "${RUNTIME_LINKS:-0}" != "0" ]; then
    ln -sfn "$RUNTIME_ROOT" "$RUNS_ROOT/latest"
    ln -sfn "$RUNTIME_ROOT" "$REPO_ROOT/data/runtime"
  else
    [ -L "$RUNS_ROOT/latest" ] && rm -f "$RUNS_ROOT/latest"
    [ -L "$REPO_ROOT/data/runtime" ] && rm -f "$REPO_ROOT/data/runtime"
  fi

  if [ -d "$REPO_ROOT/data/runtime" ] && [ ! -L "$REPO_ROOT/data/runtime" ]; then
    LEGACY_RUNTIME="$RUNS_ROOT/legacy-runtime-$(stamp)"
    mv "$REPO_ROOT/data/runtime" "$LEGACY_RUNTIME"
    log_note "archived previous data/runtime to $LEGACY_RUNTIME"
  fi
  if [ -d "$RUNS_ROOT/latest" ] && [ ! -L "$RUNS_ROOT/latest" ]; then
    LEGACY_LATEST="$RUNS_ROOT/legacy-latest-$(stamp)"
    mv "$RUNS_ROOT/latest" "$LEGACY_LATEST"
    log_note "archived previous runs/latest to $LEGACY_LATEST"
  fi
fi

CMD_STRING=${RUN_CMD:-}
if [ -z "$CMD_STRING" ]; then
  if [ "${ENABLE_MARKET_PROVIDER:-0}" = "1" ]; then
    CMD_STRING="pnpm --filter @mev/arb-mm dev"
  else
    CMD_STRING="pnpm dev:all"
  fi
fi

RUN_SOURCE="pnpm live"
if [ "$LIVE_MODE" != "default" ]; then
  RUN_SOURCE="${RUN_SOURCE}:$LIVE_MODE"
fi

GIT_COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
if git -C "$REPO_ROOT" status --short >/dev/null 2>&1 && git -C "$REPO_ROOT" status --short | grep -q .; then
  DIRTY=true
else
  DIRTY=false
fi

RUN_META="$RUNTIME_ROOT/run.json"
cat >"$RUN_META" <<JSON
{
  "run_id": "$RUN_ID",
  "started_at": "$STARTED_AT",
  "source": "$RUN_SOURCE",
  "command": "$CMD_STRING",
  "git_commit": "$GIT_COMMIT",
  "git_dirty": $DIRTY,
  "runs_root": "$RUNS_ROOT"
}
JSON

export RUN_ID
export RUNS_ROOT
export RUN_ROOT="$RUNTIME_ROOT"
export RUN_ROOT_SINGLE=1

for var in DATA_DIR ARB_DATA_DIR ARB_REPORTS_DIR ARB_REPORTS_LIVE_DIR ARB_LIVE_DIR ARB_FEATURES_DIR ARB_PARAMS_DIR ARB_REPLAY_DIR ARB_ML_DIR SESSION_LOGS_DIR AMMS_DATA_DIR; do
  export "$var=$RUNTIME_ROOT"
done

export EDGE_AMMS_JSONL="$RUNTIME_ROOT/amms-feed.jsonl"
export EDGE_PHOENIX_JSONL="$RUNTIME_ROOT/phoenix-feed.jsonl"
export LOG_FILE="$RUNTIME_ROOT/arb-runtime.jsonl"
export ML_EVENTS_FILE="$RUNTIME_ROOT/ml-events.jsonl"
export SHADOW_TRADING=0
export LIVE_TRADING=1
export FORCE_COLOR=${FORCE_COLOR:-1}
if [ "$LIVE_MODE" = "jito" ]; then
  export SUBMIT_MODE=jito
fi

RUNTIME_LOG="$RUNTIME_ROOT/arb-runtime.log"
log_note "run directory: $RUNTIME_ROOT"
log_note "log file: $RUNTIME_LOG"
log_note "command: $CMD_STRING"

stdbuf -oL -eL bash -lc "$CMD_STRING" 2>&1 | tee "$RUNTIME_LOG"
exit ${PIPESTATUS[0]}
