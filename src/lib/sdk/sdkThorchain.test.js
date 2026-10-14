/**
 * sdkThorchain.test.js — import smoke test for the grabbed official
 * THORChain SDK family readiness module (src/lib/sdk/sdkThorchain.js —
 * @xchainjs/xchain-thorchain + @xchainjs/xchain-client). Offline: both
 * packages resolve with the pinned export surface and the class accessors
 * return the real classes. (Instantiating an xchain Client needs a phrase +
 * network — the future leg's job, per the audit's memo verdict.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadThorchainSdk,
  loadXchainClientSdk,
  thorchainClientClass,
  xchainBaseClientClass,
} from "./sdkThorchain.js";

test("sdkThorchain: @xchainjs/xchain-thorchain resolves (Client present)", async () => {
  const ns = await loadThorchainSdk();
  assert.equal(typeof ns.Client, "function", "xchain-thorchain Client class");
});

test("sdkThorchain: @xchainjs/xchain-client resolves (BaseXChainClient present)", async () => {
  const ns = await loadXchainClientSdk();
  assert.equal(typeof ns.BaseXChainClient, "function", "xchain-client BaseXChainClient");
});

test("sdkThorchain: class accessors return the real pinned classes", async () => {
  const Client = await thorchainClientClass();
  const Base = await xchainBaseClientClass();
  assert.equal(typeof Client, "function");
  assert.equal(typeof Base, "function");
  // The audit's memo verdict: the SDK takes memos as CALLER-SUPPLIED strings —
  // the app's memo module (src/lib/thorchain/memo.js) stays the builder. The
  // family is grabbed for the future in-app cosmos/thorchain leg.
  const memo = "=:SOL.SOL:destination"; // shape only — never sent here
  assert.equal(typeof memo, "string");
});
