/**
 * TokenIcon.test.jsx — the shared token-icon renderer's contract:
 *   - prefers the real logo URI when one is registered;
 *   - falls back to the deterministic badge when none is registered;
 *   - swaps a FAILED logo for the badge on <img> onError (never blank);
 *   - is DI-able (icon/logo resolvers injected → no network, no real art).
 */
import { dom } from "../thorchain/jsdomSetup.js"; // MUST stay the first import
import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import TokenIcon from "../../components/TokenIcon.jsx";

function renderIcon(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(React.createElement(TokenIcon, props)); });
  return {
    container,
    img: () => container.querySelector("img"),
    unmount() { act(() => root.unmount()); container.remove(); },
  };
}

const BADGE = "data:image/svg+xml,%3Csvg%3E%3C/svg%3E";
const LOGO = "https://example.test/logo.png";

test("TokenIcon: no logo registered → renders the badge data-URI", () => {
  const { img, unmount } = renderIcon({ symbol: "FOO", icon: () => BADGE, logo: () => null });
  try {
    assert.equal(img().getAttribute("src"), BADGE);
    assert.equal(img().getAttribute("data-fallback"), BADGE);
  } finally { unmount(); }
});

test("TokenIcon: a registered logo is preferred over the badge", () => {
  const { img, unmount } = renderIcon({ symbol: "USDC", icon: () => BADGE, logo: () => LOGO });
  try {
    assert.equal(img().getAttribute("src"), LOGO, "real logo wins");
    assert.equal(img().getAttribute("data-fallback"), BADGE, "badge kept as the fallback");
  } finally { unmount(); }
});

test("TokenIcon: a FAILED logo swaps to the badge on error (never blank, never loops)", () => {
  const { img, unmount } = renderIcon({ symbol: "USDC", icon: () => BADGE, logo: () => LOGO });
  try {
    const el = img();
    act(() => { el.dispatchEvent(new window.Event("error")); });
    assert.equal(el.getAttribute("src"), BADGE, "onError → badge fallback");
    assert.equal(el.dataset.failed, "1", "flagged so a broken badge cannot loop");
    // a second error must be a no-op
    act(() => { el.dispatchEvent(new window.Event("error")); });
    assert.equal(el.getAttribute("src"), BADGE);
  } finally { unmount(); }
});

test("TokenIcon: defaults to the pure tokenOptions resolvers (real USDC logo, no injection)", () => {
  const { img, unmount } = renderIcon({ symbol: "USDC" });
  try {
    assert.ok(/^https:\/\//.test(img().getAttribute("src")), "USDC renders its registered brand logo by default");
    assert.ok(img().getAttribute("data-fallback").startsWith("data:image/svg+xml"), "badge fallback present");
  } finally { unmount(); }
});
