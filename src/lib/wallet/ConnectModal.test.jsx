/**
 * ConnectModal + BridgeCard render tests (Step 2.2) — jsdom + React 18 act.
 *
 * Proves at the DOM level what modalLogic.test.js proves at the data level:
 * Starport pinned first, installed highlighted, not-installed shown with
 * install links, never hidden — plus the sequential connect flow
 * (family → wallet → connected/error) and the one-card tab shell
 * (Teleport / THORChain / Buy tabs per docs/BRIEF.md).
 *
 * A fake discovery handle stands in for walletDiscovery.js: it can be fed
 * announce events mid-test to prove the modal reacts to late-discovered
 * wallets (installed highlighting updates without a reload). EVM entries
 * carry REAL wagmi mock connectors, so the connect path through
 * createEvmProviderAdapter is exercised for real.
 */

import { JSDOM } from "jsdom";

// jsdom globals must exist BEFORE react-dom is imported/evaluated.
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
import { createConfig, createStorage, http, noopStorage } from "wagmi";
import { mock } from "wagmi/connectors";
import { mainnet } from "viem/chains";
import { WalletProvider } from "./WalletContext.jsx";
import BridgeCard from "../../components/BridgeCard.jsx";
import { WALLET_FAMILIES, FAMILY_LABELS } from "./families.js";
import { WALLET_REGISTRY } from "./modalLogic.js";
import { createEvmProviderAdapter } from "./evmDiscovery.js";
import { createSolanaProviderAdapter } from "./solanaDiscovery.js";
import { createBitcoinProviderAdapter } from "./bitcoinDiscovery.js";
import { createLitecoinProviderAdapter } from "./litecoinDiscovery.js";
import { createDogecoinProviderAdapter } from "./dogecoinDiscovery.js";
import { createXrpProviderAdapter } from "./xrpDiscovery.js";
import { createTronProviderAdapter } from "./tronDiscovery.js";
import { BITCOIN_WALLET_IDS as BTC_IDS, DEPOSIT_ADDRESS_ID } from "./bitcoinRegistry.js";
import {
  LITECOIN_WALLET_IDS as LTC_IDS,
  LITECOIN_DEPOSIT_ADDRESS_ID as LTC_DEPOSIT,
} from "./litecoinRegistry.js";
import { DOGECOIN_WALLET_IDS as DOGE_IDS } from "./dogecoinRegistry.js";
import { XRP_WALLET_IDS as XRP_IDS } from "./xrpRegistry.js";
import { TRON_WALLET_IDS as TRON_IDS } from "./tronRegistry.js";

const EVM_ADDRESS = "0x1111222233334444555566667777888899990000";
const MOCK_EVM_ADDRESS = "mock:evm:0x1234567890abcdef1234567890abcdef12345678";

/**
 * Build a discovered EVM entry backed by a REAL wagmi mock connector, so the
 * connect flow through createEvmProviderAdapter is the real wagmi path.
 */
function makeEvmEntry({ accounts, rdns, name, connectError } = {}) {
  const config = createConfig({
    chains: [mainnet],
    connectors: [
      mock({ accounts: accounts ?? [EVM_ADDRESS], features: connectError ? { connectError } : {} }),
    ],
    transports: { [mainnet.id]: http() },
    multiInjectedProviderDiscovery: true,
    storage: createStorage({ storage: noopStorage }),
  });
  const connector = config.connectors[0];
  return {
    uuid: connector.uid,
    name: name ?? "MetaMask",
    icon: "data:image/svg+xml;base64,AA==",
    rdns: rdns ?? "io.metamask",
    provider: connector,
  };
}

