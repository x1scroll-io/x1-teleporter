/**
 * Canonical Bitcoin wallet table (Step 2.3) — transcribed from the Bitcoin
 * section of docs/WALLET-REGISTRY.md (the canonical registry, PR #15). THE
 * SPEC: the connect modal's Bitcoin family renders exactly these rows in
 * exactly this order. Nothing here is invented — every detection key and
 * every connect API comes from the registry table.
 *
 * Ordering follows docs/WALLET-REGISTRY.md "Connect modal layout" as
 * applied to the Bitcoin family:
 *   1. Starport (pinned, first — flips to installed only if it announces
 *      Bitcoin).
 *   2. The family's reference wallet: Xverse.
 *   3. Every other software wallet, ALPHABETICAL — ✅ and ⚠️ rows alike
 *      (⚠️ rows are still shown, never hidden; they carry a `todo` note
 *      about what needs verifying, per the runbook: no guessed APIs).
 *   4. Hardware: Ledger, Trezor.
 *   5. Deposit-address row — ALWAYS last, never removed (the v1 path).
 *
 * Status legend (registry): ✅ maintained · ⚠️ verify at build time.
 * Every ⚠️ row below has a `todo` string naming exactly what must be
 * verified in a real browser before its connect path is wired.
 *
 * `laserEyesProvider` is the @omnisat/lasereyes provider type for wallets
 * LaserEyes ships an explicit provider for (the registry mandates LaserEyes
 * for exactly these). Wallets WITHOUT a LaserEyes provider get their
 * namespaced detection + a minimal per-table connect adapter in
 * bitcoinDiscovery.js — never a generic fallback.
 */

/** Wallet ids used as the modal match keys (bitcoin family). */
export const BITCOIN_WALLET_IDS = Object.freeze({
  STARPORT: "starport",
  XVERSE: "Xverse",
  UNISAT: "Unisat",
  LEATHER: "Leather",
  OKX: "OKX Wallet",
  PHANTOM: "Phantom",
  MAGIC_EDEN: "Magic Eden",
  BITGET: "Bitget Wallet",
  COINBASE: "Coinbase Wallet",
  TRUST: "Trust Wallet",
  CTRL: "Ctrl",
  ENKRYPT: "Enkrypt",
  KEPLR: "Keplr",
  LEAP: "Leap",
  WIZZ: "Wizz",
  OYL: "Oyl",
  ORANGE: "Orange",
  OP_NET: "OP_NET",
  LEDGER: "Ledger",
  TREZOR: "Trezor",
  DEPOSIT_ADDRESS: "deposit-address",
});

/**
 * Wallets known to inject a Unisat-compatible object at the bare
 * `window.unisat` key (registry collision rules: "Bitget, OKX, Wizz, and
 * others inject a Unisat-compatible object at that key"). The bare global
 * counts as REAL Unisat only when none of these is present (detected via
 * its own namespaced key). See detectBareUnisat() in bitcoinDiscovery.js.
 */
export const UNISAT_IMPERSONATORS = Object.freeze([
  BITCOIN_WALLET_IDS.BITGET, // window.bitkeep.unisat
  BITCOIN_WALLET_IDS.OKX, // window.okxwallet.bitcoin
  BITCOIN_WALLET_IDS.WIZZ, // window.wizz
]);

/** Id of the always-last, never-removed deposit-address row. */
export const DEPOSIT_ADDRESS_ID = BITCOIN_WALLET_IDS.DEPOSIT_ADDRESS;

/**
 * The full Bitcoin wallet list, in modal order. Do NOT reorder: the modal
 * (modalLogic.js) renders pinned → reference → software-alpha → hardware →
 * deposit-address, and the tests pin this exact order.
 */
