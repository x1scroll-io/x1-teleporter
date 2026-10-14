/**
 * landingDetection.js — detect the THORChain outbound SOL landing in the
 * connected Solana wallet (Step 3.1, the hop stage of the THORChain lane).
 *
 * docs/BRIEF.md (Workstream A — Panel 2): "On `done`: detect SOL landing in
 * the connected wallet (balance delta ≥ expected − tolerance). Auto-advance
 * into the existing SOL→USDC same-chain swap, then the 0.5% skim, then Warp."
 *
 * The THORChain outbound delivers SOL.SOL to the destination (the connected
 * Solana wallet). We measure the NATIVE SOL balance delta from the moment the
 * tx status reaches `done` (that is when the outbound is landing) until the
 * delta clears `expectedAmountOut − tolerance`.
 *
 * PURE + DI: `getBalance` is injected (tests mock it; the component wires a
 * real RPC reader). `schedule`/`now` are the timer/clock seams, same pattern
 * as pollStatus.js — tests drive ticks by hand, no fake timers.
 */

export const DEFAULT_LANDING_INTERVAL_MS = 5_000;
export const DEFAULT_LANDING_MAX_MS = 30 * 60 * 1000; // 30 min of arrival-checking

/**
 * The core predicate — exported pure so it is unit-tested directly.
 *
 * @param {object} args
 * @param {number} args.balanceBefore balance at the moment `done` was observed
 * @param {number} args.balanceNow current wallet balance
 * @param {number} args.expectedAmountOut the hook payload's expected SOL out
 * @param {number} [args.tolerance] allowed shortfall (default: 0.5% of expected,
 *   floored at 1e-6 — THORChain outbounds can land a hair under the estimate)
 * @returns {boolean} true when the SOL landing clears the threshold
 */
export function hasSolLanded({ balanceBefore, balanceNow, expectedAmountOut, tolerance }) {
  const expected = Number(expectedAmountOut);
  if (!Number.isFinite(expected) || expected <= 0) return false;
  const tol = tolerance ?? Math.max(1e-6, expected * 0.005);
  const before = Number.isFinite(balanceBefore) ? balanceBefore : 0;
  const now = Number.isFinite(balanceNow) ? balanceNow : 0;
  return now - before >= expected - tol;
}

/** Default timer seam. */
function defaultSchedule(fn, ms) {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/**
 * Create a SOL landing watcher.
 *
 * @param {object} [deps]
 * @param {() => Promise<number>} deps.getBalance reads the wallet's native SOL balance
 * @param {number} [deps.intervalMs] check interval (default: 5s)
 * @param {number} [deps.maxMs] max arrival window (default: 30 min)
 * @param {number} [deps.tolerance] shortfall tolerance in SOL
 * @param {(fn:()=>void, ms:number) => () => void} [deps.schedule]
 * @param {() => number} [deps.now]
 * @returns {{start:Function, stop:Function, checkNow:Function, isRunning:() => boolean}}
 */
export function createSolLandingWatcher(deps = {}) {
  const getBalance = deps.getBalance;
  const intervalMs = deps.intervalMs ?? DEFAULT_LANDING_INTERVAL_MS;
  const maxMs = deps.maxMs ?? DEFAULT_LANDING_MAX_MS;
  const tolerance = deps.tolerance;
  const schedule = deps.schedule ?? defaultSchedule;
  const now = deps.now ?? Date.now;

  let running = false;
  let cancelled = false;
  let cancelScheduled = null;
  let inFlight = false;
  let startedAt = 0;
  let balanceBefore = 0;
  let expectedAmountOut = 0;

  async function check() {
    if (!running || cancelled || inFlight) return;
    inFlight = true;
    try {
      let balanceNow;
      try {
        balanceNow = await getBalance();
      } catch (e) {
        opts.onError?.(`balance check failed: ${e?.message || String(e)}`);
        scheduleNext();
        return;
      }
      if (hasSolLanded({ balanceBefore, balanceNow, expectedAmountOut, tolerance })) {
        opts.onLanded?.(balanceNow);
        stop();
        return;
      }
      scheduleNext();
    } finally {
      inFlight = false;
    }
  }

  function scheduleNext() {
    if (!running || cancelled) return;
    if (now() - startedAt > maxMs) {
      opts.onTimeout?.();
      stop();
      return;
    }
    cancelScheduled = schedule(() => {
      cancelScheduled = null;
      check();
    }, intervalMs);
  }

  let opts = {};

  function start(options) {
    if (running) return;
    opts = options || {};
    if (typeof getBalance !== "function") {
      throw new Error("createSolLandingWatcher.start: getBalance is required");
    }
    balanceBefore = opts.balanceBefore ?? 0;
    expectedAmountOut = opts.expectedAmountOut ?? 0;
    running = true;
    cancelled = false;
    startedAt = now();
    check();
  }

  function stop() {
    running = false;
    cancelled = true;
    if (cancelScheduled) {
      cancelScheduled();
      cancelScheduled = null;
    }
  }

  /** Test/operator hook: force a balance check now. */
  function checkNow() {
    if (!running) return Promise.resolve();
    return check();
  }

  return { start, stop, checkNow, isRunning: () => running };
}
