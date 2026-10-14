/**
 * Route-builder tests for the un-gated reverse off-ramp.
 *
 * REVERSE_ENABLED now DEFAULTS ON (a kill switch, not a release gate): every
 * X1-source route constructs by default, and setting the flag false restores
 * the old fail-closed "direct" fall-through. The forward paths are untouched.
 * Runs under Node's built-in test runner (node --test, type stripping handles
 * the .ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { determineRoute } from "./routes.ts";
import { resolveFlags } from "./flags.ts";

test("route builder ALLOWS X1-source routes by default (REVERSE_ENABLED un-gated)", () => {
  // Default (real env, flag unset) → the off-ramp is ON.
  assert.equal(determineRoute("x1", "sol"), "x1_reverse");
  assert.equal(determineRoute("x1", "eth"), "x1_onward");
  assert.equal(determineRoute("x1", "bsc"), "x1_onward");
});

test("route builder rejects X1-source routes when REVERSE_ENABLED is forced false (kill switch)", () => {
  assert.equal(determineRoute("x1", "sol", false), "direct");
  assert.equal(determineRoute("x1", "eth", false), "direct");
  assert.equal(determineRoute("x1", "bsc", false), "direct");
});

test("route builder still allows X1-source routes when REVERSE_ENABLED is explicitly true", () => {
  assert.equal(determineRoute("x1", "sol", true), "x1_reverse");
  assert.equal(determineRoute("x1", "eth", true), "x1_onward");
});

test("forward + direct routes are unaffected by REVERSE_ENABLED", () => {
  assert.equal(determineRoute("sol", "x1", false), "sol_x1");
  assert.equal(determineRoute("eth", "x1", false), "x1");
  assert.equal(determineRoute("eth", "sol", false), "direct");
  assert.equal(determineRoute("eth", "sol", true), "direct");
});

test("REVERSE_ENABLED flag resolves default-on with an env kill switch", () => {
  assert.equal(resolveFlags({}).REVERSE_ENABLED, true);
  assert.equal(resolveFlags({ VITE_FLAG_REVERSE_ENABLED: "false" }).REVERSE_ENABLED, false);
  assert.equal(resolveFlags({ VITE_FLAG_REVERSE_ENABLED: "0" }).REVERSE_ENABLED, false);
  assert.equal(resolveFlags({ VITE_FLAG_REVERSE_ENABLED: "true" }).REVERSE_ENABLED, true);
  assert.equal(resolveFlags({ VITE_FLAG_REVERSE_ENABLED: "1" }).REVERSE_ENABLED, true);
  assert.equal(resolveFlags({ NEXT_PUBLIC_FLAG_REVERSE_ENABLED: "true" }).REVERSE_ENABLED, true);
  assert.equal(resolveFlags({ NEXT_PUBLIC_FLAG_REVERSE_ENABLED: "false", VITE_FLAG_REVERSE_ENABLED: "true" }).REVERSE_ENABLED, false);
});
