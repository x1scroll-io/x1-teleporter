/**
 * XRP balance tests (Step 2.4) — node:test, fetcher injected. The public
 * XRPL node needs no key; the module never touches the network in tests
 * (mocked fetcher) and never constructs transactions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  XRPL_PUBLIC_NODE,
  balanceFromAccountInfo,
  createXrpBalanceFetcher,
  formatXrpBalance,
} from "./xrpBalance.js";

const XRP_ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

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

test("account_info: Balance is parsed as drops (string or number)", () => {
  assert.equal(
    balanceFromAccountInfo({ result: { account_data: { Balance: "56774133566" } } }),
    56_774_133_566,
    "the real genesis-account balance in drops",
  );
  assert.equal(balanceFromAccountInfo({ result: { account_data: { Balance: 123 } } }), 123);
  assert.equal(balanceFromAccountInfo({ result: { account_data: {} } }), 0);
  assert.equal(balanceFromAccountInfo({}), 0);
  assert.equal(balanceFromAccountInfo(null), 0);
  assert.equal(balanceFromAccountInfo({ result: { account_data: { Balance: "-5" } } }), 0, "never negative");
});

test("fetcher POSTs account_info to the public node and parses drops", async () => {
  const fetcher = mockFetcher({ result: { account_data: { Balance: "1000000" } } });
  const fetchBalance = createXrpBalanceFetcher({ fetcher });
  const drops = await fetchBalance(XRP_ADDRESS);

  assert.equal(drops, 1_000_000);
  assert.equal(fetcher.calls.length, 1);
  const [url, init] = fetcher.calls[0];
  assert.equal(url, XRPL_PUBLIC_NODE);
  assert.equal(init.method, "POST");
  const body = JSON.parse(init.body);
  assert.equal(body.method, "account_info");
  assert.deepEqual(body.params[0], { account: XRP_ADDRESS, ledger_index: "current", strict: true });
});

test("transport + HTTP failures reject with a descriptive error", async () => {
  const boom = async () => {
    throw new Error("network down");
  };
  await assert.rejects(createXrpBalanceFetcher({ fetcher: boom })(XRP_ADDRESS), /XRPL node request failed/);

  const bad = mockFetcher({}, { ok: false, status: 500 });
  await assert.rejects(createXrpBalanceFetcher({ fetcher: bad })(XRP_ADDRESS), /responded 500/);
});

test("an address is required; no fetch impl is a hard error", async () => {
  await assert.rejects(createXrpBalanceFetcher({ fetcher: mockFetcher({}) })(""), /address is required/);
  assert.throws(() => createXrpBalanceFetcher({ fetcher: null }), /no fetch implementation/);
});

test("formatXrpBalance: 6 decimals max, trimmed, XRP suffix", () => {
  assert.equal(formatXrpBalance(1_000_000), "1 XRP");
  assert.equal(formatXrpBalance(12_345_678), "12.345678 XRP");
  assert.equal(formatXrpBalance(0), "0 XRP");
  assert.equal(formatXrpBalance(-1), "—");
});
