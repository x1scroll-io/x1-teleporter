# Golden-transaction fixtures — the DEX swap legs (the regression oracle, Phase 4)

Tool for the Phase-4 routing-engine migration (instruments-first, same
discipline as Phases 1-3). These fixtures capture the EXACT artifacts the
routing engine's DEX swap legs construct — Jupiter (Solana DEX aggregator),
XDEX (X1's DEX — DIRECT on-chain), and the LiFi EVM same-chain swap verdict
leg — so the engine can be proven correct: the legs must reproduce them
exactly, or `test/goldenDex.test.js` fails. The rebuild path is
`test/golden/dexLegBuilders.mjs` (shared with
`tools/capture-dex-golden-fixtures.mjs`).

## The three legs

| leg | route plan | what the fixture pins |
|---|---|---|
| `jupiter-swap` | `planJupiterSwap()` (`swap-sol-sol-jupiter`, family svm) | step1 the canonical quote request URL (GET `api.jup.ag/swap/v1/quote`); step2 the canonical swap-instructions request body (POST `…/swap-instructions`) |
| `xdex-swap` | `planXdexSwap()` (`swap-x1-x1-xdex`, family svm) | step1 the constant-product quote from the pool snapshot (fee on input); step2 the `SwapBaseInput` instruction + the unsigned serialized tx |
| `lifi-evm-swap` | `planLifiEvmSwap()` (`swap-eth-eth-lifi`, family evm) | step1 the same-chain EVM swap quote request through the `/api/lifi/quote` fee policy (the LEG C verdict leg) |

## LIVE-STATUS BOUNDARY (read this first — honest oracle)

Three of the fixture files are **LIVE read-only captures** (2026-09-02 — no
signing, no broadcast), frozen as oracle INPUTS — the same pattern as the
forward/reverse frozen LiFi quotes:

| Input file | Stands in for | When to refresh |
|---|---|---|
| `jupiter-quote-input.json` | a live Jupiter quote response (0.5 SOL→USDC, api.jup.ag/swap/v1) | route/amounts change — the oracle pins the CONSTRUCTION given the same quote, not the quote itself |
| `xdex-pool-snapshot.json` | the live XDEX wXNT/USDC.x pool state on X1 mainnet (vault raw balances + the AmmConfig fee decode; captured via read-only RPC) | **before any live use** — the vault balances move with every swap |
| `lifi-samechain-quote-input.json` | a live LiFi same-chain quote (eth USDC→USDT — the Leg-C verdict evidence: type `lifi`, tool `sushiswap`/`nordstern`, includedSteps `[protocol:feeCollection, swap:<dex>]`) | evidence only |

What the fixtures pin is the **CURRENT canonical CONSTRUCTION** as the
oracle: given these inputs + the fixed samples, the legs build exactly these
artifacts — the engine must reproduce them byte-for-byte.

## XDEX discovery + the discriminator correction (important)

XDEX has **no HTTP swap API** (api.xdex.xyz exposes price/token endpoints
only; every `/api/swap/*`, `/api/v1/*`, `/api/pool/*` probe 404s). The REAL
swap surface is the XDEX program on X1 mainnet —
`sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` (upgradeable-loader, authority
NONE — immutable; last deploy slot 21,171,632 ≈ 2026-01-07). Live txs log
`Instruction: SwapBaseInput`; the instruction is 24 bytes = discriminator +
`amount_in u64 LE` + `minimum_amount_out u64 LE`, 13 accounts (the Raydium
CP-Swap `Swap` struct order — verified against live txs and byte-for-byte
against the current Raydium source: the pool account discriminator
`f7ede3f5d7c3de46` = sha256("account:PoolState"), the AmmConfig len 236
layout matches the current Raydium struct with trade fee 2800/1e6 = 0.28%).

**The live swap discriminator is `13bddf5c73d6bd24`** — observed on 273
sampled pool swaps across 12,504 pool signatures (slots 72.87M→76.0M,
Aug 20→Sep 2 2026), and identical on Raydium's OWN live Solana CP-Swap
program. The earlier repo note (nebula-dex, Aug 2026) claiming
`8fbe5adac41e33de` (= sha256("global:swap_base_input") under classic Anchor)
does **NOT** match the live program — the Phase-4 oracle pins the observed
discriminator. `13bddf5c73d6bd24` is what the leg must send.

## Integration prerequisites (flagged, same honesty as THORChain's key note)

- **XDEX arg semantics**: the (amount_in u64 LE, min_out u64 LE) layout is
  the Raydium source layout, consistent with the wire evidence (13-account
  Swap struct, 24-byte payload, per-tx-varying args). The pool's recent live
  txs are relayer/AA-driven (native-XNT payers, ATA create+sync patterns)
  and do NOT 1:1 expose the arg↔vault-delta mapping — **run ONE tiny
  controlled swap through the leg on the operator's go-ahead** and compare
  the vault deltas + program logs against this construction before any real
  flow. The quote math IS live-confirmed (pool raw-ratio price 0.3973 vs the
  XNT price API 0.3926 USD — sane).
- **Jupiter host**: the older `quote-api.jup.ag/v6` host no longer resolves
  (dead DNS) — the fixtures pin the current `api.jup.ag/swap/v1`.
- **XDEX snapshot refresh**: `tools/capture-dex-x1-snapshot.mjs`-style
  read-only RPC capture (the fixture file documents its own capture time).
- **Leg C**: nothing to enable — LiFi already covers EVM same-chain swaps
  (swap-route evidence frozen here); the approval audit gate
  (`lifiApproval.validateLiFiApproval`) already accepts exchange tools.

## Files

- `jupiter-step1-quote-request.json`, `jupiter-step2-swap-request.json`,
  `xdex-step1-swap-quote.json`, `xdex-step2-swap-ix.json`,
  `lifi-step1-samechain-swap-request.json` — the step fixtures (artifacts +
  sha256 + hash siblings).
- `jupiter-quote-input.json`, `xdex-pool-snapshot.json`,
  `lifi-samechain-quote-input.json` — the frozen LIVE input captures.
- `dex-leg-summary.json` — the capture summary (samples, evidence hashes,
  per-step file/sha256).
- `test/goldenDex.test.js` rebuilds every step from the same inputs and
  asserts byte-identical + sha256 match + the dex-leg invariants. The engine
  must make it pass UNCHANGED.
