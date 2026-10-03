#!/usr/bin/env bash
# OOM-capped FULL test suite for x1-teleporter v2 (canonical npm test file list).
ulimit -v $((1024*1024*16))
cd /root/.openclaw/workspace/memory/x1-teleporter-v2
exec node --import ./tools/jsx-loader.mjs --test \
  src/lib/flags.test.ts src/lib/routes.test.ts src/lib/fees.test.ts \
  src/lib/teleportQuote.test.js src/lib/reverseQuote.test.js src/lib/lifiQuote.test.js \
  src/lib/lifiApproval.test.js src/lib/simulateTx.test.js src/lib/cors.test.js \
  src/warpBridge.test.js src/lib/wallet/walletReducer.test.js \
  src/lib/wallet/WalletContext.test.jsx src/lib/wallet/evmDiscovery.test.js \
  src/lib/wallet/solanaDiscovery.test.js src/lib/wallet/bitcoinDiscovery.test.js \
  src/lib/wallet/bitcoinBalance.test.js src/lib/wallet/bitcoinProvider.test.js \
  src/lib/wallet/laserEyesHandle.test.js src/lib/wallet/litecoinDiscovery.test.js \
  src/lib/wallet/dogecoinDiscovery.test.js src/lib/wallet/xrpDiscovery.test.js \
  src/lib/wallet/tronDiscovery.test.js src/lib/wallet/altcoinBalance.test.js \
  src/lib/wallet/xrpBalance.test.js src/lib/wallet/tronBalance.test.js \
  src/lib/wallet/memoRule.test.js src/lib/wallet/modalLogic.test.js \
  src/lib/wallet/walletDiscovery.test.js src/lib/wallet/noWindowProbe.test.js \
  src/lib/wallet/sessionProviders.test.js src/lib/wallet/TeleportTab.test.jsx \
  src/lib/wallet/ConnectModal.test.jsx src/lib/thorchain/statusEndpoint.test.js \
  src/lib/thorchain/pollStatus.test.js src/lib/thorchain/landingDetection.test.js \
  src/lib/thorchain/storage.test.js src/lib/thorchain/autoAdvance.test.js \
  src/lib/thorchain/solBalance.test.js src/lib/thorchain/gate.test.js \
  src/lib/thorchain/THORChainProgress.test.jsx src/lib/thorchain/THORChainTab.test.jsx \
  src/lib/thorchain/memo.test.js src/lib/thorchain/inboundAddresses.test.js \
  src/lib/thorchain/quote.test.js src/lib/thorchain/quoteProxy.test.js \
  src/lib/thorchain/apiKeyLeak.test.js src/lib/thorchain/THORChainDeposit.test.jsx
