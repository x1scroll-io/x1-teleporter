# ROUTING-ENGINE.md — the x1-teleporter routing engine (Phase 4)

Status: **Phase 4 — the DEX swap legs join the engine (Jupiter on Solana,
XDEX on X1 — direct on-chain — and the LiFi EVM same-chain swap verdict
leg), instruments-first; all four route classes (forward ETH → X1, reverse
X1 → EVM, THORChain source → SOL.SOL, DEX swap) are planned on the engine,
proven byte-identical against the measuring instruments.** The DEX swap
legs are construction-migrated (their deterministic artifacts are pinned by
the Phase-4 oracle); live DEX lanes keep their existing gated paths until a
later phase wires runners. The engine never merges until the instruments
pass unchanged (PR policy: base `v2`, branch `feat/engine-phaseN`).

---

## 1. Why this exists

Today the forward leg's flow lives inside bespoke runners
(`teleportExecute.executeLiFiEvmTx`, `warpBridge.runStage2`) — correct,
proven, but not composable. The next phases (multi-leg routes, new lanes)
need a uniform way to say: *a route is an ordered set of chain-scoped legs,
each of which builds → simulates → requests a signature → submits → confirms.*

Phase 1 builds that skeleton WITHOUT touching the proven transaction logic:
every leg **wraps** the existing builder/sender functions (no rewrites), and
the two measuring instruments (the golden fixtures + the browser harness)
prove the wrapped output is byte-for-byte what the reference path produced.

## 2. The three core abstractions

### 2.1 `LegContract` — `src/engine/legContract.js`

A leg is one atomic, chain-scoped step of a route. Every leg implements the
same five-phase contract:

| phase | what it does | Phase-1 reality |
|---|---|---|
| `build(ctx)` | deterministic artifact — the app-controlled bytes (calldata + tx params, or the unsigned serialized tx) | **the byte-identity surface the golden fixtures pin**; pure/offline |
| `simulate(ctx)` | pre-send gate (Step 1.3A, fail-closed) | EVM legs THROW `SimulationError` on a revert; SVM legs return the normalized `{ ok, err/logs/simUnavailable }`; `{ ok:true, skipSubmit:true }` = the rest of the lifecycle is unnecessary |
| `requestSignature(ctx)` | the wallet boundary when signing is separable from broadcast | Phase-1 legs use wallet-mediated sends whose proven code bundles request+submit (EIP-1193 `eth_sendTransaction`, Wallet-Standard sign-and-send) — those legs implement `submit`; future server-side signers can split this phase out |
| `submit(ctx)` | broadcast → tx id/hash/signature | **only runs when `simulate` passed** — a failed sim never reaches the wallet or the network |
| `confirm(ctx)` | finality (receipt / confirmation) | optional; the EVM bridge leg treats the hash as final (reference behavior) |

`runLeg(leg, ctx)` executes the defined phases in order, records a trace, and
enforces the sim gate (a non-ok sim or a `skipSubmit` marker stops the leg
before submit/confirm; a throwing sim propagates).

Legs never construct wallets, RPC connections or endpoints — everything is
dependency-injected through the route context, so legs are deterministic and
unit-testable, and the SAME leg can run against a live chain, a mock, or a
fixture.

### 2.2 `SignerResolver` — `src/engine/signerResolver.js`

The engine's SINGLE signer-resolution point, keyed by chain family:

- `"evm"` → the EIP-1193 provider (`resolveEvmProvider`)
- `"svm"` → the sign-capable Solana adapter (`resolveSolanaAdapter`)

Both delegates are the **proven resolvers** from
`src/lib/wallet/sessionProviders.js` — the ones the reference path already
ships (PR #34's stage-2 submit fix resolves the Solana signer through exactly
this adapter resolver). The resolver adds family keying + fail-soft nulls
(unknown family / mock session with no signing surface → `null`, caller
surfaces the honest "connect a real wallet" error).

