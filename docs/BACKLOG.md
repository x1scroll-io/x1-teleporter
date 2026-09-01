
## Teleporter v2 backlog (entries 3-4)

3. **Tron adapter dependency delta (+33 advisories via tronweb→ethers→ws)** — decision deferred to the BridgeCard mount step; intended resolution is **lazy-loading the Tron adapter module only when the Tron family is opened** — isolates the dependency tree and keeps the bundle small.

4. **THORNode/Liquify hosts do not resolve from the build box's DNS** (getaddrinfo ENOTFOUND on thornode/liquify; other hosts fine) — if the box's resolver can't see Liquify's gateways, a watcher cron run there can't poll them either. Strengthens the case for the THORChain watcher living on Vercel (serverless), per the one-sign follow-on.

5. **All non-main previews arm live-send by default** — the `VERCEL_GIT_COMMIT_REF !== "main" → WARP_LIVE_SEND=true` rule (vite.config.js define) is a hop-test convenience: every branch preview compiles the live-send gate armed. That is fine for hop testing on `v2`, but revisit before this becomes permanent — a random future branch preview must not be able to silently send real money. Re-scope to an explicit allowlist of armed branches (or a dedicated env toggle) before production permanence.
