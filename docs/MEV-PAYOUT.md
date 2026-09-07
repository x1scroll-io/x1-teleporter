# MEV CAPTURE PAYOUT — the treasury design (deposit-only, drop-as-is, batched sweep)

Mr. Esters' treasury design for the MEV capture engine (`src/lib/mev/`) —
the PAYOUT + ACCUMULATION + SWEEP layer that sits under the gated detection
engine. This is the DEPOSIT side of the capture: what happens to a capture
once the engine detects it (gated OFF today — every number below is
measurement).

🔴 **The boundary in one line: the engine DEPOSITS to these addresses and
never holds, signs, or spends from them. The treasury SEEDs/keys live
offline with Mr. Esters — never in the repo.**

## The design (confirmed)

1. **Per-chain payout addresses (deposit-only destinations).** A config map
   { chain → treasury address }. The engine sends captures TO these; it
   never holds their keys. Provided addresses:

   | group | address | serves |
   |---|---|---|
   | `evm` | `0xd907e2d4770D3222382eE619980075ac1e59a369` | ETH / Base / BNB / Arb / Opt / Pol / RH (one EVM key, per-chain deployment) |
   | `solana_x1` | `H3JfpvBRxAQ9ejrkyeKtCEy3WSRKbwcCxxxFBcohKSuY` | Solana + X1 (the same SVM address space) |

   BTC/XRP/… can be added later IF captures ever happen on those rails
   (today the capture engine scans the same-chain swap venues only:
   `CAPTURE_SCAN_CHAINS` in `src/engine/routePlanner.js`).

2. **Capture cheap (drop-as-is).** When MEV is captured on a chain, the
   captured token is dropped **AS-IS** into that chain's treasury address —
   no per-trade conversion, no per-trade send beyond the deposit. Minimal
   gas per capture.

3. **Accumulate.** Tokens pile up in the per-chain treasury over the period
   (the capture ledger is the record of the pile).

4. **Batch sweep (daily/weekly — configurable, NOT per-trade).** ONE batched
   op per chain converts the accumulated pile → the **SOL/wBTC/wETH/USDC**
   basket. Gas is paid ONCE per batch — amortized across the pile. This is
   what makes small captures profitable (per-trade sends would kill them).

5. **Consolidation — Mr. Esters' later choice.** Keep per-chain treasuries
   OR bridge each chain's captures to the **Solana hub** (our own bridge)
   and convert to the basket there. **DEFAULT: accumulate per-chain; the
   consolidation decision is deferred.** The sweep planner builds BOTH plan
   shapes so the choice is a config flip later, not a build.

6. **Gated OFF.** `MEV_CAPTURE_ENABLED` defaults false (v2-armed branches
   only — the `WARP_LIVE_SEND` discipline, `vite.config.js`
   `MEV_ARMED_BRANCHES`). Even armed: the engine produces **signable
   artifacts, never autonomous broadcast** — every composed leg's `submit()`
   throws `DexDirectLiveTestGateError` (the repo has no autonomous
   broadcast at any flag value).

7. **Sandbox measurement.** During the exotic-route tests the goal is to
   MEASURE/VERIFY the capture amount (does the engine capture the right gap
   on real aping flow?). Captured value **recycles in the test fleet**; the
   real treasury is production-only. Records are marked `simulated`/`test`.

## What was built

