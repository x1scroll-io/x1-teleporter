/**
 * mevPayout.test.js — the MEV PAYOUT wiring tests (the treasury design's
 * routing-layer seam — docs/MEV-PAYOUT.md).
 *
 * Spec coverage:
 *   • captureGate wiring: runCaptureScan results carry the drop-as-is
 *     `payout` destination; runRouteCaptureScan carries `payouts` per
 *     distinct leg chain (a journey spans chains — per-capture
 *     destinations follow each leg),
 *   • dropAsIsRecords (same-pair): ONE record — the net capture in the
 *     pair.from token, destination = the chain treasury; no-capture scans
 *     record nothing,
 *   • dropAsIsRecords (multi-hop): ONE record per improved chain'd leg in
 *     the leg's to-token; improved legs without a chain are SKIPPED with a
 *     reason (never silently dropped),
 *   • the GATE discipline: gated OFF (default) → detection-only; the
 *     execution guard throws; every record is measurement-mode; every
 *     sweep plan is executable:false with signableArtifacts:[] — deposit-
 *     only, no autonomous broadcast at any flag value,
 *   • RoutePlanner re-exports the payout surface; default routing is
 *     BYTE-UNCHANGED (the forward route id still plans),
 *   • REAL-fixture measurement (the exotic-route verify path): the frozen
 *     REAL-labeled multi-hop evidence (route-01-sol-ape-2500-down.json)
 *     runs the route scan → dropAsIsRecords → ledger → sweep plan: the
 *     recorded amounts EQUAL the analyzer's per-leg deltas (the MEASURE/
 *     VERIFY self-consistency), every record carries the sol treasury, and
 *     the sweep plan converts the pile with executable:false.
 *
 * Pure/offline — frozen fixtures, no network, no funds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RoutePlanner, capturePayoutForChain, dropAsIsRecords } from "../src/engine/index.js";
import {
  captureGate,
  runCaptureScan,
  runRouteCaptureScan,
  assertCaptureGateOpen,
  CaptureGateClosedError,
  CAPTURE_GATE_MODES,
} from "../src/lib/mev/captureGate.js";
import { DEFAULT_MEV_PAYOUT_CONFIG, treasuryForChain, MEV_PAYOUT_DEPOSIT_ONLY_NOTE } from "../src/lib/mev/payoutConfig.js";
import { emptyLedger, recordCaptures, accumulatePile } from "../src/lib/mev/captureLedger.js";
import { planChainSweep } from "../src/lib/mev/sweepPlanner.js";
import { analyzeRoute } from "../src/lib/mev/routeAnalyzer.js";

const here = dirname(fileURLToPath(import.meta.url));
const SVM_TREASURY = treasuryForChain(DEFAULT_MEV_PAYOUT_CONFIG, "sol");
const EVM_TREASURY = treasuryForChain(DEFAULT_MEV_PAYOUT_CONFIG, "eth");
const MULTIHOP_INPUT = join(here, "..", "test", "fixtures", "golden", "mev-multihop", "inputs", "route-01-sol-ape-2500-down.json");
const PAIR_INPUT = join(here, "..", "test", "fixtures", "golden", "mev-capture", "inputs", "round-01-sol-SOL-USDC-evidence.json");

/** A quote pair where `better` beats `worse` (same size). The `dex` field
 *  is what the SAME-PAIR detector reads (gapDetector.normalizeQuote); the
 *  route analyzer accepts dex as the venue name too. */
function venuePair(betterVenue, worseVenue, amountIn, betterOut, worseOut) {
  return [
    { dex: betterVenue, amountIn, amountOut: betterOut },
    { dex: worseVenue, amountIn, amountOut: worseOut },
  ];
}

