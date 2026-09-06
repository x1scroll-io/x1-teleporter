# SDK REGISTRY — every official SDK, its version, the leg it serves

Branch: `feat/grab-sdks` (off `v2` @ be72bde) · 2026-09-06 · additive, readiness-only.

Mr. Esters' standing rule: EVERY chain/protocol integration uses the OFFICIAL
SDK — never hand-rolled calldata/instructions (correct by construction,
maintained by the protocol team). This registry is the single table of every
official SDK in the x1-teleporter v2 tree: what it serves, which module pins
it, and its import status. Versions were VERIFIED on the npm registry
2026-09-06 (`npm view <pkg> version` / probing the installed package's real
export surface) — nothing here is guessed; package names that do NOT exist on
npm (@tronweb3/tronweb, @jupiter/api, @mysten/sui.js, cardano-serialization-lib
as a maintained line) were resolved to their real current equivalents.

Import-status legend:
- **IN USE** — statically imported by the app's money path today.
- **DYNAMIC** — lazy `import()` on the execute path only (heavy-SDK bundle
  discipline; never in the Vite main bundle).
- **GRABBED (readiness)** — dependency added + version-pinned + import-
  verified by the `src/lib/sdk/*` smoke tests; NOT wired into any flow (the
  future leg imports the module when it lands).
- **IN FLIGHT** — owned by a parallel task (dexDirect SDKs), not landed here.

---

## A. GRABBED THIS BRANCH (readiness scaffolding — `src/lib/sdk/`)

