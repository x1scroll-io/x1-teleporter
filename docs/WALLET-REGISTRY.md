com` |Solana, BTC, Tron |✅ | |
|Magic Eden Wallet |`io.magiceden.wallet` |Solana, BTC |⚠️ |ME exited Bitcoin NFTs Mar 2026 — confirm wallet still shipping |
|Uniswap Extension |`org.uniswap.app` |— |✅ | |
|Talisman |`xyz.talisman` |Polkadot |✅ | |
|SubWallet |`app.subwallet` |Polkadot, BTC |⚠️ | |
|Keplr |`app.keplr` |Cosmos, BTC |✅ | |
|Leap |`io.leapwallet` |Cosmos, BTC |⚠️ | |
|Frame |`sh.frame` |— |✅ |Desktop app + extension companion |
|Taho |`xyz.taho` |— |⚠️ |Low activity |
|Ctrl (ex-XDEFI) |`io.xdefi` |BTC, LTC, DOGE, BCH, THOR, Cosmos, Solana|✅ |Built for THORChain — the one wallet that covers the whole THORChain lane |
|Safe{Wallet} |n/a |— |✅ |Not an extension — @safe-global/safe-apps-sdk connector when Teleporter is loaded inside Safe|
|Ledger |n/a |BTC, LTC, DOGE, XRP, SOL |✅ |WebHID via @ledgerhq/connect-kit or Ledger Live's 6963 provider |
|Trezor |n/a |BTC, LTC, DOGE, XRP |✅ |`@trezor/connect-web` |
|WalletConnect v2 |n/a |Solana, Tron, XRPL |✅ |Reown AppKit. Covers ~500 mobile wallets. Always present as the last EVM option |

Collision rules (EVM):

- Two wallets announcing the same rdns (Rabby-as-MetaMask, Phantom-as-MetaMask when "override" is on) → dedupe by provider object identity, not rdns; show both with their real names.
- OKX, Bitget, Phantom, Coinbase all try to own window.ethereum. Under 6963 this is a non-issue. If any code path still touches window.ethereum, that's a bug.

-----

## Chain family: Solana (+ X1, since X1 is SVM)

Discovery: Wallet Standard via @solana/wallet-adapter-react with wallets={[]} and autoConnect off. Wallet Standard wallets register themselves; no manual adapters needed for those. Manual adapters listed only where the wallet is not Wallet-Standard.

|Wallet |Registration |Also does |Status|Notes |
|-------------------|--------------------------------------|--------------------|------|----------------------------------------------------------------------------------------------------------------------------------------|
|**Starport** |Wallet Standard |multi-chain |✅ |Ours. Pin to top of the list with a "recommended" badge. Verify which other families it announces (EVM 6963? BTC?) and list it there too||Phantom |Wallet Standard |EVM, BTC |✅ |Connecting for Solana must not auto-select for EVM/BTC |
|Solflare |Wallet Standard |— |✅ |Also the Ledger path for Solana users |
|Backpack |Wallet Standard |EVM |✅ | |
|MetaMask |Wallet Standard |EVM |✅ |Native Solana support; not the old Snap |
|Coinbase Wallet |Wallet Standard |EVM, BTC |✅ | |
|Trust Wallet |Wallet Standard |EVM, BTC |✅ | |
|OKX Wallet |Wallet Standard |EVM, BTC, Tron |✅ |Also sets window.solana — ignore the global |
|Bitget Wallet |Wallet Standard |EVM, BTC, Tron |✅ | |
|Binance Web3 Wallet|Wallet Standard |EVM, Tron |⚠️ | |
|Exodus |Wallet Standard |EVM, BTC |✅ | |
|Brave Wallet |Wallet Standard |EVM |✅ | |
|Glow |Wallet Standard |— |✅ | |
|Nightly |Wallet Standard |multi |✅ | |
|Magic Eden Wallet |Wallet Standard |EVM, BTC |⚠️ |see EVM note |
|Zerion |Wallet Standard |EVM |✅ | |
|Coin98 |Wallet Standard |EVM, BTC, Tron |✅ | |
|Ctrl (ex-XDEFI) |Wallet Standard |BTC, LTC, DOGE, THOR|⚠️ |verify Solana support in current build |
|Fuse |Wallet Standard |— |⚠️ | ||Salmon |Wallet Standard |— |⚠️ | |
|Ledger (direct) |`@solana/wallet-adapter-ledger` |— |✅ |WebHID; most users go through Solflare instead |
|WalletConnect |`@solana/wallet-adapter-walletconnect`|— |✅ |Mobile fallback |

X1 note: every wallet above that lets the user add a custom RPC works for X1 out of the box. Starport has X1 preconfigured; that's the pitch. Do not build a separate "X1 wallet" list — same wallets, different RPC.

Collision rules (Solana): Wallet Standard handles it. window.solana is claimed by whichever of Phantom/OKX/Bitget/Coinbase loaded last — never read it.

-----

## Chain family: Bitcoin (native BTC — THORChain lane + LI.FI BTC routes)

Discovery: Wallet Standard for Bitcoin where the wallet registers (Xverse, Unisat, Leather, OKX, Phantom, Magic Eden, Coinbase do), plus the wallet's namespaced global as a fallback. Recommended library: LaserEyes (`@omnisat/lasereyes`) — it already ships one explicit provider per wallet below and handles the window.unisat impersonation problem. Use it; do not write these adapters by hand.

Address rule: always request the payment address (`bc1q` native segwit) for sends. Never the ordinals/taproot address (`bc1p`) — Xverse and Unisat expose both; sending from the wrong one burns inscriptions.

|Wallet |Detection |Connect API |Status|Notes |
|--------------------------------|----------------------------------------------------------|--------------------------------------------------------------|------|-------------------------------------------------------------------------------------|
|Xverse |`window.XverseProviders.BitcoinProvider` + Wallet Standard|`sats-connect` request('getAccounts'), signPsbt |✅ |Reference BTC wallet. Returns payment + ordinals addresses — use `purpose: 'payment'`|
|Unisat |`window.unisat` + Wallet Standard |`window.unisat.requestAccounts()`, signPsbt |✅ |**Impersonated** by Bitget/OKX/Wizz — see collision rules |
|Leather (ex-Hiro) |`window.LeatherProvider` |`request('getAddresses')`, signPsbt |✅ |Legacy window.btc / window.StacksProvider — ignore |
|OKX Wallet |`window.okxwallet.bitcoin` |Unisat-compatible API |✅ |Never via bare window.unisat |
|Phantom |`window.phantom.bitcoin` + Wallet Standard |`requestAccounts`, signPSBT |✅ | |
|Magic Eden Wallet |`window.magicEden.bitcoin` |sats-connect compatible |⚠️ |verify still shipping |
|Bitget Wallet |`window.bitkeep.unisat` |Unisat-compatible |✅ |Never via bare window.unisat ||Coinbase Wallet |Wallet Standard |— |⚠️ |BTC in extension; verify PSBT signing exposed |
|Trust Wallet |`window.trustwallet.bitcoin`? |— |⚠️ |verify API surface |
|Ctrl (ex-XDEFI) |`window.xfi.bitcoin` |`request({method:'request_accounts'})`, transfer, `signPsbt`|✅ |THORChain-native — supports memo on send directly |
|Enkrypt |Wallet Standard / injected |— |⚠️ |BTC supported; verify PSBT API |
|Keplr |`window.keplr` BTC methods |— |⚠️ |Keplr added Bitcoin; verify send/psbt |
|Leap |`window.leapBitcoin`? |— |⚠️ | |
|Wizz |`window.wizz` |Unisat-compatible |✅ |Also sets window.unisat in some builds |
|Oyl |`window.oyl` |LaserEyes provider |✅ | |
|Orange |`window.orange` |sats-connect compatible |✅ | |
|OP_NET wallet |`window.opnet` |— |⚠️ |Niche |
|Ledger |WebHID |`ledger-bitcoin` (PSBT) |✅ |Advanced; via Xverse/Leather is easier |
|Trezor |`@trezor/connect-web` |signTransaction |✅ | |
|Sparrow / Electrum / any desktop|— |**deposit-address + memo + QR** |✅ |No connect. This is the v1 path and must always be visible |

Collision rules (Bitcoin):

- `window.unisat` is not proof of Unisat. Bitget, OKX, Wizz, and others inject a Unisat-compatible object at that key. Detection order: (1) Wallet Standard registrations, (2) namespaced globals (`okxwallet.bitcoin`, bitkeep.unisat, wizz, phantom.bitcoin, magicEden.bitcoin, XverseProviders`), (3) bare `window.unisat counts as real Unisat only if no wallet in step 2 is present that is known to impersonate it. LaserEyes implements exactly this.
- One BTC session at a time; it never touches the EVM or Solana sessions.

-----

## Chain family: Litecoin (THORChain lane)

Few extensions. Deposit-address is the primary path; these are additive.

|Wallet |Detection |Status|Notes ||---------------|---------------------------|------|-------------------------------------------------------------------|
|Ctrl (ex-XDEFI)|`window.xfi.litecoin` |✅ |Supports memo on send — the only clean LTC→THORChain extension path|
|Litescribe |`window.litescribe` |✅ |Unisat-style API for LTC ordinals; verify OP_RETURN memo support |
|Enkrypt |injected |⚠️ |LTC supported; verify memo |
|OKX Wallet |extension |⚠️ |LTC send exists; dApp API unverified |
|Trust Wallet |extension |⚠️ |same |
|Ledger / Trezor|WebHID / connect |✅ |via XChainJS xchain-litecoin with Ledger client |
|Any wallet |deposit-address + memo + QR|✅ |Default |

## Chain family: Dogecoin (THORChain lane)

|Wallet |Detection |Status|Notes |
|--------------------|---------------------------|------|-----------------------------------------------------------------------------------------------------|
|Ctrl (ex-XDEFI) |`window.xfi.dogecoin` |✅ |Memo supported |
|MyDoge |`window.doge` (verify) |✅ |Doge-native extension; verify OP_RETURN/memo support — if absent, it's balance-only + deposit-address|
|DogeLabs Wallet |`window.dogeLabs` (verify) |⚠️ |Doginals-focused |
|Enkrypt |injected |⚠️ |DOGE supported; verify memo |
|OKX / Trust / Bitget|extension |⚠️ |send exists; dApp memo unverified |
|Ledger / Trezor |WebHID / connect |✅ |via XChainJS xchain-doge |
|Any wallet |deposit-address + memo + QR|✅ |Default |

Memo is the hard constraint for LTC/DOGE: THORChain needs the memo in OP_RETURN. A wallet that can't attach OP_RETURN cannot do the send in-app — for those, show balance, then hand off to deposit-address.

-----

## Chain family: XRP Ledger (THORChain lane)

XRPL is mobile-first; the extension ecosystem is thin and two of its main extensions have gone quiet. Treat Xaman as the primary wallet and deposit-address as the baseline. THORChain memo goes in the XRPL Memos field, not a destination tag.

|Wallet |Connect |Status|Notes |
|---------------|------------------------------------------------------------------------|------|-----------------------------------------------------------------------------------------------------------|
|Xaman (ex-XUMM)|`xumm-sdk` / xumm-universal-sdk — QR sign-in + payload signing; mobile|✅ |**Primary.** Payload includes Memos. Verify WalletConnect support in current version as an alternate path|
|Joey Wallet |mobile; WalletConnect (verify) |⚠️ |Growing XRPL-native mobile wallet |
|Bifrost Wallet |mobile; WalletConnect |⚠️ |Multi-chain, XRPL-first; from the XRP Toolkit team |
|Crossmark |`@crossmarkio/sdk`, window.xrpl.# Teleporter Wallet Registry

Companion to teleporter-thorchain-anyswap-brief.md (Cross-cutting — Wallet layer). This is the explicit list. Every wallet below gets its own entry in the connect modal with its own adapter, icon, and detection check. No "injected" catch-all, no "other wallet" button, no reading bare globals unless the row says so.

Legend — Status: ✅ maintained · ⚠️ verify at build time · ❌ stale/unmaintained (show, but badge "unmaintained" and rank last). Verify = confirm the exact key/API in a real browser console with the extension installed before shipping.

-----

## Chain family: EVM (all LI.FI EVM chains + Robinhood Chain 4663)

Discovery: EIP-6963 only. Listen for eip6963:announceProvider; key each provider by info.rdns. Do not read window.ethereum. Library: wagmi injected({ target: { id, name, provider } }) per announced provider, or wagmi's built-in multi-injected discovery.

|Wallet |rdns (verify) |Also does |Status|Notes |
|-------------------|------------------------|-----------------------------------------|------|-----------------------------------------------------------------------------------------------|
|MetaMask |`io.metamask` |Solana (native, 2025+) |✅ |Also announces on Solana via Wallet Standard as "MetaMask" |
|Rabby |`io.rabby` |— |✅ |Has a "flip to MetaMask" mode that spoofs io.metamask — 6963 still shows both |
|Coinbase Wallet |`com.coinbase.wallet` |Solana, BTC (extension) |✅ |Coinbase Smart Wallet is separate — use its SDK connector |
|Phantom |`app.phantom` |Solana, BTC, Sui |✅ |Overrides window.ethereum by default — irrelevant under 6963 |
|Trust Wallet |`com.trustwallet.app` |Solana, BTC (extension) |✅ | |
|OKX Wallet |`com.okex.wallet` |Solana, BTC, Tron, LTC, DOGE |✅ |Most aggressive global-overrider on the list; 6963 + namespaced globals only |
|Brave Wallet |`com.brave.wallet` |Solana |✅ |Only in Brave browser |
|Rainbow |`me.rainbow` |— |✅ | |
|Zerion |`io.zerion.wallet` |Solana |✅ | |
|Enkrypt |`com.enkrypt` |BTC, LTC, DOGE, Polkadot |✅ |See BTC/LTC/DOGE rows for its non-EVM API |
|Backpack |`app.backpack` |Solana |✅ | |
|Bitget Wallet |`com.bitget.web3` |Solana, BTC, Tron |✅ | |
|Binance Web3 Wallet|`com.binance.wallet` |Solana, Tron, BTC |⚠️ |rdns verify |
|Exodus |`com.exodus.web3-wallet`|Solana, BTC |✅ | |
|Coin98 |`coin98.crossmark |❌ |Last release Mar 2025; Firefox build gone. Show with "unmaintained" badge, rank last |
|GemWallet |`@gemwallet/api` |❌ |No release since late 2024. Same treatment |
|Ledger |WebHID, @ledgerhq/hw-app-xrp |✅ | |
|Trezor |`@trezor/connect-web` |✅ | |
|Tangem |card/NFC, mobile |— |Not a dApp connector; deposit-address only |
|Any wallet |deposit-address + memo + QR |✅ |Default |

