# APE UNIVERSE — the meme/venom capture surface

**Frame.** The APE UNIVERSE is Mr. Esters' name for the meme-token trading
surface the x1-teleporter MEV engine hunts — the liquid, multi-venue memes
whose cross-venue price dislocations are capturable. This doc frames the
build; the capture mechanics live in MEV-CAPTURE-ENGINE.md /
MEV-PAYOUT.md.

## Why the APE UNIVERSE exists

The real-capture tests proved the mechanism — **2 real WIF captures,
8.89 + 16.3 bps** — but the sweep was limited by **hardcoded mint
guessing**:

- the scratch mint table's BONK mint was **wrong** (`…v7S2M` vs the real
  `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`),
- the real dogwifhat does not even surface in a DEX Screener *symbol*
  search — meme turnover drowns canonical symbols in pump.fun lookalikes
  (live-verified: `search?q=wif` returns 8 pairs, **zero** of them the
  real $WIF).

Discovery cannot be a static list. It has to be **self-discovering**: find
what is actually trading on ≥2 liquid venues *right now*, on-chain.

## The venue map (per chain — capture surface)

A **venue** = one AMM's aggregate depth for a token (Jupiter's
`excludeDexes` excludes whole AMMs, so the gap sweep's unit is the AMM:
`raydium`, `orca`, `meteora`, `raydium-clmm`, `whirlpool`, …). Two pairs
on the same AMM are ONE venue.

| chain | canonical key | DEX Screener chainId | GeckoTerminal network | capture surface |
|---|---|---|---|---|
| Solana | `sol` | `solana` | `solana` | ✅ proven (WIF 8.89 + 16.3 bps) |
| Ethereum | `eth` | `ethereum` | `eth` | structured (discovery ready; sweep rails future) |
| Base | `bas` | `base` | `base` | structured |
| BNB Chain | `bsc` | `bsc` | `bsc` | structured |
| Polygon | `pol` | `polygon` | `polygon` | structured |

## The two consumers of this module

```
                ┌─────────────────────────────┐
                │   memeDiscovery.js (src)    │  ← build #1 (this PR)
                │  live, keyless, per chain   │
                └──────────────┬──────────────┘
                               │ candidates [{ symbol, mint, chain,
                               │   liquidityUsd, volume24Usd, venueCount,
                               │   venues: [{dex, liquidityUsd, …}], … }]
              ┌────────────────┴─────────────────┐
              ▼                                  ▼
   tools/mev-discover-sweep.mjs         APE UNIVERSE dashboard tab
   (self-discovering capture sweep)     (the degen/ticker feed — the
   discovery → top N → live gap          same module powers the rows;
   probe → caged round-trip capture      future build, consumes this
   → ledger                               output shape as-is)
```

1. **MEV sweep breadth** — the ≥2-liquid-venues filter **is** the capture
   precondition: single-venue tokens cannot be gap-captured (sim + real
   tests proved it). Discovery replaces the hardcoded mint table, so every
   liquid multi-venue meme is a candidate the sweep can hunt.
2. **The degen feed** — the APE UNIVERSE tab's meme ticker/destination
   rows consume the same module (same output contract), so the dashboard
   and the sweeps can never disagree about what is capturable.

## Build order

- **#1 (this PR):** `src/lib/mev/memeDiscovery.js` + tests + the
  discover-driven sweep (`tools/mev-discover-sweep.mjs`) + docs. Details:
  docs/MEME-DISCOVERY.md.
- **#2 (future):** the APE UNIVERSE tab/feed — consumes
  `discoverMemes()` output directly.

## Boundaries (carried from the capture engine)

- Frozen instruments byte-unchanged. This build adds discovery — it does
  not touch the money paths.
- The sweep stays **caged**: sandbox-only test scale, tiny amounts,
  round-trip recycle, ledger-recorded, never autonomous (see the tool's
  header). Deposits + sweeps remain future armed actions.
- Pump.fun is **skipped** everywhere (rug risk) — never queried, and pump
  venues are stripped from every venue map.
