/**
 * TeleportConsole.test.jsx — the Teleport Console DOM-level tests.
 *
 * Proves at the DOM level that the console (BridgeCard variant="console" —
 * the new visual front door) is:
 *   - REAL: it drives the SAME quote path as the classic form — the pinned
 *     /api/lifi/quote query (no fee param — fee-model v2 x1-class policy),
 *     the same derive* fee picture (Teleporter 0.5% capped at $250 + the
 *     PER-ASSET Warp fee: flat $1 USDC.x / 0.25% wSOL.X), the To-address
 *     destination line, and the same fail-closed send gates (stage-1 sim
 *     blocks doomed txs; the stage-2 runner receives allowLive=false in the
 *     default flag state; sim failures land in an honest handoff).
 *   - The console "fires" the teleport-sequence overlay ONLY on a real
 *     broadcast (never in confirm/sim-only mode).
 *   - ROUTE-FIRST: direction is derived from the FROM coordinate (EVM chain
 *     → X1 = forward; X1 → EVM chain = reverse) — no direction toggle.
 *   - The classic card (variant default) is untouched: default BridgeCard
 *     still renders the classic TeleportTab/TeleportForm stack.
 *
 * HARNESS NOTE: ./jsdomSetup.js (via ../thorchain/jsdomSetup.js) MUST stay
 * the FIRST import — same rule as TeleportTab.test.jsx (DOM globals before
 * react/react-dom evaluate).
 */
import { dom } from "../thorchain/jsdomSetup.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider } from "./WalletContext.jsx";
import BridgeCard from "../../components/BridgeCard.jsx";
import { createInitialState } from "./walletReducer.js";
import { QUOTE_REFRESH_SECONDS } from "../../components/TeleportConsole.jsx";

const EVM_ADDR = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";
const SOL_ADDR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

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

function connectedState({ evm = false, solana = false, evmProvider = null, solProvider = null } = {}) {
  const state = createInitialState();
  if (evm) state.evm = { status: "connected", address: EVM_ADDR, provider: evmProvider, error: undefined };
  if (solana) state.solana = { status: "connected", address: SOL_ADDR, provider: solProvider, error: undefined };
  return state;
}

/** No-op balance deps keep the console hermetic (no RPC, no Coingecko). */
const NOOP_BALANCES = {
  priceFetcher: async () => null,
  evmBalanceFetcher: async () => null,
  solBalanceFetcher: async () => null,
  x1BalanceFetcher: async () => null,
};

function renderConsole({
  evm = true,
  solana = true,
  evmProvider,
  solProvider,
  initialState,
  formProps = {},
  flags = { THORCHAIN: false },
  initialTab = "teleport",
  consoleProps = {},
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        WalletProvider,
        {
          discovery: FAKE_DISCOVERY,
          initialState: initialState || connectedState({ evm, solana, evmProvider, solProvider }),
        },
        React.createElement(BridgeCard, {
          variant: "console",
          flags,
          initialTab,
          formProps: {
            balancesDeps: NOOP_BALANCES,
            ...formProps,
          },
          consoleProps: {
            autoQuoteDebounceMs: 0,
            ...consoleProps,
          },
        }),
      ),
    );
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
const selectValueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set;
const setInput = (el, value) => act(() => {
  nativeValueSetter.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});
const setSelect = (el, value) => act(() => {
  selectValueSetter.call(el, value);
  el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
});
const click = (el) => act(() => {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
});

/** Flush async handlers + debounce timers (auto-quote uses setTimeout(0)). */
async function flush(rounds = 30) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 2));
    }
  });
}

/** Fake EIP-1193 EVM provider. revertSim → eth_call throws with a decodable
 *  Error(string) revert (the Step 1.3A sim gate path). Records sends. */
function makeEvmProvider({ revertSim = false, sent = [] } = {}) {
  const revertData = "0x08c379a0" + // Error(string) selector
    "0".repeat(62) + "20" +          // offset 0x20
    "0".repeat(62) + "12" +          // length 18
    Buffer.from("Not enough balance").toString("hex").padEnd(64, "0");
  return {
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_call") {
        if (revertSim) {
          const err = new Error("execution reverted: Not enough balance");
          err.data = revertData;
          throw err;
        }
        return "0x";
      }
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_sendTransaction") { sent.push(params[0]); return "0xstage1hash"; }
      if (method === "eth_getTransactionReceipt") return { blockNumber: "0x1", status: "0x1" };
      return "0x";
    },
  };
}

/** Sign-capable Solana adapter (the resolveSolanaAdapter shape). */
function makeSolAdapter() {
  return {
    publicKey: { toBase58: () => SOL_ADDR },
    signAndSendTransaction: async () => ({ signature: "warp-sig" }),
  };
}