export const BITCOIN_WALLETS = Object.freeze([
  Object.freeze({
    id: BITCOIN_WALLET_IDS.STARPORT,
    name: "Starport",
    pinned: true,
    installUrl: null, // no public install link yet — pinned + dev mock fallback
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.XVERSE,
    name: "Xverse",
    reference: true,
    status: "ok",
    installUrl: "https://www.xverse.app/download",
    detection: "global+standard",
    detectionKey: "window.XverseProviders.BitcoinProvider",
    laserEyesProvider: "xverse", // XVERSE from @omnisat/lasereyes
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.BITGET,
    name: "Bitget Wallet",
    status: "ok",
    installUrl: "https://web3.bitget.com/en/wallet/download",
    detection: "global",
    detectionKey: "window.bitkeep.unisat",
    // LaserEyes ships NO Bitget provider. Registry: "Unisat-compatible" —
    // the connect adapter in bitcoinDiscovery.js speaks exactly that
    // surface (requestAccounts) against window.bitkeep.unisat. Never via
    // bare window.unisat (registry collision rule).
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.CTRL,
    name: "Ctrl",
    status: "ok",
    installUrl: "https://ctrl.xyz/",
    detection: "global",
    detectionKey: "window.xfi.bitcoin",
    // LaserEyes ships NO Ctrl (ex-XDEFI) provider. Registry connect API:
    // request({ method: "request_accounts" }) — the adapter uses exactly
    // that, nothing more.
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.LEATHER,
    name: "Leather",
    status: "ok",
    installUrl: "https://leather.io/",
    detection: "global",
    detectionKey: "window.LeatherProvider",
    laserEyesProvider: "leather", // LEATHER
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.MAGIC_EDEN,
    name: "Magic Eden",
    status: "verify",
    installUrl: "https://wallet.magiceden.io/",
    detection: "global",
    detectionKey: "window.magicEden.bitcoin",
    laserEyesProvider: "magic-eden", // MAGIC_EDEN
    // ⚠️ TODO (verify at build time): ME exited Bitcoin NFTs Mar 2026 —
    // confirm the wallet extension still ships with window.magicEden.bitcoin
    // before shipping the connect path. Detection is per the registry
    // table; the connect adapter stays behind this todo until verified.
    todo: "verify the Magic Eden extension still ships window.magicEden.bitcoin (ME exited Bitcoin NFTs Mar 2026)",
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.OKX,
    name: "OKX Wallet",
    status: "ok",
    installUrl: "https://www.okx.com/web3",
    detection: "global",
    detectionKey: "window.okxwallet.bitcoin",
    laserEyesProvider: "okx", // OKX
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.OP_NET,
    name: "OP_NET",
    status: "verify",
    installUrl: "https://opnet.org/",
    detection: "global",
    detectionKey: "window.opnet",
    laserEyesProvider: "op_net", // OP_NET
    // ⚠️ TODO (verify at build time): registry marks OP_NET "Niche" — the
    // LaserEyes provider exists, but confirm the extension is still
    // maintained before shipping the connect path.
    todo: "verify the OP_NET extension is still maintained (registry marks it Niche)",
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.ORANGE,
    name: "Orange",
    status: "ok",
    installUrl: "https://www.orangewallet.com/",
    detection: "global",
    detectionKey: "window.OrangeWalletProviders.OrangeBitcoinProvider",
    laserEyesProvider: "orange", // ORANGE
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.OYL,
    name: "Oyl",
    status: "ok",
    installUrl: "https://www.oyl.io/",
    detection: "global",
    detectionKey: "window.oyl",
    laserEyesProvider: "oyl", // OYL
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.PHANTOM,
    name: "Phantom",
    status: "ok",
    installUrl: "https://phantom.app/",
    detection: "global+standard",
    detectionKey: "window.phantom.bitcoin",
    laserEyesProvider: "phantom", // PHANTOM
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.UNISAT,
    name: "Unisat",
    status: "ok",
    installUrl: "https://unisat.io/",
    detection: "unisat", // bare window.unisat — impersonation-aware ONLY
    detectionKey: "window.unisat",
    laserEyesProvider: "unisat", // UNISAT
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.WIZZ,
    name: "Wizz",
    status: "ok",
    installUrl: "https://wizzwallet.io/",
    detection: "global",
    detectionKey: "window.wizz",
    laserEyesProvider: "wizz", // WIZZ
  }),
  // ——— ⚠️ rows with NO wired connect path (verify first, never guess) ———
  Object.freeze({
    id: BITCOIN_WALLET_IDS.COINBASE,
    name: "Coinbase Wallet",
    status: "verify",
    installUrl: "https://www.coinbase.com/wallet/downloads",
    detection: "standard", // Wallet Standard for Bitcoin only
    // ⚠️ TODO (verify at build time): registry — "BTC in extension; verify
    // PSBT signing exposed". No connect API is listed in the registry, so
    // no connect path is wired: detection (Wallet Standard) only.
    todo: "verify Coinbase Wallet exposes its BTC PSBT/account surface in the extension (registry ⚠️)",
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.ENKRYPT,
    name: "Enkrypt",
    status: "verify",
    installUrl: "https://www.enkrypt.com/",
    detection: "standard", // Wallet Standard / injected per registry
    // ⚠️ TODO (verify at build time): registry — "BTC supported; verify
    // PSBT API". Detection via Wallet Standard registration only; no
    // connect path until the PSBT/account surface is verified.
    todo: "verify Enkrypt's Bitcoin PSBT/account API surface (registry ⚠️)",
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.KEPLR,
    name: "Keplr",
    status: "verify",
    installUrl: "https://www.keplr.app/",
    detection: "todo",
    // ⚠️ TODO (verify at build time): registry — "Keplr added Bitcoin;
    // verify send/psbt". Detection key unverified (window.keplr BTC
    // methods) — do NOT guess; wire detection + connect after verification.
    todo: "verify Keplr's Bitcoin detection key and send/PSBT methods (registry ⚠️)",
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.LEAP,
    name: "Leap",
    status: "verify",
    installUrl: "https://www.leapwallet.io/",
    detection: "todo",
    // ⚠️ TODO (verify at build time): registry — "window.leapBitcoin?"
    // (key unverified). Do NOT guess; wire detection + connect after
    // verification.
    todo: "verify Leap's Bitcoin detection key (window.leapBitcoin?) and API (registry ⚠️)",
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.TRUST,
    name: "Trust Wallet",
    status: "verify",
    installUrl: "https://trustwallet.com/",
    detection: "todo",
    // ⚠️ TODO (verify at build time): registry — "window.trustwallet.bitcoin?
    // verify API surface" (key unverified). Do NOT guess; wire detection +
    // connect after verification.
    todo: "verify Trust Wallet's Bitcoin detection key (window.trustwallet.bitcoin?) and API surface (registry ⚠️)",
  }),
  // ——— Hardware (after software, before deposit-address) ———
  Object.freeze({
    id: BITCOIN_WALLET_IDS.LEDGER,
    name: "Ledger",
    status: "ok",
    hardware: true,
    installUrl: "https://www.ledger.com/",
    detection: "todo",
    // TODO (Phase 3, signing lane): WebHID via ledger-bitcoin (PSBT).
    // Discovery-only PR — hardware connect is a later step. Not a ⚠️
    // registry row; deliberately unwired here.
  }),
  Object.freeze({
    id: BITCOIN_WALLET_IDS.TREZOR,
    name: "Trezor",
    status: "ok",
    hardware: true,
    installUrl: "https://trezor.io/",
    detection: "todo",
    // TODO (Phase 3, signing lane): @trezor/connect-web signTransaction.
    // Discovery-only PR — hardware connect is a later step.
  }),
  // ——— Deposit address — ALWAYS the final row, never removed ———
  Object.freeze({
    id: DEPOSIT_ADDRESS_ID,
    name: "Deposit address (Sparrow / Electrum / any desktop)",
    depositAddress: true,
    status: "ok",
    // ⚠️ TODO (Step 3.3, THORChain flow): the memo field comes from the
    // THORChain quote (affiliate + destination); the deposit address comes
    // from /thorchain/inbound_addresses. NOT guessed here — this row
    // renders the concept + a QR placeholder only.
  }),
]);

