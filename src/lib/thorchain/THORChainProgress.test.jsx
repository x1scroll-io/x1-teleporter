/**
 * THORChainProgress.test.jsx — the hop/progress component (Step 3.1).
 *
 * jsdom + React 18 act, same harness as ConnectModal.test.jsx. Everything is
 * injected: a fake poller factory drives the THORChain stage callbacks, a
 * fake landing watcher drives the SOL landing, an in-memory storage backend
 * asserts the persist/resume contract, and a mock advance asserts the
 * auto-advance wiring. No timers, no network, no wallet globals.
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
import THORChainProgress, { STAGE_SEQUENCE } from "../../components/THORChainProgress.jsx";
import { createThorchainStorage, HOP_KEY_PREFIX } from "./storage.js";

const HOP = { inboundTxid: "tx-abc", sourceChain: "BTC", destination: "SOL", expectedAmountOut: 0.05 };
const SOL_ADDR = "FakeSolanaAddress11111111111111111111111111111111";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Deterministically wait for an element to appear in the container. Used
 * where REAL async work must settle before an assertion runs — e.g. the
 * default wiring's lazy dynamic import (autoAdvance.js getLifi()) happens
 * before the swap step reports the missing quote, and that import can
 * outlast a couple of macrotasks on a slow CI box. Bounded by a deadline:
 * if the element never appears we return and the test's own assertion
 * reports the failure — nothing is loosened, the timing is just made
 * deterministic.
 */
