/**
 * Canonical TON wallet table (TON Connect) — the connect modal's TON family
 * renders exactly these rows in exactly this order. Nothing invented: every
 * `id` is a real TON Connect wallet `appName` from the official wallets
 * registry (ton-blockchain/wallets-list, wallets-v2.json — verified
 * 2026-09-29). See docs/NEAR-TON-DEX-RESEARCH.md (TON connectors).
 *
 * Ordering mirrors docs/WALLET-REGISTRY.md connect-modal layout:
 *   1. Starport (pinned, first).
 *   2. The reference wallet: Tonkeeper (TON's flagship wallet).
 *   3. Other software wallets, ALPHABETICAL (MyTonWallet, Telegram Wallet,
 *      Tonhub).
 *   4. Hardware: none wired (TON Connect is a bridge/QR protocol; hardware
 *      TON wallets connect through their own app — deposit-address handles
 *      the rest).
 *   5. Deposit-address row — ALWAYS the final row, never connectable
 *      (the ChangeNOW / bridge long-tail fallback: TON is a ChangeNOW
 *      deposit chain).
 *
 * ── WHY A DEPOSIT-ADDRESS ROW ALWAYS EXISTS (fail-closed) ─────────────────
 * TON Connect connects through a BRIDGE (a QR code the wallet app scans, or a
 * universal link / deep link). That UX is wallet-app-owned, not a browser
 * extension popup, so it does not always fit the desktop connect modal. When
 * the bridge element is not wired (or the user has no TON Connect wallet),
 * discovery reports ZERO connectable wallets and the modal falls through to
 * the deposit-address row — never a dead Connect button. The connector is
 * wired honestly where the standard supports it (see tonConnect.js); the
 * deposit row is the honest fallback everywhere else.
 *
 * DISCOVERY RULE (binding): TON Connect ONLY. We never read a wallet's
 * injected global directly — TON Connect owns the bridge transport.
 *
 * Status legend: ✅ maintained (verified against the official wallets list).
 */

/** Wallet ids used as the modal match keys (ton family) — these EXACTLY
 *  equal the TON Connect wallet `appName`, so discovery keys match the
 *  registry rows. */
export const TON_WALLET_IDS = Object.freeze({
  STARPORT: "starport",
  TONKEEPER: "tonkeeper",
  MYTONWALLET: "mytonwallet",
  TELEGRAM: "telegram-wallet",
  TONHUB: "tonhub",
  DEPOSIT_ADDRESS: "deposit-address",
});

/** Id of the always-last, never-removed deposit-address row. */
export const TON_DEPOSIT_ADDRESS_ID = TON_WALLET_IDS.DEPOSIT_ADDRESS;

/**
 * The full TON wallet list, in modal order. Do NOT reorder: the modal
 * (modalLogic.js) renders pinned → reference → software-alpha → deposit-
 * address, and the tests pin the pinned/reference/deposit order.
 */
export const TON_WALLETS = Object.freeze([
  Object.freeze({
    id: TON_WALLET_IDS.STARPORT,
    name: "Starport",
    pinned: true,
    installUrl: null, // no public install link yet — pinned + dev mock fallback
    detection: "todo",
    todo: "wire Starport as a TON Connect wallet (custom wallet entry) when it ships — pinned row, no guessed bridge",
  }),
  // ——— Reference wallet: Tonkeeper ———
  Object.freeze({
    id: TON_WALLET_IDS.TONKEEPER,
    name: "Tonkeeper",
    reference: true,
    status: "ok",
    installUrl: "https://tonkeeper.com/",
    detection: "ton-connect",
    // Official wallets-list entry: app_name "tonkeeper", about_url
    // https://tonkeeper.com (verified 2026-09-29).
  }),
  // ——— Software wallets, alphabetical ———
  Object.freeze({
    id: TON_WALLET_IDS.MYTONWALLET,
    name: "MyTonWallet",
    status: "ok",
    installUrl: "https://mytonwallet.io/",
    detection: "ton-connect",
    // wallets-list: app_name "mytonwallet", about_url https://mywallet.io.
  }),
  Object.freeze({
    id: TON_WALLET_IDS.TELEGRAM,
    name: "Telegram Wallet",
    status: "ok",
    installUrl: "https://wallet.tg/",
    detection: "ton-connect",
    // wallets-list: app_name "telegram-wallet", about_url https://wallet.tg/.
  }),
  Object.freeze({
    id: TON_WALLET_IDS.TONHUB,
    name: "Tonhub",
    status: "ok",
    installUrl: "https://tonhub.com/",
    detection: "ton-connect",
    // wallets-list: app_name "tonhub", about_url https://tonhub.com.
  }),
  // ——— Deposit address — ALWAYS the final row, never removed ———
  Object.freeze({
    id: TON_DEPOSIT_ADDRESS_ID,
    name: "Deposit address (any TON wallet or exchange)",
    depositAddress: true,
    status: "ok",
    todo: "deposit address + memo/comment (if any) arrive from the quote/inbound flow — never guessed here",
  }),
]);
