# Golden-transaction fixtures — the DEX-DIRECT fallback legs (regression oracle, Phase 6)

Tool for the Phase-6 dexDirect scaffold: DEX-DIRECT fallback legs — the
no-aggregator paths when LiFi (EVM) or Jupiter (Solana) is down, or for fee
comparison. Same discipline as Phases 1-5: these fixtures capture the EXACT
artifacts the legs construct from REAL live read-only inputs, so the engine
can be proven correct — the legs must reproduce them exactly, or
`test/goldenDexDirect.test.js` fails. Rebuild path:
`test/golden/dexDirectBuilders.mjs` (shared with
`tools/capture-dexdirect-golden-fixtures.mjs`).

## The four legs

| leg | plan (`planDexDirect`) | what the fixture pins |
|---|---|---|
| `uniswap-swap` (EVM) | `swap-eth-eth-dexdirect-uniswap` (…arb/opt/pol) | step1 the quoter eth_call REQUEST (QuoterV2.quoteExactInputSingle — static calldata) + the FROZEN LIVE RESPONSE parse; step2 the SwapRouter.exactInputSingle swap-call REQUEST (guarded) |
| `pancakeswap-swap` (BNB) | `swap-bsc-bsc-dexdirect-pancakeswap` | the same fork shape on PancakeSwap's OWN deployments (quoter `0xB048Bbc1…e25997` — the deployment-record address; a stale `…B5023F2` address circulates with NO code) |
| `raydium-swap` (Solana, dex cpmm\|clmm) | `swap-sol-sol-dexdirect-raydium` | CPMM: the constant-product quote on the live pool+config+vault state + the swap_base_input ix (disc 8fbe5adac41e33de — the XDEX-anchored family). CLMM: the full tick-walk quote on the live pool+config+tick-array state + the swap_v2 ix |
| `orca-swap` (Solana) | `swap-sol-sol-dexdirect-orca` | the Whirlpool tick-walk quote on the live whirlpool+3-tick-array state + the swap_v2 ix (disc 2b04ed0b1ac91e62 — the CURRENT deployed instruction) |

## LIVE-STATUS BOUNDARY (read this first — honest oracle)

Every input fixture is a **LIVE READ-ONLY capture (2026-09-05)** — no
signing, no broadcast:

| Input | What it is | When to refresh |
|---|---|---|
| `inputs/uni-*-…json` (eth/arb/opt/pol) | live QuoterV2 eth_call responses (10 USDC→USDT per chain) | quotes are market data — refresh before live use; the oracle pins the CONSTRUCTION |
| `inputs/pcs-bsc-…json` | live PancakeSwap QuoterV2 eth_call responses (10 USDC→USDT, 18-dp raw) | same |
| `inputs/orca-sol-usdc-whirlpool-snapshot.json` | the live SOL/USDC whirlpool `Czfq3xZZ…` state (decode + 3 tick arrays + vault token programs + oracle PDA) + the quote + the READ-ONLY mainnet SIMULATION of the constructed swap tx | refresh before any live use (state moves) |
| `inputs/raydium-clmm-sol-usdc-snapshot.json` | the live SOL/USDC CLMM pool `3ucNos4…` state (pool + config + pdas + 4 tick arrays) + quote + sim | refresh before any live use |
| `inputs/raydium-cpmm-token-usdc-snapshot.json` | a live Raydium CPMM pool (`5KXE8RMF…` — mintA/ USDC, CPMMoo8 program) state (pool + config + authority + vault balances) + quote + sim | refresh before any live use |

**Quote validation (all numerical cross-checks ran on identical state):**

- **Orca** — this repo's `whirlpoolQuote` == `@orca-so/whirlpools-sdk`
  computeSwap (same whirlpool + tick-array bytes): amountOut 51614524 vs
  51614524, fee 200000 == 200000, endTick -22706 == -22706 (0.5 SOL,
  multi-tick-crossing sample). Single-step math additionally verified
  field-identical.
- **Raydium CLMM** — `raydiumClmmQuote` == raydium-sdk-v2 `swapInternal`:
  amountOut 10320856 == 10320856, fee 40000 == 40000, endTick -22708 ==
  -22708; pool/config decodes byte-identical to the SDK layouts.
- **Raydium CPMM** — `raydiumCpmmQuote` == raydium-sdk-v2
  `CurveCalculator.swapBaseInput`: output 68530663519451 == 68530663519451,
  fee 250000 == 250000.
- **EVM** — quotes come from the protocols' own QuoterV2 contracts
  (on-chain truth by construction).

**Wire-level validation (read-only mainnet simulations).** Every Solana
capture SIMULATED its constructed swap transaction against mainnet
(simulateTransaction, sigVerify:false — sandboxed, nothing broadcast, no
balance touched). All three simulations parsed the instruction and executed
to the FIRST user-state check — `AccountNotInitialized` on the repo test
wallet's token account (the test wallet has no ATAs; a live swap uses the
user's funded accounts). The discriminators, account orders and data
layouts are therefore correct to the wire.

**Execute side = GUARDED.** Every dexDirect leg's submit() throws
`DexDirectLiveTestGateError` ("…READY FOR LIVE ANCHOR…") — the live-swap
anchor is Mr. Esters': first live swap per DEX (funded wallet, real ATA,
router allowance for the EVM legs). Nothing here signs or broadcasts.

## Verification notes (facts this scaffold pinned live)

