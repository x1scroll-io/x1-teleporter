/**
 * walletDiscovery integration tests (Step 2.2) — proves the composition
 * handle end-to-end with fakes: real EIP-6963 announce events through a
 * wagmi config (jsdom) for EVM, plus a fake Wallet Standard registry for
 * Solana → discovered snapshots → getProvider resolution → connect through
 * the real-provider path.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
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

import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { createWalletDiscovery } from "./walletDiscovery.js";
import { createDefaultEvmConfig } from "./evmDiscovery.js";

const EVM_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const SOLANA_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** Fake injected EVM wallet — answers eip6963:requestProvider with an announce. */
function fakeEvmWallet({ uuid, rdns, name, request }) {
  const provider = { request, on: () => {}, removeListener: () => {}, off: () => {} };
  const announce = () => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: { info: { uuid, name, icon: "data:image/svg+xml;base64,AA==", rdns }, provider },
      }),
    );
  };
  const handler = () => announce();
  window.addEventListener("eip6963:requestProvider", handler);
  return { announce, stop: () => window.removeEventListener("eip6963:requestProvider", handler) };
}

function makeStandardWallet({ name }) {
  return {
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,AA==",
    chains: ["solana:mainnet"],
    accounts: [
      {
        address: SOLANA_ADDRESS,
        publicKey: bs58.decode(SOLANA_ADDRESS),
        chains: ["solana:mainnet"],
        features: ["standard:connect"],
      },
    ],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => ({
          accounts: [
            {
              address: SOLANA_ADDRESS,
              publicKey: bs58.decode(SOLANA_ADDRESS),
              chains: ["solana:mainnet"],
              features: ["standard:connect"],
            },
          ],
        }),
      },
      "standard:events": { version: "1.0.0", on: () => () => {}, off: () => {} },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signAndSendTransaction: async () => ({ signature: new Uint8Array(64) }),
      },
    },
  };
}

