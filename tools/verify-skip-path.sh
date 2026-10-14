#!/usr/bin/env bash
# Prove the apiKeyLeak skip path: with dist/ absent, the bundle scan must
# report SKIPPED (2 pass, 1 skipped) — never build, never fail.
set -u
cd "$(dirname "$0")/.."

if [ -d dist ]; then
  mv dist dist.hidden
  echo "dist/ moved aside for skip-path check"
fi

ulimit -v $((1024*1024*16)); node --import ./tools/jsx-loader.mjs --test src/lib/thorchain/apiKeyLeak.test.js 2>&1 | grep -E "^# (tests|pass|fail|skipped)|not ok|skipping the bundle scan" || true

if [ -d dist.hidden ]; then
  mv dist.hidden dist
  echo "dist/ restored"
fi
