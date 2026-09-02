/**
 * Unit tests for the BUILD banner builder (src/lib/buildBanner.js).
 *
 * The banner must reflect the REAL compiled flags — the hardcoded "live
 * sends OFF" string previously lied about armed builds (v2 branch compiles
 * WARP_LIVE_SEND:true). The ON/OFF phrase is build-time folded from the
 * pinned env var (vite.config.js define), so the bundle-level proof is the
 * build grep; these tests pin the pure phrase mapping and the marker format.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBanner, liveSendPhrase, resolveLiveSendArmed } from "./buildBanner.js";

test("liveSendPhrase maps armed=true to 'live sends ON'", () => {
  assert.equal(liveSendPhrase(true), "live sends ON");
});

test("liveSendPhrase maps armed=false to 'live sends OFF'", () => {
  assert.equal(liveSendPhrase(false), "live sends OFF");
});

test("resolveLiveSendArmed is false outside Vite (no import.meta.env)", () => {
  // Under node --test there is no Vite transform, so the env pin is absent.
  // The build-time fold (vite.config.js define) is proven by bundle grep:
  //   VERCEL_GIT_COMMIT_REF=v2 npm run build → grep "live sends ON"
  //   VERCEL_GIT_COMMIT_REF=main npm run build → grep "live sends OFF"
  assert.equal(resolveLiveSendArmed(), false);
});

test("banner format: build marker, v2 card note, and flag dumps", () => {
  const banner = buildBanner({
    buildTime: "2026-09-02T00:00:00.000Z",
    WARP_LIVE_SEND: true,
    THORCHAIN: false,
  });
  assert.match(banner, /BUILD 2026-09-02T00:00:00\.000Z/);
  assert.match(banner, /\(v2 card mounted — preview;/);
  assert.match(banner, /WARP_LIVE_SEND=true/);
  assert.match(banner, /THORCHAIN=false/);
  // The phrase itself is env-driven (build-time folded); under node --test it
  // resolves OFF. The ON/OFF mapping is covered by liveSendPhrase tests above
  // and the armed state by the bundle grep.
  assert.match(banner, /live sends (ON|OFF)/);
});

test("falls back to dev marker when __BUILD_TIME__ is absent", () => {
  const banner = buildBanner({
    buildTime: undefined,
    WARP_LIVE_SEND: false,
    THORCHAIN: false,
  });
  assert.match(banner, /BUILD dev/);
});

test("reports the THORCHAIN flag state", () => {
  const banner = buildBanner({
    buildTime: undefined,
    WARP_LIVE_SEND: false,
    THORCHAIN: true,
  });
  assert.match(banner, /THORCHAIN=true/);
});

test("format matches the console contract: %c style prefix + full marker", () => {
  const banner = buildBanner({
    buildTime: "2026-09-02T00:00:00.000Z",
    WARP_LIVE_SEND: false,
    THORCHAIN: false,
  });
  // main.jsx prepends the %c style token; the banner itself is the text.
  assert.ok(banner.startsWith("[Teleporter] BUILD "));
});