/**
 * Wallet Standard Bitcoin registrations → registry id. The registry table
 * lists which wallets register for Bitcoin via Wallet Standard (Xverse,
 * Unisat, Leather, OKX, Phantom, Magic Eden, Coinbase do). Names are
 * matched case-insensitively against the Wallet Standard wallet `name`.
 * Wallets announcing bitcoin chains but NOT in this map are surfaced as
 * `standard:<name>` extras (never hidden) with no connect adapter.
 */
export const BITCOIN_STANDARD_NAME_MAP = Object.freeze({
  xverse: BITCOIN_WALLET_IDS.XVERSE,
  unisat: BITCOIN_WALLET_IDS.UNISAT,
  leather: BITCOIN_WALLET_IDS.LEATHER,
  okx: BITCOIN_WALLET_IDS.OKX,
  "okx wallet": BITCOIN_WALLET_IDS.OKX,
  phantom: BITCOIN_WALLET_IDS.PHANTOM,
  "magic eden": BITCOIN_WALLET_IDS.MAGIC_EDEN,
  "magic eden wallet": BITCOIN_WALLET_IDS.MAGIC_EDEN,
  "coinbase wallet": BITCOIN_WALLET_IDS.COINBASE,
  enkrypt: BITCOIN_WALLET_IDS.ENKRYPT,
});

/** Is a registry entry the always-last deposit-address row? */
export function isDepositAddressEntry(entry) {
  return entry?.depositAddress === true;
}

/** Is a registry entry a hardware wallet (Ledger / Trezor)? */
export function isHardwareEntry(entry) {
  return entry?.hardware === true;
}
