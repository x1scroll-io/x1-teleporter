/**
 * routeState.js — Rango-rail ROUTE-UNAVAILABILITY state (the Sui-lane
 * single-point-of-failure hardening — 2026-09-06 SUI COVERAGE CHECK).
 *
 * WHY THIS EXISTS
 *   SUI is a Rango-ONLY source in this console's rail layer
 *   (teleportRail.js COVERAGE_MATRIX: sui → [Rango] — THORChain can't serve
 *   Sui, the Wanchain-family XFlows API has no native-SUI row, and Rango
 *   has no fallback candidate behind it, unlike BTC/DOGE/LTC/XRP which
 *   carry [THORChain, Rango]). That makes the Sui lane a SINGLE POINT OF
 *   FAILURE: when Rango is down / the route is halted / the API errors, the
 *   Sui lane goes fully dark — `pickRail({ fromChain: "sui" })` with Rango
 *   unavailable answers { rail: null } (no second candidate to fail over
 *   to).
 *
 *   This module is the mirror of the THORChain SOL-halt UX pattern
 *   (THORChainDeposit.jsx: isThorchainHaltMessage + the destHalted calm
 *   state + gate disable + auto re-check on the next refresh), built for
 *   the Rango rail: it DETECTS the failure class (Rango down / route
 *   halted / API error — the transient classes) and carries the CALM,
 *   honest copy a console step must render instead of a raw error:
 *
 *     "⚠️ Sui route temporarily unavailable (the bridge network is having
 *      issues) — this usually recovers; try again shortly."
 *
 *   The console does NOT list Sui as a source yet (the source picker is
 *   EVM-chains + BTC/DOGE/LTC/XRP + X1 — Rango-native sources are a later
 *   console phase; see the ⚠️ CONSOLE BOUNDARY note in teleportRail.js).
 *   When that phase lands, its Rango quote step MUST route every quote
 *   failure through isRangoRouteUnavailable() and render
 *   rangoRouteUnavailableMessage() — disabling the quote gate and
 *   auto-recovering on the next attempt/refresh, exactly like the deposit
 *   lane's destHalted state. This module is that seam, pinned + tested now
 *   so the wiring exercise later is copy-paste, not design.
 *
 *   NOT covered here (deliberate): Rango's NO_ROUTE resultType — that is
 *   Rango's honest "no route for this pair RIGHT NOW" coverage answer (the
 *   permanent/coverage class, like ADA's no-rail dead-end), not a transient
 *   outage, so it must NOT render the "usually recovers" copy. The caller
 *   shows its own route-level message for NO_ROUTE (mirror of the rail
 *   layer's honest { rail: null } dead-end).
 *
 * PURE MODULE: no DOM, no fetch, no wallet. Runnable under `node --test`.
 */

/**
 * Wire phrases that mean "Rango's route is unavailable right now" —
 * matched on proxy/API error messages so a down/halted Rango lane renders
 * the CALM unavailable state instead of a raw error wall. Kept to the
 * transient vocabulary (halted / maintenance / network trouble / retry) —
 * deliberately narrow so unrelated quote errors (bad amounts, NO_ROUTE,
 * INPUT_LIMIT_ISSUE, user-input problems) keep their normal error surface.
 */
export const RANGO_ROUTE_UNAVAILABLE_RE =
  /halted|temporarily (?:unavailable|down|offline|paused)|(?:under )?maintenance|network (?:issue|problem|error|disruption)|connect(?:ion|ivity) (?:issue|problem|failed|error)|service (?:interruption|unavailable)|try again (?:in a moment|shortly|later)/i;

/** The proxy's own fail-closed error codes (api/rango/quote.js): the Rango
 *  API key missing server-side (parked item) or the upstream call itself
 *  failed — both are the bridge operator's side, not the user's. */
const PROXY_UNAVAILABLE_ERROR_CODES = Object.freeze(["rango_quote_failed", "no_api_key"]);

/** Rango's deliberate coverage answer — explicitly NOT an outage class. */
const NO_ROUTE_RESULT_TYPES = Object.freeze(["NO_ROUTE"]);

/**
 * Classify a Rango quote failure. True when the failure means "the Sui (or
 * other Rango-native) lane is unavailable right now" — the class that must
 * render the calm route-unavailable state. False for OK quotes, for
 * Rango's NO_ROUTE coverage answer, and for user-input-style errors.
 *
 * Callers pass whatever the failure carried:
 *   - HTTP response received: { status, error?, message? } (proxy body:
 *     error/message; upstream body parsed by parseRangoQuoteResponse:
 *     error/errorCode/resultType + message).
 *   - Fetch THREW (no response — Rango down / network): pass
 *     { status: 0, message: <the thrown message> } — status 0 is the
 *     transport class by contract (the proxy's own upstream failure
 *     surfaces as HTTP 502 { error: "rango_quote_failed" } instead).
 *
 * @param {{status?: number, error?: string, message?: string,
 *          errorCode?: string, resultType?: string}} failure
 * @returns {boolean}
 */
export function isRangoRouteUnavailable(failure = {}) {
  // Non-record input (null / a bare string / undefined) is not a failure
  // record — never assume the lane is down from garbage.
  if (!failure || typeof failure !== "object") return false;
  const { status, error, message, errorCode, resultType } = failure;
  // Rango's deliberate "no route for the pair" coverage answer — NOT a
  // transient outage (see module header). Explicit guard so a NO_ROUTE body
  // can never be mis-translated into "usually recovers".
  if (NO_ROUTE_RESULT_TYPES.includes(resultType) || errorCode === "NO_ROUTE") return false;
  // Class 1/3 — server side: our proxy answered 5xx (upstream down,
  // upstream API error, proxy failure) or the fetch never got a response.
  if (status === 0) return true;
  if (Number.isInteger(status) && status >= 500) return true;
  // Class 1 — the proxy's fail-closed codes (api/rango/quote.js).
  if (PROXY_UNAVAILABLE_ERROR_CODES.includes(error)) return true;
  // Class 2 — route-halt / maintenance wire phrases in any text field.
  const text = [message, error, errorCode].filter((v) => typeof v === "string").join(" ");
  return RANGO_ROUTE_UNAVAILABLE_RE.test(text);
}

/**
 * The CALM, honest message a console step renders when a Rango-native
 * route (e.g. Sui) is unavailable — mirror of the deposit lane's
 * destPaused copy: no rail name, no raw error, no user blame, and the
 * promise that a retry/re-check is the recovery (the console's existing
 * next-attempt/refresh semantics ARE the auto re-check — no new timers).
 *
 * @param {string} chainLabel human chain name ("Sui", "Tron")
 * @returns {string}
 */
export function rangoRouteUnavailableMessage(chainLabel) {
  const label = typeof chainLabel === "string" && chainLabel.trim() !== "" ? chainLabel.trim() : "This";
  return (
    `⚠️ ${label} route temporarily unavailable (the bridge network is having issues) ` +
    `— this usually recovers; try again shortly.`
  );
}

/** The Sui-lane message, pre-built for the console's future Sui phase (the
 *  exact copy Mr. Esters specified). */
export const SUI_ROUTE_UNAVAILABLE_MESSAGE = rangoRouteUnavailableMessage("Sui");