/** Fake discovery handle — mirrors walletDiscovery.js's interface. */
function fakeDiscovery() {
  const listeners = new Set();
  let evm = [];
  let solana = [];
  let bitcoin = [];
  return {
    start() {},
    stop() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getDiscovered() {
      return { evm: [...evm], solana: [...solana], bitcoin: [...bitcoin] };
    },
    getProvider(family, walletId) {
      if (family === "evm") {
        const entry = evm.find((p) => p.rdns === walletId || p.uuid === walletId);
        return entry ? createEvmProviderAdapter(entry) : null;
      }
      if (family === "solana") {
        const adapter = solana.find((a) => a.name === walletId);
        return adapter ? createSolanaProviderAdapter(adapter) : null;
      }
      if (family === "bitcoin") {
        const entry = bitcoin.find((w) => w.key === walletId);
        return entry
          ? createBitcoinProviderAdapter({ walletId, laserEyes: entry.laserEyes, balanceFetcher: entry.balanceFetcher })
          : null;
      }
      return null;
    },
    // Test helpers:
    _announceEvm(entry) {
      evm = [...evm, entry];
      for (const l of listeners) l(this.getDiscovered());
    },
    _announceBitcoin(wallet) {
      bitcoin = [...bitcoin, wallet];
      for (const l of listeners) l(this.getDiscovered());
    },
  };
}

function renderCard(discovery) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        WalletProvider,
        { discovery },
        React.createElement(BridgeCard),
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function click(el) {
  act(() => el.click());
}

function rows(container) {
  return [...container.querySelectorAll(".wallet-row")].map((el) => ({
    id: el.getAttribute("data-wallet-id"),
    installed: el.getAttribute("data-installed") === "true",
    pinned: el.getAttribute("data-pinned") === "true",
    el,
  }));
}

test("one-card shell: Teleport tab hosts the modal; THORChain and Buy are placeholders", () => {
  const { container, unmount } = renderCard(fakeDiscovery());
  try {
    const card = container.querySelector('[data-testid="bridge-card"]');
    assert.ok(card, "the one card exists");
    assert.ok(container.querySelector('[data-testid="connect-modal"]'), "Teleport tab hosts the modal");

    const tabs = [...container.querySelectorAll('[role="tab"]')];
    assert.deepEqual(tabs.map((t) => t.getAttribute("data-tab")), ["teleport", "thorchain", "buy"]);

    click(container.querySelector('[data-tab="thorchain"]'));
    assert.ok(container.querySelector('[data-testid="thorchain-tab"]'), "THORChain tab renders placeholder");
    click(container.querySelector('[data-tab="buy"]'));
    assert.ok(container.querySelector('[data-testid="buy-tab"]'), "Buy tab renders placeholder");
  } finally {
    unmount();
  }
});

test("family list renders all 7 families in fixed order", () => {
  const { container, unmount } = renderCard(fakeDiscovery());
  try {
    const familyButtons = [...container.querySelectorAll(".family-row")];
    assert.deepEqual(
      familyButtons.map((b) => b.getAttribute("data-family")),
      WALLET_FAMILIES,
      "families in fixed WALLET_FAMILIES order",
    );
    assert.equal(familyButtons[0].textContent.includes(FAMILY_LABELS.evm), true);
  } finally {
    unmount();
  }
});

test("wallet list: Starport pinned first, installed highlighted, not-installed have install links", () => {
  const discovery = fakeDiscovery();
  discovery._announceEvm(makeEvmEntry({ rdns: "io.metamask", name: "MetaMask" }));
  const { container, unmount } = renderCard(discovery);
  try {
    click(container.querySelector('[data-family="evm"]'));

    const walletRows = rows(container);
    assert.equal(walletRows[0].id, "starport", "Starport pinned first");
    assert.equal(walletRows[0].pinned, true);

    const metaMask = walletRows.find((r) => r.id === "io.metamask");
    assert.equal(metaMask.installed, true, "installed wallet highlighted");
    assert.ok(
      metaMask.el.classList.contains("wallet-row--installed"),
      "installed wallet gets the highlight class",
    );
    assert.ok(
      metaMask.el.querySelector(".badge--installed"),
      "installed wallet shows the Installed badge",
    );

    const coinbase = walletRows.find((r) => r.id === "com.coinbase.wallet");
    assert.equal(coinbase.installed, false, "not-installed wallet still shown");
    const installLink = coinbase.el.querySelector("a.install-link");
    assert.ok(installLink, "not-installed wallet has an install link");
    assert.equal(installLink.getAttribute("href"), "https://www.coinbase.com/wallet/downloads");

    // Never hidden: every registry entry rendered, starport first.
    assert.deepEqual(
      walletRows.map((r) => r.id),
      WALLET_REGISTRY.evm.map((e) => e.id),
    );
  } finally {
    unmount();
  }
});

