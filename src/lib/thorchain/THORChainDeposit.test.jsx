/**
 * THORChainDeposit.test.jsx — the deposit-address stage of the THORChain
 * tab (Step 3.2).
 *
 * jsdom + React 18 act, same harness as THORChainTab.test.jsx. Everything is
 * injected: a fake inbound-address refresher drives the vault/halted data,
 * a stub QR factory returns fixed SVG, the clipboard is stubbed, and the
 * submit hook captures the emitted payload. No timers, no network, no wallet
 * globals.
 *
 * Proves the acceptance points of this step:
 *   - destination prefilled from the Solana session + NOT editable
 *   - no Solana wallet → the stage blocks ("connect a Solana wallet first")
 *   - sources limited to BTC/DOGE/LTC/XRP; halted chains grey out with
 *     "paused by THORChain" and are not selectable
 *   - deposit address + memo (exact THORChain format) + QR displayed
 *   - refund address prefilled from the connected source-wallet session
 *   - the submit hook emits {inboundTxid, sourceChain, destination,
 *     expectedAmountOut} with the right shape
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
import THORChainDeposit, { THORCHAIN_SOURCES } from "../../components/THORChainDeposit.jsx";

const SOL_ADDR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BTC_VAULT = "bc1qdepositvault123";
const XRP_VAULT = "rDepositVaultXRP";

/** The four source ids — proves the source list is limited. */
const SOURCE_IDS = THORCHAIN_SOURCES.map((s) => s.id);

/** Fake inbound refresher factory: captures deps, lets the test push data. */
function fakeRefresherFactory() {
  const instances = [];
  const factory = (deps) => {
    const inst = {
      deps,
      started: null,
      stopped: false,
      start(opts) { inst.started = opts; },
      stop() { inst.stopped = true; },
      // test helpers
      pushEntries(entries) {
        inst.started?.onUpdate?.(entries);
      },
      pushError(msg) {
        inst.started?.onError?.(msg);
      },
    };
    instances.push(inst);
    return inst;
  };
  factory.instances = instances;
  return factory;
}

const STUB_QR = '<svg xmlns="http://www.w3.org/2000/svg" data-test="qr"><path d="M0 0"/></svg>';

const DEFAULT_INBOUND = [
  { chain: "BTC", address: BTC_VAULT, halted: false },
  { chain: "DOGE", address: "DDepositVault456", halted: false },
  { chain: "LTC", address: "ltc1depositvault789", halted: false },
  { chain: "XRP", address: XRP_VAULT, halted: false },
];

