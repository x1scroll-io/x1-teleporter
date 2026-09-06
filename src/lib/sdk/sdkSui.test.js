/**
 * sdkSui.test.js — import smoke test for the grabbed official Sui SDK
 * readiness module (src/lib/sdk/sdkSui.js). Offline: the subpath imports
 * resolve (no root export in @mysten/sui — verified), the pinned exports
 * exist, and a client constructs without network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSuiClient,
  getSuiBalance,
  isValidSuiAddress,
  loadSuiClientSdk,
  loadSuiUtilsSdk,
} from "./sdkSui.js";

const SUI_ADDR = "0x" + "0".repeat(64);

test("sdkSui: @mysten/sui subpaths resolve with the pinned export surface", async () => {
  const clientNs = await loadSuiClientSdk();
  assert.equal(typeof clientNs.SuiGrpcClient, "function", "@mysten/sui/grpc SuiGrpcClient");
  const utilsNs = await loadSuiUtilsSdk();
  assert.equal(typeof utilsNs.isValidSuiAddress, "function", "@mysten/sui/utils isValidSuiAddress");
});

test("sdkSui: wrapper functions exist (future-leg surface)", () => {
  assert.equal(typeof createSuiClient, "function");
  assert.equal(typeof getSuiBalance, "function");
  assert.equal(typeof isValidSuiAddress, "function");
});

test("sdkSui: createSuiClient constructs offline + getBalance is on the client", async () => {
  const client = await createSuiClient({ network: "mainnet" });
  assert.equal(typeof client.getBalance, "function");
  assert.equal(client.network, "mainnet");
});

test("sdkSui: isValidSuiAddress runs the real SDK utils offline", async () => {
  assert.equal(await isValidSuiAddress(SUI_ADDR), true);
  assert.equal(await isValidSuiAddress("not-an-address"), false);
});
