/**
 * Bitcoin balance tests (Step 2.3) — node:test, fetcher injected.
 *
 * The mempool.space public API needs no key; the module never touches the
 * network in tests (mocked fetcher) and never constructs transactions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMPOOL_SPACE_API,
  balanceFromMempoolAddress,
  createBtcBalanceFetcher,
  formatBtcBalance,
} from "./bitcoinBalance.js";

const PAYMENT_ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

/** Minimal fetch-compatible mock returning a mempool.space-shaped body. */
function mockFetcher(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, init]);
    return { ok, status, json: async () => body };
  };
  fetcher.calls = calls;
  return fetcher;
}

test("balance = chain funded − spent + mempool funded − spent (sats)", () => {
  const data = {
    chain_stats: { funded_txo_sum: 1_000_000, spent_txo_sum: 400_000 },
    mempool_stats: { funded_txo_sum: 50_000, spent_txo_sum: 10_000 },
  };
  assert.equal(balanceFromMempoolAddress(data), 640_000);
});

test("a drained address (fully spent) reports 0, never negative", () => {
  const data = {
    chain_stats: { funded_txo_sum: 100, spent_txo_sum: 150 },
    mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
  };
  assert.equal(balanceFromMempoolAddress(data), 0);
});

test("missing stats objects are tolerated (empty response → 0)", () => {
  assert.equal(balanceFromMempoolAddress({}), 0);
  assert.equal(balanceFromMempoolAddress(null), 0);
});

test("createBtcBalanceFetcher hits the address endpoint and parses sats", async () => {
  const fetcher = mockFetcher({
    chain_stats: { funded_txo_sum: 500_000, spent_txo_sum: 100_000 },
    mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
  });
  const fetchBalance = createBtcBalanceFetcher({ fetcher });
  const sats = await fetchBalance(PAYMENT_ADDRESS);

  assert.equal(sats, 400_000);
  assert.equal(fetcher.calls.length, 1);
  const [url] = fetcher.calls[0];
  assert.equal(url, `${MEMPOOL_SPACE_API}/address/${PAYMENT_ADDRESS}`);
});

test("the address is URL-encoded in the request path", async () => {
  const fetcher = mockFetcher({});
  const fetchBalance = createBtcBalanceFetcher({ fetcher });
  await fetchBalance("bc1q odd?address");
  assert.equal(fetcher.calls[0][0], `${MEMPOOL_SPACE_API}/address/bc1q%20odd%3Faddress`);
});

test("HTTP errors surface with the status code", async () => {
  const fetcher = mockFetcher({}, { ok: false, status: 500 });
  const fetchBalance = createBtcBalanceFetcher({ fetcher });
  await assert.rejects(fetchBalance(PAYMENT_ADDRESS), /responded 500/);
});

test("transport failures surface a descriptive error", async () => {
  const fetcher = async () => {
    throw new Error("network down");
  };
  const fetchBalance = createBtcBalanceFetcher({ fetcher });
  await assert.rejects(fetchBalance(PAYMENT_ADDRESS), /mempool\.space request failed/);
});

test("an empty address is rejected before any request", async () => {
  const fetcher = mockFetcher({});
  const fetchBalance = createBtcBalanceFetcher({ fetcher });
  await assert.rejects(fetchBalance(""), /payment address is required/);
  assert.equal(fetcher.calls.length, 0);
});

test("creating a fetcher without any fetch implementation throws (no silent no-op)", () => {
  // null/undefined fetcher explicitly injected — must throw, never no-op.
  assert.throws(
    () => createBtcBalanceFetcher({ fetcher: null }),
    /no fetch implementation/,
  );
});

test("formatBtcBalance renders sats as trimmed BTC with 8-decimal precision", () => {
  assert.equal(formatBtcBalance(123_456), "0.00123456 BTC");
  assert.equal(formatBtcBalance(100_000_000), "1 BTC");
  assert.equal(formatBtcBalance(50_000_000), "0.5 BTC");
  assert.equal(formatBtcBalance(0), "0 BTC");
  assert.equal(formatBtcBalance(1), "0.00000001 BTC");
  assert.equal(formatBtcBalance(Number.NaN), "—");
  assert.equal(formatBtcBalance(-5), "—");
});