| file | what it is |
|---|---|
| `src/lib/mev/payoutConfig.js` | the PURE config: `MEV_PAYOUT_GROUPS_DEFAULT` (the per-chain treasury map), the sweep cadence (`MEV_SWEEP_FREQUENCY` — `daily` default / `weekly`), the basket (`MEV_SWEEP_BASKET` = SOL/wBTC/wETH/USDC), `BASKET_TARGETS` (per-chain canonical representation of each basket member — verified against the tokenResolver in the tests), `resolvePayoutConfig`/`readPayoutEnv` (the override load pattern: env vars + a gitignored file), and fail-closed address validation (EVM 0x+40hex; SVM base58 32 bytes). |
| `src/lib/mev/captureLedger.js` | the PURE accumulation ledger: one record per capture `{chain, token, amountRaw, destinationTreasury, capturedAt, source, simulated, test, evidence}` — the drop-as-is deposit-INTENT record (the MEASURE/VERIFY journal). `recordCapture`/`accumulatePile`/`queryLedger`/`summarizeLedger`/`serializeLedger`/`parseLedger`. No fs (src/ is browser-bundled) — persistence is the caller's JSON file (below). |
| `src/lib/mev/sweepPlanner.js` | the PURE batch-sweep planner: given a chain's ledger pile over a period, produces the plan — keep steps (already-basket captures) + convert steps (descriptors of the EXISTING engine swap legs — dexDirect/aggregator, built at arm time via the official-SDK constructors), the ONE gas payment, the per-chain treasury destination. BOTH consolidation shapes: `planChainSweep`/`planSweeps` (per-chain — DEFAULT) and `planHubSweep` (the deferred Solana-hub shape). Every plan: `executable:false`, `signableArtifacts:[]`, carries the gate. |
| `src/lib/mev/captureGate.js` (+wiring) | the observation pipelines now carry the payout: `runCaptureScan` results include `payout` (the drop-as-is destination); `runRouteCaptureScan` results include `payouts` (per distinct leg chain — a journey spans chains). `capturePayoutForChain(chain)` is the destination query; `dropAsIsRecords(scanResult)` is the MEASURE/VERIFY bridge that turns a scan into the ledger's drop-as-is record drafts (per-leg for multi-hop, per-capture for same-pair). |
| `src/engine/routePlanner.js` / `src/engine/index.js` | additive re-exports of `capturePayoutForChain` + `dropAsIsRecords` on the `RoutePlanner` surface (default routing byte-unchanged — verified by the suite). |
| `tools/mev-capture-measure.mjs` | the SANDBOX MEASUREMENT tool: given a test route's REAL quotes (the frozen exotic-route evidence files), runs the gated scan, records what the engine WOULD capture into the sandbox ledger (marked simulated/test), prints the MEASURE/VERIFY report. No network, no funds. |
| `docs/MEV-PAYOUT.md` | this design. |

### The ledger file (persistence — decided + documented)

The ledger is a JSON journal at a caller-chosen path — the module is pure;
fs lives in the callers:

- **Sandbox default**: `.sandbox/mev-capture-ledger.json` (`.sandbox/` is
  gitignored — test wallet keys live there; the ledger file NEVER commits).
