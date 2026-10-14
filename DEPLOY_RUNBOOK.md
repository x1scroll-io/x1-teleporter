# X1 TELEPORTER — DEPLOY RUNBOOK (for the agent)

Deploy target: GitHub repo -> Vercel. RPC: Helius (Secure URL).
Package to deploy: x1teleporter-vercel.tar.gz  (bundle index hash: index-f-yiz82R.js)

================================================================
PHASE 0 — INPUTS (set these once, exact values)
================================================================
HELIUS_SECURE_RPC = https://berty-633y20-fast-mainnet.helius-rpc.com
INTEGRATOR        = x1-teleporter-labs        (already hardcoded; do NOT override)
FEE_WALLET_SVM    = TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu  (already in code)
GIT_REPO          = <your github repo url, e.g. git@github.com:x1scroll-io/x1teleporter.git>

================================================================
PHASE 1 — UNPACK CLEAN (no stale build artifacts)
================================================================
# work in a clean dir
rm -rf x1teleporter && tar -xzf x1teleporter-vercel.tar.gz && cd x1teleporter

# CRITICAL: remove build artifacts that must NOT be committed
rm -rf node_modules dist .vercel

# ensure a .gitignore exists so they never get committed
cat > .gitignore <<'EOF'
node_modules
dist
.vercel
.env
.env.local
*.log
EOF

================================================================
PHASE 2 — VERIFY THE PACKAGE IS THE RIGHT ONE (fail fast if not)
================================================================
# These greps MUST all print a match. If any is empty, STOP — wrong package.
grep -q 'const DEMO_MODE = false'        src/Teleporter.jsx && echo "OK demo_off"   || echo "FAIL demo"
grep -q 'const WARP_LIVE = true'         src/Teleporter.jsx && echo "OK warp_live"  || echo "FAIL warp_live"
grep -q 'const WARP_LIVE_SEND = false'   src/Teleporter.jsx && echo "OK send_gate"  || echo "FAIL send_gate"
grep -q 'VITE_SOLANA_RPC'                src/Teleporter.jsx && echo "OK rpc_env"     || echo "FAIL rpc_env"
grep -q '"x1-teleporter-labs"'           api/_lifi.js       && echo "OK integrator" || echo "FAIL integrator"
grep -q 'evt_out'                        src/warpBridge.js  && echo "OK warp_seed"   || echo "FAIL warp_seed"
grep -q 'getConfigAccountData'           src/warpBridge.js  && echo "OK rpc_fallback"|| echo "FAIL rpc_fallback"

================================================================
PHASE 3 — LOCAL BUILD SANITY (must succeed before pushing)
================================================================
npm install
npm run build
# confirm a real bundle was produced and note the hash
ls dist/assets/index-*.js
# Expected current hash family: index-f-yiz82R.js (or newer if code changed).
# record it; you will verify this EXACT hash is live after deploy.
DEPLOY_HASH=$(ls dist/assets/ | grep -E '^index-[A-Za-z0-9_-]+\.js$' | grep -v browser | head -1)
echo "DEPLOY_HASH=$DEPLOY_HASH"
# clean artifacts again before commit
rm -rf node_modules dist

================================================================
PHASE 4 — PUSH TO GITHUB
================================================================
git init -q 2>/dev/null || true
git add -A
git commit -m "Teleporter: Helius RPC + multi-RPC fallback, seq fix, placeholder removed" -q
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin "$GIT_REPO"
git push -u origin main --force   # force ok if this repo is dedicated to the app

================================================================
PHASE 5 — VERCEL ENV VARS (set BEFORE the deploy builds)
================================================================
# Using Vercel CLI (npm i -g vercel ; vercel login) OR the dashboard.
# Dashboard path: Vercel > Project > Settings > Environment Variables.
# Add for: Production (and Preview if used).

# 1) THE RPC (this is the fix for the 403):
VITE_SOLANA_RPC = https://berty-633y20-fast-mainnet.helius-rpc.com