/** Mocked /api/lifi/quote endpoint — DI'd fetch. `toAmount` is configurable
 *  (base units of the LiFi destination token — 6 decimals in these tests).
 *  No approvalAddress → the approval leg is skipped, keeping tests focused
 *  on the quote/fee/gate behavior. Records every requested URL. */
function mockQuoteFetch({ toAmount = "100000000", error = null } = {}) {
  const calls = [];
  const lifiQuote = {
    id: "0xmock-quote",
    estimate: { toAmount, fromAmount: "100000000" },
    transactionRequest: { chainId: 1, to: "0x1234", data: "0xabcdef", value: "0x0", gasLimit: "0x5208" },
    action: {
      fromToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1 },
      toToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chainId: "SOL" },
    },
  };
  const fetcher = mock.fn(async (url) => {
    calls.push(String(url));
    if (error) return { ok: true, json: async () => error };
    return { ok: true, json: async () => lifiQuote };
  });
  mock.method(globalThis, "fetch", fetcher);
  return { calls, restore: () => mock.restoreAll() };
}

/** Fill the amount and wait for the console's auto-quote to land. */
async function quoteAmount(container, amount) {
  setInput(container.querySelector('[data-testid="amount"]'), amount);
  await flush();
}

// ── THE CONSOLE MOUNTS (the bridge card's console variant) ─────────────────

test("console mounts as the bridge card's console variant: hardware shell, header strip, route coordinates, TELEPORT — ONE unified flow (no rail tabs, no Buy)", () => {
  const { container, unmount } = renderConsole({});
  try {
    const shell = container.querySelector('[data-testid="teleport-console"]');
    assert.ok(shell, "the console housing renders");
    assert.ok(container.querySelector('[data-testid="teleport-console-page"]'), "full-viewport page layer");
    // Header readout strip
    const header = container.querySelector('[data-testid="console-header"]');
    assert.ok(header && header.textContent.includes("TELEPORT CONSOLE"), "header strip title");
    assert.ok(container.querySelector('[data-testid="console-subheader"]'), "route subheader");
    const status = container.querySelector('[data-testid="console-status"]');
    assert.ok(status && status.textContent.includes("STATUS: READY"), `status readout, got: ${status?.textContent}`);
    // Route coordinates: FROM eth → TO x1 (forward default), token USDC
    assert.equal(container.querySelector('[data-testid="from-chain"]').value, "eth");
    assert.equal(container.querySelector('[data-testid="to-chain"]').value, "x1");
    assert.equal(container.querySelector('[data-testid="token"]').value, "USDC");
    assert.equal(container.querySelector('[data-testid="x1-token"]').value, "USDC.x");
    assert.ok(container.querySelector('[data-testid="amount"]'), "amount readout");
    assert.ok(container.querySelector('[data-testid="max-button"]'), "MAX button");
    assert.ok(container.querySelector('[data-testid="quote-strip"]'), "quote-status strip");
    const fire = container.querySelector('[data-testid="teleport-now"]');
    assert.ok(fire, "the TELEPORT fire control");
    assert.ok(fire.textContent.includes("TELEPORT"), `label, got: ${fire.textContent}`);
    assert.equal(fire.disabled, true, "no amount yet → not armed");
    // ONE unified flow: no rail tabs anywhere, no Buy tab, and the rail is
    // never named in the console surface.
    assert.equal(container.querySelectorAll('[role="tab"]').length, 0, "no tab strip in the unified console");
    assert.equal(container.querySelector('[data-testid="buy-tab"]'), null, "Buy tab panel gone");
    assert.equal(container.querySelector('[data-testid="thorchain-tab"]'), null, "THORChain tab shell gone");
    const shellText = shell.textContent;
    assert.ok(!shellText.includes("THORChain"), "the rail is never named in the console");
    assert.ok(!shellText.includes("Buy"), "no Buy entry in the console");
    // Source-asset union: EVM chains + native chains (BTC/DOGE/LTC/XRP) + X1.
    const fromOptions = [...container.querySelector('[data-testid="from-chain"]').options].map((o) => o.value);
    for (const c of ["eth", "bsc", "arb", "btc", "doge", "ltc", "xrp", "x1"]) {
      assert.ok(fromOptions.includes(c), `source picker lists ${c}`);
    }
  } finally {
    unmount();
  }
});

