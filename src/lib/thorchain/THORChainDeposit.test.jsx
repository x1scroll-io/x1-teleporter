/**
 * THORChainDeposit.test.jsx — the deposit-address stage of the THORChain
 * tab (Steps 3.2 + 3.3).
 *
 * jsdom + React 18 act, same harness as THORChainTab.test.jsx. Everything is
 * injected: a fake inbound-address refresher drives the vault/halted data,
 * a MOCK quote fetcher drives the quote gate (the real aggregator key is a
 * parked item, held server-side only — never touched in tests), a stub QR
 * factory returns fixed
 * SVG, the clipboard is stubbed, and the submit hook captures the emitted
 * payload. No timers, no network, no wallet globals.
 *
 * Proves the acceptance points of this step:
 *   - destination prefilled from the Solana session + NOT editable
 *   - no Solana wallet → the stage blocks ("connect a Solana wallet first")
 *   - sources limited to BTC/DOGE/LTC/XRP; halted chains grey out with
 *     "paused by THORChain" and are not selectable
 *   - QUOTE GATE (3.3): the deposit address is shown ONLY after a fresh
 *     quote lands — the "get quote" moment sits immediately before the
 *     address; a failed quote BLOCKS the address with a Retry; changing the
 *     source or the amount invalidates the quote (quotes expire)
 *   - the THREE fees (THORChain affiliate protocol fee + our 1% skim +
 *     Warp's $1) render before the user sends
 *   - SIZE CAP (3.3): over-cap requests are blocked with a clear message,
 *     at-cap is allowed, unknown-rate assets show a note
 *   - deposit address + memo (exact THORChain format) + QR displayed
 *   - refund address prefilled from the connected source-wallet session
 *   - the submit hook emits {inboundTxid, sourceChain, destination,
 *     expectedAmountOut} — expectedAmountOut from the FRESH QUOTE (the 3.2
 *     sent-amount guess is gone)
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

/** The quote fixture the MOCK fetcher returns (never a real endpoint). */
const QUOTE_FIXTURE = {
  expectedAmountOut: 0.0456,
  expectedAmountOutRaw: 4560000,
  affiliateBps: 100,
  slippageBps: 38,
  memo: null,
  halted: false,
  raw: {},
};

/** Mock quote fetcher factory: captures the args, returns the fixture.
 *  `fetcher.respond` can be swapped mid-test to flip a failing quote to a
 *  succeeding one (the retry-recovery tests). */
function mockQuoteFetcher(overrides = {}) {
  const calls = [];
  const fetcher = async (args) => {
    calls.push(args);
    if (fetcher.respond) return fetcher.respond(args);
    if (overrides.fail) {
      return { ok: false, reason: "error", message: overrides.fail };
    }
    return { ok: true, quote: { ...QUOTE_FIXTURE, ...(overrides.quote ?? {}) } };
  };
  fetcher.calls = calls;
  return fetcher;
}

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
        fetchQuote: mockQuoteFetcher(),
        ...props,
      }),
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

/** Flush the mock quote's promise chain inside act (the getQuote handler
 *  awaits the mock fetcher before setting state). */
async function flushQuote() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Complete the quote gate: enter an amount + click "Get fresh quote". */
async function getQuote(container, amount = "0.01") {
  change(container.querySelector('[data-testid="tc-amount-input"]'), amount);
  act(() => container.querySelector('[data-testid="tc-get-quote"]').click());
  await flushQuote();
}

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
    // No destination, no quote gate, no deposit card, no submit.
    assert.equal(container.querySelector('[data-testid="tc-destination-input"]'), null);
    assert.equal(container.querySelector('[data-testid="tc-get-quote"]'), null);
    assert.equal(container.querySelector('[data-testid="tc-deposit-card"]'), null);
    assert.equal(container.querySelector('[data-testid="tc-submit"]'), null);
  } finally {
    unmount();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE GATE (Step 3.3) — the address appears ONLY after a fresh quote
// ─────────────────────────────────────────────────────────────────────────────
test("QUOTE GATE: the deposit address is NOT shown until a fresh quote lands", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    // Vault is known, but no quote yet → no address card.
    assert.equal(container.querySelector('[data-testid="tc-deposit-card"]'), null, "address blocked before the quote");
    assert.ok(container.querySelector('[data-testid="tc-get-quote"]'), "the get-quote moment is present");

    await getQuote(container, "0.01");

    const addr = container.querySelector('[data-testid="tc-deposit-address"]');
    assert.ok(addr, "address appears AFTER the fresh quote lands");
    assert.equal(addr.textContent, BTC_VAULT, "default source is BTC");
    // The quote summary + freshness render.
    const summary = container.querySelector('[data-testid="tc-quote-summary"]');
    assert.ok(summary, "quote summary shown");
    assert.match(summary.textContent, /0\.0456 SOL/, "expected SOL out from the quote");
    assert.match(summary.textContent, /38 bps/, "slippage bps from the quote");
    assert.ok(container.querySelector('[data-testid="tc-quote-freshness"]'), "freshness line present");
  } finally {
    unmount();
  }
});

