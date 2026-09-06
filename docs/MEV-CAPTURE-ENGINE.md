# MEV / price-gap CAPTURE ENGINE — design (v2, Phase 7)

Mr. Esters' concept, in plain terms: when the routing engine sees the SAME
token pair quoted on MULTIPLE DEXes on the SAME chain (Uniswap/PancakeSwap
on an EVM chain, Raydium/Orca on Solana — plus the aggregators), a price
difference between the venues is capturable value. Buy on the cheap venue,
sell on the expensive venue, in one atomic same-chain round trip, while the
engine is already routing a user's swap. The protocol keeps 100% of that
value, silently, in the background.

🔴 HARD LIMITS (Mr. Esters — absolute, structural):
- **NO live trades, NO broadcasting funds.** Build + SIMULATE only.
- **NO standalone bot.** Engine-integrated detection logic — not a daemon.
- **NO cutover / live-fire.** Frozen instruments are byte-unchanged; official
  SDKs only; no synthetic oracles on money paths.
- **The live arm/test is Mr. Esters' alone** — the exact WARP_LIVE_SEND
  discipline. He flips it; nothing here ever fires itself.

## TWO MODELS (the framing correction — 2026-09-06)

| model | file | question it answers | verdict from the real sims |
|---|---|---|---|
| **same-pair round trip** | `gapDetector.js` | buy X→Y on the cheap venue, sell Y→X on the expensive venue, ONE atomic same-chain round trip | **0/32 economically capturable** on deep stable pairs (two pool fees + two gas bills beat every observed spread) |
| **multi-hop route choice** | `routeAnalyzer.js` | a USER JOURNEY's per-hop venue selection (best venue per leg vs the routed venue), accumulated across 3–5 hops to volatile/exotic destinations — the APING flow | **11/21 route analyses economically capturable** on realistic any-to-any routes ending at exotic destinations (the ape-leg venue spread is 14–16 bps every round) |

The single-pair round trip is the engine's per-hop primitive and STAYS (it
answers the same-chain arb question). The route analyzer is the model Mr.
Esters' framing correction points at: the real value is distributed across
the whole multi-hop journey — per-hop spread/slippage + route-choice
improvement (Uniswap vs Pancake, Jupiter vs Raydium, which bridge)
accumulated to volatile/exotic destinations. One-way, no round-trip double
fee.

## What was built

