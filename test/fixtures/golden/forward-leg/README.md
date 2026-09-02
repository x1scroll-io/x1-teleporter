# Golden-transaction fixtures — forward leg ETH→X1 (the regression oracle)

Tool 1 for the routing-engine migration. These fixtures capture the EXACT
transactions the CURRENT reference forward leg (ETH → X1) constructs —
serialized byte-for-byte — so the routing engine can be proven correct: it
must reproduce them exactly, or `test/golden.test.js` fails.

## Files

| File | Step | What it captures |
|---|---|---|
| `quote-eth-sol-usdc-25.65.json` | INPUT | The FROZEN live LiFi quote (Relay route, 25.65 USDC ETH→SOL, captured 2026-09-02 via the stable v2 proxy `/api/lifi/quote`). Stands in for the LiFi network so everything is reproducible offline. The stage-1 EVM bridge calldata rides inside it (`transactionRequest`) — the engine must pass the quote through UNCHANGED. |
| `step1-approval.json` | 1 | The EXACT-amount ERC-20 approval — `approve(LiFi Diamond, 25,650,000)` calldata + the `eth_sendTransaction` params the leg sends (PR #3 shape: never MaxUint256). |
| `step2a-x1-ata-prep.json` | 2a | The X1 recipient ATA create tx (idempotent, Token-2022, payer = user) the leg broadcasts on X1 BEFORE the Solana lock — the bridge_in_v2 prerequisite. Serialized unsigned (base64) + sha256. |
| `step2b-warp-lock.json` | 2b | The stage-2 Solana lock tx: ComputeBudget(60k) + the 1% skim SPL transfer (user → fee wallet) + Warp `BridgeOut(seq, bridgeBase)` — one transaction, serialized unsigned (base64) + sha256. |
| `step3-bridge-in-v2.json` | 3 | The `WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC` (14 rows) serialized canonically (`specSha256`) + the concrete wrapped-USDC.x account list (11 offline-derivable keys in spec order — the vault pair is native-only and omitted; `signature_set` is guardian-signed and recorded as its seed template). |
| `forward-leg-summary.json` | — | Sample input, derived amounts, per-step sha256s, the stage-1 bridge-calldata reference sha256, and the quote-box display strings computed by the REAL fee code (the browser harness asserts against these). |

## Fixed sample input (deterministic, offline)

```json
{
  "from": "eth", "token": "USDC", "destToken": "USDC.x",
  "amountUser": 25.65,
  "evmAddress": "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6",
  "solanaAddress": "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV",
  "feeWalletSvm": "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu",
  "liFiDiamondEth": "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
  "blockhash": "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
  "seqSlot": 305000000
}
```

All wallet addresses are the repo's own test constants (warpBridge `USER` /
`FEE_WALLET`, teleportQuote `EVM_ADDR`) — reproducible offline, no live wallet.

Derived from the frozen quote: LiFi delivers **25.554929 USDC** to Solana
(`estimate.toAmount` 25554929); stage 2 skims **1% = 255549 base** and locks
**25299380 base** via BridgeOut.

## Per-step sha256 (2026-09-02 capture)

| Step | sha256 (canonical artifact) | sha256 (serialized bytes, SVM steps) |
|---|---|---|
| step1 approval | `3f62ee2a8487aa8a2dcd14118767c5300d61f15252ec1aa2d25ea9ec6379749b` | — (calldata hex is the artifact) |
| step2a X1 ATA prep | `d094b94ebd064215b0b8efc9791853a58a6ccb016e2cf24f5f77a6efa9faef04` | `4ea287a431e06952f0544bd0b83886b0b7b50ee1bd4f11603e2eb0269384559e` |
| step2b Warp lock | `84f4d2173d817ec586a943d08fd21e89a99965b78199a471fcf6d0a4907a5e17` | `296b3994972879a6a48c4c965308695e1db8d2f2ae111138a582350644d348a3` |
| step3 bridge_in_v2 | `ff40e375daa872ff2369b3f20035f33819508fe7806d88b432c334c883771576` (account list) | `specSha256` (14-row spec): see the fixture file |
| quote (stage-1 bridge calldata reference) | `40355dc3aebbbab33586c91d4961bfe4210cdee8ca7a4b484d514909ec210c54` | sha256 of `transactionRequest.data` bytes |

## How the engine is verified against these

1. `npm test` — `test/golden.test.js` REBUILDS each step from the same inputs
   (shared builders in `test/golden/forwardLegBuilders.mjs` — the capture
   script and the test use the SAME module, so they cannot drift) and asserts
   byte-identity: canonical artifact equality, sha256 match, and — for the
   SVM transactions — the raw serialized-byte sha256.
2. When the routing engine replaces the forward leg, it must produce the
   same transactions for the same inputs. The engine ships when
   `test/golden.test.js` passes UNCHANGED (do not weaken the assertions) and
   the browser harness (`e2e/forward-leg.spec.js`) still passes UNCHANGED.
3. `forward-leg-summary.json` is the human-readable single source: sample
   input, derived amounts, quote-box display strings, sha256 per step.

## Regenerating

```bash
node --import ./tools/jsx-loader.mjs tools/capture-golden-fixtures.mjs
```

(The frozen quote fixture is INPUT — only re-capture it deliberately, with a
note of the new quote's tool/amounts, since the oracle is about tx
construction given the same quote.)