test("QUOTE GATE: a failed quote BLOCKS the address and offers a Retry that recovers", async () => {
  const factory = fakeRefresherFactory();
  const fetcher = mockQuoteFetcher({ fail: "quote endpoint error: chain halted" });
  const { container, unmount } = render({ createInboundRefresher: factory, fetchQuote: fetcher });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    await getQuote(container, "0.01");

    const err = container.querySelector('[data-testid="tc-quote-error"]');
    assert.ok(err, "quote error surfaced");
    assert.match(err.textContent, /chain halted/);
    assert.match(err.textContent, /not shown until a fresh quote/, "address is blocked, never shown stale");
    assert.equal(container.querySelector('[data-testid="tc-deposit-card"]'), null, "no address on quote failure");
    const submit = container.querySelector('[data-testid="tc-submit"]');
    assert.equal(submit.disabled, true, "submit blocked without a quote");

    // Retry with the mock now succeeding → address appears.
    fetcher.respond = async () => ({ ok: true, quote: { ...QUOTE_FIXTURE } });
    act(() => container.querySelector('[data-testid="tc-quote-retry"]').click());
    await flushQuote();
    assert.equal(container.querySelector('[data-testid="tc-quote-error"]'), null);
    assert.ok(container.querySelector('[data-testid="tc-deposit-address"]'), "address after the retry succeeds");
  } finally {
    unmount();
  }
});

test("QUOTE GATE: changing the source invalidates the quote (quotes expire) — the address hides until a fresh quote for the new chain", async () => {
  const factory = fakeRefresherFactory();
  const fetcher = mockQuoteFetcher();
  const { container, unmount } = render({ createInboundRefresher: factory, fetchQuote: fetcher });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    await getQuote(container, "0.01");
    assert.ok(container.querySelector('[data-testid="tc-deposit-address"]'));

    act(() => container.querySelector('[data-testid="tc-source-XRP"]').click());
    // The quote was for BTC — invalidated on source change.
    assert.equal(container.querySelector('[data-testid="tc-deposit-card"]'), null, "address hidden after source switch");
    assert.equal(container.querySelector('[data-testid="tc-quote-summary"]'), null, "stale quote cleared");

    await getQuote(container, "10");
    assert.equal(
      container.querySelector('[data-testid="tc-deposit-address"]').textContent,
      XRP_VAULT,
      "fresh quote for XRP → XRP address appears",
    );
    // The quote was fetched for the NEW source asset.
    assert.equal(fetcher.calls[fetcher.calls.length - 1].fromAsset, "XRP.XRP");
  } finally {
    unmount();
  }
});

test("QUOTE GATE: changing the amount invalidates the quote (quotes expire)", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    await getQuote(container, "0.01");
    assert.ok(container.querySelector('[data-testid="tc-deposit-address"]'));
    change(container.querySelector('[data-testid="tc-amount-input"]'), "0.02");
    assert.equal(container.querySelector('[data-testid="tc-deposit-card"]'), null, "amount change → quote stale → address hidden");
  } finally {
    unmount();
  }
});

