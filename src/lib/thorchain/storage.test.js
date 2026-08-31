/**
 * storage.test.js — closed-tab resume persistence (Step 3.1).
 *
 * docs/BRIEF.md: persist `{inboundTxid, stage}` in window.storage keyed by
 * txid, no server state. The storage handle is DI — these tests use an
 * in-memory backend and prove save/load/list/remove, txid keying, malformed
 * entry handling, and that "done" entries drop out of the pending list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createThorchainStorage, HOP_KEY_PREFIX } from "./storage.js";

/** In-memory backend with getAll() (mirrors the default backend's shape). */
function memBackend() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, v); },
    del: (k) => { m.delete(k); },
    getAll: () => Object.fromEntries(m),
    map: m,
  };
}

const PAYLOAD = { inboundTxid: "tx-abc", sourceChain: "BTC", destination: "SOL", expectedAmountOut: 0.05 };

test("saveHop persists {inboundTxid, stage} keyed by txid with the payload", () => {
  const backend = memBackend();
  const store = createThorchainStorage(backend);

  store.saveHop({ inboundTxid: "tx-abc", stage: "observed", payload: PAYLOAD });

  const raw = backend.map.get(`${HOP_KEY_PREFIX}tx-abc`);
  assert.ok(raw, "entry stored under the txid key");
  assert.equal(raw.inboundTxid, "tx-abc");
  assert.equal(raw.stage, "observed");
  assert.deepEqual(raw.payload, PAYLOAD);
  assert.ok(raw.updatedAt > 0);
});

test("loadHop returns the entry; missing txids return null", () => {
  const store = createThorchainStorage(memBackend());
  store.saveHop({ inboundTxid: "tx-abc", stage: "swapping", payload: PAYLOAD });

  const entry = store.loadHop("tx-abc");
  assert.equal(entry.inboundTxid, "tx-abc");
  assert.equal(entry.stage, "swapping");
  assert.deepEqual(entry.payload, PAYLOAD);

  assert.equal(store.loadHop("tx-nope"), null);
});

test("saveHop updates the stage of an existing entry (stage progression)", () => {
  const store = createThorchainStorage(memBackend());
  store.saveHop({ inboundTxid: "tx-abc", stage: "observed", payload: PAYLOAD });
  store.saveHop({ inboundTxid: "tx-abc", stage: "swapping", payload: PAYLOAD });

  const entry = store.loadHop("tx-abc");
  assert.equal(entry.stage, "swapping");
});

test("removeHop deletes the entry (completed journeys are forgotten)", () => {
  const store = createThorchainStorage(memBackend());
  store.saveHop({ inboundTxid: "tx-abc", stage: "done", payload: PAYLOAD });
  store.removeHop("tx-abc");
  assert.equal(store.loadHop("tx-abc"), null);
});

const settle = () => new Promise((r) => setTimeout(r, 2));

test("listHops returns pending (non-done) entries, newest first", async () => {
  const store = createThorchainStorage(memBackend());
  store.saveHop({ inboundTxid: "tx-1", stage: "observed", payload: { ...PAYLOAD, inboundTxid: "tx-1" } });
  await settle(); // distinct updatedAt so "newest first" is deterministic
  store.saveHop({ inboundTxid: "tx-2", stage: "done", payload: { ...PAYLOAD, inboundTxid: "tx-2" } });
  await settle();
  store.saveHop({ inboundTxid: "tx-3", stage: "outbound_signed", payload: { ...PAYLOAD, inboundTxid: "tx-3" } });

  const pending = store.listHops();
  assert.deepEqual(
    pending.map((p) => p.inboundTxid),
    ["tx-3", "tx-1"],
    "done entries drop out; pending entries listed",
  );
  assert.equal(pending[0].stage, "outbound_signed");
});

test("malformed entries are dropped on load (never crash the resume path)", () => {
  const backend = memBackend();
  backend.map.set(`${HOP_KEY_PREFIX}tx-bad`, { stage: "swapping" }); // no inboundTxid
  backend.map.set(`${HOP_KEY_PREFIX}tx-junk`, "not-an-object");

  const store = createThorchainStorage(backend);
  assert.equal(store.loadHop("tx-bad"), null);
  assert.equal(store.loadHop("tx-junk"), null);
  assert.equal(store.loadHop("tx-bad"), null, "malformed entry removed on first load");
});

test("an entry whose stored txid does not match its key is dropped", () => {
  const backend = memBackend();
  backend.map.set(`${HOP_KEY_PREFIX}tx-key`, { inboundTxid: "tx-OTHER", stage: "swapping" });
  const store = createThorchainStorage(backend);
  assert.equal(store.loadHop("tx-key"), null);
});

test("saveHop requires an inboundTxid", () => {
  const store = createThorchainStorage(memBackend());
  assert.throws(() => store.saveHop({ stage: "observed" }), /inboundTxid is required/);
});
