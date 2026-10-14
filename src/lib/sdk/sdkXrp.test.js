/**
 * sdkXrp.test.js — import smoke test for the grabbed official XRP SDK
 * readiness module (src/lib/sdk/sdkXrp.js). Offline: the SDK resolves, the
 * pinned exports exist, and a real derivation executes (no network, no
 * funds).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveXrpAddress, getXrpBalance, loadXrplSdk } from "./sdkXrp.js";

test("sdkXrp: official xrpl SDK resolves with the pinned export surface", async () => {
  const ns = await loadXrplSdk();
  assert.equal(typeof ns.Client, "function", "xrpl Client class");
  assert.equal(typeof ns.Wallet, "function", "xrpl Wallet class");
  assert.equal(typeof ns.deriveAddress, "function", "xrpl deriveAddress");
});

test("sdkXrp: wrapper functions exist (future-leg surface)", () => {
  assert.equal(typeof deriveXrpAddress, "function");
  assert.equal(typeof getXrpBalance, "function");
});

test("sdkXrp: deriveXrpAddress runs the real SDK offline (classic r… address)", async () => {
  // Generate a throwaway keypair through the SDK itself — offline, no funds.
  const { Wallet } = await loadXrplSdk();
  const w = Wallet.generate();
  const derived = await deriveXrpAddress(w.seed);
  assert.equal(derived, w.classicAddress);
  assert.match(derived, /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
});
