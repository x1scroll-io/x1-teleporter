/**
 * fetchWithTimeout.test.js — the fail-closed network bound (audit 2026-10-14).
 *
 * Pins the guarantee that a stalled HTTP request (a proxy/socket that never
 * answers) REJECTS with a clear "request timed out" instead of hanging the
 * swap/bridge UI — and that the poll loop's `maxMs` is a real wall-clock
 * deadline, not an iteration count.
 *
 * Mocks only — no real network.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  fetchWithTimeout,
  makeTimeoutError,
  isTimeoutError,
  DEFAULT_FETCH_TIMEOUT_MS,
  QUOTE_TIMEOUT_MS,
  POLL_TIMEOUT_MS,
} from "./fetchWithTimeout.js";
import { pollWarpStatus } from "../../warpBridge.js";

/** A fetch that NEVER settles — the exact stall the audit reproduced. */
const never = () => new Promise(() => {});

function mockFetch(fn) {
  mock.method(globalThis, "fetch", fn);
}

// ── the helper itself ─────────────────────────────────────────────────────

test("fetchWithTimeout: default + named timeouts are sane and exported", () => {
  assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 20_000);
  assert.equal(QUOTE_TIMEOUT_MS, 20_000);
  assert.equal(POLL_TIMEOUT_MS, 8_000);
});

test("fetchWithTimeout: rejects within the timeout window when fetch never resolves (no hang)", async () => {
  mockFetch(never);
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => fetchWithTimeout("https://x.test/hang", {}, 60),
      (e) => {
        assert.equal(e.name, "TimeoutError");
        assert.equal(e.code, "ETIMEDOUT");
        assert.match(e.message, /request timed out/);
        assert.equal(e.timeoutMs, 60);
        return true;
      },
    );
    const dt = Date.now() - t0;
    assert.ok(dt < 1000, `rejected promptly (${dt}ms) — never hung`);
  } finally { mock.restoreAll(); }
});

test("fetchWithTimeout: a normal response passes through untouched", async () => {
  const resp = { ok: true, status: 200, async json() { return { ok: 1 }; } };
  mockFetch(async () => resp);
  try {
    const r = await fetchWithTimeout("https://x.test/ok", {}, 60);
    assert.equal(r, resp);
  } finally { mock.restoreAll(); }
});

test("fetchWithTimeout: a non-timeout fetch error is rethrown unchanged (not mislabeled)", async () => {
  mockFetch(async () => { throw new Error("boom-500"); });
  try {
    await assert.rejects(
      () => fetchWithTimeout("https://x.test/boom", {}, 60),
      (e) => { assert.match(e.message, /boom-500/); assert.ok(!isTimeoutError(e)); return true; },
    );
  } finally { mock.restoreAll(); }
});

test("fetchWithTimeout: the fetchImpl DI seam is bounded too", async () => {
  await assert.rejects(
    () => fetchWithTimeout("https://x.test/di", {}, 50, { fetchImpl: never }),
    (e) => isTimeoutError(e),
  );
});

test("fetchWithTimeout: a caller AbortController abort is surfaced (NOT mislabeled a timeout)", async () => {
  const ctrl = new AbortController();
  mockFetch((url, opts) => new Promise((_, rej) => {
    // Emulate a real fetch honoring the signal it is handed.
    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => {
        const e = new Error("operation aborted");
        e.name = "AbortError";
        rej(e);
      });
    }
  }));
  try {
    const p = fetchWithTimeout("https://x.test/abort", { signal: ctrl.signal }, 60);
    setTimeout(() => ctrl.abort(), 10);
    await assert.rejects(() => p, (e) => {
      assert.equal(e.name, "AbortError");
      assert.ok(!isTimeoutError(e), "a caller abort is not a timeout");
      return true;
    });
  } finally { mock.restoreAll(); }
});

test("fetchWithTimeout: stalled fetch leaves NO pending promise — settles (bounded)", async () => {
  mockFetch(never);
  try {
    let settled = false;
    await fetchWithTimeout("https://x.test/pending", {}, 40)
      .then(() => { settled = true; }, () => { settled = true; });
    assert.equal(settled, true, "the call settled (did not stay pending)");
  } finally { mock.restoreAll(); }
});

test("makeTimeoutError/isTimeoutError: canonical, greppable shape", () => {
  const e = makeTimeoutError(1234, "https://x.test/z");
  assert.match(e.message, /request timed out after 1234ms/);
  assert.ok(e.message.includes("https://x.test/z"));
  assert.ok(isTimeoutError(e));
  assert.ok(!isTimeoutError(new Error("request timed out"))); // message alone isn't a timeout tag
});

// ── pollWarpStatus: wall-clock bounded (was: overshoot past maxMs) ─────────

test("pollWarpStatus: a stalled fetch TIMES OUT within maxMs — no pending promise", async () => {
  mockFetch(never);
  try {
    const t0 = Date.now();
    const res = await pollWarpStatus("sig-hang", { from: "x1", maxMs: 120, intervalMs: 15, timeoutMs: 20 });
    const dt = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.ok(dt < 800, `wall-clock bounded: ${dt}ms (<= maxMs + slack)`);
  } finally { mock.restoreAll(); }
});

test("pollWarpStatus: a fetch slower than maxMs no longer overshoots (prior STILL-PENDING 1502ms case)", async () => {
  // A fetch that only answers after 1502ms — PAST the poll deadline. Pre-fix
  // the poller sat STILL-PENDING well beyond maxMs; now the wall-clock deadline
  // + the per-request timeout bound the TOTAL wait.
  const slow = () => new Promise((resolve) => setTimeout(
    () => resolve({ ok: true, status: 200, async json() { return { signatures: [] }; } }),
    1502,
  ));
  mockFetch(slow);
  try {
    const t0 = Date.now();
    const res = await pollWarpStatus("sig-slow", { from: "x1", maxMs: 120, intervalMs: 15, timeoutMs: 25 });
    const dt = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.ok(dt < 700, `resolved within a bounded time (${dt}ms) — never waited on the 1502ms body`);
  } finally { mock.restoreAll(); }
});

test("pollWarpStatus: a stalled fetch surfaces as poll_error, keeps the deadline, then returns timedOut", async () => {
  mockFetch(never);
  try {
    const stages = [];
    const res = await pollWarpStatus("sig-hang2", {
      from: "x1", maxMs: 100, intervalMs: 15, timeoutMs: 20,
      onUpdate: (s, d) => stages.push([s, d]),
    });
    assert.equal(res.timedOut, true);
    const errs = stages.filter(([s]) => s === "poll_error");
    assert.ok(errs.length >= 1, "the stalled request is reported, not swallowed silently");
    assert.ok(errs.every(([, d]) => /timed out/i.test(d.msg)), `timeout is the reported reason: ${JSON.stringify(stages)}`);
  } finally { mock.restoreAll(); }
});
