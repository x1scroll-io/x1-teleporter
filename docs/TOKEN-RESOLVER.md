# TOKEN-RESOLVER.md — the canonical token registry

**Module:** `src/lib/tokenResolver.js` (pure — no DOM, no wallet, no fetch, no
`@solana` imports; runs under `node --test` and in the browser bundle).
**Tests:** `src/lib/tokenResolver.test.js`.

This is the single source of truth for **token identity** — the module that
answers "is this USDC the same USDC everywhere" in one place. Every address /
mint / decimals value the app transacts with lives here. Nothing else in the
codebase may hardcode a token address.

---

## Why it exists

Before this module, token identity was scattered across five places that could
drift:

| Module | What it hardcoded | Now |
|---|---|---|
| `src/lib/teleportConstants.js` | the `TOKENS` registry (per-chain symbol → address/decimals) | **derived projection** of the resolver (`listed` entries only) |
| `src/warpBridge.js` | mint `PublicKey`s (`USDC_MINT`, `X1_USDCX_MINT`, `WSOL_MINT`, `X1_WSOLX_MINT`, `ETH_MINT`, `X1_ETHX_MINT`, `CBBTC_MINT`, `X1_CBBTCX_MINT`), `X1_WARP_FEES` / `SOL_WARP_FEES` decimals, `X1_REVERSE_TOKENS` / `X1_FORWARD_TOKENS` mints+decimals, `X1_USDC_DECIMALS` | reads mints/decimals from the resolver (`requireToken`) |
| `src/lib/reverseQuote.js` | second copy of the per-token Warp fee decimals, the reverse twin map, the Coingecko id map | reads decimals + twins + coingecko ids from the resolver |
| `src/lib/teleportQuote.js` | inline Solana-landing twin lookups (`destToken === "wSOL.X" ? "WSOL" : "USDC"`) | twin relation from the resolver (gated on forward-bridgeable destinations) |
| `src/Teleporter.jsx` (v1) | its own inline `TOKENS` | **untouched on purpose** — the flag-restorable v1 safety net stays frozen; the eventual "collapse v1 onto the resolver" step can do it with zero behavior change |

