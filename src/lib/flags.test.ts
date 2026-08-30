/**
 * Placeholder test for the v2 feature flags — runs under Node's built-in test
 * runner (node --test, type stripping handles the .ts). No framework needed.
 *
 * Asserts the documented defaults: both flags are false when no env vars are
 * set, and that the NEXT_PUBLIC_ name wins over the VITE_ fallback name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFlags, THORCHAIN, ANYSWAP, REVERSE_ENABLED, LEGACY_UI, selectRootCard } from "./flags.ts";

test("flags default to false when no env vars are set", () => {
  // Singleton values (resolved from the real environment at module load —
  // which has no flags set under node --test, so this exercises the default).
  assert.equal(THORCHAIN, false);
  assert.equal(ANYSWAP, false);
  assert.equal(REVERSE_ENABLED, false);

  // Explicit empty env: same result via the pure resolver.
  const flags = resolveFlags({});
  assert.equal(flags.THORCHAIN, false);
  assert.equal(flags.ANYSWAP, false);
  assert.equal(flags.REVERSE_ENABLED, false);
});

test("NEXT_PUBLIC_ flag name takes precedence over VITE_ name", () => {
  const flags = resolveFlags({
    NEXT_PUBLIC_FLAG_THORCHAIN: "true",
    VITE_FLAG_THORCHAIN: "false",
  });
  assert.equal(flags.THORCHAIN, true);
});

test("falls back to the VITE_ flag name when NEXT_PUBLIC_ is unset", () => {
  const flags = resolveFlags({ VITE_FLAG_THORCHAIN: "1" });
  assert.equal(flags.THORCHAIN, true);
});

test("ANYSWAP is independent of THORCHAIN", () => {
  const flags = resolveFlags({ VITE_FLAG_ANYSWAP: "true" });
  assert.equal(flags.ANYSWAP, true);
  assert.equal(flags.THORCHAIN, false);
});

test("LEGACY_UI defaults to false — the v2 card is the default mount", () => {
  assert.equal(LEGACY_UI, false);
  const flags = resolveFlags({});
  assert.equal(flags.LEGACY_UI, false);
});

test("LEGACY_UI resolves from both the VITE_ and NEXT_PUBLIC_ names", () => {
  assert.equal(resolveFlags({ VITE_FLAG_LEGACY_UI: "true" }).LEGACY_UI, true);
  assert.equal(resolveFlags({ NEXT_PUBLIC_FLAG_LEGACY_UI: "1" }).LEGACY_UI, true);
});

test("LEGACY_UI: NEXT_PUBLIC_ name takes precedence over VITE_ name", () => {
  const flags = resolveFlags({
    NEXT_PUBLIC_FLAG_LEGACY_UI: "true",
    VITE_FLAG_LEGACY_UI: "false",
  });
  assert.equal(flags.LEGACY_UI, true);
});

test("selectRootCard defaults to v2 (BridgeCard) when the legacy flag is off", () => {
  assert.equal(selectRootCard({ LEGACY_UI: false }), "v2");
  // Missing / undefined flag behaves like off — default is v2.
  assert.equal(selectRootCard({}), "v2");
});

test("selectRootCard returns legacy (Teleporter) when the legacy flag is set", () => {
  assert.equal(selectRootCard({ LEGACY_UI: true }), "legacy");
  // And it flows through resolveFlags end-to-end.
  assert.equal(selectRootCard(resolveFlags({ NEXT_PUBLIC_FLAG_LEGACY_UI: "true" })), "legacy");
});
