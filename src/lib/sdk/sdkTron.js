/**
 * sdkTron.js — READINESS SCAFFOLDING for the official TRON SDK (`tronweb`,
 * pinned ^6.5.0 — the current package; @tronweb3/tronweb does NOT exist on
 * npm, verified 2026-09-06. The @tronweb3/tronwallet-adapters the app
 * already uses are the WALLET-CONNECT adapters, a different layer).
 *
 * ROADMAP LEG: TRON source chain. Today TRON (USDT-TRC20) is served by the
 * THORChain deposit-address lane + the Rango rail. This module exists so
 * the official tronweb SDK is GRABBED, version-pinned and import-verified
 * for the future in-app TRON leg (balance reads; a deposit/forward tx
 * builder when TRON construction moves in-app).
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no
 * broadcasts — import/verify only.
 *
 * SHAPE VERIFIED at 6.5.0 (probe, 2026-09-06): named export TronWeb (class,
 * options-object constructor `new TronWeb({ fullHost, headers, privateKey })`
 * per lib/esm/types/TronWeb.d.ts). Constructing with a fullHost fires NO
 * network request (verified under a dead-proxy dispatcher).
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — resolves the checked `tronweb` namespace. */
export const loadTronwebSdk = makeSdkLoader("tronweb", {
  exports: ["TronWeb"],
});

/**
 * Create a TronWeb client (official SDK class) for the future leg. Does not
 * connect — construction is offline; the first network call happens on the
 * first RPC use.
 * @param {object} [opts]
 * @param {string} [opts.fullHost] TRON node base URL (e.g. https://api.trongrid.io)
 * @param {Record<string,string>} [opts.headers] extra headers
 * @returns {Promise<import("tronweb").TronWeb>}
 */
export async function createTronClient({ fullHost, headers } = {}) {
  const { TronWeb } = await loadTronwebSdk();
  return new TronWeb({ fullHost, headers });
}

/**
 * Read a TRX (or TRC20 via its own call) balance through a TronWeb client
 * the caller owns. Thin passthrough — the SDK's `trx` API is the
 * implementation.
 * @param {import("tronweb").TronWeb} client a TronWeb client
 * @param {string} address base58 T-… address
 * @returns {Promise<number>} balance in SUN (raw base unit)
 */
export async function getTronBalance(client, address) {
  await loadTronwebSdk(); // pin/verify the SDK is the grabbed one before use
  return client.trx.getBalance(address);
}

/**
 * Validate a TRON address shape through the SDK's own checker.
 * @param {import("tronweb").TronWeb} client a TronWeb client
 * @param {string} address candidate base58 address
 * @returns {Promise<boolean>}
 */
export async function isTronAddress(client, address) {
  await loadTronwebSdk();
  return client.isAddress(address);
}