test("QUOTE GATE: the quote fetcher receives the source asset, SOL destination, amount and refund (no affiliate while the THORName is unset)", async () => {
  const factory = fakeRefresherFactory();
  const fetcher = mockQuoteFetcher();
  const { container, unmount } = render({ createInboundRefresher: factory, fetchQuote: fetcher });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    change(container.querySelector('[data-testid="tc-refund-input"]'), "bc1qrefundaddr99");
    await getQuote(container, "0.01");

    assert.equal(fetcher.calls.length, 1);
    const args = fetcher.calls[0];
    assert.equal(args.fromAsset, "BTC.BTC");
    assert.equal(args.toAsset, "SOL.SOL");
    assert.equal(args.amount, 0.01);
    assert.equal(args.destination, SOL_ADDR);
    assert.equal(args.refundAddress, "bc1qrefundaddr99");
    // PARKED ITEM: the THORName placeholder is empty → no affiliate params.
    assert.equal("affiliate" in args, false, "no affiliate sent while the THORName is unset");
    assert.equal("affiliateBps" in args, false);
  } finally {
    unmount();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FEE DISPLAY (Step 3.3) — three fees, exactly, before the user sends
// ─────────────────────────────────────────────────────────────────────────────
test("FEES: exactly three fee lines render before sending — THORChain affiliate (protocol) + our 1% skim + Warp's $1", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    // No fee lines before a quote.
    assert.equal(container.querySelectorAll('[data-testid="tc-fee-line"]').length, 0);

    await getQuote(container, "0.01");

    const lines = [...container.querySelectorAll('[data-testid="tc-fee-line"]')];
    assert.equal(lines.length, 3, "exactly three fee lines");
    assert.deepEqual(
      lines.map((l) => l.getAttribute("data-fee-id")),
      ["thorchain-affiliate", "warp-skim", "warp-flat"],
    );
    // The three parties: protocol/third-party affiliate, Teleporter 1%, third-party Warp.
    assert.deepEqual(
      lines.map((l) => l.getAttribute("data-party")),
      ["third-party", "teleporter", "third-party"],
    );
    assert.match(lines[0].textContent, /THORChain affiliate/);
    assert.match(lines[0].textContent, /1\.00%/, "affiliate 100 bps from config");
    assert.match(lines[1].textContent, /Teleporter fee/);
    assert.match(lines[1].textContent, /1\.00%/, "our 1% skim");
    assert.match(lines[2].textContent, /Warp bridge fee/);
    assert.match(lines[2].textContent, /\$1 flat/, "Warp's $1 pass-through");
  } finally {
    unmount();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SIZE CAP (Step 3.3) — config value, enforced at quote time
// ─────────────────────────────────────────────────────────────────────────────
test("SIZE CAP: over-cap requests are BLOCKED with a clear message before any fetch", async () => {
  const factory = fakeRefresherFactory();
  const fetcher = mockQuoteFetcher();
  const { container, unmount } = render({ createInboundRefresher: factory, fetchQuote: fetcher });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    // 0.06 BTC > the 0.05 BTC-equivalent cap.
    change(container.querySelector('[data-testid="tc-amount-input"]'), "0.06");
    act(() => container.querySelector('[data-testid="tc-get-quote"]').click());
    await flushQuote();

    const err = container.querySelector('[data-testid="tc-cap-error"]');
    assert.ok(err, "over-cap message shown");
    assert.match(err.textContent, /exceeds/);
    assert.match(err.textContent, /0\.05 BTC-equivalent/);
    assert.equal(container.querySelector('[data-testid="tc-deposit-card"]'), null, "no address for an over-cap swap");
    assert.equal(fetcher.calls.length, 0, "no quote fetch for an over-cap swap");
  } finally {
    unmount();
  }
});

test("SIZE CAP: at-cap is allowed (0.05 BTC exactly)", async () => {
  const factory = fakeRefresherFactory();
  const fetcher = mockQuoteFetcher();
  const { container, unmount } = render({ createInboundRefresher: factory, fetchQuote: fetcher });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    await getQuote(container, "0.05");
    assert.equal(container.querySelector('[data-testid="tc-cap-error"]'), null);
    assert.equal(fetcher.calls.length, 1, "at-cap quote fetched");
    assert.ok(container.querySelector('[data-testid="tc-deposit-address"]'), "at-cap address shown");
  } finally {
    unmount();
  }
});

test("SIZE CAP: assets with no BTC-equivalent rate yet show a note, not a guess (DOGE until the live wiring)", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    act(() => container.querySelector('[data-testid="tc-source-DOGE"]').click());
    await getQuote(container, "9999");

    const note = container.querySelector('[data-testid="tc-cap-unknown"]');
    assert.ok(note, "cap-unknown note shown for DOGE");
    assert.match(note.textContent, /not enforced yet/);
    assert.equal(container.querySelector('[data-testid="tc-cap-error"]'), null);
    assert.ok(container.querySelector('[data-testid="tc-deposit-address"]'), "DOGE quote proceeds (no invented price)");
  } finally {
    unmount();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEPOSIT CARD + MEMO + QR (Step 3.2 behavior, now behind the quote gate)
// ─────────────────────────────────────────────────────────────────────────────
test("inbound addresses fetched on mount; vault address + memo + QR render once the quote lands", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    assert.equal(factory.instances.length, 1, "refresher created on mount");
    assert.equal(factory.instances[0].stopped, false);
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    await getQuote(container, "0.01");

    const addr = container.querySelector('[data-testid="tc-deposit-address"]');
    assert.ok(addr, "deposit card renders once the vault list lands AND the quote is fresh");
    assert.equal(addr.textContent, BTC_VAULT, "default source is BTC");

    const memo = container.querySelector('[data-testid="tc-memo"]');
    assert.equal(memo.textContent, `=:SOL.SOL:${SOL_ADDR}`, "exact THORChain memo format (no refund, no affiliate while THORName unset)");

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

test("memo includes the refund address when one is entered (DEST/REFUND scheme)", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    change(container.querySelector('[data-testid="tc-refund-input"]'), "bc1qrefundaddr99");
    await getQuote(container, "0.01");
    const memo = container.querySelector('[data-testid="tc-memo"]');
    assert.equal(memo.textContent, `=:SOL.SOL:${SOL_ADDR}/bc1qrefundaddr99`);
  } finally {
    unmount();
  }
});

test("refund address prefills from the connected source-wallet session (Steps 2.3/2.4 rows feed this)", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({
    createInboundRefresher: factory,
    sourceSessions: { bitcoin: { address: "bc1qconnectedwallet" } },
  });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    const refund = container.querySelector('[data-testid="tc-refund-input"]');
    assert.equal(refund.value, "bc1qconnectedwallet", "prefilled from the connected BTC session");
    await getQuote(container, "0.01");
    const memo = container.querySelector('[data-testid="tc-memo"]');
    assert.equal(memo.textContent, `=:SOL.SOL:${SOL_ADDR}/bc1qconnectedwallet`);
  } finally {
    unmount();
  }
});

