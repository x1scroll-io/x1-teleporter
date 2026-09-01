/**
 * TeleportTab.test.jsx — Phase 3 bridge form tests (DOM level).
 *
 * Proves at the DOM level what the pure tests prove at the data level:
 *   - REPRODUCTION: pre-port, the ConnectedBody rendered the
 *     "bridge-form-placeholder" (data-testid="bridge-form-placeholder");
 *     post-port that element is GONE and the real bridge form renders after
 *     connect (chains / tokens / amount / Get Quote).
 *   - The quote flow works against a MOCKED quote endpoint (DI'd fetch): the
 *     x1-class query is pinned (no fee param, x1Class=1, real wallet
 *     addresses, allowSwitchChain=false) and the fee lines render from
 *     computeFee via quoteFees — Teleporter fee 1% + Warp bridge fee $1 on
 *     X1 routes — plus the honest "you receive" net.
 *   - The send path is gated by the simulation (a reverting eth_call blocks
 *     the send and surfaces the reason — eth_sendTransaction is NEVER called)
 *     and by WARP_LIVE_SEND (the stage-2 runner receives allowLive=false in
 *     the default flag state — real Warp broadcasts only when the flag is
 *     armed).
 *   - Honest dead-ends: missing wallets / sub-floor amounts / quote failures
 *     surface explicit messages — never a silent no-op.
 *
 * HARNESS NOTE: ./jsdomSetup.js (via ../thorchain/jsdomSetup.js) MUST stay
 * the FIRST import — it creates the JSDOM and sets the DOM globals before
 * react/react-dom evaluate (see jsdomSetup.js for the full explanation).
 */
import { dom } from "../thorchain/jsdomSetup.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider } from "./WalletContext.jsx";
import BridgeCard from "../../components/BridgeCard.jsx";
import TeleportForm from "../../components/TeleportForm.jsx";
import { createInitialState } from "./walletReducer.js";
import { WALLET_FAMILIES } from "./families.js";

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

function renderWithProvider(element, initialState) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // BridgeCard → TeleportTab → TeleportForm: inject the no-op balancesDeps
  // so the bridge-flow tests stay hermetic (the balance line itself is
  // covered with DI'd fetchers in BalancesLine.test.jsx).
  const el = React.cloneElement(element, {
    formProps: {
      balancesDeps: {
        priceFetcher: async () => null,
        evmBalanceFetcher: async () => null,
        solBalanceFetcher: async () => null,
        x1BalanceFetcher: async () => null,
        createConnections: async () => ({ sol: null, x1: null }),
      },
    },
  });
  act(() => {
    root.render(
      React.createElement(WalletProvider, { discovery: FAKE_DISCOVERY, initialState },
        el),
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

function renderForm(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(TeleportForm, props));
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
const setInput = (el, value) => act(() => {
  nativeValueSetter.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});
const click = (el) => act(() => {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
});

/** Flush the async handler + fetch microtasks. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
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

/** Mocked /api/lifi/quote endpoint — DI'd fetch. Returns a realistic LiFi
 *  quote: $99 delivered for a $100 input (toAmount in base units, 6
 *  decimals), carrying the transactionRequest + action the stage-1 send path
 *  reads, with NO approvalAddress (no allowance needed → the approval path is
 *  skipped, keeping the test focused on the sim + WARP_LIVE_SEND gates). */
function mockQuoteFetch() {
  const calls = [];
  const lifiQuote = {
    id: "0xmock-quote",
    estimate: { toAmount: "99000000", fromAmount: "100000000" }, // no approvalAddress → no allowance needed
    transactionRequest: { chainId: 1, to: "0x1234", data: "0xabcdef", value: "0x0", gasLimit: "0x5208" },
    action: {
      fromToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1 },
      toToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chainId: "SOL" },
    },
  };
  const fetcher = mock.fn(async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => lifiQuote };
  });
  mock.method(globalThis, "fetch", fetcher);
  return { calls, restore: () => mock.restoreAll() };
}

const FORM_PROPS = (over = {}) => ({
  evmSession: { status: "connected", address: EVM_ADDR, provider: makeEvmProvider() },
  solSession: { status: "connected", address: SOL_ADDR, provider: makeSolAdapter() },
  // BalancesLine (wallet balances + live USD) is DI-able: these tests pin the
  // bridge flow, not balances — no-op fetchers keep them hermetic (no RPC,
  // no Coingecko). The balance line itself is covered in BalancesLine.test.jsx.
  balancesDeps: {
    priceFetcher: async () => null,
    evmBalanceFetcher: async () => null,
    solBalanceFetcher: async () => null,
    x1BalanceFetcher: async () => null,
    createConnections: async () => ({ sol: null, x1: null }),
  },
  ...over,
});

// ── REPRODUCTION: placeholder GONE, form renders after connect ─────────────

test("the bridge-form-placeholder is GONE — the real form renders after connect", () => {
  const { container, unmount } = renderWithProvider(
    React.createElement(BridgeCard, {}),
    connectedState({ evm: true, evmProvider: makeEvmProvider() }),
  );
  try {
    assert.equal(
      container.querySelector('[data-testid="bridge-form-placeholder"]'),
      null,
      "pre-port this placeholder rendered after connect; post-port it must be GONE",
    );
    const form = container.querySelector('[data-testid="teleport-form"]');
    assert.ok(form, "the bridge form renders after connect");
    assert.ok(container.querySelector('[data-testid="from-chain"]'), "from-chain picker");
    assert.ok(container.querySelector('[data-testid="to-chain"]'), "to-chain picker");
    assert.ok(container.querySelector('[data-testid="token"]'), "token picker");
    assert.ok(container.querySelector('[data-testid="amount"]'), "amount input");
    assert.ok(container.querySelector('[data-testid="get-quote"]'), "Get Quote button");
    const fromSelect = container.querySelector('[data-testid="from-chain"]');
    const evmOptions = Array.from(fromSelect.options).map((o) => o.value);
    assert.ok(evmOptions.includes("eth") && evmOptions.includes("bsc") && evmOptions.includes("arb"),
      "from-chain lists EVM chains (the hop's route)");
    assert.equal(container.querySelector('[data-testid="to-chain"]').value, "x1", "destination fixed to X1");
  } finally {
    unmount();
  }
});

