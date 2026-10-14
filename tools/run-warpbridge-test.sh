#!/usr/bin/env bash
# OOM-capped run of the warpBridge tests (surgical-change verification).
ulimit -v $((1024*1024*16))
cd /root/.openclaw/workspace/memory/x1-teleporter-v2
exec node --import ./tools/jsx-loader.mjs --test src/warpBridge.test.js
