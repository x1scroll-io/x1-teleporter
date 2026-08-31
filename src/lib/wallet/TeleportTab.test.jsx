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
  act(() => {
    root.render(
      React.createElement(WalletProvider, { discovery: FAKE_DISCOVERY, initialState },
        element),
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
