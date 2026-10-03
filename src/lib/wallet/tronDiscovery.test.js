/**
 * Tron discovery tests (Step 2.4) — node:test, fully injected (fake
 * adapters standing in for @tronweb3/tronwallet-adapters instances).
 * Proves:
 *   - installed = adapters whose readyState is "Found" (the package's
 *     WalletReadyState.Found), refreshed on readyStateChanged events;
 *   - the wired adapters (TronLink / OKX / Bitget / TokenPocket) connect
 *     through adapter.connect() + adapter.address — session only, no
 *     signing methods ever called;
 *   - Ledger (hardware lane), WalletConnect (projectId config) and imToken
 *     (mobile via WalletConnect) are TODO-gated; Binance / Trust (⚠️ via
 *     WalletConnect) reject with their verify TODOs;
 *   - the adapter-only rule: discovery NEVER looks at injected globals
 *     (the Tron-EVM isolation is pinned at the composition level in
 *     walletDiscovery.test.js).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTronDiscovery,
  createTronProviderAdapter,
} from "./tronDiscovery.js";
import {
  TRON_WALLETS,
  TRON_WALLET_IDS as IDS,
} from "./tronRegistry.js";

const TRON_ADDRESS = "TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // 34-char base58 shape

/**
 * Fake @tronweb3/tronwallet-adapters-style adapter: controllable
 * readyState + a tiny event emitter for readyStateChanged.
 */