- **Runtime override**: `MEV_CAPTURE_LEDGER_PATH` → a gitignored runtime
  file (the future armed daemon's own path).
- Format: `serializeLedger(state)` / `parseLedger(state)` (fail-closed on a
  corrupt or foreign file — a corrupt journal is never silently
  overwritten).

## Config + the load pattern

The default config carries the PUBLIC deposit addresses verbatim (they are
destinations — public by design). The override path mirrors how the repo
loads every other secret-ish value (flags.ts / .env.example):

- Env: `VITE_MEV_PAYOUT_EVM`, `VITE_MEV_PAYOUT_SOLANA_X1`
  (`NEXT_PUBLIC_…` fallbacks), `MEV_SWEEP_FREQUENCY`, `MEV_SWEEP_BASKET`
  (comma list) — see `.env.example`.
- Gitignored file: `.sandbox/mev-payout-config.json`
  (`{ "groups": { "evm": { "address": … }, "solana_x1": { "address": … } },
  "sweepFrequency": …, "sweepBasket": […] }`) — the sandbox measurement
  runs point the destinations at the TEST fleet addresses via this file.

The treasury SEEDs/keys are NEVER in the repo (they live in `.sandbox/`,
gitignored, and Mr. Esters' offline copy).

## The basket + per-chain representation

The basket member names are Mr. Esters' shorthand. Each chain represents a
member with its CANONICAL asset (`BASKET_TARGETS` — verified against the
repo tokenResolver in the tests):

| chain | SOL | wBTC | wETH | USDC |
|---|---|---|---|---|
| sol | WSOL (native wrap) | cbBTC | ETH (Wormhole wrap) | USDC |
| x1 | wSOL.X | cbBTC.X | ETH.X | USDC.x |
| eth / arb / opt / bas | — | — | ETH (native) | USDC |
| bsc / pol / avax / sonic | — | — | — | USDC |
| rbn | — | — | — | — (canonical stable is Paxos USDG) |

A member with no canonical entry on a chain is honestly **unavailable**
there: the per-chain sweep converts the representable slice, and the
hub-consolidation shape carries the rest to the Solana hub where the FULL
basket exists (sol represents all four members).

## The two sweep shapes (both planned; per-chain is the default)

- **Per-chain** (`planChainSweep` / `planSweeps`): each chain's pile
  converts in place — keep steps for already-basket captures, convert steps
  for the rest (batch anchor: USDC when representable — the deepest-
  liquidity stable sink; the executor may split across the alternate
  targets once real quotes are on the wire). ONE gas payment per chain per
  batch. Destination: that chain's treasury.
- **Solana-hub** (`planHubSweep` — the DEFERRED choice): each chain's pile
  bridges to the Solana hub (our own bridge — the engine's warp-leg
  family, descriptor only) and converts to the FULL basket there. One gas
  payment per chain (the bridge) + one hub conversion batch.

Nothing executes: every plan is a signable-artifact blueprint
(`executable:false`, `signableArtifacts:[]`, gate carried, `broadcast:
"never"`).

## Deposit-only boundary + the swap-out note

- **Deposit-only**: these addresses are DESTINATIONS. Nothing in the payout
  layer ever signs, spends, or moves funds FROM a treasury. Recording a
  capture in the ledger moves no funds — it journals drop-as-is INTENT.
  The deposit + sweep are future ARMED actions through the repo's existing
  guarded legs (signable artifacts for Mr. Esters' wallet; `submit()` throws
  `DexDirectLiveTestGateError`). The live arm is Mr. Esters' alone.
- **Interim addresses (swap-out)**: the committed addresses are Mr. Esters'
  current treasury destinations. Post-cutover he **re-derives them from his
  own offline seed** — the env/gitignored-file override path is the
  swap-out mechanism (no code change needed; the config validates the new
  addresses fail-closed before anything could use them).

## Sandbox measurement (the exotic-route verify path)

```
node --import ./tools/jsx-loader.mjs tools/mev-capture-measure.mjs \
    --route test/fixtures/golden/mev-multihop/inputs/route-01-sol-ape-2500-down.json
node --import ./tools/jsx-loader.mjs tools/mev-capture-measure.mjs \
    --pair  test/fixtures/golden/mev-capture/inputs/round-01-sol-SOL-USDC-evidence.json [--gas <raw>]
node --import ./tools/jsx-loader.mjs tools/mev-capture-measure.mjs   # config + ledger report
```

The tool runs the gated observation over the REAL-labeled frozen quotes,
records what the engine WOULD capture into `.sandbox/mev-capture-ledger.json`
(marked `simulated`/`test` — the test fleet recycles the value; the real
treasury is production-only), and prints the MEASURE/VERIFY report: per-leg
recorded amounts vs the engine's detection math, the drop destinations, and
the gate state. `--dry-run` prints without writing. **No funds move.**

## Tests

`src/lib/mev/payoutConfig.test.js` (13), `src/lib/mev/captureLedger.test.js`
(9), `src/lib/mev/sweepPlanner.test.js` (9), `test/mevPayout.test.js` (6) —
config shape + validation + env pattern, basket-target sanity vs the
tokenResolver, ledger record/accumulate/query/serialize + fail-closed parse,
both sweep plan shapes, the gate discipline (gated OFF → measurement only,
executable never), the RoutePlanner wiring, and the REAL-fixture
measurement round-trip (recorded amounts == the analyzer's per-leg deltas).
Full suite green; build green.