### 2.3 `RoutePlanner` (stub) — `src/engine/routePlanner.js`

Owns ROUTE SHAPE: which legs, in which order, grouped into which stages.
Phase 1 plans exactly one route — `forward-eth-x1` — as four legs:

```
stage 1 of 2 (EVM)   evm-approval      exact-amount ERC-20 approval      (golden step1)
                      lifi-evm-bridge   LiFi stage-1 bridge tx, forwarded  (quoteReference)
                                        verbatim
stage 2 of 2 (SVM)   x1-ata-create     X1 recipient ATA-create,           (golden step2a)
                                        Token-2022, idempotent
                      warp-lock         1% skim + BridgeOut in ONE tx,     (golden step2b)
                                        + the bridge_in_v2 account          (+ golden step3)
                                        pre-image for the guardians' mint
```

The planner does not execute anything — the stage runners drive the planned
legs with an injected context. Unplanned directions (`plan({direction:
"reverse"})`, THORChain, DEX) return `null`: those lanes keep their existing
paths until a later phase adds their `plan*`.

## 3. Which existing functions each leg wraps

| leg | file | wraps (unchanged) |
|---|---|---|
| `evm-approval` | `src/engine/legs/forward/approvalLeg.js` | `lifiApproval.buildApprovalData` + `validateLiFiApproval` (fail-closed spender gate), `simulateTx.simulateEvmTx`, `teleportExecute.waitForReceipt` — the approval block of `executeLiFiEvmTx` (same validation → allowance read → exact approve() → sim → send → receipt-wait order, same status lines, same `LiFiApprovalValidationError`/`SimulationError` pass-through and the reference "Token approval failed: …" wrap for everything else) |
| `lifi-evm-bridge` | `src/engine/legs/forward/lifiEvmLeg.js` | the bridge-tx half of `executeLiFiEvmTx` — the quote's `transactionRequest` forwarded VERBATIM (calldata sha256 reference) through `simulateEvmTx` + `eth_sendTransaction` |
| `x1-ata-create` | `src/engine/legs/forward/ataCreateLeg.js` | `warpBridge.ensureX1RecipientAta` (idempotent Token-2022 create) + `simulateStage2` + `sendX1AtaCreation` (guarded, deterministic-chain broadcast) — `runStage2`'s X1-prep step |
| `warp-lock` | `src/engine/legs/forward/warpLockLeg.js` | `warpBridge.buildStage2` (ComputeBudget + skim + BridgeOut), `simulateStage2`, `sendStage2ViaPhantom` — `runStage2`'s Solana leg; `deriveBridgeInV2AccountList` is the engine port of the golden step3 rebuild (PDA derivations + spec filter, oracle-pinned) |

The stage runners (`src/engine/runners/`) own the reference error/return
contracts so the UI behaves identically:

- `forwardEvmStage.js` — chain-ensure prelude (migrated from
  `executeLiFiEvmTx`), approval leg under the reference error policy, bridge
  leg; returns `{ stage: "evm_sent", txHash }`.
- `forwardSvmStage.js` — fee-payer preflight (`assertSolanaFeePayer`), ATA
  leg (simulate or guarded-send per `allowLive`), warp-lock leg; returns the
  **runStage2 result shape** the form reads (`x1_ata_simulation` /
  `simulation` / `simulated_ok` / `sent` + `sim`/`built`/`prep`). The
  WARP_LIVE_SEND gate is forwarded as `allowLive` — never decided by the
  engine.

`src/engine/index.js` is the facade. `TeleportForm.jsx` now plans the forward
route and runs the two stages through the engine; the REVERSE handlers
(`executeReverseStage1/2`, the reverse runners) still use the reference
resolvers/functions — untouched.

## 4. The proof protocol (non-negotiable)

The engine is correct **iff** it reproduces the reference transactions
byte-for-byte. Two instruments measure this; neither may be modified to
accommodate the engine:

