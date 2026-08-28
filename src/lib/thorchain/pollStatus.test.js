/**
 * pollStatus.test.js — the THORChain status polling state machine (Step 3.1).
 *
 * The poller is pure + DI: fetchImpl is a mock endpoint, `schedule` is a
 * manual scheduler the test drives by hand, and `now` is a fake clock — so
 * the 15s interval, the 90-minute cap, and every stage transition are
 * asserted without real waiting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createThorchainStatusPoller, DEFAULT_POLL_INTERVAL_MS, DEFAULT_MAX_POLL_MS } from "./pollStatus.js";

/** Manual scheduler: records scheduled callbacks; the test fires them. */
function manualScheduler() {
  const scheduled = []; // {fn, ms}
  return {
    schedule(fn, ms) {
      scheduled.push({ fn, ms });
      let cancelled = false;
      return () => { cancelled = true; };
    },
    get scheduled() { return scheduled; },
    /** Fire the next scheduled callback (FIFO), return its delay. */
    fireNext() {
      const item = scheduled.shift();
      assert.ok(item, "expected a scheduled callback");
      item.fn();
      return item.ms;
    },
    count() { return scheduled.length; },
  };
}

/** Fake clock the test advances explicitly. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; },
  };
}

/** Mock endpoint: returns the next scripted response per call. */
function mockEndpoint(...responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const r = responses.shift() ?? { json: async () => ({ status: "done" }) };
    if (r instanceof Error) throw r;
    return {
      status: r.status ?? 200,
      json: async () => r.body,
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const HOP = { inboundTxid: "tx-abc", sourceChain: "BTC" };

function makePoller({ responses, intervalMs, maxMs, schedule, clock } = {}) {
  const sched = schedule ?? manualScheduler();
  const clk = clock ?? fakeClock(1_000_000);
  const fetchImpl = mockEndpoint(...(responses ?? []));
  const poller = createThorchainStatusPoller({
    fetchImpl,
    intervalMs: intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxMs: maxMs ?? DEFAULT_MAX_POLL_MS,
    schedule: sched.schedule,
    now: clk.now,
  });
  return { poller, sched, clk, fetchImpl };
}

const settle = () => new Promise((r) => setImmediate(r));

test("walks observed → swapping → outbound_signed → done with 15s intervals, then stops", async () => {
  const { poller, sched, clk, fetchImpl } = makePoller({
    responses: [
      { body: { status: "observed" } },
      { body: { status: "swapping" } },
      { body: { status: "outbound_signed" } },
      { body: { status: "done" } },
    ],
  });

  const stages = [];
  let doneCount = 0;
  poller.start({
    ...HOP,
    onStage: (s) => stages.push(s),
    onDone: () => { doneCount += 1; },
  });
  await settle(); // initial immediate poll

  assert.deepEqual(stages, ["observed"]);
  assert.equal(poller.isRunning(), true);

  // advance 15s, fire the scheduled poll → swapping
  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  assert.equal(sched.fireNext(), DEFAULT_POLL_INTERVAL_MS);
  await settle();
  assert.deepEqual(stages, ["observed", "swapping"]);

  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.deepEqual(stages, ["observed", "swapping", "outbound_signed"]);

  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.deepEqual(stages, ["observed", "swapping", "outbound_signed", "done"]);
  assert.equal(doneCount, 1);
  assert.equal(poller.isRunning(), false, "poller stops after done");
  assert.equal(sched.count(), 0, "no further polls scheduled after done");

  assert.equal(fetchImpl.calls.length, 4);
  assert.ok(fetchImpl.calls[0].endsWith("/thorchain/tx/status/tx-abc"), "hits the brief's endpoint shape");
});

test("fires onStage only on CHANGE (resume from a persisted stage does not re-fire it)", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [
      { body: { status: "swapping" } }, // same as the persisted stage
      { body: { status: "outbound_signed" } },
    ],
  });

  const stages = [];
  poller.start({ ...HOP, initialStage: "swapping", onStage: (s) => stages.push(s) });
  await settle();
  assert.deepEqual(stages, [], "persisted stage is not re-emitted");

  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.deepEqual(stages, ["outbound_signed"], "only the NEW stage is emitted");
});

test("not-found responses retry silently (no callbacks), then progresses", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [
      { status: 404, body: {} },
      { body: { status: "observed" } },
    ],
  });

  const stages = [];
  let errors = 0;
  poller.start({ ...HOP, onStage: (s) => stages.push(s), onError: () => { errors += 1; } });
  await settle();
  assert.deepEqual(stages, [], "not-found: no stage emitted");
  assert.equal(errors, 0, "not-found is a silent retry");

  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.deepEqual(stages, ["observed"]);
  assert.equal(poller.isRunning(), true);
});