test("classic variant untouched: default BridgeCard still renders the classic card — no console", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        WalletProvider,
        { discovery: FAKE_DISCOVERY, initialState: connectedState({ evm: true, solana: true, evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() }) },
        React.createElement(BridgeCard, { formProps: { balancesDeps: NOOP_BALANCES } }),
      ),
    );
  });
  try {
    assert.ok(container.querySelector('[data-testid="bridge-card"]'), "classic card shell");
    assert.ok(container.querySelector('[data-testid="teleport-form"]'), "classic form renders after connect");
    assert.equal(container.querySelector('[data-testid="teleport-console"]'), null, "console NOT mounted in classic");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("route-first direction: FROM X1 flips the console to the reverse off-ramp (no direction toggle)", () => {
  const { container, unmount } = renderConsole({});
  try {
    setSelect(container.querySelector('[data-testid="from-chain"]'), "x1");
    assert.equal(container.querySelector('[data-testid="from-chain"]').value, "x1");
    // Source token becomes an X1 token; destination becomes EVM.
    assert.equal(container.querySelector('[data-testid="token"]').value, "USDC.x");
    assert.equal(container.querySelector('[data-testid="to-chain"]').value, "eth");
    const toOptions = [...container.querySelector('[data-testid="to-chain"]').options].map((o) => o.value);
    assert.ok(toOptions.includes("arb") && toOptions.includes("bsc"), "EVM destinations listed");
    assert.ok(!toOptions.includes("btc") && !toOptions.includes("x1"), "native chains + X1 are not EVM destinations");
    assert.ok(container.querySelector('[data-testid="to-token"]'), "receive-token slot on reverse");
    assert.equal(container.querySelector('[data-testid="x1-token"]'), null, "land-as slot is forward-only");
    const body = container.querySelector('[data-testid="teleport-console"]');
    assert.ok(body.textContent.includes("X1 → Ethereum"), "route readout flips");
    // And back: EVM source restores the forward surface.
    setSelect(container.querySelector('[data-testid="from-chain"]'), "eth");
    assert.equal(container.querySelector('[data-testid="token"]').value, "USDC");
    assert.equal(container.querySelector('[data-testid="to-chain"]').value, "x1");
    assert.ok(container.querySelector('[data-testid="x1-token"]'), "land-as slot back");
  } finally {
    unmount();
  }
});

test("unified source union: a native source (Bitcoin) locks the deposit-address route — dest X1, single asset, USDC.x land-as, rail never named", () => {
  const { container, unmount } = renderConsole({});
  try {
    const fromChain = container.querySelector('[data-testid="from-chain"]');
    setSelect(fromChain, "btc");
    assert.equal(fromChain.value, "btc");
    // Source chain label renders the native chain name (no CHAINS crash).
    assert.ok(container.querySelector('[data-testid="from-slot"]').textContent.includes("Bitcoin"), "native chain label");
    // Single asset, locked; destination locked to X1; no land-as picker.
    const token = container.querySelector('[data-testid="token"]');
    assert.equal(token.value, "BTC", "native chain carries its one asset");
    assert.equal(token.disabled, true, "the single native asset is not a picker");
    assert.equal(container.querySelector('[data-testid="to-chain"]').value, "x1");
    assert.equal(container.querySelector('[data-testid="x1-token"]'), null, "no land-as picker on the native rail (USDC.x is fixed)");
    assert.ok(container.querySelector('[data-testid="to-slot"]').textContent.includes("arrives as USDC.x on X1"), "fixed land-as readout");
    const body = container.querySelector('[data-testid="teleport-console"]');
    assert.ok(!body.textContent.includes("THORChain"), "the rail is never named");
    assert.ok(body.textContent.includes("Bitcoin → X1"), "route readout names the real chains");
    // Amount set → TELEPORT arms (◉) and the strip announces the deposit route.
    setInput(container.querySelector('[data-testid="amount"]'), "0.01");
    const fire = container.querySelector('[data-testid="teleport-now"]');
    assert.equal(fire.disabled, false, "armed with an amount");
    assert.ok(fire.textContent.includes("◉ TELEPORT"), "armed label");
    assert.ok(container.querySelector('[data-testid="quote-strip"]').textContent.includes("DEPOSIT ROUTE READY"), "strip announces the deposit step, not a rail");
    // And the reverse of the union: switching back to Ethereum restores USDC.
    setSelect(container.querySelector('[data-testid="from-chain"]'), "eth");
    assert.equal(container.querySelector('[data-testid="token"]').value, "USDC");
    assert.ok(container.querySelector('[data-testid="x1-token"]'), "land-as picker back on the EVM rail");
  } finally {
    unmount();
  }
});

// ── THE REAL QUOTE PATH ─────────────────────────────────────────────────────

test("forward quote: pinned query (no fee param) → fee lines 0.5% + $1 flat, honest net, To-address on X1", async () => {
  const qf = mockQuoteFetch({ toAmount: "100000000" }); // LiFi delivers $100
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() });
  try {
    await quoteAmount(container, "100");
    assert.equal(qf.calls.length, 1, "one quote request");
    const url = qf.calls[0];
    assert.ok(url.startsWith("/api/lifi/quote?"), "the app's same-origin quote proxy");
    assert.ok(url.includes(`fromAddress=${EVM_ADDR}`), "real EVM source address in the query");
    assert.ok(url.includes("toAddress="), "real destination address in the query");
    assert.ok(!url.includes("fee="), "x1-class policy: the fee param is OMITTED (absent means absent)");

    const box = container.querySelector('[data-testid="quote-box"]');
    assert.ok(box, "quote box rendered");
    // Fee lines — labels + exact amounts (Teleporter 0.5% max $250 + Warp $1 flat)
    const skim = container.querySelector('[data-testid="fee-line-warp-skim"]');
    assert.ok(skim && skim.textContent.includes("Teleporter fee (0.5%, max $250)") && skim.textContent.includes("$0.50"),
      `skim line, got: ${skim?.textContent}`);
    const flat = container.querySelector('[data-testid="fee-line-warp-flat"]');
    assert.ok(flat && flat.textContent.includes("Warp bridge fee ($1 flat)") && flat.textContent.includes("$1.00"),
      `flat line, got: ${flat?.textContent}`);
    // You receive (net of both fees)
    const recv = container.querySelector('[data-testid="you-receive"]');
    assert.ok(recv && recv.textContent.includes("98.50") && recv.textContent.includes("USDC.x") && recv.textContent.includes("X1"),
      `you-receive, got: ${recv?.textContent}`);
    // To-address: the connected Solana session is the X1 recipient
    const dest = container.querySelector('[data-testid="dest-address-forward"]');
    assert.ok(dest, "To-address line");
    assert.equal(dest.querySelector("span[title]").getAttribute("title"), SOL_ADDR);
    // The fire control is ARMED
    const fire = container.querySelector('[data-testid="teleport-now"]');
    assert.equal(fire.disabled, false, "armed after the quote");
    assert.ok(fire.className.includes("tc-fire-armed"), "armed glow class");
    const status = container.querySelector('[data-testid="console-status"]');
    assert.ok(status.textContent.includes("ARMED"), `status readout, got: ${status?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("per-asset Warp fee (forward): landing wSOL.X switches the fee line to 0.25% — no $1 flat", async () => {
  const qf = mockQuoteFetch({ toAmount: "100000000" });
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() });
  try {
    await quoteAmount(container, "100");
    assert.ok(container.querySelector('[data-testid="fee-line-warp-flat"]'), "USDC.x → flat $1");
    setSelect(container.querySelector('[data-testid="x1-token"]'), "wSOL.X");
    await flush();
    const pct = container.querySelector('[data-testid="fee-line-warp-pct"]');
    assert.ok(pct && pct.textContent.includes("Warp bridge fee (0.25%)"), `per-asset pct line, got: ${pct?.textContent}`);
    assert.equal(container.querySelector('[data-testid="fee-line-warp-flat"]'), null, "flat line gone for wSOL.X");
    const recv = container.querySelector('[data-testid="you-receive"]');
    assert.ok(recv.textContent.includes("wSOL.X"), "receive token follows the land-as choice");
  } finally {
    qf.restore();
    unmount();
  }
});

test("reverse quote: X1→Ethereum — skim 0.5% + flat $1 (USDC.x), net on Ethereum, To = EVM wallet", async () => {
  const qf = mockQuoteFetch({ toAmount: "98500000" }); // LiFi SOL→EVM delivers the 98.5 net
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() });
  try {
    setSelect(container.querySelector('[data-testid="from-chain"]'), "x1");
    await quoteAmount(container, "100");
    const box = container.querySelector('[data-testid="quote-box"]');
    assert.ok(box, "reverse quote box rendered");
    const skim = container.querySelector('[data-testid="fee-line-warp-skim"]');
    assert.ok(skim && skim.textContent.includes("$0.50"), `skim $0.50, got: ${skim?.textContent}`);
    const flat = container.querySelector('[data-testid="fee-line-warp-flat"]');
    assert.ok(flat && flat.textContent.includes("$1.00"), `flat $1.00, got: ${flat?.textContent}`);
    const recv = container.querySelector('[data-testid="you-receive"]');
    assert.ok(recv && recv.textContent.includes("98.50") && recv.textContent.includes("USDC") && recv.textContent.includes("Ethereum"),
      `you-receive, got: ${recv?.textContent}`);
    const dest = container.querySelector('[data-testid="dest-address"]');
    assert.ok(dest, "To-address (EVM destination) line");
    assert.match(dest.querySelector("span[title]").getAttribute("title"), new RegExp(`^${EVM_ADDR}$`, "i"));
  } finally {
    qf.restore();
    unmount();
  }
});

test("reverse quote per-asset: burning wSOL.X shows the 0.25% Warp line", async () => {
  const qf = mockQuoteFetch({ toAmount: "990000" });
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() });
  try {
    setSelect(container.querySelector('[data-testid="from-chain"]'), "x1");
    setSelect(container.querySelector('[data-testid="token"]'), "wSOL.X");
    await quoteAmount(container, "1");
    const pct = container.querySelector('[data-testid="fee-line-warp-pct"]');
    assert.ok(pct && pct.textContent.includes("Warp bridge fee (0.25%)"), `pct line, got: ${pct?.textContent}`);
    assert.equal(container.querySelector('[data-testid="fee-line-warp-flat"]'), null, "no flat line for wSOL.X");
  } finally {
    qf.restore();
    unmount();
  }
});

test("honest dead-end: missing source wallet → NO quote call, explicit connect error (never a silent no-op)", async () => {
  const qf = mockQuoteFetch();
  // Only the Solana session — the forward route needs the EVM source wallet.
  const { container, unmount } = renderConsole({ evm: false, solana: true, solProvider: makeSolAdapter() });
  try {
    await quoteAmount(container, "100");
    assert.equal(qf.calls.length, 0, "no quote without the source wallet");
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("Connect your EVM wallet to get a quote"),
      `explicit connect prompt, got: ${err?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("honest dead-end: quote endpoint error → explicit error, back to idle", async () => {
  const qf = mockQuoteFetch({ error: { error: "No route found" } });
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() });
  try {
    await quoteAmount(container, "100");
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("No route found"), `surfaced, got: ${err?.textContent}`);
    assert.equal(container.querySelector('[data-testid="quote-box"]'), null, "no stale quote box");
    const fire = container.querySelector('[data-testid="teleport-now"]');
    assert.equal(fire.disabled, false, "TELEPORT still available (re-quotes on press)");
  } finally {
    qf.restore();
    unmount();
  }
});

test("friendly empty-amount state: TELEPORT stays disarmed until an amount is set", async () => {
  const qf = mockQuoteFetch();
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() });
  try {
    const fire = container.querySelector('[data-testid="teleport-now"]');
    assert.equal(fire.disabled, true, "disabled with no amount");
    assert.equal(container.querySelector('[data-testid="quote-box"]'), null, "nothing quoted");
    assert.equal(qf.calls.length, 0, "nothing fired");
    // The strip guides instead of erroring.
    assert.ok(
      container.querySelector('[data-testid="quote-strip"]').textContent.includes("SET YOUR JOURNEY COORDINATES"),
      "strip guidance shown",
    );
  } finally {
    qf.restore();
    unmount();
  }
});

