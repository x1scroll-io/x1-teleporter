# Production identity — what is actually deployed

**Determined:** 2026-09-13 (autonomous run, owner asleep) · **Status:** RESOLVED with one open trace item

## The finding

| Thing | Fact |
|---|---|
| Live production app | **Classic stablecoin app** — bundle `index-D20fEYRk.js`, 239,614 B. Contains `Minted on X1` + `x1-teleporter-labs`; contains **no** `THORChain`. |
| Vercel project linked to this directory | `x1teleporter` (`prj_krjh0IfSHpmZNzOQ8iQUpOgFsRkD`, org `team_QKuVbqRoikLBGK3MTLRN8snM`) — per `.vercel/repo.json` |
| This repo's `main` | `b4548c8`, **2026-07-03** — classic tree (`src/Teleporter.jsx`). Builds clean; classic bundle (239.37 kB, contains `Minted on X1`, no `THORChain`). |
| V2 head | `41464c9`, 2026-09-08, branch `feat/meme-discovery` — the console (Teleport · THORChain · Buy + 8 wallet connects) |
| Tags | **none** (0) |
| Deployed sha | **Not directly readable** — `vercel` CLI v54 has no credentials (XDG auth store is empty). Live bundle hash differs from `main`'s build, so live is built from a *neighbouring* classic commit or with different env. |

## What this means

1. **The V2 head is not deployed anywhere reachable.** All V2 work lives on branches (`v2`, `feat/*`, 161 total); nothing has been merged to `main` since July.
2. **The console that exists in the repo is unreleased.** Live users get the stables-only app.
3. `DEPLOY_RUNBOOK.md` is **stale**: it describes a tarball deploy (`x1teleporter-vercel.tar.gz`, expected bundle `index-f-yiz82R.js`) pointing at repo `x1scroll-io/x1teleporter` — neither matches the live bundle.

## The rule (removes the "is prod the old version?" confusion)

- **`main` is production.** Production is built from `main` only.
- **V2 promotes by merging into `main`**, after it runs and its acceptance pass is green. Branch heads are never production.
- `WARP_LIVE_SEND` / `MEV_CAPTURE_ENABLED` stay armed **only** on branch `v2` (vite.config.js allowlist). Merge to `main` without an explicit maintainer act ⇒ live sends compile **false**. This is intentional and must not be "fixed".

## Open trace item (needs owner or Vercel access)

Pin the **exact** deployed sha for the current live bundle. Method options:
1. `vercel inspect https://x1teleporter.com` from an authenticated CLI/CWD linked to `x1teleporter`.
2. Vercel dashboard → Deployments → production → "Source" commit.
3. Redeploy a known commit and record the resulting bundle hash.

Until then: treat `main` as the production *branch*, and treat the current live bundle as "classic lineage, sha unpinned".
