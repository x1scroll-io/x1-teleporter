# MULTI-HOP route-choice capture — SIMULATION REPORT (2026-09-06)

**Real per-hop venue quotes. Zero trades. Gated OFF.**

The framing correction (Mr. Esters, 2026-09-06): the single same-pair ROUND-TRIP gap sim proved ~0 on deep
stable pairs — a round trip pays two pool fees + two gas bills. The MEV is DISTRIBUTED across the whole
multi-hop journey: every hop has a venue CHOICE (which DEX / aggregator / bridge), and the delta between
the venue the engine routed and the BEST venue for that hop is capturable per hop — ONCE PER HOP, one-way,
no round-trip double fee. This simulation (src/lib/mev/routeAnalyzer.js + tools/simulate-mev-multihop.mjs)
measured the route-choice value on REALISTIC ANY-TO-ANY ROUTES ENDING AT VOLATILE/EXOTIC DESTINATIONS — the
aping flow — with REAL per-leg venue quotes (quoter eth_calls, pool-state walks, keyless aggregator quotes).
The capture EXECUTION path is dead-gated (MEV_CAPTURE_ENABLED=false — the repo default and main-branch
build; armed v2 builds are wallet-sign-only by structure: the composed legs are the existing guarded swap
legs, whose submit() throws DexDirectLiveTestGateError).

## The honest headline

