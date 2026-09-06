/**
 * captureGate.test.js — the MEV capture GATE tests.
 *
 * Spec: the gate mirrors WARP_LIVE_SEND — MEV_CAPTURE_ENABLED, DEFAULT
 * FALSE. When false: the detector RUNS (read-only, quantifies, logs) but
 * nothing is executable — the engine reports "capture opportunity: X bps
 * (gated OFF)". The execution guard throws while the gate is closed, and
 * even an ARMED gate is wallet-sign-only by structure (the composed legs'
 * submit() throws DexDirectLiveTestGateError — asserted here through the
 * real planner legs in test/mevCapture.test.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureGate,
  runCaptureScan,
  formatCaptureReport,
  assertCaptureGateOpen,
  CaptureGateClosedError,
  CAPTURE_GATE_CLOSED_MESSAGE,
  CAPTURE_GATE_MODES,
} from "./captureGate.js";
import { MEV_CAPTURE_ENABLED, resolveFlags } from "../flags.ts";

test("capture gate: MEV_CAPTURE_ENABLED defaults to FALSE (singleton + resolver)", () => {
  assert.equal(MEV_CAPTURE_ENABLED, false, "no env vars under node --test → the safety default");
  assert.equal(resolveFlags({}).MEV_CAPTURE_ENABLED, false);
  assert.equal(resolveFlags({ VITE_WARP_LIVE_SEND: "true" }).MEV_CAPTURE_ENABLED, false, "independent of WARP");
});

test("capture gate: the flag resolves from the VITE_ and NEXT_PUBLIC_ names", () => {
  assert.equal(resolveFlags({ VITE_MEV_CAPTURE_ENABLED: "true" }).MEV_CAPTURE_ENABLED, true);
  assert.equal(resolveFlags({ VITE_MEV_CAPTURE_ENABLED: "1" }).MEV_CAPTURE_ENABLED, true);
  assert.equal(resolveFlags({ NEXT_PUBLIC_FLAG_MEV_CAPTURE_ENABLED: "true" }).MEV_CAPTURE_ENABLED, true);
  assert.equal(resolveFlags({ NEXT_PUBLIC_FLAG_MEV_CAPTURE_ENABLED: "true", VITE_MEV_CAPTURE_ENABLED: "false" }).MEV_CAPTURE_ENABLED, true, "NEXT_PUBLIC_ wins");
});

test("capture gate: gated OFF (default) → detection-only mode, never executable", () => {
  const gate = captureGate();
  assert.equal(gate.enabled, false);
  assert.equal(gate.mode, CAPTURE_GATE_MODES.DETECTION_ONLY);
  assert.equal(gate.label, "gated OFF");
  assert.equal(gate.executable, false, "executable is ALWAYS false — structural, not flag-dependent");
  assert.match(gate.note, /MEV_CAPTURE_ENABLED=false/);
});

test("capture gate: the execution guard throws CaptureGateClosedError while closed", () => {
  assert.throws(
    () => assertCaptureGateOpen(),
    (e) => {
      assert.ok(e instanceof CaptureGateClosedError);
      assert.match(e.message, /gate is CLOSED/);
      assert.match(e.message, /Mr. Esters' alone/);
      return true;
    },
  );
  assert.match(CAPTURE_GATE_CLOSED_MESSAGE, /dead-gated/);
});

test("capture gate: runCaptureScan RUNS the detector while gated OFF and reports the honest line", () => {
  const buyQuotes = [
    { dex: "orca", amountIn: "1000000000", amountOut: "130000000" },
    { dex: "raydium", amountIn: "1000000000", amountOut: "129900000" },
  ];
  const sellQuotes = [
    { dex: "orca", amountIn: "130000000", amountOut: "1001000000" },
    { dex: "raydium", amountIn: "130000000", amountOut: "1000500000" },
  ];
  const { detection, gate, report } = runCaptureScan({ chain: "sol", pair: { from: "SOL", to: "USDC" }, buyQuotes, sellQuotes });
  assert.equal(detection.wouldCapture, true, "the detector quantifies even while gated off");
  assert.ok(detection.gapBps > 0);
  assert.equal(gate.label, "gated OFF");
  assert.match(report, /capture opportunity: \d+ bps/);
  assert.match(report, /gated OFF/);
  assert.equal(detection.route.length, 2);
  assert.equal(typeof detection.netValueAfterCostsRaw, "string");
});

test("capture gate: a scan with no real gap reports the honest no-capture line", () => {
  const buyQuotes = [{ dex: "orca", amountIn: "1000000000", amountOut: "130000000" }];
  const sellQuotes = [{ dex: "orca", amountIn: "130000000", amountOut: "998000000" }];
  const { detection, report } = runCaptureScan({ chain: "sol", pair: { from: "SOL", to: "USDC" }, buyQuotes, sellQuotes });
  assert.equal(detection.wouldCapture, false);
  assert.equal(detection.gapBps, null);
  assert.match(report, /no second venue quoted/);
  assert.match(report, /gated OFF/);
});

test("capture gate: formatCaptureReport renders the gated-off opportunity line for logs", () => {
  const buyQuotes = [
    { dex: "a", amountIn: "1000000", amountOut: "1001000" },
    { dex: "b", amountIn: "1000000", amountOut: "999000" },
  ];
  const sellQuotes = [
    { dex: "a", amountIn: "1001000", amountOut: "998000" },
    { dex: "b", amountIn: "1001000", amountOut: "1002000" },
  ];
  const { detection } = runCaptureScan({ chain: "arb", pair: { from: "USDC", to: "USDT" }, buyQuotes, sellQuotes });
  const line = formatCaptureReport(detection);
  assert.match(line, /capture opportunity \d+ bps spread/);
  assert.match(line, /gated OFF/);
  assert.match(line, /arb USDC→USDT/);
  // A no-capture detection renders its whyNot:
  const { detection: none } = runCaptureScan({ chain: "eth", pair: { from: "USDC", to: "USDT" }, buyQuotes: [{ dex: "a", amountIn: "1", amountOut: "1" }], sellQuotes: [{ dex: "a", amountIn: "1", amountOut: "1" }] });
  assert.match(formatCaptureReport(none), /no capture/);
});

test("capture gate: bad inputs fail closed through the scan (no silent detection)", () => {
  assert.throws(() => runCaptureScan({ buyQuotes: [], sellQuotes: [] }), /buyQuotes are required/);
  assert.throws(() => runCaptureScan({ buyQuotes: [{ dex: "a", amountIn: "1", amountOut: "1" }], sellQuotes: [{ dex: "b", amountIn: "0", amountOut: "1" }] }), /non-positive amountIn/);
});
