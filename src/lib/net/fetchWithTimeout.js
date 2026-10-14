/**
 * fetchWithTimeout.js — a fail-closed fetch wrapper for the Teleporter.
 *
 * WHY THIS EXISTS (audit 2026-10-14): a stalled HTTP request (a proxy that
 * accepts the socket but never answers) left `pollWarpStatus` pending PAST its
 * `maxMs`, and `runQuote()`'s `await fetch('/api/lifi/quote…')` spun
 * "CALCULATING ROUTE…" forever. `fetch` has NO default timeout, so a hung
 * upstream hangs the whole swap/bridge UI. Every network call in `src` now goes
 * through this helper, so a stall FAILS CLOSED with a clear error instead of a
 * pending promise.
 *
 * THE TECHNIQUE (belt + suspenders):
 *   1. An `AbortController` (or, when the caller already passed a signal, a
 *      controller that mirrors that signal) is handed to `fetch` so a REAL
 *      fetch is actually cancelled at the timeout.
 *   2. A `Promise.race` against a timer is the ENFORCEMENT: even if the fetch
 *      implementation ignores the abort signal (some polyfills, and every
 *      test mock that returns `new Promise(() => {})`), the race still rejects
 *      at the deadline. This is what makes the bound REAL, not best-effort.
 *
 * The timeout rejection is a single, greppable error whose message contains
 * "request timed out" (plus the URL + the ms) and whose `name` is
 * `"TimeoutError"` / `code` is `"ETIMEDOUT"`, so callers (and tests) can detect
 * it deterministically via `isTimeoutError(e)`.
 *
 * Env note: `AbortSignal.timeout` is preferred where available (a platform
 * timeout signal with no manual controller); we fall back to a manual
 * `AbortController` + `setTimeout` on older runtimes. The race is always
 * installed, so the total wall-clock bound holds on both paths.
 */

/** Default timeout for a general network call (ms). */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
/** Quote fetches (LiFi / Rango / aggregator proxies) — user-blocking, 20s. */
export const QUOTE_TIMEOUT_MS = 20_000;
/** Status/poll fetches (short, repeated) — 8s. */
export const POLL_TIMEOUT_MS = 8_000;
/** Raw JSON-RPC reads (Solana/X1/EVM nodes) — 12s. */
export const RPC_TIMEOUT_MS = 12_000;

/** Normalize any timeout argument to a positive finite number of ms. */
function normalizeTimeout(timeoutMs) {
  const n = Number(timeoutMs);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FETCH_TIMEOUT_MS;
}

/**
 * Build the canonical timeout error. Message ALWAYS contains
 * "request timed out" so the UI/greps can rely on it.
 * @param {number} timeoutMs
 * @param {string} [url]
 * @returns {Error & { name: string, code: string, timeoutMs: number }}
 */
export function makeTimeoutError(timeoutMs, url) {
  const where = url ? ` (${url})` : "";
  const err = new Error(`request timed out after ${timeoutMs}ms${where}`);
  err.name = "TimeoutError";
  err.code = "ETIMEDOUT";
  err.timeoutMs = timeoutMs;
  return err;
}

/** True when `e` is a timeout produced by this helper (or an equivalent). */
export function isTimeoutError(e) {
  return !!e && (e.name === "TimeoutError" || e.code === "ETIMEDOUT");
}

function getGlobalFetch() {
  if (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  return null;
}

/**
 * fetch() with a hard wall-clock timeout.
 *
 * @param {string|URL} url
 * @param {object} [opts] the standard RequestInit (a caller `signal` is honored
 *   and mirrored onto the internal controller).
 * @param {number} [timeoutMs=DEFAULT_FETCH_TIMEOUT_MS]
 * @param {{fetchImpl?: Function}} [deps] optional DI seam (tests/prod).
 * @returns {Promise<Response>} resolves with the fetch Response; REJECTS with a
 *   `TimeoutError` ("request timed out …") at the deadline, or with the
 *   underlying fetch error otherwise.
 */
export function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, deps = {}) {
  const f = deps.fetchImpl || getGlobalFetch();
  if (!f) return Promise.reject(new Error("fetch is not available in this environment"));

  const ms = normalizeTimeout(timeoutMs);
  const hasController = typeof AbortController !== "undefined";
  const hasPlatformTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";

  let controller = null;
  let timer = null;
  let timedOut = false;

  // ── Timeout enforcement (the race's losing/rejecting leg) ──
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const err = makeTimeoutError(ms, typeof url === "string" ? url : String(url));
      // Cancel the real fetch too, when we own a controller.
      if (controller) { try { controller.abort(err); } catch { /* ignore */ } }
      reject(err);
    }, ms);
  });

  // ── Signal wiring: prefer AbortController; mirror any caller signal ──
  let mergedOpts = opts;
  if (hasController) {
    controller = new AbortController();
    const callerSignal = opts && opts.signal;
    if (callerSignal) {
      if (callerSignal.aborted) {
        try { controller.abort(callerSignal.reason); } catch { /* ignore */ }
      } else if (typeof callerSignal.addEventListener === "function") {
        try {
          callerSignal.addEventListener("abort", () => {
            try { controller.abort(callerSignal.reason); } catch { /* ignore */ }
          }, { once: true });
        } catch { /* ignore */ }
      }
    }
    mergedOpts = { ...opts, signal: controller.signal };
  } else if (hasPlatformTimeout && !(opts && opts.signal)) {
    // No AbortController, but the platform exposes AbortSignal.timeout.
    mergedOpts = { ...opts, signal: AbortSignal.timeout(ms) };
  }

  const fetchPromise = Promise.resolve().then(() => f(url, mergedOpts));
  // If the timeout wins the race, swallow the late fetch settle so a slow
  // response never becomes an unhandled rejection.
  fetchPromise.catch(() => { /* late settle after timeout — ignore */ });

  return Promise.race([fetchPromise, timeoutPromise])
    .finally(() => { if (timer) clearTimeout(timer); })
    .catch((e) => {
      // Normalize a timeout (ours, or an abort raised because of ours) into the
      // canonical error so every call site sees "request timed out".
      if (timedOut || isTimeoutError(e)) {
        throw makeTimeoutError(ms, typeof url === "string" ? url : String(url));
      }
      throw e;
    });
}

export default fetchWithTimeout;
