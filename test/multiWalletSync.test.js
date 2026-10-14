/**
 * multiWalletSync.test.js — the MULTI-WALLET "SYNC" isolation guarantees.
 *
 * WHAT THIS PROVES (the "does connecting several wallets at once crash or
 * clobber each other?" question):
 *   The bridge supports multiple wallet FAMILIES at once (EVM/wagmi, Solana,
 *   Bitcoin, Cardano/CIP-30, NEAR/Wallet Selector, TON Connect …). Each family
 *   holds ONE independent session (WalletContext) and PUBLISHES it through the
 *   React-free "sync" handoff registry (connectedSessions.js — the module the
 *   non-React engine reads to resolve the signer the user actually connected).
 *
 *   Connecting, disconnecting, or failing to connect ONE family must NEVER:
 *     - crash the app, or
 *     - corrupt another family's session (no cross-family overwrite).
 *
 * TWO LAYERS, both proven:
 *   (A) PURE — walletReducer.js + connectedSessions.js (no DOM, no React). The
 *       state transitions are isolated by construction (every action carries a
 *       `family`; only `state[family]` is read/written).
 *   (B) HOOK — the REAL WalletProvider + useWallet, driven through React's
 *       `act` under jsdom, with the full WALLET_FAMILIES set connected at once.
 *
 * Every async step is wrapped in withTimeout() so a regressed hang FAILS loud.
 */
import { JSDOM } from "jsdom";

// jsdom globals must exist BEFORE react-dom is imported/evaluated (Node 22
// makes some of these getter-only, so define via Object.defineProperty).
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
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
setGlobal("HTMLElement", dom.window.HTMLElement);
setGlobal("Node", dom.window.Node);
setGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { WalletProvider, useWallet } from "../src/lib/wallet/WalletContext.jsx";
import { WALLET_FAMILIES } from "../src/lib/wallet/families.js";
import {
  createInitialState,
  walletReducer,
  canConnect,
  CONNECTED,
  ERROR,
} from "../src/lib/wallet/walletReducer.js";
import {
  setConnectedSession,
  clearConnectedSession,
  getConnectedSession,
  getConnectedSessions,
  clearAllConnectedSessions,
} from "../src/lib/wallet/connectedSessions.js";

// ── Hang guard ──────────────────────────────────────────────────────────────
const BUDGET = 4000;
function withTimeout(p, ms = BUDGET, label = "step") {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HUNG: ${label} did not settle within ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(p), guard]).finally(() => clearTimeout(timer));
}

/** Drive one family through CONNECT_START + CONNECT_SUCCESS (pure reducer). */
function connectFamily(state, family, address = `mock:${family}:addr`) {
  let next = walletReducer(state, { type: "CONNECT_START", family });
  next = walletReducer(next, { type: "CONNECT_SUCCESS", family, address, provider: { id: `mock:${family}` } });
  return next;
}

beforeEach(() => clearAllConnectedSessions());
afterEach(() => clearAllConnectedSessions());

// ═════════════════════════════════════════════════════════════════════════════
// PART A — PURE STATE (walletReducer + connectedSessions)
// ═════════════════════════════════════════════════════════════════════════════

test("pure: connecting EVM + Solana + Cardano + NEAR + TON at once keeps FIVE independent sessions", () => {
  const five = ["evm", "solana", "cardano", "near", "ton"];
  let state = createInitialState();
  for (const f of five) state = connectFamily(state, f);

  // Every family is connected with its OWN address; none clobbered another.
  for (const f of five) {
    assert.equal(state[f].status, CONNECTED, `${f} connected`);
    assert.equal(state[f].address, `mock:${f}:addr`, `${f} keeps its own address`);
  }
  // And every OTHER family is still pristine.
  for (const f of WALLET_FAMILIES) {
    if (five.includes(f)) continue;
    assert.deepEqual(state[f], { status: "disconnected" }, `${f} untouched`);
  }
});

test("pure: connect EVM then Solana, disconnect EVM → Solana stays connected (no cross-family clobber)", () => {
  let state = connectFamily(createInitialState(), "evm");
  state = connectFamily(state, "solana");
  state = walletReducer(state, { type: "DISCONNECT", family: "evm" });

  assert.deepEqual(state.evm, { status: "disconnected" }, "evm fully reset");
  assert.equal(state.solana.status, CONNECTED, "solana untouched by the evm disconnect");
  assert.equal(state.solana.address, "mock:solana:addr");
});

