/**
 * routeState.test.js — the Rango-rail route-unavailability classifier
 * (src/lib/rango/routeState.js — the Sui-lane single-point-of-failure
 * hardening, 2026-09-06 SUI COVERAGE CHECK).
 *
 * Proves:
 *   - the TRANSIENT failure classes all classify unavailable: Rango down /
 *     transport (status 0, fetch threw), our proxy's fail-closed 5xx codes
 *     (rango_quote_failed / no_api_key), any HTTP 5xx (upstream API error),
 *     and route-halt wire phrases in proxy/API messages ("halted",
 *     "temporarily unavailable", "maintenance", network trouble),
 *   - the NON-outage answers stay OUT of the calm state: OK quotes,
 *     Rango's NO_ROUTE coverage answer (deliberate — it must keep its own
 *     honest route-level message, never "usually recovers"), and
 *     user-input-style errors (bad amount, limit issues),
 *   - the calm copy renders exactly the message Mr. Esters specified for
 *     Sui, with per-chain substitution for the other Rango-native sources,
 *   - the module is PURE (no DOM/fetch — node --test runs it bare).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RANGO_ROUTE_UNAVAILABLE_RE,
  isRangoRouteUnavailable,
  rangoRouteUnavailableMessage,
  SUI_ROUTE_UNAVAILABLE_MESSAGE,
} from "./routeState.js";

test("routeState: Rango down (transport — fetch threw, no HTTP response) classifies unavailable", () => {
  // status 0 is the transport class by contract: the fetch itself failed,
  // so there is no proxy body — Rango (or the network to it) is down.
  assert.equal(isRangoRouteUnavailable({ status: 0, message: "fetch failed" }), true);
  assert.equal(isRangoRouteUnavailable({ status: 0, message: "NetworkError when attempting to fetch resource." }), true);
  // No status at all (caller forgot the contract) is NOT assumed down — the
  // classifier stays narrow unless a wire phrase or explicit class says so.
  assert.equal(isRangoRouteUnavailable({ message: "something odd happened" }), false);
});

test("routeState: our proxy's fail-closed codes classify unavailable (api/rango/quote.js)", () => {
  // The proxy answers 502 { error: "rango_quote_failed" } when the upstream
  // call fails and 502 { error: "no_api_key" } when the server key is
  // missing (parked item) — both are the bridge operator's side.
  assert.equal(isRangoRouteUnavailable({ status: 502, error: "rango_quote_failed", message: "upstream timeout" }), true);
  assert.equal(isRangoRouteUnavailable({ status: 502, error: "no_api_key", message: "Rango quote unavailable — the server key is not configured (parked item)." }), true);
  // The codes alone (even without a status) still classify — the error
  // field is the proxy's own vocabulary.
  assert.equal(isRangoRouteUnavailable({ error: "rango_quote_failed" }), true);
});

test("routeState: upstream/API 5xx (Rango API error) classifies unavailable", () => {
  assert.equal(isRangoRouteUnavailable({ status: 500 }), true);
  assert.equal(isRangoRouteUnavailable({ status: 502 }), true);
  assert.equal(isRangoRouteUnavailable({ status: 503, message: "Service Unavailable" }), true);
  // 4xx stays OUT — a client/route-level answer, not a network outage.
  assert.equal(isRangoRouteUnavailable({ status: 400, message: "amount is invalid" }), false);
  assert.equal(isRangoRouteUnavailable({ status: 401 }), false);
  assert.equal(isRangoRouteUnavailable({ status: 404 }), false);
});

test("routeState: route-halt wire phrases classify unavailable (mirror of isThorchainHaltMessage)", () => {
  for (const msg of [
    "route is halted for maintenance",
    "SUI route temporarily unavailable",
    "the bridge network is having issues — temporarily down",
    "swaps are paused while the network undergoes maintenance",
    "service interruption on this route — try again shortly",
    "network problem detected on the SUI route",
    "connection failed to the swapper",
  ]) {
    assert.equal(isRangoRouteUnavailable({ status: 200, message: msg }), true, `message should classify unavailable: ${msg}`);
  }
  // The regex itself is exported and deliberately narrow.
  assert.equal(RANGO_ROUTE_UNAVAILABLE_RE.test("trading is halted"), true);
  assert.equal(RANGO_ROUTE_UNAVAILABLE_RE.test("NO_ROUTE"), false);
  assert.equal(RANGO_ROUTE_UNAVAILABLE_RE.test("input limit issue"), false);
});

test("routeState: NO_ROUTE (Rango's coverage answer) NEVER classifies as the transient outage", () => {
  // NO_ROUTE is Rango's honest "no route for this pair right now" — the
  // permanent/coverage class (like ADA's no-rail dead-end), not a transient
  // outage. It must keep its own route-level message, never the "usually
  // recovers" copy — the explicit guard pins that even if a body ALSO
  // carried a wire phrase or a 5xx-ish wrapper.
  assert.equal(isRangoRouteUnavailable({ resultType: "NO_ROUTE", errorCode: "NO_ROUTE", message: "no route found" }), false);
  assert.equal(isRangoRouteUnavailable({ resultType: "NO_ROUTE", status: 200 }), false);
  assert.equal(isRangoRouteUnavailable({ errorCode: "NO_ROUTE" }), false);
  // Other Rango non-OK result types stay out too (they have their own
  // honest surfaces — HIGH_IMPACT is a warning-level quote, INPUT_LIMIT_ISSUE
  // is an amount problem).
  assert.equal(isRangoRouteUnavailable({ resultType: "HIGH_IMPACT" }), false);
  assert.equal(isRangoRouteUnavailable({ resultType: "INPUT_LIMIT_ISSUE" }), false);
});

test("routeState: OK quotes and empty failures never classify unavailable", () => {
  assert.equal(isRangoRouteUnavailable({}), false);
  assert.equal(isRangoRouteUnavailable({ status: 200, ok: true, resultType: "OK" }), false);
  assert.equal(isRangoRouteUnavailable(null), false);
  assert.equal(isRangoRouteUnavailable(undefined), false);
  assert.equal(isRangoRouteUnavailable("rango_quote_failed"), false); // non-object input is not a failure record
});

test("routeState: the calm copy is exactly Mr. Esters' Sui message, per-chain substitutable", () => {
  assert.equal(
    SUI_ROUTE_UNAVAILABLE_MESSAGE,
    "⚠️ Sui route temporarily unavailable (the bridge network is having issues) — this usually recovers; try again shortly."
  );
  assert.equal(
    rangoRouteUnavailableMessage("Sui"),
    "⚠️ Sui route temporarily unavailable (the bridge network is having issues) — this usually recovers; try again shortly."
  );
  // Per-chain substitution for the other Rango-native source.
  assert.equal(
    rangoRouteUnavailableMessage("Tron"),
    "⚠️ Tron route temporarily unavailable (the bridge network is having issues) — this usually recovers; try again shortly."
  );
  // Empty/unknown labels degrade to a neutral subject — never a raw error.
  assert.equal(rangoRouteUnavailableMessage(""), "⚠️ This route temporarily unavailable (the bridge network is having issues) — this usually recovers; try again shortly.");
  assert.equal(rangoRouteUnavailableMessage(undefined), "⚠️ This route temporarily unavailable (the bridge network is having issues) — this usually recovers; try again shortly.");
});
