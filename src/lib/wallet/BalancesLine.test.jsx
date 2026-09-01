/**
 * BalancesLine.test.jsx — the bridge form's wallet-balances line with LIVE
 * USD values. DOM-level tests (jsdom + React 18 act), fully DI-able: every
 * fetcher (EVM balance, Solana, X1, prices, provider resolver) is injected
 * — no network, no real chains.
 *
 * Covers the directive: "bridge should have values of what is in the users
 * wallets" — each connected wallet's relevant token balances AND their USD
 * worth; EVM USDC/USDT/DAI (per-token decimals), Solana USDC+WSOL, X1
 * USDC.x+wSOL.X; fail-soft on RPC errors; refresh on wallet/chain/token/
 * amount changes.
 */
import { dom } from "../thorchain/jsdomSetup.js"; // MUST stay the first import
import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import BalancesLine from "../../components/BalancesLine.jsx";
import { SOLANA_RPC_LADDER, X1_RPC_LADDER } from "../balances.js";

const EVM_ADDR = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";
const SOL_ADDR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** DI'd fetchers shared by most tests — canned prices, no-op fetchers.
 *  IMPORTANT: spread `...DI` FIRST, then the test's specific overrides, so
 *  the per-test fetchers win. */
const DI = {
  priceFetcher: async () => ({
    USDC: 1.0, USDT: 1.0, DAI: 1.0, WSOL: 102.0, "USDC.x": 1.0, "wSOL.X": 102.0,
  }),
  resolveEvmProviderFn: async () => ({ request: async () => "0x0" }),
};

function renderBalances(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(BalancesLine, props));
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Flush async fetcher microtasks (all DI fetchers resolve in a few ticks). */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const BASE = {
  direction: "forward", from: "eth", to: "x1", token: "USDC",
  reverseToken: "USDC.x", destToken: "USDC.x", amount: "100",
};

// ── no wallets → nothing rendered ──────────────────────────────────────────

test("no wallets connected → the balance line renders nothing (no crash)", () => {
  const { container, unmount } = renderBalances({ ...BASE, ...DI, evmSession: null, solSession: null });
  try {
    assert.equal(container.querySelector('[data-testid="balances-line"]'), null);
  } finally {
    unmount();
  }
});

// ── EVM side: selected token balance + USD (forward: source chain) ─────────