test("switching source swaps the deposit address + memo chain (XRP vault + note)", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    act(() => container.querySelector('[data-testid="tc-source-XRP"]').click());
    await getQuote(container, "10");

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

test("selecting a halted chain is impossible; a halted default chain shows the paused banner and blocks the quote", () => {
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
    // The quote button is disabled while the selected chain is halted.
    change(container.querySelector('[data-testid="tc-amount-input"]'), "0.01");
    const getQuoteBtn = container.querySelector('[data-testid="tc-get-quote"]');
    assert.equal(getQuoteBtn.disabled, true, "no quote for a halted chain");
  } finally {
    unmount();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUBMIT HOOK — expectedAmountOut now comes from the FRESH QUOTE (3.3)
// ─────────────────────────────────────────────────────────────────────────────
test("submit hook emits {inboundTxid, sourceChain, destination, expectedAmountOut} with the QUOTE's expectedAmountOut", async () => {
  const factory = fakeRefresherFactory();
  const emitted = [];
  const { container, unmount } = render({
    createInboundRefresher: factory,
    onSubmit: (payload) => emitted.push(payload),
  });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    await getQuote(container, "0.01"); // quote → expectedAmountOut 0.0456
    change(container.querySelector('[data-testid="tc-txid-input"]'), "  tx-abc-123  ");
    act(() => container.querySelector('[data-testid="tc-submit"]').click());

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], {
      inboundTxid: "tx-abc-123", // trimmed
      sourceChain: "BTC",
      destination: SOL_ADDR, // the Solana session's public key, never typed
      expectedAmountOut: 0.0456, // from the FRESH QUOTE — the 3.2 sent-amount guess is gone
    });
  } finally {
    unmount();
  }
});

test("submit requires a txid AND a fresh quote; expectedAmountOut is always present once the quote landed", async () => {
  const factory = fakeRefresherFactory();
  const emitted = [];
  const { container, unmount } = render({
    createInboundRefresher: factory,
    onSubmit: (payload) => emitted.push(payload),
  });
  try {
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));

    // No quote yet → submit disabled even with a txid.
    change(container.querySelector('[data-testid="tc-txid-input"]'), "tx-xyz");
    const submit = container.querySelector('[data-testid="tc-submit"]');
    assert.equal(submit.disabled, true, "no fresh quote → submit disabled");

    await getQuote(container, "0.01");
    assert.equal(submit.disabled, false, "quote landed + txid → submit enabled");
    act(() => submit.click());
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], {
      inboundTxid: "tx-xyz",
      sourceChain: "BTC",
      destination: SOL_ADDR,
      expectedAmountOut: 0.0456, // from the quote — always present now
    });
  } finally {
    unmount();
  }
});

test("inbound fetch error surfaces and recovers on the next refresh", async () => {
  const factory = fakeRefresherFactory();
  const { container, unmount } = render({ createInboundRefresher: factory });
  try {
    act(() => factory.instances[0].pushError("inbound_addresses fetch failed: DNS"));
    const err = container.querySelector('[data-testid="tc-inbound-error"]');
    assert.ok(err);
    assert.match(err.textContent, /DNS/);
    act(() => factory.instances[0].pushEntries(DEFAULT_INBOUND));
    assert.equal(container.querySelector('[data-testid="tc-inbound-error"]'), null, "clears on recovery");
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
