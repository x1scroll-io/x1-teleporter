/**
 * typewriter.dom.test.jsx — the JOURNEY READOUT's console typewriter.
 *
 * Proves the two contracts the readout depends on:
 *   - the hook renders the FULL string immediately when the environment has no
 *     requestAnimationFrame (the jsdom default) — this is exactly why the
 *     existing journey-readout DOM tests still see the whole itinerary;
 *   - under a driven rAF it REVEALS the string progressively, then lands it,
 *     and RESTARTS from the top when the restartKey changes (a new route);
 *   - reduced motion renders instantly even when rAF is available;
 *   - <Typed> carries a blinking print-head cursor while writing and drops it
 *     when the line lands.
 *
 * HARNESS NOTE: ./thorchain/jsdomSetup.js MUST stay the FIRST import (DOM
 * globals before react/react-dom evaluate — see that file).
 */
import { dom } from "./thorchain/jsdomSetup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Typed, useTypewriter } from "../components/useTypewriter.jsx";

// ── a controllable requestAnimationFrame ────────────────────────────────────
// The hook reads the bare global; we install a queue we drive by hand so the
// animation is deterministic (no real clock, no sleeps).
function installRaf() {
  const queue = [];
  let seq = 0;
  const prev = {
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
  };
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return ++seq; };
  globalThis.cancelAnimationFrame = () => {};
  return {
    drive(t) {
      const cbs = queue.splice(0);
      act(() => { for (const cb of cbs) cb(t); });
    },
    restore() {
      if (prev.raf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = prev.raf;
      if (prev.caf === undefined) delete globalThis.cancelAnimationFrame;
      else globalThis.cancelAnimationFrame = prev.caf;
    },
  };
}

function setReducedMotion(on) {
  const prev = dom.window.matchMedia;
  dom.window.matchMedia = (q) => ({
    matches: on && /prefers-reduced-motion/.test(q),
    media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  return () => {
    if (prev === undefined) delete dom.window.matchMedia;
    else dom.window.matchMedia = prev;
  };
}

function render(el) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  return {
    container,
    rerender(next) { act(() => root.render(next)); },
    unmount() { act(() => root.unmount()); container.remove(); },
  };
}

function Harness({ text, speedMs, startDelayMs, restartKey, enabled }) {
  const { text: shown, done } = useTypewriter(text, speedMs, { startDelayMs, restartKey, enabled });
  return <span data-testid="out" data-done={String(done)}>{shown}</span>;
}

const out = (c) => c.querySelector('[data-testid="out"]');

test("no requestAnimationFrame ⇒ the full string renders immediately", () => {
  assert.equal(typeof globalThis.requestAnimationFrame, "undefined", "jsdom default: no rAF");
  const r = render(<Harness text="HELLO" speedMs={10} />);
  try {
    assert.equal(out(r.container).textContent, "HELLO");
    assert.equal(out(r.container).getAttribute("data-done"), "true");
  } finally {
    r.unmount();
  }
});

test("under rAF the string reveals progressively, then lands", () => {
  const raf = installRaf();
  const r = render(<Harness text="HELLO" speedMs={10} />);
  try {
    assert.equal(out(r.container).textContent, "", "nothing revealed before the first frame");
    raf.drive(0);
    assert.equal(out(r.container).textContent, "", "first frame arms the print head");
    raf.drive(25);
    assert.equal(out(r.container).textContent, "HE", "2 chars at t=25ms (10ms/char)");
    assert.equal(out(r.container).getAttribute("data-done"), "false");
    raf.drive(50);
    assert.equal(out(r.container).textContent, "HELLO", "full string once the window elapses");
    assert.equal(out(r.container).getAttribute("data-done"), "true");
  } finally {
    r.unmount();
    raf.restore();
  }
});

test("changing the restartKey re-types from the top (fresh lock-in print)", () => {
  const raf = installRaf();
  const r = render(<Harness text="HELLO" speedMs={10} restartKey="a" />);
  try {
    raf.drive(0); raf.drive(50);
    assert.equal(out(r.container).textContent, "HELLO");
    // Same text, new route signature ⇒ the print restarts.
    r.rerender(<Harness text="HELLO" speedMs={10} restartKey="b" />);
    assert.equal(out(r.container).textContent, "", "reset to the top on a new route");
    raf.drive(0); raf.drive(50);
    assert.equal(out(r.container).textContent, "HELLO", "re-typed to completion");
  } finally {
    r.unmount();
    raf.restore();
  }
});

test("reduced motion renders instantly even when rAF is available", () => {
  const restoreRm = setReducedMotion(true);
  const raf = installRaf();
  const r = render(<Harness text="HELLO" speedMs={10} />);
  try {
    assert.equal(out(r.container).textContent, "HELLO", "no per-character delay under reduced motion");
    assert.equal(out(r.container).getAttribute("data-done"), "true");
  } finally {
    r.unmount();
    raf.restore();
    restoreRm();
  }
});

test("<Typed> shows a blinking print-head cursor while writing, drops it when done", () => {
  const raf = installRaf();
  const r = render(<Typed text="ABC" speedMs={10} />);
  try {
    raf.drive(0);
    raf.drive(15);
    const cursor = r.container.querySelector('[data-testid="typewriter-cursor"]');
    assert.ok(cursor, "a print-head cursor is present mid-typing");
    assert.equal(r.container.textContent, "A", "the cursor adds no text of its own");
    raf.drive(100);
    assert.equal(r.container.querySelector('[data-testid="typewriter-cursor"]'), null, "cursor gone once landed");
    assert.equal(r.container.textContent, "ABC");
  } finally {
    r.unmount();
    raf.restore();
  }
});
