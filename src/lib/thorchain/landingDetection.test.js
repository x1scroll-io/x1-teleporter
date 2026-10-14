/**
 * landingDetection.test.js — SOL landing detection (Step 3.1).
 *
 * The core predicate (hasSolLanded) is pure and tested directly; the watcher
 * is DI (getBalance mock + manual scheduler + fake clock) so the arrival
 * window and the landing threshold are asserted without real waiting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasSolLanded,
  createSolLandingWatcher,
  DEFAULT_LANDING_INTERVAL_MS,
  DEFAULT_LANDING_MAX_MS,
} from "./landingDetection.js";

function manualScheduler() {
  const scheduled = [];
  return {
    schedule(fn, ms) {
      scheduled.push({ fn, ms });
      return () => {};
    },
    fireNext() {
      const item = scheduled.shift();
      assert.ok(item, "expected a scheduled callback");
      item.fn();
      return item.ms;
    },
    count() { return scheduled.length; },
  };
}

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const settle = () => new Promise((r) => setImmediate(r));

/* ————— the pure predicate ————— */

test("hasSolLanded: delta ≥ expected − tolerance → landed", () => {
  // Float-safe values: 1.25 − 1.0 = 0.25 exactly in binary64.
  assert.equal(hasSolLanded({ balanceBefore: 1.0, balanceNow: 1.25, expectedAmountOut: 0.25, tolerance: 0.01 }), true);
  // Exactly at the threshold (expected − tolerance) → landed (>=).
  assert.equal(hasSolLanded({ balanceBefore: 1.0, balanceNow: 1.24, expectedAmountOut: 0.25, tolerance: 0.01 }), true);
});

test("hasSolLanded: delta below the threshold → not landed", () => {
  assert.equal(hasSolLanded({ balanceBefore: 1.0, balanceNow: 1.23, expectedAmountOut: 0.25, tolerance: 0.01 }), false);
  assert.equal(hasSolLanded({ balanceBefore: 1.0, balanceNow: 1.0, expectedAmountOut: 0.25 }), false, "no movement");
});

test("hasSolLanded: default tolerance is 0.5% of expected (floored at 1e-6)", () => {
  // 0.25 SOL expected → default tolerance 0.00125; 1.249 arrival is within it.
  assert.equal(hasSolLanded({ balanceBefore: 1.0, balanceNow: 1.249, expectedAmountOut: 0.25 }), true);
  // A hair under the tolerance → not landed.
  assert.equal(hasSolLanded({ balanceBefore: 1.0, balanceNow: 1.248, expectedAmountOut: 0.25 }), false);
});

test("hasSolLanded: invalid expected amounts never land", () => {
  assert.equal(hasSolLanded({ balanceBefore: 0, balanceNow: 100, expectedAmountOut: 0 }), false);
  assert.equal(hasSolLanded({ balanceBefore: 0, balanceNow: 100, expectedAmountOut: NaN }), false);
  assert.equal(hasSolLanded({ balanceBefore: 0, balanceNow: 100, expectedAmountOut: -5 }), false);
});

test("hasSolLanded: unreadable balances are treated as zero (fail safe, never land)", () => {
  assert.equal(hasSolLanded({ balanceBefore: NaN, balanceNow: 5, expectedAmountOut: 1 }), true, "before unknown → 0 baseline");
  assert.equal(hasSolLanded({ balanceBefore: 0, balanceNow: NaN, expectedAmountOut: 1 }), false, "now unknown → 0");
});

/* ————— the watcher ————— */

function makeWatcher({ balances, intervalMs, maxMs, tolerance } = {}) {
  const sched = manualScheduler();
  const clk = fakeClock(1_000_000);
  const reads = [];
  let idx = 0;
  const getBalance = async () => {
    const b = balances[idx];
    idx += 1; // consume the scripted value even when it throws (the error is one check)
    if (b instanceof Error) throw b;
    reads.push(b);
    // Repeat the last scripted balance once scripted values run out.
    return b ?? balances[balances.length - 1] ?? 0;
  };
  const watcher = createSolLandingWatcher({
    getBalance,
    intervalMs: intervalMs ?? DEFAULT_LANDING_INTERVAL_MS,
    maxMs: maxMs ?? DEFAULT_LANDING_MAX_MS,
    tolerance,
    schedule: sched.schedule,
    now: clk.now,
  });
  return { watcher, sched, clk, reads };
}

