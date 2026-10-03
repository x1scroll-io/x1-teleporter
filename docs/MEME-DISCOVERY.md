# MEME-DISCOVERY — the self-discovering candidate feed

**Module:** `src/lib/mev/memeDiscovery.js` (pure-ish; fetch injected)
**Tool:** `tools/mev-discover-sweep.mjs` (the discover-driven sweep)
**Frame:** docs/APE-UNIVERSE.md · **Capture engine:** docs/MEV-CAPTURE-ENGINE.md

The discovery pipeline finds tokens trading on **≥2 liquid venues** (the
capture precondition) from **free, keyless, live** APIs. No pump.fun, no
Helius DAS required, no static mint list to go stale.

## The APIs (both verified live, keyless)

### GeckoTerminal (seed — dynamic, real liquidity only)
- `GET https://api.geckoterminal.com/api/v2/networks/{network}/trending_pools?include=base_token&page=1`
  - network slugs: `solana`, `eth`, `base`, `bsc`, `polygon` (the
    DISCOVERY_CHAINS registry maps canonical keys → slugs).
  - one response page = 20 pools; each pool carries
    `attributes.reserve_in_usd` (≈ pool liquidity),
    `attributes.volume_usd.h24`, and `relationships.base_token.data.id`
    (`"solana_<mint>"` — prefix stripped by `addressFromGeckoTokenId`) +
    `relationships.dex.data.id`.
  - the `include=base_token` side-load supplies the token symbol.
- Why the primary seed: it is **fully dynamic** — no symbol list, and it
  only surfaces pools with real volume. (Live capture: 20 pools, dex mix
  orca/meteora/raydium/raydium-clmm + pumpswap — pump entries stripped.)

### DEX Screener (venue map — the authoritative per-venue truth)
- `GET https://api.dexscreener.com/latest/dex/tokens/{mint1,mint2,…}`
  — **batch ≤ 30 mints per call**. Every pair per mint across AMMs →
  `chainId`, `dexId`, `liquidity.usd`, `volume.h24`, `priceUsd`,
  `baseToken.address`.
- Optional extra seed: `GET …/latest/dex/search?q={symbol}` over
  `DEFAULT_MEME_SEED_SYMBOLS` (curated SYMBOLS — the search resolves the
  current symbol→mint, so the list cannot go stale the way mint tables
  do).
- ⚠️ Search alone is NOT reliable for canonical memes: `search?q=wif`
  returns pump.fun lookalikes and misses the real $WIF entirely. The
  search seed only *adds* mints; venue maps + the pump skip + liquidity
  floors decide what survives. (Live capture: the real BONK mint
  `DezXAZ…pB263` — the mint the old hardcoded table got wrong — resolves
  correctly through this path.)

## Pipeline

```
1. SEED     GeckoTerminal trending pools (per network)         [dynamic]
            [+ optional DEX Screener symbol-search rows]       [curated]
              ↓ parse → buildVenueMap (pump venues STRIPPED here)
2. VENUES   every seeded mint → DEX Screener /tokens (≤30/call)
              ↓ parse → buildVenueMap (authoritative per-dex aggregates)
              ↓ dedupeByMint([dsVenueMap, seedMap])   ← DS map FIRST (wins
              │                                         per-dex conflicts);
              │                                         GT-only tokens keep
              │                                         their pools as venues
3. FILTER   filterCandidates — the capture precondition + safety floors
```

### The filter (the capture precondition)
A token **passes** when:
- **≥ `minVenues` venues** (default **2**) each show per-venue aggregate
  liquidity **≥ `minLiquidityUsd`** (default **$50,000**), and
- token-wide 24h volume (Σ across non-pump venues) **≥ `minVolume24Usd`**
  (default **$10,000**).

These are the **DISPLAY/discovery** thresholds — the capture sweep can pass
stricter values (its own `--min-liq-usd` etc.). Single-venue tokens die
here: not capturable, by proof.

## Output shape (the consumer contract)

```js
[{
  symbol: "STONK",            // display only — identity is the mint
  mint: "6GmAFSYs4gk3…",      // normalized (EVM lowercased; base58 as-is)
  chain: "sol",
  priceUsd: 0.0123,
  liquidityUsd: 5122916,      // Σ across the token's non-pump venues
  volume24Usd: 90231475,      // Σ 24h volume, non-pump venues
  venueCount: 2,              // venues passing the per-venue floor
  venues: [                   // ALL non-pump venues, liq desc
    { dex: "meteora", liquidityUsd: 2679453, volumeUsd: …, pairCount: 2 },
    { dex: "orca",    liquidityUsd: 2321790, volumeUsd: …, pairCount: 3 },
  ],
  sources: ["geckoterminal-trending", "dexscreener-tokens"],  // provenance
  discoveredAt: "2026-09-07T…Z",
}]
```

Both consumers (the sweep + the APE UNIVERSE tab) consume this shape
unchanged.

## Live proof (captured this session)

`node tools/mev-discover-sweep.mjs --discover` found **10 capturable
candidates** live on Solana — RAY ($12.5M, raydium + raydium-clmm),
USELESS ($6.6M), STONK ($5.1M, 3 venues), ZCAT, PURR, AGI, FRIES, … — each
with per-venue liquidity ≥ $50k on ≥2 AMMs. `--seed-symbols` adds the
curated search seed: TRUMP ($77M), Fartcoin, PENGU, and the **real BONK**
join the list. The sweep's live gap probe then found RAY at a **12.0 bps
dislocation** (Raydium CLMM cheaper than Orca V1).

## Safety + resilience

- **Pump.fun skipped everywhere** (rug risk): never queried; venues whose
  dex id matches `/pump/i` are stripped before aggregation — they never
  contribute liquidity, volume, or venue counts. A pump-BORN token that
  migrated to deep real-AMM liquidity may still qualify via its real
  venues — the liquidity floors are the safety.
- **API failure degrades, never crashes**: a 429/5xx retries politely
  (backoff, Retry-After-respecting) then reports the miss; a dead source
  yields fewer candidates, not a thrown feed.
- **Pure extraction** (`parseDexScreener`, `parseGeckoTerminal`,
  `buildVenueMap`, `dedupeByMint`, `filterCandidates`) is unit-tested over
  REAL captured responses (`test/fixtures/meme-discovery/`) — including
  the pump-drowned WIF search noise and the 21-row BONK search surface
  (18 rows real Bonk + 3 lookalikes — the floors sort them).

## How to add a chain

1. Add one row to `DISCOVERY_CHAINS` in memeDiscovery.js:
   `{ key: { gtNetwork, dsChainId, family: "evm"|"svm", label } }`
   (canonical key = the repo teleportConstants id, e.g. `arb`, `opt`,
   `avax`, `sonic`).
2. `discoverMemes({ chain })` then works unchanged — both APIs key off
   the registry.
3. EVM note: mint normalization lowercases (`0x…`); venue identity is
   still the AMM (uniswap-v2/v3 are distinct venues — distinct
   Jupiter-excludable routes).
4. Sweep rails on a chain require the capture leg first — discovery runs
   the day the registry row lands; capture follows the chain's rails.