// ── captureGate wiring: scans carry the drop-as-is payout destination ──────
test("mev-payout: runCaptureScan carries the drop-as-is payout destination (deposit-only)", () => {
  const { detection, gate, report, payout } = runCaptureScan({
    chain: "sol",
    pair: { from: "SOL", to: "USDC" },
    buyQuotes: venuePair("jupiter", "orca", "1000000000", "1001000000", "990000000"),
    sellQuotes: venuePair("orca", "jupiter", "1001000000", "1002000000", "1001000000"),
  });
  assert.equal(detection.wouldCapture, true);
  assert.equal(gate.enabled, false);
  assert.match(report, /gated OFF/);
  assert.ok(payout, "the scan result carries the payout annotation");
  assert.equal(payout.address, SVM_TREASURY);
  assert.equal(payout.group, "solana_x1");
  assert.equal(payout.dropAsIs, true);
  assert.equal(payout.depositOnly, true);
  // an unconfigured chain carries no payout; a missing chain carries none
  assert.equal(runCaptureScan({ chain: "avax", pair: { from: "A", to: "B" }, buyQuotes: venuePair("x", "y", "1", "2", "1"), sellQuotes: venuePair("y", "x", "2", "2", "1") }).payout, null);
  assert.equal(runCaptureScan({ buyQuotes: venuePair("x", "y", "1", "2", "1"), sellQuotes: venuePair("y", "x", "2", "2", "1") }).payout, null);
});

test("mev-payout: runRouteCaptureScan carries per-leg-chain payouts (a journey spans chains)", () => {
  const scan = runRouteCaptureScan({
    id: "two-chain-route",
    legs: [
      { hop: 1, from: "SOL", to: "USDC", chain: "sol", kind: "swap", venueChosen: "orca", quotes: venuePair("jupiter", "orca", "1000", "1010", "1000") },
      { hop: 2, from: "USDC", to: "ETH", chain: "eth", kind: "swap", venueChosen: "uniswap", quotes: venuePair("lifi", "uniswap", "1000", "1005", "1000") },
    ],
  });
  assert.ok(scan.payouts, "multi-hop scans carry per-leg-chain destinations");
  assert.equal(scan.payouts.sol.address, SVM_TREASURY);
  assert.equal(scan.payouts.eth.address, EVM_TREASURY);
  assert.deepEqual(Object.keys(scan.payouts).sort(), ["eth", "sol"]);
});

// ── dropAsIsRecords: scan result → ledger record drafts ────────────────────
test("mev-payout: dropAsIsRecords (same-pair) — one record, net capture in the pair.from token, chain treasury destination", () => {
  const scan = runCaptureScan({
    chain: "sol",
    pair: { from: "SOL", to: "USDC" },
    buyQuotes: venuePair("jupiter", "orca", "1000000000", "1001000000", "990000000"),
    sellQuotes: venuePair("orca", "jupiter", "1001000000", "1002000000", "1001000000"),
  });
  const { records, skipped } = dropAsIsRecords(scan);
  assert.equal(records.length, 1);
  assert.equal(records[0].token, "SOL");
  assert.equal(records[0].amountRaw, scan.detection.netValueAfterCostsRaw, "the recorded amount IS the engine's net capture (measure/verify)");
  assert.equal(records[0].chain, "sol");
  assert.equal(records[0].destinationTreasury, SVM_TREASURY);
  assert.equal(records[0].source, "detection", "default source");
  assert.equal(records[0].simulated, false);
  assert.equal(records[0].dropAsIs, true);
  assert.equal(records[0].mode, "measurement");
  assert.equal(records[0].evidence.kind, "same-pair-cross-venue");
  assert.equal(skipped.length, 0);

  // simulated/test flags pass through (sandbox measurement marking)
  const sim = dropAsIsRecords(scan, { source: "test", simulated: true, test: true });
  assert.equal(sim.records[0].source, "test");
  assert.equal(sim.records[0].simulated, true);
  assert.equal(sim.records[0].test, true);
});

test("mev-payout: dropAsIsRecords (same-pair) — a no-capture scan records nothing", () => {
  const scan = runCaptureScan({
    chain: "eth",
    pair: { from: "USDC", to: "USDT" },
    buyQuotes: [{ dex: "a", amountIn: "1", amountOut: "1" }],
    sellQuotes: [{ dex: "a", amountIn: "1", amountOut: "1" }],
  });
  assert.equal(scan.detection.wouldCapture, false);
  const { records, skipped } = dropAsIsRecords(scan);
  assert.equal(records.length, 0);
  assert.equal(skipped.length, 0, "no capture → nothing to skip either");
});