async function waitForBanner(container, selector, { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (container.querySelector(selector)) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** In-memory storage backend with getAll (isolated per test). */
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

/** Fake poller factory — the test drives stage callbacks by hand. */
function fakePollerFactory() {
  const instances = [];
  const factory = () => {
    const inst = {
      deps: null,
      started: null,
      stopped: false,
      start(opts) { inst.started = opts; },
      stop() { inst.stopped = true; },
      async tickNow() {},
      isRunning: () => !inst.stopped,
      // test helpers
      emitStage(s) { inst.started?.onStage?.(s); },
      emitHalted() { inst.started?.onHalted?.(); },
      emitError(m) { inst.started?.onError?.(m); },
      emitTimeout() { inst.started?.onTimeout?.(); },
      emitDone() { inst.started?.onDone?.(); },
    };
    instances.push(inst);
    return inst;
  };
  factory.instances = instances;
  return factory;
}

/** Fake landing watcher factory — the test drives landing by hand. */
function fakeWatcherFactory() {
  const instances = [];
  const factory = (deps) => {
    const inst = {
      deps,
      started: null,
      stopped: false,
      start(opts) { inst.started = opts; },
      stop() { inst.stopped = true; },
      async checkNow() {},
      isRunning: () => !inst.stopped,
      // test helpers
      emitLanded(b) { inst.started?.onLanded?.(b); inst.stopped = true; }, // the real watcher stops itself after landing
      emitTimeout() { inst.started?.onTimeout?.(); },
      emitError(m) { inst.started?.onError?.(m); },
    };
    instances.push(inst);
    return inst;
  };
  factory.instances = instances;
  return factory;
}

function renderProgress(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(THORChainProgress, props));
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

function stageState(container, stage) {
  const el = container.querySelector(`[data-testid="tc-stage-${stage}"]`);
  return el ? el.getAttribute("data-state") : null;
}

function baseProps(overrides = {}) {
  const createPoller = fakePollerFactory();
  const createLandingWatcher = fakeWatcherFactory();
  const storage = createThorchainStorage(memBackend());
  return {
    hop: HOP,
    storage,
    createPoller,
    createLandingWatcher,
    advance: async () => ({ ok: true, steps: [] }),
    getSolBalance: async () => 1.0,
    solAddress: SOL_ADDR,
    solWallet: { provider: { name: "Phantom" } },
    ...overrides,
  };
}

test("renders the stage sequence with the teleport-branded language", () => {
  const { container, unmount } = renderProgress(baseProps());
  try {
    assert.deepEqual(
      STAGE_SEQUENCE.map((s) => s.label),
      ["Charging", "In transit", "Rematerializing", "Landed"],
      "teleport sequence language",
    );
    const labels = [...container.querySelectorAll("[data-testid^='tc-stage-']")]
      .filter((el) => el.getAttribute("data-testid") !== "tc-stage-list")
      .map((el) => el.textContent);
    assert.ok(labels[0].includes("Charging"));
    assert.ok(labels[1].includes("In transit"));
    assert.ok(labels[2].includes("Rematerializing"));
    assert.ok(labels[3].includes("Landed"));
    assert.ok(container.querySelector('[data-testid="tc-meta"]').textContent.includes("0.05 SOL"));
  } finally {
    unmount();
  }
});

test("starts the poller with the hook payload and drives stages into the DOM", async () => {
  const createPoller = fakePollerFactory();
  const { container, unmount } = renderProgress(baseProps({ createPoller }));
  try {
    const poller = createPoller.instances[0];
    assert.ok(poller.started, "poller started on mount");
    assert.equal(poller.started.inboundTxid, "tx-abc");
    assert.equal(poller.started.initialStage, null);

    await act(async () => {
      poller.emitStage("observed");
      await flush();
    });
    assert.equal(stageState(container, "observed"), "active");

    await act(async () => {
      poller.emitStage("swapping");
      await flush();
    });
    assert.equal(stageState(container, "observed"), "done");
    assert.equal(stageState(container, "swapping"), "active");

    await act(async () => {
      poller.emitStage("outbound_signed");
      await flush();
    });
    assert.equal(stageState(container, "outbound_signed"), "active");

    await act(async () => {
      poller.emitStage("done");
      await flush();
    });
    assert.equal(stageState(container, "done"), "active");
  } finally {
    unmount();
  }
});

test("persists {inboundTxid, stage} on every stage change (closed-tab resume data)", async () => {
  const storage = createThorchainStorage(memBackend());
  const createPoller = fakePollerFactory();
  const { unmount } = renderProgress(baseProps({ storage, createPoller }));
  try {
    const poller = createPoller.instances[0];
    await act(async () => {
      poller.emitStage("observed");
      poller.emitStage("swapping");
      await flush();
    });

    const entry = storage.loadHop("tx-abc");
    assert.equal(entry.inboundTxid, "tx-abc");
    assert.equal(entry.stage, "swapping");
    assert.deepEqual(entry.payload, HOP, "hook payload persisted alongside the stage");
    assert.ok(entry.updatedAt > 0);
  } finally {
    unmount();
  }
});

test("resume: a persisted pending hop restarts polling from its persisted stage", async () => {
  const storage = createThorchainStorage(memBackend());
  storage.saveHop({ inboundTxid: "tx-abc", stage: "outbound_signed", payload: HOP });
  const createPoller = fakePollerFactory();

  const { container, unmount } = renderProgress(baseProps({ storage, createPoller }));
  try {
    const poller = createPoller.instances[0];
    assert.equal(poller.started.initialStage, "outbound_signed", "poller resumes from the persisted stage");
    assert.equal(stageState(container, "outbound_signed"), "active", "UI shows the persisted stage immediately");
    assert.equal(stageState(container, "observed"), "done");

    // The persisted stage is NOT re-fired (no spurious onStage callback).
    await act(async () => {
      poller.emitStage("outbound_signed");
      await flush();
    });
    // Still just active — a re-emit of the same stage is a no-op for the UI.
    assert.equal(stageState(container, "outbound_signed"), "active");
  } finally {
    unmount();
  }
});

test("resume: the persisted payload wins over the freshly-passed hop", async () => {
  const storage = createThorchainStorage(memBackend());
  const persistedPayload = { ...HOP, expectedAmountOut: 0.123 };
  storage.saveHop({ inboundTxid: "tx-abc", stage: "swapping", payload: persistedPayload });
  const createPoller = fakePollerFactory();

  const { container, unmount } = renderProgress(baseProps({ storage, createPoller }));
  try {
    assert.ok(
      container.querySelector('[data-testid="tc-meta"]').textContent.includes("0.123 SOL"),
      "persisted expectedAmountOut used",
    );
  } finally {
    unmount();
  }
});

test("halted surfaces the paused-by-THORChain banner and keeps the stage", async () => {
  const createPoller = fakePollerFactory();
  const { container, unmount } = renderProgress(baseProps({ createPoller }));
  try {
    const poller = createPoller.instances[0];
    await act(async () => {
      poller.emitStage("observed");
      poller.emitHalted();
      await flush();
    });
    const banner = container.querySelector('[data-testid="tc-banner-paused"]');
    assert.ok(banner, "paused banner rendered");
    assert.match(banner.textContent, /Paused by THORChain/);
  } finally {
    unmount();
  }
});

test("status errors surface the retrying banner", async () => {
  const createPoller = fakePollerFactory();
  const { container, unmount } = renderProgress(baseProps({ createPoller }));
  try {
    const poller = createPoller.instances[0];
    await act(async () => {
      poller.emitError("status endpoint unreachable");
      await flush();
    });
    const banner = container.querySelector('[data-testid="tc-banner-error"]');
    assert.ok(banner);
    assert.match(banner.textContent, /status endpoint unreachable/);
  } finally {
    unmount();
  }
});

test("timeout renders the still-waiting banner (funds safe, progress saved)", async () => {
  const createPoller = fakePollerFactory();
  const { container, unmount } = renderProgress(baseProps({ createPoller }));
  try {
    await act(async () => {
      createPoller.instances[0].emitTimeout();
      await flush();
    });
    const banner = container.querySelector('[data-testid="tc-banner-timeout"]');
    assert.ok(banner);
    assert.match(banner.textContent, /funds are safe/);
  } finally {
    unmount();
  }
});

test("on done → SOL landing detection → advance fires → arrived + storage cleared", async () => {
  const storage = createThorchainStorage(memBackend());
  const createPoller = fakePollerFactory();
  const createLandingWatcher = fakeWatcherFactory();
  const advanceCalls = [];
  const advance = async (hop) => {
    advanceCalls.push(hop);
    return { ok: true, steps: [{ id: "swap" }, { id: "skim" }, { id: "warp" }] };
  };
  const balances = [1.0, 1.05];
  let balanceIdx = 0;
  const getSolBalance = async () => balances[balanceIdx++];

  const { container, unmount } = renderProgress(
    baseProps({ storage, createPoller, createLandingWatcher, advance, getSolBalance }),
  );
  try {
    const poller = createPoller.instances[0];
    await act(async () => {
      poller.emitStage("done");
      poller.emitDone(); // the real poller fires onDone after the done stage
      await flush(); // beginLanding reads the baseline balance
    });
    assert.ok(
      container.querySelector('[data-testid="tc-banner-advancing"]') === null,
      "not advancing yet — still watching for the landing",
    );

    const watcher = createLandingWatcher.instances[0];
    assert.ok(watcher.started, "landing watcher started after done");
    assert.equal(watcher.started.balanceBefore, 1.0, "baseline = balance at done");
    assert.equal(watcher.started.expectedAmountOut, 0.05);

    await act(async () => {
      watcher.emitLanded(1.05);
      await flush(); // advance() promise resolves
      await flush();
    });

    assert.equal(advanceCalls.length, 1, "advance fired after the SOL landing");
    assert.equal(advanceCalls[0].inboundTxid, "tx-abc");
    assert.ok(container.querySelector('[data-testid="tc-banner-arrived"]'), "arrived banner rendered");
    assert.equal(storage.loadHop("tx-abc"), null, "completed hop removed from storage");
    assert.equal(watcher.stopped, true, "watcher stopped after landing");
  } finally {
    unmount();
  }
});

test("without a connected Solana wallet the flow lands in needs-wallet (hop stays saved)", async () => {
  const storage = createThorchainStorage(memBackend());
  const createPoller = fakePollerFactory();
  const advance = async () => { throw new Error("must not fire"); };

  const { container, unmount } = renderProgress(
    baseProps({ storage, createPoller, advance, solAddress: null, getSolBalance: null }),
  );
  try {
    const poller = createPoller.instances[0];
    await act(async () => {
      poller.emitStage("done");
      poller.emitDone();
      await flush();
    });
    const banner = container.querySelector('[data-testid="tc-banner-needs-wallet"]');
    assert.ok(banner, "needs-wallet banner rendered");
    assert.match(banner.textContent, /Connect your Solana wallet/);
    assert.equal(storage.loadHop("tx-abc").stage, "done", "stage persisted so a later visit resumes");
  } finally {
    unmount();
  }
});

test("a failed advance surfaces the Step 3.2 quote message (swap step) and keeps the hop saved", async () => {
  const storage = createThorchainStorage(memBackend());
  const createPoller = fakePollerFactory();
  const createLandingWatcher = fakeWatcherFactory();
  const advance = async () => ({ ok: false, failedStep: "swap", error: "auto-advance swap: ctx.lifiData (the SOL→USDC quote) is required" });

  const { container, unmount } = renderProgress(
    baseProps({ storage, createPoller, createLandingWatcher, advance }),
  );
  try {
    await act(async () => {
      createPoller.instances[0].emitStage("done");
      createPoller.instances[0].emitDone();
      await flush();
    });
    await act(async () => {
      createLandingWatcher.instances[0].emitLanded(1.05);
      await flush();
      await flush();
    });

    const banner = container.querySelector('[data-testid="tc-banner-advance-failed"]');
    assert.ok(banner, "advance-failed banner rendered");
    assert.match(banner.textContent, /Step 3\.2 deposit flow/);
    assert.ok(storage.loadHop("tx-abc"), "hop kept so the user can resume");
  } finally {
    unmount();
  }
});

test("default wiring (no advance prop): the real Step 3.1 actions run and report the missing-quote swap step", async () => {
  const storage = createThorchainStorage(memBackend());
  const createPoller = fakePollerFactory();
  const createLandingWatcher = fakeWatcherFactory();
  // No `advance` prop → the component wires the REAL actions (autoAdvance.js):
  // swap requires ctx.lifiData (Step 3.2), so the sequence stops at swap with
  // the honest "quote not wired yet" message instead of guessing.
  const { container, unmount } = renderProgress(
    baseProps({ storage, createPoller, createLandingWatcher, advance: undefined }),
  );
  try {
    await act(async () => {
      createPoller.instances[0].emitStage("done");
      createPoller.instances[0].emitDone();
      await flush();
    });
    await act(async () => {
      createLandingWatcher.instances[0].emitLanded(1.05);
      // The default wiring runs the REAL Step 3.1 actions: the swap step
      // lazily dynamic-imports the executor modules (autoAdvance.js getLifi())
      // before it can throw the missing-quote error. That is genuine async
      // work, so keep flushing until the banner is actually in the DOM
      // instead of assuming a fixed flush count is enough (CI is slower).
      await waitForBanner(container, '[data-testid="tc-banner-advance-failed"]');
    });

    const banner = container.querySelector('[data-testid="tc-banner-advance-failed"]');
    assert.ok(banner, "advance-failed banner rendered by the default wiring");
    assert.match(banner.textContent, /Step 3\.2 deposit flow/);
    assert.ok(storage.loadHop("tx-abc"), "hop kept so the user can resume");
  } finally {
    unmount();
  }
});

test("unmount stops the poller and the landing watcher", async () => {
  const createPoller = fakePollerFactory();
  const createLandingWatcher = fakeWatcherFactory();
  const { unmount } = renderProgress(baseProps({ createPoller, createLandingWatcher }));
  const poller = createPoller.instances[0];
  unmount();
  assert.equal(poller.stopped, true, "poller stopped on unmount");
});

test("requires an inboundTxid", () => {
  assert.throws(
    () => renderProgress(baseProps({ hop: { sourceChain: "BTC" } })),
    /inboundTxid is required/,
  );
});
