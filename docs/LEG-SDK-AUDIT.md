# LEG SDK AUDIT — every tx-construction site classified + refactored to official SDKs

Branch: `feat/leg-sdk-audit` (off `v2` @ eb2a6bf) · 2026-09-06

Mr. Esters' standing rule: EVERY chain/protocol integration uses the OFFICIAL
SDK — never hand-rolled calldata/instructions. Official SDK = correct by
construction, maintained by the protocol team, eliminates the
hand-rolled-calldata bug class (the XDEX discriminator disaster, dead quoters,
ABI traps).

This document is the full audit of the x1-teleporter v2 money path + the
record of what was refactored. Coordination: the parallel `feat/dex-official-sdk`
task owns `src/engine/legs/dexDirect/*` (Uniswap/PancakeSwap/Raydium/Orca
direct legs — in flight, verified against this audit); it does NOT own anything
else and has not landed commits yet (branch sits at v2's tip).

---

## 1. THE AUDIT TABLE

Legend: **SDK-BASED** = constructs through an official SDK (or forwards a
protocol-built tx verbatim) · **HAND-ROLLED → SDK** = was hand-rolled, an
official SDK exists, REFACTORED in this branch · **HAND-ROLLED (documented)** =
hand-rolled with NO official SDK / X1-native / deliberate-architecture → why.

### X1 / Warp (the SVM core)

| Site | What it constructs | Verdict |
|---|---|---|
| `warpBridge.js buildStage2` (forward lock) | Solana → X1 BridgeOut: ComputeBudget + 0.5% skim SPL transfer + Warp `bridge_out` | **SDK-BASED base + program-specific layout (documented)**. Every primitive is official: `@solana/web3.js` Transaction/TransactionInstruction/ComputeBudgetProgram/PDA derivation and `@solana/spl-token` `createTransferInstruction` / `getAssociatedTokenAddress` / `createAssociatedTokenAccountIdempotentInstruction`. The Warp `bridge_out` account spec (12 named slots), the `27c23977…` discriminator and the PDA seeds (`config`, `evt_out`, …) come from the Warp v2 IDL (extracted from the official app.bridge.x1.xyz bundle) + live-tx verification. **X1 is SVM-compatible — `@solana/web3.js` IS the official X1 SDK** (X1 exposes the standard Solana JSON-RPC; the app's `Connection` objects talk to `rpc.mainnet.x1.xyz` directly). There is no separate "X1 SDK" and no official Warp bridge SDK published anywhere (npm/web: none — the bridge program is x1.xyz-proprietary). The program-specific layout is therefore **unavoidable hand-rolling over the official SVM base** — and it is fixture-pinned (golden forward-leg step2b/step3, byte-for-byte) + live-tx-verified. **Classified honestly: no refactor possible beyond the official base, which is already in use.** |
| `warpBridge.js buildReverseBurn*` (reverse burn) | X1 → Solana BridgeOut burn (+ bundled fee-ATA create + skim) | Same verdict as above. Token-2022 transfers/ATA-create go through `@solana/spl-token` official helpers; the 12-account burn layout is Warp-IDL-derived + verified against live burns (mMQt8Ypjed…, 5rUiHoLE12L5…) + fixture-pinned (golden reverse-leg step1). **SDK-BASED base + documented program layout.** |
| `warpBridge.js ensureX1RecipientAta / ensureX1FeeWalletAta` | Token-2022 ATA creation on X1 | **SDK-BASED** — `@solana/spl-token` `createAssociatedTokenAccountIdempotentInstruction` + `getAssociatedTokenAddressSync` (official), wrapped in a `@solana/web3.js` Transaction. Idempotent create-if-missing; sim-gated broadcast. |
| `warpBridge.js` fee math (SKIM_BPS, per-token Warp fees) | 0.5% skim + Warp flat-$1/25bps | Not tx construction — app-side policy math over the live Warp config, single-sourced from `fees.ts`/tokenResolver. Documented; no SDK applies. |
| `ataCreateLeg.js` / `warpLockLeg.js` / `x1BurnLeg.js` (engine legs) | Wrap the warpBridge builders above | **SDK-BASED (wrappers)** — no independent construction; "wrap, don't rewrite" is stated in each header. |
| `releaseWaitLeg.js` | Polls the release (submitter constructs it) | No construction in-app (submitter-side since step 1.2). **SDK-BASED / N-A** — nothing hand-rolled. |

### EVM (forward + LiFi)

| Site | What it constructs | Verdict |
|---|---|---|
| `lifiEvmLeg.js` (forward stage-1 bridge) | LiFi bridge tx | **SDK-BASED (protocol-built, forwarded verbatim)** — the app never invents calldata: it forwards the LiFi quote's `transactionRequest` byte-for-byte (sha256-pinned) and sim-gates the send. LiFi built the tx. |
| `approvalLeg.js` + `lifiApproval.js` | ERC-20 `approve()` calldata + `allowance()` read calldata | **HAND-ROLLED → SDK (REFACTORED this branch)**. `buildApprovalData`/`buildAllowanceData` now encode through **viem** `encodeFunctionData` (viem is already a dependency and is the rule's official EVM SDK). Output is byte-identical (selector + 32-byte words), so the golden step1 fixture, the sha256 byte reference and every pinned calldata string are UNCHANGED. Spender validation stays (Diamond allowlist + /v1/tools fail-closed audit gate). |
| `teleportExecute.js executeLiFiEvmTx` | The reference EVM execution path | Forwarded-verbatim bridge tx + the same approval builders → **SDK-BASED after the viem refactor**. Chain-ensure + sim gate unchanged. |
| `lifiSolanaTx.js` / reverse `lifiSolanaOutLeg.js` | LiFi Solana→EVM out tx | The tx payload comes from LiFi's API (quote `transactionRequest` or the `/stepTransaction` materialisation); the app deserialises (VersionedTransaction — official `@solana/web3.js`), simulates fail-closed and signs via the SignerResolver. **SDK-BASED (protocol-built + official SVM primitives).** |
| `dex/lifiEvmSwapLeg.js` (Leg C verdict) | Same-chain EVM swap QUOTE REQUEST | Request-artifact leg (no calldata): pins the canonical `/api/lifi/quote` params + server fee policy. LiFi does EVM swaps (verified live). No hand-rolled tx bytes. |

**@lifi/sdk note (4.6.1 exists):** the app deliberately uses the LiFi **REST
API through its own same-origin proxies** (`/api/lifi/quote`,
`/api/lifi/stepTransaction`, `/api/lifi/tools`) — the LiFi API key lives
SERVER-side only, and the Teleporter fee policy (`resolveForcedFee`) is applied
SERVER-side on the proxy. `@lifi/sdk` would move the key client-side or force a
proxy re-shape, and its executor would replace the app's audited
sim-gated-send + exact-approval flow with heavier machinery. **The REST-proxy
pattern is deliberate (server-side key + server-side fee policy) — documented,
not refactored.** If a server-side LiFi executor is ever wanted, `@lifi/sdk`
runs server-side in the proxy; the SPA stays as-is.

### THORChain (deposit-address lane)

| Site | What it constructs | Verdict |
|---|---|---|
| `thorchain/quoteLeg.js` + `lib/thorchain/quote.js` | The quote request to `/api/thorchain/quote` | **SDK-BASED / N-A** — deterministic URL artifact through the serverless proxy (THORChain API key server-side); not tx construction. |
| `thorchain/depositBuildLeg.js` + `lib/thorchain/memo.js` | The deposit vault address + deposit MEMO `=:SOL.SOL:<dest>[/refund]` | **HAND-ROLLED (documented — no SDK exists for this)**. The memo is a protocol DATA STRING in THORNode's `SwapMemo.String()` scheme (verified against `memo_swap.go`), NOT calldata — and the official `@xchainjs/xchain-thorchain` (checked v1.0.0 and v3.1.1) has NO memo builder: its own `deposit()`/`prepareTx()` take `memo` as a CALLER-SUPPLIED string. Every xchainjs consumer hand-builds memos exactly like this module. The deposit TX itself is executed OUT-OF-BAND in the user's external wallet (family "external" — the app never constructs or broadcasts it), so no UTXO/XRP tx SDK (bitcoinjs-lib/xrpl.js) is in the money path. If an in-app deposit-tx builder ever lands, those become the SDKs. → Both are now **GRABBED** as readiness (`feat/grab-sdks` — bitcoinjs-lib 7.0.1 `sdkBitcoin.js`, xrpl 5.1.0 `sdkXrp.js`; §9 + docs/SDK-REGISTRY.md). |
| `lib/thorchain/inboundAddresses.js`, `pollStatus.js` etc. | Reads/polling | N-A. |

### DEX legs

| Site | What it constructs | Verdict |
|---|---|---|
| `dex/jupiterSwapLeg.js` | Jupiter quote-request URL + swap-instructions request body | **SDK-adjacent request artifacts (documented)** — Jupiter's server constructs the swap instructions; the leg pins the canonical requests (identical to what the official `@jupiter/api` SDK sends) + the pinned session pubkey. When a live lane lands and assembles the response into a tx, it must use `@jupiter/api` (official) + `@solana/web3.js` — noted in the leg header; no in-app tx bytes exist today. → SDK **GRABBED** (`feat/grab-sdks` — actual npm name `@jup-ag/api` 6.0.48, `sdkJupiter.js`; §9 + docs/SDK-REGISTRY.md). |
| `dex/xdexSwapLeg.js` | XDEX `SwapBaseInput` instruction + tx (X1) | **HAND-ROLLED → SDK (REFACTORED this branch — the marquee fix).** XDEX is a Raydium-CPMM fork running ON X1 with no SDK of its own (only HTTP price endpoints — verified in the discovery). The instruction is now built by **`@raydium-io/raydium-sdk-v2` `makeSwapCpmmBaseInInstruction`** (the official Raydium SDK) with the XDEX program id + the live pool key set. Evidence: (a) the SDK's CPMM `swapBaseInput` discriminator table IS `8fbe5adac41e33de` — byte-identical to the live-verified XDEX pin (also = sha256("global:swap_base_input")[..8]); (b) the SDK emits the identical 24-byte payload (disc + amount_in u64 LE + min_out u64 LE) and the identical 13-account order; (c) the SDK-built ix **SIMULATED err:null on X1 mainnet** (2026-09-06, slot 76,980,xxx, sigVerify:false) and executed the full CP swap (Token-2022 TransferChecked in, Token TransferChecked out). The only delta: the SDK marks the fee payer READONLY at the ix level (the live XDEX anchor tx marked it writable) — both accepted by the live program (proven by simulation), and the serialized legacy tx is byte-identical either way because `@solana/web3.js` forces the fee-payer meta writable when compiling the message (**fixture txSha256 UNCHANGED**; only the ix-level JSON flag + artifact sha256 changed in the regenerated xdex step2 fixture). A fail-closed drift canary now checks the SDK output against the live-verified account order + payload before anything serializes. Heavy-SDK discipline: dynamic-import only in the execute path. Quote math stays app-side CP over the live pool snapshot (live-confirmed 1:1 with the anchor economics) — the same way any DEX frontend reads on-chain state; the snapshot fixture carries no raw account bytes, so SDK pool parsing is not possible offline. |
| `dex/lifiEvmSwapLeg.js` | See EVM section | See EVM section. |
| `dexDirect/*` (Uniswap/PancakeSwap/Raydium/Orca) | Direct DEX legs | **IN FLIGHT — owned by the parallel `feat/dex-official-sdk` task** (37 files modified in its worktree as of 2026-09-06, adding `@uniswap/sdk-core`+`@uniswap/v3-sdk`, `@pancakeswap/sdk`+`smart-router`+`universal-router-sdk`, `@raydium-io/raydium-sdk-v2`, `@orca-so/whirlpools-sdk`). Not touched here. No overlap with this branch's files. |

### Rango / Wanchain (guarded external lanes)

| Site | What it constructs | Verdict |
|---|---|---|
| `rango/rangoQuoteLeg.js` + `lib/rango/quote.js` | Quote request to `/api/rango/quote` | Request artifact via the serverless proxy (Rango key server-side). Not tx construction. |
| `rango/rangoExecuteLeg.js` | Swap-create request (`GET /basic/swap`) | **HAND-ROLLED guarded stub (documented — deliberate proxy architecture).** The stub pins the request SHAPE for the future `/api/rango/swap` proxy; submit() always throws `RangoLiveTestGateError`. `rango-sdk` (0.5.0, official) exists but requires the API key CLIENT-side and does not target a same-origin proxy base — the app's architecture keeps aggregator keys server-side (same deliberate pattern as LiFi/THORChain). **The SDK belongs server-side in the future proxy route** (`api/rango/swap.js` should wrap rango-sdk's `swap()`); the SPA leg stays a request pinner. Documented in the leg header. |
| `wanchain/wanchainQuoteLeg.js` + `lib/wanchain/quote.js` | Quote request (XFlows v3 POST via proxy) | Request artifact. Not tx construction. |
| `wanchain/wanchainExecuteLeg.js` | buildTx request (XFlows `POST /api/v3/buildTx`) | **HAND-ROLLED guarded stub (documented — no official SDK).** Wanchain's XFlows is a raw HTTP API (OpenAPI at xflows-open-api.wanscan.org) — there is NO official Wanchain JS SDK. The upstream buildTx service constructs the actual transaction; the app pins the request body. submit() always throws `WanchainLiveTestGateError`. When the live anchor lands, the response is signed in the user's external wallet (family "external"). |

### src/lib support

| Site | Verdict |
|---|---|
| `simulateTx.js` | Not tx construction — the fail-closed sim gate (eth_call/estimateGas + `connection.simulateTransaction`). Official RPC methods. N-A. |
| `lifiDiamondAllowlist.js`, `fees.ts`, `tokenResolver.js`, `teleportConstants.js` | Policy/registry data. N-A. |

---

## 2. THE X1 SDK QUESTION (answered)

- **X1 chain:** SVM-compatible, standard Solana JSON-RPC (`rpc.mainnet.x1.xyz`,
  apiVersion 3.1.14). `@solana/web3.js` **IS** the official construction SDK
  for X1 — the app uses it everywhere (Connection against the X1 RPC,
  Transactions, PDAs). One X1 RPC quirk found during verification: its
  `simulateTransaction` REQUIRES `encoding: "base64"` in the config (stock
  web3.js omits it and defaults to base58 → "invalid base58 encoding"). The
  app's sim path (simulateTx.js) doesn't hit this today because it goes
  through `connection.simulateTransaction` on chains where that works; noted
  for the X1 sim path.
- **Warp bridge:** no official SDK (x1.xyz-proprietary program; IDL extracted
  from the official bundle + live-tx verified). Program-specific layouts are
  unavoidable + fixture-pinned.
- **XDEX:** no official XDEX SDK (HTTP price endpoints only). XDEX IS a
  Raydium-CPMM fork — pool state layout and AmmConfig layout decode 1:1 with
  raydium-sdk-v2's layouts (verified field-for-field against the live X1
  snapshot), and the swap instruction is byte-compatible with the Raydium
  SDK's CPMM `swap_base_input` builder. → Refactored to the Raydium SDK (§3).
- **Jupiter:** official SDK `@jupiter/api` exists — noted for the future live
  lane (no in-app assembly today). → **GRABBED** by `feat/grab-sdks` — actual
  npm name is `@jup-ag/api` 6.0.48 (`@jupiter/api` does not exist on npm) —
  see §9 + docs/SDK-REGISTRY.md.

## 3. REFACTORS LANDED

### 3a. xdexSwapLeg → @raydium-io/raydium-sdk-v2 (official Raydium SDK)
- `src/engine/legs/dex/xdexSwapLeg.js`: hand-assembled key list + raw
  discriminator/data concat replaced by
  `makeSwapCpmmBaseInInstruction(programId=XDEX, payer, authority, amm_config,
  pool, inputAta, outputAta, inputVault, outputVault, inputProgram,
  outputProgram, inputMint, outputMint, observation, amountIn, minOut)` —
  dynamic-imported (execute-path-only, Vite bundle discipline) with a cached
  module promise.
- Fail-closed drift canary: SDK account list must equal the LIVE-VERIFIED
  13-account order and the payload must be the verified 24 bytes
  (8fbe5adac41e33de + u64 LE pair) — a future Raydium SDK layout change throws
  instead of sending a broken ix.
- Fixture impact (sanctioned regeneration — dex-leg is this branch's phase):
  `test/fixtures/golden/dex-leg/xdex-step2-swap-ix.json` +
  `dex-leg-summary.json` regenerated via the capture tool. Delta: ONLY
  `ix.keys[0].isWritable` true→false (SDK shape) + meta note + artifact
  sha256. **`dataSha256` and `txSha256` are UNCHANGED** — the instruction
  bytes and the serialized tx are byte-identical to the pre-refactor pins and
  to the live anchor shape (proven: web3.js forces the fee-payer meta
  writable at message compile).
- Proof of acceptance: X1-mainnet simulation of the SDK-built ix, err:null,
  full swap execution (2026-09-06).
- Tests: goldenDex 8/8, engineDex 6/6.

### 3b. ERC-20 calldata → viem (official EVM SDK)
- `src/lib/lifiApproval.js`: `buildApprovalData` (approve) + new
  `buildAllowanceData` (allowance read) encode through viem's
  `encodeFunctionData`. Byte-identical output → golden step1 fixture, sha256
  byte references and all pinned calldata strings unchanged.
- Call sites updated: `src/engine/legs/forward/approvalLeg.js` (allowance
  read), `src/lib/teleportExecute.js` (reference path allowance read).
- Tests: lifiApproval 22/22.

### 3c. X1/Warp legs
No construction change — classified SDK-BASED-base + documented
program-specific layout (§1, §2). The SVM primitives (web3.js/spl-token) were
already the official path; nothing hand-rolled remains that an official SDK
covers.

## 4. DOCUMENTED AS UNAVOIDABLY / DELIBERATELY HAND-ROLLED

1. **Warp program layouts (forward+reverse)** — no official Warp/X1 SDK
   exists; layouts are IDL-extracted + live-tx-verified + fixture-pinned over
   the official SVM base.
2. **XDEX quote math** — app-side constant-product over the live pool
   snapshot (the SDK cannot parse the snapshot fixture — no raw account
   bytes; and quotes are market math, not tx bytes). Instruction construction
   is SDK-built (§3a).
3. **THORChain memo** — protocol data string; even the official xchainjs SDK
   takes memos as caller-supplied strings (verified v1.0.0 + v3.1.1). The
   deposit tx is out-of-band; no UTXO/XRP tx SDK in the money path. → The
   SDK family (`@xchainjs/xchain-thorchain` 3.1.1 + `xchain-client` 2.0.17)
   and the UTXO/XRP tx SDKs (`bitcoinjs-lib` 7.0.1, `xrpl` 5.1.0) are now
   **GRABBED** as readiness by `feat/grab-sdks` (§9) — available the day an
   in-app builder lands.
4. **LiFi REST-proxy pattern** — deliberate (server-side API key + server-side
   fee policy). `@lifi/sdk` would break the key boundary; if ever needed, run
   it server-side in the proxy.
5. **Rango execute stub** — rango-sdk requires the key client-side; the
   deliberate server-side-key proxy architecture keeps the SPA request-pinned.
   rango-sdk belongs in the future `api/rango/swap.js` proxy route. →
   **GRABBED** by `feat/grab-sdks` (`rango-sdk` 0.5.0, readiness module
   `sdkRango.js` — §9); wiring stays server-side when the proxy route lands.
6. **Wanchain execute stub** — no official Wanchain/XFlows SDK exists (raw
   HTTP API; upstream constructs the tx).

## 5. DEPENDENCY ADDITIONS + BUNDLE IMPACT

- `@raydium-io/raydium-sdk-v2@0.2.63-alpha` (+ transitive `bn.js` etc.) —
  the SAME package/version the parallel dex-official-sdk task adds (identical
  package.json line → clean merge). Dynamic-imported in the XDEX execute path
  only: the Vite main bundle does NOT grow; the SDK lands in a lazily-loaded
  chunk that loads only when an XDEX swap is constructed. Build verified
  green.
- viem: already a dependency — zero new weight for the approval refactor.
- No other dependency changes. `package-lock.json` regenerated (merge note for
  the parallel task: both branches touch package.json/lock — additive, same
  raydium line).

## 6. TEST + BUILD COUNTS

- Full suite: **960 tests → 960 tests (959 pass / 1 skipped — same as the v2
  baseline; 0 fail)** — see the run log. (Baseline v2: 960 tests, 959 pass,
  1 skipped.)
- `npm run build`: **green** (main bundle unchanged in size; raydium SDK is
  the async chunk).
- Fixture regeneration: only the xdex step2 fixture + dex-leg summary (delta
  explained in §3a); forward/reverse/thorchain golden fixtures untouched;
  dex-direct fixtures untouched (parallel task's).

## 7. COORDINATION WITH THE PARALLEL dex-official-sdk TASK

- No file overlap: that task owns `src/engine/legs/dexDirect/*` (+ its own
  tests/fixtures); this branch touches `src/engine/legs/dex/xdexSwapLeg.js`,
  `src/lib/lifiApproval.js`, `src/engine/legs/forward/approvalLeg.js`,
  `src/lib/teleportExecute.js`, `test/golden/dexLegBuilders.mjs`,
  `test/goldenDex.test.js`, `test/engineDex.test.js` (await-only),
  `tools/capture-dex-golden-fixtures.mjs` (await-only), the dex-leg fixtures,
  `docs/LEG-SDK-AUDIT.md`, `package.json`/`package-lock.json`.
- Shared-file merge notes: (a) `package.json` — both add
  `@raydium-io/raydium-sdk-v2@^0.2.63-alpha` (identical line) + the parallel
  task adds the uniswap/pancakeswap/orca SDKs; (b) `package-lock.json` —
  regenerate on merge; (c) `src/engine/routePlanner.js` is modified ONLY by
  the parallel task (its dexDirect route wiring) — this branch does not touch
  it; (d) dex-direct fixtures untouched here.
- Verification aid for the parallel task: the xdex refactor proves the
  Raydium-CPMM ix builder accepts a custom program id — the same
  `makeSwapCpmmBaseInInstruction` the raydium direct leg may use on mainnet
  with the real Raydium program id.

## 8. VERIFICATION EVIDENCE (2026-09-06, live X1 mainnet)

- X1 RPC `rpc.mainnet.x1.xyz` healthy (slot 76,979,897 → 76,980,264 during
  the work).
- XDEX program `sEsYH97…` unchanged; pool `CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR`
  live reserves read (USDC.x vault 3,060.27 / wXNT vault 8,627.01).
- SDK-built SwapBaseInput ix (payer readonly): simulated err:null, full swap
  executed (user -5.0 USDC.x, +14.279 wXNT out at 0.28% fee).
- Fixture-shape ix (payer writable): identical sim result — both accepted.
- sha256 checks: rebuilt fixtures byte-match; xdex dataSha256/txSha256
  unchanged across the refactor.

## 9. THE REMAINING SDKs — GRABBED (feat/grab-sdks, 2026-09-06)

Mr. Esters: "keep grabbing the other sdks." Every official SDK the roadmap
legs will need that was still PENDING in this audit is now GRABBED as
readiness scaffolding — dependency added, version VERIFIED on npm (no
guessed names: @tronweb3/tronweb, @jupiter/api, @mysten/sui.js and the old
cardano-serialization-lib line do NOT exist / are dead on npm — the registry
resolved the real current packages), and import-verified by offline smoke
tests. Full table: **docs/SDK-REGISTRY.md**. Readiness modules:
`src/lib/sdk/` (shared cached lazy loader `sdkLoader.js` + one module per
family; ⛔ NOT WIRED — nothing in the app imports them, no funds, no
broadcasts).

| SDK (npm) | Version (verified) | Leg it serves | Module |
|---|---|---|---|
| `xrpl` | 5.1.0 | XRPL source chain (in-app XRP leg) | `sdkXrp.js` |
| `tronweb` | 6.5.0 | TRON source chain | `sdkTron.js` |
| `@mysten/sui` (`./grpc`, `./utils`) | 2.29.0 | SUI source chain (non-deprecated SuiGrpcClient surface) | `sdkSui.js` |
| `@xchainjs/xchain-thorchain` + `@xchainjs/xchain-client` | 3.1.1 / 2.0.17 | future cosmos/thorchain legs (memo stays caller-supplied) | `sdkThorchain.js` |
| `@emurgo/cardano-serialization-lib-browser` | 17.0.0 | ADA (no rail today — grabbed ahead of a ruling) | `sdkCardano.js` |
| `@ton/ton` | 16.3.0 | TON source chain | `sdkTon.js` |
| `bitcoinjs-lib` | 7.0.1 | UTXO-native in-app tx builders | `sdkBitcoin.js` |
| `rango-sdk` | 0.5.0 | Rango execute lane (SERVER-side proxy route) | `sdkRango.js` |
| `@jup-ag/api` | 6.0.48 | Jupiter live lane (quote + swap-instructions) | `sdkJupiter.js` |

Bundle impact: ZERO — the readiness modules are unreferenced by the app
graph, so the Vite main bundle is byte-identical to the v2 baseline
(4,965.58 kB before AND after; verified in the branch build log). Each
module's lazy loader keeps future wiring on the dynamic-import pattern
(this audit's §3a raydium approach). Smoke tests: 31 assertions across
`src/lib/sdk/*.test.js`, all offline (no network, no keys, no funds) —
full suite count below unchanged except +31.

Merge notes: additive-only. Touches package.json/package-lock.json
(dependency lines only — the parallel dex-official-sdk task adds ITS SDKs
in the same files; npm reconciles), docs (this file + SDK-REGISTRY.md), and
the new `src/lib/sdk/*` + `tools/run-sdk-smoke.mjs`. Does NOT touch
`dexDirect/*`, engine legs, warpBridge, fixtures, or any instrument.
