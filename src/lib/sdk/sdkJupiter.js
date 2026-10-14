/**
 * sdkJupiter.js — READINESS SCAFFOLDING for the official Jupiter SDK
 * (`@jup-ag/api`, pinned ^6.0.48 — the current package; @jupiter/api does
 * NOT exist on npm, verified 2026-09-06).
 *
 * ROADMAP LEG: the Jupiter LIVE lane. The leg-sdk audit's verdict
 * (docs/LEG-SDK-AUDIT.md §1, dex/jupiterSwapLeg): Jupiter's server
 * constructs the swap instructions; the app's jupiterSwapLeg pins the
 * canonical quote/swap-instructions requests (identical to what the official
 * SDK sends) — and "when a live lane lands and assembles the response into
 * a tx, it must use `@jup-ag/api` (official) + `@solana/web3.js`". This
 * module exists so @jup-ag/api is GRABBED, version-pinned and
 * import-verified ahead of that lane.
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no
 * broadcasts — import/verify only. Constructing the client fires no network
 * request.
 *
 * SHAPE VERIFIED at 6.0.48 (probe, 2026-09-06): exports
 * createJupiterApiClient(config?) → SwapApi with quoteGet(QuoteGetRequest)
 * and swapInstructionsPost(SwapInstructionsPostRequest) (+ 90 exports total,
 * openapi-generated surface).
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — the checked `@jup-ag/api` namespace. */
export const loadJupiterSdk = makeSdkLoader("@jup-ag/api", {
  exports: ["createJupiterApiClient"],
});

/**
 * Create the official Jupiter API client. The future live lane calls this
 * against the canonical quote/swap endpoints the jupiterSwapLeg already
 * pins (request shapes stay identical — the leg header documents the swap
 * to the SDK is a wiring-time step).
 * @param {object} [config] ConfigurationParameters (basePath, apiKey…)
 * @returns {Promise<import("@jup-ag/api").SwapApi>}
 */
export async function createJupiterClient(config) {
  const { createJupiterApiClient } = await loadJupiterSdk();
  return createJupiterApiClient(config);
}

/**
 * Quote through the official client (GET /quote equivalent).
 * @param {import("@jup-ag/api").SwapApi} client
 * @param {object} params QuoteGetRequest
 * @returns {Promise<object>} QuoteResponse
 */
export async function getJupiterQuote(client, params) {
  await loadJupiterSdk(); // pin/verify the SDK is the grabbed one before use
  return client.quoteGet(params);
}

/**
 * Swap instructions through the official client (POST /swap-instructions).
 * The future live lane takes the response's instruction set and assembles
 * the tx with @solana/web3.js + the app's sim gate (simulateTx.js) — never
 * blind-broadcast.
 * @param {import("@jup-ag/api").SwapApi} client
 * @param {object} params SwapInstructionsPostRequest
 * @returns {Promise<object>} SwapInstructionsResponse
 */
export async function getJupiterSwapInstructions(client, params) {
  await loadJupiterSdk();
  return client.swapInstructionsPost(params);
}