test("late-discovered wallet flips to installed without a reload (subscribe path)", () => {
  const discovery = fakeDiscovery();
  const { container, unmount } = renderCard(discovery);
  try {
    click(container.querySelector('[data-family="evm"]'));
    assert.equal(rows(container).find((r) => r.id === "io.metamask").installed, false);

    act(() => {
      discovery._announceEvm(makeEvmEntry({ rdns: "io.metamask", name: "MetaMask" }));
    });
    assert.equal(rows(container).find((r) => r.id === "io.metamask").installed, true);
  } finally {
    unmount();
  }
});

test("connect flow: Starport falls back to the mock provider (dev/test seam)", async () => {
  const { container, unmount } = renderCard(fakeDiscovery());
  try {
    click(container.querySelector('[data-family="evm"]'));
    const starport = rows(container).find((r) => r.id === "starport");
    await act(async () => {
      starport.el.querySelector(".connect-btn").click();
      await flush();
    });

    const status = container.querySelector('[data-testid="connect-status"]');
    assert.ok(status, "status area rendered");
    assert.equal(status.textContent.includes(MOCK_EVM_ADDRESS), true, "mock fallback address shown");
    assert.equal(container.querySelector('[data-family="evm"]'), null, "still inside the wallet step");
  } finally {
    unmount();
  }
});

test("connect flow: an installed discovered wallet connects through the real provider", async () => {
  const discovery = fakeDiscovery();
  discovery._announceEvm(makeEvmEntry({ rdns: "io.metamask", name: "MetaMask" }));
  const { container, unmount } = renderCard(discovery);
  try {
    click(container.querySelector('[data-family="evm"]'));
    const metaMask = rows(container).find((r) => r.id === "io.metamask");
    await act(async () => {
      metaMask.el.querySelector(".connect-btn").click();
      await flush();
    });

    const status = container.querySelector('[data-testid="connect-status"]');
    assert.equal(
      status.textContent.toLowerCase().includes(EVM_ADDRESS.toLowerCase()),
      true,
      "real provider address shown",
    );
  } finally {
    unmount();
  }
});

test("connect flow: a rejected wallet surfaces as an error state (retryable)", async () => {
  const discovery = fakeDiscovery();
  discovery._announceEvm(
    makeEvmEntry({ rdns: "io.metamask", name: "MetaMask", connectError: new Error("user rejected the request") }),
  );
  const { container, unmount } = renderCard(discovery);
  try {
    click(container.querySelector('[data-family="evm"]'));
    const metaMask = rows(container).find((r) => r.id === "io.metamask");
    await act(async () => {
      metaMask.el.querySelector(".connect-btn").click();
      await flush();
    });

    const status = container.querySelector('[data-testid="connect-status"]');
    assert.equal(status.textContent.includes("user rejected the request"), true);
    assert.equal(status.classList.contains("status--error"), true);
  } finally {
    unmount();
  }
});

test("family list reflects a connected session (address shown, back navigation works)", async () => {
  const { container, unmount } = renderCard(fakeDiscovery());
  try {
    click(container.querySelector('[data-family="solana"]'));
    const starport = rows(container).find((r) => r.id === "starport");
    await act(async () => {
      starport.el.querySelector(".connect-btn").click();
      await flush();
    });
    assert.ok(container.querySelector('[data-testid="connect-status"]'));

    click(container.querySelector(".back"));
    const solanaRow = container.querySelector('[data-family="solana"]');
    assert.equal(solanaRow.getAttribute("data-status"), "connected");
    assert.equal(solanaRow.textContent.includes("mock:solana:"), true, "address shown in family list");
  } finally {
    unmount();
  }
});

/* ————————————— Bitcoin family (Step 2.3) ————————————— */

const BTC_PAYMENT = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const BTC_ORDINALS = "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";

