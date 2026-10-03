#!/usr/bin/env bash
# Capped test runner — OOM guardrail wrapper (16GB virtual memory cap).
# Usage: scripts/capped-test.sh [test files...]
set -e
cd /root/.openclaw/workspace/memory/x1-teleporter-v2
ulimit -v $((1024*1024*16))
exec node --import ./tools/jsx-loader.mjs --test "$@"
