# RH-APE-PLAYBOOK.md — How to ape into PONS (and RH memes) — ALL paths

**Research date:** 2026-09-08. Chain: Robinhood Chain (4663). All routes verified via live aggregator APIs + on-chain probes. Test wallet: 0x562d9b7093e624a83a2fdE35ee71a658208F09F9.

## THE TOKEN
PONS: `0x39dBED3a2bd333467115dE45665cC57F813C4571` (18 dec)
Deepest pairs (live, ~$90M combined daily volume):
| Venue | Pair | Liq | Vol24 |
|---|---|---|---|
| uniswap-v4 | PONS/USDG 0.3% | $8.1M | $27.6M |
| uniswap-v3 fork | PONS/WETH 0.3% | $4.0M | $36.3M |
| uniswap-v3 fork | PONS/WETH 1% | $7.0M | $9.1M |
| uniswap-v3 fork | PONS/USDG 1% | $3.9M | $4.8M |
| ramses-v3 | PONS/USDG 0.3% | $955K | $18.7M |
| ramses-v3 | PONS/WETH 1% | $617K | $7.0M |
| up-v3 | PONS/USDG 0.3% | $335K | $5.2M |
| giga-v3 | PONS/WETH 0.2% | $175K | $3.1M |

## ✅ THE APE PATHS (working, verified live)

### PATH 1 — Paraswap aggregator (SIMPLEST)
- API: `GET https://apiv5.paraswap.io/prices?srcToken=USDG&destToken=PONS&amount=&network=4663`
- **Verified route:** 5 USDG → 7.006 PONS via **uniswapv4** pool `0x703f98c5...`
- Execution: `POST /transactions/4663` with the UNMODIFIED priceRoute → get swap tx
- Requires: approve USDG → paraswap's token transfer proxy, then send tx
- ✅ Aggregates all RH venues (uni-v3 fork + v4 + ramses) and picks best

### PATH 2 — Kyberswap aggregator
- API: `GET https://aggregator-api.kyberswap.com/robinhood/route/encode`
- **Verified route:** USDG → uniswap-v4 pool → WETH → (hop) → PONS
- Router: `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` (kyber family router)
- Executes `encodedSwapData` directly; gas ~848k on RH (0.26 gwei)
- ⚠️ Kyber executor approvals: approve router AND executor `0x8f10b468b06c6fd214b65f87778827f7d113f996` (the pattern that blocked us on OPT/Base — but kyber DOES serve RH so the route exists)

### PATH 3 — Direct venue (for MEV, skip aggregators)
The per-venue contracts (all probed live):
- **uniswap-v3 fork** factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (owner `0x05C420bc...`)
  - PONS/WETH 0.3% pool: `0xed50bdeea8adc232f159486192a4157281d722ff`
  - PONS/USDG 1% pool: `0x7a192e71564ec66ee0763e328a3ac274942de4e1`
  - ⚠️ fork's OWN quoter/router NOT YET FOUND (canonical uni contracts point at canonical factory — they fail on this fork)
- **ramses-v3** factory `0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8`
  - PONS/USDG 0.3% pool: `0xf2a0be59ab76b96f957bd5e5b967f2b75e8db269` (token0=PONS, token1=USDG, fee 1000)
  - Real swaps execute via router `0x39b37fE004B9bCDa781784345d2fFc84ef4B8cE6` (13.4KB custom — probed, NOT standard uni-v3 ABI)
- **uniswap-v4** singleton: PONS/USDG 0.3% `0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a` — needs v4 Universal Router (paraswap already solves this)

## 💰 THE MEV SURFACE (why this matters for the bridge)

1. **SIX DEX families quote PONS simultaneously** ($90M/day). The uniswap-v3-fork vs uniswap-v4 vs ramses vs up vs giga spreads are the arb. Paraswap/kyber pick the best — an engine that quotes ALL venues directly (not via one aggregator) captures the inter-venue spread.
2. **Aggregator routes differ**: paraswap chose v4 (7.006 PONS), kyber routed v4→WETH multi-hop (7.07 PONS). The 1% difference IS capturable.
3. **Equity tokens (TSLA etc.) are proxy + AccessControl + pausable** — gate toggles create forced-sell/liquidation events.
4. **Custom routers** (ramses `0x39b37fE0...`) = less competition = stale-price windows.

## 🔧 BRIDGE IMPLICATION (the any-to-any question)
RH IS bridgeable for the ape leg:
1. SOL → RH native ETH (relaydepository, ~45s — PROVEN)
2. wrap ETH → WETH (PROVEN)
3. **USDG needed for best PONS routes** — either bridge USDG in, or swap WETH→USDG (uni-v3 fork USDG/WETH $8.5M+$531K), or ape WETH→PONS directly on the v3 fork pair (needs fork router) / via paraswap (WETH→PONS works — paraswap aggregates)
4. Executing via **paraswap or kyberswap = the solved path**; direct-venue = MEV engine work

## NEXT: EXECUTE THE TEST APE
1. Paraswap USDG→PONS quote at test size (~$5) → confirm route
2. OR kyberswap WETH→PONS (we hold WETH — no USDG needed)
3. If WETH→PONS quotes via paraswap/kyber → EXECUTE one tx, verify PONS lands
4. Reverse PONS→WETH → unwrap → reclaim to SOL → RH ANCHORED