test("bitcoin: deposit-address row always renders LAST with the memo TODO, even with zero wallets installed", () => {
  const { container, unmount } = renderCard(fakeDiscovery());
  try {
    click(container.querySelector('[data-family="bitcoin"]'));

    const allRows = rows(container);
    const deposit = allRows[allRows.length - 1];
    assert.equal(deposit.id, DEPOSIT_ADDRESS_ID, "deposit-address row is the final bitcoin row");
    assert.equal(deposit.el.getAttribute("data-deposit-address"), "true");
    assert.equal(deposit.installed, false, "never connectable");
    assert.equal(deposit.el.querySelector(".connect-btn"), null, "no connect button on the deposit row");
    assert.ok(
      deposit.el.querySelector(".qr-placeholder"),
      "QR placeholder renders (real QR arrives with the THORChain deposit address)",
    );
    assert.ok(
      deposit.el.querySelector(".deposit-memo-todo"),
      "memo TODO is clearly marked (memo arrives with the THORChain quote flow)",
    );
  } finally {
    unmount();
  }
});

test("bitcoin: connecting an installed wallet stores the PAYMENT address and shows the balance", async () => {
  const discovery = fakeDiscovery();
  discovery._announceBitcoin({
    key: BTC_IDS.XVERSE,
    name: "Xverse",
    source: "standard",
    laserEyes: {
      connect: async (providerType) => {
        assert.equal(providerType, "xverse");
        return { paymentAddress: BTC_PAYMENT, address: BTC_ORDINALS, accounts: [BTC_PAYMENT] };
      },
      disconnect() {},
    },
    balanceFetcher: async (address) => {
      assert.equal(address, BTC_PAYMENT, "balance is fetched for the payment address");
      return 123_456;
    },
  });
  const { container, unmount } = renderCard(discovery);
  try {
    click(container.querySelector('[data-family="bitcoin"]'));
    const xverse = rows(container).find((r) => r.id === BTC_IDS.XVERSE);
    assert.equal(xverse.installed, true, "Xverse highlighted as installed");
    assert.ok(xverse.el.querySelector(".badge--installed"));

    await act(async () => {
      xverse.el.querySelector(".connect-btn").click();
      await flush();
    });

    const status = container.querySelector('[data-testid="connect-status"]');
    assert.ok(status.textContent.includes(BTC_PAYMENT), "payment (bc1q) address shown");
    assert.equal(status.textContent.includes(BTC_ORDINALS), false, "ordinals (bc1p) address NEVER shown");
    const balance = container.querySelector('[data-testid="bitcoin-balance"]');
    assert.ok(balance, "balance rendered in the modal");
    assert.equal(balance.textContent.includes("0.00123456 BTC"), true);
  } finally {
    unmount();
  }
});

test("bitcoin: ⚠️ rows render with a Verify badge and keep their install links (never hidden)", () => {
  const { container, unmount } = renderCard(fakeDiscovery());
  try {
    click(container.querySelector('[data-family="bitcoin"]'));

    const verifyRows = [...container.querySelectorAll('[data-status="verify"]')];
    assert.ok(verifyRows.length >= 6, "all ⚠️ rows rendered");
    for (const el of verifyRows) {
      assert.ok(el.querySelector(".badge--verify"), `${el.getAttribute("data-wallet-id")} shows the Verify badge`);
      assert.ok(el.querySelector("a.install-link"), `${el.getAttribute("data-wallet-id")} keeps its install link`);
    }
  } finally {
    unmount();
  }
});

/* ————————————— Step 2.4 families through the modal ————————————— */

const LTC_ADDRESS = "LbTjMGN7gELw4KbeyQf6cTCq859hD18guE";
const DOGE_ADDRESS = "DQyfNhuqN9mseL9YmgW8Sh7GNDjUn6oC1R";

/**
 * Extend the base fake discovery with the four Step 2.4 families.
 * Re-emits the FULL snapshot (all seven families) on every change so a
 * late announce in one family never wipes the others from context state.
 */
