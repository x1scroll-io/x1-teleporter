#!/usr/bin/env bash
# Local verification for the two CI-failure fixes (THORChainProgress + apiKeyLeak).
# Every test run is capped at 16GB virtual memory (OOM guardrail).
set -u
cd "$(dirname "$0")/.."

echo "=== THORChainProgress.test.jsx (pass/fail counts) ==="
ulimit -v $((1024*1024*16)); node --import ./tools/jsx-loader.mjs --test src/lib/thorchain/THORChainProgress.test.jsx 2>&1 | grep -E "^# (tests|pass|fail)"

echo ""
echo "=== apiKeyLeak.test.js x5 ==="
for i in 1 2 3 4 5; do
  echo "--- run $i ---"
  ulimit -v $((1024*1024*16)); node --import ./tools/jsx-loader.mjs --test src/lib/thorchain/apiKeyLeak.test.js 2>&1 | grep -E "^# (tests|pass|fail|skipped)|not ok" || true
done
