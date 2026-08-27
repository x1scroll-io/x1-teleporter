/**
 * Route-builder tests for the Step 1.2 reverse-relay removal.
 *
 * Asserts the route builder rejects ANY fromChain=X1 route while
 * REVERSE_ENABLED is false (the documented default), and that the forward
 * paths are untouched. Runs under Node's built-in test runner
 * (node --test, type stripping handles the .ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { determineRoute } from "./routes.ts";
import { resolveFlags } from "./flags.ts";

test("route builder rejects X1-source routes while REVERSE_ENABLED is false", () => {
  // Explicit false — the documented default.
  assert.equal(determineRoute("x1", "sol", false), "direct");
  assert.equal(determineRoute("x1", "eth", false), "direct");
  assert.equal(determineRoute("x1", "bsc", false), "direct");

  // Default (real env, flag unset) also rejects — the singleton resolves to
  // false under node --test, so this exercises the actual production default.
  assert.notEqual(determineRoute("x1", "sol"), "x1_reverse");
  assert.notEqual(determineRoute("x1", "eth"), "x1_onward");
});

test("route builder allows X1-source routes when REVERSE_ENABLED is true", () => {
  assert.equal(determineRoute("x1", "sol", true), "x1_reverse");
  assert.equal(determineRoute("x1", "eth", true), "x1_onward");
});

test("forward + direct routes are unaffected by REVERSE_ENABLED", () => {
  assert.equal(determineRoute("sol", "x1", false), "sol_x1");
  assert.equal(determineRoute("eth", "x1", false), "x1");
  assert.equal(determineRoute("eth", "sol", false), "direct");
  assert.equal(determineRoute("eth", "sol", true), "direct");
});

test("REVERSE_ENABLED flag resolves env-driven, default false", () => {
  assert.equal(resolveFlags({}).REVERSE_ENABLED, false);
  assert.equal(resolveFlags({ VITE_FLAG_REVERSE_ENABLED: "true" }).REVERSE_ENABLED, true);
  assert.equal(resolveFlags({ VITE_FLAG_REVERSE_ENABLED: "1" }).REVERSE_ENABLED, true);
  assert.equal(resolveFlags({ NEXT_PUBLIC_FLAG_REVERSE_ENABLED: "true" }).REVERSE_ENABLED, true);
  assert.equal(resolveFlags({ NEXT_PUBLIC_FLAG_REVERSE_ENABLED: "true", VITE_FLAG_REVERSE_ENABLED: "false" }).REVERSE_ENABLED, true);
});
