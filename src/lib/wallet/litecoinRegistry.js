/**
 * Canonical Litecoin wallet table (Step 2.4) — transcribed from the
 * Litecoin section of docs/WALLET-REGISTRY.md (the canonical registry,
 * PR #15). THE SPEC: the connect modal's Litecoin family renders exactly
 * these rows in exactly this order. Nothing here is invented — every
 * detection key and every status comes from the registry table.
 *
 * Ordering follows docs/WALLET-REGISTRY.md "Connect modal layout" as
 * applied to the Litecoin family:
 *   1. Starport (pinned, first).
 *   2. The family's reference wallet: Ctrl (ex-XDEFI) — the registry's
 *      "only clean LTC→THORChain extension path".
 *   3. Every other software wallet, ALPHABETICAL — ✅ and ⚠️ rows alike
 *      (⚠️ rows are still shown, never hidden; they carry a `todo` note
 *      about what needs verifying, per the runbook: no guessed APIs).
 *   4. Hardware: Ledger, Trezor (XChainJS `xchain-litecoin`).
 *   5. Deposit-address row — ALWAYS last, never removed (the v1 path).
 *
 * Status legend (registry): ✅ maintained · ⚠️ verify at build time.
 * Every ⚠️ row below has a `todo` string naming exactly what must be
 * verified in a real browser before its connect path is wired.
 *
 * MEMO RULE (THORChain lane, binding): THORChain needs the memo in an
 * OP_RETURN. Wallets that can attach one (`memoSupport: "op_return"`) can
 * send in-app (signing is a later Pro-lane step — this PR only wires
 * discovery/session/balance). Wallets with `memoSupport: "verify"` or
 * `"none"` show their balance and hand sends off to the deposit-address
 * row — that hand-off logic lives in memoRule.js and renders in the modal.
 */

/** Wallet ids used as the modal match keys (litecoin family). */
export const LITECOIN_WALLET_IDS = Object.freeze({
  STARPORT: "starport",
  CTRL: "Ctrl",
  LITESCRIBE: "Litescribe",
  ENKRYPT: "Enkrypt",
  OKX: "OKX Wallet",
  TRUST: "Trust Wallet",
  LEDGER: "Ledger",
  TREZOR: "Trezor",
  DEPOSIT_ADDRESS: "deposit-address",
});

/** Id of the always-last, never-removed deposit-address row. */
export const LITECOIN_DEPOSIT_ADDRESS_ID = LITECOIN_WALLET_IDS.DEPOSIT_ADDRESS;

/**
 * The full Litecoin wallet list, in modal order. Do NOT reorder: the modal
 * (modalLogic.js) renders pinned → reference → software-alpha → hardware →
 * deposit-address, and the tests pin this exact order.
 */