// ── BALANCE LINE: wallet balances + live USD inside the real form ──────────
// The form mounts BalancesLine under the Amount field. With DI'd fetchers it
// shows what the connected wallets hold + its USD worth — Mr. Esters'
// directive ("bridge should have values of what is in the users wallets").

test("balance line renders inside the form: EVM + Solana + X1 balances with live USD", async () => {
  const { container, unmount } = renderForm(FORM_PROPS({
    balancesDeps: {
      priceFetcher: async () => ({ USDC: 1.0, USDT: 1.0, DAI: 1.0, WSOL: 102.0, "USDC.x": 1.0, "wSOL.X": 102.0 }),
      evmBalanceFetcher: async () => 27.59,
      solBalanceFetcher: async () => ({ USDC: 5.2, WSOL: 0.3 }),
      x1BalanceFetcher: async () => ({ "USDC.x": 27.59, "wSOL.X": 0.3 }),
      createConnections: async () => ({ sol: { fake: true }, x1: { fake: true } }),
    },
  }));
  try {
    await flush();
    const line = container.querySelector('[data-testid="balances-line"]');
    assert.ok(line, "the balance line renders inside the bridge form");
    assert.ok(line.textContent.includes("Balances"), "labeled Balances");
    const evm = container.querySelector('[data-testid="balance-evm"]');
    assert.ok(evm && evm.textContent.includes("27.59 USDC ($27.59)"), `EVM side + USD, got: ${evm?.textContent}`);
    const sol = container.querySelector('[data-testid="balance-sol"]');
    assert.ok(sol && sol.textContent.includes("5.2 USDC ($5.20)") && sol.textContent.includes("0.3 WSOL ($30.60)"),
      `Solana USDC+WSOL + USD, got: ${sol?.textContent}`);
    const x1 = container.querySelector('[data-testid="balance-x1"]');
    assert.ok(x1 && x1.textContent.includes("27.59 USDC.x ($27.59)") && x1.textContent.includes("0.3 wSOL.X ($30.60)"),
      `X1 USDC.x+wSOL.X + USD, got: ${x1?.textContent}`);
  } finally {
    unmount();
  }
});

test("balance line fail-soft inside the form: dead RPCs show —, form still works", async () => {
  const { container, unmount } = renderForm(FORM_PROPS({
    balancesDeps: {
      priceFetcher: async () => null,
      evmBalanceFetcher: async () => { throw new Error("eth_call down"); },
      solBalanceFetcher: async () => { throw new Error("RPC down"); },
      x1BalanceFetcher: async () => { throw new Error("RPC down"); },
      createConnections: async () => ({ sol: {}, x1: {} }),
    },
  }));
  try {
    await flush(); // must NOT throw
    const line = container.querySelector('[data-testid="balances-line"]');
    assert.ok(line, "balance line still renders");
    assert.ok(container.querySelector('[data-testid="balance-evm"]').textContent.includes("—"), "EVM side —");
    assert.ok(container.querySelector('[data-testid="balance-sol"]').textContent.includes("—"), "Solana side —");
    assert.ok(container.querySelector('[data-testid="balance-x1"]').textContent.includes("—"), "X1 side —");
    // the bridge form itself is untouched — quote button still there
    assert.ok(container.querySelector('[data-testid="get-quote"]'), "form still fully functional");
  } finally {
    unmount();
  }
});

// ── QUOTE FLOW against the mocked endpoint + fee lines ─────────────────────

test("quote flow: mocked endpoint → x1-class query pinned, fee lines 1% + $1, honest net", async () => {
  const qf = mockQuoteFetch();
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();

    assert.equal(qf.calls.length, 1, "exactly one quote call");
    const url = new URL(qf.calls[0], "http://localhost");
    assert.equal(url.searchParams.get("fromChain"), "eth");
    assert.equal(url.searchParams.get("toChain"), "SOL");
    assert.equal(url.searchParams.has("fee"), false, "x1-class quote OMITS the fee key entirely");
    assert.equal(url.searchParams.get("x1Class"), "1");
    assert.equal(url.searchParams.get("fromAddress"), EVM_ADDR, "real connected EVM address — no placeholders");
    assert.equal(url.searchParams.get("toAddress"), SOL_ADDR, "real connected Solana address — no placeholders");
    assert.equal(url.searchParams.get("allowSwitchChain"), "false");

    const box = container.querySelector('[data-testid="quote-box"]');
    assert.ok(box, "quote box rendered");
    const skim = container.querySelector('[data-testid="fee-line-warp-skim"]');
    assert.ok(skim && skim.textContent.includes("Teleporter fee (1%)") && skim.textContent.includes("$0.99"),
      `1% Teleporter fee line, got: ${skim?.textContent}`);
    const flat = container.querySelector('[data-testid="fee-line-warp-flat"]');
    assert.ok(flat && flat.textContent.includes("Warp bridge fee") && flat.textContent.includes("$1.00"),
      `Warp $1 third-party line, got: ${flat?.textContent}`);
    const recv = container.querySelector('[data-testid="you-receive"]');
    assert.ok(recv && recv.textContent.includes("97.01") && recv.textContent.includes("USDC.x") && recv.textContent.includes("X1"),
      `honest net, got: ${recv?.textContent}`);
    assert.ok(container.querySelector('[data-testid="bridge-now"]'), "send button appears when quoted");
  } finally {
    qf.restore();
    unmount();
  }
});

