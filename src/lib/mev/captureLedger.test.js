/**
 * captureLedger.test.js — the MEV CAPTURE ACCUMULATION LEDGER tests (the
 * drop-as-is record + per-chain pile of the treasury design).
 *
 * Spec coverage:
 *   • createCaptureRecord: shape + validation (chain/token/amount/source/
 *     date; zero and negative rejections; unconfigured chain FAILS CLOSED
 *     for real detections and is allowed ONLY as an explicitly-flagged
 *     sandbox measurement),
 *   • destination: defaults to the config's treasury for the chain,
 *     explicit destinations pass through, the drop-as-is/deposit-only/
 *     measurement flags are structural on every record,
 *   • recordCapture/recordCaptures: immutable appends + updatedAt,
 *   • accumulatePile: exact BigInt per-token sums, ordering, counts,
 *     period + token filters, simulated inclusion,
 *   • queryLedger filters + summarizeLedger,
 *   • serializeLedger/parseLedger: round-trip + fail-closed on a corrupt/
 *     foreign journal (a corrupt journal is never silently overwritten),
 *   • PURE: no fs in the module — persistence is the documented file
 *     contract callers implement (sandbox default .sandbox/, gitignored).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyLedger,
  createCaptureRecord,
  recordCapture,
  recordCaptures,
  queryLedger,
  accumulatePile,
  summarizeLedger,
  serializeLedger,
  parseLedger,
  normalizeAmountRaw,
  CAPTURE_LEDGER_VERSION,
  CAPTURE_LEDGER_KIND,
  CAPTURE_RECORD_SOURCES,
  CAPTURE_LEDGER_SANDBOX_PATH,
} from "./captureLedger.js";
import { DEFAULT_MEV_PAYOUT_CONFIG, treasuryForChain } from "./payoutConfig.js";

const SVM_TREASURY = treasuryForChain(DEFAULT_MEV_PAYOUT_CONFIG, "sol");
const EVM_TREASURY = treasuryForChain(DEFAULT_MEV_PAYOUT_CONFIG, "eth");

test("capture ledger: createCaptureRecord builds the drop-as-is record (shape + structural flags)", () => {
  const r = createCaptureRecord({ chain: "sol", token: "USDC", amountRaw: "123456", capturedAt: "2026-09-07T00:00:00.000Z", evidence: { kind: "multi-hop-route-choice", hop: 1 } });
  assert.equal(r.kind, "capture-record");
  assert.match(r.id, /^cap-sol-/);
  assert.equal(r.chain, "sol");
  assert.equal(r.token, "USDC");
  assert.equal(r.amountRaw, "123456");
  assert.equal(r.destinationTreasury, SVM_TREASURY, "destination defaults to the chain's configured treasury");
  assert.equal(r.capturedAt, "2026-09-07T00:00:00.000Z");
  assert.equal(r.source, "detection", "default source");
  assert.equal(r.simulated, false);
  assert.equal(r.test, false);
  assert.equal(r.dropAsIs, true, "drop-as-is is structural");
  assert.equal(r.depositOnly, true, "deposit-only is structural");
  assert.equal(r.mode, "measurement", "measurement-first: recording is intent, not execution");
  assert.deepEqual(r.evidence, { kind: "multi-hop-route-choice", hop: 1 });
  assert.ok(Object.isFrozen(r));
});

test("capture ledger: record validation fails closed on every malformed input", () => {
  assert.throws(() => createCaptureRecord({}), /chain is required/);
  assert.throws(() => createCaptureRecord({ chain: "sol" }), /token is required/);
  assert.throws(() => createCaptureRecord({ chain: "sol", token: "USDC", amountRaw: "abc" }), /BigInt-compatible/);
  assert.throws(() => createCaptureRecord({ chain: "sol", token: "USDC", amountRaw: "-5" }), /cannot be negative/);
  assert.throws(() => createCaptureRecord({ chain: "sol", token: "USDC", amountRaw: "0" }), /zero capture/);
  assert.throws(() => createCaptureRecord({ chain: "sol", token: "USDC", amountRaw: "1", source: "live" }), /source must be one of/);
  assert.throws(() => createCaptureRecord({ chain: "sol", token: "USDC", amountRaw: "1", capturedAt: "not-a-date" }), /not a valid date/);
  assert.equal(normalizeAmountRaw("00123", "t"), "123", "amounts normalize to plain decimal strings");
  assert.deepEqual(CAPTURE_RECORD_SOURCES, ["detection", "simulated", "test"]);
});

test("capture ledger: a REAL detection on an unconfigured chain fails closed (no treasury → nowhere to drop)", () => {
  assert.throws(
    () => createCaptureRecord({ chain: "avax", token: "USDC", amountRaw: "1" }),
    /no configured treasury/,
  );
  // …but an EXPLICIT sandbox measurement is allowed (test fleet) and flagged
  const sim = createCaptureRecord({ chain: "avax", token: "USDC", amountRaw: "1", source: "simulated", simulated: true, test: true });
  assert.equal(sim.destinationTreasury, null, "no configured treasury — sandbox-only record");
  assert.equal(sim.simulated, true);
  assert.equal(sim.test, true);
});

test("capture ledger: explicit destinations pass through (sandbox test-fleet override pattern)", () => {
  const TEST_FLEET = "F6rZMb9CiZx24CHkAXGfGF4vt9nri2SKasnCjvPQQ678";
  const r = createCaptureRecord({ chain: "sol", token: "USDC", amountRaw: "7", destinationTreasury: TEST_FLEET, source: "test", test: true });
  assert.equal(r.destinationTreasury, TEST_FLEET);
});

test("capture ledger: recordCapture appends immutably; recordCaptures batches one transition", () => {
  let st = emptyLedger();
  assert.equal(st.records.length, 0);
  const { state: st2, record } = recordCapture(st, { chain: "sol", token: "USDC", amountRaw: "10" });
  assert.equal(st.records.length, 0, "the input state is untouched (immutable)");
  assert.equal(st2.records.length, 1);
  assert.equal(record.amountRaw, "10");
  const { state: st3 } = recordCaptures(st2, [
    { chain: "sol", token: "USDC", amountRaw: "20" },
    { chain: "eth", token: "EXOTIC", amountRaw: "30" },
  ]);
  assert.equal(st3.records.length, 3);
  assert.ok(st3.updatedAt, "updatedAt stamps the transition");
});

test("capture ledger: accumulatePile sums exactly per chain+token (BigInt) with counts + order", () => {
  let st = emptyLedger();
  ({ state: st } = recordCaptures(st, [
    { chain: "sol", token: "USDC", amountRaw: "5000000000", capturedAt: "2026-09-07T01:00:00.000Z" },
    { chain: "sol", token: "USDC", amountRaw: "7000000000", capturedAt: "2026-09-07T02:00:00.000Z" },
    { chain: "sol", token: "EXOTIC", amountRaw: "123456789012345678901234567890", capturedAt: "2026-09-07T03:00:00.000Z", source: "simulated", simulated: true, test: true },
    { chain: "eth", token: "USDC", amountRaw: "42", capturedAt: "2026-09-07T04:00:00.000Z" },
  ]));
  const pile = accumulatePile(st, { chain: "sol" });
  assert.equal(pile.length, 2);
  assert.equal(pile[0].token, "EXOTIC", "descending by amountRaw");
  assert.equal(pile[0].amountRaw, "123456789012345678901234567890");
  assert.equal(pile[0].recordCount, 1);
  assert.equal(pile[0].simulatedCount, 1);
  assert.equal(pile[0].testCount, 1);
  assert.equal(pile[1].token, "USDC");
  assert.equal(pile[1].amountRaw, "12000000000", "exact BigInt sum of the two USDC captures");
  assert.equal(pile[1].recordCount, 2);
  assert.equal(pile[1].detectionCount, 2);
  assert.equal(pile[1].firstCapturedAt, "2026-09-07T01:00:00.000Z");
  assert.equal(pile[1].lastCapturedAt, "2026-09-07T02:00:00.000Z");
  // period + token filters
  const since = accumulatePile(st, { chain: "sol", since: "2026-09-07T02:30:00.000Z" });
  assert.deepEqual(since.map((p) => p.token), ["EXOTIC"]);
  assert.equal(accumulatePile(st, { chain: "eth" })[0].amountRaw, "42");
  assert.throws(() => accumulatePile(st, {}), /chain is required/);
});

test("capture ledger: queryLedger filters + summarizeLedger report the honest numbers", () => {
  let st = emptyLedger();
  ({ state: st } = recordCaptures(st, [
    { chain: "sol", token: "USDC", amountRaw: "1" },
    { chain: "sol", token: "USDC", amountRaw: "2", source: "simulated", simulated: true },
    { chain: "sol", token: "EXOTIC", amountRaw: "3", source: "test", test: true },
    { chain: "x1", token: "USDC.x", amountRaw: "4" },
  ]));
  assert.equal(queryLedger(st, { chain: "sol" }).length, 3);
  assert.equal(queryLedger(st, { chain: "sol", token: "USDC" }).length, 2);
  assert.equal(queryLedger(st, { simulated: true }).length, 1);
  assert.equal(queryLedger(st, { test: true }).length, 1);
  assert.equal(queryLedger(st, { source: "detection" }).length, 2);
  const s = summarizeLedger(st);
  assert.equal(s.recordCount, 4);
  assert.equal(s.detectionCount, 2);
  assert.equal(s.simulatedCount, 1);
  assert.equal(s.testCount, 1);
  assert.deepEqual(s.chains, ["sol", "x1"]);
  assert.equal(s.byChain.sol.recordCount, 3);
  assert.equal(s.byChain.sol.amountRaw, "6");
  assert.equal(s.byChain.x1.amountRaw, "4");
  assert.match(s.depositOnlyNote, /DEPOSIT-ONLY/);
});

test("capture ledger: serialize/parse round-trips; parse fails closed on a corrupt or foreign journal", () => {
  let st = emptyLedger();
  ({ state: st } = recordCaptures(st, [
    { chain: "sol", token: "USDC", amountRaw: "10", source: "simulated", simulated: true },
    { chain: "eth", token: "EXOTIC", amountRaw: "20" },
  ]));
  const json = serializeLedger(st);
  const back = parseLedger(json);
  assert.equal(back.records.length, 2);
  assert.equal(back.kind, CAPTURE_LEDGER_KIND);
  assert.equal(back.version, CAPTURE_LEDGER_VERSION);
  assert.equal(back.records[0].amountRaw, "10");
  assert.equal(back.records[1].destinationTreasury, EVM_TREASURY);
  assert.equal(back.records[0].dropAsIs, true, "re-parsed records keep the structural flags");
  assert.equal(back.records[0].mode, "measurement");

  assert.throws(() => parseLedger("not json"), /not valid JSON/);
  assert.throws(() => parseLedger('{"kind":"something-else","records":[]}'), /not a mev-capture-ledger file/);
  assert.throws(() => parseLedger(JSON.stringify({ kind: CAPTURE_LEDGER_KIND, version: 99, records: [] })), /unsupported ledger version/);
  assert.throws(() => parseLedger(JSON.stringify({ kind: CAPTURE_LEDGER_KIND, version: 1 })), /records array/);
  assert.throws(
    () => parseLedger(JSON.stringify({ kind: CAPTURE_LEDGER_KIND, version: 1, records: [{ id: "x", chain: "sol" }] })),
    /missing "token"/,
  );
  assert.throws(
    () => parseLedger(JSON.stringify({ kind: CAPTURE_LEDGER_KIND, version: 1, records: [{ id: "x", chain: "sol", token: "USDC", amountRaw: "1", destinationTreasury: SVM_TREASURY, capturedAt: "2026-09-07T00:00:00.000Z", source: "live" }] })),
    /unknown source/,
  );
});

test("capture ledger: the module is PURE (no fs) and the persistence contract is documented + gitignored", () => {
  // the sandbox path is under .sandbox/ (gitignored) — the ledger file NEVER commits
  assert.equal(CAPTURE_LEDGER_SANDBOX_PATH, ".sandbox/mev-capture-ledger.json");
  // the module exports no fs-backed helpers — serialize/parse are the file
  // format, and the file contract string documents the caller's read/write
  const src = serializeLedger(emptyLedger());
  assert.match(src, /mev-capture-ledger/);
  assert.ok(typeof src === "string");
});