function render(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(THORChainDeposit, {
        solAddress: SOL_ADDR,
        solConnected: true,
        sourceSessions: {},
        onSubmit: () => {},
        createInboundRefresher: fakeRefresherFactory(),
        qrFactory: async () => STUB_QR,
        ...props,
      }),
    );
  });
  return {
    root,
    container,
    refresher: null, // set by tests that need it
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// React tracks controlled-input values with an own-property setter that
// updates its internal tracker on assignment — so a plain `el.value = x`
// followed by an "input" event looks like "no change" and onChange never
// fires. The native prototype setter bypasses React's tracker: the value
// changes in the DOM, the tracker stays stale, and the input event sees the
// delta. (Same trick @testing-library/user-event uses.)
const nativeValueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
const change = (el, value) => act(() => {
  nativeValueSetter.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});

test("sources are limited to BTC/DOGE/LTC/XRP", () => {
  assert.deepEqual(SOURCE_IDS, ["BTC", "DOGE", "LTC", "XRP"]);
  const { container, unmount } = render({});
  try {
    const buttons = container.querySelectorAll('[data-testid^="tc-source-"]');
    assert.equal(buttons.length, 4, "exactly four source buttons");
    assert.deepEqual(
      [...buttons].map((b) => b.getAttribute("data-testid").replace("tc-source-", "")),
      ["BTC", "DOGE", "LTC", "XRP"],
    );
  } finally {
    unmount();
  }
});

test("destination is prefilled from the Solana session and NOT editable", () => {
  const { container, unmount } = render({ solAddress: SOL_ADDR });
  try {
    const input = container.querySelector('[data-testid="tc-destination-input"]');
    assert.ok(input, "destination row renders");
    assert.equal(input.value, SOL_ADDR, "prefilled from the Solana session");
    assert.equal(input.readOnly, true, "never user-typed");
    assert.equal(input.getAttribute("tabindex"), "-1", "not focusable");
  } finally {
    unmount();
  }
});

test("no Solana wallet → the stage blocks with 'connect a Solana wallet first'", () => {
  const { container, unmount } = render({ solAddress: null, solConnected: false });
  try {
    const block = container.querySelector('[data-testid="tc-deposit-no-solana"]');
    assert.ok(block, "block message renders");
    assert.match(block.textContent, /Connect a Solana wallet first/);
    // No destination, no deposit card, no submit — the stage is blocked.
    assert.equal(container.querySelector('[data-testid="tc-destination-input"]'), null);
    assert.equal(container.querySelector('[data-testid="tc-deposit-card"]'), null);
    assert.equal(container.querySelector('[data-testid="tc-submit"]'), null);
  } finally {
    unmount();
  }
});

test("inbound addresses fetched on mount; vault address + memo + QR render for the selected chain", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    assert.equal(factory.instances.length, 1, "refresher created on mount");
    assert.equal(factory.instances[0].stopped, false);
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));

    const addr = container.querySelector('[data-testid="tc-deposit-address"]');
    assert.ok(addr, "deposit card renders once the vault list lands");
    assert.equal(addr.textContent, BTC_VAULT, "default source is BTC");

    const memo = container.querySelector('[data-testid="tc-memo"]');
    assert.equal(memo.textContent, `=:SOL.SOL:${SOL_ADDR}`, "exact THORChain memo format (no refund)");

    await act(async () => {
      await Promise.resolve();
    });
    const qr = container.querySelector('[data-testid="tc-qr"] svg');
    assert.ok(qr, "QR rendered from the deposit address");
    assert.match(qr.outerHTML, /data-test="qr"/, "stubbed QR SVG mounted");
  } finally {
    unmount();
  }
});

test("memo includes the refund address when one is entered (DEST/REFUND scheme)", () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    change(container.querySelector('[data-testid="tc-refund-input"]'), "bc1qrefundaddr99");
    const memo = container.querySelector('[data-testid="tc-memo"]');
    assert.equal(memo.textContent, `=:SOL.SOL:${SOL_ADDR}/bc1qrefundaddr99`);
  } finally {
    unmount();
  }
});

test("refund address prefills from the connected source-wallet session (Steps 2.3/2.4 rows feed this)", () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({
    createInboundRefresher: factory,
    sourceSessions: { bitcoin: { address: "bc1qconnectedwallet" } },
  });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    const refund = container.querySelector('[data-testid="tc-refund-input"]');
    assert.equal(refund.value, "bc1qconnectedwallet", "prefilled from the connected BTC session");
    const memo = container.querySelector('[data-testid="tc-memo"]');
    assert.equal(memo.textContent, `=:SOL.SOL:${SOL_ADDR}/bc1qconnectedwallet`);
  } finally {
    unmount();
  }
});

test("switching source swaps the deposit address + memo chain (XRP vault + note)", () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    act(() => container.querySelector('[data-testid="tc-source-XRP"]').click());

    const addr = container.querySelector('[data-testid="tc-deposit-address"]');
    assert.equal(addr.textContent, XRP_VAULT);
    const memo = container.querySelector('[data-testid="tc-memo"]');
    assert.equal(memo.textContent, `=:SOL.SOL:${SOL_ADDR}`);
    assert.match(container.querySelector('[data-testid="tc-memo-note"]').textContent, /XRPL Memos field/);
  } finally {
    unmount();
  }
});

