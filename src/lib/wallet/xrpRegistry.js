/**
 * Canonical XRP Ledger wallet table (Step 2.4) — transcribed from the XRP
 * section of docs/WALLET-REGISTRY.md (the canonical registry, PR #15). THE
 * SPEC: the connect modal's XRP family renders exactly these rows in
 * exactly this order. Nothing here is invented — every detection key and
 * every status comes from the registry table.
 *
 * Ordering follows docs/WALLET-REGISTRY.md "Connect modal layout" as
 * applied to the XRP family:
 *   1. Starport (pinned, first).
 *   2. The family's reference wallet: Xaman (ex-XUMM) — the registry's
 *      PRIMARY wallet ("XRPL is mobile-first; treat Xaman as the primary
 *      wallet and deposit-address as the baseline").
 *   3. Every other software wallet, ALPHABETICAL — ✅ and ⚠️ rows alike.
 *   4. Hardware: Ledger (WebHID, @ledgerhq/hw-app-xrp), Trezor.
 *   5. ❌ wallets (Crossmark, GemWallet) — badged "unmaintained", ranked
 *      LAST (per the registry's ❌ treatment).
 *   6. Deposit-address row — ALWAYS the final row, never removed.
 *
 * Status legend (registry): ✅ maintained · ⚠️ verify at build time ·
 * ❌ stale/unmaintained (show, but badge "unmaintained" and rank last).
 *
 * MEMO RULE (THORChain lane, binding): the THORChain memo goes in the XRPL
 * `Memos` field, NOT a destination tag — documented on the Xaman row and
 * the deposit-address row, and enforced by memoRule.js / the modal.
 * Xaman's payload flow includes `Memos` (`memoSupport: "memos"`); wallets
 * with unverified memo support (`memoSupport: "verify"`) show balance and
 * hand sends off to the deposit-address row.
 */

/** Wallet ids used as the modal match keys (xrp family). */
export const XRP_WALLET_IDS = Object.freeze({
  STARPORT: "starport",
  XAMAN: "Xaman",
  JOEY: "Joey Wallet",
  BIFROST: "Bifrost Wallet",
  CROSSMARK: "Crossmark",
  GEMWALLET: "GemWallet",
  LEDGER: "Ledger",
  TREZOR: "Trezor",
  TANGEM: "Tangem",
  DEPOSIT_ADDRESS: "deposit-address",
});

/** Id of the always-last, never-removed deposit-address row. */
export const XRP_DEPOSIT_ADDRESS_ID = XRP_WALLET_IDS.DEPOSIT_ADDRESS;

/**
 * The full XRP wallet list, in modal order. Do NOT reorder: the modal
 * (modalLogic.js) renders pinned → reference → software-alpha → hardware →
 * unmaintained (❌) → deposit-address, and the tests pin this exact order.
 */
