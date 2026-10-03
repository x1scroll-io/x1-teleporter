#!/usr/bin/env bash
# OOM-guardrail test runner — every test command MUST be wrapped in a 16GB
# vmem cap (ulimit -v) per the Step 3.3 ground rules. Usage:
#   ./tools/run-capped-test.sh <file...>
set -u
ulimit -v $((1024 * 1024 * 16)) || { echo "ulimit failed"; exit 1; }
cd /root/.openclaw/workspace/memory/x1-teleporter-v2 || exit 1
exec node --import ./tools/jsx-loader.mjs --test "$@"