- **Uniswap v3 presence** (eth_getCode on the canonical factory/quoter/
  router): eth ✓ arb ✓ bas ✓ opt ✓ pol ✓ — avax ✗ (v3 not at the canonical
  deployment), bsc ✗ (PancakeSwap owns BNB), sonic ✗ (no Uniswap). Direct
  pools between the app's registry stables verified per chain (factory
  getPool + quoter eth_call). Base note: no direct v3 pool between Base's
  registry stables (USDC/DAI) — the leg is chain-generic; a fee tier must
  be supplied for pairs without a verified pool.
- **Orca**: the pool's vault token accounts are owned by the WHIRLPOOL
  address itself (the program CPI-signs); the ix tokenAuthority is the USER
  wallet (readonly signer — verified on the live swap tx 44VxpkKE…, err
  ok). Tick arrays hold 88 ticks for EVERY tickSpacing (9988-byte
  accounts). The oracle account PDA may not exist on-chain (non-adaptive
  pools) — the live tx includes it regardless.
- **Raydium**: CPMM + CLMM share the `vault_and_lp_mint_auth_seed` family
  only for CPMM's authority; CLMM uses per-pool PDAs (observation /
  pool_tick_array_bitmap_extension). CLMM tick arrays hold 60 ticks at
  SPACING multiples. CLMM limit-order ticks are NOT supported by this leg
  (throws honestly — use Jupiter for those); the fixture path crosses none
  (the SDK cross-check — which includes limit-order handling — matched).

## Files

- `inputs/*` — the frozen LIVE read-only captures (dated; refresh before
  live use).
- `steps/*` — the step fixtures (artifacts + sha256 + hash siblings),
  rebuilt deterministically by `test/goldenDexDirect.test.js` from the
  inputs (the engine must reproduce them byte-for-byte).
- `dex-direct-summary.json` — the capture summary (evidence hashes, the
  SDK cross-check records, the simulation results).

## Skill cross-check (official Uniswap swap-integration skill v1.5.0 — 2026-09-06)

The Uniswap leg was reviewed against the official skill (SKILL.md +
references/advanced-patterns.md). Findings, corrections, and the decisions
we deliberately do NOT adopt:

| Skill guidance | Verdict for this leg |
|---|---|
| Trading API (quote/swap via `trade-api.gateway.uniswap.org`) for backend scripts | **Not adopted** — needs an API key and builds txs through Uniswap's gateway; this leg IS the independent no-aggregator fallback (works when LiFi AND the gateway are down). QuoterV2 eth_call is the canonical on-chain quote. |
| Universal Router (2.0, per-chain addresses) for smart-contract/direct integration | **Not adopted** — would force Permit2 (approve → Permit2 + per-swap EIP-712 signature/allowance) + command-encoded calldata + per-chain router addresses for a single-hop v3 swap. The skill's own approval-target table endorses LEGACY DIRECT-APPROVE for backend/automated systems: approve the token to the router once, swap with no signatures — exactly the v3 SwapRouter path this leg uses. |
| Permit2 signature flow | **Not adopted** (frontend-with-user-signing pattern). Live anchor: ONE approval tx — `fromToken.approve(UNISWAP_V3_SWAP_ROUTER 0xE592…, exactAmount)`. Never approve to a Universal Router for this leg. |
| Pre-broadcast validation discipline | **Adopted** — encoded as `validateUniswapSwapRequest` (router target, calldata shape selector+8 words, positive min-out, fresh deadline, non-payable value); the live anchor validates there before signing. |

Corrections applied (all simulation-verifiable; golden artifacts unchanged
byte-for-byte — the golden tests re-prove it):
1. **Removed the deprecated `UNISWAP_UNIVERSAL_ROUTER` export** — it pointed
   at Universal Router v1 `0x3fC91A3a…7FAD`, which the skill explicitly
   marks deprecated/superseded (the current UR 2.0 is per-chain; eth
   `0x66a9893c…`, code presence re-verified 2026-09-06). Dead export,
   zero consumers — a live-anchor hazard if ever used. The module header
   now documents the SwapRouter-vs-UR decision instead.
2. **Burn-recipient guard** — a quote-pinned swap request without a
   `recipient` now throws instead of shaping a swap-call request that would
   send the output to the zero address on a live anchor (Uniswap + PCS legs).
3. **`validateUniswapSwapRequest`** (evmV3 generic +
   Uniswap-bound) — the skill's pre-broadcast checks adapted to the direct
   SwapRouter artifact; unit-tested against the frozen request (accept) and
   wire hazards (wrong router / truncated calldata / zero min-out / stale
   deadline / wrong kind — all reject).
4. Comment accuracy — the eth quote figure in module comments now matches
   the frozen fixture capture (9,997,027, not 9,997,036).

Live re-verification 2026-09-06 (read-only, public RPCs — no funds, no
broadcast, no fixture rewrite): canonical factory/QuoterV2/SwapRouter code
presence re-confirmed on eth/arb/opt/pol/bas; the frozen quoter calldata
still quotes on `latest` on every chain (eth 9,997,212 vs frozen 9,997,027
— normal pool drift; the oracle pins the CONSTRUCTION, quotes are market
data and are refreshed before live use). The execute stubs remain GUARDED
(`submit()` throws `DexDirectLiveTestGateError`) — swap-execution is
READY FOR LIVE ANCHOR, Mr. Esters fires the first live swap.
