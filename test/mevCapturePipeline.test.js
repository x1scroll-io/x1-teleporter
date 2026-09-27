/**
 * mevCapturePipeline.test.js — the MEV capture PIPELINE tests (the live-flow
 * wiring: quote → detect → record ledger → sweep plan).
 *
 * Spec coverage:
 *   • detection → record → sweep: a REAL cross-venue gap (buy cheap / sell
 *     expensive across venues, sell leg sized at the best buy output) is
 *     detected, recorded as a drop-as-is capture in the ledger (destination =
 *     the chain treasury), and the accumulated pile is routed through the
 *     batch-sweep planner (ONE per-chain plan, executable:false),
 *   • the KILL-SWITCH discipline: under `node --test` the engine is UNARMED
 *     (MEV_CAPTURE_ENABLED resolves false — the safety default) → the
 *     pipeline records the SAME value as SANDBOX MEASUREMENT (source
 *     "simulated", simulated:true) — the non-capture fallback; nothing is
 *     ever executable,
 *   • FAIL-CLOSED: no quotes → skipped (no throw); a thin gap → nothing
 *     recorded/swept; a malformed quote → the scan error is swallowed into
 *     { ok:false } — the money path is NEVER jeopardized,
 *   • the MULTI-HOP route-choice path: an exotic-route analysis records one
 *     record PER IMPROVED CHAIN'D LEG and plans a sweep per leg chain,
 *   • the stateful SESSION accumulates the ledger across quotes,
 *   • the routing-layer hook (RoutePlanner.runCapturePipelineForSwap) + the
 *     engine facade re-exports.
 *
 * Pure/offline — synthetic venue quotes + the frozen multi-hop fixture, no
 * network, no funds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RoutePlanner, runCapturePipeline, createCapturePipeline, getLiveCaptureSession } from "../src/engine/index.js";
import { runCapturePipelineForSwap } from "../src/engine/routePlanner.js";
import { captureGate, runCaptureScan } from "../src/lib/mev/captureGate.js";
import { CAPTURE_PIPELINE_MODES } from "../src/lib/mev/capturePipeline.js";
import { DEFAULT_MEV_PAYOUT_CONFIG, treasuryForChain } from "../src/lib/mev/payoutConfig.js";
import { summarizeLedger } from "../src/lib/mev/captureLedger.js";
import { observeCaptureGap, observeRouteGap } from "../src/lib/mev/observe.js";

const SOL_TREASURY = treasuryForChain(DEFAULT_MEV_PAYOUT_CONFIG, "sol");
const ETH_TREASURY = treasuryForChain(DEFAULT_MEV_PAYOUT_CONFIG, "eth");

/** A same-pair cross-venue gap where the round trip nets POSITIVE (the venue
 *  spread beats both pool fees): buy X→Y cheap, sell Y→X expensive, the sell
 *  leg sized at the best buy output (exact round trip). */
const PROFITABLE_PAIR = {
  chain: "sol",
  pair: { from: "USDC", to: "SOL" },
  buyQuotes: [
    { dex: "cheap", amountIn: "1000000000", amountOut: "1100000000" },
    { dex: "expensive", amountIn: "1000000000", amountOut: "1000000000" },
  ],
  sellQuotes: [
    { dex: "expensive", amountIn: "1100000000", amountOut: "1120000000" },
    { dex: "cheap", amountIn: "1100000000", amountOut: "1100000000" },
  ],
};

// ── detection → record → sweep (the wiring) ────────────────────────────────
test("mev-pipeline: a detected capture is RECORDED and the pile is ROUTED through the sweep planner", () => {
  const logs = [];
  const r = runCapturePipeline({ ...PROFITABLE_PAIR, onLog: (l) => logs.push(l) });

  assert.equal(r.ok, true);
  assert.equal(r.detected, true, "the venue spread is a positive round trip");
  assert.equal(r.records.length, 1, "one drop-as-is record");
  const rec = r.records[0];
  assert.equal(rec.kind, "capture-record");
  assert.equal(rec.chain, "sol");
  assert.equal(rec.token, "USDC", "the pair.from token is what drops as-is");
  assert.equal(rec.destinationTreasury, SOL_TREASURY, "drops into the chain treasury");
  assert.equal(rec.dropAsIs, true);
  assert.equal(rec.depositOnly, true);

  // the sweep: the accumulated pile is routed through the batch planner.
  assert.ok(r.sweep, "the pipeline planned the sweep");
  assert.equal(r.sweep.executable, false, "the sweep bundle is never executable");
  assert.deepEqual(r.sweep.chains, ["sol"]);
  const plan = r.sweep.plans[0];
  assert.equal(plan.chain, "sol");
  assert.equal(plan.wouldSweep, true);
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.signableArtifacts, []);
  assert.match(plan.broadcast, /never/);
  assert.equal(plan.destination.address, SOL_TREASURY);

  // the log carries the honest report + the record + sweep lines.
  assert.ok(logs.some((l) => /capture opportunity/.test(l)), "report line");
  assert.ok(logs.some((l) => /recorded 1 drop-as-is/.test(l)), "record line");
  assert.ok(logs.some((l) => /sweep planned/.test(l)), "sweep line");
});

