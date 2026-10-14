/**
 * nearBalance.test.js — DI-clean tests for the NEAR RPC balance fetcher
 * (fake fetch injected; no network).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createNearBalanceFetcher, NEAR_MAINNET_RPC } from "./nearBalance.js";

function fakeFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, async json() { return payload; } };
  };
  fn.calls = calls;
  return fn;
}

test("reads yoctoNEAR from the RPC view_account result", async () => {
  const fetchImpl = fakeFetch({ jsonrpc: "2.0", result: { amount: "1500000000000000000000000" } });
  const fetchBalance = createNearBalanceFetcher({ fetchImpl, rpcUrl: NEAR_MAINNET_RPC });
  const balance = await fetchBalance("alice.near");
  assert.equal(balance, 1500000000000000000000000n);

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, NEAR_MAINNET_RPC);
  const body = JSON.parse(init.body);
  assert.equal(body.method, "query");
  assert.deepEqual(body.params, { request_type: "view_account", finality: "final", account_id: "alice.near" });
});

test("throws on an RPC error result", async () => {
  const fetchImpl = fakeFetch({ error: { message: "account not found" } });
  const fetchBalance = createNearBalanceFetcher({ fetchImpl });
  await assert.rejects(() => fetchBalance("nope.near"), /RPC error/);
});

test("throws on a non-OK HTTP response and on a missing accountId", async () => {
  const fetchImpl = fakeFetch({}, { ok: false, status: 503 });
  const fetchBalance = createNearBalanceFetcher({ fetchImpl });
  await assert.rejects(() => fetchBalance("alice.near"), /HTTP 503/);
  await assert.rejects(() => fetchBalance(""), /accountId is required/);
});
