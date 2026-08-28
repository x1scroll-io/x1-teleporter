/**
 * React-level tests for WalletContext (Step 2.1): proves the actual hook +
 * context wiring, not just the pure reducer. Runs under node:test with jsdom
 * globals and React 18's `act` (exported from "react" since 18.3). The .jsx
 * files are transpiled on the fly by tools/jsx-loader.mjs (esbuild), which the
 * npm test script registers via `--import`.
 *
 * Coverage mirrors the runbook guarantees at the hook level:
 *   (a) connecting evm never touches solana state,
 *   (b) disconnecting one family leaves the others connected,
 *   (c) every family starts disconnected,
 *   (d) connecting the same family twice is idempotent (single provider),
 *   (e) an error in one family never affects the others.
 */
import { JSDOM } from "jsdom";

// jsdom globals must exist BEFORE react-dom is imported/evaluated.
// Node 22 defines some of these (e.g. navigator) as getter-only globals, so
// define them via Object.defineProperty where plain assignment would throw.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
function setGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  } catch {
    globalThis[name] = value; // fallback for anything not configurable
  }
}
setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
setGlobal("navigator", dom.window.navigator);
setGlobal("HTMLElement", dom.window.HTMLElement);
setGlobal("Node", dom.window.Node);
setGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider, useWallet } from "./WalletContext.jsx";
import { createMockProvider, MOCK_ADDRESSES } from "./mockProviders.js";
import { WALLET_FAMILIES } from "./families.js";

/** Probe component: subscribes to three families and snapshots every render. */
function Probe({ onRender }) {
  const evm = useWallet("evm");
  const solana = useWallet("solana");
  const xrp = useWallet("xrp");
  onRender({ evm, solana, xrp });
  return null;
}

/**
 * Render <WalletProvider><Probe/></WalletProvider> into a detached container.
 * `latest` always holds the most recent render's sessions (fresh closures),
 * `seen` records every snapshot for ordering assertions.
 */
function renderProbe(providerFactory = createMockProvider) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const latest = {};
  const seen = [];
  act(() => {
    root.render(
      React.createElement(
        WalletProvider,
        { providerFactory },
        React.createElement(Probe, {
          onRender: (s) => {
            latest.evm = s.evm;
            latest.solana = s.solana;
            latest.xrp = s.xrp;
            seen.push(s);
          },
        }),
      ),
    );
  });
  return { root, latest, seen, container };
}

function unmount({ root, container }) {
  act(() => root.unmount());
  container.remove();
}

test("(c) hook level: every family starts disconnected", () => {
  const { latest, ...handle } = renderProbe();
  try {
    assert.equal(latest.evm.status, "disconnected");
    assert.equal(latest.solana.status, "disconnected");
    assert.equal(latest.xrp.status, "disconnected");
    // The pure-state test already proves all seven start disconnected;
    // here we prove the hook surfaces the same default per family.
    for (const family of ["evm", "solana", "xrp"]) {
      assert.equal(latest[family].address, undefined);
      assert.equal(latest[family].provider, undefined);
      assert.equal(latest[family].error, undefined);
    }
  } finally {
    unmount(handle);
  }
});

test("(a) hook level: connecting evm does not touch solana", async () => {
  const { latest, ...handle } = renderProbe();
  try {
    await act(async () => {
      await latest.evm.connect();
    });
    assert.equal(latest.evm.status, "connected");
    assert.equal(latest.evm.address, MOCK_ADDRESSES.evm);
    assert.equal(latest.evm.provider.id, "mock:evm");
    assert.equal(latest.solana.status, "disconnected", "solana untouched");
    assert.equal(latest.xrp.status, "disconnected", "xrp untouched");
  } finally {
    unmount(handle);
  }
});

test("(b) hook level: disconnecting evm leaves solana connected", async () => {
  const { latest, ...handle } = renderProbe();
  try {
    await act(async () => {
      await latest.evm.connect();
      await latest.solana.connect();
    });
    assert.equal(latest.evm.status, "connected");
    assert.equal(latest.solana.status, "connected");

    act(() => latest.evm.disconnect());
    assert.equal(latest.evm.status, "disconnected");
    assert.equal(latest.evm.address, undefined);
    assert.equal(latest.solana.status, "connected", "solana still connected");
    assert.equal(latest.solana.address, MOCK_ADDRESSES.solana);
  } finally {
    unmount(handle);
  }
});

test("(d) hook level: double connect on the same family is a no-op (one provider)", async () => {
  let calls = 0;
  const countingFactory = (family) => {
    calls += 1;
    return createMockProvider(family);
  };
  const { latest, ...handle } = renderProbe(countingFactory);
  try {
    await act(async () => {
      // Both fired synchronously — the second must be swallowed by the
      // in-flight guard before it can create a provider.
      await Promise.all([latest.evm.connect(), latest.evm.connect()]);
    });
    assert.equal(latest.evm.status, "connected");
    assert.equal(latest.evm.address, MOCK_ADDRESSES.evm);
    assert.equal(calls, 1, "provider factory ran exactly once");

    // Re-connect after connected is also a no-op (canConnect guard).
    await act(async () => {
      await latest.evm.connect();
    });
    assert.equal(calls, 1, "still exactly one provider");
  } finally {
    unmount(handle);
  }
});

test("(e) hook level: a connect error in one family leaves the others untouched", async () => {
  let xrpAttempts = 0;
  const flakyFactory = (family) => {
    if (family === "xrp") {
      xrpAttempts += 1;
      return createMockProvider(family, { failOnConnect: xrpAttempts === 1 });
    }
    return createMockProvider(family);
  };
  const { latest, ...handle } = renderProbe(flakyFactory);
  try {
    await act(async () => {
      await Promise.allSettled([latest.xrp.connect(), latest.evm.connect()]);
    });
    assert.equal(latest.xrp.status, "error");
    assert.equal(latest.xrp.error, "mock xrp provider rejected connect (test fixture)");
    assert.equal(latest.xrp.address, undefined);

    assert.equal(latest.evm.status, "connected", "evm unaffected by xrp error");
    assert.equal(latest.evm.address, MOCK_ADDRESSES.evm);
    assert.equal(latest.solana.status, "disconnected", "solana unaffected");

    // Retry from error (second attempt) succeeds and stays isolated.
    await act(async () => {
      await latest.xrp.connect();
    });
    assert.equal(latest.xrp.status, "connected");
    assert.equal(latest.xrp.address, MOCK_ADDRESSES.xrp);
    assert.equal(latest.evm.status, "connected", "evm still connected after xrp retry");
  } finally {
    unmount(handle);
  }
});

test("useWallet throws outside a provider", () => {
  // Outside a provider the hook must throw a clear error, not silently return.
  let hookError;
  function BadProbe() {
    try {
      useWallet("evm");
    } catch (err) {
      hookError = err;
    }
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(BadProbe));
  });
  assert.ok(hookError instanceof Error);
  assert.match(hookError.message, /WalletProvider/);
  act(() => root.unmount());
  container.remove();
});

test("useWallet throws for an unknown family inside a provider", () => {
  let unknownError;
  function BadFamilyProbe() {
    try {
      useWallet("monero");
    } catch (err) {
      unknownError = err;
    }
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        WalletProvider,
        null,
        React.createElement(BadFamilyProbe),
      ),
    );
  });
  assert.ok(unknownError instanceof Error);
  assert.match(unknownError.message, /unknown family/);
  act(() => root.unmount());
  container.remove();
});
