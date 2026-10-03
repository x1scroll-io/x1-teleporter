/**
 * Canonical Tron wallet table (Step 2.4) — transcribed from the Tron
 * section of docs/WALLET-REGISTRY.md (the canonical registry, PR #15). THE
 * SPEC: the connect modal's Tron family renders exactly these rows in
 * exactly this order. Nothing here is invented — every adapter and every
 * status comes from the registry table.
 *
 * Ordering follows docs/WALLET-REGISTRY.md "Connect modal layout" as
 * applied to the Tron family:
 *   1. Starport (pinned, first).
 *   2. The family's reference wallet: TronLink (TronLinkAdapter).
 *   3. Every other software wallet, ALPHABETICAL — ✅ and ⚠️ rows alike.
 *   4. Hardware: Ledger (LedgerAdapter).
 *   5. WalletConnect (WalletConnectAdapter) — the mobile row.
 *   6. Deposit-address row — NONE for Tron: the registry's deposit row is
 *      "always the final row on BTC/LTC/DOGE/XRP" only; Tron is the
 *      existing LI.FI Tron path and has no deposit row in its table.
 *
 * Status legend (registry): ✅ maintained · ⚠️ verify at build time.
 * Every ⚠️ row below has a `todo` string naming exactly what must be
 * verified in a real browser before its connect path is wired.
 *
 * DISCOVERY RULE (binding): explicit adapters from
 * @tronweb3/tronwallet-adapters ONLY — NEVER read the bare injected
 * tronWeb global (several wallets inject it; the adapters own that
 * handling internally — see tronAdapters.js, the sole allowlisted file).
 *
 * ISOLATION RULE (binding): TronLink-family wallets must NEVER appear in
 * the EVM list even if they inject an ethereum-like object. EVM discovery
 * is EIP-6963-only (evmDiscovery.js); Tron discovery is adapter-only
 * (tronDiscovery.js) — the isolation test pins this at the composition
 * level (walletDiscovery.test.js).
 */

/** Wallet ids used as the modal match keys (tron family) — adapter names. */
export const TRON_WALLET_IDS = Object.freeze({
  STARPORT: "starport",
  TRONLINK: "TronLink",
  OKX: "OKX Wallet",
  BITGET: "Bitget Wallet",
  TOKENPOCKET: "TokenPocket",
  BINANCE: "Binance Web3 Wallet",
  TRUST: "Trust Wallet",
  IMTOKEN: "imToken",
  LEDGER: "Ledger",
  WALLETCONNECT: "WalletConnect",
});

/**
 * The full Tron wallet list, in modal order. Do NOT reorder: the modal
 * (modalLogic.js) renders pinned → reference → software-alpha → hardware →
 * walletConnect → (no deposit row for Tron), and the tests pin this exact
 * order.
 *
 * `adapterName` is the @tronweb3/tronwallet-adapters AdapterName for the
 * rows with a wired adapter (TronLinkAdapter → "TronLink", OkxWalletAdapter
 * → "OKX Wallet", BitKeepAdapter → "Bitget Wallet", TokenPocketAdapter →
 * "TokenPocket", LedgerAdapter → "Ledger"). tronAdapters.js builds exactly
 * these; tronDiscovery.js matches installed adapters by this name.
 */