1. **`test/golden.test.js`** (+ `test/fixtures/golden/forward-leg/`) — the
   regression oracle. Rebuilds the forward leg from the frozen quote + fixed
   inputs and asserts canonical-JSON equality + sha256 for all four steps
   (approval calldata/params, X1 ATA serialized tx, Warp lock serialized tx,
   bridge_in_v2 account list + spec) plus the cross-step chain of custody.
2. **`e2e/forward-leg.spec.js`** — the browser harness. Drives the REAL UI
   (connect modal → quote → Bridge) and asserts the fee lines, the To-address
   line, advancement to the sign step, and that the wallet is asked to sign
   the EXACT golden approval — byte-for-byte — stopping at the signature.

`test/engine.test.js` adds engine-specific coverage WITHOUT duplicating the
oracle: lifecycle ordering/gating with fakes, SignerResolver delegation,
RoutePlanner shape, and a byte-identity pass that runs the ENGINE's leg
artifacts against the same fixtures (all four sha256s + serialized bytes +
chain of custody). If any comparison fails, **the engine is wrong** — fix the
engine, never the oracle.

## 5. Phase-1 scope (hard boundaries)

- Migrates: the forward leg ETH → X1 (approval, LiFi stage-1 bridge, X1
  ATA-create, Warp lock + bridge_in_v2 pre-image).
- Does NOT migrate: reverse (X1 → EVM), THORChain lanes, DEX/swap lanes.
- No new chains, no new tokens, no fee changes.
- `vite.config.js` / `vercel.json` untouched; `npm run build` must succeed;
  the branch stays deployable at every commit.

## 6. Phase-2 scope — the REVERSE route (X1 → EVM)

- Migrates: the X1 Warp burn (bundled fee-ATA create when missing + 1% skim +
  BridgeOut — `x1-reverse-burn`), the release-wait poll (`warp-release-wait`,
  submitter-side release DETECTION via the same-origin `/api/warp/*` proxy),
  and the LiFi Solana→EVM out leg to the PINNED EVM destination
  (`lifi-solana-out`). Golden oracle: `test/goldenReverse.test.js` +
  `test/fixtures/golden/reverse-leg/`; harness: `e2e/reverse-leg.spec.js`.

## 7. Phase-3 scope — the THORChain deposit-address lane

- Migrates: the THORChain lane's app-constructed artifacts (the Buy/THORChain
  tab — BTC/DOGE/LTC/XRP → SOL.SOL deposit-address flow) as TWO build-only
  legs — `thorchain-quote` (the canonical proxy quote request + size-cap
  gate) and `thorchain-deposit-build` (the vault deposit address + the
  deposit memo). Golden oracle: `test/goldenThorchain.test.js` +
  `test/fixtures/golden/thorchain-leg/` (synthetic THORNode input bodies —
  the lane is NOT live yet; the fixtures pin CURRENT construction; replace
  with live captures on the first operator deposit).
- BOTH legs are family `"external"` (an additive LegContract family): the
  deposit executes OUT-OF-BAND in the user's external wallet — the engine's
  SINGLE SignerResolver returns null for them BY DESIGN (no in-app session
  signer exists for the deposit-address lane; the UI surfaces the honest
  "send from your wallet" step). The SOL-landing watcher + post-landing
  auto-advance reuse the Phase-1/2-proven executors on their existing gated
  paths — not re-migrated.
- Does NOT migrate: DEX/swap lanes (stay unplanned — `plan` returns null).
- No new chains, no new tokens, no fee changes; `vite.config.js` /
  `vercel.json` untouched; `npm run build` must succeed.

## 8. Later phases (not built here)

New route classes arrive as new `plan*` functions + leg factories behind the
same shape; legs that need separable signing implement `requestSignature`;
the planner learns to branch on quote/route-class. Each migration repeats the
same proof protocol against the instruments that exist for that lane.

