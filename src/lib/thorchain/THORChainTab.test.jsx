/**
 * THORChainTab.test.jsx — flag-gated rendering of the THORChain lane inside
 * the one card (Steps 3.1 + 3.2).
 *
 * docs/BRIEF.md: the whole THORChain flow is ONE card with sequential states
 * inside the THORChain tab (quote → deposit address → progress → done), and
 * everything renders only when flags.THORCHAIN is true. These tests prove:
 *   - flag OFF → the THORChain tab shows the generic placeholder (the lane is
 *     never mounted unconditionally).
 *   - flag ON → the tab mounts THORChainTab (quote placeholder — Step 3.3
 *     builds it; the deposit + progress states are Steps 3.2 / 3.1).
 *   - a hook payload (initialHop) drops the tab straight into the progress
 *     state, and a pending persisted hop resumes into progress on mount.
 *   - Step 3.2: the deposit stage renders inside the tab, blocks without a
 *     Solana wallet, greys out halted chains, and its submit hook emits the
 *     payload → advances to progress + persists the hop (closed-tab resume).
 */

/**
 * HARNESS NOTE: `./jsdomSetup.js` MUST stay the FIRST import — it creates
 * the JSDOM and sets the DOM globals before react/react-dom evaluate, so
 * react-dom's one-time `canUseDOM`/`isInputEventSupported` checks see a real
 * DOM (see jsdomSetup.js for the full explanation). Importing it after react
 * silently breaks every controlled-input event in this file.
 */
import { dom } from "./jsdomSetup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider } from "../wallet/WalletContext.jsx";
import BridgeCard from "../../components/BridgeCard.jsx";
import THORChainTab from "../../components/THORChainTab.jsx";
import { createThorchainStorage } from "./storage.js";
import { createInitialState } from "../wallet/walletReducer.js";
import { MOCK_ADDRESSES } from "../wallet/mockProviders.js";

const HOP = { inboundTxid: "tx-abc", sourceChain: "BTC", destination: "SOL", expectedAmountOut: 0.05 };

/** A Solana-connected initialState (the deposit stage needs a destination). */
function initialStateWithSolana(address = MOCK_ADDRESSES.solana) {
  const state = createInitialState();
  state.solana = { family: "solana", status: "connected", address, provider: null, error: null };
  return state;
}

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

function render(element, opts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        WalletProvider,
        { discovery: FAKE_DISCOVERY, ...(opts.initialState ? { initialState: opts.initialState } : {}) },
        element,
      ),
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

test("flag ON: the THORChain tab mounts THORChainTab (quote state placeholder — Step 3.3)", () => {
  const { container, unmount } = render(React.createElement(BridgeCard, { flags: { THORCHAIN: true } }));
  try {
    click(container.querySelector('[data-tab="thorchain"]'));
    const placeholder = container.querySelector('[data-testid="thorchain-placeholder"]');
    assert.ok(placeholder, "THORChainTab mounted");
    assert.match(placeholder.textContent, /THORChain lane — quote/);
    assert.match(placeholder.textContent, /Step 3\.3/, "quote state is a clearly-marked placeholder");
  } finally {
    unmount();
  }
});