export const TRON_WALLETS = Object.freeze([
  Object.freeze({
    id: TRON_WALLET_IDS.STARPORT,
    name: "Starport",
    pinned: true,
    installUrl: null, // no public install link yet — pinned + dev mock fallback
  }),
  // ——— Reference wallet: TronLink (the registry's reference adapter) ———
  Object.freeze({
    id: TRON_WALLET_IDS.TRONLINK,
    name: "TronLink",
    reference: true,
    status: "ok",
    installUrl: "https://www.tronlink.org/",
    detection: "adapter",
    adapterName: "TronLink", // TronLinkAdapter
    // Registry: "Reference. Also injects its own global" — the adapter
    // owns that global internally; our code never reads it.
  }),
  // ——— Software wallets, alphabetical (✅ and ⚠️ mixed) ———
  Object.freeze({
    id: TRON_WALLET_IDS.BINANCE,
    name: "Binance Web3 Wallet",
    status: "verify",
    installUrl: "https://www.binance.com/web3wallet",
    detection: "todo",
    // ⚠️ TODO (verify at build time): registry — "via WalletConnect".
    // A dedicated adapter package exists (@tronweb3/tronwallet-adapter-
    // binance) but the registry's spec is the WalletConnect path — do NOT
    // guess; verify before wiring.
    todo: "verify Binance Web3 Wallet's Tron path via WalletConnect (registry ⚠️) before wiring",
  }),
  Object.freeze({
    id: TRON_WALLET_IDS.BITGET,
    name: "Bitget Wallet",
    status: "ok",
    installUrl: "https://web3.bitget.com/en/wallet/download",
    detection: "adapter",
    adapterName: "Bitget Wallet", // BitKeepAdapter (registry table: BitKeepAdapter)
  }),
  Object.freeze({
    id: TRON_WALLET_IDS.IMTOKEN,
    name: "imToken",
    status: "ok",
    installUrl: "https://token.im/",
    detection: "todo",
    // Registry: "via WalletConnect — mobile". A dedicated ImTokenAdapter
    // exists in the adapters package, but the registry lists imToken via
    // WalletConnect and it is mobile-only (no desktop extension global) —
    // connect stays gated behind verification, never guessed.
    connectTodo:
      "verify imToken's Tron path (registry: via WalletConnect, mobile) — dedicated ImTokenAdapter or WalletConnect route, in the current version (Step 2.5 operator profile)",
  }),
  Object.freeze({
    id: TRON_WALLET_IDS.OKX,
    name: "OKX Wallet",
    status: "ok",
    installUrl: "https://www.okx.com/web3",
    detection: "adapter",
    adapterName: "OKX Wallet", // OkxWalletAdapter (registry: window.okxwallet.tronLink — owned by the adapter)
  }),
  Object.freeze({
    id: TRON_WALLET_IDS.TOKENPOCKET,
    name: "TokenPocket",
    status: "ok",
    installUrl: "https://www.tokenpocket.pro/",
    detection: "adapter",
    adapterName: "TokenPocket", // TokenPocketAdapter
  }),
  Object.freeze({
    id: TRON_WALLET_IDS.TRUST,
    name: "Trust Wallet",
    status: "verify",
    installUrl: "https://trustwallet.com/",
    detection: "todo",
    // ⚠️ TODO (verify at build time): registry — "via WalletConnect".
    // Same treatment as Binance Web3 — verify before wiring.
    todo: "verify Trust Wallet's Tron path via WalletConnect (registry ⚠️) before wiring",
  }),
  // ——— Hardware (after software, before WalletConnect) ———
  Object.freeze({
    id: TRON_WALLET_IDS.LEDGER,
    name: "Ledger",
    status: "ok",
    hardware: true,
    installUrl: "https://www.ledger.com/",
    detection: "adapter",
    adapterName: "Ledger", // LedgerAdapter (registry ✅)
    // The LedgerAdapter is constructed in tronAdapters.js (readyState
    // reflects WebHID support). Connect is TODO-gated: the adapter's
    // connect() flow needs the WebHID device-picker UX verified with a
    // real device (hardware lane, later step — same treatment as the
    // Bitcoin/LTC/DOGE/XRP Ledger rows).
    todo: "TODO (Phase 3): wire LedgerAdapter connect (WebHID device flow) — detection via readyState only in this PR",
  }),
  // ——— WalletConnect (mobile) — after hardware, before ❌/deposit ———
  Object.freeze({
    id: TRON_WALLET_IDS.WALLETCONNECT,
    name: "WalletConnect",
    status: "ok",
    walletConnect: true,
    installUrl: "https://walletconnect.com/",
    detection: "todo",
    // Registry: ✅ WalletConnectAdapter. The adapter requires a Reown
    // AppKit projectId + network config (WalletConnectAdapterConfig) that
    // this app does not carry yet — connect stays gated behind that TODO,
    // no guessed config.
    connectTodo:
      "wire WalletConnectAdapter (needs a Reown AppKit projectId + network config; verify the current adapter version's required options — Step 2.5 operator profile)",
  }),
]);