function makeFakeTronAdapter({ name, readyState = "NotFound", address = null } = {}) {
  const listeners = new Set();
  const adapter = {
    name,
    url: "https://example.invalid/",
    icon: "data:image/svg+xml;base64,AA==",
    readyState,
    state: readyState === "Found" ? "Disconnected" : "NotFound",
    address,
    connectCalls: 0,
    disconnectCalls: 0,
    async connect() {
      this.connectCalls += 1;
      this.address = address ?? TRON_ADDRESS;
      this.state = "Connected";
    },
    async disconnect() {
      this.disconnectCalls += 1;
    },
    on(event, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    _setReady(next) {
      this.readyState = next;
      this.state = next === "Found" ? "Disconnected" : "NotFound";
      for (const listener of [...listeners]) listener();
    },
  };
  return adapter;
}

const installedKeys = (discovery) => discovery.getInstalled().map((w) => w.key).sort();

test("installed = adapters whose readyState is Found (Loading/NotFound are not installed)", () => {
  const tronlink = makeFakeTronAdapter({ name: "TronLink", readyState: "Found" });
  const okx = makeFakeTronAdapter({ name: "OKX Wallet", readyState: "NotFound" });
  const discovery = createTronDiscovery({
    adapters: [
      { registryId: IDS.TRONLINK, adapter: tronlink },
      { registryId: IDS.OKX, adapter: okx },
    ],
  });
  discovery.start();

  assert.deepEqual(installedKeys(discovery), [IDS.TRONLINK]);
  const [entry] = discovery.getInstalled();
  assert.equal(entry.name, "TronLink");
  assert.equal(entry.source, "adapter");
});

test("late readyStateChanged events refresh the installed snapshot", () => {
  const tronlink = makeFakeTronAdapter({ name: "TronLink", readyState: "NotFound" });
  const seen = [];
  const discovery = createTronDiscovery({
    adapters: [{ registryId: IDS.TRONLINK, adapter: tronlink }],
    onChange: (w) => seen.push(w.map((x) => x.key)),
  });
  discovery.start();

  assert.deepEqual(installedKeys(discovery), [], "not installed yet (Loading/NotFound)");
  assert.equal(seen.length, 1, "initial snapshot emitted");

  tronlink._setReady("Found"); // the wallet extension injects late
  assert.deepEqual(installedKeys(discovery), [IDS.TRONLINK]);
  assert.deepEqual(seen[seen.length - 1], [IDS.TRONLINK], "late registration emitted");
});

test("stop() detaches adapter listeners; state stays readable", () => {
  const tronlink = makeFakeTronAdapter({ name: "TronLink", readyState: "NotFound" });
  const seen = [];
  const discovery = createTronDiscovery({
    adapters: [{ registryId: IDS.TRONLINK, adapter: tronlink }],
    onChange: (w) => seen.push(w.map((x) => x.key)),
  });
  discovery.start();
  discovery.stop();

  tronlink._setReady("Found");
  assert.deepEqual(installedKeys(discovery), [], "no refresh after stop");
  assert.equal(seen.length, 1, "no subscriber notification after stop");
});

test("no adapters injected → nothing discovered, no throw (browser-less default)", () => {
  const discovery = createTronDiscovery();
  discovery.start();
  assert.deepEqual(discovery.getInstalled(), []);
  assert.equal(discovery.getProvider(IDS.TRONLINK), null);
});

test("getProvider: an installed adapter connects through adapter.connect() + address + balance", async () => {
  const tronlink = makeFakeTronAdapter({ name: "TronLink", readyState: "Found" });
  const discovery = createTronDiscovery({
    adapters: [{ registryId: IDS.TRONLINK, adapter: tronlink }],
    balanceFetcher: async () => 7_500_000,
  });
  discovery.start();

  const provider = discovery.getProvider(IDS.TRONLINK);
  assert.ok(provider, "installed TronLink resolves a provider");
  assert.equal(provider.isReal, true);
  assert.equal(provider.walletName, "TronLink");

  const result = await provider.connect();
  assert.equal(tronlink.connectCalls, 1);
  assert.equal(result.address, TRON_ADDRESS);
  assert.equal(result.balance, 7_500_000);
  assert.equal(result.family, "tron");

  await provider.disconnect();
  assert.equal(tronlink.disconnectCalls, 1);
});

test("getProvider returns null for adapters that are NOT installed", () => {
  const okx = makeFakeTronAdapter({ name: "OKX Wallet", readyState: "NotFound" });
  const discovery = createTronDiscovery({ adapters: [{ registryId: IDS.OKX, adapter: okx }] });
  discovery.start();
  assert.equal(discovery.getProvider(IDS.OKX), null, "not installed → null (mock fallback)");
});

test("every wired ✅ adapter row maps to its registry adapter name", () => {
  const wired = TRON_WALLETS.filter((e) => e.adapterName);
  assert.deepEqual(
    wired.map((e) => e.adapterName),
    ["TronLink", "Bitget Wallet", "OKX Wallet", "TokenPocket", "Ledger"],
    "exactly the registry's adapter rows",
  );
  assert.equal(wired.find((e) => e.id === IDS.TRONLINK).reference, true, "TronLink is the reference wallet");
});

test("Ledger (hardware lane): detected via readyState but connect is TODO-gated", async () => {
  const ledger = makeFakeTronAdapter({ name: "Ledger", readyState: "Found" });
  const discovery = createTronDiscovery({ adapters: [{ registryId: IDS.LEDGER, adapter: ledger }] });
  discovery.start();

  assert.deepEqual(installedKeys(discovery), [IDS.LEDGER], "Ledger detection via the adapter (WebHID support)");
  const provider = discovery.getProvider(IDS.LEDGER);
  assert.ok(provider, "Ledger resolves a provider");
  await assert.rejects(provider.connect(), /not wired yet/);
  await assert.rejects(provider.connect(), /Phase 3/);
  assert.equal(ledger.connectCalls, 0, "the adapter's connect is never invoked");
});

test("WalletConnect row: connect rejects with the projectId config TODO", async () => {
  const provider = createTronProviderAdapter({ registryId: IDS.WALLETCONNECT, adapter: null });
  assert.ok(provider, "WalletConnect still renders/resolves");
  await assert.rejects(provider.connect(), /not wired yet/);
  await assert.rejects(provider.connect(), /Reown AppKit projectId/);
});

test("imToken: connect rejects with the mobile/WalletConnect verification TODO", async () => {
  const provider = createTronProviderAdapter({ registryId: IDS.IMTOKEN, adapter: null });
  await assert.rejects(provider.connect(), /not wired yet/);
  await assert.rejects(provider.connect(), /imToken's Tron path/);
});

test("⚠️ rows (Binance Web3 / Trust) reject with their verify TODOs, not guessed connects", async () => {
  for (const walletId of [IDS.BINANCE, IDS.TRUST]) {
    const entry = TRON_WALLETS.find((e) => e.id === walletId);
    assert.equal(entry.status, "verify", `${walletId} is a ⚠️ row`);
    assert.ok(entry.todo.includes("WalletConnect"), `${walletId} TODO names the WalletConnect path`);

    const provider = createTronProviderAdapter({ registryId: walletId, adapter: null });
    await assert.rejects(provider.connect(), /not wired yet/);
    await assert.rejects(provider.connect(), /WalletConnect/);
  }
});

test("unknown wallet ids resolve to null (never a provider)", () => {
  assert.equal(createTronProviderAdapter({ registryId: "monero-wallet", adapter: {} }), null);
});

test("no signing surface: the provider exposes connect/disconnect only", () => {
  const tronlink = makeFakeTronAdapter({ name: "TronLink", readyState: "Found" });
  const discovery = createTronDiscovery({ adapters: [{ registryId: IDS.TRONLINK, adapter: tronlink }] });
  discovery.start();
  const provider = discovery.getProvider(IDS.TRONLINK);

  assert.equal(typeof provider.connect, "function");
  assert.equal(typeof provider.disconnect, "function");
  assert.equal(provider.signTransaction, undefined, "signing is hard-stopped (Pro lane)");
  assert.equal(provider.signMessage, undefined, "signing is hard-stopped (Pro lane)");
  assert.equal(tronlink.signTransaction, undefined, "the fake adapter has no signing surface to leak");
});
