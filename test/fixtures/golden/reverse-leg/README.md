# Golden-transaction fixtures — reverse leg X1→ETH (the regression oracle, Phase 2)

Tool 1 for the Phase-2 routing-engine migration. These fixtures capture the
EXACT artifacts the CURRENT reference reverse leg (X1 → EVM) constructs —
serialized byte-for-byte — so the routing engine can be proven correct: it
must reproduce them exactly, or `test/goldenReverse.test.js` fails.

**Ground truth** (captured 2026-09-02 from last night's WORKING reverse run —
the one that delivered USDC to Ethereum; Ethereum balance went 82.92 →
122.20):

| Leg | Live transaction |
|---|---|
| X1 burn (skim + Warp bridge_out, 0.4 wSOL.X, net 0.39501) | `3q7H3kV4ZrrUPEbQ37DQv1cWRNmJ2V4pSMYZV3xCDYr8VrD58YZV9irDiveeCaYVmBqCxTu3cmxrXhepgJxegPe1` (slot 75951086) |
| Solana release (bridge_in_v2, 5/5 sigs, OFFICIAL submitter path) | `v6etkXX21dQdfeZf6TabWMv16PEQoKBLhHPEQGnriSkcRRkUgfYkb5jAd2q8KCwuHxSwyYqGExb4PY4rHCGszbk` (slot 443613057, vault debited exactly 395,010,000) |
| LiFi WSOL→USDC-on-ETH (the #43 submit-fix shape) | `25fvaCmtgb4EKhwETLgXG3npQqgHcJeGo6VyXxJXMMBtgrhv94ejs2jXSZt8L6NThzuQvBxi2Azt2fwwJhkRRd6q` — receiving leg `0xaf0f3546ec52b349dafb1e9de863e690689ba6562b074b63fb1dd94e07c85284` on ETH, toAddress = the EVM wallet `0x1870aFAfA502223f6F70b6DDB93dc4099C86C239` |

## Files

| File | Step | What it captures |
|---|---|---|
| `quote-wsol-usdc-eth-0.39501.json` | INPUT | The FROZEN live LiFi quote (relaydepository route, 0.39501 WSOL → USDC on Ethereum, captured 2026-09-02 via the stable v2 proxy `/api/lifi/quote` with toAddress = the pinned EVM destination). Stands in for the LiFi network so everything is reproducible offline. The executable Solana tx rides inside it (`transactionRequest.data`, base64). |
| `step1-x1-burn.json` | 1 | The X1 reverse burn tx: the 1% skim Token-2022 transfer (user → the fee wallet's wSOL.X ATA `8YxSUo3…` — the SAME ATA the live burn transferred to) + Warp `BridgeOut(seq, 396,000,000)` in ONE transaction (wSOL.X 9-dec, token-aware 25bps fee account). Serialized unsigned (base64) + sha256. |
| `step2-release-shape.json` | 2 | The app's side of the Solana release contract: the `WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC` (14 rows) serialized canonically (`specSha256`) + the NATIVE-variant derivable account list (11 offline-derivable keys in spec order — the vault pair is INCLUDED, `mint_authority` is the program-self placeholder) + the expected release math. The release tx itself is SUBMITTER-constructed (official submitter + guardians): `signature_set` / `incoming_msg` / `payer` (+ the bundled recipient-ATA create) are documented as templates, never guessed. |
| `step3-lifi-out.json` | 3 | The deterministic LiFi query (`buildReverseLifiQuoteParams`) with the **PINNED EVM destination** (`toAddress = 0x1870aFAfA…` — the #44 display value): fromToken WSOL (9-dec), toToken USDC on eth, fromAmount 395,010,000, x1-class (no fee param). |
| `reverse-leg-summary.json` | — | Sample input, derived amounts (skim 4,000,000 / bridge 396,000,000 / Warp 25bps 990,000 / release 395,010,000), per-step sha256s, the quote reference (recipient == the pinned EVM wallet), and the quote-box display strings computed by the REAL fee code (the browser harness asserts against these). |

## Fixed sample input (deterministic, offline)

```json
{
  "from": "x1", "to": "eth", "token": "wSOL.X", "toToken": "USDC",
  "amountUser": 0.4,
  "solanaAddress": "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV",
  "feeWallet": "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu",
  "evmDestination": "0x1870aFAfA502223f6F70b6DDB93dc4099C86C239",
  "blockhash": "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
  "seqSlot": 305000000
}
```

Wallet set = the repo's own test constants (the SAME set as the forward
fixtures). The EVM destination is the ground-truth wallet from the working
run — note the canonical EIP-55 casing: the task's logged all-caps
`0x1870aFAFA502223F6F70b6DDB93dc4099C86C239` is NOT valid EIP-55 (LI.Fi
rejects it); `0x1870aFAfA502223f6F70b6DDB93dc4099C86C239` is the same account
in its canonical form. All comparisons are case-insensitive.

Derived from the fixed sample: burn **0.4 wSOL.X** gross → 1% skim
**4,000,000** base (9-dec) → bridge_out **396,000,000** → Warp's own 25bps
carved inside bridge_out (**990,000** — the live fee-collector debit) → the
guardians release **395,010,000** base (**0.39501 WSOL**) on Solana → LiFi
carries exactly that (fromAmount 395010000) to Ethereum as USDC.

## Per-step sha256 (2026-09-02 capture)

| Step | sha256 (canonical artifact) | sha256 (serialized bytes, SVM tx) |
|---|---|---|
| step1 X1 burn | `a51a62e143ee667444cc19e1fce0a8165e5bfdf32c4c66d27f151c9112c60e9e` | `9fb5eb3903cb632d8dc2d9cf5a0dfd016bbca278a2dcd69d3b6a65d77dc111a1` |
| step2 release shape | `33716a7fbe2b44ed318cd1b90979cc0d2dfa2b5ef7c4ab417e83abdf085cbe26` | `specSha256` (14-row spec): see the fixture file |
| step3 LiFi query | `9158503c0e92c92337c65f147cee888314e2cbc89c438a9a4470d4938e69a287` | — (the query is the artifact; the executable tx is LI.Fi's — frozen quote input) |
| quote (LiFi Solana tx payload reference) | `9c07270c1d9695032e9f2a529e7803e228d52d31584bbec26c7b2173c5fa6cb6` | sha256 of the base64-decoded `transactionRequest.data` bytes |

## How the engine is verified against these

1. `npm test` — `test/goldenReverse.test.js` REBUILDS each step from the same
   inputs (shared builders in `test/golden/reverseLegBuilders.mjs` — the
   capture script and the test use the SAME module, so they cannot drift) and
   asserts byte-identity: canonical artifact equality, sha256 match, the raw
   serialized-byte sha256 for the burn tx, the release math chain of custody,
   and the toAddress PIN (recipient == the EVM destination) in both the query
   artifact and the frozen quote.
2. The engine's reverse legs must produce the same artifacts for the same
   inputs — proven in `test/engine.test.js` (byte-identity vs these
   fixtures). If any comparison fails, **the engine is wrong** — fix the
   engine, never the oracle.
3. The browser harness (`e2e/reverse-leg.spec.js`) drives the real UI to the
   sign step and asserts the wallet is asked to sign the EXACT golden burn tx
   (bytes) + the To-address line shows the EVM destination.

## Regenerating

```bash
node --import ./tools/jsx-loader.mjs tools/capture-reverse-golden-fixtures.mjs
```

(The frozen quote fixture is INPUT — only re-capture it deliberately, with a
note of the new quote's tool/amounts, since the oracle is about construction
given the same quote.)
