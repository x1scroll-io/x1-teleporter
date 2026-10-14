/**
 * observe.js — the READ-ONLY observation seam (fail-closed) for the MEV
 * capture engine.
 *
 * Mirrors the wallet's src/lib/mev/observe.js: the capture engine runs
 * ALONGSIDE the swap flow — it never changes the user's trade and never
 * broadcasts. This is the one entry point the routing layer calls to
 * observe a venue gap on quotes it already holds. It is gated (captureGate)
 * but the DETECTION math runs at every gate state; a scan failure NEVER
 * throws into the money path — it returns null and logs.
 *
 * 🔴 BOUNDARY: pure observation. No transactions, no funds, no broadcast.
 * The user's money path is untouched by construction (this function only
 * reads the quote objects it is handed).
 */

import { runCaptureScan, runRouteCaptureScan } from "./captureGate.js";

/**
 * observeCaptureGap — observe a same-pair cross-venue capture gap on quotes
 * the routing layer already fetched. Pure observation; never throws into
 * the money path (returns null on any error).
 *
 * @param {object} args
 * @param {Array<object>} args.buyQuotes   X→Y quotes across venues
 * @param {Array<object>} args.sellQuotes  Y→X quotes across venues
 * @param {object} [args.pair]             { from, to } symbols
 * @param {string} [args.chain]            chain key
 * @param {number|bigint} [args.gasCostQuoteUnits] gas in X base units
 * @param {(line:string)=>void} [args.onLog]  where the report line goes
 * @returns {object|null} the scan { detection, gate, report, payout } or null
 */
export function observeCaptureGap({ buyQuotes, sellQuotes, pair = null, chain = null, gasCostQuoteUnits = 0n, onLog = () => {} } = {}) {
  try {
    const scan = runCaptureScan({ buyQuotes, sellQuotes, pair, chain, gasCostQuoteUnits });
    onLog(scan.report);
    return scan;
  } catch (e) {
    // observation is best-effort — a scan failure must never break the swap.
    onLog(`[mev-capture] ${chain ?? "?"} ${pair?.from ?? "?"}→${pair?.to ?? "?"}: scan skipped (${e?.message ?? String(e)})`);
    return null;
  }
}

/**
 * observeRouteGap — observe a multi-hop route-choice capture gap on a planned
 * route whose legs carry per-venue quotes. Pure observation; never throws
 * into the money path (returns null on any error).
 *
 * @param {object} route the analyzed route shape (see routeAnalyzer.analyzeRoute)
 * @param {object} [opts] { onLog }
 * @returns {object|null} the scan { analysis, gate, report, payouts } or null
 */
export function observeRouteGap(route, { onLog = () => {} } = {}) {
  try {
    const scan = runRouteCaptureScan(route);
    onLog(scan.report);
    return scan;
  } catch (e) {
    onLog(`[mev-route-capture] ${route?.id ?? "?"}: scan skipped (${e?.message ?? String(e)})`);
    return null;
  }
}