test("halted chain greys out with 'paused by THORChain' and is not selectable", () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() =>
      factory.instances[0].pushEntries([
        ...DEFAULT_INBOUND,
        { chain: "LTC", address: "ltc1halted", halted: true },
      ]),
    );
    const ltc = container.querySelector('[data-testid="tc-source-LTC"]');
    assert.equal(ltc.getAttribute("data-halted"), "true");
    assert.equal(ltc.disabled, true, "halted chain cannot be selected");
    assert.match(ltc.textContent, /paused/);
    assert.equal(ltc.getAttribute("title"), "paused by THORChain");
  } finally {
    unmount();
  }
});

test("selecting a halted chain is impossible; a halted default chain shows the paused banner", () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    // BTC (the default) is halted.
    act(() =>
      factory.instances[0].pushEntries([
        { chain: "BTC", address: BTC_VAULT, halted: true },
        { chain: "DOGE", address: "DDepositVault456", halted: false },
      ]),
    );
    const banner = container.querySelector('[data-testid="tc-paused-banner"]');
    assert.ok(banner, "paused banner for the selected halted chain");
    assert.match(banner.textContent, /paused by THORChain/);
    // Submit is disabled while the selected chain is halted.
    change(container.querySelector('[data-testid="tc-txid-input"]'), "deadbeef");
    const submit = container.querySelector('[data-testid="tc-submit"]');
    assert.equal(submit.disabled, true);
  } finally {
    unmount();
  }
});

test("submit hook emits {inboundTxid, sourceChain, destination, expectedAmountOut}", () => {
  const factory = fakeRefresherFactory();
  const emitted = [];
  const { container, unmount } = render({
    createInboundRefresher: factory,
    onSubmit: (payload) => emitted.push(payload),
  });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    change(container.querySelector('[data-testid="tc-txid-input"]'), "  tx-abc-123  ");
    change(container.querySelector('[data-testid="tc-amount-input"]'), "0.01");
    act(() => container.querySelector('[data-testid="tc-submit"]').click());

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], {
      inboundTxid: "tx-abc-123", // trimmed
      sourceChain: "BTC",
      destination: SOL_ADDR, // the Solana session's public key, never typed
      expectedAmountOut: 0.01, // sent amount − affiliate bps (0 until THORName)
    });
  } finally {
    unmount();
  }
});

test("submit requires a txid; expectedAmountOut is omitted when no amount is given", () => {
  const factory = fakeRefresherFactory();
  const emitted = [];
  const { container, unmount } = render({
    createInboundRefresher: factory,
    onSubmit: (payload) => emitted.push(payload),
  });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    const submit = container.querySelector('[data-testid="tc-submit"]');
    assert.equal(submit.disabled, true, "no txid → disabled");
    change(container.querySelector('[data-testid="tc-txid-input"]'), "tx-xyz");
    assert.equal(submit.disabled, false);
    act(() => submit.click());
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], {
      inboundTxid: "tx-xyz",
      sourceChain: "BTC",
      destination: SOL_ADDR,
    });
    assert.equal("expectedAmountOut" in emitted[0], false, "optional field omitted when unknown");
  } finally {
    unmount();
  }
});

test("inbound fetch error surfaces and recovers on the next refresh", () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushError("inbound_addresses fetch failed: DNS"));
    const err = container.querySelector('[data-testid="tc-inbound-error"]');
    assert.ok(err);
    assert.match(err.textContent, /DNS/);
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    assert.equal(container.querySelector('[data-testid="tc-inbound-error"]'), null, "clears on recovery");
    assert.ok(container.querySelector('[data-testid="tc-deposit-address"]'));
  } finally {
    unmount();
  }
});

test("refresher is stopped on unmount (no dangling timers)", () => {
  const factory = fakeRefresherFactory();
  const { unmount } = render({ createInboundRefresher: factory });
  assert.equal(factory.instances[0].stopped, false);
  unmount();
  assert.equal(factory.instances[0].stopped, true);
});
