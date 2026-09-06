/**
 * sdkCardano.test.js — import smoke test for the grabbed official Cardano
 * CSL SDK readiness module (src/lib/sdk/sdkCardano.js). Offline: the wasm
 * package resolves and EXECUTES (a real key → base-address derivation +
 * bech32 roundtrip — no network, no funds).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardanoAddressFromBech32,
  deriveCardanoAddress,
  loadCardanoSdk,
} from "./sdkCardano.js";

test("sdkCardano: official CSL resolves with the pinned export surface", async () => {
  const ns = await loadCardanoSdk();
  for (const name of ["Address", "BaseAddress", "Credential", "PrivateKey", "Ed25519KeyHash"]) {
    assert.equal(typeof ns[name], "function", `CSL ${name}`);
  }
});

test("sdkCardano: wrapper functions exist (future-leg surface)", () => {
  assert.equal(typeof cardanoAddressFromBech32, "function");
  assert.equal(typeof deriveCardanoAddress, "function");
});

test("sdkCardano: wasm executes — deterministic address derivation + roundtrip", async () => {
  const addr = await deriveCardanoAddress(new Uint8Array(32).fill(7));
  assert.match(addr, /^addr1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,}/);
  // And it roundtrips through the official parser (proves wasm is alive).
  const parsed = await cardanoAddressFromBech32(addr);
  assert.equal(typeof parsed.to_bech32, "function");
  assert.equal(parsed.to_bech32(), addr);
});
