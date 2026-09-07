/**
 * captureGate.js — the CAPTURE GATE + DETECTION-ONLY OBSERVATION PIPELINE
 * for the MEV/price-gap capture engine (src/lib/mev/).
 *
 * LAYERS (read in order):
 *   1. gapDetector.js        — pure gap math (no network, no txs). It never
 *                              returns a trade; it returns a DETECTION.
 *   1b. routeAnalyzer.js     — the MULTI-HOP route-choice analyzer (pure):
 *                              per-hop venue deltas (best venue vs routed
 *                              venue) accumulated across a whole journey —
 *                              the framing correction: real MEV is
 *                              DISTRIBUTED over multi-hop routes to volatile
 *                              destinations, not same-pair round trips.
 *   2. THIS MODULE           — the gate (mirror of the WARP_LIVE_SEND flag
 *                              discipline) + the observation pipelines:
 *                              runCaptureScan (same-pair round trip →
 *                              "capture opportunity: X bps (gated OFF)") and
 *                              runRouteCaptureScan (multi-hop route choice →
 *                              "route capture opportunity: X bps across N
 *                              hops (gated OFF)").
 *   3. routePlanner.js       — the routing-layer hook: captureCandidatesForChain
 *                              (the same-chain venue lists) + planCaptureSwapPair
 *                              (the atomic capture-leg constructor that COMPOSES
 *                              two existing swap legs via composeRoute — see
 *                              src/engine/routePlanner.js) + observeRouteCapture
 *                              (the multi-hop hook) + planCaptureRouteJourney
 *                              (the optimal-sub-path constructor).
 *   4. tools/simulate-mev-capture.mjs / tools/simulate-mev-multihop.mjs —
 *                              the read-only SIMULATION harnesses:
 *                              real quotes against live pool state, quantified,
 *                              reported, ZERO trades (the deliverable proofs).
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
import { analyzeRoute } from "./routeAnalyzer.js";
import { DEFAULT_MEV_PAYOUT_CONFIG, treasuryForChain, payoutGroupForChain, MEV_PAYOUT_DEPOSIT_ONLY_NOTE } from "./payoutConfig.js";
import { createCaptureRecord } from "./captureLedger.js";

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
 * carries executable:false. The result ALSO carries `payout` — the
 * drop-as-is deposit destination (the treasury design — payoutConfig.js)
 * so every observation records WHERE the capture would drop. Pure
 * annotation; nothing here moves funds.
 *
 * @param {object} args
 * @param {Array<object>} args.buyQuotes   X→Y quotes across venues
 * @param {Array<object>} args.sellQuotes  Y→X quotes across venues
 * @param {object} [args.pair]             { from, to } symbols
 * @param {string} [args.chain]            chain key
 * @param {string|number|bigint} [args.gasCostQuoteUnits] gas in X units
 * @param {number} [args.protocolFeeBps]   capture fee policy bps
 * @returns {{detection: object, gate: object, report: string,
 *            payout: object|null}}
 */
