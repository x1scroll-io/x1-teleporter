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
  loadStonfiSdk,
  loadDedustSdk,
  createStonfiRouterV1,
  getStonfiRouterAddress,
  getDedustFactoryAddress,
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

// ── STON.fi / DeDust native-DEX loaders (2026-09-30 extension) ──────────────

test("sdkTon: official @ston-fi/sdk resolves with the pinned export surface", async () => {
  const ns = await loadStonfiSdk();
  assert.equal(typeof ns.DEX, "object");
  assert.equal(typeof ns.DEX.v1.Router, "function");
  assert.equal(typeof ns.DEX_TYPE, "object");
  assert.equal(typeof ns.DEX_VERSION, "object");
  assert.equal(typeof ns.toUnits, "function");
});

test("sdkTon: official @dedust/sdk resolves with the pinned export surface", async () => {
  const ns = await loadDedustSdk();
  for (const name of ["Factory", "Pool", "Asset", "Vault", "VaultNative", "VaultJetton"]) {
    assert.equal(typeof ns[name], "function", `@dedust/sdk export ${name}`);
  }
  for (const name of ["PoolType", "AssetType"]) {
    assert.equal(typeof ns[name], "object", `@dedust/sdk export ${name}`);
  }
  assert.ok(ns.MAINNET_FACTORY_ADDR, "MAINNET_FACTORY_ADDR present");
});

test("sdkTon: STON.fi router address matches the registry value (drift canary)", async () => {
  const addr = await getStonfiRouterAddress();
  assert.equal(addr, "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt");
});

test("sdkTon: DeDust factory address matches the registry value", async () => {
  const addr = await getDedustFactoryAddress();
  assert.equal(addr, "EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67");
});

test("sdkTon: the STON.fi v1 router builds a swap body offline (op 0x25938561)", async () => {
  const router = await createStonfiRouterV1();
  const body = await router.createSwapBody({
    userWalletAddress: router.address,
    minAskAmount: 1n,
    askJettonWalletAddress: router.address,
  });
  const op = body.beginParse().loadUintBig(32);
  assert.equal(op, 0x25938561n);
});