## 9. Phase-4 scope — the DEX swap legs

- Migrates (construction): the engine's DEX swap legs, pinned by the Phase-4
  oracle `test/goldenDex.test.js` + `test/fixtures/golden/dex-leg/` (inputs:
  frozen LIVE captures — the Jupiter quote, the XDEX pool snapshot, the
  LiFi same-chain quote). Engine coverage: `test/engineDex.test.js`.
- **Jupiter (Solana DEX aggregator)** — `jupiter-swap` (family svm, chain
  sol), planned by `planJupiterSwap()` (`swap-sol-sol-jupiter`). The
  canonical construction: the quote request (GET `api.jup.ag/swap/v1/quote`
  — RAW base-unit amount + slippage bps; the old `quote-api.jup.ag/v6` host
  is dead) + the swap-instructions request (POST `…/swap-instructions` — the
  quote forwarded VERBATIM as quoteResponse + the pinned session pubkey +
  the fixed option set). Build is pure; the network half (fetch → LUT
  assembly → sign-and-send via the single SignerResolver's svm adapter) is
  the stage layer's job once a live lane lands.
- **XDEX (X1's DEX — DIRECT on-chain)** — `xdex-swap` (family svm, chain x1),
  planned by `planXdexSwap()` (`swap-x1-x1-xdex`). Discovery: XDEX has NO
  HTTP swap API — the swap is one instruction to the XDEX program
  `sEsYH97…4fN` (immutable since 2026-01-07), method SwapBaseInput (Anchor
  log-confirmed), discriminator **13bddf5c73d6bd24** (OBSERVED on 273
  sampled live pool swaps + identical on Raydium's own live Solana CP-Swap —
  the earlier nebula note's 8fbe5ada… does not match the live program),
  13 accounts, data = disc + amount_in u64 LE + min_out u64 LE. The quote is
  the Raydium CP curve on the live pool snapshot (trade fee 2800/1e6 =
  0.28% from the live AmmConfig; protocol 25% + fund 5% of the trade fee
  are internal). ARG-SEMANTICS PREREQUISITE (flagged): run one tiny
  controlled swap on the operator's go-ahead before real funds — the
  sampled live txs are relayer/AA-driven and do not 1:1 expose the
  arg↔vault-delta mapping.
- **LiFi EVM same-chain swap (Leg C verdict)** — `lifi-evm-swap` (family
  evm), planned by `planLifiEvmSwap()` (`swap-eth-eth-lifi`). VERDICT
  (verified live 2026-09-02): LiFi ALREADY quotes EVM same-chain swaps —
  fromChain == toChain returns a swap route (observed tools: sushiswap AND
  nordstern; includedSteps `[protocol:feeCollection, swap:<dex>]`); the
  app's quote params never filtered swap tools and the server fee policy
  already forces the 1% integrator fee on same-chain routes. EVM swap legs
  are DONE by LiFi — the leg pins the canonical quote-request construction
  through the existing `/api/lifi/quote` policy; execution reuses the
  existing /api/lifi/* path + the lifiApproval audit gate (accepts exchange
  tools).
- **Leg-composition design ("swap then bridge")**: `composeRoute(first,
  second)` splices a swap route's legs IN FRONT of a bridge route's legs and
  re-groups the stages under a prefixed namespace — the legs stay the SAME
  LegContract objects; only the ordered leg list + stage grouping compose.
  The canonical use: the THORChain post-landing auto-advance (SOL lands →
  swap SOL→USDC on Jupiter → 1% skim + Warp hop into X1) =
  `composeRoute(planJupiterSwap(), planForward())`. The planner owns the
  SHAPE; the runners own execution.
- Does NOT migrate: DEX lane RUNNERS (the legs' network half — live sends
  stay gated on their existing paths until a later phase wires them).
- No new chains, no new tokens, no fee changes; `vite.config.js` /
  `vercel.json` untouched; `npm run build` must succeed.
