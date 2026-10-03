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

test("Starport pinned EVM row resolves the REAL EIP-6963 provider via the rdns alias (never the dev mock)", async () => {
  // The registry row id is "starport"; discovery keys on the announced rdns
  // "com.starportllc.starport". The alias sweep must bridge the two so the
  // pinned EVM row signs with the connected wallet, not a mock address.
  const realProvider = {
    id: "eip6963:com.starportllc.starport",
    isReal: true,
    async connect() { return { family: "evm", address: "0xSTARPORTreal", provider: this }; },
  };
  const discovery = {
    start() {}, stop() {}, subscribe() { return () => {}; },
    getDiscovered() { return { evm: [], solana: [], bitcoin: [], litecoin: [], dogecoin: [], xrp: [], tron: [] }; },
    getProvider(family, walletId) {
      return family === "evm" && walletId === "com.starportllc.starport" ? realProvider : null;
    },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const latest = {};
  function Probe2() {
    latest.evm = useWallet("evm");
    return null;
  }
  act(() => {
    root.render(
      React.createElement(
        WalletProvider,
        { discovery },
        React.createElement(Probe2),
      ),
    );
  });
  try {
    await act(async () => {
      await latest.evm.connect("starport");
    });
    assert.equal(latest.evm.status, "connected");
    assert.equal(latest.evm.address, "0xSTARPORTreal", "the REAL Starport provider connected — not the mock");
    assert.equal(latest.evm.provider.id, "eip6963:com.starportllc.starport");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

/** Minimal discovery fake — getDiscovered returns the given snapshot,
 *  getProvider delegates to `resolve` (default: nothing resolves). */
function makeDiscovery({ discovered, resolve = () => null } = {}) {
  return {
    start() {},
    stop() {},
    subscribe() { return () => {}; },
    getDiscovered() {
      return (
        discovered ?? { evm: [], solana: [], bitcoin: [], litecoin: [], dogecoin: [], xrp: [], tron: [] }
      );
    },
    getProvider(family, walletId) {
      return resolve(family, walletId);
    },
  };
}

/** Render <WalletProvider discovery allowMockFallback><Probe/></WalletProvider>. */
function renderWithDiscovery(discovery, allowMockFallback = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const latest = {};
  function Probe3() {
    latest.evm = useWallet("evm");
    latest.solana = useWallet("solana");
    return null;
  }
  act(() => {
    root.render(
      React.createElement(
        WalletProvider,
        { discovery, allowMockFallback },
        React.createElement(Probe3),
      ),
    );
  });
  return {
    root,
    latest,
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/* ————————————— MOCK GATING (a real user is NEVER handed the mock) ————————————— */

test("MOCK GATED OFF (default): an unresolved connect never yields a mock address — honest error instead", async () => {
  // A REAL wallet (MetaMask) is discovered for evm, but the user hit the
  // pinned Starport row (id "starport" — no real adapter). Pre-fix this fell
  // through defaultResolveProvider to createMockProvider: a "connected"
  // mock:evm:0x1234… address NO wallet approved. Default (mock off) must
  // instead surface an honest error and leave the session disconnected-looking.
  const discovery = makeDiscovery({
    discovered: { evm: [{ rdns: "io.metamask" }], solana: [], bitcoin: [], litecoin: [], dogecoin: [], xrp: [], tron: [] },
    resolve: () => null,
  });
  const { latest, unmount } = renderWithDiscovery(discovery /* allowMockFallback defaults false */);
  try {
    await act(async () => {
      await latest.evm.connect("starport");
    });
    assert.equal(latest.evm.status, "error");
    assert.equal(latest.evm.address, undefined, "NO mock address is ever surfaced");
    assert.notEqual(latest.evm.address, MOCK_ADDRESSES.evm);
    assert.match(latest.evm.error, /No EVM wallet detected/);
  } finally {
    unmount();
  }
});

test("MOCK GATED OFF (default): empty discovery + mock off → honest error, never a mock connect", async () => {
  const discovery = makeDiscovery(); // nothing discovered at all
  const { latest, unmount } = renderWithDiscovery(discovery);
  try {
    await act(async () => {
      await latest.solana.connect();
    });
    assert.equal(latest.solana.status, "error");
    assert.equal(latest.solana.address, undefined);
    assert.match(latest.solana.error, /No Solana wallet detected/);
  } finally {
    unmount();
  }
});

test("MOCK SEAM: armed AND the family is genuinely empty → the mock fires (the ONLY allowed case)", async () => {
  const discovery = makeDiscovery(); // no wallet installed
  const { latest, unmount } = renderWithDiscovery(discovery, true);
  try {
    await act(async () => {
      await latest.evm.connect();
    });
    assert.equal(latest.evm.status, "connected");
    assert.equal(latest.evm.address, MOCK_ADDRESSES.evm, "dev/test mock used when nothing is discovered");
  } finally {
    unmount();
  }
});

test("MOCK SEAM: armed but a REAL wallet IS discovered → still NO mock (no masquerade)", async () => {
  // Even with the seam armed, a family that HAS a discovered wallet never
  // gets the mock: the user must connect their real wallet.
  const discovery = makeDiscovery({
    discovered: { evm: [{ rdns: "io.metamask" }], solana: [], bitcoin: [], litecoin: [], dogecoin: [], xrp: [], tron: [] },
    resolve: () => null,
  });
  const { latest, unmount } = renderWithDiscovery(discovery, true);
  try {
    await act(async () => {
      await latest.evm.connect("starport");
    });
    assert.equal(latest.evm.status, "error");
    assert.equal(latest.evm.address, undefined);
    assert.notEqual(latest.evm.address, MOCK_ADDRESSES.evm);
  } finally {
    unmount();
  }
});

/* Non-Starport user: discovered MetaMask (EIP-6963) + Phantom (Wallet Standard)
 * connect through their OWN providers with no Starport anywhere in the path. */
test("NON-STARPORT user: MetaMask (EIP-6963) + Phantom (Wallet Standard) connect via discovery — no Starport", async () => {
  const metamask = {
    id: "eip6963:io.metamask", isReal: true,
    async connect() { return { family: "evm", address: "0xMETAMASKreal", provider: this }; },
  };
  const phantom = {
    id: "wallet-standard:Phantom", isReal: true,
    async connect() { return { family: "solana", address: "PhantomRealAddr111111111111111111111111111111", provider: this }; },
  };
  const discovery = makeDiscovery({
    discovered: {
      evm: [{ rdns: "io.metamask", name: "MetaMask" }],
      solana: [{ name: "Phantom" }],
      bitcoin: [], litecoin: [], dogecoin: [], xrp: [], tron: [],
    },
    resolve: (family, walletId) =>
      family === "evm" && walletId === "io.metamask"
        ? metamask
        : family === "solana" && walletId === "Phantom"
          ? phantom
          : null,
  });
  const { latest, unmount } = renderWithDiscovery(discovery);
  try {
    await act(async () => {
      await latest.evm.connect("io.metamask");
      await latest.solana.connect("Phantom");
    });
    assert.equal(latest.evm.status, "connected");
    assert.equal(latest.evm.address, "0xMETAMASKreal");
    assert.equal(latest.evm.provider.id, "eip6963:io.metamask");
    assert.equal(latest.solana.status, "connected");
    assert.equal(latest.solana.address, "PhantomRealAddr111111111111111111111111111111");
    assert.equal(latest.solana.provider.id, "wallet-standard:Phantom");
  } finally {
    unmount();
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
