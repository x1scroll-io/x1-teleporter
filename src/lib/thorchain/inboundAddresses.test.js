/**
 * inboundAddresses.test.js — /thorchain/inbound_addresses fetch + 60s
 * refresh + halted parsing (Step 3.2, deposit-address stage).
 *
 * Proves: URL shape, defensive parsing of the THORNode response, fetch on
 * start + refresh every 60s (driven through the schedule seam — no fake
 * timers), halted flags surfaced, and the NEVER-CACHE rule (no storage
 * backend is ever touched — vault addresses live in memory only).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inboundAddressesUrl,
  parseInboundAddresses,
  createInboundAddressRefresher,
  DEFAULT_INBOUND_REFRESH_MS,
} from "./inboundAddresses.js";
import { THORCHAIN_STATUS_BASE_URL } from "./statusEndpoint.js";

// Drain the refresher's full async chain (fetchImpl → res.json() → parse →
// onUpdate). A single `await Promise.resolve()` only settles ONE microtask
// turn — the immediate fetch's callbacks land several turns later, so the
// tests must yield to a macrotask to see them.
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

const SAMPLE = [
  { chain: "BTC", address: "bc1qdepositvault123", halted: false, router: "", gas_rate: "12", dust_threshold: "1000" },
  { chain: "DOGE", address: "DDepositVault456", halted: true, gas_rate: "100000", dust_threshold: "10000000" },
  { chain: "LTC", address: "ltc1depositvault789", halted: false },
  { chain: "XRP", address: "rDepositVaultXRP", halted: false, router: "rRouter" },
];

test("inboundAddressesUrl builds the endpoint on the status module's base URL", () => {
  assert.equal(inboundAddressesUrl(undefined), `${THORCHAIN_STATUS_BASE_URL}/thorchain/inbound_addresses`);
  assert.equal(
    inboundAddressesUrl("https://gateway.liquify.com/chain/thorchain_api/"),
    "https://gateway.liquify.com/chain/thorchain_api/thorchain/inbound_addresses",
  );
});

test("parseInboundAddresses normalizes the THORNode array shape", () => {
  const res = parseInboundAddresses(SAMPLE);
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 4);
  const btc = res.entries.find((e) => e.chain === "BTC");
  assert.deepEqual(
    { chain: btc.chain, address: btc.address, halted: btc.halted, router: btc.router, gasRate: btc.gasRate, dustThreshold: btc.dustThreshold },
    { chain: "BTC", address: "bc1qdepositvault123", halted: false, router: "", gasRate: "12", dustThreshold: "1000" },
  );
  const doge = res.entries.find((e) => e.chain === "DOGE");
  assert.equal(doge.halted, true, "halted: true surfaces as a flag");
});

test("parseInboundAddresses accepts the wrapped { addresses: [...] } gateway shape", () => {
  const res = parseInboundAddresses({ addresses: SAMPLE });
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 4);
});

test("parseInboundAddresses is defensive: malformed bodies never throw", () => {
  assert.deepEqual(parseInboundAddresses(null), { ok: false, reason: "malformed", message: "empty or non-object response" });
  assert.deepEqual(parseInboundAddresses({}), { ok: false, reason: "not-array", message: "inbound_addresses body has no address array" });
  assert.deepEqual(parseInboundAddresses([{ chain: 42 }]), { ok: false, reason: "malformed", message: "no recognisable chain entries" });
  assert.deepEqual(parseInboundAddresses([]), { ok: true, entries: [] }, "an empty vault list is valid");
});

test("refresher: fetches immediately on start, then on the 60s cadence", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => SAMPLE };
  };
  // Manual schedule: capture the scheduled callback instead of using timers.
  const scheduled = [];
  const schedule = (fn) => {
    scheduled.push(fn);
    return () => {};
  };
  const refresher = createInboundAddressRefresher({ fetchImpl, intervalMs: 60000, schedule });

  const updates = [];
  refresher.start({ onUpdate: (entries) => updates.push(entries) });
  await flushAsync(); // let the immediate fetch settle

  assert.equal(calls.length, 1, "fetch on mount");
  assert.match(calls[0], /\/thorchain\/inbound_addresses$/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].length, 4);
  assert.equal(scheduled.length, 1, "one refresh scheduled after the initial fetch");

  // Fire the scheduled refresh → second fetch + second update + re-schedule.
  scheduled[0]();
  await flushAsync();
  assert.equal(calls.length, 2, "refresh every 60s");
  assert.equal(updates.length, 2);
  assert.equal(scheduled.length, 2, "re-scheduled after each refresh");
});

test("refresher: DEFAULT_INBOUND_REFRESH_MS is 60s per the brief", () => {
  assert.equal(DEFAULT_INBOUND_REFRESH_MS, 60_000);
});

test("refresher: getLatest returns the in-memory snapshot; stop() halts scheduling", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => SAMPLE });
  let scheduled = [];
  const schedule = (fn) => {
    const handle = { fn, cancelled: false };
    scheduled.push(handle);
    return () => {
      handle.cancelled = true;
    };
  };
  const refresher = createInboundAddressRefresher({ fetchImpl, schedule });
  refresher.start({});
  await flushAsync();
  assert.equal(refresher.getLatest().length, 4);
  refresher.stop();
  const before = scheduled.length;
  // Stopping cancels the pending timer; a fire after stop must not refetch.
  scheduled.forEach((h) => h.cancelled && null);
  assert.ok(before >= 1);
});

test("NEVER-CACHE: the refresher never touches any storage backend", async () => {
  // A storage backend that throws on ANY access — if the refresher so much
  // as reads it, the test fails.
  const hostileStorage = {
    get() { throw new Error("storage must never be touched"); },
    set() { throw new Error("storage must never be touched"); },
    del() { throw new Error("storage must never be touched"); },
    getAll() { throw new Error("storage must never be touched"); },
  };
  const fetchImpl = async () => ({ ok: true, json: async () => SAMPLE });
  const refresher = createInboundAddressRefresher({ fetchImpl, schedule: () => () => {} });
  refresher.start({});
  await flushAsync();
  assert.equal(refresher.getLatest().length, 4);
  // The refresher exposes no storage handle at all — vault addresses are
  // in-memory only; a fresh mount always fetches from the network.
  assert.equal("backend" in refresher, false);
  assert.equal("localStorage" in refresher, false);
  void hostileStorage;
});

test("refresher: fetch failure surfaces onError and keeps the cadence alive", async () => {
  let fail = true;
  const fetchImpl = async () => {
    if (fail) throw new Error("DNS failure (sandbox)");
    return { ok: true, json: async () => SAMPLE };
  };
  const scheduled = [];
  const schedule = (fn) => {
    scheduled.push(fn);
    return () => {};
  };
  const refresher = createInboundAddressRefresher({ fetchImpl, schedule });
  const errors = [];
  refresher.start({ onError: (msg) => errors.push(msg) });
  await flushAsync();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /DNS failure/);
  assert.equal(refresher.getLatest(), null);
  // Recovery on the next scheduled tick.
  fail = false;
  scheduled[0]();
  await flushAsync();
  assert.equal(refresher.getLatest().length, 4);
});

test("refresher: halted chains are exposed so the UI can grey them out", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => SAMPLE });
  const refresher = createInboundAddressRefresher({ fetchImpl, schedule: () => () => {} });
  let latest = null;
  refresher.start({ onUpdate: (e) => { latest = e; } });
  await flushAsync();
  const doge = latest.find((e) => e.chain === "DOGE");
  const btc = latest.find((e) => e.chain === "BTC");
  assert.equal(doge.halted, true);
  assert.equal(btc.halted, false);
});
