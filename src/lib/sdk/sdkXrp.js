/**
 * sdkXrp.js — READINESS SCAFFOLDING for the official XRP SDK (`xrpl`,
 * pinned ^5.1.0 — verified on npm 2026-09-06).
 *
 * ROADMAP LEG: XRPL source chain. Today XRP is a THORChain deposit-address
 * source (the deposit tx is built + broadcast OUT-OF-BAND in the user's
 * external wallet — family "external", docs/LEG-SDK-AUDIT.md §4.3) and a
 * Rango rail source (rango-quote/rango-execute). This module exists so the
 * official xrpl.js SDK is GRABBED, version-pinned and import-verified for
 * the future in-app XRP leg (balance reads, and a deposit/forward tx
 * builder if the deposit-address lane ever moves in-app).
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no
 * broadcasts — import/verify only.
 *
 * SHAPE VERIFIED at 5.1.0 (probe, 2026-09-06): exports Client, Wallet,
 * deriveAddress (137 exports total).
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — resolves the checked `xrpl` namespace. */
export const loadXrplSdk = makeSdkLoader("xrpl", {
  exports: ["Client", "Wallet", "deriveAddress"],
});

/**
 * Derive the classic XRP address for a seed — offline, no network. The
 * future leg uses this to display/validate the source address before any
 * balance read or tx build.
 * @param {string} seed an xrpl family seed (s… / sEd…)
 * @returns {Promise<string>} the classic (r…) address
 */
export async function deriveXrpAddress(seed) {
  const { Wallet } = await loadXrplSdk();
  return Wallet.fromSeed(seed).classicAddress;
}

/**
 * Read an XRP balance through an xrpl `Client` the caller owns (the future
 * leg constructs it against the XRP public/own node). Thin passthrough —
 * the SDK's own method is the implementation.
 * @param {import("xrpl").Client} client a connected xrpl Client
 * @param {string} address classic r… address
 * @returns {Promise<string>} balance in drops (string)
 */
export async function getXrpBalance(client, address) {
  await loadXrplSdk(); // pin/verify the SDK is the grabbed one before use
  return client.getXrpBalance(address);
}
