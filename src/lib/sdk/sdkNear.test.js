/**
 * sdkNear.test.js — import smoke test for the grabbed official Ref Finance
 * SDK readiness module (src/lib/sdk/sdkNear.js). Offline: the SDK resolves
 * with the pinned export surface and the module's constants agree with the
 * SDK's own (a drift canary).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadRefSdk,
  REF_FINANCE_CONTRACT_ID,
  WRAP_NEAR_CONTRACT_ID,
  estimateRefSwap,
  getRefPoolsByIds,
  buildRefSwapTransactions,
  transformRefTransactions,
  nearWrapTransaction,
} from "./sdkNear.js";

test("sdkNear: official @ref-finance/ref-sdk resolves with the pinned export surface", async () => {
  const ns = await loadRefSdk();
  for (const name of ["estimateSwap", "getPoolByIds", "getPool", "instantSwap", "parsePool", "transformTransactions", "nearDepositTransaction"]) {
    assert.equal(typeof ns[name], "function", `@ref-finance/ref-sdk export ${name}`);
  }
});

test("sdkNear: constants match the SDK's own (registry drift canary)", async () => {
  const ns = await loadRefSdk();
  assert.equal(REF_FINANCE_CONTRACT_ID, ns.REF_FI_CONTRACT_ID);
  assert.equal(WRAP_NEAR_CONTRACT_ID, ns.WRAP_NEAR_CONTRACT_ID);
  assert.equal(REF_FINANCE_CONTRACT_ID, "v2.ref-finance.near");
  assert.equal(WRAP_NEAR_CONTRACT_ID, "wrap.near");
});

test("sdkNear: wrapper functions exist (nearSwapLeg surface)", () => {
  assert.equal(typeof estimateRefSwap, "function");
  assert.equal(typeof getRefPoolsByIds, "function");
  assert.equal(typeof buildRefSwapTransactions, "function");
  assert.equal(typeof transformRefTransactions, "function");
  assert.equal(typeof nearWrapTransaction, "function");
});

test("sdkNear: estimateSwap throws honestly for an empty pool set (offline)", async () => {
  const tokenIn = { id: "wrap.near", symbol: "wNEAR", name: "Wrapped NEAR", decimals: 24, icon: "" };
  const tokenOut = { id: "usdt.tether-token.near", symbol: "USDT", name: "Tether", decimals: 6, icon: "" };
  await assert.rejects(
    () => estimateRefSwap({ tokenIn, tokenOut, amountIn: "1000000000000000000000000", simplePools: [] }),
    /pool/i,
  );
});

test("sdkNear: nearDepositTransaction builds a wrap.near Transaction offline", async () => {
  const tx = await nearWrapTransaction("1000000000000000000000000");
  assert.equal(tx.receiverId, "wrap.near");
  assert.ok(Array.isArray(tx.functionCalls) && tx.functionCalls.length >= 1);
  assert.equal(tx.functionCalls[0].methodName, "near_deposit");
});
