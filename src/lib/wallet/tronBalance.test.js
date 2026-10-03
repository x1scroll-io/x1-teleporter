/**
 * Tron balance tests (Step 2.4) — node:test, fetcher injected. The public
 * Trongrid endpoint needs no key; the module never touches the network in
 * tests (mocked fetcher) and never constructs transactions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRONGRID_API,
  balanceFromTrongridAccount,
  createTronBalanceFetcher,
  formatTronBalance,
} from "./tronBalance.js";

const TRON_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

/** Minimal fetch-compatible mock returning a canned body. */
function mockFetcher(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, init]);
    return { ok, status, json: async () => body };
  };
  fetcher.calls = calls;
  return fetcher;
}

test("Trongrid: data[0].balance is parsed as SUN", () => {
  assert.equal(balanceFromTrongridAccount({ data: [{ balance: 773_482_579_012 }] }), 773_482_579_012);
  assert.equal(balanceFromTrongridAccount({ data: [{ balance: 0 }] }), 0);
  assert.equal(balanceFromTrongridAccount({ data: [] }), 0, "unknown address → data: [] → 0");
  assert.equal(balanceFromTrongridAccount({}), 0);
  assert.equal(balanceFromTrongridAccount(null), 0);
  assert.equal(balanceFromTrongridAccount({ data: [{ balance: -10 }] }), 0, "never negative");
});

test("fetcher GETs /v1/accounts/{address} and parses SUN", async () => {
  const fetcher = mockFetcher({ data: [{ balance: 1_500_000 }] });
  const fetchBalance = createTronBalanceFetcher({ fetcher });
  const sun = await fetchBalance(TRON_ADDRESS);

  assert.equal(sun, 1_500_000);
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0][0], `${TRONGRID_API}/v1/accounts/${TRON_ADDRESS}`);
});

test("transport + HTTP failures reject with a descriptive error", async () => {
  const boom = async () => {
    throw new Error("network down");
  };
  await assert.rejects(createTronBalanceFetcher({ fetcher: boom })(TRON_ADDRESS), /Trongrid request failed/);

  const bad = mockFetcher({}, { ok: false, status: 429 });
  await assert.rejects(createTronBalanceFetcher({ fetcher: bad })(TRON_ADDRESS), /responded 429/);
});

test("an address is required; no fetch impl is a hard error", async () => {
  await assert.rejects(createTronBalanceFetcher({ fetcher: mockFetcher({}) })(""), /address is required/);
  assert.throws(() => createTronBalanceFetcher({ fetcher: null }), /no fetch implementation/);
});

test("formatTronBalance: 6 decimals max, trimmed, TRX suffix", () => {
  assert.equal(formatTronBalance(1_000_000), "1 TRX");
  assert.equal(formatTronBalance(12_345_678), "12.345678 TRX");
  assert.equal(formatTronBalance(0), "0 TRX");
  assert.equal(formatTronBalance(-1), "—");
});