export function runCaptureScan({ buyQuotes, sellQuotes, pair = null, chain = null, gasCostQuoteUnits = 0n, protocolFeeBps = CAPTURE_FEE_POLICY_BPS } = {}) {
  const detection = detectCaptureGap({ buyQuotes, sellQuotes, pair, chain, gasCostQuoteUnits, protocolFeeBps });
  const gate = captureGate();
  const gapTxt = detection.gapBps === null ? "no second venue quoted" : `${detection.gapBps} bps`;
  const line = detection.wouldCapture
    ? `capture opportunity: ${gapTxt} — ${detection.netRoundTripBps} bps net after costs (${gate.label})`
    : `capture scan: ${gapTxt} — ${detection.whyNot || "no capture"} (${gate.label})`;
  const report = `[mev-capture] ${chain ?? "?"} ${pair?.from ?? "?"}→${pair?.to ?? "?"}: ${line}`;
  return { detection, gate, report, payout: capturePayoutForChain(chain) };
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

// ── MULTI-HOP ROUTE-CHOICE CAPTURE (the framing correction — 2026-09-06) ──
//
// The single same-pair ROUND-TRIP model (runCaptureScan above) proved ~0 on
// deep stable pairs — a round trip pays two pool fees + two gas bills. The
// multi-hop model (routeAnalyzer.js) measures the ONE-WAY ROUTE-CHOICE value
// distributed across a whole journey: every hop has a venue CHOICE (which
// DEX / aggregator / bridge), and the delta between the venue the engine
// routed and the BEST venue for that hop is capturable per hop, accumulated
// across the journey — concentrated on the APING flow (any-to-any routes
// ending at volatile/exotic destinations). runRouteCaptureScan is the
// observation pipeline for that model — PURE OBSERVATION at every gate
// state, same discipline as runCaptureScan: gated OFF (default) → the line
// "route capture opportunity: X bps across N hops (gated OFF)".

/** The label every gated-off route report carries. */
export const ROUTE_CAPTURE_GATE_LABEL = CAPTURE_GATE_LABEL; // "gated OFF"

/**
 * runRouteCaptureScan — the multi-hop observation pipeline (PURE
 * OBSERVATION at every gate state): given a planned multi-hop route with
 * per-leg venue quotes (the routing layer already fetched them across the
 * venue candidates), run the route analyzer and produce the capture report.
 *
 * When the gate is OFF (default) the report carries the honest
 * "route capture opportunity: X bps across N hops (gated OFF)" line. When
 * ON, the analysis math is identical — only the mode string changes — and
 * the report still carries executable:false.
 *
 * @param {object} route the analyzed route { id, legs: [{hop, from, to,
 *   chain?, kind?, venueChosen, quotes, usdPerOutUnit?}] } — see
 *   routeAnalyzer.analyzeRoute
 * @returns {{analysis: object, gate: object, report: string,
 *            payouts: object|null}} `payouts` maps each distinct leg chain
 *   to its drop-as-is destination ({group, address}) — a multi-hop journey
 *   spans chains, so the per-capture destinations follow each leg (see
 *   dropAsIsRecords). Pure annotation; nothing here moves funds.
 */
export function runRouteCaptureScan(route) {
  const analysis = analyzeRoute(route);
  const gate = captureGate();
  const nHops = analysis.legs.length;
  const gapTxt = analysis.routeGapBps === null ? "no usd-converted gap" : `${analysis.routeGapBps} bps`;
  const usdTxt = analysis.routeNetUsd === null ? "" : ` / $${analysis.routeNetUsd} net`;
  const line = analysis.wouldCapture
    ? `route capture opportunity: ${gapTxt}${usdTxt} across ${nHops} hops (${gate.label})`
    : `route capture scan: ${analysis.whyNot || "no capture"} (${gate.label})`;
  const report = `[mev-route-capture] ${analysis.routeId ?? "?"}: ${line}`;
  const legChains = [...new Set((analysis.legs || []).map((l) => l.chain).filter(Boolean))];
  const payouts = legChains.length
    ? Object.freeze(Object.fromEntries(legChains.map((c) => [c, capturePayoutForChain(c)]).filter(([, p]) => p)))
    : null;
  return { analysis, gate, report, payouts };
}

/**
 * formatRouteCaptureReport — the human log line for a route analysis (the
 * line the engine prints when its routing pass observes a capturable
 * multi-hop route).
 * @param {object} analysis from analyzeRoute
 * @returns {string}
 */
export function formatRouteCaptureReport(analysis) {
  if (!analysis) return "[mev-route-capture] no analysis";
  const id = analysis.routeId ?? "?";
  if (!analysis.wouldCapture) {
    return `[mev-route-capture] ${id}: no capture (${analysis.whyNot || "below threshold"})`;
  }
  const bpsTxt = analysis.routeGapBps === null ? "?" : `${analysis.routeGapBps} bps`;
  const usdTxt = analysis.routeNetUsd === null ? "" : ` / $${analysis.routeNetUsd} net`;
  const opt = analysis.optimalRoute.map((o) => o.venue).join(" → ");
  return (
    `[mev-route-capture] ${id}: route capture opportunity ${bpsTxt}${usdTxt} across ${analysis.legs.length} hops, ` +
    `optimal sub-path ${opt} — ${ROUTE_CAPTURE_GATE_LABEL}`
  );
}

// ── PAYOUT + DROP-AS-IS (the treasury design — 2026-09-07) ──────────────────
//
// Mr. Esters' treasury design (docs/MEV-PAYOUT.md, payoutConfig.js): every
// capture is deposited AS-IS into its chain's treasury address (drop-as-is,
// minimal gas per capture) and piles up until the ONE batched sweep per
// period converts it to the SOL/wBTC/wETH/USDC basket. THIS SECTION wires
// the observation pipelines to that design — PURELY:
//
//   1. capturePayoutForChain(chain) — the drop-as-is DESTINATION for a
//      chain (the payout config's treasury). Both scan pipelines already
//      carry it (runCaptureScan → `payout`; runRouteCaptureScan →
//      `payouts` per distinct leg chain).
//   2. dropAsIsRecords(scanResult, {source, simulated, test}) — the
//      MEASURE/VERIFY bridge: turns a scan result into the captureLedger
//      record DRAFTS (the drop-as-is intent records) the sandbox
//      measurement tool + the exotic-route tests persist — marked
//      simulated/test there. Gated OFF (default) these are measurement
//      only; the actual deposit is a future ARMED action (signable
//      artifacts only — DexDirectLiveTestGateError discipline).
//
// 🔴 The boundary is structural: these functions annotate and record
// INTENT. They construct no transactions, broadcast nothing, and hold no
// treasury keys. Deposit + sweep = Mr. Esters' arm alone.

/**
 * capturePayoutForChain — the drop-as-is deposit destination for a chain
 * (the payout config's per-chain treasury map — payoutConfig.js). Null for
 * chains the payout map does not cover (a capture there cannot drop
 * anywhere; the ledger record builder fails closed on it).
 *
 * @param {string|null} chain canonical chain key
 * @param {object} [config] payout config (default DEFAULT_MEV_PAYOUT_CONFIG)
 * @returns {object|null} { chain, group, address, dropAsIs: true,
 *   depositOnly: true, note } or null
 */
export function capturePayoutForChain(chain, config = DEFAULT_MEV_PAYOUT_CONFIG) {
  if (!chain) return null;
  const address = treasuryForChain(config, chain);
  if (!address) return null;
  return Object.freeze({
    chain,
    group: payoutGroupForChain(config, chain),
    address,
    dropAsIs: true,
    depositOnly: true,
    note: MEV_PAYOUT_DEPOSIT_ONLY_NOTE,
  });
}

/**
 * dropAsIsRecords — the MEASURE/VERIFY bridge from a scan result to the
 * capture ledger's drop-as-is record DRAFTS.
 *
 * Given a scan result (runCaptureScan's same-pair shape — it carries
 * `detection` — or runRouteCaptureScan's multi-hop shape — it carries
 * `analysis`), produce the captureLedger records that WOULD be recorded:
 *
 *   - same-pair capture: ONE record — the net round-trip capture in the
 *     pair's FROM token (the token that drops as-is), amountRaw =
 *     netValueAfterCostsRaw (the actual positive capture after gas/costs).
 *   - multi-hop route capture: ONE record PER LEG with a positive
 *     best-venue improvement (deltaOutRaw > 0) — the leg's TO token on the
 *     leg's own chain (where the route-choice value accrues). Legs without
 *     a chain (bridge legs) are SKIPPED with a reason — the value accrues
 *     on a leg destination this scan cannot attribute chain-locally.
 *
 * Each draft is validated through captureLedger.createCaptureRecord's
 * rules (chain-configured treasury required unless explicitly a sandbox
 * measurement). Recording = journaling INTENT — no funds move (see the
 * ledger header).
 *
 * @param {object} scanResult from runCaptureScan / runRouteCaptureScan
 * @param {object} [opts]
 * @param {string} [opts.source] "detection" | "simulated" | "test"
 *   (default "detection")
 * @param {boolean} [opts.simulated] mark the records simulated (sandbox
 *   measurement — default false)
 * @param {boolean} [opts.test] mark the records test-fleet (default false)
 * @param {object} [opts.config] payout config
 * @returns {{records: object[], skipped: object[]}} records = validated
 *   captureLedger record drafts; skipped = {reason, hop?} for value the
 *   scan found but could not attribute to a drop-as-is destination
 */
export function dropAsIsRecords(scanResult, { source = "detection", simulated = false, test = false, config = DEFAULT_MEV_PAYOUT_CONFIG } = {}) {
  if (!scanResult || typeof scanResult !== "object") throw new Error("captureGate.dropAsIsRecords: a scan result is required");
  const records = [];
  const skipped = [];

  if (scanResult.detection) {
    const d = scanResult.detection;
    if (d.wouldCapture && BigInt(d.netValueAfterCostsRaw ?? 0) > 0n) {
      const token = d.pair?.from ?? null;
      if (!token) {
        skipped.push({ reason: "same-pair capture with no pair.from token — nothing identifiable drops as-is" });
      } else {
        const rec = createCaptureLedgerRecord(
          {
            chain: d.chain,
            token,
            tokenAddress: null,
            amountRaw: d.netValueAfterCostsRaw,
            source,
            simulated,
            test,
            config,
            evidence: {
              kind: "same-pair-cross-venue",
              pair: d.pair ? `${d.pair.from}→${d.pair.to}` : null,
              gapBps: d.gapBps,
              grossRoundTripBps: d.grossRoundTripBps,
              netRoundTripBps: d.netRoundTripBps,
              route: d.route,
              exact: d.exact,
            },
          },
          skipped,
        );
        if (rec) records.push(rec);
      }
    }
    return { records, skipped };
  }

  if (scanResult.analysis) {
    const a = scanResult.analysis;
    for (const leg of a.legs || []) {
      if (leg.singleVenue || BigInt(leg.deltaOutRaw ?? 0) <= 0n) continue; // no venue choice / no improvement
      if (!leg.chain) {
        skipped.push({
          hop: leg.hop,
          reason: `leg ${leg.hop} (${leg.from ?? "?"}→${leg.to ?? "?"}) improved ${leg.deltaOutRaw} raw but carries no chain — the value accrues on a leg destination this scan cannot attribute chain-locally`,
        });
        continue;
      }
      const rec = createCaptureLedgerRecord(
        {
          chain: leg.chain,
          token: leg.to,
          tokenAddress: null,
          amountRaw: leg.deltaOutRaw,
          source,
          simulated,
          test,
          config,
          evidence: {
            kind: "multi-hop-route-choice",
            routeId: a.routeId,
            hop: leg.hop,
            from: leg.from,
            to: leg.to,
            venueChosen: leg.venueChosen,
            venueBest: leg.venueBest,
            gapBps: leg.gapBps,
            netUsd: leg.netUsd,
            routeNetUsd: a.routeNetUsd,
          },
        },
        skipped,
      );
      if (rec) records.push(rec);
    }
    return { records, skipped };
  }

  throw new Error("captureGate.dropAsIsRecords: the scan result must carry `detection` (runCaptureScan) or `analysis` (runRouteCaptureScan)");
}

/** The ledger-record factory used by dropAsIsRecords (fail-closed on
 *  unconfigured chains unless the record is an explicit sandbox
 *  measurement). Returns the record, or null after pushing the skip reason
 *  (a record that cannot drop anywhere is never silently dropped — it is
 *  surfaced on the skipped list). */
function createCaptureLedgerRecord(input, skipped) {
  try {
    return createCaptureRecord(input);
  } catch (err) {
    skipped.push({ reason: err.message, input: { chain: input.chain, token: input.token, amountRaw: input.amountRaw } });
    return null;
  }
}
