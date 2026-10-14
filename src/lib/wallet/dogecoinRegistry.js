/**
 * Canonical Dogecoin wallet table (Step 2.4) — transcribed from the
 * Dogecoin section of docs/WALLET-REGISTRY.md (the canonical registry,
 * PR #15). THE SPEC: the connect modal's Dogecoin family renders exactly
 * these rows in exactly this order. Nothing here is invented — every
 * detection key and every status comes from the registry table.
 *
 * Ordering follows docs/WALLET-REGISTRY.md "Connect modal layout" as
 * applied to the Dogecoin family:
 *   1. Starport (pinned, first).
 *   2. The family's reference wallet: Ctrl (ex-XDEFI) — memo supported.
 *   3. Every other software wallet, ALPHABETICAL — ✅ and ⚠️ rows alike
 *      (⚠️ rows are still shown, never hidden; they carry a `todo` note).
 *   4. Hardware: Ledger, Trezor (XChainJS `xchain-doge`).
 *   5. Deposit-address row — ALWAYS last, never removed (the v1 path).
 *
 * Status legend (registry): ✅ maintained · ⚠️ verify at build time.
 * Every ⚠️ row below has a `todo` string naming exactly what must be
 * verified in a real browser before its connect path is wired.
 *
 * MEMO RULE (THORChain lane, binding — same as Litecoin): THORChain needs
 * the memo in an OP_RETURN. Wallets with `memoSupport: "op_return"` can
 * send in-app (signing is a later Pro-lane step); wallets with
 * `memoSupport: "verify"` or `"none"` show their balance and hand sends
 * off to the deposit-address row (memoRule.js + the modal implement this).
 *
 * NOTE on MyDoge: the canonical table marks it ✅ but with "(verify)"
 * annotations on BOTH the detection key (`window.doge`) and the
 * OP_RETURN/memo support ("if absent, it's balance-only + deposit-address").
 * Per the runbook ("if a registry wallet's API is unverifiable, mark it
 * ⚠️ TODO — never guess") it is treated as ⚠️ here: detection is wired per
 * the table's key, connect stays gated behind the verify TODO.
 */

/** Wallet ids used as the modal match keys (dogecoin family). */
export const DOGECOIN_WALLET_IDS = Object.freeze({
  STARPORT: "starport",
  CTRL: "Ctrl",
  MYDOGE: "MyDoge",
  DOGELABS: "DogeLabs",
  ENKRYPT: "Enkrypt",
  OKX: "OKX Wallet",
  TRUST: "Trust Wallet",
  BITGET: "Bitget Wallet",
  LEDGER: "Ledger",
  TREZOR: "Trezor",
  DEPOSIT_ADDRESS: "deposit-address",
});

/** Id of the always-last, never-removed deposit-address row. */
export const DOGECOIN_DEPOSIT_ADDRESS_ID = DOGECOIN_WALLET_IDS.DEPOSIT_ADDRESS;

/**
 * The full Dogecoin wallet list, in modal order. Do NOT reorder: the modal
 * (modalLogic.js) renders pinned → reference → software-alpha → hardware →
 * deposit-address, and the tests pin this exact order.
 */
