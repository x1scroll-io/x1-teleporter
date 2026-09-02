# Golden-transaction fixtures — THORChain leg BTC→SOL.SOL (the regression oracle, Phase 3)

Tool 1 for the Phase-3 routing-engine migration. These fixtures capture the
EXACT artifacts the CURRENT reference THORChain lane (the Buy/THORChain tab's
deposit-address flow — BTC/DOGE/LTC/XRP → SOL.SOL) constructs, so the routing
engine can be proven correct: it must reproduce them exactly, or
`test/goldenThorchain.test.js` fails.

## LIVE-STATUS BOUNDARY (read this first — honest oracle)

The THORChain lane is the NEXT roadmap item: it has **NOT gone live yet** (the
THORChain aggregator key is a parked item — server-side only; the UI is
flag-gated). There are therefore **no live quote/inbound captures to freeze**.
The two INPUT fixtures are **SYNTHETIC THORNode-shaped bodies**, loudly
labeled:

| Input file | Stands in for |
|---|---|
| `inbound-addresses-body.json` | `/thorchain/inbound_addresses` (vault entries per chain) |
| `quote-body-btc-sol.json` | `/thorchain/quote/swap` (the proxy passes the body through verbatim) |

What the fixtures pin is the **CURRENT code's CONSTRUCTION** as the oracle:
given these bodies + the fixed sample, the lane builds exactly these artifacts
— the engine must reproduce them byte-for-byte. **On the first operator
deposit**: replace the synthetic bodies with live read-only captures (same
procedure as the forward/reverse frozen quotes — note the route/amounts), then
re-run `node --import ./tools/jsx-loader.mjs tools/capture-thorchain-golden-fixtures.mjs`.

## What the deposit-address lane constructs (the app-controlled artifacts)

The v1 THORChain flow does **NOT sign or broadcast anything in-app**: the user
sends native BTC/DOGE/LTC/XRP from their OWN external wallet to the THORChain
vault, attaches the memo, then pastes the inbound txid back
(`THORChainDeposit` — quote gate → deposit address + memo → paste txid →
progress). The app-constructed deterministic artifacts are:

1. **The quote request** — the canonical serialized request to OUR serverless
   proxy `/api/thorchain/quote` (`src/lib/thorchain/quote.js` — the aggregator
   key lives SERVER-side only; the client never holds it). Amounts in THORChain
   1e8 base units; destination = the connected Solana session pubkey; the size
   cap (0.05 BTC-equivalent, config) is enforced BEFORE the fetch; the
   affiliate pair is OMITTED while the Teleporter THORName placeholder is empty
   (parked item — nothing invented is ever sent).
2. **The deposit payload** — the THORChain vault address for the selected
   source chain (from the inbound-addresses refresh — in-memory only, never
   cached; halted chains are not selectable) + the deposit MEMO
   `=:SOL.SOL:<solanaDest>[/<refund>]` (`src/lib/thorchain/memo.js` — the
   THORNode `SwapMemo.String()` scheme; destination pinned to the Solana
   session pubkey, never user-typed).
3. **The quote parse** — `parseQuoteResponse`'s canonical quote
   (expectedAmountOut / slippage / halted) given the proxy body — fail-closed:
   the deposit address is shown ONLY after a fresh quote lands.

The SOL-landing watcher (`solBalance.js` — a balance READER, nothing built)
and the post-landing auto-advance (SOL→USDC swap → 0.5% skim → Warp hop) reuse
the SAME proven executors the Phase-1/2 engine legs already wrap
(`executeLiFiSolanaTx` / `buildStage2` / `runStage2` — pinned by the
forward/reverse oracles) and stay on their existing gated paths — documented
here, not duplicated.

## Files

