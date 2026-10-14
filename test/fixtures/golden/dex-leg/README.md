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

## XDEX discovery + the LIVE-TX ANCHOR (important)

XDEX has **no HTTP swap API** (api.xdex.xyz exposes price/token endpoints
only; every `/api/swap/*`, `/api/v1/*`, `/api/pool/*` probe 404s). The REAL
swap surface is the XDEX program on X1 mainnet —
`sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` (owner `BPFLoaderUpgradeab1e`
— **UPGRADEABLE**, verified on-chain 2026-09-02; NOT immutable). Live txs log
`Instruction: SwapBaseInput`; the instruction is 24 bytes = discriminator +
`amount_in u64 LE` + `minimum_amount_out u64 LE`, 13 accounts (the CP-Swap
`Swap` struct order — verified 1:1 against the live anchor tx below; the
pool account discriminator `f7ede3f5d7c3de46` =
sha256("account:PoolState"), the AmmConfig len 236 layout with trade fee
2800/1e6 = 0.28% — both decoded from the LIVE pool snapshot).

**🔒 LIVE-TX ANCHOR — the source of truth.** The discriminator
`8fbe5adac41e33de` (= sha256("global:swap_base_input") under classic
Anchor), the 13-account ordering, and the fee/quote shape are anchored to a
REAL mainnet transaction: **Mr. Esters' controlled $5 swap — tx
`65xjdHVdHKgnDgdBN7DDcUQEwMXWjRJoTHQgbSibojWY433MW7mPdLFUiuzxtfkumK52vHGR2ipYB6Bv4hsjQ3SR`
(slot 76,014,947, err ok — 5 USDC.x → ~12.74 XNT on pool
`CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR`)**. The fixture's step-2
instruction bytes equal that tx's swap-instruction bytes exactly
(`8fbe5adac41e33de` + `404b4c0000000000` = amount_in 5,000,000 LE +
`0000000000000000` = min_out 0 LE). DO NOT "correct" these values from any
other source — especially not nebula or any doc. If the program is ever
upgraded and the discriminator changes, the correction must come from a NEW
live swap observation, never from a note.

⛔ NEBULA WALL-OFF: Nebula DEX is a SEPARATE project — its notes/docs must
never inform XDEX or Teleporter reasoning. XDEX truth = its own live
on-chain data only (this anchor tx + live pool snapshots + the program's
real logs). Earlier Phase-4 text claimed a `13bddf5c73d6bd24` discriminator
"observed on 273 sampled pool swaps" and dismissed 8fbe5ada as a stale
nebula note — that was INVERTED contamination (the sample was misread;
13bddf… does NOT match the live program). All nebula references are purged
here.

## Integration prerequisites (flagged, same honesty as THORChain's key note)

- **XDEX arg semantics — LIVE-CONFIRMED 1:1** (2026-09-02): the anchor tx
  (65xjdHVd…) proves the (disc 8fbe5adac41e33de, amount_in u64 LE, min_out
u64 LE) layout + the 13-account order byte-for-byte — the decoded args
  (5,000,000 / 0) and the inner Token-2022 TransferChecked into the USDC.x
  vault + Token TransferChecked out of the wXNT vault match this
  construction. The quote math IS live-confirmed (pool raw-ratio price
  0.3973 vs the XNT price API 0.3926 USD — sane). Refresh the pool snapshot
  before any real flow (vault balances move).
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