| # | SDK (npm) | Verified version | Roadmap leg it serves | Readiness module | Import status |
|---|---|---|---|---|---|
| 1 | `xrpl` | 5.1.0 | XRPL source chain — future in-app XRP leg (balance + tx build). Today XRP = THORChain deposit-address source (out-of-band wallet tx) + Rango rail source. | `sdkXrp.js` | GRABBED — `loadXrplSdk`, `deriveXrpAddress`, `getXrpBalance` |
| 2 | `tronweb` | 6.5.0 | TRON source chain — future in-app TRON leg (balance + tx build). (The app's `@tronweb3/tronwallet-adapters` are the wallet-CONNECT layer — different thing.) | `sdkTron.js` | GRABBED — `loadTronwebSdk`, `createTronClient`, `getTronBalance`, `isTronAddress` |
| 3 | `@mysten/sui` (subpaths `./grpc`, `./utils`) | 2.29.0 | SUI source chain — future in-app Sui leg (balance via the non-deprecated `SuiGrpcClient`). `@mysten/sui.js` is DEPRECATED (renamed); root export removed in 2.x — subpath imports only. | `sdkSui.js` | GRABBED — `loadSuiClientSdk`/`loadSuiUtilsSdk`, `createSuiClient`, `getSuiBalance`, `isValidSuiAddress` |
| 4 | `@xchainjs/xchain-thorchain` + `@xchainjs/xchain-client` | 3.1.1 / 2.0.17 | Future cosmos/thorchain in-app legs. Audit verdict stands: the deposit MEMO stays a caller-supplied string from `src/lib/thorchain/memo.js` — the SDK never builds memos. | `sdkThorchain.js` | GRABBED — `loadThorchainSdk`/`loadXchainClientSdk`, `thorchainClientClass`, `xchainBaseClientClass` |
| 5 | `@emurgo/cardano-serialization-lib-browser` | 17.0.0 | ADA — honest status: NO quotable rail in [THORChain, Rango, Wanchain] today (docs/ROUTING-ENGINE.md §10/§11). Grabbed ahead of a rail ruling. (-browser twin: SPA-correct AND imports/executes under the Node test harness; the old monolithic `cardano-serialization-lib` died at 10.0.0-beta.16 in 2022.) | `sdkCardano.js` | GRABBED — `loadCardanoSdk`, `cardanoAddressFromBech32`, `deriveCardanoAddress` |
| 6 | `@ton/ton` | 16.3.0 | TON source chain — future in-app TON leg (address, balance, v4-wallet tx build). Rango chain list includes TON ✅. | `sdkTon.js` | GRABBED — `loadTonSdk`, `parseTonAddress`, `getTonBalance`, `createTonV4Wallet` |
| 7 | `bitcoinjs-lib` | 7.0.1 | UTXO-native in-app tx builders (BTC/DOGE/LTC) — the audit's "if an in-app deposit-tx builder ever lands, these become the SDKs". Balances stay on the wallet-provider layer (laser-eyes/registry). | `sdkBitcoin.js` | GRABBED — `loadBitcoinSdk`, `buildPayment`, `newPsbt`, `btcAddressFromPubkey` |
| 8 | `rango-sdk` | 0.5.0 | Rango EXECUTE lane — SERVER-side only (the future `api/rango/swap.js` proxy wraps `RangoClient`; the SPA never holds the key — audit §4.5). | `sdkRango.js` | GRABBED — `loadRangoSdk`, `createRangoClient`, `getRangoBestRoute`, `createRangoTransaction` |
| 9 | `@jup-ag/api` | 6.0.48 | Jupiter LIVE lane — when the lane assembles the swap response into a tx it uses this SDK (`createJupiterApiClient` → `quoteGet`/`swapInstructionsPost`) + `@solana/web3.js` + the sim gate (audit §1 dex row). | `sdkJupiter.js` | GRABBED — `loadJupiterSdk`, `createJupiterClient`, `getJupiterQuote`, `getJupiterSwapInstructions` |

All nine modules share the cached lazy loader `sdkLoader.js`
(`makeSdkLoader(spec, { exports })`) — dynamic `import()`, cached promise,
fail-closed export-shape check (a future SDK rename/removal throws LOUDLY at
load time, the same drift-canary philosophy as the XDEX 13-account check),
reset-on-transient-failure. Every module header records the verified export
surface + the leg it serves + the ⛔ NOT WIRED boundary.

Smoke tests (`src/lib/sdk/*.test.js`, 31 assertions, all offline — no
network, no keys, no funds) prove: the SDK resolves under the repo's Node
harness, the pinned exports exist, wrapper functions exist, and — where the
SDK allows — a real offline micro-operation executes (xrpl keygen,
tronweb construction, SuiGrpcClient construction, CSL wasm address
derivation + bech32 roundtrip, TON v4 wallet + parse roundtrip, bitcoinjs
p2wpkh derivation + PSBT, Rango/Jupiter client construction).

## B. ALREADY IN THE MONEY PATH (pre-existing, for completeness)

| SDK (npm) | Version | Serves | Where | Import status |
|---|---|---|---|---|
| `@solana/web3.js` | ^1.95.0 | X1/SVM primitives — the official X1 SDK (X1 = SVM-compatible) | warpBridge, engine legs, wallet discovery, dexDirect | IN USE + DYNAMIC (`lifiSolanaTx.js` lazy-imports) |
| `@solana/spl-token` | ^0.4.8 | SPL/Token-2022 transfers + ATAs | warpBridge, dexDirect | IN USE |
| `viem` | ^2.56.0 | EVM calldata (approve/allowance — audit §3b) | `lifiApproval.js` | IN USE |
| `@raydium-io/raydium-sdk-v2` | ^0.2.63-alpha | XDEX swap ix (Raydium-CPMM fork on X1) — audit §3a | `dex/xdexSwapLeg.js` | DYNAMIC (execute path only; added by audit #65) |

## C. IN FLIGHT — OWNED BY THE PARALLEL `feat/dex-official-sdk` TASK

The dexDirect legs (`src/engine/legs/dexDirect/*` — Uniswap v3 /
PancakeSwap v3 / Raydium / Orca) are that task's files; its SDK set
(`@uniswap/sdk-core` + `@uniswap/v3-sdk`, `@pancakeswap/sdk` +
`smart-router` + `universal-router-sdk`, `@raydium-io/raydium-sdk-v2`,
`@orca-so/whirlpools-sdk`) lands with it (uncommitted in its worktree as of
2026-09-06; same raydium line as audit #65 → additive merge). **This branch
does not touch `dexDirect/*` or add those packages.**

## D. BUNDLE DISCIPLINE — PROVEN

`src/lib/sdk/*` is imported by NOTHING in the app graph (readiness only), so
the Vite build is byte-identical to the v2 baseline: main bundle
`index-*.js` 4,965.58 kB BEFORE (be72bde) vs 4,965.58 kB AFTER this branch —
zero growth (see the branch's build log). When a future leg wires a module,
its loader's dynamic `import()` puts the SDK in a lazily-loaded chunk (the
audit's raydium pattern — main bundle still does not grow). New dependency
weight exists only in `node_modules` + the lockfile, never in what the user
downloads.
