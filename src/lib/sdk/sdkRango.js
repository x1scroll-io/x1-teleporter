/**
 * sdkRango.js — READINESS SCAFFOLDING for the official Rango SDK
 * (`rango-sdk`, pinned ^0.5.0 — verified on npm 2026-09-06; the same version
 * the leg-sdk audit cited).
 *
 * ROADMAP LEG: the Rango EXECUTE lane. The audit's verdict
 * (docs/LEG-SDK-AUDIT.md §1/§4.5/§5): the app's Rango keys are SERVER-SIDE
 * by architecture (same deliberate pattern as LiFi/THORChain — the SPA never
 * holds an aggregator key), and rango-sdk requires the apiKey in the client
 * constructor and does not target a same-origin proxy base. **The SDK
 * belongs SERVER-SIDE in the future proxy route** (`api/rango/swap.js`
 * should wrap RangoClient) — the SPA legs (rangoQuoteLeg/rangoExecuteLeg)
 * stay request-pinners. This module exists so rango-sdk is GRABBED,
 * version-pinned and import-verified ahead of that server route; it is safe
 * to import in Node (the serverless functions' runtime) AND in the browser.
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no keys,
 * no broadcasts — import/verify only. Constructing a RangoClient fires no
 * network request (verified: the httpService is lazy).
 *
 * SHAPE VERIFIED at 0.5.0 (probe, 2026-09-06): exports RangoClient
 * (constructor (apiKey, apiUrl?); methods getBestRoute(BestRouteRequest),
 * createTransaction(CreateTransactionRequest), getAllMetadata(…),
 * checkStatus(…) — lib/services/client.d.ts).
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — the checked `rango-sdk` namespace. */
export const loadRangoSdk = makeSdkLoader("rango-sdk", {
  exports: ["RangoClient"],
});

/**
 * Create the official Rango client. ⛔ SERVER-SIDE ONLY when wired: the
 * apiKey must come from the server env (RANGO_API_KEY), never from the SPA
 * (the api/rango/quote.js proxy already enforces that boundary). The future
 * api/rango/swap.js route constructs this with the server key.
 * @param {object} [opts]
 * @param {string} [opts.apiKey] server-side Rango key (omit in tests)
 * @param {string} [opts.apiUrl] default https://api.rango.exchange
 * @returns {Promise<import("rango-sdk").RangoClient>}
 */
export async function createRangoClient({ apiKey = "", apiUrl } = {}) {
  const { RangoClient } = await loadRangoSdk();
  return new RangoClient(apiKey, apiUrl);
}

/**
 * Best-route quote through the official client — the server proxy's quote
 * call once the execute lane lands (maps to the app's canonical
 * quote-request artifact in src/lib/rango/quote.js).
 * @param {import("rango-sdk").RangoClient} client
 * @param {object} requestBody BestRouteRequest
 * @returns {Promise<object>} BestRouteResponse
 */
export async function getRangoBestRoute(client, requestBody) {
  await loadRangoSdk(); // pin/verify the SDK is the grabbed one before use
  return client.getBestRoute(requestBody);
}

/**
 * Transaction-create through the official client — the server proxy's
 * swap-create call once the execute lane lands (currently the SPA's
 * rangoExecuteLeg only pins the request shape and always throws
 * RangoLiveTestGateError).
 * @param {import("rango-sdk").RangoClient} client
 * @param {object} requestBody CreateTransactionRequest
 * @returns {Promise<object>} CreateTransactionResponse
 */
export async function createRangoTransaction(client, requestBody) {
  await loadRangoSdk();
  return client.createTransaction(requestBody);
}
