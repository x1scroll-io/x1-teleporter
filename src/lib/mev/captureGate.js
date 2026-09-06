/**
 * captureGate.js — the CAPTURE GATE + DETECTION-ONLY OBSERVATION PIPELINE
 * for the MEV/price-gap capture engine (src/lib/mev/).
 *
 * LAYERS (read in order):
 *   1. gapDetector.js        — pure gap math (no network, no txs). It never
 *                              returns a trade; it returns a DETECTION.
 *   2. THIS MODULE           — the gate (mirror of the WARP_LIVE_SEND flag
 *                              discipline) + the observation pipeline that
 *                              turns multi-DEX quotes into detections +
 *                              human reports ("capture opportunity: X bps
 *                              (gated OFF)").
 *   3. routePlanner.js       — the routing-layer hook: captureCandidatesForChain
 *                              (the same-chain venue lists) + planCaptureSwapPair
 *                              (the atomic capture-leg constructor that COMPOSES
 *                              two existing swap legs via composeRoute — see
 *                              src/engine/routePlanner.js).
 *   4. tools/simulate-mev-capture.mjs — the read-only SIMULATION harness:
 *                              real quotes against live pool state, quantified,
 *                              reported, ZERO trades (the deliverable proof).
 *
 * 🔴 HARD LIMITS (Mr. Esters — absolute, structural, not just a flag):
 *   - NO live trades. NO broadcasting funds. This module is detection +
 *     reporting; the capture EXECUTION path is dead-gated.
 *   - NO standalone bot. This is engine-integrated detection logic — it runs
 *     when the routing layer already has multi-DEX quotes on the wire.
 *   - Even when the gate is TRUE (v2 builds only — vite.config.js pins the
 *     env input, MEV_ARMED_BRANCHES = { "v2" }), the capture route COMPOSES
 *     the repo's existing swap legs (dexDirect / aggregator) and every one
 *     of those legs' submit() throws DexDirectLiveTestGateError — there is
 *     NO autonomous broadcast at any flag value. At TRUE the constructor may
 *     produce a signable capture artifact for Mr. Esters' wallet. The live
 *     arm/test is Mr. Esters' alone (the same discipline as WARP_LIVE_SEND).
 *
 * The gate flag is read from flags.ts (MEV_CAPTURE_ENABLED — env names
 * VITE_MEV_CAPTURE_ENABLED / NEXT_PUBLIC_FLAG_MEV_CAPTURE_ENABLED, default
 * FALSE; pinned false in the repo's main build by the vite define).
 */

import { MEV_CAPTURE_ENABLED } from "../flags.ts";
import { detectCaptureGap, CAPTURE_FEE_POLICY_BPS } from "./gapDetector.js";

/** The label every gated-off report carries. */
export const CAPTURE_GATE_LABEL = "gated OFF";

/** The gate's honest mode strings (the mode is never "live"). */
export const CAPTURE_GATE_MODES = Object.freeze({
  DETECTION_ONLY: "detection-only",
  ARMED_WALLET_SIGN_ONLY: "armed-wallet-sign-only",
});

/**
 * captureGate() — the current gate state.
 * @returns {{ enabled: boolean, mode: string, label: string,
 *             executable: boolean, note: string }}
 * executable is ALWAYS false — even when enabled, the capture path only
 * produces wallet-sign artifacts through the existing guarded swap legs.
 */
export function captureGate() {
  const enabled = MEV_CAPTURE_ENABLED === true;
  return {
    enabled,
    mode: enabled ? CAPTURE_GATE_MODES.ARMED_WALLET_SIGN_ONLY : CAPTURE_GATE_MODES.DETECTION_ONLY,
    label: enabled ? "armed (wallet-sign only)" : CAPTURE_GATE_LABEL,
    executable: false,
    note: enabled
      ? "MEV_CAPTURE_ENABLED=true: the engine may construct capture artifacts for Mr. Esters' wallet to " +
        "sign — the composed legs are the existing guarded swap legs (submit() throws DexDirectLiveTestGateError); " +
        "no autonomous broadcast exists at any flag value."
      : "MEV_CAPTURE_ENABLED=false (default): the detector RUNS read-only and reports what WOULD be capturable; " +
        "nothing is executable.",
  };
}

