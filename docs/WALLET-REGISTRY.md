# Wallet Registry — Teleporter v2

> Started at Step 2.1 (WalletContext). Canonical list of chain families and
> the connect-modal conventions. Later steps extend this file with per-wallet
> entries (SDK adapter, install URL, feature support) as real wallets are
> wired in.

## Chain families (fixed order)

The registry order is FIXED and canonical — it drives the connect modal, the
context state, and the tests. It is deliberately NOT alphabetical and NOT
popularity-sorted: EVM and Solana first (the two live bridge legs today), then
the five THORChain-supported families.

Canonical source of truth: `src/lib/wallet/families.js` (`WALLET_FAMILIES`).

| # | Family    | Session key | Mock address shape (Step 2.1)                          |
|---|-----------|-------------|--------------------------------------------------------|
| 1 | EVM       | `evm`       | `mock:evm:0x` + 40 hex                                 |
| 2 | Solana    | `solana`    | `mock:solana:` + 44 base58 chars                       |
| 3 | Bitcoin   | `bitcoin`   | `mock:bitcoin:1` + base58                              |
| 4 | Litecoin  | `litecoin`  | `mock:litecoin:L` + base58                             |
| 5 | Dogecoin  | `dogecoin`  | `mock:dogecoin:D` + base58                             |
| 6 | XRP       | `xrp`       | `mock:xrp:r` + base58                                  |
| 7 | Tron      | `tron`      | `mock:tron:T` + base58                                 |

## Connect modal rules (Step 2.2 and later)

Consolidated from product orders — these are binding for the connect modal
that lives INSIDE the one-card Connect tab (see docs/BRIEF.md):

1. **Fixed order** — wallets render in the registry order above. Never sort
   by anything else.
2. **Starport pinned first** — Starport occupies the top slot, always
   visible, always first. (Starport's family mapping is decided when real
   wallet adapters are wired in later steps.)
3. **Installed highlighted** — wallets detected as installed are visually
   distinguished.
4. **Not-installed still shown** — a wallet that isn't installed is NOT
   hidden; it is shown with its install link.
5. **Never hide a wallet** — no filtering, no collapsing, no "show more".
   Every wallet in the registry is always reachable.

## Current state (Step 2.1)

- State layer only: `WalletContext` with one independent session per family,
  mock providers (`src/lib/wallet/mockProviders.js`), isolation tests.
- NO real wallet SDKs are wired yet. No UI yet.
- Real wallet adapters (EIP-1193, @solana/wallet-adapter, THORChain wallets,
  …) replace the mocks in later steps behind the same provider interface.
