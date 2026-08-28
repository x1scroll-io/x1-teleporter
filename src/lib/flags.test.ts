/**
 * Placeholder test for the v2 feature flags — runs under Node's built-in test
 * runner (node --test, type stripping handles the .ts). No framework needed.
 *
 * Asserts the documented defaults: both flags are false when no env vars are
 * set, and that the NEXT_PUBLIC_ name wins over the VITE_ fallback name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFlags, THORCHAIN, ANYSWAP, REVERSE_ENABLED, WARP_LIVE_SEND } from "./flags.ts";

test("flags default to false when no env vars are set", () => {
  // Singleton values (resolved from the real environment at module load —
  // which has no flags set under node --test, so this exercises the default).
  assert.equal(THORCHAIN, false);
  assert.equal(ANYSWAP, false);
  assert.equal(REVERSE_ENABLED, false);
  assert.equal(WARP_LIVE_SEND, false); // send gate closed by default

  // Explicit empty env: same result via the pure resolver.
  const flags = resolveFlags({});
  assert.equal(flags.THORCHAIN, false);
  assert.equal(flags.ANYSWAP, false);
  assert.equal(flags.REVERSE_ENABLED, false);
  assert.equal(flags.WARP_LIVE_SEND, false);
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

// ── WARP_LIVE_SEND gate (the runStage2 allowLive wiring) ──
// The send path is BLOCKED while the flag is false and ARMED when true.
// flags.ts is pure, so the gate resolves directly from the env.

test("WARP_LIVE_SEND false => send gate closed (allowLive resolves false)", () => {
  const flags = resolveFlags({});
  assert.equal(flags.WARP_LIVE_SEND, false);
});

test("WARP_LIVE_SEND true via VITE_WARP_LIVE_SEND => send gate armed (allowLive resolves true)", () => {
  const flags = resolveFlags({ VITE_WARP_LIVE_SEND: "true" });
  assert.equal(flags.WARP_LIVE_SEND, true);
});

test("VITE_WARP_LIVE_SEND accepts '1' as true", () => {
  const flags = resolveFlags({ VITE_WARP_LIVE_SEND: "1" });
  assert.equal(flags.WARP_LIVE_SEND, true);
});

test("NEXT_PUBLIC_FLAG_WARP_LIVE_SEND takes precedence over VITE_WARP_LIVE_SEND", () => {
  const flags = resolveFlags({
    NEXT_PUBLIC_FLAG_WARP_LIVE_SEND: "true",
    VITE_WARP_LIVE_SEND: "false",
  });
  assert.equal(flags.WARP_LIVE_SEND, true);
});
