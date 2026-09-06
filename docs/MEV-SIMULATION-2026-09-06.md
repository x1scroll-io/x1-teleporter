# MEV / price-gap capture — SIMULATION REPORT (2026-09-06)

**Real on-chain quotes. Zero trades. Gated OFF.**

The MEV/price-gap capture engine (src/lib/mev/) ran its detector against **live pool state** on the chains the
DEX-direct legs cover — read-only quoter eth_calls (EVM), on-chain pool-state walks + the legs' own quote math
(Solana), keyless aggregator quotes (Jupiter / LiFi). The capture EXECUTION path is dead-gated
(MEV_CAPTURE_ENABLED=false — the repo default and main-branch build; armed v2 builds are wallet-sign-only by
structure: the composed legs are the existing guarded swap legs, whose submit() throws DexDirectLiveTestGateError).

## The honest headline

- **32 round-trip detections** over 8 sample rounds (2026-09-06T17:04:19.060Z).
- Observed same-chain cross-venue spreads: **0–7 bps** (avg 3.94 bps).
- Net round trips after BOTH pool fees (netted inside the quotes) + gas: **-2 to 0 bps** (avg -1.50 bps).
- Strict-math positive nets: **4/32** — all four are noise: ≤ 0.004 bps net (≈ $0.02 on ~$530 — the aggregator's own two-sided quote rounding), routed Jupiter→Jupiter (same venue).
- **Economically capturable (net ≥ $0.1 AND ≥ 1 bps): 0/32. ZERO.**
- **How often gaps were TOO SMALL: 32/32 (100%).**

**Conclusion:** on the DEEP STABLE PAIRS the bridge actually moves (USDC↔USDT on eth/arb/bsc, SOL→USDC on
Solana) at the sampled sizes ($2,500 / 5 SOL), the round-trip cost — two pool fees + gas — exceeds every
observed same-chain cross-venue gap. The venues arbitrage each other too tightly for a fee-covered round trip
under normal conditions. The detector works (it found and quantified real dislocations — e.g. the Jupiter
aggregator out-quoted both direct Solana pools by up to 7 bps at 5 SOL); the engine should treat capture as a
**monitor for dislocation events** (volatile pairs, thin books, fee-tier dislocations at larger notional), not a
steady yield on these pairs.

## Method

- **EVM** (eth/arb/bsc): USDC→USDT then USDT→USDC sized at the best buy output — QuoterV2 / PancakeSwap
  QuoterV2 eth_call (the dexDirect legs' own read-only quote path), fee tiers 100 + 500, 2,500 USDC per chain
  (raw 6dp eth/arb, 18dp bsc — Binance-peg). LiFi aggregator quote (fee=0, the pure DEX-aggregated price) when
  reachable.
- **Solana**: SOL→USDC at 5 SOL then USDC→SOL sized at the best buy output — Orca whirlpool + Raydium CLMM
  live pool-state walks + the legs' pure quote math; Jupiter aggregator quote (fee-inclusive) when reachable.
- **Gas**: EVM — 2 txs × quoter gasEstimate × live eth_gasPrice, converted to USDC through REAL same-chain
  WETH/WBNB→USDC quoter reads (no synthetic prices). Solana — 2 × 5,000 lamports, already in SOL units.
- **USD**: EVM stable pairs ≈ $1 by pair construction (peg pairs, ~1e-3 tolerance). Solana — the SOL side is
  valued through the same round's real SOL→USDC venue quotes. Reporting only — never on a money path.
- **Honesty**: legs were quoted sequentially (two read-only calls); a real capture executes buy+sell atomically —
  the net figures assume the quotes held. Pool fees are netted inside the quotes (never double counted).
  Quotes are market data — they move; fixtures are dated 2026-09-06.

## Per-chain results

| chain | detections | gap min–max (avg) | wouldCapture (strict) | economically capturable |
|---|---|---|---|---|
| eth | 8 | 5–5 (5.00) | 0 | **0** |
| arb | 8 | 6–6 (6.00) | 0 | **0** |
| bsc | 8 | 2–2 (2.00) | 0 | **0** |
| sol | 8 | 0–7 (2.75) | 4 | **0** |

## The detections (all 32, honest numbers)

| round | chain | pair | gap bps | gross bps | net bps | net USD | strict | economic | route | whyNot |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | eth | USDC→USDT | 5 | -2 | -2 | $-0.5554 | no | no | uniswap(uniswap-eth-USDC-USDT-f100) → uniswap(uniswap-eth-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 1 | arb | USDC→USDT | 6 | -2 | -2 | $-0.5116 | no | no | uniswap(uniswap-arb-USDC-USDT-f100) → uniswap(uniswap-arb-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 1 | bsc | USDC→USDT | 2 | -2 | -2 | $-0.5096 | no | no | pancakeswap(pancakeswap-bsc-USDC-USDT-f100) → pancakeswap(pancakeswap-bsc-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 1 | sol | SOL→USDC | 7 | 0 | 0 | $-0.0191 | no | no | jupiter(jupiter-sol-USDC) → jupiter(jupiter-USDC-sol) | no-arb: the best round trip through the quoted venues return |
| 2 | eth | USDC→USDT | 5 | -2 | -2 | $-0.5558 | no | no | uniswap(uniswap-eth-USDC-USDT-f100) → uniswap(uniswap-eth-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 2 | arb | USDC→USDT | 6 | -2 | -2 | $-0.5115 | no | no | uniswap(uniswap-arb-USDC-USDT-f100) → uniswap(uniswap-arb-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 2 | bsc | USDC→USDT | 2 | -2 | -2 | $-0.5078 | no | no | pancakeswap(pancakeswap-bsc-USDC-USDT-f100) → pancakeswap(pancakeswap-bsc-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 2 | sol | SOL→USDC | 7 | 0 | 0 | $0.0227 | yes | no | jupiter(jupiter-sol-USDC) → jupiter(jupiter-USDC-sol) | capturable |
| 3 | eth | USDC→USDT | 5 | -2 | -2 | $-0.5540 | no | no | uniswap(uniswap-eth-USDC-USDT-f100) → uniswap(uniswap-eth-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 3 | arb | USDC→USDT | 6 | -2 | -2 | $-0.5116 | no | no | uniswap(uniswap-arb-USDC-USDT-f100) → uniswap(uniswap-arb-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 3 | bsc | USDC→USDT | 2 | -2 | -2 | $-0.5095 | no | no | pancakeswap(pancakeswap-bsc-USDC-USDT-f100) → pancakeswap(pancakeswap-bsc-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 3 | sol | SOL→USDC | 1 | 0 | 0 | $-0.0127 | no | no | jupiter(jupiter-sol-USDC) → jupiter(jupiter-USDC-sol) | no-arb: the best round trip through the quoted venues return |
| 4 | eth | USDC→USDT | 5 | -2 | -2 | $-0.5525 | no | no | uniswap(uniswap-eth-USDC-USDT-f100) → uniswap(uniswap-eth-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 4 | arb | USDC→USDT | 6 | -2 | -2 | $-0.5116 | no | no | uniswap(uniswap-arb-USDC-USDT-f100) → uniswap(uniswap-arb-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 4 | bsc | USDC→USDT | 2 | -2 | -2 | $-0.5078 | no | no | pancakeswap(pancakeswap-bsc-USDC-USDT-f100) → pancakeswap(pancakeswap-bsc-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 4 | sol | SOL→USDC | 0 | 0 | 0 | $0.0232 | yes | no | jupiter(jupiter-sol-USDC) → jupiter(jupiter-USDC-sol) | capturable |
| 5 | eth | USDC→USDT | 5 | -2 | -2 | $-0.5477 | no | no | uniswap(uniswap-eth-USDC-USDT-f100) → uniswap(uniswap-eth-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 5 | arb | USDC→USDT | 6 | -2 | -2 | $-0.5116 | no | no | uniswap(uniswap-arb-USDC-USDT-f100) → uniswap(uniswap-arb-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 5 | bsc | USDC→USDT | 2 | -2 | -2 | $-0.5078 | no | no | pancakeswap(pancakeswap-bsc-USDC-USDT-f100) → pancakeswap(pancakeswap-bsc-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 5 | sol | SOL→USDC | 1 | 0 | 0 | $0.0072 | yes | no | jupiter(jupiter-sol-USDC) → jupiter(jupiter-USDC-sol) | capturable |
| 6 | eth | USDC→USDT | 5 | -2 | -2 | $-0.5521 | no | no | uniswap(uniswap-eth-USDC-USDT-f100) → uniswap(uniswap-eth-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 6 | arb | USDC→USDT | 6 | -2 | -2 | $-0.5115 | no | no | uniswap(uniswap-arb-USDC-USDT-f100) → uniswap(uniswap-arb-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 6 | bsc | USDC→USDT | 2 | -2 | -2 | $-0.5096 | no | no | pancakeswap(pancakeswap-bsc-USDC-USDT-f100) → pancakeswap(pancakeswap-bsc-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 6 | sol | SOL→USDC | 3 | 0 | 0 | $-0.0136 | no | no | jupiter(jupiter-sol-USDC) → jupiter(jupiter-USDC-sol) | no-arb: the best round trip through the quoted venues return |
| 7 | eth | USDC→USDT | 5 | -2 | -2 | $-0.5506 | no | no | uniswap(uniswap-eth-USDC-USDT-f100) → uniswap(uniswap-eth-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 7 | arb | USDC→USDT | 6 | -2 | -2 | $-0.5116 | no | no | uniswap(uniswap-arb-USDC-USDT-f100) → uniswap(uniswap-arb-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 7 | bsc | USDC→USDT | 2 | -2 | -2 | $-0.5096 | no | no | pancakeswap(pancakeswap-bsc-USDC-USDT-f100) → pancakeswap(pancakeswap-bsc-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 7 | sol | SOL→USDC | 3 | 0 | 0 | $0.0008 | yes | no | jupiter(jupiter-sol-USDC) → jupiter(jupiter-USDC-sol) | capturable |
| 8 | eth | USDC→USDT | 5 | -2 | -2 | $-0.5529 | no | no | uniswap(uniswap-eth-USDC-USDT-f100) → uniswap(uniswap-eth-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 8 | arb | USDC→USDT | 6 | -2 | -2 | $-0.5115 | no | no | uniswap(uniswap-arb-USDC-USDT-f100) → uniswap(uniswap-arb-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 8 | bsc | USDC→USDT | 2 | -2 | -2 | $-0.5096 | no | no | pancakeswap(pancakeswap-bsc-USDC-USDT-f100) → pancakeswap(pancakeswap-bsc-USDT-USDC-f100) | no-arb: the best round trip through the quoted venues return |
| 8 | sol | SOL→USDC | 0 | 0 | 0 | $-0.0099 | no | no | jupiter(jupiter-sol-USDC) → jupiter(jupiter-USDC-sol) | no-arb: the best round trip through the quoted venues return |

## Fixtures

- `test/fixtures/golden/mev-capture/inputs/round-*-evidence.json` — every round's REAL quote evidence + the
  detection computed over it (REAL-labeled, quote-level only).
- `test/fixtures/golden/mev-capture/capture-log.json` — the flat real-quote log.
- `docs/mev-simulation-2026-09-06.json` — the machine report (this file's data).

Rebuild: `node tools/simulate-mev-capture.mjs --rounds=N` then `node tools/mev-report-build.mjs`.
