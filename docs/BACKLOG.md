
## Teleporter v2 backlog (entries 3-4)

3. **Tron adapter dependency delta (+33 advisories via tronweb→ethers→ws)** — decision deferred to the BridgeCard mount step; intended resolution is **lazy-loading the Tron adapter module only when the Tron family is opened** — isolates the dependency tree and keeps the bundle small.

4. **THORNode/Liquify hosts do not resolve from the build box's DNS** (getaddrinfo ENOTFOUND on thornode/liquify; other hosts fine) — if the box's resolver can't see Liquify's gateways, a watcher cron run there can't poll them either. Strengthens the case for the THORChain watcher living on Vercel (serverless), per the one-sign follow-on.

5. **All non-main previews arm live-send by default** — ✅ RESOLVED (PR #31, branch `fix/arming-allowlist`): arming is now allowlist-gated. `WARP_ARMED_BRANCHES = new Set(["v2"])` in vite.config.js — ONLY the hop-test branch `v2` compiles `WARP_LIVE_SEND:true`; `main`, every other branch, and no-ref local builds all compile `false`. Adding a branch to the allowlist is an explicit maintainer decision (deliberate arming), so a random future branch preview can no longer silently send real money.