/** Thrown when code attempts to reach the capture EXECUTION path while the
 *  gate is closed (the default). Fail-closed by construction. */
export class CaptureGateClosedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaptureGateClosedError";
  }
}

/** The canonical gated-off message. */
export const CAPTURE_GATE_CLOSED_MESSAGE =
  "capture-execute: the MEV capture gate is CLOSED (MEV_CAPTURE_ENABLED=false — the repo's default and the " +
  "main-branch build). Detection runs read-only and reports 'capture opportunity: X bps (gated OFF)'; the " +
  "capture EXECUTION path is dead-gated and the live arm is Mr. Esters' alone (like WARP_LIVE_SEND).";

/**
 * assertCaptureGateOpen() — the execution-path guard. Throws
 * CaptureGateClosedError while the gate is closed (always in the repo's
 * main build). Even when it does NOT throw (armed v2 builds), the composed
 * route's legs still throw DexDirectLiveTestGateError on submit — wallet-
 * sign-only by structure.
 */
export function assertCaptureGateOpen() {
  if (MEV_CAPTURE_ENABLED !== true) {
    throw new CaptureGateClosedError(CAPTURE_GATE_CLOSED_MESSAGE);
  }
  return true;
}

/**
 * runCaptureScan — the observation pipeline (PURE OBSERVATION at every gate
 * state): given the same-pair same-chain BUY quotes (X→Y) and SELL quotes
 * (Y→X) the routing layer already fetched across the same-chain candidate
 * venues, run the gap detector and produce the capture report.
 *
 * When the gate is OFF (default) the report carries the honest
 * "capture opportunity: X bps (gated OFF)" line. When ON, the detection
 * math is identical — only the mode string changes — and the report still
 * carries executable:false.
 *
 * @param {object} args
 * @param {Array<object>} args.buyQuotes   X→Y quotes across venues
 * @param {Array<object>} args.sellQuotes  Y→X quotes across venues
 * @param {object} [args.pair]             { from, to } symbols
 * @param {string} [args.chain]            chain key
 * @param {string|number|bigint} [args.gasCostQuoteUnits] gas in X units
 * @param {number} [args.protocolFeeBps]   capture fee policy bps
 * @returns {{detection: object, gate: object, report: string}}
 */
export function runCaptureScan({ buyQuotes, sellQuotes, pair = null, chain = null, gasCostQuoteUnits = 0n, protocolFeeBps = CAPTURE_FEE_POLICY_BPS } = {}) {
  const detection = detectCaptureGap({ buyQuotes, sellQuotes, pair, chain, gasCostQuoteUnits, protocolFeeBps });
  const gate = captureGate();
  const gapTxt = detection.gapBps === null ? "no second venue quoted" : `${detection.gapBps} bps`;
  const line = detection.wouldCapture
    ? `capture opportunity: ${gapTxt} — ${detection.netRoundTripBps} bps net after costs (${gate.label})`
    : `capture scan: ${gapTxt} — ${detection.whyNot || "no capture"} (${gate.label})`;
  const report = `[mev-capture] ${chain ?? "?"} ${pair?.from ?? "?"}→${pair?.to ?? "?"}: ${line}`;
  return { detection, gate, report };
}

/**
 * formatCaptureReport — the human log line for a detection (the line the
 * engine prints when its routing pass observes a capturable gap).
 * @param {object} detection from detectCaptureGap
 * @returns {string}
 */
export function formatCaptureReport(detection) {
  if (!detection) return "[mev-capture] no detection";
  const where = [detection.chain, detection.pair ? `${detection.pair.from}→${detection.pair.to}` : null].filter(Boolean).join(" ");
  if (!detection.wouldCapture) {
    return `[mev-capture] ${where}: no capture (${detection.whyNot || "below threshold"})`;
  }
  return (
    `[mev-capture] ${where}: capture opportunity ${detection.gapBps} bps spread, ` +
    `${detection.netRoundTripBps} bps net after costs, route ${detection.route.join(" → ")} — ${CAPTURE_GATE_LABEL}`
  );
}
