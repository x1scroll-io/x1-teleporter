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
    // One notification per sub-discovery's initial snapshot (evm + solana).
    assert.equal(notifications, 2, "start notifies subscribers");
    await flush();
    discovery.stop();

    wallet.announce();
    await flush();
    assert.equal(notifications, 2, "no subscriber notification after stop");

    const snap = discovery.getDiscovered();
    assert.ok(Array.isArray(snap.evm) && Array.isArray(snap.solana), "snapshot still readable");
  } finally {
    wallet.stop();
  }
});

test("default handle (no injected config/registry) degrades to fallback-only discovery", () => {
  // Pure browser-less default: EVM surfaces only the static injected()
  // fallback connector; Solana has nothing registered.
  const discovery = createWalletDiscovery();
  discovery.start();
  const snap = discovery.getDiscovered();
  assert.equal(snap.evm.length, 1);
  assert.equal(snap.evm[0].rdns, "injected");
  assert.deepEqual(snap.solana, []);
  assert.equal(discovery.getProvider("evm", "io.metamask"), null);
});
