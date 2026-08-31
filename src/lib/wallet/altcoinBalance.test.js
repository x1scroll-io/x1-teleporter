/**
 * Litecoin + Dogecoin balance tests (Step 2.4) — node:test, fetcher
 * injected. The LitecoinSpace (LTC) and BlockCypher (DOGE) public APIs
 * need no key; the modules never touch the network in tests (mocked
 * fetcher) and never construct transactions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKCYPHER_DOGE_API,
  LITECOIN_SPACE_API,
  balanceFromBlockcypher,
  createDogeBalanceFetcher,
  createLtcBalanceFetcher,
  formatDogeBalance,
  formatLtcBalance,
} from "./altcoinBalance.js";

const LTC_ADDRESS = "LbTjMGN7gELw4KbeyQf6cTCq859hD18guE";
const DOGE_ADDRESS = "DQyfNhuqN9mseL9YmgW8Sh7GNDjUn6oC1R";

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

/* ————————————— Litecoin (LitecoinSpace, mempool-style JSON) ————————————— */

test("LTC: reuses the mempool.space parser (chain_stats/mempool_stats, satoshis)", async () => {
  const fetcher = mockFetcher({
    address: LTC_ADDRESS,
    chain_stats: { funded_txo_sum: 13_125_755_998_597, spent_txo_sum: 13_125_673_567_647 },
    mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
  });
  const fetchBalance = createLtcBalanceFetcher({ fetcher });
  const sats = await fetchBalance(LTC_ADDRESS);

  assert.equal(sats, 82_430_950, "chain funded − chain spent (the real LitecoinSpace number for this address)");
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0][0], `${LITECOIN_SPACE_API}/address/${LTC_ADDRESS}`);
});

test("LTC: pending mempool deltas are included", async () => {
  const fetcher = mockFetcher({
    chain_stats: { funded_txo_sum: 1_000, spent_txo_sum: 0 },
    mempool_stats: { funded_txo_sum: 500, spent_txo_sum: 100 },
  });
  const fetchBalance = createLtcBalanceFetcher({ fetcher });
  assert.equal(await fetchBalance(LTC_ADDRESS), 1_400);
});

test("LTC: transport + HTTP failures reject with a descriptive error", async () => {
  const boom = async () => {
    throw new Error("network down");
  };
  const fetchBalance = createLtcBalanceFetcher({ fetcher: boom });
  await assert.rejects(fetchBalance(LTC_ADDRESS), /LitecoinSpace request failed/);

  const bad = mockFetcher({}, { ok: false, status: 503 });
  const fetchBalance2 = createLtcBalanceFetcher({ fetcher: bad });
  await assert.rejects(fetchBalance2(LTC_ADDRESS), /responded 503/);
});

test("LTC: an address is required; no fetch impl is a hard error", async () => {
  const fetchBalance = createLtcBalanceFetcher({ fetcher: mockFetcher({}) });
  await assert.rejects(fetchBalance(""), /address is required/);
  assert.throws(() => createLtcBalanceFetcher({ fetcher: null }), /no fetch implementation/);
});

/* ————————————— Dogecoin (BlockCypher, final_balance satoshis) ————————————— */

test("DOGE: balance = final_balance (confirmed + pending), never negative", () => {
  assert.equal(
    balanceFromBlockcypher({ balance: 32_024_793_035_768, unconfirmed_balance: 0, final_balance: 32_024_793_035_768 }),
    32_024_793_035_768,
  );
  assert.equal(balanceFromBlockcypher({ balance: 100, unconfirmed_balance: 50, final_balance: 150 }), 150);
  assert.equal(balanceFromBlockcypher({ balance: 10, unconfirmed_balance: -30, final_balance: -20 }), 0);
  assert.equal(balanceFromBlockcypher({}), 0);
  assert.equal(balanceFromBlockcypher(null), 0);
});

test("DOGE: fetcher hits the /addrs/{addr}/balance endpoint and parses sats", async () => {
  const fetcher = mockFetcher({ address: DOGE_ADDRESS, balance: 1_000, unconfirmed_balance: 200, final_balance: 1_200 });
  const fetchBalance = createDogeBalanceFetcher({ fetcher });
  const sats = await fetchBalance(DOGE_ADDRESS);

  assert.equal(sats, 1_200);
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0][0], `${BLOCKCYPHER_DOGE_API}/addrs/${DOGE_ADDRESS}/balance`);
});

test("DOGE: transport + HTTP failures reject with a descriptive error", async () => {
  const boom = async () => {
    throw new Error("network down");
  };
  await assert.rejects(createDogeBalanceFetcher({ fetcher: boom })(DOGE_ADDRESS), /BlockCypher request failed/);

  const bad = mockFetcher({}, { ok: false, status: 429 });
  await assert.rejects(createDogeBalanceFetcher({ fetcher: bad })(DOGE_ADDRESS), /responded 429/);
});

test("DOGE: an address is required", async () => {
  await assert.rejects(createDogeBalanceFetcher({ fetcher: mockFetcher({}) })(""), /address is required/);
});

/* ————————————— Formatting ————————————— */

test("formatLtcBalance: 8 decimals max, trimmed, LTC suffix", () => {
  assert.equal(formatLtcBalance(82_430_950), "0.8243095 LTC");
  assert.equal(formatLtcBalance(100_000_000), "1 LTC");
  assert.equal(formatLtcBalance(50_000_000), "0.5 LTC");
  assert.equal(formatLtcBalance(0), "0 LTC");
  assert.equal(formatLtcBalance(-1), "—");
  assert.equal(formatLtcBalance(Number.NaN), "—");
});

test("formatDogeBalance: 8 decimals max, trimmed, DOGE suffix", () => {
  assert.equal(formatDogeBalance(1_234_567_890), "12.3456789 DOGE");
  assert.equal(formatDogeBalance(320_247_930_357_68), "320247.93035768 DOGE");
  assert.equal(formatDogeBalance(0), "0 DOGE");
  assert.equal(formatDogeBalance(-5), "—");
});