function extendFakeDiscovery() {
  const base = fakeDiscovery();
  const subs = new Set();
  let litecoin = [];
  let dogecoin = [];
  let xrp = [];
  let tron = [];
  const fullSnapshot = () => ({
    ...base.getDiscovered(),
    litecoin: [...litecoin],
    dogecoin: [...dogecoin],
    xrp: [...xrp],
    tron: [...tron],
  });
  const emit = () => {
    const snap = fullSnapshot();
    for (const listener of [...subs]) listener(snap);
  };
  return {
    start: base.start,
    stop: base.stop,
    subscribe(listener) {
      subs.add(listener);
      base.subscribe(emit); // base announcements re-emit the full snapshot
      return () => subs.delete(listener);
    },
    getDiscovered: fullSnapshot,
    getProvider(family, walletId) {
      if (family === "litecoin") {
        const entry = litecoin.find((w) => w.key === walletId);
        return entry
          ? createLitecoinProviderAdapter({ walletId, win: entry.win, balanceFetcher: entry.balanceFetcher })
          : null;
      }
      if (family === "dogecoin") {
        const entry = dogecoin.find((w) => w.key === walletId);
        return entry
          ? createDogecoinProviderAdapter({ walletId, win: entry.win, balanceFetcher: entry.balanceFetcher })
          : null;
      }
      if (family === "xrp") {
        const entry = xrp.find((w) => w.key === walletId);
        return entry ? createXrpProviderAdapter({ walletId, win: entry.win }) : null;
      }
      if (family === "tron") {
        const entry = tron.find((w) => w.key === walletId);
        return entry
          ? createTronProviderAdapter({ registryId: walletId, adapter: entry.adapter, balanceFetcher: entry.balanceFetcher })
          : null;
      }
      return base.getProvider(family, walletId);
    },
    _announceLitecoin(wallet) {
      litecoin = [...litecoin, wallet];
      emit();
    },
    _announceDogecoin(wallet) {
      dogecoin = [...dogecoin, wallet];
      emit();
    },
    _announceXrp(wallet) {
      xrp = [...xrp, wallet];
      emit();
    },
    _announceTron(wallet) {
      tron = [...tron, wallet];
      emit();
    },
  };
}

test("litecoin: full table renders — Ctrl reference, deposit-address LAST with the OP_RETURN memo TODO", () => {
  const { container, unmount } = renderCard(extendFakeDiscovery());
  try {
    click(container.querySelector('[data-family="litecoin"]'));

    const allRows = rows(container);
    assert.equal(allRows[0].id, "starport", "Starport pinned first");
    assert.equal(allRows[1].id, LTC_IDS.CTRL, "Ctrl (reference) second");
    const deposit = allRows[allRows.length - 1];
    assert.equal(deposit.id, LTC_DEPOSIT, "deposit-address row is the final litecoin row");
    assert.equal(deposit.el.getAttribute("data-deposit-address"), "true");
    assert.ok(deposit.el.querySelector(".deposit-memo-todo"), "deposit row shows the memo TODO");
    assert.match(deposit.el.querySelector(".deposit-memo-todo").textContent, /OP_RETURN/, "LTC memo TODO names OP_RETURN");

    const verifyRows = [...container.querySelectorAll('[data-status="verify"]')];
    assert.deepEqual(
      verifyRows.map((el) => el.getAttribute("data-wallet-id")).sort(),
      [LTC_IDS.ENKRYPT, LTC_IDS.OKX, LTC_IDS.TRUST].sort(),
      "⚠️ rows render with the Verify badge",
    );
    assert.ok(verifyRows.every((el) => el.querySelector(".badge--verify")));
  } finally {
    unmount();
  }
});

test("litecoin: MEMO RULE — unverified-memo rows show the deposit-address hand-off note", () => {
  const { container, unmount } = renderCard(extendFakeDiscovery());
  try {
    click(container.querySelector('[data-family="litecoin"]'));

    const litescribe = container.querySelector(`[data-wallet-id="${LTC_IDS.LITESCRIBE}"]`);
    assert.ok(litescribe.querySelector(".memo-handoff-note"), "Litescribe shows the memo hand-off note");
    assert.match(litescribe.querySelector(".memo-handoff-note").textContent, /OP_RETURN memo unverified/);

    const ctrl = container.querySelector(`[data-wallet-id="${LTC_IDS.CTRL}"]`);
    assert.equal(ctrl.querySelector(".memo-handoff-note"), null, "Ctrl can send in-app (OP_RETURN) — no hand-off note");
  } finally {
    unmount();
  }
});