// ── THE SEND GATES (fail-closed, mirroring TeleportForm) ────────────────────

test("send gated by the sim: reverting eth_call → eth_sendTransaction NEVER called, reason surfaced, back to armed", async () => {
  const sent = [];
  const qf = mockQuoteFetch();
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider({ revertSim: true, sent }), solProvider: makeSolAdapter() });
  try {
    await quoteAmount(container, "100");
    click(container.querySelector('[data-testid="teleport-now"]'));
    await flush();
    assert.equal(sent.length, 0, "eth_sendTransaction must NEVER be called on a doomed tx");
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("Not enough balance"), `surfaced revert reason, got: ${err?.textContent}`);
    const fire = container.querySelector('[data-testid="teleport-now"]');
    assert.equal(fire.disabled, false, "back to quoted — retry available");
  } finally {
    qf.restore();
    unmount();
  }
});

test("WARP_LIVE_SEND gate: stage-2 runner receives allowLive=false (default flag) → simulated, not sent", async () => {
  const sent = [];
  const qf = mockQuoteFetch();
  const runnerCalls = [];
  const fakeRunner = async (args) => {
    runnerCalls.push(args);
    return { stage: "simulated_ok", success: true, sim: { ok: true }, sent: null }; // confirm-mode result
  };
  const { container, unmount } = renderConsole({
    evmProvider: makeEvmProvider({ sent }),
    solProvider: makeSolAdapter(),
    formProps: { stage2Runner: fakeRunner },
  });
  try {
    await quoteAmount(container, "100");
    click(container.querySelector('[data-testid="teleport-now"]'));
    await flush();
    assert.equal(sent.length, 1, "stage 1 (the engine EVM stage) sent — the sim passed");
    assert.ok(container.querySelector('[data-testid="bridge-step2"]'), "stage 2 prompt rendered");
    click(container.querySelector('[data-testid="bridge-step2"]'));
    await flush();
    assert.equal(runnerCalls.length, 1, "stage-2 runner invoked once");
    assert.equal(runnerCalls[0].allowLive, false,
      "WARP_LIVE_SEND gate: default flag state → allowLive=false (no real Warp broadcast)");
    assert.equal(runnerCalls[0].amountHuman, 100, "stage 2 bridges what LiFi DELIVERED");
    const done = container.querySelector('[data-testid="done"]');
    assert.ok(done && done.textContent.includes("not sent"), `confirm-mode shown, got: ${done?.textContent}`);
    // Confirm-mode is NOT a broadcast → the sequence overlay must NOT fire.
    assert.equal(container.querySelector('[data-testid="sequence-overlay"]'), null, "no fire sequence on a simulated journey");
  } finally {
    qf.restore();
    unmount();
  }
});