test("forward EVM: selected token balance + USD on the source chain (USDC)", async () => {
  const calls = [];
  const evmBalanceFetcher = async ({ provider, wallet, token }) => {
    calls.push({ wallet, token });
    return 27.59; // human units — decimals handled by balances.js
  };
  const { container, unmount } = renderBalances({
    ...BASE, ...DI,
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher,
  });
  try {
    await flush();
    const line = container.querySelector('[data-testid="balances-line"]');
    assert.ok(line, "balance line renders");
    assert.equal(container.querySelector('[data-testid="balance-sol"]'), null, "no Solana side without a Solana wallet");
    assert.equal(container.querySelector('[data-testid="balance-x1"]'), null, "no X1 side without a Solana/X1 wallet");

    const evm = container.querySelector('[data-testid="balance-evm"]');
    assert.ok(evm.textContent.includes("Ethereum:"), "EVM side labeled with the source chain name");
    assert.ok(evm.textContent.includes("27.59 USDC"), `balance shown, got: ${evm.textContent}`);
    assert.ok(evm.textContent.includes("($27.59)"), `live USD value shown (27.59 × $1), got: ${evm.textContent}`);

    // the fetcher received the connected wallet + the USDC token spec
    assert.equal(calls[0].wallet, EVM_ADDR);
    assert.equal(calls[0].token.address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    assert.equal(calls[0].token.decimals, 6, "USDC decimals from TOKENS");
  } finally {
    unmount();
  }
});

test("EVM USDT + DAI: per-token decimals reach the fetcher; USD math holds", async () => {
  // USDT (6 dec)
  let seen = [];
  const { container: c1, unmount: u1 } = renderBalances({
    ...BASE, ...DI, token: "USDT",
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher: async ({ token }) => { seen.push(token.decimals); return 12.345678; },
  });
  try {
    await flush();
    assert.ok(c1.querySelector('[data-testid="balance-evm"]').textContent.includes("12.345678 USDT ($12.35)"),
      "USDT 6-dec balance + USD");
  } finally { u1(); }

  // DAI (18 dec) — from=eth has DAI
  const { container: c2, unmount: u2 } = renderBalances({
    ...BASE, ...DI, token: "DAI",
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher: async ({ token }) => { seen.push(token.decimals); return 27.59; },
  });
  try {
    await flush();
    assert.ok(c2.querySelector('[data-testid="balance-evm"]').textContent.includes("27.59 DAI ($27.59)"),
      "DAI 18-dec balance + USD");
  } finally { u2(); }

  assert.deepEqual(seen, [6, 18], "USDT 6 decimals, DAI 18 decimals — per TOKENS");
});

test("reverse EVM: the selected destination token on the destination chain", async () => {
  const calls = [];
  const { container, unmount } = renderBalances({
    ...BASE, ...DI,
    direction: "reverse", from: "x1", to: "arb", token: "USDT",
    reverseToken: "USDC.x", destToken: "USDC.x", amount: "50",
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher: async ({ token }) => { calls.push(token); return 8.5; },
  });
  try {
    await flush();
    const evm = container.querySelector('[data-testid="balance-evm"]');
    assert.ok(evm.textContent.includes("Arbitrum:"), "reverse EVM side = destination chain");
    assert.ok(evm.textContent.includes("8.5 USDT ($8.50)"), `reverse dest token + USD, got: ${evm.textContent}`);
    assert.equal(calls[0].address, "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "Arbitrum USDT address");
  } finally {
    unmount();
  }
});

// ── Solana side: USDC + WSOL with USD ──────────────────────────────────────

test("Solana: USDC + WSOL balances with live USD values", async () => {
  const { container, unmount } = renderBalances({
    ...BASE, ...DI,
    evmSession: null,
    solSession: { status: "connected", address: SOL_ADDR },
    solBalanceFetcher: async ({ rpcs, wallet, mints }) => {
      assert.equal(wallet, SOL_ADDR);
      assert.deepEqual(rpcs, SOLANA_RPC_LADDER, "component wires the live-site Solana fallback ladder");
      assert.deepEqual(mints.map((m) => m.symbol), ["USDC", "WSOL"]);
      return { USDC: 5.2, WSOL: 0.3 };
    },
    // inject BOTH SVM fetchers — the default x1 fetcher would fire a real
    // network fetch (no fake connection to short-circuit on anymore)
    x1BalanceFetcher: async () => null,
  });
  try {
    await flush();
    const sol = container.querySelector('[data-testid="balance-sol"]');
    assert.ok(sol, "Solana side renders");
    assert.ok(sol.textContent.includes("5.2 USDC ($5.20)"), `USDC + USD, got: ${sol.textContent}`);
    assert.ok(sol.textContent.includes("0.3 WSOL ($30.60)"), `WSOL + USD (0.3 × $102), got: ${sol.textContent}`);
    assert.equal(container.querySelector('[data-testid="balance-evm"]'), null, "no EVM side without an EVM wallet");
  } finally {
    unmount();
  }
});

// ── X1 side: USDC.x + wSOL.X with USD ──────────────────────────────────────

test("X1: USDC.x + wSOL.X balances with live USD values (same Solana session)", async () => {
  const { container, unmount } = renderBalances({
    ...BASE, ...DI,
    evmSession: null,
    solSession: { status: "connected", address: SOL_ADDR },
    x1BalanceFetcher: async ({ rpcs, wallet, mints }) => {
      assert.equal(wallet, SOL_ADDR, "X1 wallet = the Solana session's address (SVM-compatible)");
      assert.deepEqual(rpcs, X1_RPC_LADDER, "component wires the X1_RPC ladder");
      assert.deepEqual(mints.map((m) => m.symbol), ["USDC.x", "wSOL.X"]);
      return { "USDC.x": 27.59, "wSOL.X": 0.3 };
    },
    // inject BOTH SVM fetchers — the default sol fetcher would fire a real
    // network fetch (no fake connection to short-circuit on anymore)
    solBalanceFetcher: async () => null,
  });
  try {
    await flush();
    const x1 = container.querySelector('[data-testid="balance-x1"]');
    assert.ok(x1, "X1 side renders");
    assert.ok(x1.textContent.includes("27.59 USDC.x ($27.59)"), `USDC.x + USD, got: ${x1.textContent}`);
    assert.ok(x1.textContent.includes("0.3 wSOL.X ($30.60)"), `wSOL.X + USD (0.3 × $102), got: ${x1.textContent}`);
  } finally {
    unmount();
  }
});

test("all three sides render together when both wallets are connected", async () => {
  const { container, unmount } = renderBalances({
    ...BASE, ...DI,
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: { status: "connected", address: SOL_ADDR },
    evmBalanceFetcher: async () => 100,
    solBalanceFetcher: async () => ({ USDC: 5.2, WSOL: 0.3 }),
    x1BalanceFetcher: async () => ({ "USDC.x": 27.59, "wSOL.X": 0.3 }),
  });
  try {
    await flush();
    assert.ok(container.querySelector('[data-testid="balance-evm"]'), "EVM side");
    assert.ok(container.querySelector('[data-testid="balance-sol"]'), "Solana side");
    assert.ok(container.querySelector('[data-testid="balance-x1"]'), "X1 side");
    const line = container.querySelector('[data-testid="balances-line"]');
    assert.ok(line.textContent.includes("Balances"), "line is labeled Balances");
    assert.ok(line.textContent.includes("100 USDC ($100.00)"), "EVM 100 USDC ≈ $100");
  } finally {
    unmount();
  }
});

// ── fail-soft: RPC errors never block the form ─────────────────────────────

test("fail-soft: EVM RPC error → '—' for the EVM side, others still render", async () => {
  const { container, unmount } = renderBalances({
    ...BASE, ...DI,
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: { status: "connected", address: SOL_ADDR },
    evmBalanceFetcher: async () => { throw new Error("eth_call reverted"); },
    solBalanceFetcher: async () => ({ USDC: 5.2, WSOL: 0.3 }),
    x1BalanceFetcher: async () => ({ "USDC.x": 27.59, "wSOL.X": 0.3 }),
  });
  try {
    await flush(); // must NOT throw
    const evm = container.querySelector('[data-testid="balance-evm"]');
    assert.ok(evm.textContent.includes("—"), `EVM side shows —, got: ${evm.textContent}`);
    assert.ok(container.querySelector('[data-testid="balance-sol"]').textContent.includes("5.2 USDC"),
      "Solana side unaffected by the EVM failure");
  } finally {
    unmount();
  }
});

test("fail-soft: Solana/X1 RPC down → '—' for those sides, form never throws", async () => {
  const { container, unmount } = renderBalances({
    ...BASE, ...DI,
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: { status: "connected", address: SOL_ADDR },
    evmBalanceFetcher: async () => 27.59,
    solBalanceFetcher: async () => { throw new Error("RPC unavailable"); },
    x1BalanceFetcher: async () => { throw new Error("RPC unavailable"); },
  });
  try {
    await flush();
    assert.ok(container.querySelector('[data-testid="balance-sol"]').textContent.includes("—"), "Solana side —");
    assert.ok(container.querySelector('[data-testid="balance-x1"]').textContent.includes("—"), "X1 side —");
    assert.ok(container.querySelector('[data-testid="balance-evm"]').textContent.includes("27.59 USDC"),
      "EVM side unaffected");
  } finally {
    unmount();
  }
});

test("fail-soft: price fetch failure → balances render WITHOUT USD values", async () => {
  const { container, unmount } = renderBalances({
    ...BASE, ...DI,
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher: async () => 27.59,
    priceFetcher: async () => { throw new Error("coingecko down"); },
  });
  try {
    await flush();
    const evm = container.querySelector('[data-testid="balance-evm"]');
    assert.ok(evm.textContent.includes("27.59 USDC"), "balance still shown");
    assert.ok(!evm.textContent.includes("$"), "no USD value when the price is unavailable — never a hardcoded guess");
  } finally {
    unmount();
  }
});

// ── refresh triggers ───────────────────────────────────────────────────────

/** Stateful wrapper: re-renders BalancesLine with merged prop changes — the
 *  honest way to drive refresh triggers (same root, new props). */
function renderHarness(baseProps) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const state = { ...baseProps };
  const set = (patch) => {
    Object.assign(state, patch);
    act(() => {
      root.render(React.createElement(BalancesLine, state));
    });
  };
  act(() => {
    root.render(React.createElement(BalancesLine, state));
  });
  return {
    container,
    set,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test("refresh: changing the selected token refetches with the new token spec", async () => {
  const calls = [];
  const evmBalanceFetcher = async ({ token }) => { calls.push(token.address); return 1; };
  const h = renderHarness({
    ...BASE, ...DI, token: "USDC",
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher,
  });
  try {
    await flush();
    assert.equal(calls.length, 1, "initial load");
    assert.equal(calls[0], "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC address");
    h.set({ token: "DAI" });
    await flush();
    assert.equal(calls[1], "0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI address fetched on token change");
    assert.ok(h.container.querySelector('[data-testid="balance-token-DAI"]'), "line now shows the DAI token");
  } finally {
    h.unmount();
  }
});

test("refresh: chain change (from) refetches the EVM side for the new chain's token", async () => {
  const calls = [];
  const evmBalanceFetcher = async ({ token }) => { calls.push(token.address); return 1; };
  const h = renderHarness({
    ...BASE, ...DI, from: "eth",
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher,
  });
  try {
    await flush();
    assert.equal(calls.length, 1);
    h.set({ from: "bsc" }); // BSC USDC (18 dec) — different contract
    await flush();
    assert.equal(calls[1], "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "BSC USDC address on chain change");
    assert.ok(h.container.querySelector('[data-testid="balance-evm"]').textContent.includes("BNB Chain:"),
      "EVM side relabeled for the new chain");
  } finally {
    h.unmount();
  }
});

test("refresh: refreshSignal bump refetches (the post-bridge manual refresh)", async () => {
  let count = 0;
  const evmBalanceFetcher = async () => { count += 1; return 10; };
  const h = renderHarness({
    ...BASE, ...DI,
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher,
    refreshSignal: 0,
  });
  try {
    await flush();
    assert.equal(count, 1, "initial load");
    h.set({ refreshSignal: 1 }); // the form bumps this after a bridge completes
    await flush();
    assert.equal(count, 2, "refreshSignal bump → refetch");
  } finally {
    h.unmount();
  }
});

test("refresh: amount changes are debounced — one refetch after typing settles", async () => {
  let count = 0;
  const evmBalanceFetcher = async () => { count += 1; return 10; };
  const h = renderHarness({
    ...BASE, ...DI, amount: "10",
    evmSession: { status: "connected", address: EVM_ADDR },
    solSession: null,
    evmBalanceFetcher,
    debounceMs: 40,
  });
  try {
    await flush();
    const afterMount = count;
    assert.ok(afterMount >= 1, "initial load");
    // Type: two rapid amount changes within the debounce window → ONE extra
    // fetch (the second change cancels the first timer).
    h.set({ amount: "50" });
    h.set({ amount: "100" });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); }); // > debounceMs
    assert.equal(count, afterMount + 1, `debounce collapsed rapid changes into one refetch (count=${count})`);
  } finally {
    h.unmount();
  }
});