test("flag ON + hook payload: the tab drops straight into the PROGRESS state", () => {
  const { container, unmount } = render(
    React.createElement(THORChainTab, { initialHop: HOP, createPoller: fakePollerFactory() }),
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
    React.createElement(THORChainTab, { storage, createPoller: fakePollerFactory() }),
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

// ── STEP 3.2: the deposit-address stage inside the tab ──

/** Fake inbound refresher factory for the tab-level deposit tests. */
function fakeRefresherFactory() {
  const instances = [];
  const factory = (deps) => {
    const inst = {
      deps,
      started: null,
      stopped: false,
      start(opts) { inst.started = opts; },
      stop() { inst.stopped = true; },
      pushEntries(entries) { inst.started?.onUpdate?.(entries); },
      pushError(msg) { inst.started?.onError?.(msg); },
    };
    instances.push(inst);
    return inst;
  };
  factory.instances = instances;
  return factory;
}

const INBOUND = [
  { chain: "BTC", address: "bc1qdepositvault123", halted: false },
  { chain: "DOGE", address: "DDepositVault456", halted: false },
  { chain: "LTC", address: "ltc1depositvault789", halted: false },
  { chain: "XRP", address: "rDepositVaultXRP", halted: false },
];

const STUB_QR = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

/** Fake status poller factory (mirrors fakeRefresherFactory): the progress
 *  stage's poll loop is driven by the test, never by the network. */
function fakePollerFactory() {
  const instances = [];
  const factory = (deps) => {
    const inst = {
      deps,
      started: null,
      stopped: false,
      start(opts) { inst.started = opts; },
      stop() { inst.stopped = true; },
      // test helpers
      pushStage(stage) { inst.started?.onStage?.(stage); },
      pushHalted() { inst.started?.onHalted?.(); },
      pushError(msg) { inst.started?.onError?.(msg); },
      pushTimeout() { inst.started?.onTimeout?.(); },
      pushDone() { inst.started?.onDone?.(); },
    };
    instances.push(inst);
    return inst;
  };
  factory.instances = instances;
  return factory;
}

// React tracks controlled-input values with an own-property setter that
// updates its internal tracker on assignment — so a plain `el.value = x`
// followed by an "input" event looks like "no change" and onChange never
// fires. The native prototype setter bypasses React's tracker: the value
// changes in the DOM, the tracker stays stale, and the input event sees the
// delta. (Same trick @testing-library/user-event uses.)
const nativeValueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
const setInput = (el, value) => act(() => {
  nativeValueSetter.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});

test("3.2: the quote placeholder links into the DEPOSIT stage", () => {
  const storage = createThorchainStorage(memBackend());
  const refresher = fakeRefresherFactory();
  const { container, unmount } = render(
    React.createElement(THORChainTab, { storage, createInboundRefresher: refresher }),
  );
  try {
    click(container.querySelector('[data-testid="tc-continue-deposit"]'));
    const deposit = container.querySelector('[data-testid="tc-deposit"]');
    assert.ok(deposit, "deposit stage renders from the quote placeholder");
    assert.match(deposit.textContent, /Deposit address/);
  } finally {
    unmount();
  }
});

test("3.2: no Solana wallet → the deposit stage blocks with 'connect a Solana wallet first'", () => {
  const storage = createThorchainStorage(memBackend());
  const refresher = fakeRefresherFactory();
  const { container, unmount } = render(
    React.createElement(THORChainTab, { storage, createInboundRefresher: refresher }),
  );
  try {
    click(container.querySelector('[data-testid="tc-continue-deposit"]'));
    const block = container.querySelector('[data-testid="tc-deposit-no-solana"]');
    assert.ok(block);
    assert.match(block.textContent, /Connect a Solana wallet first/);
  } finally {
    unmount();
  }
});

test("3.2: deposit submit emits the hook payload → the tab advances to PROGRESS and persists the hop", () => {
  const storage = createThorchainStorage(memBackend());
  const refresher = fakeRefresherFactory();
  const { container, unmount } = render(
    React.createElement(THORChainTab, {
      storage,
      createInboundRefresher: refresher,
      createPoller: fakePollerFactory(),
      qrFactory: async () => STUB_QR,
    }),
    { initialState: initialStateWithSolana() },
  );
  try {
    click(container.querySelector('[data-testid="tc-continue-deposit"]'));
    act(() => refresher.instances[0].pushEntries(INBOUND));

    const dest = container.querySelector('[data-testid="tc-destination-input"]');
    assert.equal(dest.value, MOCK_ADDRESSES.solana, "destination = the Solana session's public key");
    assert.equal(dest.readOnly, true);

    setInput(container.querySelector('[data-testid="tc-txid-input"]'), "tx-deposit-1");
    click(container.querySelector('[data-testid="tc-submit"]'));

    // Advanced into the Step 3.1 progress state with the emitted payload.
    const progress = container.querySelector('[data-testid="thorchain-progress"]');
    assert.ok(progress, "submit advances the tab into the progress state");
    assert.ok(progress.textContent.includes("tx-deposit-1"), "the inbound txid is the hop's");
    assert.ok(progress.textContent.includes("BTC → Solana → X1"), "sourceChain from the payload");

    // Closed-tab resume: the hop was persisted at submit time.
    const persisted = storage.loadHop("tx-deposit-1");
    assert.ok(persisted, "hop persisted on submit");
    assert.equal(persisted.stage, "observed");
    assert.deepEqual(persisted.payload, {
      inboundTxid: "tx-deposit-1",
      sourceChain: "BTC",
      destination: MOCK_ADDRESSES.solana,
    });
  } finally {
    unmount();
  }
});

test("3.2: halted chain greys out in the tab's deposit stage", () => {
  const storage = createThorchainStorage(memBackend());
  const refresher = fakeRefresherFactory();
  const { container, unmount } = render(
    React.createElement(THORChainTab, { storage, createInboundRefresher: refresher }),
    { initialState: initialStateWithSolana() },
  );
  try {
    click(container.querySelector('[data-testid="tc-continue-deposit"]'));
    act(() =>
      refresher.instances[0].pushEntries([
        ...INBOUND,
        { chain: "DOGE", address: "DDepositVault456", halted: true },
      ]),
    );
    const doge = container.querySelector('[data-testid="tc-source-DOGE"]');
    assert.equal(doge.getAttribute("data-halted"), "true");
    assert.equal(doge.disabled, true);
    assert.match(doge.textContent, /paused/);
  } finally {
    unmount();
  }
});

test("3.2: back link returns from the deposit stage to the quote placeholder", () => {
  const storage = createThorchainStorage(memBackend());
  const refresher = fakeRefresherFactory();
  const { container, unmount } = render(
    React.createElement(THORChainTab, { storage, createInboundRefresher: refresher }),
    { initialState: initialStateWithSolana() },
  );
  try {
    click(container.querySelector('[data-testid="tc-continue-deposit"]'));
    assert.ok(container.querySelector('[data-testid="tc-deposit"]'));
    click(container.querySelector('[data-testid="tc-back"]'));
    assert.ok(container.querySelector('[data-testid="thorchain-placeholder"]'), "back at the quote placeholder");
  } finally {
    unmount();
  }
});
