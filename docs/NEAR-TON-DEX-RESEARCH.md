# NEAR + TON — DEX research, wallet connectors & swap-routing plan

> Status: **PLAN + research + registry + connectors.** No swap execution is
> wired in this pass. Every address below is either taken from the protocol's
> OWN SDK/docs (marked ✅ verified) or explicitly left unverified (fail
> closed). Nothing is guessed.
>
> Owner: Mr. Esters · Author: FrankyFyve · Date: 2026-09-29

---

## 0. Scope

This note covers four things:

1. **Wallet connectors** — connecting a user's NEAR wallet (NEAR Wallet
   Selector) and TON wallet (TON Connect) inside the Teleporter, session-only
   (address + balance), never signing.
2. **Native DEX venues** — the real NEAR + TON DEXes, recorded in the DEX
   registry (`src/lib/dex/registry.js`) as venues.
3. **Swap-routing plan** — how a connected NEAR/TON wallet would swap ANY
   token on its chain through its native DEX (quote → pool → build → sign).
4. **MEV integration plan** — how NEAR + TON join the capture-scan engine.

Execution (SDK + pool resolution + sign path) is the follow-up; this is the
honest, verified groundwork.

---

## 1. Wallet connectors

### 1.1 The wallet-family pattern (what "connect" means here)

Every family in the wallet layer is the same four-piece shape
(see `cardanoRegistry.js` + `cardanoDiscovery.js`, the newest template):

| Piece | File | Role |
| --- | --- | --- |
| Registry | `src/lib/wallet/<fam>Registry.js` | the frozen, ordered wallet table the modal renders |
| Discovery | `src/lib/wallet/<fam>Discovery.js` | `create<Fam>Discovery({...})` → `{ start, stop, getInstalled, getProvider }` — DI-clean, no SDK import |
| Browser factory | `src/lib/wallet/<fam>Selector.js` / `<fam>Connect.js` | the ONE module that imports the real SDK (app-only; never imported by tests) |
| Balance | `src/lib/wallet/<fam>Balance.js` | optional best-effort balance reader (DI-clean fetcher) |

`createWalletDiscovery` (`src/lib/wallet/walletDiscovery.js`) composes every
discovery into the single handle the `WalletContext` + connect modal share;
`WalletContext.jsx` keeps ONE session per family; `modalLogic.js` maps
discovered keys onto registry rows.

**Session-only, never sign.** Connect = the wallet's own connect handshake →
the account address (+ best-effort balance). No transaction, message, or
payload is signed by the connector layer. Signing a swap is the (later) swap
step.

### 1.2 NEAR — NEAR Wallet Selector

**Packages added** (verified on npm 2026-09-29, current line 10.1.4):

- `@near-wallet-selector/core`
- `@near-wallet-selector/my-near-wallet`
- `@near-wallet-selector/meteor-wallet`
- `@near-wallet-selector/sender`
- `@near-wallet-selector/ledger`
- `@near-wallet-selector/nightly`

**Files:**

- Registry — `src/lib/wallet/nearRegistry.js`
  Rows: Starport (pinned, not-yet-wired → fail closed) → **MyNearWallet
  (reference)** → Meteor / Nightly / Sender (software, alpha) → Ledger
  (hardware) → **deposit-address row (always last, never connectable)**.
  `NEAR_WALLET_IDS` are EXACTLY the selector module ids
  (`my-near-wallet`, `meteor-wallet`, `sender`, `nightly`, `ledger`) so
  discovery keys == registry ids.