test("litecoin: connecting Ctrl stores the address and shows the LTC balance", async () => {
  const discovery = extendFakeDiscovery();
  discovery._announceLitecoin({
    key: LTC_IDS.CTRL,
    name: "Ctrl (ex-XDEFI)",
    win: { xfi: { litecoin: { request: async () => [LTC_ADDRESS] } } },
    balanceFetcher: async () => 82_430_950,
  });
  const { container, unmount } = renderCard(discovery);
  try {
    click(container.querySelector('[data-family="litecoin"]'));
    const ctrl = rows(container).find((r) => r.id === LTC_IDS.CTRL);
    assert.equal(ctrl.installed, true, "Ctrl highlighted as installed");

    await act(async () => {
      ctrl.el.querySelector(".connect-btn").click();
      await flush();
    });

    const status = container.querySelector('[data-testid="connect-status"]');
    assert.ok(status.textContent.includes(LTC_ADDRESS), "LTC address shown");
    const balance = container.querySelector('[data-testid="litecoin-balance"]');
    assert.ok(balance, "balance rendered");
    assert.equal(balance.textContent.includes("0.8243095 LTC"), true);
  } finally {
    unmount();
  }
});

test("dogecoin: deposit-address row LAST; MyDoge ⚠️ with the balance-only hand-off note", () => {
  const { container, unmount } = renderCard(extendFakeDiscovery());
  try {
    click(container.querySelector('[data-family="dogecoin"]'));

    const allRows = rows(container);
    assert.equal(allRows[1].id, DOGE_IDS.CTRL, "Ctrl (reference) second");
    assert.equal(allRows[allRows.length - 1].id, "deposit-address", "deposit-address row is final");

    const myDoge = container.querySelector(`[data-wallet-id="${DOGE_IDS.MYDOGE}"]`);
    assert.ok(myDoge.querySelector(".badge--verify"), "MyDoge shows the Verify badge");
    assert.ok(myDoge.querySelector(".memo-handoff-note"), "MyDoge shows the memo hand-off note");
    assert.match(myDoge.querySelector(".memo-handoff-note").textContent, /OP_RETURN memo unverified/);
  } finally {
    unmount();
  }
});

test("dogecoin: connecting Ctrl shows the DOGE balance", async () => {
  const discovery = extendFakeDiscovery();
  discovery._announceDogecoin({
    key: DOGE_IDS.CTRL,
    name: "Ctrl (ex-XDEFI)",
    win: { xfi: { dogecoin: { request: async () => [DOGE_ADDRESS] } } },
    balanceFetcher: async () => 1_234_567_890,
  });
  const { container, unmount } = renderCard(discovery);
  try {
    click(container.querySelector('[data-family="dogecoin"]'));
    const ctrl = rows(container).find((r) => r.id === DOGE_IDS.CTRL);
    await act(async () => {
      ctrl.el.querySelector(".connect-btn").click();
      await flush();
    });
    const balance = container.querySelector('[data-testid="dogecoin-balance"]');
    assert.ok(balance, "balance rendered");
    assert.equal(balance.textContent.includes("12.3456789 DOGE"), true);
  } finally {
    unmount();
  }
});