-----

## Chain family: Tron (existing LI.FI Tron path)

Discovery: explicit adapters from @tronweb3/tronwallet-adapters. Never read window.tronWeb directly — several wallets inject it.

|Wallet |Adapter |Status|Notes |
|-------------------|------------------------------------------------|------|-----------------------------------------|
|TronLink |`TronLinkAdapter` |✅ |Reference. Also injects `window.tronLink`|
|OKX Wallet |`OkxWalletAdapter` (`window.okxwallet.tronLink`)|✅ | |
|Bitget Wallet |`BitKeepAdapter` |✅ | |
|TokenPocket |`TokenPocketAdapter` |✅ | |
|Binance Web3 Wallet|via WalletConnect |⚠️ | |
|Trust Wallet |via WalletConnect |⚠️ | |
|imToken |via WalletConnect |✅ |mobile O|
|Ledger |`LedgerAdapter` |✅ | |
|WalletConnect |`WalletConnectAdapter` |✅ | |

Isolation: TronLink-family wallets must never appear in the EVM list even if they inject an `ethereum`-like object.

-----

## Chain family: Move (Aptos / Sui — LI.FI MVM routes, Workstream B only)

|Wallet |Standard |Status|
|------------------|----------------------------------------------------------|------|
|Petra |Aptos Wallet Standard (`@aptos-labs/wallet-adapter-react`)|✅ |
|Pontem |Aptos Wallet Standard |✅ |
|Martian |Aptos + Sui |✅ |
|Nightly |Aptos + Sui |✅ |
|OKX Wallet |Aptos + Sui |✅ |
|Sui Wallet (Slush)|Sui Wallet Standard (`@mysten/dapp-kit`) |✅ |
|Suiet |Sui Wallet Standard |✅ |
|Ethos |Sui |⚠️ |
|Phantom |Sui (Wallet Standard) |✅ |
|Backpack |Sui? |⚠️ |

