/**
 * sdkTon.test.js — import smoke test for the grabbed official TON SDK
 * readiness module (src/lib/sdk/sdkTon.js). Offline: the SDK resolves with
 * the pinned export surface, and a v4 wallet builds + parses roundtrip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTonV4Wallet,
  getTonBalance,
  loadTonSdk,
  parseTonAddress,
} from "./sdkTon.js";

test("sdkTon: official @ton/ton resolves with the pinned export surface", async () => {
  const ns = await loadTonSdk();
  assert.equal(typeof ns.Address, "function");
  assert.equal(typeof ns.TonClient, "function");
  assert.equal(typeof ns.WalletContractV4, "function");
});

test("sdkTon: wrapper functions exist (future-leg surface)", () => {
  assert.equal(typeof createTonV4Wallet, "function");
  assert.equal(typeof getTonBalance, "function");
  assert.equal(typeof parseTonAddress, "function");
});

test("sdkTon: v4 wallet builds offline and the address parses roundtrip", async () => {
  const wallet = await createTonV4Wallet(new Uint8Array(32).fill(7));
  const friendly = wallet.address.toString();
  const reparsed = await parseTonAddress(friendly);
  assert.equal(reparsed.equals(wallet.address), true);
});

test("sdkTon: parseTonAddress rejects garbage offline", async () => {
  await assert.rejects(() => parseTonAddress("not-a-ton-address"), /(Invalid|failed|address)/i);
});
