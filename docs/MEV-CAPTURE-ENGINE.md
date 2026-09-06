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

## What was built

| file | what it is |
|---|---|
| `src/lib/mev/gapDetector.js` | the PURE gap math. Given same-chain same-pair buy quotes (X→Y) and sell quotes (Y→X), computes the best-vs-second spread (bps), the round trip net of BOTH pool fees + gas + the capture fee policy, and returns a **DETECTION** `{pair, chain, gapBps, netValueAfterCosts, wouldCapture, route: [cheap, expensive]}` — never a trade. |
| `src/lib/mev/captureGate.js` | the GATE (mirror of WARP_LIVE_SEND) + the observation pipeline. `MEV_CAPTURE_ENABLED` (flags.ts) — **default FALSE**. Gated OFF → the detector RUNS read-only and reports **"capture opportunity: X bps (gated OFF)"**; the execution guard (`assertCaptureGateOpen`) throws `CaptureGateClosedError`. Even ARMED it is wallet-sign-only: `executable` is always false. |
| `src/engine/routePlanner.js` | the routing hook: `CAPTURE_CANDIDATES` / `captureCandidatesForChain` (the same-chain venue lists, derived from `DEX_DIRECT_FALLBACKS` — default routing unchanged), `planCaptureSwapPair` (the atomic capture-route CONSTRUCTOR — COMPOSES two existing swap legs via `composeRoute`; no hand-rolled calldata), and `observeCaptureForSwap` (records what WOULD be capturable when multi-venue quotes are on the wire). |
| `src/lib/flags.ts` + `vite.config.js` | the gate flag + build-time pin. `MEV_ARMED_BRANCHES = { "v2" }` — the repo's main build compiles `MEV_CAPTURE_ENABLED:"false"` (verified in the dist bundle); only the v2 branch compiles it true. |
| `tools/simulate-mev-capture.mjs` | the read-only SIMULATION harness (real pool state, zero trades). |
| `tools/mev-report-build.mjs` | the offline report builder (adds the economic layer + the human report). |
| `docs/MEV-SIMULATION-2026-09-06.md` + `docs/mev-simulation-2026-09-06.json` | the simulation REPORT (the deliverable proof). |
| `test/fixtures/golden/mev-capture/` | the REAL quote captures (REAL-labeled, quote-level only) + per-round evidence. |
| tests | `src/lib/mev/gapDetector.test.js` (13), `src/lib/mev/captureGate.test.js` (8), `test/mevCapture.test.js` (11), `test/mevSimulationFixtures.test.js` (3). Full suite: **1026/1026 green**, build green. |

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
model reports them as context and does NOT subtract them twice.

## The atomic execution shape (dead-gated)

`planCaptureSwapPair({chain, pair, buy: {via, dex}, sell: {via, dex}})`
returns a composed route whose legs ARE the repo's existing swap legs
(dexDirect: uniswap/pancakeswap/raydium/orca; aggregators: lifi/jupiter)
in buy→sell order. Every one of those legs' `submit()` throws
`DexDirectLiveTestGateError` — **no autonomous broadcast exists at any flag
value**. Even an armed gate (v2 builds only) merely allows the constructor
to produce artifacts for Mr. Esters' wallet to sign.

## The simulation result (the honest truth)

8 rounds × 4 chains (eth/arb/bsc/sol) against LIVE pool state, 2,500 USDC /
5 SOL round trips: **32 detections**. Same-chain cross-venue spreads were
**0–7 bps** (avg 3.9); net round trips after both pool fees + gas were
**−2 to 0 bps**; the strict-math positives (4) were all ≤ 0.004 bps noise
(≈ $0.02, the aggregator's own two-sided quote rounding); **economically
capturable (≥ $0.10 AND ≥ 1 bp): ZERO of 32.** Gaps were too small 100% of
the time.

Conclusion for Mr. Esters: on the DEEP STABLE PAIRS the bridge actually
moves, the venues arbitrage each other too tightly for a fee-covered round
trip under normal conditions. The engine is not a money printer on these
pairs — it is a **dislocation monitor**: the detector provably finds and
quantifies real gaps (Jupiter out-quoted both direct Solana pools by up to
7 bps at 5 SOL), and it reports "capture opportunity: X bps (gated OFF)"
the moment a gap clears the round-trip cost (volatile pairs, thin books,
fee-tier dislocations at larger notional). When Mr. Esters arms the gate on
a live test, the machinery he signs with is the repo's own verified legs.

## Re-run

```bash
node tools/simulate-mev-capture.mjs --rounds=8 --sleep=15000   # read-only live capture
node tools/mev-report-build.mjs                                 # rebuild the report offline
node tools/run-selected-tests.mjs src/lib/mev/gapDetector.test.js src/lib/mev/captureGate.test.js test/mevCapture.test.js test/mevSimulationFixtures.test.js
```