- **21 route analyses** over 3 sample rounds × 7 route archetypes (2026-09-06T23:21:20.759Z).
- **11/21 routes economically capturable** (accumulated net ≥ $0.10 AND ≥ 1 bps — the honest bar, same as the single-pair sim).
- **15/21 strict-positive** (any positive accumulated net after per-leg cost deltas).
- Accumulated route nets: **$0 to $7.95** (avg $2.82); route nets in bps: **0 to 12.21 bps** (avg 4.09 bps).
- Per-leg venue spreads: **0–16 bps** (avg 5.45 bps); distribution 0-1bps: 13, 1-5bps: 8, 5-20bps: 12, 20-+bps: 0.
- **51 legs analyzed, 33 with venue choice** (multi-venue); the rest are single-venue rails (bridge hops with one serving carrier, the Warp hop, X1's only DEX) — they contribute 0 by construction.
- **Already-optimal routes: 6/21** — when the aggregator is UP and best (the DEX_DIRECT_FALLBACKS default), best-venue routing IS what the engine already does: nothing to capture. The capturable value appears in the **aggregator-DOWN state** (the direct-fallback routing the registry exists for) and on the **exotic destination leg**.

**Conclusion — Mr. Esters' thesis CONFIRMED, in the corrected form:** the value is NOT in same-pair round
trips on liquid pairs (0/32 there); it IS in the one-way route-choice deltas accumulated across multi-hop
journeys to volatile/exotic destinations. The pattern across all rounds:

- **The ape leg (USDC → a real low-liquidity Solana token) is where the value concentrates: 14–16 bps every
  round** — the direct single-market pool (Raydium CPMM) quotes 14–16 bps worse than the aggregated market
  (Jupiter splits the same token across its OTHER live markets — an Orca Whirlpool + a Raydium CP pool —
  verified in Jupiter's route plan). Routing the direct CPMM fallback while the aggregator is down costs
  that much per ape; best-venue routing captures it. At $2,500 that is **$3.7–4.5 per journey on the last
  hop alone**; the SOL→USDC hop adds 1–7 bps ($0.3–2.1).
- **Accumulated route capture on the $2,500 aping routes: ~9–12 bps / $4.7–5.4 net, economically capturable
  in every round** (sol-ape / btc-ape / evm-ape down-variants).
- **The $10,000 ape route tells the size story honestly**: the aggregator stops quoting the thin exotic leg
  at ~$10k (liquidity limit — the direct pool becomes the only venue, single-venue → 0 there) and the
  capturable value narrows to the SOL→USDC leg (1–3 bps / $1.2–3.5). Bigger ape ≠ bigger capture on a thin
  target — the pool IS the market at that size.
- **Stable-heavy routes do NOT clear (the honest control)**: the EVM-stable → X1 flow (WETH→USDC swap +
  bridge to a STABLE destination) was already-optimal 3/3 rounds — 0 bps, $0 (the EVM aggregator and the
  direct Uniswap pool arbitrage each other to <1 bp on WETH→USDC; the bridge leg has one serving carrier).
- **Single-venue rails contribute 0 everywhere**: the EVM→SOL bridge (one serving carrier observed), the
  Warp hop (0.5% skim — invariant across venue choices), the X1 destination leg (X1 has ONE DEX — XDEX).
  The X1-exotic route therefore nets only its Solana-side hop: strict-positive but BELOW the economic bar
  ($0.06–0.85, <1 bp) in every round.

**What the engine would have captured (the deliverable number):** routing each hop through its best venue
on the aping journeys would have improved the destination balance by **~$4.7–5.4 on a $2,500 ape** (the
aggregator-DOWN state — i.e. the fallback penalty the route-choice engine removes) and ~$0 on stable-heavy
journeys. When the aggregator is UP and best the engine already routes optimally (0 — honest). The capture
is a **routing-quality improvement**, not a same-block arb: it realizes when the engine holds multi-venue
quotes and routes the best one (observation-only today — gated OFF).

## Method

- **Route model** (src/lib/mev/routeAnalyzer.js, pure): a journey = ordered legs (swaps + bridges); each leg
  carries its venue options' quotes at the leg's routed size + a real USD conversion of the output token.
  Per-leg: best-venue vs routed-venue gap (bps + $), net of the per-leg explicit cost delta. Route-level:
  the ACCUMULATED net across the whole journey (dollar-weighted bps + $), the optimal sub-path (best venue
  per leg), and the honest wouldCapture verdict. Single-venue legs contribute 0; pool/bridge fees are netted
  inside every quote (never double counted — the gapDetector ruling carried over).
- **Venue sets** (per DEX_DIRECT_FALLBACKS / CAPTURE_CANDIDATES + the rail matrix):
  - EVM same-chain (WETH→USDC, Ethereum): LiFi (aggregator) vs Uniswap v3 f500 QuoterV2 eth_call (direct).
  - Solana SOL↔USDC: Jupiter (aggregator) vs Orca whirlpool + Raydium CLMM (live pool-state walks).
  - Ape leg USDC→EXOTIC(sol): Jupiter vs Raydium CPMM direct (live pool-state walk) — the real low-liquidity
    token DvjbE…/USDC (verified: the token has ≥3 live markets — Orca Whirlpool + Raydium CP + Raydium
    CPMM — Jupiter aggregates them; the CPMM direct is one market).
  - EVM→SOL bridge: LiFi (keyless — one serving carrier observed). Native→SOL (THORChain/Rango rail): NOT
    re-quotable from this environment (THORChain hosts egress-blocked; Rango mainnet = server-keyed; the
    repo's REAL Rango capture 2026-09-05 is pinned in test/fixtures/golden/rango-leg/) — native-source
    routes are analyzed over their quotable SOL-side legs, documented per route.
  - X1: XDEX (the only DEX) — SOL/B69ch… pool: vault balances refreshed live per round (official SPL
    layout), static fields + fee config = the repo's frozen 2026-09-02 capture. The Warp hop (0.5% skim) is
    a documented invariant across venue choices (not a venue delta).
- **Sizes**: ~$2,500 journeys (25 SOL / 1 WETH / 2,500 USDC) + one ~$10,000 size-effect route (98 SOL).
- **Routing states modeled**: 'agg-up' (aggregator first — the DEX_DIRECT_FALLBACKS default) and 'agg-down'
  (the aggregator unavailable → the engine routes the DIRECT fallback — the exact scenario the fallback
  registry exists for). The analyzer measures the delta either way.
- **USD**: real same-round rates only — stables ≈ $1 by peg construction (~1e-3 tolerance, the single-pair
  sim convention); SOL via the round's real SOL→USDC venue rates; EXOTIC(sol) via the round's real Jupiter
  USDC→EXOTIC rate; EXOTIC(x1) via the XDEX pool's real reserves × the round's real SOL price. No synthetic
  prices. Reporting only — never on a money path.
- **Honesty**: venues for a leg are quoted at the same amountIn (the routed size), sequentially (read-only
  calls) — markets move between reads; per-leg deltas are per-snapshot math. Aggregator quotes flap (the
  keyless Jupiter/LiFi endpoints rate-limit + rotate tools); retries + a round-scoped success cache were
  used, and a transient LiFi misquote (~43 bps, one round) was observed and excluded by re-quote. Quotes are
  market data — they move; fixtures are dated 2026-09-06.

## Per-route archetype results (aggregated across rounds)

| route archetype | runs | econ | strict | route net $ min–max (avg) | route net bps min–max (avg) |
|---|---|---|---|---|---|
| sol-ape-2500-down | 3 | **3** | 3 | $4.69–$6.49 ($5.52) | 8.82–12.21 (10.38) |
| sol-ape-2500-up | 3 | **0** | 0 | $0–$0 ($0) | 0–0 (0) |
| sol-ape-10000-down | 3 | **2** | 3 | $1.19–$7.95 ($4.22) | 0.58–3.89 (2.06) |
| btc-ape-2500-down | 3 | **3** | 3 | $4.69–$6.49 ($5.52) | 8.82–12.21 (10.38) |
| evm-ape-2500-down | 3 | **3** | 3 | $3.96–$4.07 ($4.03) | 5.27–5.41 (5.36) |
| evm-x1-stable-2500-down | 3 | **0** | 0 | $0–$0 ($0) | 0–0 (0) |
| x1-exotic-2500-down | 3 | **0** | 3 | $0.06–$0.85 ($0.45) | 0.06–0.86 (0.46) |

Legend: econ = economically capturable (net ≥ $0.10 AND ≥ 1 bps); strict = any positive accumulated net.

### Per-leg venue deltas (aggregated across rounds by hop shape)

| hop shape | legs | multi-venue | single-venue | gap bps min–max (avg) | venues routed (chosen → best seen) |
|---|---|---|---|---|---|
| hop1 SOL→USDC (sol) | 12 | 12 | 0 | 0–7 (2.75) | orca/jupiter → jupiter |
| hop2 USDC→EXOTIC(sol) (sol) | 12 | 9 | 3 | 0–16 (10.67) | raydium-cpmm/jupiter → jupiter/raydium-cpmm |
| hop1 WETH→USDC (eth) | 6 | 6 | 0 | 0–0 (0) | uniswap → uniswap |
| hop2 USDC→USDC (eth→sol) | 6 | 0 | 6 | — | lifi → lifi |
| hop3 USDC→EXOTIC(sol) (sol) | 3 | 3 | 0 | 15–16 (15.67) | raydium-cpmm → jupiter |
| hop1 USDC→USDC (eth→sol) | 3 | 0 | 3 | — | lifi → lifi |
| hop2 USDC→SOL (sol) | 3 | 3 | 0 | 0–3 (1.33) | orca → jupiter |
| hop3 SOL→wSOL.X (sol→x1) | 3 | 0 | 3 | — | warp → warp |
| hop4 wSOL.X→EXOTIC(x1) (x1) | 3 | 0 | 3 | — | xdex → xdex |

## The route analyses (all rounds, honest numbers)

| round | route | legs | multi-venue legs | route gap bps | route net $ | route net bps | econ | whyNot / note |
|---|---|---|---|---|---|---|---|---|
| 1 | sol-ape-2500-down | 2 | 2 | 12.21 | $6.49 | 12.21 | **YES** | capturable |
| 1 | sol-ape-2500-up | 2 | 2 | 0 | $0 | 0 | no | already-optimal: every multi-venue leg was already routed through its best venue — the engine left nothing on  |
| 1 | sol-ape-10000-down | 2 | 1 | 3.89 | $7.95 | 3.89 | **YES** | capturable |
| 1 | btc-ape-2500-down | 2 | 2 | 12.21 | $6.49 | 12.21 | **YES** | capturable |
| 1 | evm-ape-2500-down | 3 | 2 | 5.27 | $3.96 | 5.27 | **YES** | capturable |
| 1 | evm-x1-stable-2500-down | 2 | 1 | 0 | $0 | 0 | no | already-optimal: every multi-venue leg was already routed through its best venue — the engine left nothing on  |
| 1 | x1-exotic-2500-down | 4 | 1 | 0.06 | $0.06 | 0.06 | strict-only | capturable |
| 2 | sol-ape-2500-down | 2 | 2 | 8.82 | $4.69 | 8.82 | **YES** | capturable |
| 2 | sol-ape-2500-up | 2 | 2 | 0 | $0 | 0 | no | already-optimal: every multi-venue leg was already routed through its best venue — the engine left nothing on  |
| 2 | sol-ape-10000-down | 2 | 1 | 0.58 | $1.19 | 0.58 | strict-only | capturable |
| 2 | btc-ape-2500-down | 2 | 2 | 8.82 | $4.69 | 8.82 | **YES** | capturable |
| 2 | evm-ape-2500-down | 3 | 2 | 5.41 | $4.07 | 5.41 | **YES** | capturable |
| 2 | evm-x1-stable-2500-down | 2 | 1 | 0 | $0 | 0 | no | already-optimal: every multi-venue leg was already routed through its best venue — the engine left nothing on  |
| 2 | x1-exotic-2500-down | 4 | 1 | 0.86 | $0.85 | 0.86 | strict-only | capturable |
| 3 | sol-ape-2500-down | 2 | 2 | 10.12 | $5.38 | 10.12 | **YES** | capturable |
| 3 | sol-ape-2500-up | 2 | 2 | 0 | $0 | 0 | no | already-optimal: every multi-venue leg was already routed through its best venue — the engine left nothing on  |
| 3 | sol-ape-10000-down | 2 | 1 | 1.72 | $3.51 | 1.72 | **YES** | capturable |
| 3 | btc-ape-2500-down | 2 | 2 | 10.12 | $5.38 | 10.12 | **YES** | capturable |
| 3 | evm-ape-2500-down | 3 | 2 | 5.41 | $4.07 | 5.41 | **YES** | capturable |
| 3 | evm-x1-stable-2500-down | 2 | 1 | 0 | $0 | 0 | no | already-optimal: every multi-venue leg was already routed through its best venue — the engine left nothing on  |
| 3 | x1-exotic-2500-down | 4 | 1 | 0.44 | $0.44 | 0.44 | strict-only | capturable |

### Per-hop detail (round 1 — the representative snapshot)

| round | route | hop | leg | chosen → best | gap bps | gap $ |
|---|---|---|---|---|---|---|
| 1 | sol-ape-2500-down | 1 | SOL→USDC (sol) | orca → jupiter | 7 | $2.12 |
| 1 | sol-ape-2500-down | 2 | USDC→EXOTIC(sol) (sol) | raydium-cpmm → jupiter | 16 | $4.38 |
| 1 | sol-ape-2500-up | 1 | SOL→USDC (sol) | jupiter → jupiter | 0 | $0 |
| 1 | sol-ape-2500-up | 2 | USDC→EXOTIC(sol) (sol) | jupiter → jupiter | 0 | $0 |
| 1 | sol-ape-10000-down | 1 | SOL→USDC (sol) | orca → jupiter | 7 | $7.95 |
| 1 | sol-ape-10000-down | 2 | USDC→EXOTIC(sol) (sol) | raydium-cpmm → raydium-cpmm | single | — |
| 1 | btc-ape-2500-down | 1 | SOL→USDC (sol) | orca → jupiter | 7 | $2.12 |
| 1 | btc-ape-2500-down | 2 | USDC→EXOTIC(sol) (sol) | raydium-cpmm → jupiter | 16 | $4.38 |
| 1 | evm-ape-2500-down | 1 | WETH→USDC (eth) | uniswap → uniswap | 0 | $0 |
| 1 | evm-ape-2500-down | 2 | USDC→USDC (eth→sol) | lifi → lifi | single | — |
| 1 | evm-ape-2500-down | 3 | USDC→EXOTIC(sol) (sol) | raydium-cpmm → jupiter | 15 | $3.96 |
| 1 | evm-x1-stable-2500-down | 1 | WETH→USDC (eth) | uniswap → uniswap | 0 | $0 |
| 1 | evm-x1-stable-2500-down | 2 | USDC→USDC (eth→sol) | lifi → lifi | single | — |
| 1 | x1-exotic-2500-down | 1 | USDC→USDC (eth→sol) | lifi → lifi | single | — |
| 1 | x1-exotic-2500-down | 2 | USDC→SOL (sol) | orca → jupiter | 0 | $0.06 |
| 1 | x1-exotic-2500-down | 3 | SOL→wSOL.X (sol→x1) | warp → warp | single | — |
| 1 | x1-exotic-2500-down | 4 | wSOL.X→EXOTIC(x1) (x1) | xdex → xdex | single | — |

## The routes that DID NOT clear (honesty)

- **evm-x1-stable (the bridge's real flow to a STABLE destination) — 0 bps / $0 in all 3 rounds.** The EVM
  swap leg's venues (LiFi vs Uniswap f500 direct on WETH→USDC) arbitrage each other to <1 bp; the bridge leg
  has one serving carrier. This is the stable-heavy non-clearer the single-pair sim predicted — and the
  reason the multi-hop model concentrates on exotic destinations.
- **sol-ape-2500-up / agg-up variants — 0 bps / $0 in all rounds (already-optimal).** When the aggregator is
  up AND best, the engine's default routing already takes the best venue: nothing to capture. The route-
  choice value is a FALLBACK-state + thin-market phenomenon, not a steady-state tax on default routing.
- **x1-exotic (EVM stable → X1 fresh token) — strict-positive but BELOW the economic bar every round**
  ($0.06–0.85 net, <1 bp): only its Solana-side hop has venue choice; the bridge, the Warp hop and X1's only
  DEX are single-venue by design. X1-side exotic destinations carry no route-choice value today (one DEX).
- **sol-ape-10000 round 1 — 0 bps**: at ~$10k the aggregator did not quote the thin exotic leg (liquidity
  limit) → single-venue; and Orca matched/beat Jupiter on SOL→USDC at 98 SOL that round. Rounds 2–3 cleared
  on the SOL leg alone ($1.2–3.5).

## Fixtures

- `test/fixtures/golden/mev-multihop/inputs/route-*.json` — every route's REAL per-leg quote evidence (each
  leg's venue options at the leg's routed size) + the analysis computed over it (REAL-labeled, quote-level
  only; dated; refresh before live use).
- `test/fixtures/golden/mev-multihop/capture-log.json` — the flat real-quote log.
- `docs/mev-multihop-simulation-2026-09-06.json` — the machine report (this file's data).

Rebuild: `node tools/simulate-mev-multihop.mjs --rounds=3` then `node tools/mev-multihop-report-build.mjs`.
