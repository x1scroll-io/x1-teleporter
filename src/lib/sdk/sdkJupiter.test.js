/**
 * sdkJupiter.test.js — import smoke test for the grabbed official Jupiter
 * SDK readiness module (src/lib/sdk/sdkJupiter.js). Offline: the SDK
 * resolves with the pinned export surface and a client constructs without
 * firing any network request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJupiterClient,
  getJupiterQuote,
  getJupiterSwapInstructions,
  loadJupiterSdk,
} from "./sdkJupiter.js";

test("sdkJupiter: official @jup-ag/api resolves with the pinned export surface", async () => {
  const ns = await loadJupiterSdk();
  assert.equal(typeof ns.createJupiterApiClient, "function", "@jup-ag/api createJupiterApiClient");
});

test("sdkJupiter: wrapper functions exist (future live-lane surface)", () => {
  assert.equal(typeof createJupiterClient, "function");
  assert.equal(typeof getJupiterQuote, "function");
  assert.equal(typeof getJupiterSwapInstructions, "function");
});

test("sdkJupiter: client constructs offline with the quote/swap surface", async () => {
  const client = await createJupiterClient();
  assert.equal(typeof client.quoteGet, "function");
  assert.equal(typeof client.swapInstructionsPost, "function");
  assert.equal(typeof client.swapPost, "function");
});