test("mev-payout: dropAsIsRecords (multi-hop) — per improved chain'd leg; no-chain legs are skipped with a reason", () => {
  const scan = runRouteCaptureScan({
    id: "skip-test",
    legs: [
      { hop: 1, from: "SOL", to: "USDC", chain: "sol", kind: "swap", venueChosen: "orca", quotes: venuePair("jupiter", "orca", "1000", "1010", "1000") },
      // improved, but no chain — the value accrues on an unattributable leg destination
      { hop: 2, from: "USDC", to: "EXOTIC", chain: null, kind: "swap", venueChosen: "orca", quotes: venuePair("jupiter", "orca", "1000", "1010", "1000") },
      // single-venue → no venue choice → contributes nothing
      { hop: 3, from: "USDC", to: "USDT", chain: "eth", kind: "swap", venueChosen: "lifi", quotes: [{ venue: "lifi", amountIn: "1000", amountOut: "1000" }] },
    ],
  });
  const { records, skipped } = dropAsIsRecords(scan);
  assert.equal(records.length, 1, "only the improved chain'd leg records a drop-as-is capture");
  assert.equal(records[0].hop ?? records[0].evidence.hop, 1);
  assert.equal(records[0].token, "USDC");
  assert.equal(records[0].amountRaw, scan.analysis.legs[0].deltaOutRaw);
  assert.equal(records[0].destinationTreasury, SVM_TREASURY);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].hop, 2);
  assert.match(skipped[0].reason, /carries no chain/);
});

// ── the gate discipline ─────────────────────────────────────────────────────
test("mev-payout: gated OFF → detection-only mode, guard throws, everything is measurement + signable-artifact-only", () => {
  const gate = captureGate();
  assert.equal(gate.enabled, false);
  assert.equal(gate.mode, CAPTURE_GATE_MODES.DETECTION_ONLY);
  assert.throws(() => assertCaptureGateOpen(), CaptureGateClosedError);
  assert.throws(() => assertCaptureGateOpen(), /MEV_CAPTURE_ENABLED=false/);
  // a full wiring pass: scan → records → ledger → sweep plan stays dead
  const scan = runCaptureScan({
    chain: "sol",
    pair: { from: "SOL", to: "USDC" },
    buyQuotes: venuePair("jupiter", "orca", "1000000000", "1001000000", "990000000"),
    sellQuotes: venuePair("orca", "jupiter", "1001000000", "1002000000", "1001000000"),
  });
  const { records } = dropAsIsRecords(scan, { source: "simulated", simulated: true });
  let ledger = emptyLedger();
  ({ state: ledger } = recordCaptures(ledger, records));
  const plan = planChainSweep({ ledgerState: ledger, chain: "sol" });
  assert.equal(plan.executable, false, "the sweep plan is never executable");
  assert.deepEqual(plan.signableArtifacts, []);
  assert.equal(plan.gate.enabled, false);
  assert.equal(plan.destination.depositOnly, true);
  assert.equal(records[0].mode, "measurement", "records are measurement-first");
  assert.match(MEV_PAYOUT_DEPOSIT_ONLY_NOTE, /never holds, signs, or spends/);
});

// ── RoutePlanner re-exports + default routing byte-unchanged ───────────────
test("mev-payout: RoutePlanner re-exports the payout surface; default routing is untouched", () => {
  assert.equal(typeof RoutePlanner.capturePayoutForChain, "function");
  assert.equal(typeof RoutePlanner.dropAsIsRecords, "function");
  assert.equal(capturePayoutForChain("sol").address, SVM_TREASURY);
  assert.equal(RoutePlanner.capturePayoutForChain("x1").address, SVM_TREASURY);
  assert.equal(RoutePlanner.capturePayoutForChain("rbn").address, EVM_TREASURY);
  assert.equal(RoutePlanner.plan({ direction: "forward" }).id, "forward-eth-x1", "default routing unchanged");
  assert.equal(RoutePlanner.plan({ direction: "swap", via: "jupiter" }).id, "swap-sol-sol-jupiter");
  assert.equal(typeof dropAsIsRecords, "function", "named re-export present");
});