test("watcher: lands when the balance delta clears expected − tolerance", async () => {
  const { watcher, sched, clk } = makeWatcher({ balances: [1.0, 1.0, 1.05] });
  let landedAt = null;
  watcher.start({
    balanceBefore: 1.0,
    expectedAmountOut: 0.05,
    onLanded: (b) => { landedAt = b; },
  });
  await settle();
  assert.equal(landedAt, null, "first check (1.0) is below the threshold");

  clk.advance(DEFAULT_LANDING_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.equal(landedAt, null, "second check (1.0) still below");

  clk.advance(DEFAULT_LANDING_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.equal(landedAt, 1.05, "landing detected on the third check");
  assert.equal(watcher.isRunning(), false, "watcher stops after landing");
  assert.equal(sched.count(), 0);
});

test("watcher: uses the balanceBefore captured at start() as the delta baseline", async () => {
  const { watcher, sched, clk } = makeWatcher({ balances: [0.5, 0.55] });
  let landedAt = null;
  watcher.start({
    balanceBefore: 0.5,
    expectedAmountOut: 0.05,
    onLanded: (b) => { landedAt = b; },
  });
  await settle();
  assert.equal(landedAt, null, "0.5 → delta 0 < threshold");

  clk.advance(DEFAULT_LANDING_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.equal(landedAt, 0.55, "0.5 → 0.55 = 0.05 delta ≥ threshold");
});

test("watcher: times out if the SOL never lands within the arrival window", async () => {
  const { watcher, sched, clk } = makeWatcher({ balances: [1.0] });
  let timedOut = 0;
  watcher.start({ balanceBefore: 1.0, expectedAmountOut: 0.05, onTimeout: () => { timedOut += 1; } });
  await settle();
  assert.equal(timedOut, 0);

  clk.advance(DEFAULT_LANDING_MAX_MS + 1);
  sched.fireNext();
  await settle();
  assert.equal(timedOut, 1);
  assert.equal(watcher.isRunning(), false);
});

test("watcher: balance errors surface via onError and keep checking", async () => {
  const { watcher, sched, clk } = makeWatcher({ balances: [new Error("rpc down"), 1.05] });
  const errors = [];
  let landedAt = null;
  watcher.start({
    balanceBefore: 1.0,
    expectedAmountOut: 0.05,
    onError: (m) => errors.push(m),
    onLanded: (b) => { landedAt = b; },
  });
  await settle();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rpc down/);
  assert.equal(watcher.isRunning(), true);

  clk.advance(DEFAULT_LANDING_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.equal(landedAt, 1.05, "recovers and lands once the RPC is back");
});

test("watcher: start() requires a getBalance implementation", () => {
  const watcher = createSolLandingWatcher({});
  assert.throws(() => watcher.start({ balanceBefore: 0, expectedAmountOut: 1 }), /getBalance is required/);
});

test("watcher: checkNow() forces an immediate balance check", async () => {
  const { watcher, sched } = makeWatcher({ balances: [1.0, 1.05] });
  let landedAt = null;
  watcher.start({ balanceBefore: 1.0, expectedAmountOut: 0.05, onLanded: (b) => { landedAt = b; } });
  await settle();
  assert.equal(landedAt, null);

  await watcher.checkNow();
  assert.equal(landedAt, 1.05, "checkNow polls immediately");
  assert.equal(watcher.isRunning(), false);
});

test("watcher: stop() halts further checks", async () => {
  const { watcher, sched, clk } = makeWatcher({ balances: [1.0] });
  let landedAt = null;
  watcher.start({ balanceBefore: 1.0, expectedAmountOut: 0.05, onLanded: (b) => { landedAt = b; } });
  await settle();
  watcher.stop();
  clk.advance(DEFAULT_LANDING_INTERVAL_MS);
  await settle();
  assert.equal(landedAt, null);
  assert.equal(watcher.isRunning(), false);
});