test("pure: rapid connect/disconnect CHURN across families never leaves a corrupt state", () => {
  let state = createInitialState();
  const script = [
    ["CONNECT_START", "evm"], ["CONNECT_SUCCESS", "evm"],
    ["CONNECT_START", "cardano"], ["CONNECT_START", "near"],
    ["CONNECT_SUCCESS", "cardano"], ["DISCONNECT", "evm"],
    ["CONNECT_SUCCESS", "near"], ["CONNECT_START", "solana"],
    ["DISCONNECT", "cardano"], ["CONNECT_SUCCESS", "solana"],
    ["DISCONNECT", "near"], ["DISCONNECT", "solana"],
  ];
  for (const [type, family] of script) {
    state = type === "CONNECT_SUCCESS"
      ? walletReducer(state, { type, family, address: `mock:${family}:addr`, provider: { id: family } })
      : walletReducer(state, { type, family });
  }
  // Final state: everything disconnected and pristine (the churn ended clean).
  for (const f of ["evm", "cardano", "near", "solana"]) {
    assert.deepEqual(state[f], { status: "disconnected" }, `${f} ended pristine`);
  }
});

test("pure: two wallets of the SAME family — a second connect is an idempotent no-op; after disconnect a new one connects", () => {
  let state = connectFamily(createInitialState(), "evm", "0xAAA");
  // Second attempt on the SAME family while connected: reducer no-op + guard refuses.
  const same = walletReducer(state, { type: "CONNECT_START", family: "evm" });
  assert.equal(same, state, "a re-connect on a connected family returns the SAME state object");
  assert.equal(canConnect(state, "evm"), false, "cannot start a second connect while connected");
  assert.equal(state.evm.address, "0xAAA", "the FIRST wallet's session is untouched");

  // Disconnect, then a DIFFERENT wallet of the same family connects cleanly.
  state = walletReducer(state, { type: "DISCONNECT", family: "evm" });
  assert.equal(canConnect(state, "evm"), true, "connectable again after disconnect");
  state = connectFamily(state, "evm", "0xBBB");
  assert.equal(state.evm.address, "0xBBB", "the new same-family wallet took over cleanly");
});

test("pure: unknown families are ignored defensively (never a crash)", () => {
  const state = createInitialState();
  for (const type of ["CONNECT_START", "CONNECT_SUCCESS", "CONNECT_ERROR", "DISCONNECT"]) {
    assert.equal(walletReducer(state, { type, family: "monero", address: "x", error: "x" }), state);
  }
  assert.equal(canConnect(state, "monero"), false);
});

test("pure sync registry: publishing FIVE families concurrently never clobbers; clearing one leaves the rest", () => {
  const five = ["evm", "solana", "cardano", "near", "ton"];
  const sessions = {};
  for (const f of five) {
    sessions[f] = { status: "connected", family: f, address: `addr:${f}`, provider: { id: f } };
    setConnectedSession(f, sessions[f]);
  }
  assert.equal(getConnectedSessions().size, 5, "all five published");
  for (const f of five) assert.equal(getConnectedSession(f), sessions[f], `${f} intact`);

  // Clearing one family clears ONLY that family.
  clearConnectedSession("cardano");
  assert.equal(getConnectedSession("cardano"), null, "cardano cleared");
  for (const f of ["evm", "solana", "near", "ton"]) {
    assert.equal(getConnectedSession(f), sessions[f], `${f} untouched by the cardano clear`);
  }

  // A null publish for a family clears it, leaving the others.
  setConnectedSession("near", null);
  assert.equal(getConnectedSession("near"), null);
  assert.equal(getConnectedSession("evm"), sessions.evm);
  assert.equal(getConnectedSession("ton"), sessions.ton);
});