Ship Move last; only if LI.FI Move routes are actually live at build time.

-----

## Multi-family wallets — one install, many rowsThese appear in multiple lists above and must be separate sessions per family. Connecting Phantom for Solana does not connect Phantom for BTC.

Phantom (SOL/EVM/BTC/Sui) · OKX (EVM/SOL/BTC/Tron/LTC/DOGE/Move) · Bitget (EVM/SOL/BTC/Tron) · Coinbase (EVM/SOL/BTC) · Trust (EVM/SOL/BTC) · Exodus (EVM/SOL/BTC) · Coin98 (EVM/SOL/BTC/Tron) · Ctrl (EVM/BTC/LTC/DOGE/BCH/THOR/SOL) · Enkrypt (EVM/BTC/LTC/DOGE) · MetaMask (EVM/SOL) · Magic Eden (EVM/SOL/BTC) · Binance (EVM/SOL/Tron) · Backpack (SOL/EVM) · Keplr (EVM/Cosmos/BTC) · Ledger (everything) · Starport (verify and list every family it announces).

-----

## Connect modal layout (so it's not generic)

Per chain family, a fixed-order list, not detected-first sorting:

1. Starport (Solana, and any other family it supports) — pinned, "recommended."
1. The family's reference wallet (MetaMask / Phantom / Xverse / Xaman / TronLink / Petra).
1. Every other ✅ wallet, alphabetical, installed ones highlighted, not-installed ones shown with an "install" link — never hidden.
1. Hardware: Ledger, Trezor.
1. WalletConnect (mobile).
1. ❌ wallets, badged "unmaintained."
1. Deposit address + memo + QR — always the final row on BTC/LTC/DOGE/XRP. Never removed.

Acceptance: screenshot the modal for all seven families with zero extensions installed — every row still renders with an install link. Then again with the eight-extension profile from the brief — highlights are correct, nothing missing, nothing duplicated.
