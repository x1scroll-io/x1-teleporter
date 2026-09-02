# ROUTING-ENGINE.md — the x1-teleporter routing engine (Phase 1)

Status: **Phase 1 — the FORWARD leg (ETH → X1) runs on the engine, proven
byte-identical against both measuring instruments.** Reverse, THORChain and
DEX lanes are NOT on the engine — they keep their existing code paths until a
later phase migrates them. The engine never merges until the instruments pass
unchanged (PR policy: base `v2`, branch `feat/engine-phase1`).

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

## 6. Phase-2+ (not built here)

New route classes arrive as new `plan*` functions + leg factories behind the
same shape; legs that need separable signing implement `requestSignature`;
the planner learns to branch on quote/route-class. Each migration repeats the
same proof protocol against the instruments that exist for that lane.
