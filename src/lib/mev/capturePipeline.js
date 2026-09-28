/**
 * capturePipeline.js — the MEV capture PIPELINE (the live-flow wiring).
 *
 * This is the seam the LIVE quote/execute flow calls after a route is quoted:
 * it OBSERVES the cross-venue gap on the quotes the routing layer already
 * holds, and — when a capture is detected — RECORDS the drop-as-is intent in
 * the capture ledger and ROUTES the accumulated pile through the batch-sweep
 * planner. It is the "quote → detect → record → sweep-plan" orchestrator the
 * capture engine was missing (the detector/gate/ledger/planner were all
 * built; nothing joined them in the flow).
 *
 * ── WHAT IT CAPTURES (and what it does NOT) ───────────────────────────────
 *   • IT CAPTURES the PRICE-IMPROVEMENT spread: the difference between the
 *     venue the engine would route and the BEST venue available for the same
 *     leg (the "capture gap" — gapDetector.js / routeAnalyzer.js). The engine
 *     executing at the better price and the protocol keeping the difference
 *     is legitimate price-improvement capture.
 *   • IT DOES NOT sandwich/frontrun the user's own order, and it NEVER touches
 *     the user's funds. The capture is the SPREAD across venues — a value that
 *     exists whether or not the user trades. Every function here is
 *     read-only w.r.t. the user's money path: it reads quote objects, writes
 *     ledger INTENT records, and returns plans. It constructs no user
 *     transaction and holds no keys.
 *
 * ── GATE + KILL SWITCH ────────────────────────────────────────────────────
 *   • The gate is MEV_CAPTURE_ENABLED (captureGate.js). ARMED (the real build
 *     default — see vite.config.js) → the pipeline records REAL drop-as-is
 *     detection records (source "detection") and plans the sweep.
 *   • UNARMED (the flag flipped off — the instant kill switch, or the
 *     `node --test` safety default) → the pipeline still RUNS detection
 *     read-only and records the SAME value as SANDBOX MEASUREMENT records
 *     (source "simulated", simulated:true) — the non-capture measurement
 *     fallback. Nothing is ever "live": even armed, the composed legs'
 *     submit() throws DexDirectLiveTestGateError and every sweep plan carries
 *     executable:false (no autonomous broadcast exists at any flag value).
 *
 * ── FAIL-CLOSED ───────────────────────────────────────────────────────────
 *   • Missing/short venue quotes → no detection, no records (honest report).
 *   • Gap too thin (wouldCapture false) → nothing recorded, nothing swept.
 *   • Unconfigured chain (no treasury) → the record is refused and surfaced
 *     on `skipped` (never silently dropped).
 *   • ANY error (planner, record validation, sweep) → caught; the pipeline
 *     returns { ok:false, reason } and logs — it NEVER throws into the money
 *     path and never jeopardizes the user's swap for a capture.
 *
 * ── PERSISTENCE ───────────────────────────────────────────────────────────
 * Pure/in-memory (src/ is bundled by Vite; node:fs would break the browser
 * build — same reason captureLedger.js is pure). The live flow holds a
 * session (createCapturePipeline / getLiveCaptureSession) that accumulates
 * the ledger across quotes; the documented JSON file contract (captureLedger
 * CAPTURE_LEDGER_FILE_CONTRACT) is the runtime persistence path when the
 * engine moves server-side.
 *
 * All amounts are RAW base units (integer strings/BigInt) — the engine-wide
 * money convention. No floating point on the money path.
 */

import {
  captureGate,
  runCaptureScan,
  runRouteCaptureScan,
  formatCaptureReport,
  formatRouteCaptureReport,
  capturePayoutForChain,
  dropAsIsRecords,
} from "./captureGate.js";
import { emptyLedger, recordCaptures, summarizeLedger } from "./captureLedger.js";
import { planSweeps } from "./sweepPlanner.js";
import { DEFAULT_MEV_PAYOUT_CONFIG } from "./payoutConfig.js";

/** The pipeline's two modes (never "live"). */
export const CAPTURE_PIPELINE_MODES = Object.freeze({
  /** MEV_CAPTURE_ENABLED=true — real drop-as-is detection records + sweep plan. */
  CAPTURE: "capture",
  /** MEV_CAPTURE_ENABLED=false — read-only sandbox-measurement fallback. */
  MEASUREMENT: "measurement",
});

/**
 * runCapturePipeline — the one-call orchestrator. Given the quotes (or a
 * pre-built scan) the live flow holds, run detection, record the
 * drop-as-is intent, and plan the sweep. FAIL-CLOSED: never throws.
 *
 * Inputs (any ONE of the detection sources, in priority order):
 *   • scan     — a ready runCaptureScan/runRouteCaptureScan result
 *   • detection— a raw same-pair detection (gapDetector.detectCaptureGap)
 *   • analysis — a raw multi-hop route analysis (routeAnalyzer.analyzeRoute)
 *   • route    — a multi-hop route to analyze (observeRouteCapture shape)
 *   • buyQuotes + sellQuotes — the same-pair venue quotes to scan directly
 *   • buy/sell — (with `pair`) explicit side specs for the artifact path
 *
 * @param {object} args { scan?, detection?, analysis?, route?, buyQuotes?,
 *   sellQuotes?, pair?, chain?, gasCostQuoteUnits?, ledgerState?, config?,
 *   planSweep? (default true), onLog? }
 * @returns {{ok: boolean, armed: boolean, mode: string, gate: object,
 *   detected: boolean, records: object[], skipped: object[],
 *   ledgerState: object, sweep: object|null, report: string|null,
 *   reason: string|null}}
 */
