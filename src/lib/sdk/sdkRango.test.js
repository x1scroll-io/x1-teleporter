/**
 * sdkRango.test.js — import smoke test for the grabbed official Rango SDK
 * readiness module (src/lib/sdk/sdkRango.js). Offline: the SDK resolves with
 * the pinned export surface and a client constructs without firing any
 * network request (no key, no funds — the apiKey is SERVER-side when the
 * future proxy route wires this).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRangoClient,
  createRangoTransaction,
  getRangoBestRoute,
  loadRangoSdk,
} from "./sdkRango.js";

test("sdkRango: official rango-sdk resolves with the pinned export surface", async () => {
  const ns = await loadRangoSdk();
  assert.equal(typeof ns.RangoClient, "function", "rango-sdk RangoClient");
});

test("sdkRango: wrapper functions exist (future server-proxy surface)", () => {
  assert.equal(typeof createRangoClient, "function");
  assert.equal(typeof getRangoBestRoute, "function");
  assert.equal(typeof createRangoTransaction, "function");
});

test("sdkRango: client constructs offline (no network fired, no key needed)", async () => {
  const client = await createRangoClient({ apiKey: "", apiUrl: "https://public-api.rango.exchange" });
  assert.equal(typeof client.getBestRoute, "function");
  assert.equal(typeof client.createTransaction, "function");
  assert.equal(typeof client.getAllMetadata, "function");
});