- Discovery — `src/lib/wallet/nearDiscovery.js`
  `createNearDiscovery({ selector, contractId, balanceFetcher, onChange })`.
  **Connect:** reads `selector.store.getState().modules` (the connectable set —
  the selector's module factories resolve to `null` when a wallet is absent),
  filters `metadata.available === false`, then
  `selector.wallet(id).signIn({ contractId })` → `accounts[0].accountId` →
  best-effort balance. The `selector` may be a resolved object OR a promise
  (the real setup is async) — `start()` awaits the promise and re-scans.
- Browser factory — `src/lib/wallet/nearSelector.js`
  `createNearWalletSelector({ network:"mainnet", contractId })` →
  `setupWalletSelector({...})` with the five modules. Returns `null` when no
  window. **Browser-only** (never imported by node:test).
- Balance — `src/lib/wallet/nearBalance.js`
  `createNearBalanceFetcher({ rpcUrl, fetchImpl })` → NEAR JSON-RPC
  `query`/`view_account` → yoctoNEAR (`BigInt`). Default RPC
  `https://rpc.mainnet.near.org`.
- Tests — `src/lib/wallet/nearDiscovery.test.js`,
  `src/lib/wallet/nearBalance.test.js` (fake selector / fake fetch injected).

**Wiring:** `families.js` (added `near`), `walletDiscovery.js`
(EMPTY_DISCOVERED + snapshot + start/stop + `getProvider("near", …)`),
`WalletContext.jsx` (empty session entry), `modalLogic.js`
(`near: NEAR_WALLETS` + `normalizeNearDiscovered`), `components/ConnectModal.jsx`
(discovered-item switch), `mockProviders.js` (mock address), `main.jsx`
(injects the real selector + balance fetcher).

#### Fail-closed fallback
If no NEAR module is available (browser-less, no wallet, selector setup
failure), `getInstalled()` returns `[]` and `getProvider("near", …)` returns
`null`. The modal then shows the **deposit-address row** (NEAR is a ChangeNOW
long-tail deposit chain) — never a dead Connect button. The pinned Starport
row always renders but its NEAR module is not wired → same fallback.

### 1.3 TON — TON Connect

**Package added:** `@tonconnect/ui` (3.0.2).

**Files:**

- Registry — `src/lib/wallet/tonRegistry.js`
  Rows: Starport (pinned, not-yet-wired) → **Tonkeeper (reference)** →
  MyTonWallet / Telegram Wallet / Tonhub (software, alpha) →
  **deposit-address row (always last)**. `TON_WALLET_IDS` are EXACTLY the TON
  Connect wallet `appName`s (`tonkeeper`, `mytonwallet`, `telegram-wallet`,
  `tonhub`) — verified against the official
  `ton-blockchain/wallets-list` `wallets-v2.json`.
- Discovery — `src/lib/wallet/tonDiscovery.js`
  `createTonDiscovery({ tonConnect, balanceFetcher, onChange })`.
  **Connect:** `getWallets()` (the connectable set — TON Connect has no
  separate "installed" signal; the wallet app is the install) →
  `handle.connect(walletId)` (opens TON Connect's modal for that wallet) →
  account address → best-effort balance. `tonConnect` may be an object OR a
  promise.
- Browser factory — `src/lib/wallet/tonConnect.js`
  `createTonConnectHandle({ manifestUrl, ui })` → wraps a `TonConnectUI`
  instance in the DI shape (`getWallets`, `onStatusChange`, `connect`,
  `disconnect`). Returns `null` when there is no window **OR no manifestUrl**
  (fail closed — TON Connect requires a hosted
  `/tonconnect-manifest.json`; we do NOT guess one).
- Balance — `src/lib/wallet/tonBalance.js`
  `createTonBalanceFetcher({ endpoint, apiKey, fetchImpl })` → toncenter
  `getAddressBalance` → nanoTON (`BigInt`). Default
  `https://toncenter.com/api/v2`.
- Tests — `src/lib/wallet/tonDiscovery.test.js`,
  `src/lib/wallet/tonBalance.test.js`.

**Wiring:** same matrix as NEAR (`families.js`, `walletDiscovery.js`,
`WalletContext.jsx`, `modalLogic.js`, `ConnectModal.jsx`, `mockProviders.js`,
`main.jsx`).

#### UX caveat (documented, honest)
TON Connect is a **bridge protocol**: the dApp and the wallet app talk over a
bridge, and the connect UX (QR code / universal link / deep link) is
wallet-app-owned — it does not fit a browser-extension popup model. The
adapter therefore **delegates the last mile to TON Connect's own modal**
(`openSingleWalletModal(appName)` → `openModal()`) rather than faking a popup.
Mounting TON Connect's web-component button directly inside the bridge's
one-card connect modal is a UI follow-up; until then the honest path is:

1. The bridge's connect modal lists the wallet rows (registry).
2. Choosing one hands off to TON Connect's modal (the bridge's own modal
   closes / yields).
3. If TON Connect is not wired (no manifest), the row falls through to the
   **deposit-address row**.

#### Fail-closed fallback
No TON Connect handle (no window / no manifest) → `getInstalled()` returns
`[]`, `getProvider("ton", …)` returns `null` → deposit-address row. Never a
dead Connect button.

### 1.4 Isolation

NEAR wallets never appear in the EVM/Solana lists and vice-versa (discovery is
per-`createNearDiscovery` / `createTonDiscovery`, composed under distinct
snapshot keys). `noWindowProbe.test.js` still passes: neither module reads any
banned injected global (the SDK factories are browser-only and outside its
scan surface — and they only touch `window` defensively via
`typeof window === "undefined"`).

---

## 2. Native DEX venues (registry)

Added to `src/lib/dex/registry.js` under the new chain keys `near` and `ton`
(family keys `"near"` / `"ton"`, matching the wallet families). Fail-closed:
`venuesFor(chain)` only returns rows with `verified && router !== null`.

### NEAR

| DEX | Protocol | Router / entry point | Verified | Source |
| --- | --- | --- | --- | --- |
| **Ref Finance** | AMM (v2 exchange) | `v2.ref-finance.near` | ✅ | `@ref-finance/ref-sdk` config `REF_FI_CONTRACT_ID` |
| **Trisolaris** | AMM (UniV2 fork, **Aurora** EVM L2) | `0x2CB45Edb4517d5947aFdE3BEAbF95A582506858B` | ✅ | `@trisolaris/sdk` `ROUTER_ADDRESS[ChainId.AURORA]` (factory `0xc66F594268041dB60507F00703b152492fb176E7`) |
| Jumbo Exchange | AMM | — | ❌ unverified | no authoritative contract from an official source |
| Orderly Network | Orderbook (clob) | — | ❌ unverified | off-chain book + on-chain settlement; no official address located |
| Spin | AMM | — | ❌ unverified | no authoritative program id located |

> Note: Trisolaris runs on **Aurora** (NEAR's EVM-compatible L2), so its
> entry point is an EVM router — kept in the `near` family per the owner's
> chain grouping. It would route through the EVM leg mechanics, not a NEAR
> action set.

### TON

| DEX | Protocol | Router / entry point | Verified | Source |
| --- | --- | --- | --- | --- |
| **STON.fi** | AMM | `EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt` | ✅ | `@ston-fi/sdk` `ROUTER_ADDRESS` (v1 Router) |
| **DeDust** | AMM (Vault/Pool) | `EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67` (Factory = entry point; no router) | ✅ | `@dedust/sdk` `MAINNET_FACTORY_ADDR` |
| Megaton Finance | AMM | — | ❌ unverified | no authoritative address located |
| TONCO | AMM | — | ❌ unverified | confirmed live (referenced by STON.fi Omniston) but no official address located |

> DeDust has **no single Router**: swaps enter via per-asset Vaults located by
> the Factory, so the Factory IS the canonical entry-point program (recorded as
> both `router` and `factory`).

Registry tests: `src/lib/dex/registry.test.js` (added assertions for the
verified near/ton venues + the unverified fail-closed rows).

---

## 3. Swap-routing plan (per chain)

Execution is the **follow-up**; this documents the full path so the swap leg
can be built without guessing. Target: swap ANY token (gas token + every
jetton/NEP-141/EP-141/NEP-245 token on the chain) via the native DEX, signed by
the connected wallet.

### 3.1 Reference targets + fallbacks

- **NEAR → Ref Finance** (reference). Fallbacks: Jumbo → Trisolaris (Aurora).
- **TON → STON.fi** (reference). Fallbacks: DeDust → TONCO → Megaton.

### 3.2 The four-stage path

```
quote  →  pool resolution  →  build swap tx  →  sign (connected wallet)
```

#### NEAR (Ref Finance)

1. **Quote** — either the Ref indexer API (`https://api.ref.finance/`, the
   public pricing/indexer endpoint) or on-chain view calls against
   `v2.ref-finance.near`:
   `get_return` / `get_pools` / `get_pool`. `@ref-finance/ref-sdk` wraps both
   (`estimateSwap`, `getPoolByIds`).
2. **Pool resolution** — `v2.ref-finance.near` view `get_pool([token0,
   token1])` (token ids are NEP-141 account ids; native NEAR is `wrap.near`).
   The ref-sdk's `getPoolByIds` maps a pair → pool id.
3. **Build** — ref-sdk `executeSwap` produces the action list; the modern
   flow is an `ft_transfer_call` into `v2.ref-finance.near` carrying the swap
   payload (native NEAR is wrapped to `wrap.near` first). Output is a NEAR
   transaction.
4. **Sign** — `selector.wallet(id).signAndSendTransaction({ actions })`
   (NEAR Wallet Selector) — the connected wallet signs and submits.

**Gas-token routing:** NEAR (via `wrap.near`) is the universal base pair in
Ref pools, so any-token ↔ any-token routes through the NEAR/wNEAR pool leg(s).

**SDKs:** `@ref-finance/ref-sdk` (quotes + builders) + `@near-js/*`
(`@near-js/transactions`, `@near-js/signers` — re-exported by
`@near-wallet-selector/core`) for serialization; signing via the selector.

#### TON (STON.fi)

1. **Quote** — `@ston-fi/sdk` `Pool.getExpectedOutputs(...)` /
   `getSwapEstimate`, or the STON.fi API (`api.ston.fi` pool/swap endpoints).
2. **Pool resolution** — `Router.getPoolAddressByJettonMinters(token0,
   token1)` / `get_pool_address`. Native TON is represented by **proxyTON**
   (pTON); the SDK resolves the pTON contract for the router revision.
3. **Build** — the SDK's tx-param builders return `{ to, value, body }`:
   - `getSwapJettonToJettonTxParams`
   - `getSwapJettonToTonTxParams`
   - `getSwapTonToJettonTxParams`
   - `getSwapTonToTonTxParams`
   (swap op `0x25938561` on the v1 Router).
4. **Sign** — `tonConnectUI.sendTransaction({ validUntil, messages })`
   (TON Connect) — the connected wallet signs and submits.

**Gas-token routing:** TON (via pTON) is the base pair; jetton↔jetton swaps
route jetton→pTON→jetton.

**SDKs:** `@ston-fi/sdk` (quotes + builders) + `@ton/core` + `@ton/ton`
(`TonClient`, address parsing — already pinned `@ton/ton@16.3.0` in the repo,
see `src/lib/sdk/sdkTon.js`) + `@tonconnect/ui` for signing.

**DeDust fallback:** `@dedust/sdk` — `Factory.getNativeVault()` /
`Factory.getPool(PoolType.VOLATILE, [TON, jetton])` →
`vault.sendSwap(sender, { poolAddress, amount, gasAmount })`
(jetton route: `VaultJetton.createSwapPayload`). Signing via TonConnect.

### 3.3 New engine legs (follow-up)

- `nearSwapLeg` — mirrors the existing `dexDirect` legs
  (`src/engine/legs/dexDirect/*`): resolves the pool, builds the swap, and
  submits through the connected NEAR session (`connectedSessions.js` +
  a NEAR provider resolver, the analogue of `sessionProviders.js`).
- `tonSwapLeg` — same shape, submitting through the connected TON Connect
  session.
- Both stay **dead-gated** exactly like the existing legs
  (`DexDirectLiveTestGateError` discipline — no autonomous broadcast at any
  flag value).

---

## 4. MEV integration plan

NEAR + TON must be able to join the capture-scan engine the same way
EVM/Solana do. Below are the EXACT seams (plan only — no execution).

### 4.1 Where the engine declares its scan chains

| Seam | File:line | What it is |
| --- | --- | --- |
| `CAPTURE_SCAN_CHAINS` | `src/engine/routePlanner.js:778` | the chain list the capture scan consults — **add `"near"` + `"ton"` here** |
| `CAPTURE_CANDIDATES` | `src/engine/routePlanner.js:760` | per-family venue lists, derived from `DEX_DIRECT_FALLBACKS` — **add `near`/`ton` family blocks** |
| `DEX_DIRECT_FALLBACKS` | `src/engine/routePlanner.js:669` | the engine's own candidate ordering (aggregator first) — **add `near`/`ton` blocks** |
| `captureCandidatesForChain` | `src/engine/routePlanner.js:788` | currently dispatches `evm` vs `svm`; **add a `near`/`ton` dispatch** (or generalise the family lookup) |

### 4.2 Capture-gap detection across their DEXes

The detector math is **chain-agnostic** already — it consumes per-venue
quotes (`{ venue, amountIn, amountOut }`) and needs no chain-specific code:

- **Same-pair round trip** — `runCaptureScan` (`src/lib/mev/captureGate.js`)
  → `gapDetector.js` (`detectCaptureGap`): quote the SAME pair on Ref Finance
  vs Jumbo (NEAR) / STON.fi vs DeDust (TON), buy on the cheap venue, sell on
  the dear one, net out fees+gas.
- **Multi-hop route choice** — `runRouteCaptureScan` (`captureGate.js`) →
  `routeAnalyzer.js` (`analyzeRoute`): per-hop venue deltas (best venue vs the
  routed venue) accumulated across a journey.
- **Feed:** the routing hook `observeCaptureForSwap` /
  `observeRouteCapture` (`routePlanner.js`) calls the scanners whenever the
  engine already holds multi-venue quotes for a planned NEAR/TON route — pure
  observation at every gate state, never an executable trade.

For NEAR/TON this requires the per-venue quote producers (Ref indexer API /
STON.fi API) to be wired as quote sources — that is the same follow-up as the
swap legs (3.3).

### 4.3 Payout config shape (per-chain treasuries)

`src/lib/mev/payoutConfig.js` — the deposit-only treasury design:

- Add two groups to `MEV_PAYOUT_GROUPS_DEFAULT`:
  - `near` — family `"near"`, chains `["near"]`, a NEAR deposit-only address,
    **validated by a NEAR account-id format check** (lowercase, `.near`/hex,
    2–64 chars) — a new `assertValidTreasuryAddress` branch.
  - `ton` — family `"ton"`, chains `["ton"]`, a TON friendly address,
    validated by a **TON address format check** (base64url `EQ…`/`UQ…`, 48
    chars) — a new branch.
- Add `CHAIN_FAMILY` entries `near → "near"`, `ton → "ton"` (so
  `resolvePayoutConfig` accepts the chains).
- `BASKET_TARGETS`: leave **empty** for both (`near: {}`, `ton: {}`) until a
  canonical basket member resolves on the chain — captures drop **as-is**
  (`dropAsIsRecords`) into the per-chain treasury; the sweep is a later
  decision. Fail closed: a chain with no treasury address cannot drop
  anywhere (the ledger record builder already refuses).
- Addresses are **not guessed** — the NEAR/TON treasury destinations must be
  supplied by Mr. Esters (env override path `VITE_MEV_PAYOUT_NEAR` /
  `VITE_MEV_PAYOUT_TON`, mirroring `VITE_MEV_PAYOUT_EVM`).

### 4.4 Gate

The capture gate (`MEV_CAPTURE_ENABLED`, `captureGate.js`) is unchanged:
default **OFF** → detection-only. Even armed, the only artifact is a
wallet-sign request through the guarded legs — no autonomous broadcast exists
at any flag value.

---

## 5. Verification & fail-closed discipline

- Every address marked ✅ came from the protocol's **own** package/config
  (`@ref-finance/ref-sdk`, `@trisolaris/sdk`, `@ston-fi/sdk`, `@dedust/sdk`)
  or the official `ton-blockchain/wallets-list`. Anything without an
  authoritative source is `verified:false`, `router:null` — and the engine
  skips it.
- The deposit-address row is ALWAYS the final row in the NEAR + TON connect
  modals; discovery never returns a dead provider (unavailable → `null` →
  deposit fallback).
- No signing is wired anywhere in this pass.

### Files touched (summary)

**New:** `nearRegistry.js`, `nearDiscovery.js`, `nearSelector.js`,
`nearBalance.js`, `tonRegistry.js`, `tonDiscovery.js`, `tonConnect.js`,
`tonBalance.js`, `nearDiscovery.test.js`, `tonDiscovery.test.js`,
`nearBalance.test.js`, `tonBalance.test.js`, `docs/NEAR-TON-DEX-RESEARCH.md`.

**Edited:** `families.js`, `walletDiscovery.js`, `WalletContext.jsx`,
`modalLogic.js`, `memoRule.js`, `mockProviders.js`, `components/ConnectModal.jsx`,
`main.jsx`, `package.json`, `walletDiscovery.test.js`, `walletReducer.test.js`,
`ConnectModal.test.jsx`, `src/lib/dex/registry.js`, `src/lib/dex/registry.test.js`.