export const LITECOIN_WALLETS = Object.freeze([
  Object.freeze({
    id: LITECOIN_WALLET_IDS.STARPORT,
    name: "Starport",
    pinned: true,
    installUrl: null, // no public install link yet — pinned + dev mock fallback
  }),
  // ——— Reference wallet (second, right after Starport) ———
  Object.freeze({
    id: LITECOIN_WALLET_IDS.CTRL,
    name: "Ctrl (ex-XDEFI)",
    reference: true,
    status: "ok",
    installUrl: "https://ctrl.xyz/",
    detection: "global",
    detectionKey: "window.xfi.litecoin",
    // Registry: "Supports memo on send — the only clean LTC→THORChain
    // extension path". Memo-on-send is THORChain-lane signing (a later
    // Pro-lane step); THIS PR wires discovery + session + balance only.
    memoSupport: "op_return",
  }),
  // ——— Software wallets, alphabetical (✅ and ⚠️ mixed) ———
  Object.freeze({
    id: LITECOIN_WALLET_IDS.ENKRYPT,
    name: "Enkrypt",
    status: "verify",
    installUrl: "https://www.enkrypt.com/",
    detection: "todo",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "LTC supported; verify
    // memo". Detection key + dApp connect API unverified; wire both after
    // verification in a real browser. Never guess.
    todo: "verify Enkrypt's Litecoin detection key + dApp API and OP_RETURN memo support (registry ⚠️)",
  }),
  Object.freeze({
    id: LITECOIN_WALLET_IDS.LITESCRIBE,
    name: "Litescribe",
    status: "ok",
    installUrl: "https://www.litescribe.io/",
    detection: "global",
    detectionKey: "window.litescribe",
    memoSupport: "verify",
    // Registry: ✅ "Unisat-style API for LTC ordinals; verify OP_RETURN
    // memo support". The connect API is NOT documented in the registry
    // ("Unisat-style" is a hint, not a spec) — per the runbook
    // ("if a registry wallet's API is unverifiable, mark it ⚠️ TODO —
    // never guess") connect stays gated behind this TODO. Detection IS
    // wired per the table's key.
    connectTodo:
      "verify Litescribe's exact connect API (registry: 'Unisat-style API for LTC ordinals' — unverified) and its OP_RETURN memo support in a real browser before wiring connect",
  }),
  Object.freeze({
    id: LITECOIN_WALLET_IDS.OKX,
    name: "OKX Wallet",
    status: "verify",
    installUrl: "https://www.okx.com/web3",
    detection: "todo",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "LTC send exists; dApp
    // API unverified". No detection key given; do NOT guess.
    todo: "verify OKX Wallet's Litecoin dApp API surface + memo support (registry ⚠️ 'dApp API unverified')",
  }),
  Object.freeze({
    id: LITECOIN_WALLET_IDS.TRUST,
    name: "Trust Wallet",
    status: "verify",
    installUrl: "https://trustwallet.com/",
    detection: "todo",
    memoSupport: "verify",
    // ⚠️ TODO (verify at build time): registry — "same" (as OKX: send
    // exists; dApp memo unverified).
    todo: "verify Trust Wallet's Litecoin dApp API surface + memo support (registry ⚠️, same note as OKX)",
  }),
  // ——— Hardware (after software, before deposit-address) ———
  Object.freeze({
    id: LITECOIN_WALLET_IDS.LEDGER,
    name: "Ledger",
    status: "ok",
    hardware: true,
    installUrl: "https://www.ledger.com/",
    detection: "todo",
    memoSupport: "op_return", // via XChainJS xchain-litecoin transfer memo param
    // TODO (Phase 3, signing lane): registry — "via XChainJS
    // xchain-litecoin with Ledger client". Discovery-only PR — hardware
    // connect is a later step; the XChainJS wiring is deliberately
    // TODO-gated (the runbook allows this when the SDK wiring is heavy).
    todo: "TODO (Phase 3): wire xchain-litecoin Ledger client connect (memo via the XChainJS transfer memo param)",
  }),
  Object.freeze({
    id: LITECOIN_WALLET_IDS.TREZOR,
    name: "Trezor",
    status: "ok",
    hardware: true,
    installUrl: "https://trezor.io/",
    detection: "todo",
    memoSupport: "op_return", // via XChainJS xchain-litecoin transfer memo param
    // TODO (Phase 3, signing lane): registry — Ledger/Trezor "via XChainJS
    // xchain-litecoin". Same treatment as Ledger above.
    todo: "TODO (Phase 3): wire xchain-litecoin Trezor connect (memo via the XChainJS transfer memo param)",
  }),
  // ——— Deposit address — ALWAYS the final row, never removed ———
  Object.freeze({
    id: LITECOIN_DEPOSIT_ADDRESS_ID,
    name: "Deposit address (any Litecoin wallet)",
    depositAddress: true,
    status: "ok",
    memoSupport: "op_return", // the deposit path supports OP_RETURN memos
    // ⚠️ TODO (Step 3.3, THORChain flow): the memo field comes from the
    // THORChain quote; the deposit address from /thorchain/inbound_addresses.
    // NOT guessed here — this row renders the concept + a QR placeholder.
    todo: "TODO (Step 3.3): deposit address + OP_RETURN memo arrive with the THORChain quote flow",
  }),
]);
