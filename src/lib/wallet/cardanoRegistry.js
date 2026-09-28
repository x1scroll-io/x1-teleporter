/**
 * Canonical Cardano wallet table (CIP-30) — the connect modal's Cardano
 * family renders exactly these rows in exactly this order. Nothing invented:
 * every wallet is a real CIP-30 ("Cardano dApp-Wallet Web Bridge") provider.
 *
 * Ordering mirrors docs/WALLET-REGISTRY.md connect-modal layout:
 *   1. Starport (pinned, first — Starport ships a CIP-30 provider).
 *   2. The reference wallet: Eternl (née ccvault).
 *   3. Other software wallets, ALPHABETICAL.
 *   4. Hardware: Ledger.
 *   5. WalletConnect (mobile).
 *   6. Deposit-address row — NONE for Cardano: ADA runs the ChangeNOW
 *      long-tail rail (deposit address), not the THORChain native deposit row.
 *
 * Status legend: ✅ maintained · ⚠️ verify at build time.
 *
 * DISCOVERY RULE (binding): CIP-30 only — read window.cardano[<key>].
 * Each wallet injects under its own key (eternl, nami, lace, …). Never read
 * a wallet's internal state; enable() is the only handshake.
 *
 * ISOLATION RULE (binding): Cardano wallets must NEVER appear in the EVM
 * list. EVM discovery is EIP-6963-only; Cardano discovery is CIP-30-only.
 */

/** Wallet ids used as the modal match keys (cardano family). */
export const CARDANO_WALLET_IDS = Object.freeze({
  STARPORT: "starport",
  ETERNL: "eternl",
  NAMI: "nami",
  LACE: "lace",
  FLINT: "flint",
  VESPR: "vespr",
  TYPHON: "typhon",
  GERO: "gero",
  YOROI: "yoroi",
  LEDGER: "Ledger",
  WALLETCONNECT: "WalletConnect",
});

/**
 * The full Cardano wallet list, in modal order. Do NOT reorder.
 *
 * `cip30Key` is the window.cardano key each wallet injects (the CIP-30
 * discovery key). `detection:"cip30"` rows are discovered by that key;
 * `detection:"todo"` rows are gated behind build-time verification.
 */
export const CARDANO_WALLETS = Object.freeze([
  Object.freeze({
    id: CARDANO_WALLET_IDS.STARPORT,
    name: "Starport",
    pinned: true,
    installUrl: null, // no public install link yet — pinned + dev mock fallback
  }),
  // ——— Reference wallet: Eternl (née ccvault) ———
  Object.freeze({
    id: CARDANO_WALLET_IDS.ETERL,
    name: "Eternl",
    reference: true,
    status: "ok",
    installUrl: "https://eternl.io/",
    detection: "cip30",
    cip30Key: "eternl",
  }),
  // ——— Software wallets, alphabetical ———
  Object.freeze({
    id: CARDANO_WALLET_IDS.FLINT,
    name: "Flint",
    status: "ok",
    installUrl: "https://flint-wallet.com/",
    detection: "cip30",
    cip30Key: "flint",
  }),
  Object.freeze({
    id: CARDANO_WALLET_IDS.GERO,
    name: "Gero",
    status: "ok",
    installUrl: "https://gerowallet.io/",
    detection: "cip30",
    cip30Key: "gerowallet",
  }),
  Object.freeze({
    id: CARDANO_WALLET_IDS.LACE,
    name: "Lace",
    status: "ok",
    installUrl: "https://www.lace.io/",
    detection: "cip30",
    cip30Key: "lace",
  }),
  Object.freeze({
    id: CARDANO_WALLET_IDS.NAMI,
    name: "Nami",
    status: "ok",
    installUrl: "https://namiwallet.io/",
    detection: "cip30",
    cip30Key: "nami",
  }),
  Object.freeze({
    id: CARDANO_WALLET_IDS.TYPHON,
    name: "Typhon",
    status: "ok",
    installUrl: "https://typhonwallet.io/",
    detection: "cip30",
    cip30Key: "typhoncip30",
  }),
  Object.freeze({
    id: CARDANO_WALLET_IDS.VESPR,
    name: "Vespr",
    status: "ok",
    installUrl: "https://vespr.xyz/",
    detection: "cip30",
    cip30Key: "vespr",
  }),
  Object.freeze({
    id: CARDANO_WALLET_IDS.YOROI,
    name: "Yoroi",
    status: "ok",
    installUrl: "https://yoroi-wallet.com/",
    detection: "cip30",
    cip30Key: "yoroi",
  }),
  // ——— Hardware ———
  Object.freeze({
    id: CARDANO_WALLET_IDS.LEDGER,
    name: "Ledger",
    status: "verify",
    installUrl: "https://www.ledger.com/",
    detection: "todo",
    // ⚠️ TODO (verify at build time): Ledger Cardano is exposed through the
    // Eternl/Lace/Yoroi hardware bridge, not its own CIP-30 key — verify the
    // intended path before wiring.
    todo: "verify Ledger Cardano via the Eternl/Lace/Yoroi hardware bridge before wiring",
  }),
  // ——— Mobile ———
  Object.freeze({
    id: CARDANO_WALLET_IDS.WALLETCONNECT,
    name: "WalletConnect",
    status: "verify",
    installUrl: null,
    detection: "todo",
    todo: "verify the Cardano WalletConnect path before wiring",
  }),
]);