test("stage 2 live: a REAL broadcast → relaying state AND the console fires the sequence overlay", async () => {
  const qf = mockQuoteFetch();
  const fakeRunner = async () => ({ stage: "sent", success: true, signature: "warp-sig-123" });
  const { container, unmount } = renderConsole({
    evmProvider: makeEvmProvider(),
    solProvider: makeSolAdapter(),
    formProps: { stage2Runner: fakeRunner },
  });
  try {
    await quoteAmount(container, "100");
    click(container.querySelector('[data-testid="teleport-now"]'));
    await flush();
    click(container.querySelector('[data-testid="bridge-step2"]'));
    await flush();
    const relaying = container.querySelector('[data-testid="relaying"]');
    assert.ok(relaying && relaying.textContent.includes("bridge_out sent"), `relaying, got: ${relaying?.textContent}`);
    const overlay = container.querySelector('[data-testid="sequence-overlay"]');
    assert.ok(overlay, "the teleport-sequence overlay fires on a REAL broadcast");
    const video = container.querySelector('[data-testid="sequence-video"]');
    const sources = [...video.querySelectorAll("source")].map((s) => s.getAttribute("src"));
    assert.deepEqual(sources, ["/assets/teleport-sequence.webm", "/assets/teleport-sequence.mp4"], "webm + mp4 sources");
    click(container.querySelector('[data-testid="sequence-skip"]'));
    assert.equal(container.querySelector('[data-testid="sequence-overlay"]'), null, "skip dismisses the overlay");
  } finally {
    qf.restore();
    unmount();
  }
});