| file | what it is |
|---|---|
| `src/lib/mev/gapDetector.js` | the PURE same-pair gap math. Given same-chain same-pair buy quotes (X→Y) and sell quotes (Y→X), computes the best-vs-second spread (bps), the round trip net of BOTH pool fees + gas + the capture fee policy, and returns a **DETECTION** — never a trade. |
| `src/lib/mev/routeAnalyzer.js` | the PURE MULTI-HOP route analyzer. Given an ordered leg list (swaps + bridges), each leg carrying its venue options' quotes at the leg's routed size + a real USD conversion of the output token, computes per-leg best-venue-vs-routed-venue deltas (bps + $, net of the per-leg explicit cost delta), the ACCUMULATED route-level capture (the number that matters), the optimal sub-path, and the honest wouldCapture verdict. Single-venue legs contribute 0; pool/bridge fees are netted inside every quote (never double counted). Builds on gapDetector's primitives (`rankQuotes` / `gapBpsBetween` / the fee ruling) per leg. |
| `src/lib/mev/captureGate.js` | the GATE (mirror of WARP_LIVE_SEND) + BOTH observation pipelines. `MEV_CAPTURE_ENABLED` (flags.ts) — **default FALSE**. Gated OFF → `runCaptureScan` (same-pair) reports **"capture opportunity: X bps (gated OFF)"** and `runRouteCaptureScan` (multi-hop) reports **"route capture opportunity: X bps across N hops (gated OFF)"**; the execution guard (`assertCaptureGateOpen`) throws `CaptureGateClosedError`. Even ARMED it is wallet-sign-only: `executable` is always false. |
| `src/engine/routePlanner.js` | the routing hooks: `CAPTURE_CANDIDATES` / `captureCandidatesForChain` (the same-chain venue lists, derived from `DEX_DIRECT_FALLBACKS` — default routing unchanged), `planCaptureSwapPair` (the atomic same-pair capture-route CONSTRUCTOR — COMPOSES two existing swap legs via `composeRoute`), `observeCaptureForSwap` (same-pair observation), and the MULTI-HOP seams: `observeRouteCapture` (runs the route analyzer when a multi-hop route's per-leg venue quotes are on the wire) + `planCaptureRouteJourney` (folds `composeRoute` over the optimal sub-path's per-leg routes — the repo's OWN legs; dead-gated; `atomic:false` with the honest note that a journey is not a same-block arb). |
| `src/lib/flags.ts` + `vite.config.js` | the gate flag + build-time pin. `MEV_ARMED_BRANCHES = { "v2" }` — the repo's main build compiles `MEV_CAPTURE_ENABLED:"false"` (verified in the dist bundle); only the v2 branch compiles it true. |
| `tools/simulate-mev-capture.mjs` | the read-only same-pair SIMULATION harness (real pool state, zero trades). |
| `tools/simulate-mev-multihop.mjs` | the read-only MULTI-HOP SIMULATION harness — REAL per-leg venue quotes (quoter eth_calls, Solana/X1 pool-state walks, keyless Jupiter/LiFi) on realistic any-to-any routes ending at volatile/exotic destinations. |
| `tools/mev-report-build.mjs` / `tools/mev-multihop-report-build.mjs` | the offline report builders (economic layer + human reports). |
| `docs/MEV-SIMULATION-2026-09-06.md` + `.json` | the same-pair simulation REPORT (0/32 — the honest negative). |
| `docs/MEV-MULTIHOP-SIMULATION-2026-09-06.md` + `.json` | the MULTI-HOP simulation REPORT (the framing-correction proof — 11/21 economically capturable on the aping flow). |
| `test/fixtures/golden/mev-capture/` + `test/fixtures/golden/mev-multihop/` | the REAL quote captures (REAL-labeled, quote-level only, dated) + per-round/per-route evidence. |
| tests | same-pair: `gapDetector.test.js` (13), `captureGate.test.js` (11 — incl. the route scan), `test/mevCapture.test.js` (11), `test/mevSimulationFixtures.test.js` (3). multi-hop: `routeAnalyzer.test.js` (13), `test/mevMultihop.test.js` (6), `test/mevMultihopSimulationFixtures.test.js` (3). Full suite green, build green. |

## The fee ruling (documented, configurable)

Mr. Esters: "protocol keeps 100%, silent." The fee-model-v2 charge (0.5%
capped $250 once-per-journey — `src/lib/fees.ts`) applies to USER journeys.
An internal capture leg is NOT a user journey — the protocol IS the taker,
so **capture value = gross round trip − the pool fees both legs already paid
(netted inside the quotes) − gas**; the 0.5% journey fee does NOT apply to
internal capture legs. Enforced as a config constant
(`CAPTURE_FEE_POLICY_BPS`, default 0) so the ruling is adjustable in one
place. Pool fees are netted inside every quote the engine uses (quoter
eth_call / pool-state walks return amountOut AFTER the LP fee) — the cost
model reports them as context and does NOT subtract them twice. The
multi-hop model carries the same convention: per-leg venue quotes are NET
outputs; only EXPLICIT ADDITIVE cost deltas between venues enter the net
math (same-chain venue swaps share gas → delta 0). The fee-model-v2 journey
charge and the Warp skim (0.5%) apply regardless of venue choice — they
cancel out of every venue comparison.

## The execution shapes (dead-gated)

- `planCaptureSwapPair({chain, pair, buy: {via, dex}, sell: {via, dex}})` —
  the atomic same-pair capture route: the repo's existing swap legs
  (dexDirect: uniswap/pancakeswap/raydium/orca; aggregators: lifi/jupiter)
  in buy→sell order, `atomic: true`.
- `planCaptureRouteJourney({legRoutes, id, optimal})` — the multi-hop
  capture journey: `composeRoute` folded over an ordered list of per-leg
  routes (the analyzer's optimal sub-path — best venue per hop), `atomic:
  false` (a journey is NOT a same-block round trip; the value is route-
  choice improvement realized leg by leg).

Every one of those legs' `submit()` throws `DexDirectLiveTestGateError` —
**no autonomous broadcast exists at any flag value**. Even an armed gate
(v2 builds only) merely allows the constructor to produce artifacts for Mr.
Esters' wallet to sign.

## The simulation results (the honest truth)

### Same-pair round trips (deep stable pairs): 0/32

8 rounds × 4 chains (eth/arb/bsc/sol) against LIVE pool state, 2,500 USDC /
5 SOL round trips: **32 detections**. Same-chain cross-venue spreads were
**0–7 bps** (avg 3.9); net round trips after both pool fees + gas were
**−2 to 0 bps**; the strict-math positives (4) were all ≤ 0.004 bps noise
(≈ $0.02, the aggregator's own two-sided quote rounding); **economically
capturable (≥ $0.10 AND ≥ 1 bp): ZERO of 32.**

### Multi-hop route choice (the aping flow): 11/21 economically capturable

3 rounds × 7 route archetypes (~$2,500 journeys + a $10k size route) with
REAL per-leg venue quotes on realistic any-to-any routes ending at
volatile/exotic destinations (the EVM→SOL→exotic ape, the native-source
ape, the EVM-stable→X1 stable control, the X1 fresh-token route): **21 route
analyses**; **15/21 strict-positive, 11/21 economically capturable**
(accumulated net ≥ $0.10 AND ≥ 1 bps). Accumulated route nets **$0–7.95
(avg $2.82)**; route bps **0–12.2 (avg 4.1)**. The value concentrates on the
ape leg — the direct single-market pool (Raydium CPMM) quoted **14–16 bps
worse than the aggregated market every round** ($3.7–4.5 per $2,500 ape;
Jupiter splits the same token across its other live markets — verified in
its route plan) — plus 1–7 bps on the SOL→USDC hop. The stable-heavy
control (EVM-stable → X1 to a STABLE destination) was **already-optimal
3/3 rounds: $0** — the honest non-clearer. When the aggregator is UP and
best the engine already routes optimally (6/21 already-optimal — nothing to
capture); the value is the FALLBACK-state + thin-market routing penalty the
route-choice engine removes. Full numbers + the routes that did NOT clear:
docs/MEV-MULTIHOP-SIMULATION-2026-09-06.md.

## Re-run

```bash
# same-pair round-trip sim (the negative result — monitor framing)
node tools/simulate-mev-capture.mjs --rounds=8 --sleep=15000   # read-only live capture
node tools/mev-report-build.mjs                                 # rebuild the report offline

# multi-hop route-choice sim (the framing-correction proof)
node tools/simulate-mev-multihop.mjs --rounds=3 --sleep=5000    # read-only live capture
node tools/mev-multihop-report-build.mjs                         # rebuild the report offline

node tools/run-selected-tests.mjs src/lib/mev/gapDetector.test.js src/lib/mev/captureGate.test.js src/lib/mev/routeAnalyzer.test.js test/mevCapture.test.js test/mevSimulationFixtures.test.js test/mevMultihop.test.js test/mevMultihopSimulationFixtures.test.js
```
