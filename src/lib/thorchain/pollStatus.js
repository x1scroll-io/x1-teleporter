/**
 * pollStatus.js — the THORChain tx-status polling state machine (Step 3.1,
 * the hop stage of the THORChain lane).
 *
 * docs/BRIEF.md (Workstream A — Panel 2): poll `/thorchain/tx/status/{inboundTxid}`
 * every 15s, max 90 min, stages `observed → swapping → outbound_signed → done`.
 *
 * DESIGN (pure + dependency-injected so the whole machine is unit-testable
 * without a browser, a network, or fake timers):
 *   - `fetchImpl`: the fetch function (default: global fetch). Tests inject a
 *     mock endpoint.
 *   - `parseResponse`: defaults to parseTxStatusResponse() from
 *     statusEndpoint.js. Tests may inject a stricter/looser parser.
 *   - `schedule(fn, ms)`: the timer seam. Defaults to setTimeout/clearTimeout.
 *     Tests inject a manual scheduler and drive ticks by hand — the 15s
 *     interval and the 90-minute cap are asserted WITHOUT real waiting.
 *   - `now()`: clock seam for the max-duration check.
 *
 * BEHAVIOUR:
 *   - Polls immediately on start(), then every `intervalMs` (default 15s),
 *     never overlapping (the next poll is scheduled after the current one
 *     settles).
 *   - not-found → silently retry (the tx has not been observed yet).
 *   - halted/paused → `onHalted()` (the UI shows "paused by THORChain") and
 *     KEEPS polling — a chain can un-halt within the window.
 *   - error → `onError(message)` and KEEPS polling within the max window.
 *   - stage change → `onStage(stage)`; the caller persists `{inboundTxid, stage}`.
 *     The callback fires ONLY on a change (not on every poll), so resuming
 *     from a persisted stage does not re-fire the same stage.
 *   - `done` → `onStage("done")` + `onDone()` and polling stops.
 *   - max window exceeded → `onTimeout()` and polling stops. (The persisted
 *     {inboundTxid, stage} entry stays in storage, so a later visit can resume.)
 *   - `stop()` cancels any scheduled poll and marks the poller stopped.
 *   - `tickNow()` — test hook: force one poll cycle immediately.
 *
 * PURE MODULE: no DOM, no wallet, no window. Runnable under `node --test`.
 */

import {
  THORCHAIN_STAGES,
  parseTxStatusResponse,
  statusUrl,
  THORCHAIN_STATUS_BASE_URL,
} from "./statusEndpoint.js";

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_MAX_POLL_MS = 90 * 60 * 1000; // 90 minutes

/** Default timer seam — real setTimeout/clearTimeout. */
function defaultSchedule(fn, ms) {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/**
 * Create a THORChain status poller.
 *
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] fetch implementation (default: global fetch)
 * @param {string} [deps.baseUrl] status API base URL (default: THORCHAIN_STATUS_BASE_URL)
 * @param {number} [deps.intervalMs] poll interval (default: 15s)
 * @param {number} [deps.maxMs] max total polling window (default: 90 min)
 * @param {(json:unknown, meta?:object) => object} [deps.parseResponse]
 * @param {(fn:()=>void, ms:number) => () => void} [deps.schedule]
 * @param {() => number} [deps.now] clock seam (default: Date.now)
 * @returns {{start:Function, stop:Function, tickNow:Function, isRunning:() => boolean}}
 */
export function createThorchainStatusPoller(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? THORCHAIN_STATUS_BASE_URL;
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxMs = deps.maxMs ?? DEFAULT_MAX_POLL_MS;
  const parseResponse = deps.parseResponse ?? parseTxStatusResponse;
  const schedule = deps.schedule ?? defaultSchedule;
  const now = deps.now ?? Date.now;

  let running = false;
  let cancelled = false;
  let cancelScheduled = null;
  let inFlight = false;
  let startedAt = 0;
  let lastStage = null;
  let consecutiveErrors = 0;

  /** Options captured at start() — the poller is single-flight. */
  let opts = {};

  /** One poll cycle: fetch → parse → dispatch callbacks → schedule next. */
  async function tick() {
    if (!running || cancelled || inFlight) return;
    inFlight = true;
    try {
      const url = statusUrl(baseUrl, opts.inboundTxid);
      let res;
      try {
        res = await fetchImpl(url);
      } catch (e) {
        // Network-level failure — surface it and keep polling within max.
        consecutiveErrors += 1;
        opts.onError?.(`status endpoint unreachable: ${e?.message || String(e)}`);
        scheduleNext();
        return;
      }

      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      const parsed = parseResponse(json, { status: res?.status });

      if (!parsed.ok) {
        if (parsed.reason === "not-found") {
          // Not observed yet — silent retry.
          consecutiveErrors = 0;
          scheduleNext();
          return;
        }
        consecutiveErrors += 1;
        opts.onError?.(parsed.message || "unrecognisable status response");
        scheduleNext();
        return;
      }

      consecutiveErrors = 0;
      const { stage, halted } = parsed;

      if (halted) {
        opts.onHalted?.(stage);
      }

      if (stage === "done") {
        if (stage !== lastStage) {
          lastStage = stage;
          opts.onStage?.(stage);
        }
        opts.onDone?.();
        stop();
        return;
      }

      if (stage !== lastStage) {
        lastStage = stage;
        opts.onStage?.(stage);
      }

      scheduleNext();
    } finally {
      inFlight = false;
    }
  }

  /** Schedule the next poll — or time out if the max window is exceeded. */
  function scheduleNext() {
    if (!running || cancelled) return;
    if (now() - startedAt > maxMs) {
      opts.onTimeout?.();
      stop();
      return;
    }
    cancelScheduled = schedule(() => {
      cancelScheduled = null;
      tick();
    }, intervalMs);
  }

  function start(options) {
    if (running) return;
    opts = options || {};
    if (!opts.inboundTxid) {
      throw new Error("createThorchainStatusPoller.start: inboundTxid is required");
    }
    running = true;
    cancelled = false;
    startedAt = now();
    lastStage = opts.initialStage ?? null;
    // Poll immediately, then every intervalMs.
    tick();
  }

  function stop() {
    running = false;
    cancelled = true;
    if (cancelScheduled) {
      cancelScheduled();
      cancelScheduled = null;
    }
  }

  /** Test/operator hook: force a poll cycle now (no-op when not running). */
  function tickNow() {
    if (!running) return Promise.resolve();
    return tick();
  }

  return {
    start,
    stop,
    tickNow,
    isRunning: () => running,
    /** Exposed for tests: the stage vocabulary the poller emits. */
    STAGES: THORCHAIN_STAGES,
  };
}