test("quote flow: sub-floor amount → explicit floor error, no quote call", async () => {
  const qf = mockQuoteFetch();
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "10");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    assert.equal(qf.calls.length, 0, "no quote call below the $25 floor");
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("$25"), `floor error surfaced, got: ${err?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

// ── HONEST DEAD-ENDS: missing wallets surface, never silent ────────────────

test("honest dead-ends: missing Solana wallet → explicit connect prompt, no quote call", async () => {
  const qf = mockQuoteFetch();
  const { container, unmount } = renderForm(
    FORM_PROPS({ solSession: { status: "disconnected" } }),
  );
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    assert.equal(qf.calls.length, 0);
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("Connect your Solana/X1 wallet to get a quote"),
      `explicit prompt, got: ${err?.textContent}`);
    assert.ok(container.querySelector('[data-testid="get-quote"]'), "still on the form (idle)");
  } finally {
    qf.restore();
    unmount();
  }
});

test("honest dead-ends: missing EVM wallet → explicit connect prompt, no quote call", async () => {
  const qf = mockQuoteFetch();
  const { container, unmount } = renderForm(
    FORM_PROPS({ evmSession: { status: "disconnected" } }),
  );
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    assert.equal(qf.calls.length, 0);
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("Connect your EVM wallet to get a quote"),
      `explicit prompt, got: ${err?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("honest dead-ends: quote endpoint error → explicit error, back to idle (no silent dead-end)", async () => {
  const fetcher = mock.fn(async () => ({ ok: true, json: async () => ({ error: "lifi_quote_failed", message: "no routes found" }) }));
  mock.method(globalThis, "fetch", fetcher);
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("no routes found"), `surfaced, got: ${err?.textContent}`);
    assert.ok(container.querySelector('[data-testid="get-quote"]'), "back to idle — retry available");
  } finally {
    mock.restoreAll();
    unmount();
  }
});

// ── THE SIM GATE: a reverting eth_call blocks the send ─────────────────────

test("send gated by the sim: reverting eth_call → eth_sendTransaction NEVER called, reason surfaced", async () => {
  const sent = [];
  const qf = mockQuoteFetch();
  const { container, unmount } = renderForm(
    FORM_PROPS({ evmSession: { status: "connected", address: EVM_ADDR, provider: makeEvmProvider({ revertSim: true, sent }) } }),
  );
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    assert.ok(container.querySelector('[data-testid="bridge-now"]'), "quoted");

    click(container.querySelector('[data-testid="bridge-now"]'));
    await flush();

    assert.equal(sent.length, 0, "eth_sendTransaction must NEVER be called on a doomed tx (Step 1.3A)");
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("Not enough balance"),
      `surfaced revert reason, got: ${err?.textContent}`);
    assert.ok(container.querySelector('[data-testid="bridge-now"]'), "back to quoted — retry available");
  } finally {
    qf.restore();
    unmount();
  }
});

// ── THE WARP_LIVE_SEND GATE on stage 2 ─────────────────────────────────────