test("stage-2 sim failure blocks the send → honest handoff with the surfaced reason", async () => {
  const qf = mockQuoteFetch();
  const fakeRunner = async () => ({
    success: false,
    sim: { ok: false, err: "custom program error", logs: ["Program log: Error: insufficient funds"] },
  });
  const { container, unmount } = renderConsole({
    evmProvider: makeEvmProvider(),
    solProvider: makeSolAdapter(),
    formProps: { stage2Runner: fakeRunner },
  });
  try {
    await quoteAmount(container, "100");
    click(container.querySelector('[data-testid="teleport-now"]'));
    await flush();
    click(container.querySelector('[data-testid="bridge-step2"]'));
    await flush();
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("Bridge sim failed"), `sim failure surfaced, got: ${err?.textContent}`);
    const handoff = container.querySelector('[data-testid="handoff"]');
    assert.ok(handoff, "handoff state — funds rest safely on Solana");
  } finally {
    qf.restore();
    unmount();
  }
});

test("REVERSE stage 1 gated by WARP_LIVE_SEND: runner receives allowLive=false + gross amount → simulated, not sent", async () => {
  const qf = mockQuoteFetch({ toAmount: "98500000" });
  const runnerCalls = [];
  const fakeRunner = async (args) => {
    runnerCalls.push(args);
    return { success: true, sim: { ok: true }, sent: null };
  };
  const { container, unmount } = renderConsole({
    evmProvider: makeEvmProvider(),
    solProvider: makeSolAdapter(),
    formProps: { reverseStage1Runner: fakeRunner },
  });
  try {
    setSelect(container.querySelector('[data-testid="from-chain"]'), "x1");
    await quoteAmount(container, "100");
    click(container.querySelector('[data-testid="teleport-now"]'));
    await flush();
    assert.equal(runnerCalls.length, 1, "reverse stage-1 runner invoked once");
    assert.equal(runnerCalls[0].allowLive, false, "WARP_LIVE_SEND gate closed by default");
    assert.equal(runnerCalls[0].amountHuman, 100, "gross amount passed to the burn runner");
    const done = container.querySelector('[data-testid="done"]');
    assert.ok(done && done.textContent.includes("not sent"), `confirm-mode, got: ${done?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("REVERSE AUTO-FIRE: release poll resolves → stage-2 fires AUTOMATICALLY (one attempt), final broadcast fires the sequence", async () => {
  const qf = mockQuoteFetch({ toAmount: "98500000" });
  const stage2Calls = [];
  const { container, unmount } = renderConsole({
    evmProvider: makeEvmProvider(),
    solProvider: makeSolAdapter(),
    formProps: {
      reverseStage1Runner: async () => ({ stage: "sent", success: true, signature: "burn-sig" }),
      releasePoller: async (sig, { onUpdate } = {}) => {
        onUpdate?.("complete", {});
        return { ok: true, destinationTx: "release-tx" };
      },
      reverseStage2Runner: async (args) => {
        stage2Calls.push(args);
        return "0xfinalhash";
      },
    },
  });
  try {
    setSelect(container.querySelector('[data-testid="from-chain"]'), "x1");
    await quoteAmount(container, "100");
    click(container.querySelector('[data-testid="teleport-now"]'));
    await flush();
    assert.equal(stage2Calls.length, 1, "auto-fired EXACTLY once after the release");
    assert.equal(stage2Calls[0].toTokenSymbol, "USDC", "delivers the selected destination stable");
    assert.equal(stage2Calls[0].netOnSolana, 98.5, "bridges the net that LANDED on Solana");
    const done = container.querySelector('[data-testid="done"]');
    assert.ok(done && done.textContent.includes("Bridge complete"), `done, got: ${done?.textContent}`);
    assert.ok(container.querySelector('[data-testid="sequence-overlay"]'), "final REAL broadcast fires the sequence");
  } finally {
    qf.restore();
    unmount();
  }
});

// ── CONSOLE CONTROLS ────────────────────────────────────────────────────────

test("MAX + balance: the source balance shows under Amount; MAX fills the amount", async () => {
  const qf = mockQuoteFetch();
  const { container, unmount } = renderConsole({
    evmProvider: makeEvmProvider(),
    solProvider: makeSolAdapter(),
    formProps: {
      balancesDeps: {
        ...NOOP_BALANCES,
        evmBalanceFetcher: async () => 25.5,
        priceFetcher: async () => ({ USDC: 1 }),
      },
    },
  });
  try {
    await flush();
    const bal = container.querySelector('[data-testid="source-balance"]');
    assert.ok(bal && bal.textContent.includes("25.5") && bal.textContent.includes("USDC"),
      `balance readout, got: ${bal?.textContent}`);
    click(container.querySelector('[data-testid="max-button"]'));
    assert.equal(container.querySelector('[data-testid="amount"]').value, "25.5", "MAX fills the amount");
  } finally {
    qf.restore();
    unmount();
  }
});

test("connect affordance: no wallets → CONNECT WALLET opens the SAME ConnectModal; cancel returns", async () => {
  const { container, unmount } = renderConsole({ initialState: connectedState({}) });
  try {
    const open = container.querySelector('[data-testid="connect-open"]');
    assert.ok(open, "connect control visible");
    click(open);
    assert.ok(container.querySelector('[data-testid="connect-overlay"]'), "overlay opens");
    assert.ok(container.querySelector('[data-testid="connect-modal"]'), "the real ConnectModal inside");
    click(container.querySelector('[data-testid="cancel-connect"]'));
    assert.equal(container.querySelector('[data-testid="connect-overlay"]'), null, "cancel returns to the console");
    assert.ok(container.querySelector('[data-testid="teleport-console"]'), "console still mounted");
  } finally {
    unmount();
  }
});

test("wallet chips: connected sessions render as chips with disconnect", async () => {
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() });
  try {
    const evmChip = container.querySelector('[data-testid="wallet-chip-evm"]');
    assert.ok(evmChip && evmChip.textContent.includes("EVM"), "EVM chip");
    assert.ok(container.querySelector('[data-testid="wallet-chip-solana"]'), "Solana chip");
  } finally {
    unmount();
  }
});

test("unified flow: a native source routes into the DEPOSIT-ADDRESS final step on TELEPORT (the engine picks the rail invisibly — no signing, no rail name)", async () => {
  // No wallets at all: the deposit step must render and explain itself — the
  // console never asks the user to understand a rail. A fake inbound
  // refresher keeps the mount hermetic (no network).
  const noopRefresher = { start() {}, stop() {} };
  const { container, unmount } = renderConsole({
    initialState: connectedState({}),
    consoleProps: {
      depositDeps: { createInboundRefresher: () => noopRefresher },
    },
  });
  try {
    setSelect(container.querySelector('[data-testid="from-chain"]'), "btc");
    setInput(container.querySelector('[data-testid="amount"]'), "0.01");
    click(container.querySelector('[data-testid="teleport-now"]'));
    // The deposit-address final step rendered (post-pick, pre-execution).
    const depositStep = container.querySelector('[data-testid="deposit-step"]');
    assert.ok(depositStep, "the deposit-address step renders");
    assert.ok(container.querySelector('[data-testid="tc-deposit"]'), "the deposit card (vault address + memo + txid) renders");
    assert.ok(
      depositStep.textContent.includes("Sending BTC from Bitcoin → X1"),
      "step context names the real chains, not a rail",
    );
    // The rail is invisible: the word never appears anywhere in the console.
    const body = container.querySelector('[data-testid="teleport-console"]').textContent;
    assert.ok(!body.includes("THORChain"), "the word THORChain never renders in the unified console");
    assert.ok(!body.includes("Buy"), "no Buy tab");
    // The console body is replaced by the deposit step (no competing pickers).
    assert.equal(container.querySelector('[data-testid="console-coords"]'), null, "coords hidden during the deposit step");
    assert.equal(container.querySelector('[data-testid="teleport-now"]'), null, "fire control hidden during the deposit step");
    // The status readout reflects the step.
    assert.ok(container.querySelector('[data-testid="console-status"]').textContent.includes("DEPOSIT"), "status: DEPOSIT");
    // Back to the route.
    click(container.querySelector('[data-testid="back-to-route"]'));
    assert.ok(container.querySelector('[data-testid="console-coords"]'), "back on the route coordinates");
    assert.equal(container.querySelector('[data-testid="from-chain"]').value, "btc", "route kept");
  } finally {
    unmount();
  }
});

test("unified flow: the deposit step prefills the console's amount and locks the source (no second picker)", async () => {
  const noopRefresher = { start() {}, stop() {} };
  const { container, unmount } = renderConsole({
    solana: true,
    solProvider: makeSolAdapter(),
    consoleProps: {
      depositDeps: { createInboundRefresher: () => noopRefresher },
    },
  });
  try {
    setSelect(container.querySelector('[data-testid="from-chain"]'), "doge");
    setInput(container.querySelector('[data-testid="amount"]'), "1234.5");
    click(container.querySelector('[data-testid="teleport-now"]'));
    const depositStep = container.querySelector('[data-testid="deposit-step"]');
    assert.ok(depositStep, "deposit step renders");
    // The console amount rode into the deposit stage.
    assert.equal(container.querySelector('[data-testid="tc-amount-input"]').value, "1234.5", "amount prefilled from the route");
    // The source is locked to the picked asset (no competing grid).
    assert.ok(container.querySelector('[data-testid="tc-source-locked"]'), "source locked row renders");
    assert.equal(container.querySelector('[data-testid="tc-sources"]'), null, "no source picker grid inside the step");
    assert.ok(container.querySelector('[data-testid="tc-source-locked"]').textContent.includes("DOGE"), "locked to DOGE");
    // The destination is the connected Solana/X1 wallet session.
    assert.equal(container.querySelector('[data-testid="tc-destination-input"]').value, SOL_ADDR, "destination = the connected session");
    // Neutral copy: no rail name in the deposit card either.
    const depositText = depositStep.textContent;
    assert.ok(!depositText.includes("THORChain"), "deposit card copy never names the rail");
  } finally {
    unmount();
  }
});

test("the quote strip counts down to an auto-refresh (30s window)", async () => {
  const qf = mockQuoteFetch();
  const { container, unmount } = renderConsole({ evmProvider: makeEvmProvider(), solProvider: makeSolAdapter() });
  try {
    await quoteAmount(container, "100");
    assert.equal(qf.calls.length, 1);
    assert.equal(container.querySelector('[data-testid="quote-strip"]').textContent.includes("refresh in"), true, "countdown shown");
    // Manual refresh re-quotes immediately.
    click(container.querySelector('[data-testid="refresh-quote"]'));
    await flush();
    assert.equal(qf.calls.length, 2, "refresh button re-quotes");
    assert.ok(container.querySelector('[data-testid="quote-box"]'), "quote restored after refresh");
    assert.equal(QUOTE_REFRESH_SECONDS, 30, "the freshness window constant");
  } finally {
    qf.restore();
    unmount();
  }
});