# 2) LiFi (server-side proxy):
INTEGRATOR      = x1-teleporter-labs
INTEGRATOR_FEE  = 0.005   # fee-model v2: 0.5% (was 1%)
LIFI_API_KEY    = <your LiFi API key from portal.li.fi>     # if your proxy needs it

# 3) Fee wallets (used by withdraw flow; server never signs):
FEE_WALLET_EVM  = 0x0cDb...6D32      # your EVM fee wallet (from LiFi portal)
FEE_WALLET_SVM  = TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu

# IMPORTANT: if an OLD env var named INTEGRATOR=x1scroll-teleporter exists,
# DELETE it. (Code hardcodes the right value now, but delete to avoid confusion.)

# CLI equivalents (optional):
# vercel env add VITE_SOLANA_RPC production   (paste the Helius secure URL)
# vercel env add INTEGRATOR production
# vercel env add INTEGRATOR_FEE production

================================================================
PHASE 6 — DEPLOY
================================================================
# If Vercel is git-connected, the push in Phase 4 already triggered a build.
# Otherwise force a clean production deploy:
vercel --prod --force        # --force = ignore build cache (avoids stale bundle)

================================================================
PHASE 7 — POST-DEPLOY VERIFICATION (do NOT skip)
================================================================
# 7a. Confirm the LIVE bundle hash matches DEPLOY_HASH from Phase 3.
#     Fetch the deployed index.html and grep the script src:
curl -s https://x1teleporter.vercel.app/ | grep -o 'index-[A-Za-z0-9_-]*\.js'
#     -> MUST equal $DEPLOY_HASH. If it shows an OLDER hash, the deploy didn't
#        land / cache served stale. Redeploy with --force and hard-refresh.

# 7b. Confirm the RPC env actually took effect: the 403 on account
#     48Po6q... should be GONE. (Manual: open site, connect wallet, the
#     "failed to get info about account ... 403" error must not appear.)

================================================================
PHASE 8 — GO-LIVE GATES (manual, human-confirmed, IN ORDER)
================================================================
# The app is LIVE for LiFi (EVM<->X1 fee collection) immediately after deploy.
# The Warp SEND is still gated. Do these in order, by a human, with own funds:
#
# 1) Dry-run sim (safe, no funds move). Update simulate.js RPC first if needed:
#      SOLANA_RPC=https://berty-633y20-fast-mainnet.helius-rpc.com \
#      node simulate.js <A_SOLANA_ADDRESS_WITH_25+_USDC>
#    Expect: "SIMULATION PASSED" + BridgeOut log. If "Assertion failed" -> the
#    seq value/semantics need review (capture full program logs, send to Claude).
#
# 2) If sim passes: flip the final gate in src/Teleporter.jsx:
#      const WARP_LIVE_SEND = false;   ->   const WARP_LIVE_SEND = true;
#    Commit, push, redeploy (repeat Phases 4 & 6).
#
# 3) Do ONE real $25 bridge with your OWN wallet end-to-end. Watch USDC.x
#    land on X1. Only after that succeeds, open to users.

================================================================
ROLLBACK
================================================================
# If a deploy is bad: Vercel > Deployments > pick last-good > "Promote to
# Production". Or: git revert HEAD && git push (triggers rebuild).

================================================================
COMMON FAILURE -> FIX
================================================================
# 403 "Access forbidden" on 48Po6q...  -> VITE_SOLANA_RPC not set / wrong.
#                                          Set Helius Secure URL, redeploy.
# "Integrator ... not configured"       -> stale INTEGRATOR env var; delete it.
# Live bundle hash != DEPLOY_HASH       -> stale deploy/cache; vercel --prod --force,
#                                          then hard-refresh (Ctrl+Shift+R).
# Blank page                            -> ensure dist/ and node_modules NOT
#                                          committed; Vercel builds from source.
# "Warp error: Assertion failed"        -> RPC now works but seq semantics off;
#                                          capture program logs, send to Claude.
