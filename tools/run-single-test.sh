#!/usr/bin/env bash
# Run a single test file (or list) under the OOM cap — convenience wrapper.
set -e
cd /root/.openclaw/workspace/memory/x1-teleporter-v2
ulimit -v $((1024*1024*16))
exec node --import ./tools/jsx-loader.mjs --test "$@"