function makeFakeRegistry(wallets = []) {
  let current = [...wallets];
  const listeners = { register: [], unregister: [] };
  return {
    get: () => [...current],
    on(event, listener) {
      listeners[event].push(listener);
      return () => {
        listeners[event] = listeners[event].filter((l) => l !== listener);
      };
    },
    _register(...ws) {
      current = [...current, ...ws];
      for (const l of listeners.register) l(...ws);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("discovers EVM (wagmi EIP-6963) and Solana (Wallet Standard) wallets together", () => {
  const wallet = fakeEvmWallet({
    uuid: "u1", rdns: "io.metamask", name: "MetaMask",
    request: async ({ method }) => (method === "eth_requestAccounts" ? [EVM_ADDRESS] : undefined),
  });
  try {
    const registry = makeFakeRegistry([makeStandardWallet({ name: "Phantom" })]);
    const discovery = createWalletDiscovery({ evmConfig: createDefaultEvmConfig(), solanaRegistry: registry });

    const snapshots = [];
    discovery.subscribe((snap) => snapshots.push(snap));
    discovery.start();

    const snap = discovery.getDiscovered();
    assert.equal(snap.evm.some((p) => p.rdns === "io.metamask"), true, "EVM provider discovered");
    assert.equal(snap.solana.length, 1, "Solana adapter discovered");
    assert.equal(snap.solana[0].name, "Phantom");
    assert.ok(snapshots.length >= 1, "subscribers notified");
  } finally {
    wallet.stop();
  }
});

test("getProvider resolves the discovered EVM wallet and connects through it", async () => {
  const wallet = fakeEvmWallet({
    uuid: "u1", rdns: "io.metamask", name: "MetaMask",
    request: async ({ method }) => {
      if (method === "wallet_requestPermissions") throw new Error("not supported");
      if (method === "eth_requestAccounts") return [EVM_ADDRESS];
      return undefined;
    },
  });
  try {
    const discovery = createWalletDiscovery({ evmConfig: createDefaultEvmConfig(), solanaRegistry: makeFakeRegistry() });
    discovery.start();

    const provider = discovery.getProvider("evm", "io.metamask");
    assert.ok(provider, "resolves a provider for an installed EVM wallet");
    assert.equal(provider.isReal, true);

    const result = await provider.connect();
    assert.equal(result.address.toLowerCase(), EVM_ADDRESS.toLowerCase());
  } finally {
    wallet.stop();
  }
});

test("getProvider resolves the discovered Solana wallet and connects through it", async () => {
  const registry = makeFakeRegistry([makeStandardWallet({ name: "Phantom" })]);
  const discovery = createWalletDiscovery({ evmConfig: createDefaultEvmConfig(), solanaRegistry: registry });
  discovery.start();

  const provider = discovery.getProvider("solana", "Phantom");
  assert.ok(provider, "resolves a provider for an installed Solana wallet");
  assert.equal(provider.isReal, true);

  const result = await provider.connect();
  assert.equal(result.address, SOLANA_ADDRESS);
});

test("getProvider returns null for unknown wallets (mock fallback path)", () => {
  const discovery = createWalletDiscovery({ evmConfig: createDefaultEvmConfig(), solanaRegistry: makeFakeRegistry() });
  discovery.start();
  assert.equal(discovery.getProvider("evm", "io.metamask"), null, "no EIP-6963 MetaMask announced");
  assert.equal(discovery.getProvider("solana", "Phantom"), null);
  assert.equal(discovery.getProvider("bitcoin", "anything"), null, "unsupported family → null");
});

test("stop() detaches subscribers; snapshots stay readable", async () => {
  const wallet = fakeEvmWallet({
    uuid: "u1", rdns: "io.metamask", name: "MetaMask",
    request: async ({ method }) => (method === "eth_requestAccounts" ? [EVM_ADDRESS] : undefined),
  });
  wallet.stop(); // injects late, after start
  try {
    let notifications = 0;
    const discovery = createWalletDiscovery({
      evmConfig: createDefaultEvmConfig(),
      solanaRegistry: makeFakeRegistry(),
    });
    discovery.subscribe(() => { notifications += 1; });
    discovery.start();
    // One notification per sub-discovery's initial snapshot (7 families).
    assert.equal(notifications, 7, "start notifies subscribers");
    await flush();
    discovery.stop();

    wallet.announce();
    await flush();
    assert.equal(notifications, 7, "no subscriber notification after stop");

    const snap = discovery.getDiscovered();
    assert.ok(
      Array.isArray(snap.evm) && Array.isArray(snap.solana) && Array.isArray(snap.bitcoin),
      "snapshot still readable",
    );
  } finally {
    wallet.stop();
  }
});

test("default handle (no injected config/registry) degrades to fallback-only discovery", () => {
  // Pure browser-less default: EVM surfaces only the static injected()
  // fallback connector; Solana and Bitcoin have nothing registered.
  const discovery = createWalletDiscovery();
  discovery.start();
  const snap = discovery.getDiscovered();
  assert.equal(snap.evm.length, 1);
  assert.equal(snap.evm[0].rdns, "injected");
  assert.deepEqual(snap.solana, []);
  assert.deepEqual(snap.bitcoin, [], "no bitcoin globals/registrations in the default env");
  assert.deepEqual(snap.litecoin, [], "no litecoin globals in the default env");
  assert.deepEqual(snap.dogecoin, [], "no dogecoin globals in the default env");
  assert.deepEqual(snap.xrp, [], "no xrp globals in the default env");
  assert.deepEqual(snap.tron, [], "no tron adapters in the default env");
  assert.equal(discovery.getProvider("evm", "io.metamask"), null);
  assert.equal(discovery.getProvider("bitcoin", "Xverse"), null);
  assert.equal(discovery.getProvider("litecoin", "Ctrl"), null);
  assert.equal(discovery.getProvider("dogecoin", "Ctrl"), null);
  assert.equal(discovery.getProvider("xrp", "Crossmark"), null);
  assert.equal(discovery.getProvider("tron", "TronLink"), null);
});

/* ————————————— Step 2.4 families through the composition ————————————— */

import { createLitecoinProviderAdapter } from "./litecoinDiscovery.js";
import { createDogecoinProviderAdapter } from "./dogecoinDiscovery.js";
import { createXrpProviderAdapter } from "./xrpDiscovery.js";
import { createTronProviderAdapter } from "./tronDiscovery.js";
import { LITECOIN_WALLET_IDS as LTC_IDS } from "./litecoinRegistry.js";
import { DOGECOIN_WALLET_IDS as DOGE_IDS } from "./dogecoinRegistry.js";
import { XRP_WALLET_IDS as XRP_IDS } from "./xrpRegistry.js";
import { TRON_WALLET_IDS as TRON_IDS } from "./tronRegistry.js";

/** Fake @tronweb3/tronwallet-adapters-style adapter (readyState + events). */
function makeFakeTronAdapter({ name, readyState = "Found" } = {}) {
  const listeners = new Set();
  return {
    name,
    readyState,
    state: readyState === "Found" ? "Disconnected" : "NotFound",
    address: "TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    async connect() {},
    async disconnect() {},
    on(event, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

test("composition: litecoin + dogecoin + xrp globals and tron adapters are discovered together", () => {
  const win = {
    xfi: { litecoin: {}, dogecoin: {} },
    litescribe: {},
    doge: {},
    xrpl: { crossmark: {} },
  };
  const tronlink = makeFakeTronAdapter({ name: "TronLink" });
  const okx = makeFakeTronAdapter({ name: "OKX Wallet", readyState: "NotFound" });

  const discovery = createWalletDiscovery({
    evmConfig: createDefaultEvmConfig(),
    solanaRegistry: makeFakeRegistry(),
    litecoinWin: win,
    dogecoinWin: win,
    xrpWin: win,
    tronAdapters: [
      { registryId: TRON_IDS.TRONLINK, adapter: tronlink },
      { registryId: TRON_IDS.OKX, adapter: okx },
    ],
  });
  discovery.start();
  const snap = discovery.getDiscovered();

  assert.deepEqual(snap.litecoin.map((w) => w.key).sort(), [LTC_IDS.CTRL, LTC_IDS.LITESCRIBE]);
  assert.deepEqual(snap.dogecoin.map((w) => w.key).sort(), [DOGE_IDS.CTRL, DOGE_IDS.MYDOGE]);
  assert.deepEqual(snap.xrp.map((w) => w.key), [XRP_IDS.CROSSMARK]);
  assert.deepEqual(snap.tron.map((w) => w.key), [TRON_IDS.TRONLINK], "only Found adapters are installed");
});

test("composition: getProvider resolves the new families' real providers", async () => {
  const win = { xfi: { litecoin: { request: async () => ["LbTjMGN7gELw4KbeyQf6cTCq859hD18guE"] } } };
  const tronlink = makeFakeTronAdapter({ name: "TronLink" });
  const discovery = createWalletDiscovery({
    evmConfig: createDefaultEvmConfig(),
    solanaRegistry: makeFakeRegistry(),
    litecoinWin: win,
    tronAdapters: [{ registryId: TRON_IDS.TRONLINK, adapter: tronlink }],
  });
  discovery.start();

  const ltcProvider = discovery.getProvider("litecoin", LTC_IDS.CTRL);
  assert.ok(ltcProvider, "Ctrl on Litecoin resolves");
  assert.equal(ltcProvider.isReal, true);
  const ltcResult = await ltcProvider.connect();
  assert.equal(ltcResult.address, "LbTjMGN7gELw4KbeyQf6cTCq859hD18guE");

  const tronProvider = discovery.getProvider("tron", TRON_IDS.TRONLINK);
  assert.ok(tronProvider, "TronLink resolves via its adapter");
  const tronResult = await tronProvider.connect();
  assert.equal(tronResult.address, "TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

  // Not installed / unknown → null (mock fallback).
  assert.equal(discovery.getProvider("dogecoin", DOGE_IDS.CTRL), null);
  assert.equal(discovery.getProvider("xrp", XRP_IDS.XAMAN), null, "Xaman is mobile — never a global install");
  assert.equal(discovery.getProvider("tron", TRON_IDS.OKX), null, "OKX adapter not Found → null");
});

test("TRON-EVM ISOLATION: TronLink-family wallets NEVER appear in the EVM list, even with an ethereum-like object injected", () => {
  // A window where a TronLink-family wallet injected BOTH an ethereum-like
  // object and its own globals. EVM discovery is EIP-6963-only: nothing
  // announces via 6963, so the EVM list must NOT contain TronLink — even
  // though the injected ethereum-like object exists. Tron discovery is
  // adapter-only: TronLink appears ONLY via its adapter.
  const win = {
    tronLink: {},
    ethereum: { isTronLink: true, request: async () => [] }, // ethereum-like injection
    xfi: { litecoin: {} },
  };
  const tronlink = makeFakeTronAdapter({ name: "TronLink" });
  const discovery = createWalletDiscovery({
    evmConfig: createDefaultEvmConfig(),
    solanaRegistry: makeFakeRegistry(),
    litecoinWin: win,
    tronAdapters: [{ registryId: TRON_IDS.TRONLINK, adapter: tronlink }],
  });
  discovery.start();
  const snap = discovery.getDiscovered();

  const evmNames = snap.evm.map((p) => p.name ?? "");
  assert.ok(
    !evmNames.some((n) => n.toLowerCase().includes("tronlink")),
    "TronLink must never appear in the EVM list (EIP-6963-only discovery ignores the ethereum-like injection)",
  );

  assert.deepEqual(snap.tron.map((w) => w.key), [TRON_IDS.TRONLINK], "TronLink appears in the TRON list via its adapter");
  assert.deepEqual(snap.litecoin.map((w) => w.key), [LTC_IDS.CTRL], "the ethereum-like injection does not leak into other families either");
});

test("composition: family isolation — connecting Litecoin never touches Tron", async () => {
  // Per docs/BRIEF.md: one wallet session per family; families never
  // interfere. Proven here at the provider-resolution level: each family
  // resolves through its OWN discovery module.
  const win = { xfi: { litecoin: {} } };
  const discovery = createWalletDiscovery({
    evmConfig: createDefaultEvmConfig(),
    solanaRegistry: makeFakeRegistry(),
    litecoinWin: win,
  });
  discovery.start();

  const ltc = discovery.getProvider("litecoin", LTC_IDS.CTRL);
  const doge = discovery.getProvider("dogecoin", DOGE_IDS.CTRL);
  const xrp = discovery.getProvider("xrp", XRP_IDS.CROSSMARK);
  const tron = discovery.getProvider("tron", TRON_IDS.TRONLINK);

  assert.ok(ltc, "litecoin resolves through its own module");
  assert.equal(doge, null, "dogecoin has its own separate session list");
  assert.equal(xrp, null);
  assert.equal(tron, null);
});