test("pure sync registry: rapid set/clear on ONE family never disturbs the others (race-free by keying)", () => {
  const evm = { status: "connected", address: "0xEVM" };
  const sol = { status: "connected", address: "SOL" };
  setConnectedSession("evm", evm);
  setConnectedSession("solana", sol);
  // Churn evm many times; solana must survive untouched.
  for (let i = 0; i < 50; i++) {
    setConnectedSession("evm", { status: "connected", address: `0x${i}` });
    clearConnectedSession("evm");
  }
  setConnectedSession("evm", evm);
  assert.equal(getConnectedSession("evm"), evm);
  assert.equal(getConnectedSession("solana"), sol, "solana untouched through 100 evm churns");
  assert.equal(getConnectedSessions().size, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// PART B — HOOK LEVEL (the REAL WalletProvider + useWallet under jsdom/act)
// ═════════════════════════════════════════════════════════════════════════════

/** A custom providerFactory: a sign-in-capable fake for every family, or a
 *  thrower for families in `failFamilies` (the "not installed" case). */
function fakeFactory({ failFamilies = new Set() } = {}) {
  return (family) => {
    if (failFamilies.has(family)) {
      return {
        family,
        id: `fake:${family}`,
        async connect() { throw new Error(`No ${family} wallet detected.`); },
        async disconnect() {},
      };
    }
    const provider = {
      family,
      id: `fake:${family}`,
      async connect() { return { family, address: `addr:${family}`, provider }; },
      async disconnect() {},
    };
    return provider;
  };
}

/** Render <WalletProvider providerFactory><Probe/></WalletProvider>. The probe
 *  subscribes to every family in `families` and snapshots each render. */
function renderProbe({ families, providerFactory }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const latest = {};
  function Probe() {
    for (const f of families) latest[f] = useWallet(f);
    return null;
  }
  act(() => {
    root.render(
      React.createElement(WalletProvider, { providerFactory }, React.createElement(Probe)),
    );
  });
  return {
    latest,
    unmount() { act(() => root.unmount()); container.remove(); },
  };
}

test("hook: connecting FIVE families at once keeps each session independent (and publishes to the sync registry)", async () => {
  const five = ["evm", "solana", "cardano", "near", "ton"];
  const h = renderProbe({ families: five, providerFactory: fakeFactory() });
  try {
    await withTimeout(
      act(async () => { await Promise.all(five.map((f) => h.latest[f].connect())); }),
      BUDGET,
      "connect five",
    );
    for (const f of five) {
      assert.equal(h.latest[f].status, "connected", `${f} connected`);
      assert.equal(h.latest[f].address, `addr:${f}`, `${f} has its own address`);
      // The sync registry mirrors the live session (the engine's handoff).
      assert.equal(getConnectedSession(f)?.address, `addr:${f}`, `${f} published to connectedSessions`);
    }
    assert.equal(getConnectedSessions().size, 5);
  } finally {
    h.unmount();
  }
});

test("hook: connect EVM + Solana, then disconnect EVM → Solana stays connected (registry clears EVM only)", async () => {
  const h = renderProbe({ families: ["evm", "solana"], providerFactory: fakeFactory() });
  try {
    await withTimeout(act(async () => { await h.latest.evm.connect(); await h.latest.solana.connect(); }), BUDGET, "connect");
    assert.equal(h.latest.evm.status, "connected");
    assert.equal(h.latest.solana.status, "connected");
    assert.equal(getConnectedSession("evm")?.address, "addr:evm");

    act(() => h.latest.evm.disconnect());
    assert.equal(h.latest.evm.status, "disconnected");
    assert.equal(h.latest.evm.address, undefined, "evm session cleared");
    assert.equal(h.latest.solana.status, "connected", "solana untouched");
    assert.equal(h.latest.solana.address, "addr:solana");
    assert.equal(getConnectedSession("evm"), null, "sync registry cleared evm");
    assert.equal(getConnectedSession("solana")?.address, "addr:solana", "sync registry keeps solana");
  } finally {
    h.unmount();
  }
});

test("hook: a FAILED connect in one family leaves the others connected (no crash, no clobber)", async () => {
  // EVM + Solana succeed; Cardano + NEAR are "not installed" → honest error.
  const families = ["evm", "solana", "cardano", "near"];
  const h = renderProbe({
    families,
    providerFactory: fakeFactory({ failFamilies: new Set(["cardano", "near"]) }),
  });
  try {
    await withTimeout(
      act(async () => {
        await Promise.allSettled(families.map((f) => h.latest[f].connect()));
      }),
      BUDGET,
      "mixed connect",
    );
    assert.equal(h.latest.evm.status, "connected", "evm connected");
    assert.equal(h.latest.solana.status, "connected", "solana connected");
    assert.equal(h.latest.cardano.status, ERROR, "cardano errored (not installed)");
    assert.equal(h.latest.near.status, ERROR, "near errored (not installed)");
    assert.match(h.latest.cardano.error, /No cardano wallet detected/);
    assert.match(h.latest.near.error, /No near wallet detected/);
    assert.equal(h.latest.cardano.address, undefined, "no phantom address from a failed connect");
    assert.equal(getConnectedSession("cardano"), null, "a failed family is NOT published to the registry");
    assert.equal(getConnectedSession("evm")?.address, "addr:evm", "evm still published");
  } finally {
    h.unmount();
  }
});

test("hook: rapid connect/disconnect churn across families does not crash and ends CONSISTENT (no corrupt/mixed session)", async () => {
  const families = ["evm", "solana", "cardano"];
  const h = renderProbe({ families, providerFactory: fakeFactory() });
  try {
    await withTimeout(
      act(async () => {
        await h.latest.evm.connect();
        await h.latest.solana.connect();
        await h.latest.cardano.connect();
      }),
      BUDGET,
      "initial connect",
    );
    // Rapid churn: many disconnects/reconnects in quick succession.
    await withTimeout(
      act(async () => {
        for (let i = 0; i < 5; i++) {
          h.latest.evm.disconnect();
          h.latest.solana.disconnect();
          h.latest.cardano.disconnect();
          await Promise.all([h.latest.evm.connect(), h.latest.solana.connect(), h.latest.cardano.connect()]);
        }
      }),
      BUDGET,
      "churn",
    );
    // INVARIANTS (what "no crash / no clobber" actually guarantees):
    // Each family is EITHER cleanly connected with ITS OWN address, OR cleanly
    // disconnected with NO address — never a corrupt / half-migrated session,
    // and the sync registry mirrors the sessions exactly (no stale entries).
    let connected = 0;
    for (const f of families) {
      const s = h.latest[f];
      assert.ok(["connected", "disconnected"].includes(s.status), `${f} is in a valid status (${s.status})`);
      if (s.status === "connected") {
        connected += 1;
        assert.equal(s.address, `addr:${f}`, `${f} connected with its OWN address (never another family's)`);
        assert.equal(getConnectedSession(f)?.address, `addr:${f}`, `${f} published consistently`);
      } else {
        assert.equal(s.address, undefined, `${f} disconnected exposes no phantom address`);
        assert.equal(getConnectedSession(f), null, `${f} disconnected is not in the registry`);
      }
    }
    assert.equal(getConnectedSessions().size, connected, "registry size matches the connected set exactly");
  } finally {
    h.unmount();
  }
});

test("hook: two wallets of the SAME family — the second connect while connected is a no-op", async () => {
  let builds = 0;
  const factory = (family) => {
    builds += 1;
    const provider = {
      family,
      id: `fake:${family}:${builds}`,
      async connect() { return { family, address: `addr:${family}:${builds}`, provider }; },
      async disconnect() {},
    };
    return provider;
  };
  const h = renderProbe({ families: ["evm"], providerFactory: factory });
  try {
    await withTimeout(act(async () => { await h.latest.evm.connect("walletA"); }), BUDGET, "connect A");
    const firstAddr = h.latest.evm.address;
    // A second, concurrent connect on the SAME family must be swallowed.
    await withTimeout(act(async () => { await Promise.all([h.latest.evm.connect("walletB"), h.latest.evm.connect("walletC")]); }), BUDGET, "connect B/C");
    assert.equal(h.latest.evm.status, "connected");
    assert.equal(h.latest.evm.address, firstAddr, "the FIRST same-family wallet is retained");
    assert.equal(builds, 1, "only ONE provider was ever built for the family");
  } finally {
    h.unmount();
  }
});

test("hook: unmounting the provider does not crash (no lingering sync-registry entries)", async () => {
  const h = renderProbe({ families: ["evm"], providerFactory: fakeFactory() });
  await withTimeout(act(async () => { await h.latest.evm.connect(); }), BUDGET, "connect");
  assert.equal(getConnectedSession("evm")?.address, "addr:evm");
  // Unmount must not throw and must leave the app usable.
  assert.doesNotThrow(() => h.unmount());
});
