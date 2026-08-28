/**
 * THORChainTab.test.jsx — flag-gated rendering of the THORChain lane inside
 * the one card (Step 3.1).
 *
 * docs/BRIEF.md: the whole THORChain flow is ONE card with sequential states
 * inside the THORChain tab (quote → deposit address → progress → done), and
 * everything renders only when flags.THORCHAIN is true. These tests prove:
 *   - flag OFF → the THORChain tab shows the generic placeholder (the lane is
 *     never mounted unconditionally).
 *   - flag ON → the tab mounts THORChainTab (quote placeholder for now —
 *     Steps 3.2/3.3 build it; the progress state is this step).
 *   - a hook payload (initialHop) drops the tab straight into the progress
 *     state, and a pending persisted hop resumes into progress on mount.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
function setGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    globalThis[name] = value;
  }
}
setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
setGlobal("navigator", dom.window.navigator);
setGlobal("Event", dom.window.Event);
setGlobal("CustomEvent", dom.window.CustomEvent);
setGlobal("HTMLElement", dom.window.HTMLElement);
setGlobal("Node", dom.window.Node);
setGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider } from "../wallet/WalletContext.jsx";
import BridgeCard from "../../components/BridgeCard.jsx";
import THORChainTab from "../../components/THORChainTab.jsx";
import { createThorchainStorage } from "./storage.js";

const HOP = { inboundTxid: "tx-abc", sourceChain: "BTC", destination: "SOL", expectedAmountOut: 0.05 };

function memBackend() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, v); },
    del: (k) => { m.delete(k); },
    getAll: () => Object.fromEntries(m),
    map: m,
  };
}

/** Minimal fake discovery handle so WalletProvider mounts cleanly. */
const FAKE_DISCOVERY = {
  start() {},
  stop() {},
  subscribe() { return () => {}; },
  getDiscovered() {
    return { evm: [], solana: [], bitcoin: [], litecoin: [], dogecoin: [], xrp: [], tron: [] };
  },
  getProvider() { return null; },
};

function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(WalletProvider, { discovery: FAKE_DISCOVERY }, element),
    );
  });
  return {
    root,
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const click = (el) => act(() => el.click());

test("flag OFF: the THORChain tab renders the generic placeholder — the lane is never mounted", () => {
  const { container, unmount } = render(React.createElement(BridgeCard, { flags: { THORCHAIN: false } }));
  try {
    click(container.querySelector('[data-tab="thorchain"]'));
    const tab = container.querySelector('[data-testid="thorchain-tab"]');
    assert.ok(tab, "placeholder tab panel rendered");
    assert.match(tab.textContent, /THORChain swap flow arrives in a later step/);
    assert.equal(
      container.querySelector('[data-testid="thorchain-progress"]'),
      null,
      "no progress component when the flag is off",
    );
    assert.equal(
      container.querySelector('[data-testid="thorchain-placeholder"]'),
      null,
      "the THORChainTab content itself is not mounted either",
    );
  } finally {
    unmount();
  }
});

test("flag ON: the THORChain tab mounts THORChainTab (quote state placeholder — Steps 3.2/3.3)", () => {
  const { container, unmount } = render(React.createElement(BridgeCard, { flags: { THORCHAIN: true } }));
  try {
    click(container.querySelector('[data-tab="thorchain"]'));
    const placeholder = container.querySelector('[data-testid="thorchain-placeholder"]');
    assert.ok(placeholder, "THORChainTab mounted");
    assert.match(placeholder.textContent, /THORChain lane — quote/);
    assert.match(placeholder.textContent, /Step 3\.2/, "quote state is a clearly-marked placeholder");
  } finally {
    unmount();
  }
});

test("flag ON + hook payload: the tab drops straight into the PROGRESS state", () => {
  const { container, unmount } = render(
    React.createElement(THORChainTab, { initialHop: HOP }),
  );
  try {
    const progress = container.querySelector('[data-testid="thorchain-progress"]');
    assert.ok(progress, "progress state renders when a hop payload exists");
    assert.ok(progress.textContent.includes("BTC → Solana → X1"));
    assert.ok(progress.textContent.includes("tx-abc"));
  } finally {
    unmount();
  }
});

test("flag ON + pending persisted hop: the tab resumes into progress on mount", () => {
  const storage = createThorchainStorage(memBackend());
  storage.saveHop({ inboundTxid: "tx-resume", stage: "swapping", payload: { ...HOP, inboundTxid: "tx-resume" } });

  const { container, unmount } = render(
    React.createElement(THORChainTab, { storage }),
  );
  try {
    const progress = container.querySelector('[data-testid="thorchain-progress"]');
    assert.ok(progress, "resumed into the progress state from the persisted hop");
    assert.ok(progress.textContent.includes("tx-resume"), "resumed hop txid shown");
    const swapping = container.querySelector('[data-testid="tc-stage-swapping"]');
    assert.equal(swapping.getAttribute("data-state"), "active", "resumed from the persisted stage");
  } finally {
    unmount();
  }
});

test("flag ON, no hop: the quote placeholder renders (fresh visit, nothing persisted)", () => {
  const storage = createThorchainStorage(memBackend());
  const { container, unmount } = render(React.createElement(THORChainTab, { storage }));
  try {
    const placeholder = container.querySelector('[data-testid="thorchain-placeholder"]');
    assert.ok(placeholder);
    assert.match(placeholder.textContent, /THORChain lane — quote/);
    assert.equal(container.querySelector('[data-testid="thorchain-progress"]'), null);
  } finally {
    unmount();
  }
});
