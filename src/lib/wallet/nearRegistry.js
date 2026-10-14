/**
 * Canonical NEAR wallet table (NEAR Wallet Selector) — the connect modal's
 * NEAR family renders exactly these rows in exactly this order. Nothing
 * invented: every row is a real NEAR Wallet Selector module
 * (@near-wallet-selector/<id>), confirmed against the published packages.
 *
 * Ordering mirrors docs/WALLET-REGISTRY.md connect-modal layout:
 *   1. Starport (pinned, first).
 *   2. The reference wallet: MyNearWallet (NEAR's flagship web wallet —
 *      the canonical "connect" entry point, mirrors MetaMask/Phantom/Xaman).
 *   3. Other software wallets, ALPHABETICAL (Meteor, Nightly, Sender).
 *   4. Hardware: Ledger.
 *   5. Deposit-address row — ALWAYS the final row, never connectable
 *      (the ChangeNOW / bridge long-tail fallback: NEAR is a ChangeNOW
 *      deposit chain, so a user with NO dApp connector still has a path).
 *
 * ── WHY A DEPOSIT-ADDRESS ROW ALWAYS EXISTS (fail-closed) ─────────────────
 * The NEAR Wallet Selector is loaded only in a browser (it needs the wallet
 * SDKs + injected extensions). In a browser-less / non-browser context, or
 * when NO NEAR wallet is installed, discovery reports ZERO connectable
 * wallets. Rather than a dead Connect button, the modal falls through to the
 * deposit-address row (the same pattern as XRP's `depositOnly` Tangem/main
 * row) — the bridge still works, it just routes the user through the
 * out-of-band deposit rail instead of a dApp session.
 *
 * DISCOVERY RULE (binding): the NEAR Wallet Selector OWNS CONNECT — discovery
 * enumerates `selector.store.getState().modules` and connect goes through
 * `selector.wallet(id).signIn(...)`. INSTALL DETECTION, however, is a POSITIVE
 * presence probe against the injected globals (nearDiscovery.js
 * NEAR_PRESENCE_PROBES): the selector's `metadata.available` is unreliable
 * (the web wallets hard-code `available: true`, Ledger reports WebHID
 * support), so trusting it made every NEAR row claim "Installed" with nothing
 * installed. Wallets with no positive signal (MyNearWallet, Ledger) always
 * show "Install".
 *
 * ISOLATION RULE (binding): NEAR wallets must NEVER appear in the EVM/Solana
 * lists. NEAR discovery is Wallet-Selector-only.
 *
 * Status legend: ✅ maintained (verified against the published packages).
 */

/** Wallet ids used as the modal match keys (near family) — these EXACTLY
 *  equal the NEAR Wallet Selector module ids, so discovery keys match the
 *  registry rows. */
export const NEAR_WALLET_IDS = Object.freeze({
  STARPORT: "starport",
  MY_NEAR_WALLET: "my-near-wallet",
  METEOR: "meteor-wallet",
  NIGHTLY: "nightly",
  SENDER: "sender",
  LEDGER: "ledger",
  DEPOSIT_ADDRESS: "deposit-address",
});

/** Id of the always-last, never-removed deposit-address row. */
export const NEAR_DEPOSIT_ADDRESS_ID = NEAR_WALLET_IDS.DEPOSIT_ADDRESS;

/**
 * The full NEAR wallet list, in modal order. Do NOT reorder: the modal
 * (modalLogic.js) renders pinned → reference → software-alpha → hardware →
 * deposit-address, and the tests pin this exact order.
 *
 * Every row carries `detection:"near-selector"` (the NEAR Wallet Selector is
 * the sole detection source — no injected-global reads). `selectorModule`
 * records the @near-wallet-selector/<id> package that provides the module.
 */
export const NEAR_WALLETS = Object.freeze([
  Object.freeze({
    id: NEAR_WALLET_IDS.STARPORT,
    name: "Starport",
    pinned: true,
    installUrl: null, // no public install link yet — pinned + dev mock fallback
    // Starport's NEAR support is not wired into the NEAR Wallet Selector yet —
    // the pinned row stays (it is pinned in EVERY family) and fails closed to
    // the deposit-address row until a real NEAR module ships.
    detection: "todo",
    todo: "wire Starport's NEAR provider into the NEAR Wallet Selector when the module ships (pinned row, no guessed module)",
  }),
  // ——— Reference wallet: MyNearWallet ———
  Object.freeze({
    id: NEAR_WALLET_IDS.MY_NEAR_WALLET,
    name: "MyNearWallet",
    reference: true,
    status: "ok",
    installUrl: "https://www.mynearwallet.com/",
    detection: "near-selector",
    selectorModule: "@near-wallet-selector/my-near-wallet",
  }),
  // ——— Software wallets, alphabetical ———
  Object.freeze({
    id: NEAR_WALLET_IDS.METEOR,
    name: "Meteor Wallet",
    status: "ok",
    installUrl: "https://meteorwallet.app/",
    detection: "near-selector",
    selectorModule: "@near-wallet-selector/meteor-wallet",
  }),
  Object.freeze({
    id: NEAR_WALLET_IDS.NIGHTLY,
    name: "Nightly",
    status: "ok",
    installUrl: "https://wallet.nightly.app/",
    detection: "near-selector",
    selectorModule: "@near-wallet-selector/nightly",
  }),
  Object.freeze({
    id: NEAR_WALLET_IDS.SENDER,
    name: "Sender",
    status: "ok",
    installUrl: null, // official site not verifiable from the build host — never guessed
    detection: "near-selector",
    selectorModule: "@near-wallet-selector/sender",
    todo: "confirm Sender's official install URL before linking (never guess a domain)",
  }),
  // ——— Hardware (after software) ———
  Object.freeze({
    id: NEAR_WALLET_IDS.LEDGER,
    name: "Ledger",
    hardware: true,
    status: "ok",
    installUrl: "https://www.ledger.com/",
    detection: "near-selector",
    selectorModule: "@near-wallet-selector/ledger",
  }),
  // ——— Deposit address — ALWAYS the final row, never removed ———
  Object.freeze({
    id: NEAR_DEPOSIT_ADDRESS_ID,
    name: "Deposit address (any NEAR wallet or exchange)",
    depositAddress: true,
    status: "ok",
    // The out-of-band rail: a user with no dApp connector deposits to the
    // bridge's NEAR deposit address (ChangeNOW long-tail rail / bridge
    // inbound). Fail-closed fallback — never a dead Connect button.
    todo: "deposit address + memo (if any) arrive from the quote/inbound flow — never guessed here",
  }),
]);