| File | Step | What it captures |
|---|---|---|
| `inbound-addresses-body.json` | INPUT (synthetic) | THORNode-shaped `/thorchain/inbound_addresses` body — 4 chains; BTC is the sample's chain; DOGE marked halted to pin the paused-chain gate. NOT a live capture. |
| `quote-body-btc-sol.json` | INPUT (synthetic) | THORNode-shaped `/thorchain/quote/swap` body (`expected_amount_out` 49,750,000 = 0.4975 SOL @ 1e8; `slippage_bps` 50; non-empty `inbound_address` → not halted). NOT a live capture. |
| `step1-quote-request.json` | 1 | The quote request: `from_asset=BTC.BTC&to_asset=SOL.SOL&amount=1000000&destination=wJs2…` on OUR proxy path + the cap decision (`{ok:true, capKnown:true}` — BTC's rate is configured) + `urlSha256` (sibling) over the canonical serialized request. |
| `step2-deposit-payload.json` | 2 | The deposit payload: the BTC vault address selected from the inbound snapshot + the memo `=:SOL.SOL:wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV` (+ `memoParts` parse + `memoSha256` sibling). No refund segment (the external-send sample state); no affiliate (THORName placeholder empty). |
| `thorchain-leg-summary.json` | — | Sample input, derived values (base units, quote parse, fee lines from the REAL fee code — the browser harness asserts those display strings), per-step sha256s, url + memo hashes. |

## Fixed sample input (deterministic, offline)

```json
{
  "sourceChain": "BTC", "fromAsset": "BTC.BTC", "toAsset": "SOL.SOL",
  "amount": 0.01,
  "solanaAddress": "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV",
  "refundAddress": null
}
```

Wallet set = the repo's own test constants (the SAME Solana wallet the
forward/reverse fixtures use AND the e2e fake Solana wallet connects with).
Amount 0.01 BTC → 1,000,000 base units (1e8); the 0.05 BTC-equivalent cap is
known (BTC rate 1) and the sample is at-cap.

Derived: quote parse → `expectedAmountOut 0.4975 SOL` (raw 49,750,000),
`slippageBps 50`, not halted; memo `=:SOL.SOL:wJs2CD1p…`; the three pre-send
fee lines (real `computeFee`): THORChain affiliate **1.00%** (protocol,
third-party) + Teleporter fee **0.50%** (warp-skim — fee-model v2) + Warp bridge fee
**$1 flat**.

## Per-step sha256 (2026-09-02 capture)

| Step | sha256 (canonical artifact) | hash sibling |
|---|---|---|
| step1 quote request | `cd566851e678f0f6e429c9e3d5e1bfac0b70d7d69008a9c654bbc5064cc6b37a` | `urlSha256` `adbcd110b09540ddbe6d874d9b5966d14c0e99b4abfe29325b9f606dc2cccf9c` |
| step2 deposit payload | `9a5cb00fc10d32dad3501cc0efebd0a421a76d968a2b88b6487a46fa3df2d383` | `memoSha256` `398eb36717bb9364a1b16af6f1535e1a2a72f55a58f1ace00fd1689d0938a4fa` |

## How the engine is verified against these

1. `npm test` — `test/goldenThorchain.test.js` REBUILDS each step from the same
   inputs (shared builders in `test/golden/thorchainLegBuilders.mjs` — the
   capture script and the test use the SAME module, so they cannot drift) and
   asserts byte-identity: canonical artifact equality, sha256 match, the
   destination PIN (== the Solana session pubkey), no-affiliate-while-unset,
   the cap decision, the halted-chain gates, the quote parse, and the fee-line
   display strings.
2. The engine's THORChain legs must produce the same artifacts for the same
   inputs — proven in `test/engine.test.js` (byte-identity vs these fixtures +
   the planner shape + the "external" signer boundary). If any comparison
   fails, **the engine is wrong** — fix the engine, never the oracle.
3. The browser harness (`e2e/thorchain-leg.spec.js`) drives the real UI to the
   deposit-address step (the deposit-address lane's "sign step" is the
   copy-address-and-memo screen — the app never signs) and asserts the quote
   summary, the three fee lines, the vault address and the memo byte-for-byte
   against these fixtures.

## Regenerating

```bash
node --import ./tools/jsx-loader.mjs tools/capture-thorchain-golden-fixtures.mjs
```

(The synthetic input bodies are INPUT — only replace them deliberately with a
live capture on the first operator deposit, with a note of the route/amounts.)