Fee *logic*, leg *logic*, fee *accounts* (Warp's per-token collector ATAs) and
*program* PDAs are NOT token identity — they stay where they are
(`WARP_ACCOUNTS`, the fee-account exports in `warpBridge.js`). Only where a
token's address/decimals live was moved.

Non-token contracts that are deliberately NOT in the resolver: the LiFi
Diamond allowlist (`src/lib/lifiDiamondAllowlist.js` — a per-chainId protocol
allowlist, not a token), the `0xeeee…eeee` native-ETH sentinel, wallet
placeholders.

---

## The API

```js
import {
  resolve,            // resolve(symbol, chain)  → enriched entry | null
  resolveByAddress,   // resolveByAddress(address, chain) → { symbol, entry } | null
  resolveTwin,        // resolveTwin(symbol, chain?) → twin symbol | null
  requireToken,       // requireToken(symbol, chain) → entry | THROWS (constants only)
  canonicalSymbols,   // all canonical symbols, table order
  isKnownChain,       // chain id known?
  TOKEN_TABLE,        // the canonical table (frozen)
  CHAIN_META,         // chain id metadata (id/name/chainId/family)
} from "./tokenResolver.js";
```

### resolve(symbol, chain)

```js
resolve("USDC", "sol")    // → { symbol:"USDC", chain:"sol", address:"EPjF…", decimals:6,
                          //     program:"spl", rails:["lifi","warp"], listed:true,
                          //     warpTwin:"USDC.x", coingeckoId:"usd-coin", … }
resolve("USDC.x", "x1")   // → the X1 Token-2022 wrap
resolve("ETH", "eth")     // → native entry (address:null, program:"native", decimals:18)
resolve("USDC", "rbn")    // → null  (Robinhood Chain USDC — unresolved TODO, see below)
resolve("FOO", "sol")     // → null  (never throws, never guesses)
```

Contract:
- Unknown symbol / unknown chain → `null`.
- Symbols are **case-sensitive** (`"WSOL"` ≠ `"wsol"`, `"USDC.x"` ≠ `"USDC.X"`).
- A non-native entry with `address === null` is an **unresolved TODO** and
  resolves to `null` — no half-answers.
- Native assets (BTC, ETH-on-EVM, XNT) legitimately have `address: null` and
  DO resolve (their `program` is `"native"`).

### resolveByAddress(address, chain)

```js
resolveByAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "eth")
// checksummed, all-lower, all-UPPER, 0X-prefixed → all match (erc20 hex is
// case-insensitive)
resolveByAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "sol") // exact
resolveByAddress("So11111111111111111111111111111111111111112", "sol")   // → WSOL
resolveByAddress("So11111111111111111111111111111111111111112", "x1")    // → wXNT!
// same address, different chain, different token — the whole point
```

- **EVM (erc20)** `0x`-hex matches case-insensitively.
- **spl / token-2022 / trc20** addresses are base58 — exact match only
  (base58 is case-sensitive; lowercasing a base58 address is a different,
  invalid string and returns `null` — never fuzzy-match).
- Wrong chain → `null` (the Solana USDC mint is not the X1 USDC).

### resolveTwin(symbol, chain?) — the Warp pair relation

The Solana-side token ↔ X1-side wrapped token of each Warp pair:

```
USDC   ↔ USDC.x      WSOL ↔ wSOL.X
ETH    ↔ ETH.X       cbBTC ↔ cbBTC.X
```

```js
resolveTwin("USDC")          // → "USDC.x"   (and vice versa for all four pairs)
resolveTwin("USDC", "sol")   // → "USDC.x"
resolveTwin("USDC", "x1")    // → "USDC.x"
resolveTwin("USDC", "eth")   // → null — an EVM USDC has no Warp twin
resolveTwin("USDT")          // → null — not a warp-pair member
```

The relation is symmetric and only exists on the SVM sides (`sol`/`x1`) when a
chain is supplied.

### requireToken(symbol, chain) — the loud escape hatch

`resolve()` never throws. Money-path **constants** modules (`warpBridge.js`,
the `teleportConstants` projection source) cannot ship a `null` mint silently,
so they call `requireToken`, which throws a descriptive error at import time if
a pinned entry is missing or misnamed. User-facing flows use `resolve()`.

---

## The canonical table

Row key = **canonical symbol** (what the app displays and keys on). Each row:
`name`, `kind` (`"token"` | `"native"`), optional `warpTwin` / `coingeckoId` /
`thorchainAsset`, and `entries` keyed by chain id.

Per-chain entry fields:

| Field | Meaning |
|---|---|
| `chain` | chain id (see CHAIN_META below) |
| `address` | mint/contract string — or `null` for natives AND unresolved TODOs |
| `decimals` | **per-chain** decimals (EVM native ETH 18; Solana Wormhole ETH 8; X1 ETH.X 8) |
| `program` | `"erc20"` \| `"trc20"` \| `"spl"` \| `"token-2022"` \| `"native"` — the SVM "program" question: `spl` = Token program v1, `token-2022` = Token-2022 |
| `rails` | transport rails that move it: `"lifi"`, `"warp"`, `"xdex"`, `"thorchain"`, `"native"` |
| `listed` | `true` ⇔ appears in the v2 picker registry — `teleportConstants.TOKENS` is **derived** from exactly these entries |
| `status` | optional; `"unverified"` = documented TODO (address `null` → does not resolve) |
| `note` | provenance / caveats (peg variants, live-config source, …) |

### Token × chain matrix (2026-09-05)

**Stables (LiFi rail across EVM + Solana; listed):**
USDC — eth · bsc (Binance-Peg, 18) · sol · arb · bas · opt · pol (bridged
legacy) · avax · sonic · tron (v1-gated, unlisted). Warp twin `USDC.x`.
USDT — eth · bsc (Binance-Peg, 18) · sol · arb · opt · pol · avax · sonic ·
tron (v1-gated, unlisted).
DAI — eth · bsc (Binance-Peg, 18) · arb · bas · opt · pol · avax.

**SVM warp rails:**
| Canonical | Chain | Address | Dec | Program | Listed | Twin |
|---|---|---|---|---|---|---|
| USDC | sol | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 | spl | ✅ | USDC.x |
| WSOL | sol | `So11111111111111111111111111111111111111112` | 9 | spl | ✅ | wSOL.X |
| ETH | sol | `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` (Wormhole) | 8 | spl | ✅ | ETH.X |
| cbBTC | sol | `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij` | 8 | spl | ✅ | cbBTC.X |
| USDC.x | x1 | `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq` | 6 | token-2022 | ✅ | USDC |
| wSOL.X | x1 | `JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8` | 9 | token-2022 | ✅ | WSOL |
| ETH.X | x1 | `4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw` | 8 | token-2022 | engine rail | ETH |
| cbBTC.X | x1 | `s47zmcZNFkZkdJqgZxZSBvXb8wRx89HgVGXt5Pf791K` | 8 | token-2022 | engine rail | cbBTC |
| wXNT | x1 | `So11111111111111111111111111111111111111112` (native wrap) | 9 | spl | xdex rail | — |
| XNT | x1 | native (no mint) | 9 | native | gas | — |

`wXNT` note: X1's native-wrap mint is the SAME canonical spl-token all-0x01
pubkey as Solana's WSOL — per-chain semantics differ (it wraps XNT on X1).
Ground truth: the verified live xdex `wXNT/USDC.x` swap golden fixture.

**Native identity rows (unlisted):** ETH native on eth/arb/opt/bas (18, no
contract).

**THORChain lane (native, `"thorchain"` rail, unlisted):**
BTC (8, `BTC.BTC`) · DOGE (8, `DOGE.DOGE`) · LTC (8, `LTC.LTC`) · XRP (6,
`XRP.XRP`).

**Reserved / unresolved (resolve to `null` — never a guess):**
`DGN`, `xencat` — rows exist to document intent, zero chain entries, no ground
truth in the repo yet (2026-09-05).

### Robinhood Chain USDC — TODO (coordination with the robinhood leg)

The USDC row carries a **marked TODO entry** for Robinhood Chain
(`chain: "rbn"`, chainId 4663, `status: "unverified"`, `address: null`,
`listed: false`). The sibling robinhood-chain task has NOT landed as of
2026-09-05, so:

- `resolve("USDC", "rbn")` → `null` today (no identity assumed).
- When the robinhood leg confirms the deployment: if it is Circle's canonical
  contract, fill in the address/decimals on the existing entry; if it is a
  different deployment, give it its own canonical row. Either way the change
  is resolver-only.

---

## Chain ids (CHAIN_META)

The resolver's chain space extends the teleport UI ids with the non-UI rails:

`x1` · `sol` · `eth` · `bsc` · `arb` · `bas` · `opt` · `pol` · `avax` · `sonic`
· `rbn` (Robinhood Chain 4663) · `tron` (v1-gated) · `btc` · `doge` · `ltc` ·
`xrp`

`CHAIN_META` is identity-only metadata (id/name/chainId/family). The UI routing
registry stays `CHAINS` in `teleportConstants.js`.

---

## What reads from the resolver now

- **`teleportConstants.TOKENS`** — derived projection of `listed` entries
  (same shape, same per-chain key order, decimals-first entry keys — the
  regression test pins it byte-identical to the pre-resolver literal). The
  default-token pickers read `Object.keys(TOKENS[chain])[0]`, so row order in
  `TOKEN_TABLE` is meaningful: EVM chains USDC→USDT→DAI, sol
  USDC→USDT→WSOL→ETH→cbBTC, x1 USDC.x→wSOL.X. **Add new rows at the END.**
- **`warpBridge.js`** — mint `PublicKey`s, `X1_WARP_FEES`/`SOL_WARP_FEES`
  decimals, `X1_REVERSE_TOKENS`/`X1_FORWARD_TOKENS` mints+decimals,
  `X1_USDC_DECIMALS` all via `requireToken`.
- **`reverseQuote.js`** — per-token Warp fee decimals, `reverseSolanaToken()`
  (the twin lookup), the Coingecko fallback ids.
- **`teleportQuote.js`** — the Solana-landing twin lookups, gated to
  forward-bridgeable destinations (`TOKENS.x1[destToken]`): a listed x1
  destination uses its canonical twin, anything else keeps the legacy USDC@6
  decode.
- **`verify-accounts.mjs`** (build preflight) — accepts the
  `requireToken("SYM","chain")` source form and resolves it through the
  registry, so the on-chain drift guard still verifies the real runtime value.

---

## How to add a token

1. **Add a row** to `TOKEN_TABLE` (or an entry to an existing row) with every
   field above. `listed: true` only if it should appear in the v2 pickers
   (TOKENS projection). Row order matters (see above) — new rows go at the
   END, and update the pinned symbol-list assertion in the test.
2. **Ground truth first.** Every address must come from a verified source
   (live on-chain config, a finalized tx, an existing verified constant). A
   non-native entry without a verified address is `address: null,
   status: "unverified"` — it documents intent and resolves to `null` until
   filled in. **Never guess an address into the table.**
3. If the token is one side of a Warp pair, set `warpTwin` on BOTH rows.
4. **Run the tests:** `npm test` (the resolver test pins the TOKENS
   projection, the mint constants, the fee tables and the registry tables
   byte-identical — any accidental behavior change fails loudly).
5. Consumers pick it up automatically: `TOKENS`, quote builders, balance
   lines. Fee/leg logic is NOT touched by a registry edit unless the token
   needs a fee shape (then update the Warp fee tables' symbol keys — decimals
   still come from the resolver).

## Ground rules

- `resolve` / `resolveByAddress` / `resolveTwin` never throw and never guess.
- `requireToken` is the only throwing path, for constants modules.
- The TOKENS projection, mint constants and fee tables are pinned by
  regression tests — changes must be intentional and tested.
- `Teleporter.jsx` (v1) keeps its own frozen inline TOKENS until the
  documented "collapse v1" step.