export const XRP_WALLETS = Object.freeze([
  Object.freeze({
    id: XRP_WALLET_IDS.STARPORT,
    name: "Starport",
    pinned: true,
    installUrl: null, // no public install link yet — pinned + dev mock fallback
  }),
  // ——— Reference wallet: Xaman — the registry's PRIMARY ———
  Object.freeze({
    id: XRP_WALLET_IDS.XAMAN,
    name: "Xaman (ex-XUMM)",
    reference: true,
    status: "ok",
    installUrl: "https://xaman.app/",
    detection: "todo", // mobile app, not a browser extension — no injected global
    memoSupport: "memos", // payload flow includes Memos (XRPL Memos field)
    // Registry: "xumm-sdk / xumm-universal-sdk — QR sign-in + payload
    // signing; mobile. PRIMARY. Payload includes Memos. TODO: verify
    // WalletConnect support in current version as an alternate path."
    // Connect is TODO-gated: QR sign-in requires the xumm SDK + Xumm API
    // credentials (apiKey) and its payload flow is Pro-lane (signing-
    // adjacent) — deliberately NOT wired in this discovery/session PR.
    // No guessed APIs, no dead SDK dependency.
    connectTodo:
      "wire Xaman connect via xumm-sdk / xumm-universal-sdk (QR sign-in needs Xumm API credentials) — TODO: verify WalletConnect support in the current version as an alternate path (Step 2.5 operator profile)",
  }),
  // ——— Software wallets, alphabetical (✅ and ⚠️ mixed) ———
  Object.freeze({
    id: XRP_WALLET_IDS.BIFROST,
    name: "Bifrost Wallet",
    status: "verify",
    installUrl: "https://bifrostwallet.com/",
    detection: "todo", // mobile wallet — no browser extension global documented
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "Multi-chain, XRPL-first;
    // from the XRP Toolkit team. Mobile; WalletConnect". The WalletConnect
    // path is unverified — never guess.
    todo: "verify Bifrost's WalletConnect integration + XRPL Memos support (registry ⚠️ 'mobile; WalletConnect')",
  }),
  Object.freeze({
    id: XRP_WALLET_IDS.JOEY,
    name: "Joey Wallet",
    status: "verify",
    installUrl: null, // official site unverifiable from the build host — TODO, never guessed
    detection: "todo", // mobile wallet — no browser extension global documented
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "mobile; WalletConnect
    // (verify)". installUrl is null because no official site could be
    // verified (do not link to a guessed domain).
    todo: "verify Joey Wallet's WalletConnect integration + XRPL Memos support and its official install URL (registry ⚠️)",
  }),
  Object.freeze({
    id: XRP_WALLET_IDS.TANGEM,
    name: "Tangem",
    status: "ok",
    installUrl: "https://tangem.com/",
    detection: "todo",
    depositOnly: true, // registry: "Not a dApp connector; deposit-address only"
    // Registry: "card/NFC, mobile — Not a dApp connector; deposit-address
    // only". Renders as an info row with an install link; never
    // connectable. The deposit flow itself is the final row below.
    memoSupport: "none",
  }),
  // ——— Hardware (after software, before the ❌ rows) ———
  Object.freeze({
    id: XRP_WALLET_IDS.LEDGER,
    name: "Ledger",
    status: "ok",
    hardware: true,
    installUrl: "https://www.ledger.com/",
    detection: "todo",
    memoSupport: "verify", // WebHID signing flow — memo support verified at Phase 3
    // TODO (Phase 3, signing lane): registry — "WebHID,
    // @ledgerhq/hw-app-xrp". Discovery-only PR — hardware connect is a
    // later step.
    todo: "TODO (Phase 3): wire @ledgerhq/hw-app-xrp WebHID connect (XRPL Memos in the signing flow)",
  }),
  Object.freeze({
    id: XRP_WALLET_IDS.TREZOR,
    name: "Trezor",
    status: "ok",
    hardware: true,
    installUrl: "https://trezor.io/",
    detection: "todo",
    memoSupport: "verify", // @trezor/connect-web signing flow — memo at Phase 3
    // TODO (Phase 3, signing lane): registry — "@trezor/connect-web".
    // Discovery-only PR — hardware connect is a later step.
    todo: "TODO (Phase 3): wire @trezor/connect-web connect (XRPL Memos in the signing flow)",
  }),
  // ——— ❌ stale/unmaintained — badged "unmaintained", ranked LAST ———
  Object.freeze({
    id: XRP_WALLET_IDS.CROSSMARK,
    name: "Crossmark",
    status: "unmaintained",
    unmaintained: true,
    installUrl: "https://crossmark.io/",
    detection: "global",
    detectionKey: "window.xrpl.crossmark",
    memoSupport: "verify",
    // Registry: ❌ "Last release Mar 2025; Firefox build gone. Show with
    // 'unmaintained' badge, rank last". The SDK (@crossmarkio/sdk) is not
    // wired — connect is gated behind the unmaintained note.
    todo: "unmaintained (last release Mar 2025; Firefox build gone) — connect NOT wired; revisit only if the project resumes releases",
  }),
  Object.freeze({
    id: XRP_WALLET_IDS.GEMWALLET,
    name: "GemWallet",
    status: "unmaintained",
    unmaintained: true,
    installUrl: "https://gemwallet.app/",
    detection: "todo", // API is the @gemwallet/api SDK — no namespaced global documented
    memoSupport: "verify",
    // Registry: ❌ "No release since late 2024. Same treatment" (as
    // Crossmark). The @gemwallet/api SDK is not wired — connect is gated
    // behind the unmaintained note. No detection key is documented, so
    // detection stays unwired too (never guess).
    todo: "unmaintained (no release since late 2024) — connect NOT wired; revisit only if the project resumes releases",
  }),
  // ——— Deposit address — ALWAYS the final row, never removed ———
  Object.freeze({
    id: XRP_DEPOSIT_ADDRESS_ID,
    name: "Deposit address (any XRP wallet or exchange)",
    depositAddress: true,
    status: "ok",
    memoSupport: "memos", // the deposit path carries the memo in the XRPL Memos field
    // ⚠️ TODO (Step 3.3, THORChain flow): the memo field comes from the
    // THORChain quote; the deposit address from /thorchain/inbound_addresses.
    // NOT guessed here — this row renders the concept + a QR placeholder.
    // The XRPL Memos-field rule is documented here AND rendered in the
    // modal (depositMemoNote in memoRule.js).
    todo: "TODO (Step 3.3): deposit address + memo arrive with the THORChain quote flow — the memo goes in the XRPL Memos field, NOT a destination tag",
  }),
]);