// ── the kill-switch / measurement fallback ─────────────────────────────────
test("mev-pipeline: UNARMED (node default) → the value is recorded as SANDBOX MEASUREMENT, never executable", () => {
  // Under node --test the env is unset → the gate is closed (the safety default).
  assert.equal(captureGate().enabled, false, "node default: gate closed");

  const r = runCapturePipeline(PROFITABLE_PAIR);
  assert.equal(r.armed, false);
  assert.equal(r.mode, CAPTURE_PIPELINE_MODES.MEASUREMENT);
  assert.equal(r.detected, true, "detection still RUNS read-only");
  assert.equal(r.records.length, 1);
  // the non-capture fallback: measurement records (sandbox), not detection.
  assert.equal(r.records[0].source, "simulated");
  assert.equal(r.records[0].simulated, true);
  assert.equal(r.records[0].mode, "measurement");
  // still never executable at any gate value.
  assert.equal(r.gate.executable, false);
  assert.equal(r.sweep.executable, false);
  assert.equal(r.sweep.plans[0].executable, false);
});

// ── fail-closed ────────────────────────────────────────────────────────────
test("mev-pipeline: no quotes → skipped, never throws (the money path is untouched)", () => {
  const logs = [];
  const r = runCapturePipeline({ pair: { from: "USDC", to: "SOL" }, chain: "sol", onLog: (l) => logs.push(l) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no quotes\/route provided/);
  assert.deepEqual(r.records, []);
  assert.equal(r.sweep, null);
  assert.ok(logs.some((l) => /skipped/.test(l)));
});

test("mev-pipeline: a thin gap (no positive round trip) records nothing and sweeps nothing", () => {
  const r = runCapturePipeline({
    chain: "sol",
    pair: { from: "USDC", to: "SOL" },
    buyQuotes: [
      { dex: "a", amountIn: "1000000000", amountOut: "1000000000" },
      { dex: "b", amountIn: "1000000000", amountOut: "999999000" },
    ],
    sellQuotes: [
      { dex: "a", amountIn: "1000000000", amountOut: "999000000" },
      { dex: "b", amountIn: "1000000000", amountOut: "998000000" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.detected, false, "no capture when the fees eat the gap");
  assert.deepEqual(r.records, []);
  assert.equal(r.sweep, null, "nothing to sweep");
});

test("mev-pipeline: a malformed quote fails CLOSED into { ok:false } — never throws into the flow", () => {
  const r = runCapturePipeline({
    chain: "sol",
    pair: { from: "USDC", to: "SOL" },
    buyQuotes: [{ dex: "a", amountIn: "0", amountOut: "1" }],
    sellQuotes: [{ dex: "a", amountIn: "1", amountOut: "1" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-positive amountIn/);
  assert.deepEqual(r.records, []);
  assert.equal(r.sweep, null);
});

// ── the multi-hop route-choice path (per-leg records + per-chain sweeps) ────
test("mev-pipeline: a multi-hop route records ONE record per improved chain'd leg and sweeps per chain", () => {
  const r = runCapturePipeline({
    route: {
      id: "pipeline-multihop",
      legs: [
        {
          hop: 1,
          from: "USDC",
          to: "USDT",
          chain: "eth",
          venueChosen: "lifi",
          usdPerOutUnit: 1 / 1e6,
          quotes: [
            { venue: "lifi", amountIn: "2500000000", amountOut: "2493955555" },
            { venue: "uniswap", amountIn: "2500000000", amountOut: "2495210000" },
          ],
        },
        {
          hop: 2,
          from: "USDC",
          to: "EXOTIC",
          chain: "sol",
          venueChosen: "raydium-cpmm",
          usdPerOutUnit: 1 / 5.15e11,
          quotes: [
            { venue: "jupiter", amountIn: "2495210000", amountOut: "1282515834808065" },
            { venue: "raydium-cpmm", amountIn: "2495210000", amountOut: "1280319724902352" },
          ],
        },
      ],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.detected, true);
  // one record per improved, chain'd leg.
  assert.equal(r.records.length, 2, "eth leg + sol leg");
  const chains = r.records.map((x) => x.chain).sort();
  assert.deepEqual(chains, ["eth", "sol"]);
  assert.equal(r.records.find((x) => x.chain === "eth").destinationTreasury, ETH_TREASURY);
  assert.equal(r.records.find((x) => x.chain === "sol").destinationTreasury, SOL_TREASURY);
  // a sweep per chain.
  assert.deepEqual([...r.sweep.chains].sort(), ["eth", "sol"]);
  for (const plan of r.sweep.plans) {
    assert.equal(plan.executable, false);
    assert.equal(plan.wouldSweep, true);
  }
});

// ── the stateful session (accumulate across quotes) ────────────────────────
test("mev-pipeline: the session accumulates the ledger + re-plans the sweep across quotes", () => {
  const session = createCapturePipeline();
  assert.equal(summarizeLedger(session.ledgerState).recordCount, 0);

  session.process(PROFITABLE_PAIR);
  const afterFirst = session.summarize();
  assert.equal(afterFirst.recordCount, 1);
  assert.equal(afterFirst.byChain.sol.recordCount, 1);

  const second = session.process(PROFITABLE_PAIR);
  assert.equal(second.records.length, 1, "each capture is one record");
  const afterSecond = session.summarize();
  assert.equal(afterSecond.recordCount, 2, "the session accumulates");
  // the sweep now converts the SUMMED pile.
  const pile = second.sweep.plans[0].pile.find((p) => p.token === "USDC");
  assert.equal(pile.recordCount, 2);
  assert.equal(pile.amountRaw, (BigInt(second.records[0].amountRaw) * 2n).toString());

  session.reset();
  assert.equal(session.summarize().recordCount, 0);
});

test("mev-pipeline: getLiveCaptureSession returns a stable singleton", () => {
  assert.equal(getLiveCaptureSession(), getLiveCaptureSession());
});

// ── the routing-layer hook + engine re-exports ─────────────────────────────
test("mev-pipeline: the routing-layer hook + engine facade expose the pipeline", () => {
  assert.equal(typeof RoutePlanner.runCapturePipelineForSwap, "function");
  assert.equal(typeof RoutePlanner.createCapturePipeline, "function");
  assert.equal(typeof RoutePlanner.getLiveCaptureSession, "function");
  assert.equal(typeof runCapturePipeline, "function");
  assert.equal(typeof runCapturePipelineForSwap, "function");

  const viaHook = runCapturePipelineForSwap(PROFITABLE_PAIR);
  assert.equal(viaHook.detected, true);

  // default routing is untouched — the forward route still plans.
  assert.equal(RoutePlanner.plan({ direction: "forward" }).id, "forward-eth-x1");
});

// ── sanity: the pipeline never invents a capture the detector wouldn't ──────
test("mev-pipeline: the pipeline's detection matches the raw detector (no fabrication)", () => {
  const raw = runCaptureScan(PROFITABLE_PAIR);
  const piped = runCapturePipeline(PROFITABLE_PAIR);
  assert.equal(piped.detected, raw.detection.wouldCapture);
  assert.equal(piped.records[0].amountRaw, raw.detection.netValueAfterCostsRaw);
});

// ── the read-only observation seam (observe.js) is fail-closed ──────────────
test("mev-observe: observeCaptureGap returns the scan + logs, null on a bad scan (never throws)", () => {
  const logs = [];
  const scan = observeCaptureGap({ ...PROFITABLE_PAIR, onLog: (l) => logs.push(l) });
  assert.ok(scan && scan.detection.wouldCapture === true);
  assert.ok(logs.some((l) => /capture opportunity/.test(l)));

  const bad = observeCaptureGap({
    buyQuotes: [{ dex: "a", amountIn: "0", amountOut: "1" }],
    sellQuotes: [{ dex: "a", amountIn: "1", amountOut: "1" }],
    onLog: (l) => logs.push(l),
  });
  assert.equal(bad, null, "a malformed scan fails closed to null");
  assert.ok(logs.some((l) => /scan skipped/.test(l)));
});

test("mev-observe: observeRouteGap runs the route analyzer and fails closed on a bad route", () => {
  const route = {
    id: "obs-1",
    legs: [
      {
        hop: 1,
        from: "SOL",
        to: "USDC",
        chain: "sol",
        venueChosen: "orca",
        usdPerOutUnit: 1 / 1e6,
        quotes: [
          { venue: "orca", amountIn: "5000000000", amountOut: "101950000" },
          { venue: "jupiter", amountIn: "5000000000", amountOut: "101951000" },
        ],
      },
    ],
  };
  const scan = observeRouteGap(route, { onLog: () => {} });
  assert.ok(scan && scan.analysis);
  assert.equal(observeRouteGap(null, { onLog: () => {} }), null, "a bad route fails closed to null");
});