test("send gated by WARP_LIVE_SEND: stage-2 runner receives allowLive=false (default flag) → simulated, not sent", async () => {
  const sent = [];
  const qf = mockQuoteFetch();
  const runnerCalls = [];
  const fakeRunner = async (args) => {
    runnerCalls.push(args);
    return { stage: "simulated_ok", success: true, sim: { ok: true }, sent: null }; // confirm-mode result
  };
  const { container, unmount } = renderForm(
    FORM_PROPS({
      evmSession: { status: "connected", address: EVM_ADDR, provider: makeEvmProvider({ sent }) },
      stage2Runner: fakeRunner,
    }),
  );
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    click(container.querySelector('[data-testid="bridge-now"]'));
    await flush();

    assert.equal(sent.length, 1, "stage 1 (the EVM LiFi leg) sent — the sim passed");
    assert.ok(container.querySelector('[data-testid="bridge-step2"]'), "stage 2 prompt rendered");

    click(container.querySelector('[data-testid="bridge-step2"]'));
    await flush();

    assert.equal(runnerCalls.length, 1, "stage-2 runner invoked once");
    assert.equal(runnerCalls[0].allowLive, false,
      "WARP_LIVE_SEND gate: default flag state → allowLive=false (no real Warp broadcast). Arm VITE_WARP_LIVE_SEND=true to broadcast.");
    assert.equal(runnerCalls[0].amountHuman, 99, "stage 2 bridges what LiFi DELIVERED ($99), not the $100 input");

    const done = container.querySelector('[data-testid="done"]');
    assert.ok(done && done.textContent.includes("not sent"),
      `confirm-mode shown, got: ${done?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("stage 2 live path: runner reports a broadcast → honest awaiting-relay state", async () => {
  const qf = mockQuoteFetch();
  const fakeRunner = async () => ({ stage: "sent", success: true, signature: "warp-sig-123" });
  const { container, unmount } = renderForm(FORM_PROPS({ stage2Runner: fakeRunner }));
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    click(container.querySelector('[data-testid="bridge-now"]'));
    await flush();
    click(container.querySelector('[data-testid="bridge-step2"]'));
    await flush();

    const relaying = container.querySelector('[data-testid="relaying"]');
    assert.ok(relaying && relaying.textContent.includes("bridge_out sent") && relaying.textContent.includes("warp-sig-1"),
      `relaying state with the sig (UI truncates it by design), got: ${relaying?.textContent}`);
    assert.ok(container.querySelector('[data-testid="reset"]'), "reset available");
  } finally {
    qf.restore();
    unmount();
  }
});

// ── MULTI-WALLET CONNECT: connect a SECOND family after the first ──────────

// REPRODUCTION (the live-preview bug): TeleportTab switches from ConnectModal
// to ConnectedBody the moment ANY family connects (anyConnected). The modal —
// the ONLY path to connect — is unmounted, so after the first connect there
// was NO way to connect a second family (e.g. Solana after EVM): the bridge
// form showed "Connect your Solana/X1 wallet to get a quote" with no way to
// do it, and the hop (LiFi leg lands USDC on Solana → Warp carries it to X1)
// needs BOTH sessions. These tests lock the fix: ConnectedBody now has a
// "Connect another wallet" affordance that re-opens the modal inline, the
// modal auto-closes when the new family connects, and the form's connect
// warnings are actionable buttons.

test("MULTI-WALLET: after EVM connects, the connected body offers a way to add another wallet", () => {
  const { container, unmount } = renderWithProvider(
    React.createElement(BridgeCard, {}),
    connectedState({ evm: true, evmProvider: makeEvmProvider() }),
  );
  try {
    const body = container.querySelector('[data-testid="teleport-connected"]');
    assert.ok(body, "connected body rendered");
    // PRE-FIX this selector matches nothing — the modal (the only connect
    // path) is unmounted and the body has no way to open it again.
    const affordance = container.querySelector('[data-testid="connect-another"]');
    assert.ok(affordance, "a way to add another wallet is visible after the first connect");
    assert.match(affordance.textContent, /Connect another wallet/);
    assert.equal(container.querySelector('[data-testid="connect-modal"]'), null, "modal is closed by default");
  } finally {
    unmount();
  }
});

test("MULTI-WALLET: clicking 'Connect another wallet' renders the modal; cancel returns to the body", () => {
  const { container, unmount } = renderWithProvider(
    React.createElement(BridgeCard, {}),
    connectedState({ evm: true, evmProvider: makeEvmProvider() }),
  );
  try {
    click(container.querySelector('[data-testid="connect-another"]'));
    const modal = container.querySelector('[data-testid="connect-modal"]');
    assert.ok(modal, "the connect modal renders when adding another wallet");
    // The modal's step 1 is the full family picker — ANY family reachable.
    const familyButtons = [...modal.querySelectorAll(".family-row")].map((b) => b.getAttribute("data-family"));
    assert.deepEqual(familyButtons, WALLET_FAMILIES, "full family picker available");

    // Cancel: back to the connected body, nothing connected.
    click(container.querySelector('[data-testid="cancel-connect"]'));
    assert.equal(container.querySelector('[data-testid="connect-modal"]'), null, "modal closes on cancel");
    assert.ok(container.querySelector('[data-testid="connect-another"]'), "body restored with the affordance");
    assert.equal(container.querySelector('[data-family="solana"]'), null, "no Solana session appeared");
  } finally {
    unmount();
  }
});

test("MULTI-WALLET: connect Solana via the modal → both sessions in the body, solReady clears the warning", async () => {
  const { container, unmount } = renderWithProvider(
    React.createElement(BridgeCard, {}),
    connectedState({ evm: true, evmProvider: makeEvmProvider() }),
  );
  try {
    // No Solana session yet → the form shows the connect warning.
    assert.ok(container.querySelector('[data-testid="warn-solana"]'), "Solana warning visible before the second connect");

    click(container.querySelector('[data-testid="connect-another"]'));
    assert.ok(container.querySelector('[data-testid="connect-modal"]'), "modal open");

    // Pick Solana → connect Starport (mock fallback in the test harness).
    click(container.querySelector('[data-family="solana"]'));
    const starport = [...container.querySelectorAll(".wallet-row")]
      .find((r) => r.getAttribute("data-wallet-id") === "starport");
    await act(async () => {
      starport.querySelector(".connect-btn").click();
      await flush();
    });

    // The modal auto-closes back to the connected body.
    assert.equal(container.querySelector('[data-testid="connect-modal"]'), null, "modal closed after the second connect");
    const body = container.querySelector('[data-testid="teleport-connected"]');
    assert.ok(body, "connected body rendered");

    // BOTH sessions show.
    const evmRow = container.querySelector('[data-family="evm"]');
    const solRow = container.querySelector('[data-family="solana"]');
    assert.ok(evmRow && evmRow.textContent.includes(EVM_ADDR), "EVM session still shown");
    assert.ok(solRow && solRow.textContent.includes("mock:solana:"), "Solana session now shown");

    // The form's solReady is now true — the connect warning clears.
    assert.equal(container.querySelector('[data-testid="warn-solana"]'), null, "Solana connect warning cleared");
    assert.ok(container.querySelector('[data-testid="teleport-form"]'), "form still rendered");
  } finally {
    unmount();
  }
});

test("MULTI-WALLET: works for any pairing — connect Bitcoin after EVM", async () => {
  const { container, unmount } = renderWithProvider(
    React.createElement(BridgeCard, {}),
    connectedState({ evm: true, evmProvider: makeEvmProvider() }),
  );
  try {
    click(container.querySelector('[data-testid="connect-another"]'));
    click(container.querySelector('[data-family="bitcoin"]'));
    const starport = [...container.querySelectorAll(".wallet-row")]
      .find((r) => r.getAttribute("data-wallet-id") === "starport");
    await act(async () => {
      starport.querySelector(".connect-btn").click();
      await flush();
    });

    assert.equal(container.querySelector('[data-testid="connect-modal"]'), null, "modal closed");
    const body = container.querySelector('[data-testid="teleport-connected"]');
    assert.ok(body.textContent.includes(EVM_ADDR), "EVM session shown");
    const btcRow = container.querySelector('[data-family="bitcoin"]');
    assert.ok(btcRow && btcRow.textContent.includes("mock:bitcoin:"), "Bitcoin session shown");
  } finally {
    unmount();
  }
});

test("MULTI-WALLET: the form's Solana connect warning is actionable — opens the connect modal", () => {
  const { container, unmount } = renderWithProvider(
    React.createElement(BridgeCard, {}),
    connectedState({ evm: true, evmProvider: makeEvmProvider() }),
  );
  try {
    const warn = container.querySelector('[data-testid="warn-solana"]');
    assert.ok(warn, "warning visible");
    assert.equal(warn.tagName, "BUTTON", "warning is actionable (a button) when rendered inside the tab");
    click(warn);
    assert.ok(container.querySelector('[data-testid="connect-modal"]'), "clicking the warning opens the connect modal");
  } finally {
    unmount();
  }
});

test("stage 1 sent but the Solana session can't sign → honest handoff (funds safe on Solana), never a silent dead-end", async () => {
  const sent = [];
  const qf = mockQuoteFetch();
  const { container, unmount } = renderForm(
    FORM_PROPS({
      evmSession: { status: "connected", address: EVM_ADDR, provider: makeEvmProvider({ sent }) },
      // Address present (the quote needs the LiFi toAddress) but the session's
      // provider can't sign (mock/demo session, or a wallet that lost its
      // signing surface) — resolveSolanaAdapter → null → handoff after stage 1.
      solSession: { status: "connected", address: SOL_ADDR, provider: { publicKey: {} } },
    }),
  );
  try {
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    click(container.querySelector('[data-testid="bridge-now"]'));
    await flush();

    assert.equal(sent.length, 1, "stage 1 sent");
    const handoff = container.querySelector('[data-testid="handoff"]');
    assert.ok(handoff && handoff.textContent.includes("Stage 1 sent") && handoff.textContent.includes("Warp Bridge"),
      `handoff state with the Warp Bridge escape hatch, got: ${handoff?.textContent}`);
    assert.ok(handoff.querySelector('a[href*="bridge.x1.xyz"]'), "official Warp Bridge link present");
  } finally {
    qf.restore();
    unmount();
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  REVERSE LEG (X1 → ETH): the direction toggle + the off-ramp flow.
//  Forward behavior is unchanged (all tests above pass untouched); these pin
//  the NEW path: toggle → reverse quote (1% + $1 + LiFi leg) → stage 1 X1 burn
//  (WARP_LIVE_SEND-gated) → Warp release poll → stage 2 LiFi Solana→EVM →
//  done / honest handoff.
// ════════════════════════════════════════════════════════════════════════════

/** Mocked /api/lifi/quote for the REVERSE leg (SOL→EVM). $98 net on Solana →
 *  $97.02 delivered on Ethereum (toAmount in base units). */
function mockReverseQuoteFetch() {
  const calls = [];
  const lifiQuote = {
    id: "0xmock-reverse-quote",
    estimate: { toAmount: "97020000", fromAmount: "98000000" },
  };
  const fetcher = mock.fn(async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => lifiQuote };
  });
  mock.method(globalThis, "fetch", fetcher);
  return { calls, restore: () => mock.restoreAll() };
}

async function reverseQuote(container) {
  setInput(container.querySelector('[data-testid="amount"]'), "100");
  click(container.querySelector('[data-testid="dir-reverse"]'));
  click(container.querySelector('[data-testid="get-quote"]'));
  await flush();
}

test("direction toggle: default forward; X1→ETH switch flips the form to the reverse state (X1 source, EVM destinations, USDC.x token)", () => {
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    assert.ok(container.querySelector('[data-testid="direction-toggle"]'), "direction toggle rendered");
    // Default: the proven forward state — EVM from-picker, X1 fixed destination.
    const fromSelect = container.querySelector('[data-testid="from-chain"]');
    assert.ok(Array.from(fromSelect.options).some((o) => o.value === "eth"), "forward from-picker lists EVM chains");
    assert.equal(container.querySelector('[data-testid="to-chain"]').value, "x1", "forward destination fixed to X1");

    // Flip to reverse.
    click(container.querySelector('[data-testid="dir-reverse"]'));
    assert.equal(container.querySelector('[data-testid="from-chain"]').value, "x1", "reverse source fixed to X1");
    const toSelect = container.querySelector('[data-testid="to-chain"]');
    assert.ok(Array.from(toSelect.options).some((o) => o.value === "eth") && Array.from(toSelect.options).some((o) => o.value === "arb"),
      "reverse destination picker lists EVM chains");
    assert.equal(container.querySelector('[data-testid="token"]').value, "USDC.x", "reverse token fixed to USDC.x");
    const toTokenSelect = container.querySelector('[data-testid="to-token"]');
    assert.ok(toTokenSelect, "reverse destination-token selector present");
    assert.deepEqual(Array.from(toTokenSelect.options).map((o) => o.value), ["USDC", "USDT", "DAI"],
      "Ethereum destination offers the full stable set (USDC/USDT/DAI)");
    assert.equal(toTokenSelect.value, "USDC", "destination token defaults to USDC");

    // Flip back — the forward state returns.
    click(container.querySelector('[data-testid="dir-forward"]'));
    assert.equal(container.querySelector('[data-testid="to-chain"]').value, "x1");
    assert.ok(Array.from(container.querySelector('[data-testid="from-chain"]').options).some((o) => o.value === "eth"));
  } finally {
    unmount();
  }
});

test("reverse quote flow: pinned SOL→EVM query (x1Class=1, fee OMITTED), fee lines 1% + $1, honest Ethereum net", async () => {
  const qf = mockReverseQuoteFetch();
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    await reverseQuote(container);

    assert.equal(qf.calls.length, 1, "exactly one quote call (the LiFi SOL→EVM leg)");
    const url = new URL(qf.calls[0], "http://localhost");
    assert.equal(url.searchParams.get("fromChain"), "SOL");
    assert.equal(url.searchParams.get("toChain"), "eth");
    assert.equal(url.searchParams.get("fromToken"), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Solana USDC source");
    assert.equal(url.searchParams.get("toToken"), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "Ethereum USDC destination");
    assert.equal(url.searchParams.get("fromAmount"), "98000000", "the net that lands on Solana ($98), in base units");
    assert.equal(url.searchParams.get("fromAddress"), SOL_ADDR, "real connected Solana address — no placeholders");
    assert.equal(url.searchParams.get("toAddress"), EVM_ADDR, "real connected EVM address — no placeholders");
    assert.equal(url.searchParams.get("x1Class"), "1", "x1-class marker");
    assert.equal(url.searchParams.has("fee"), false, "x1-class quote OMITS the fee key entirely");

    const box = container.querySelector('[data-testid="quote-box"]');
    assert.ok(box, "quote box rendered");
    const skim = container.querySelector('[data-testid="fee-line-warp-skim"]');
    assert.ok(skim && skim.textContent.includes("Teleporter fee (1%)") && skim.textContent.includes("$1.00"),
      `1% Teleporter fee line, got: ${skim?.textContent}`);
    const flat = container.querySelector('[data-testid="fee-line-warp-flat"]');
    assert.ok(flat && flat.textContent.includes("Warp bridge fee") && flat.textContent.includes("$1.00"),
      `Warp $1 third-party line, got: ${flat?.textContent}`);
    const recv = container.querySelector('[data-testid="you-receive"]');
    assert.ok(recv && recv.textContent.includes("97.02") && recv.textContent.includes("USDC") && recv.textContent.includes("Ethereum"),
      `honest Ethereum net, got: ${recv?.textContent}`);
    assert.equal(container.querySelector('[data-testid="reverse-lifi-note"]'), null, "no handoff note when the leg quoted");
    assert.ok(container.querySelector('[data-testid="bridge-now"]'), "send button appears when quoted");
  } finally {
    qf.restore();
    unmount();
  }
});

test("reverse quote without a LiFi route → honest handoff note; stage 1 (the X1 burn) still quoted on Solana", async () => {
  const fetcher = mock.fn(async () => ({ ok: true, json: async () => ({ error: "lifi_quote_failed", message: "no routes found" }) }));
  mock.method(globalThis, "fetch", fetcher);
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    await reverseQuote(container);
    // Stage 1 is still fully quoted — the burn works; the EVM leg is the next stage.
    const note = container.querySelector('[data-testid="reverse-lifi-note"]');
    assert.ok(note, "honest handoff note rendered");
    const recv = container.querySelector('[data-testid="you-receive"]');
    assert.ok(recv && recv.textContent.includes("98.00") && recv.textContent.includes("Solana"),
      `you-receive is the USDC on Solana (not an invented EVM figure), got: ${recv?.textContent}`);
    assert.ok(container.querySelector('[data-testid="bridge-now"]'), "stage 1 (burn) still available");
  } finally {
    mock.restoreAll();
    unmount();
  }
});

test("REVERSE stage 1 gated by WARP_LIVE_SEND: runner receives allowLive=false (default flag) + gross amount → simulated, not sent", async () => {
  const qf = mockReverseQuoteFetch();
  const runnerCalls = [];
  const fakeRunner = async (args) => {
    runnerCalls.push(args);
    return { stage: "simulated_ok", success: true, sim: { ok: true }, sent: null };
  };
  const { container, unmount } = renderForm(FORM_PROPS({ reverseStage1Runner: fakeRunner }));
  try {
    await reverseQuote(container);
    click(container.querySelector('[data-testid="bridge-now"]'));
    await flush();

    assert.equal(runnerCalls.length, 1, "reverse stage-1 runner invoked once");
    assert.equal(runnerCalls[0].allowLive, false,
      "WARP_LIVE_SEND gate: default flag state → allowLive=false (no real X1 burn). Arm VITE_WARP_LIVE_SEND=true to broadcast.");
    assert.equal(runnerCalls[0].amountHuman, 100, "runner receives the GROSS — it skims 1% and burns the net");

    const done = container.querySelector('[data-testid="done"]');
    assert.ok(done && done.textContent.includes("not sent"),
      `confirm-mode shown, got: ${done?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("REVERSE AUTO-FIRE: release poll resolves ok:true → stage-2 runner invoked AUTOMATICALLY (no click), net = what landed on Solana", async () => {
  const qf = mockReverseQuoteFetch();
  const fakeRunner1 = async () => ({ stage: "sent", success: true, signature: "burn-sig-123" });
  const pollStages = [];
  const fakePoller = async (sig, { onUpdate } = {}) => {
    onUpdate("awaiting_guardians", {});
    onUpdate("guardians_signing", { count: 3 });
    onUpdate("complete", { destinationTx: "release-tx-456" });
    pollStages.push("polled:" + sig);
    return { ok: true, destinationTx: "release-tx-456" };
  };
  const stage2Calls = [];
  const fakeRunner2 = async (args) => {
    stage2Calls.push(args);
    return "lifi-final-hash";
  };
  const { container, unmount } = renderForm(FORM_PROPS({
    reverseStage1Runner: fakeRunner1,
    releasePoller: fakePoller,
    reverseStage2Runner: fakeRunner2,
  }));
  try {
    await reverseQuote(container);
    click(container.querySelector('[data-testid="bridge-now"]'));
    await flush();

    assert.deepEqual(pollStages, ["polled:burn-sig-123"], "release poller called with the burn signature");
    assert.equal(stage2Calls.length, 1, "stage-2 runner invoked AUTOMATICALLY — no manual click");
    assert.equal(stage2Calls[0].to, "eth");
    assert.equal(stage2Calls[0].toTokenSymbol, "USDC", "default destination stable USDC flows into the LiFi leg");
    assert.equal(stage2Calls[0].evmAddress, EVM_ADDR, "destination = the connected EVM wallet");
    assert.equal(stage2Calls[0].netOnSolana, 98, "bridges the net that LANDED on Solana (100 − 1% − $1)");
    // The journey is ONE continuous flow (burn → guardians → released → LiFi
    // → done) — no manual stage-2 button remains in the auto-fired flow.
    assert.equal(container.querySelector('[data-testid="bridge-step2"]'), null, "no manual stage-2 button in the auto-fired flow");
    const done = container.querySelector('[data-testid="done"]');
    assert.ok(done && done.textContent.includes("USDC on Ethereum"),
      `done state on the destination chain, got: ${done?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("REVERSE AUTO-FIRE failure: auto-fired stage 2 fails → error + Retry button, EXACTLY ONE auto attempt (no retry loop)", async () => {
  const qf = mockReverseQuoteFetch();
  const fakeRunner1 = async () => ({ stage: "sent", success: true, signature: "burn-sig" });
  const fakePoller = async () => ({ ok: true, destinationTx: "release-tx" });
  let stage2Attempts = 0;
  const fakeRunner2 = async () => {
    stage2Attempts += 1;
    throw new Error("No LiFi route for this pair");
  };
  const { container, unmount } = renderForm(FORM_PROPS({
    reverseStage1Runner: fakeRunner1,
    releasePoller: fakePoller,
    reverseStage2Runner: fakeRunner2,
  }));
  try {
    await reverseQuote(container);
    click(container.querySelector('[data-testid="bridge-now"]'));
    await flush();

    assert.equal(stage2Attempts, 1, "exactly ONE auto attempt — the auto-fire never loops");
    const handoff = container.querySelector('[data-testid="handoff"]');
    assert.ok(handoff && handoff.textContent.includes("safe on Solana"),
      `honest handoff, got: ${handoff?.textContent}`);
    const err = container.querySelector('[data-testid="form-error"]');
    assert.ok(err && err.textContent.includes("No LiFi route"), `surfaced reason, got: ${err?.textContent}`);
    assert.ok(container.querySelector('[data-testid="retry-stage2"]'), "retry affordance present");
    assert.ok(container.querySelector('[data-testid="reset"]'), "reset present");

    // No auto-retry: after the dust settles, still exactly one attempt.
    await flush();
    await flush();
    assert.equal(stage2Attempts, 1, "no infinite auto-retry — still one attempt after further flushes");

    // The manual Retry path still works — the user finishes the hop by hand.
    click(container.querySelector('[data-testid="retry-stage2"]'));
    await flush();
    assert.equal(stage2Attempts, 2, "manual Retry re-invokes the stage-2 runner");
    assert.ok(container.querySelector('[data-testid="retry-stage2"]'), "retry affordance remains after the manual retry fails");
  } finally {
    qf.restore();
    unmount();
  }
});

test("FORWARD token choice restored: USDC/USDT/DAI offered on Ethereum; selecting USDT drives the quote to the USDT address", async () => {
  const qf = mockQuoteFetch();
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    const tokenSelect = container.querySelector('[data-testid="token"]');
    assert.ok(tokenSelect, "token picker present");
    assert.equal(tokenSelect.value, "USDC", "defaults to USDC");
    assert.deepEqual(Array.from(tokenSelect.options).map((o) => o.value), ["USDC", "USDT", "DAI"],
      "Ethereum offers the full stable set (TOKENS.eth)");

    // The user picks USDT — the change event MOVES the token (real state).
    act(() => {
      tokenSelect.value = "USDT";
      tokenSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(container.querySelector('[data-testid="token"]').value, "USDT", "token state follows the selection");

    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();

    assert.equal(qf.calls.length, 1, "exactly one quote call");
    const url = new URL(qf.calls[0], "http://localhost");
    assert.equal(url.searchParams.get("fromChain"), "eth");
    assert.equal(url.searchParams.get("fromToken"), "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "forward quote uses the SELECTED source token (USDT on Ethereum), not hardcoded USDC");
    const box = container.querySelector('[data-testid="quote-box"]');
    assert.ok(box && box.textContent.includes("USDT on Ethereum"),
      `you-send names the chosen source token, got: ${box?.textContent}`);
    // The X1 side is untouched — you receive USDC.x (the burn mint) regardless.
    const recv = container.querySelector('[data-testid="you-receive"]');
    assert.ok(recv && recv.textContent.includes("USDC.x") && recv.textContent.includes("X1"),
      `X1 receive stays USDC.x, got: ${recv?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("chain switch resets the token to one the new chain defines (base has no USDT)", () => {
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    // FORWARD: eth USDT → switch the from-chain to base → resets to USDC.
    const tokenSelect = container.querySelector('[data-testid="token"]');
    act(() => {
      tokenSelect.value = "USDT";
      tokenSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(tokenSelect.value, "USDT", "USDT selected on Ethereum");
    const fromSelect = container.querySelector('[data-testid="from-chain"]');
    act(() => {
      fromSelect.value = "bas";
      fromSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const after = container.querySelector('[data-testid="token"]');
    assert.equal(after.value, "USDC", "reset to USDC — base defines USDC + DAI, no USDT");
    assert.deepEqual(Array.from(after.options).map((o) => o.value), ["USDC", "DAI"],
      "base offers exactly the stables TOKENS.bas defines");

    // REVERSE: to eth USDT → switch the destination to base → resets to USDC.
    click(container.querySelector('[data-testid="dir-reverse"]'));
    const toSelect = container.querySelector('[data-testid="to-chain"]');
    const toToken = container.querySelector('[data-testid="to-token"]');
    assert.deepEqual(Array.from(toToken.options).map((o) => o.value), ["USDC", "USDT", "DAI"],
      "ethereum destination offers the full stable set (the default to-chain)");
    act(() => {
      toSelect.value = "bas";
      toSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const basToken = container.querySelector('[data-testid="to-token"]');
    assert.deepEqual(Array.from(basToken.options).map((o) => o.value), ["USDC", "DAI"],
      "base destination offers USDC + DAI, no USDT");
    act(() => {
      basToken.value = "USDT";
      basToken.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(container.querySelector('[data-testid="to-token"]').value, "USDC",
      "USDT cannot be selected on base — the token stays at the valid USDC");
    act(() => {
      toSelect.value = "eth";
      toSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const ethToken = container.querySelector('[data-testid="to-token"]');
    assert.deepEqual(Array.from(ethToken.options).map((o) => o.value), ["USDC", "USDT", "DAI"],
      "back on ethereum the full stable set returns");
    act(() => {
      ethToken.value = "USDT";
      ethToken.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(ethToken.value, "USDT", "USDT selected on the Ethereum destination");
    act(() => {
      toSelect.value = "bas";
      toSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(container.querySelector('[data-testid="to-token"]').value, "USDC",
      "reset to USDC — the new destination chain has no USDT");
  } finally {
    unmount();
  }
});

test("REVERSE destination token drives the LiFi leg: USDT on Ethereum → quote params use the USDT address, you-receive names USDT", async () => {
  const qf = mockReverseQuoteFetch();
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    click(container.querySelector('[data-testid="dir-reverse"]'));
    const toToken = container.querySelector('[data-testid="to-token"]');
    act(() => {
      toToken.value = "USDT";
      toToken.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();

    assert.equal(qf.calls.length, 1, "exactly one quote call (the LiFi SOL→EVM leg)");
    const url = new URL(qf.calls[0], "http://localhost");
    assert.equal(url.searchParams.get("toToken"), "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "destination = the SELECTED USDT, not hardcoded USDC");
    assert.equal(url.searchParams.get("fromToken"), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "source stays Solana USDC (the Warp release)");
    assert.equal(url.searchParams.get("fromAmount"), "98000000", "source-side amount stays USDC 6 decimals");
    const recv = container.querySelector('[data-testid="you-receive"]');
    assert.ok(recv && recv.textContent.includes("USDT") && recv.textContent.includes("Ethereum"),
      `you-receive names the selected destination stable, got: ${recv?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("REVERSE stage-2 delivers the SELECTED destination token: the auto-fired LiFi runner receives toTokenSymbol", async () => {
  const qf = mockReverseQuoteFetch();
  const fakeRunner1 = async () => ({ stage: "sent", success: true, signature: "burn-sig" });
  const fakePoller = async () => ({ ok: true, destinationTx: "release-tx" });
  const stage2Calls = [];
  const fakeRunner2 = async (args) => { stage2Calls.push(args); return "lifi-final-hash"; };
  const { container, unmount } = renderForm(FORM_PROPS({
    reverseStage1Runner: fakeRunner1,
    releasePoller: fakePoller,
    reverseStage2Runner: fakeRunner2,
  }));
  try {
    click(container.querySelector('[data-testid="dir-reverse"]'));
    const toToken = container.querySelector('[data-testid="to-token"]');
    act(() => {
      toToken.value = "DAI";
      toToken.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    setInput(container.querySelector('[data-testid="amount"]'), "100");
    click(container.querySelector('[data-testid="get-quote"]'));
    await flush();
    click(container.querySelector('[data-testid="bridge-now"]'));
    await flush();

    assert.equal(stage2Calls.length, 1, "stage-2 runner invoked (auto-fire)");
    assert.equal(stage2Calls[0].toTokenSymbol, "DAI", "the SELECTED destination stable flows into the LiFi leg");
    assert.equal(stage2Calls[0].to, "eth");
    assert.equal(stage2Calls[0].netOnSolana, 98, "stage-2 math unchanged — fees stay on the X1/Solana source side");
    const done = container.querySelector('[data-testid="done"]');
    assert.ok(done && done.textContent.includes("DAI on Ethereum"),
      `done state names the selected destination stable, got: ${done?.textContent}`);
  } finally {
    qf.restore();
    unmount();
  }
});

test("REVERSE token: USDC.x default, wSOL.X now offered (SOL rail) — change events switch the burn token", () => {
  const { container, unmount } = renderForm(FORM_PROPS());
  try {
    click(container.querySelector('[data-testid="dir-reverse"]'));
    const tokenSelect = container.querySelector('[data-testid="token"]');
    assert.ok(tokenSelect, "token picker present in reverse");
    assert.equal(tokenSelect.value, "USDC.x", "reverse token defaults to USDC.x");
    assert.equal(tokenSelect.getAttribute("aria-label"), "Token to burn on X1", "aria-label names the burn token");
    assert.deepEqual(Array.from(tokenSelect.options).map((o) => o.value), ["USDC.x", "wSOL.X"], "USDC.x + wSOL.X offered (both bridged by Warp)");
    assert.equal(tokenSelect.textContent.includes("USDT"), false, "USDT not rendered");
    assert.equal(tokenSelect.textContent.includes("DAI"), false, "DAI not rendered");

    act(() => {
      tokenSelect.value = "wSOL.X";
      tokenSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(container.querySelector('[data-testid="token"]').value, "wSOL.X", "token switches to wSOL.X");

    // The reverse FROM selector (the X1 leg) offers the same two bridged tokens.
    const fromSelect = container.querySelector('[data-testid="from-chain"]');
    assert.equal(fromSelect.value, "x1", "reverse source fixed to X1");
    assert.deepEqual(Array.from(container.querySelector('[data-testid="x1-token"]').options).map((o) => o.value), ["USDC.x", "wSOL.X"], "X1 source offers USDC.x + wSOL.X");
    assert.equal(fromSelect.textContent.includes("USDT"), false, "no USDT on the X1 source");
    assert.equal(fromSelect.textContent.includes("DAI"), false, "no DAI on the X1 source");
    // The stablecoin CHOICE lives on the destination side — never the X1 side.
    assert.ok(container.querySelector('[data-testid="to-token"]'), "destination token selector present in reverse");
  } finally {
    unmount();
  }
});
