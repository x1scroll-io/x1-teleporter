/**
 * sdkTron.test.js — import smoke test for the grabbed official TRON SDK
 * readiness module (src/lib/sdk/sdkTron.js). Offline: the SDK resolves, the
 * pinned export exists, and a TronWeb client constructs WITHOUT firing a
 * network request (the repo's CI has no network guarantees).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTronClient, getTronBalance, isTronAddress, loadTronwebSdk } from "./sdkTron.js";

test("sdkTron: official tronweb SDK resolves with the pinned export surface", async () => {
  const ns = await loadTronwebSdk();
  assert.equal(typeof ns.TronWeb, "function", "tronweb TronWeb class");
});

test("sdkTron: wrapper functions exist (future-leg surface)", () => {
  assert.equal(typeof createTronClient, "function");
  assert.equal(typeof getTronBalance, "function");
  assert.equal(typeof isTronAddress, "function");
});

test("sdkTron: createTronClient constructs offline (no network fired)", async () => {
  const client = await createTronClient({ fullHost: "https://api.trongrid.io" });
  assert.equal(typeof client.trx.getBalance, "function");
  assert.equal(typeof client.isAddress, "function");
  assert.equal(client.fullNode?.host, "https://api.trongrid.io");
});