// ── REAL-fixture measurement (the exotic-route MEASURE/VERIFY path) ────────
test("mev-payout: the frozen REAL sol-ape route measures → records → sweeps with executable:false (no funds)", () => {
  const evidence = JSON.parse(readFileSync(MULTIHOP_INPUT, "utf8"));
  const scan = runRouteCaptureScan({ id: evidence.routeId, legs: evidence.legs });
  assert.equal(scan.gate.enabled, false);
  assert.match(scan.report, /gated OFF/);
  const { records, skipped } = dropAsIsRecords(scan, { source: "test", simulated: true, test: true });
  assert.equal(skipped.length, 0, "every improved leg of the sol-ape route is chain-attributable");
  assert.ok(records.length >= 1, "the ape route records its per-leg captures");

  // MEASURE/VERIFY: the recorded amounts EQUAL the analyzer's per-leg deltas
  const analysis = analyzeRoute({ id: evidence.routeId, legs: evidence.legs });
  const expected = analysis.legs
    .filter((l) => !l.singleVenue && BigInt(l.deltaOutRaw) > 0n)
    .reduce((s, l) => s + BigInt(l.deltaOutRaw), 0n);
  const recorded = records.reduce((s, r) => s + BigInt(r.amountRaw), 0n);
  assert.equal(recorded, expected, "the ledger records exactly what the engine detected (drop-as-is intent)");
  for (const r of records) {
    assert.equal(r.chain, "sol");
    assert.equal(r.destinationTreasury, SVM_TREASURY, "sol captures drop to the SVM treasury");
    assert.equal(r.test, true);
    assert.equal(r.mode, "measurement");
  }

  // ledger → sweep plan (per-chain, default consolidation)
  let ledger = emptyLedger();
  ({ state: ledger } = recordCaptures(ledger, records));
  const pile = accumulatePile(ledger, { chain: "sol" });
  assert.deepEqual(pile.map((p) => p.token).sort(), [...new Set(records.map((r) => r.token))].sort());
  const plan = planChainSweep({ ledgerState: ledger, chain: "sol" });
  assert.equal(plan.wouldSweep, true);
  assert.equal(plan.destination.address, SVM_TREASURY);
  assert.equal(plan.executable, false);
  assert.equal(plan.gate.enabled, false);
  assert.deepEqual(plan.signableArtifacts, []);
  const keeps = plan.steps.filter((s) => s.action === "keep");
  const converts = plan.steps.filter((s) => s.action === "convert");
  assert.equal(keeps.length + converts.length, plan.pile.length, "every pile row is planned (keep or convert)");
});

test("mev-payout: the frozen REAL same-pair evidence scan is consistent with its records (gated OFF)", () => {
  const evidence = JSON.parse(readFileSync(PAIR_INPUT, "utf8"));
  const ok = (list) => (list || []).filter((q) => q.ok !== false && q.amountOut !== undefined && q.amountOut !== null);
  const buyQuotes = ok(evidence.buy).map((q) => ({ dex: q.dex, pool: q.pool ?? null, amountIn: q.amountIn, amountOut: q.amountOut }));
  const sellQuotes = ok(evidence.sell).map((q) => ({ dex: q.dex, pool: q.pool ?? null, amountIn: q.amountIn, amountOut: q.amountOut }));
  const scan = runCaptureScan({
    chain: evidence.chain,
    pair: { from: evidence.pair?.from ?? null, to: evidence.pair?.to ?? null },
    buyQuotes,
    sellQuotes,
    gasCostQuoteUnits: "0",
  });
  assert.equal(scan.gate.enabled, false);
  assert.ok(scan.payout, "the same-pair scan carries the sol treasury");
  assert.equal(scan.payout.address, SVM_TREASURY);
  const { records, skipped } = dropAsIsRecords(scan, { source: "simulated", simulated: true });
  // consistency: a record exists IFF the detection is a positive net capture
  const wouldCapture = scan.detection.wouldCapture && BigInt(scan.detection.netValueAfterCostsRaw ?? 0) > 0n;
  assert.equal(records.length, wouldCapture ? 1 : 0);
  if (wouldCapture) {
    assert.equal(records[0].amountRaw, scan.detection.netValueAfterCostsRaw);
    assert.equal(records[0].token, evidence.pair.from);
  }
  assert.equal(skipped.length, 0);
});