export const DOGECOIN_WALLETS = Object.freeze([
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.STARPORT,
    name: "Starport",
    pinned: true,
    installUrl: null, // no public install link yet — pinned + dev mock fallback
  }),
  // ——— Reference wallet (second, right after Starport) ———
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.CTRL,
    name: "Ctrl (ex-XDEFI)",
    reference: true,
    status: "ok",
    installUrl: "https://ctrl.xyz/",
    detection: "global",
    detectionKey: "window.xfi.dogecoin",
    // Registry: "Memo supported". Memo-on-send is THORChain-lane signing
    // (a later Pro-lane step); THIS PR wires discovery + session + balance.
    memoSupport: "op_return",
  }),
  // ——— Software wallets, alphabetical (✅ and ⚠️ mixed) ———
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.BITGET,
    name: "Bitget Wallet",
    status: "verify",
    installUrl: "https://web3.bitget.com/en/wallet/download",
    detection: "todo",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "send exists; dApp memo
    // unverified" (Bitget grouped with OKX/Trust for DOGE).
    todo: "verify Bitget Wallet's Dogecoin dApp API + memo support (registry ⚠️ 'send exists; dApp memo unverified')",
  }),
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.DOGELABS,
    name: "DogeLabs Wallet",
    status: "verify",
    installUrl: null, // official site unverifiable from the build host — TODO, never guessed
    detection: "global",
    detectionKey: "window.dogeLabs",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "Doginals-focused",
    // detection key marked "(verify)". The connect API is undocumented —
    // never guess. installUrl is null because no official site could be
    // verified (do not link to a guessed domain).
    todo: "verify DogeLabs' window.dogeLabs API surface + OP_RETURN/memo support (registry ⚠️ 'Doginals-focused') and its official install URL",
  }),
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.ENKRYPT,
    name: "Enkrypt",
    status: "verify",
    installUrl: "https://www.enkrypt.com/",
    detection: "todo",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "DOGE supported; verify
    // memo". Detection key + connect API unverified.
    todo: "verify Enkrypt's Dogecoin detection key + dApp API and OP_RETURN memo support (registry ⚠️)",
  }),
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.MYDOGE,
    name: "MyDoge",
    status: "verify",
    installUrl: "https://mydoge.com/",
    detection: "global",
    detectionKey: "window.doge",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): the canonical table marks MyDoge ✅
    // but with "(verify)" on BOTH the detection key (window.doge) and the
    // memo note ("verify OP_RETURN/memo support — if absent, it's
    // balance-only + deposit-address"). Treated as ⚠️ per the runbook
    // (no guessed APIs). Detection IS wired per the table's key.
    todo: "verify the window.doge detection key and MyDoge's OP_RETURN/memo support — if absent, balance-only + deposit-address hand-off (registry '(verify)')",
  }),
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.OKX,
    name: "OKX Wallet",
    status: "verify",
    installUrl: "https://www.okx.com/web3",
    detection: "todo",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "send exists; dApp memo
    // unverified". No detection key given; do NOT guess.
    todo: "verify OKX Wallet's Dogecoin dApp API surface + memo support (registry ⚠️ 'send exists; dApp memo unverified')",
  }),
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.TRUST,
    name: "Trust Wallet",
    status: "verify",
    installUrl: "https://trustwallet.com/",
    detection: "todo",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — same note as OKX.
    todo: "verify Trust Wallet's Dogecoin dApp API surface + memo support (registry ⚠️, same note as OKX)",
  }),
  // ——— Hardware (after software, before deposit-address) ———
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.LEDGER,
    name: "Ledger",
    status: "ok",
    hardware: true,
    installUrl: "https://www.ledger.com/",
    detection: "todo",
    memoSupport: "op_return", // via XChainJS xchain-doge transfer memo param
    // TODO (Phase 3, signing lane): registry — "via XChainJS xchain-doge".
    // Discovery-only PR — hardware connect is a later step; the XChainJS
    // wiring is deliberately TODO-gated (heavy SDK wiring, per runbook).
    todo: "TODO (Phase 3): wire xchain-doge Ledger client connect (memo via the XChainJS transfer memo param)",
  }),
  Object.freeze({
    id: DOGECOIN_WALLET_IDS.TREZOR,
    name: "Trezor",
    status: "ok",
    hardware: true,
    installUrl: "https://trezor.io/",
    detection: "todo",
    memoSupport: "op_return", // via XChainJS xchain-doge transfer memo param
    // TODO (Phase 3, signing lane): registry — Ledger/Trezor "via XChainJS
    // xchain-doge". Same treatment as Ledger above.
    todo: "TODO (Phase 3): wire xchain-doge Trezor connect (memo via the XChainJS transfer memo param)",
  }),
  // ——— Deposit address — ALWAYS the final row, never removed ———
  Object.freeze({
    id: DOGECOIN_DEPOSIT_ADDRESS_ID,
    name: "Deposit address (any Dogecoin wallet)",
    depositAddress: true,
    status: "ok",
    memoSupport: "op_return", // the deposit path supports OP_RETURN memos
    // ⚠️ TODO (Step 3.3, THORChain flow): the memo field comes from the
    // THORChain quote; the deposit address from /thorchain/inbound_addresses.
    // NOT guessed here — this row renders the concept + a QR placeholder.
    todo: "TODO (Step 3.3): deposit address + OP_RETURN memo arrive with the THORChain quote flow",
  }),
]);
