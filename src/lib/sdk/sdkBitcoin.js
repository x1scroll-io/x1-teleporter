/**
 * sdkBitcoin.js — READINESS SCAFFOLDING for the official Bitcoin SDK
 * (`bitcoinjs-lib`, pinned ^7.0.1 — verified on npm 2026-09-06).
 *
 * ROADMAP LEG: UTXO-native in-app tx builders (BTC/DOGE/LTC). The leg-sdk
 * audit's verdict (docs/LEG-SDK-AUDIT.md §4.3): the THORChain deposit-address
 * lane's UTXO deposit txs are executed OUT-OF-BAND in the user's external
 * wallet today — "If an in-app deposit-tx builder ever lands, those become
 * the SDKs." bitcoinjs-lib is that SDK for the Bitcoin-family chains. This
 * module exists so it is GRABBED, version-pinned and import-verified ahead
 * of that landing (PSBT construction = payments + Psbt; balances stay on the
 * wallet-provider layer — laser-eyes/registry — bitcoinjs is a tx library,
 * not a chain RPC client).
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no
 * broadcasts — import/verify only.
 *
 * SHAPE VERIFIED at 7.0.1 (probe, 2026-09-06): exports Psbt, payments,
 * networks, address, script. Offline p2wpkh derivation from a fixed pubkey
 * executed successfully (bc1q… output).
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — the checked `bitcoinjs-lib` namespace. */
export const loadBitcoinSdk = makeSdkLoader("bitcoinjs-lib", {
  exports: ["Psbt", "payments", "networks"],
});

const NETWORK_ALIASES = {
  bitcoin: "bitcoin",
  btc: "bitcoin",
  testnet: "testnet",
  dogecoin: "dogecoin",
  dgc: "dogecoin",
  litecoin: "litecoin",
  ltc: "litecoin",
};

function resolveNetwork(ns, networkName) {
  const key = NETWORK_ALIASES[String(networkName ?? "bitcoin").toLowerCase()] ?? "bitcoin";
  return ns.networks[key] ?? ns.networks.bitcoin;
}

/**
 * Build a native-segwit (p2wpkh) payment for a pubkey — offline. The future
 * in-app deposit-tx builder's address/output primitive (extend with p2tr
 * when the builder lands; the SDK's payments namespace carries it).
 * @param {object} params
 * @param {Uint8Array|Buffer} params.pubkey 33-byte compressed pubkey
 * @param {string} [params.networkName] bitcoin|testnet|dogecoin|litecoin
 * @returns {Promise<{address: string, output: Buffer}>} the payment object
 */
export async function buildPayment({ pubkey, networkName = "bitcoin" } = {}) {
  const ns = await loadBitcoinSdk();
  return ns.payments.p2wpkh({ pubkey: Buffer.from(pubkey), network: resolveNetwork(ns, networkName) });
}

/**
 * Start a PSBT through the official lib — the future builder's container for
 * UTXO inputs + the payment output above.
 * @param {object} [params]
 * @param {string} [params.networkName] bitcoin|testnet|dogecoin|litecoin
 * @returns {Promise<object>} a bitcoinjs-lib Psbt
 */
export async function newPsbt({ networkName = "bitcoin" } = {}) {
  const ns = await loadBitcoinSdk();
  return new ns.Psbt({ network: resolveNetwork(ns, networkName) });
}

/**
 * Derive the p2wpkh address for a pubkey — convenience over buildPayment.
 * @param {object} params @see buildPayment
 * @returns {Promise<string>} the bech32 (bc1…/tb1…) address
 */
export async function btcAddressFromPubkey(params) {
  const payment = await buildPayment(params);
  return payment.address;
}
