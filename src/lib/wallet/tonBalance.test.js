/**
 * tonBalance.test.js — DI-clean tests for the toncenter balance fetcher
 * (fake fetch injected; no network).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTonBalanceFetcher, TONCENTER_MAINNET } from "./tonBalance.js";

function fakeFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, async json() { return payload; } };
  };
  fn.calls = calls;
  return fn;
}

test("reads nanoTON from the toncenter getAddressBalance result", async () => {
  const fetchImpl = fakeFetch({ ok: true, result: "2500000000" });
  const fetchBalance = createTonBalanceFetcher({ fetchImpl, endpoint: TONCENTER_MAINNET });
  const balance = await fetchBalance("EQFakeAddress");
  assert.equal(balance, 2500000000n);

  const { url } = fetchImpl.calls[0];
  assert.ok(url.startsWith(`${TONCENTER_MAINNET}/getAddressBalance?address=`), "hits getAddressBalance");
  assert.ok(url.includes(encodeURIComponent("EQFakeAddress")));
});

test("sends the API key header when configured", async () => {
  const fetchImpl = fakeFetch({ ok: true, result: "1" });
  const fetchBalance = createTonBalanceFetcher({ fetchImpl, apiKey: "secret" });
  await fetchBalance("EQFakeAddress");
  assert.equal(fetchImpl.calls[0].init.headers["X-API-Key"], "secret");
});

test("throws on API error / non-OK HTTP / missing address", async () => {
  const apiErr = createTonBalanceFetcher({ fetchImpl: fakeFetch({ ok: false, error: "bad" }) });
  await assert.rejects(() => apiErr("EQFakeAddress"), /API error/);

  const httpErr = createTonBalanceFetcher({ fetchImpl: fakeFetch({}, { ok: false, status: 500 }) });
  await assert.rejects(() => httpErr("EQFakeAddress"), /HTTP 500/);

  const missing = createTonBalanceFetcher({ fetchImpl: fakeFetch({ ok: true, result: "1" }) });
  await assert.rejects(() => missing(""), /address is required/);
});