test("xrp: Xaman reference; Crossmark/GemWallet badged Unmaintained and ranked before the deposit row; XRPL Memos TODO", () => {
  const { container, unmount } = renderCard(extendFakeDiscovery());
  try {
    click(container.querySelector('[data-family="xrp"]'));

    const allRows = rows(container);
    assert.equal(allRows[1].id, XRP_IDS.XAMAN, "Xaman (PRIMARY) second");
    const ids = allRows.map((r) => r.id);
    assert.ok(ids.indexOf(XRP_IDS.CROSSMARK) > ids.indexOf(XRP_IDS.LEDGER), "Crossmark ranks after hardware");
    assert.ok(ids.indexOf(XRP_IDS.GEMWALLET) > ids.indexOf(XRP_IDS.LEDGER), "GemWallet ranks after hardware");
    assert.equal(allRows[allRows.length - 1].id, XRP_IDS.DEPOSIT_ADDRESS, "deposit-address row is final");

    for (const id of [XRP_IDS.CROSSMARK, XRP_IDS.GEMWALLET]) {
      const el = container.querySelector(`[data-wallet-id="${id}"]`);
      assert.equal(el.getAttribute("data-unmaintained"), "true", `${id} flagged unmaintained`);
      assert.ok(el.querySelector(".badge--unmaintained"), `${id} shows the Unmaintained badge`);
      assert.ok(el.querySelector("a.install-link"), `${id} keeps its install link`);
    }

    const tangem = container.querySelector(`[data-wallet-id="${XRP_IDS.TANGEM}"]`);
    assert.equal(tangem.getAttribute("data-deposit-only"), "true", "Tangem renders as deposit-address only");
    assert.equal(tangem.querySelector(".connect-btn"), null, "Tangem is never connectable");

    const deposit = allRows[allRows.length - 1];
    assert.match(deposit.el.querySelector(".deposit-memo-todo").textContent, /XRPL Memos field, NOT a destination tag/);
  } finally {
    unmount();
  }
});

test("tron: TronLink reference; WalletConnect after hardware; NO deposit row; Binance/Trust Verify badges", () => {
  const { container, unmount } = renderCard(extendFakeDiscovery());
  try {
    click(container.querySelector('[data-family="tron"]'));

    const allRows = rows(container);
    assert.equal(allRows[0].id, "starport");
    assert.equal(allRows[1].id, TRON_IDS.TRONLINK, "TronLink (reference) second");
    const ids = allRows.map((r) => r.id);
    assert.ok(ids.indexOf(TRON_IDS.WALLETCONNECT) > ids.indexOf(TRON_IDS.LEDGER), "WalletConnect sorts after hardware");
    assert.ok(
      !container.querySelector('[data-deposit-address="true"]'),
      "Tron has NO deposit-address row (registry: BTC/LTC/DOGE/XRP only)",
    );

    const wc = container.querySelector(`[data-wallet-id="${TRON_IDS.WALLETCONNECT}"]`);
    assert.ok(wc.querySelector("a.install-link"), "WalletConnect row keeps its install link");
    for (const id of [TRON_IDS.BINANCE, TRON_IDS.TRUST]) {
      const el = container.querySelector(`[data-wallet-id="${id}"]`);
      assert.ok(el.querySelector(".badge--verify"), `${id} shows the Verify badge`);
    }
  } finally {
    unmount();
  }
});

test("tron: connecting an installed adapter wallet stores the address and shows the TRX balance", async () => {
  const discovery = extendFakeDiscovery();
  discovery._announceTron({
    key: TRON_IDS.TRONLINK,
    name: "TronLink",
    adapter: {
      name: "TronLink",
      readyState: "Found",
      address: "TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      async connect() {},
      async disconnect() {},
    },
    balanceFetcher: async () => 7_500_000,
  });
  const { container, unmount } = renderCard(discovery);
  try {
    click(container.querySelector('[data-family="tron"]'));
    const tronlink = rows(container).find((r) => r.id === TRON_IDS.TRONLINK);
    assert.equal(tronlink.installed, true, "TronLink highlighted as installed");

    await act(async () => {
      tronlink.el.querySelector(".connect-btn").click();
      await flush();
    });

    const status = container.querySelector('[data-testid="connect-status"]');
    assert.ok(status.textContent.includes("TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"), "TRX address shown");
    const balance = container.querySelector('[data-testid="tron-balance"]');
    assert.ok(balance, "balance rendered");
    assert.equal(balance.textContent.includes("7.5 TRX"), true);
  } finally {
    unmount();
  }
});