export function runCapturePipeline({
  scan = null,
  detection = null,
  analysis = null,
  route = null,
  buyQuotes = null,
  sellQuotes = null,
  pair = null,
  chain = null,
  gasCostQuoteUnits = 0n,
  ledgerState = null,
  config = DEFAULT_MEV_PAYOUT_CONFIG,
  planSweep = true,
  onLog = () => {},
} = {}) {
  const gate = captureGate();
  const armed = gate.enabled === true;
  const mode = armed ? CAPTURE_PIPELINE_MODES.CAPTURE : CAPTURE_PIPELINE_MODES.MEASUREMENT;

  const result = {
    ok: true,
    armed,
    mode,
    gate,
    detected: false,
    records: [],
    skipped: [],
    ledgerState: ledgerState ?? emptyLedger(),
    sweep: null,
    report: null,
    reason: null,
  };

  try {
    // ── 1. OBSERVE (pure detection — runs at every gate state) ──────────────
    let scanResult = scan;
    if (!scanResult) {
      if (detection) {
        scanResult = {
          detection,
          gate,
          report: formatCaptureReport(detection),
          payout: capturePayoutForChain(chain ?? detection.chain, config),
        };
      } else if (analysis) {
        scanResult = { analysis, gate, report: formatRouteCaptureReport(analysis), payouts: null };
      } else if (route) {
        scanResult = runRouteCaptureScan(route);
      } else if (Array.isArray(buyQuotes) && buyQuotes.length > 0 && Array.isArray(sellQuotes) && sellQuotes.length > 0) {
        scanResult = runCaptureScan({ buyQuotes, sellQuotes, pair, chain, gasCostQuoteUnits });
      } else {
        result.ok = false;
        result.reason = "no quotes/route provided to observe";
        onLog(`[mev-pipeline] skipped: ${result.reason}`);
        return result;
      }
    }

    result.report = scanResult.report ?? null;
    if (result.report) onLog(result.report);

    const wouldCapture = scanResult.detection
      ? scanResult.detection.wouldCapture === true
      : scanResult.analysis?.wouldCapture === true;
    result.detected = wouldCapture;

    // Gap too thin / no capture → nothing to record, nothing to sweep. This is
    // the fail-closed "don't invent a capture" path.
    if (!wouldCapture) return result;

    // ── 2. RECORD (drop-as-is intent → capture ledger) ──────────────────────
    // ARMED → real detection records. UNARMED → the sandbox measurement
    // fallback (the same value, recorded as measurement — never "live").
    const recordOpts = armed
      ? { source: "detection", simulated: false, test: false, config }
      : { source: "simulated", simulated: true, test: false, config };

    const { records, skipped } = dropAsIsRecords(scanResult, recordOpts);
    result.skipped = skipped;
    if (records.length === 0) {
      onLog("[mev-pipeline] capture detected but no recordable drop-as-is value (see skipped)");
      return result;
    }

    const appended = recordCaptures(result.ledgerState, records);
    result.ledgerState = appended.state;
    result.records = appended.records;
    onLog(`[mev-pipeline] recorded ${records.length} drop-as-is capture record(s) [${mode}]`);

    // ── 3. SWEEP (route the accumulated pile through the batch planner) ─────
    if (planSweep) {
      const bundle = planSweeps({ ledgerState: result.ledgerState, config });
      result.sweep = bundle;
      for (const plan of bundle.plans) {
        if (plan.wouldSweep) {
          onLog(
            `[mev-pipeline] sweep planned: ${plan.id} (chain ${plan.chain}, ${plan.steps.length} step(s), ` +
              `executable:false — signable artifacts only)`,
          );
        }
      }
    }

    return result;
  } catch (e) {
    // FAIL-CLOSED: a capture-pipeline failure must NEVER break the user's
    // swap. Swallow → report → move on.
    result.ok = false;
    result.reason = e?.message ?? String(e);
    onLog(`[mev-pipeline] skipped (${result.reason})`);
    return result;
  }
}

/**
 * createCapturePipeline — a stateful session that accumulates the in-memory
 * capture ledger across quotes and re-plans the sweep after each capture.
 * This is the handle the LIVE flow holds (one per engine/console instance).
 *
 * @param {object} [opts] { config?, onLog? }
 * @returns {{process: (args:object)=>object, reset: ()=>void,
 *   ledgerState: object, summarize: ()=>object}}
 */
export function createCapturePipeline({ config = DEFAULT_MEV_PAYOUT_CONFIG, onLog = () => {} } = {}) {
  let state = emptyLedger();
  return {
    get ledgerState() {
      return state;
    },
    process(args = {}) {
      const r = runCapturePipeline({ ...args, config, onLog: args.onLog ?? onLog, ledgerState: state });
      state = r.ledgerState;
      return r;
    },
    reset() {
      state = emptyLedger();
    },
    summarize() {
      return summarizeLedger(state);
    },
  };
}

/** The process-wide live session (lazily created). The live quote flow uses
 *  this so captures accumulate across a user's session. */
let LIVE_SESSION = null;
export function getLiveCaptureSession({ config = DEFAULT_MEV_PAYOUT_CONFIG, onLog } = {}) {
  if (!LIVE_SESSION) {
    LIVE_SESSION = createCapturePipeline({
      config,
      onLog:
        onLog ??
        ((line) => {
          try {
            console.debug(line);
          } catch {
            /* logging must never throw */
          }
        }),
    });
  }
  return LIVE_SESSION;
}