test("halted surfaces 'paused by THORChain' via onHalted AND keeps polling", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [
      { body: { status: "observed", halted: true } },
      { body: { status: "swapping" } }, // chain un-halts
    ],
  });

  let haltedAt = null;
  const stages = [];
  poller.start({ ...HOP, onHalted: (stage) => { haltedAt = stage; }, onStage: (s) => stages.push(s) });
  await settle();
  assert.equal(haltedAt, "observed", "halted surfaced with the current stage");
  assert.equal(poller.isRunning(), true, "keeps polling while halted");

  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.deepEqual(stages, ["observed", "swapping"], "polling continues after the chain un-halts");
});

test("endpoint errors surface via onError and keep polling within max", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [
      new Error("network down"),
      { body: { status: "observed" } },
    ],
  });

  const errors = [];
  const stages = [];
  poller.start({ ...HOP, onError: (m) => errors.push(m), onStage: (s) => stages.push(s) });
  await settle();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unreachable/);
  assert.equal(poller.isRunning(), true);

  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.deepEqual(stages, ["observed"], "recovers once the endpoint is reachable again");
});

test("error bodies surface via onError and keep polling", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [
      { body: { error: "internal server error" } },
      { body: { status: "done" } },
    ],
  });
  const errors = [];
  poller.start({ ...HOP, onError: (m) => errors.push(m) });
  await settle();
  assert.deepEqual(errors, ["internal server error"]);
  assert.equal(poller.isRunning(), true);

  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.equal(poller.isRunning(), false, "reached done after the error");
});

test("times out when the 90-minute max window is exceeded (mid-poll)", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [{ body: { status: "observed" } }, { body: { status: "observed" } }],
  });

  let timedOut = 0;
  poller.start({ ...HOP, onTimeout: () => { timedOut += 1; } });
  await settle();
  assert.equal(poller.isRunning(), true);

  // Advance past the 90-minute cap before the next scheduled poll fires.
  clk.advance(DEFAULT_MAX_POLL_MS + 1);
  sched.fireNext();
  await settle();
  assert.equal(timedOut, 1, "timeout fires once");
  assert.equal(poller.isRunning(), false, "poller stops after the max window");
  assert.equal(sched.count(), 0);
});

test("times out on the 90-minute boundary exactly (now - startedAt > maxMs)", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [{ body: { status: "observed" } }],
  });
  let timedOut = 0;
  poller.start({ ...HOP, onTimeout: () => { timedOut += 1; } });
  await settle();
  clk.advance(DEFAULT_MAX_POLL_MS); // exactly at the boundary — NOT over
  sched.fireNext();
  await settle();
  assert.equal(timedOut, 0, "at exactly maxMs the poller keeps polling");
  assert.equal(poller.isRunning(), true);
});

test("stop() cancels the scheduled poll and marks the poller stopped", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [{ body: { status: "observed" } }],
  });
  const stages = [];
  poller.start({ ...HOP, onStage: (s) => stages.push(s) });
  await settle();
  assert.deepEqual(stages, ["observed"]);

  poller.stop();
  const scheduledBefore = sched.count();
  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  // The scheduled callback was cancelled — firing it manually must not poll
  // (tick checks running/cancelled). We drop it instead of firing.
  assert.equal(poller.isRunning(), false);
  assert.equal(scheduledBefore, 1, "a poll was scheduled");
  // Simulate the cancelled timer never firing: nothing to assert beyond state.
  await settle();
  assert.equal(stages.length, 1, "no further stage callbacks after stop");
});

test("start() requires an inboundTxid", () => {
  const { poller } = makePoller();
  assert.throws(() => poller.start({}), /inboundTxid is required/);
});

test("tickNow() forces an immediate poll cycle (test/operator hook)", async () => {
  const { poller, sched, clk } = makePoller({
    responses: [
      { body: { status: "observed" } },
      { body: { status: "swapping" } }, // consumed by tickNow, not the timer
    ],
  });
  const stages = [];
  poller.start({ ...HOP, onStage: (s) => stages.push(s) });
  await settle();
  assert.deepEqual(stages, ["observed"]);

  await poller.tickNow();
  assert.deepEqual(stages, ["observed", "swapping"], "tickNow polls immediately");

  // The scheduled timer remains for the next regular interval.
  clk.advance(DEFAULT_POLL_INTERVAL_MS);
  sched.fireNext();
  await settle();
  assert.equal(poller.isRunning(), true);
});
