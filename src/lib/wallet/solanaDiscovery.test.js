/**
 * Solana Wallet Standard discovery tests (Step 2.2) — node:test.
 *
 * Drives createSolanaDiscovery with a FAKE registry ({ get, on }) — no
 * window, no extensions. The fake wallets are real Wallet Standard shaped
 * objects (they pass isWalletAdapterCompatibleStandardWallet), so the
 * StandardWalletAdapter wrapping path is exercised for real.
 *
 * jsdom globals are defined because StandardWalletAdapter reports
 * readyState "Installed" (and allows connect()) only when a window + DOM
 * exist — in bare Node it reports "Unsupported" by design.
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
import { StandardWalletAdapter } from "@solana/wallet-standard";
import {
  createSolanaDiscovery,
  createSolanaProviderAdapter,
} from "./solanaDiscovery.js";

/** A valid-looking Solana pubkey (base58) reused as the mock address. */
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/**
 * Build a Wallet Standard shaped wallet that passes the compatibility check
 * (standard:connect + standard:events + solana:signAndSendTransaction).
 */
function makeStandardWallet({ name = "Fake Phantom", accounts = [] } = {}) {
  const account = {
    address: ADDRESS,
    publicKey: bs58.decode(ADDRESS),
    chains: ["solana:mainnet"],
    features: ["standard:connect"],
  };
  return {
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,AA==",
    chains: ["solana:mainnet"],
    accounts: accounts.length ? accounts : [account],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => ({ accounts: [account] }),
      },
      "standard:events": {
        version: "1.0.0",
        on: () => () => {}, // adapter constructor subscribes; no-op off
        off: () => {},
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signAndSendTransaction: async () => ({ signature: new Uint8Array(64) }),
      },
    },
  };
}

/** Fake Wallet Standard registry: { get, on } plus test mutation helpers. */
function makeFakeRegistry(initialWallets = []) {
  let wallets = [...initialWallets];
  const listeners = { register: [], unregister: [] };
  return {
    get: () => [...wallets],
    on(event, listener) {
      listeners[event].push(listener);
      return () => {
        listeners[event] = listeners[event].filter((l) => l !== listener);
      };
    },
    // Test helpers (not part of the Wallets API surface):
    _register(...ws) {
      wallets = [...wallets, ...ws];
      for (const l of listeners.register) l(...ws);
    },
    _unregister(...ws) {
      wallets = wallets.filter((w) => !ws.includes(w));
      for (const l of listeners.unregister) l(...ws);
    },
  };
}

test("lists pre-registered wallets as adapters on start()", () => {
  const registry = makeFakeRegistry([makeStandardWallet({ name: "Phantom" })]);
  const seen = [];
  const discovery = createSolanaDiscovery({ registry, onChange: (a) => seen.push(a) });
  discovery.start();

  const adapters = discovery.getAdapters();
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0].name, "Phantom");
  // jsdom provides a window + document, so the adapter reports "Installed"
  // (in bare Node it reports "Unsupported" — an environment artifact, NOT a
  // discovery failure; Wallet Standard registration IS the install signal).
  assert.equal(adapters[0].readyState, "Installed");
  assert.equal(seen.length, 1, "onChange fired with the initial snapshot");
});

test("picks up wallets that register AFTER start() (late-injecting wallet)", () => {
  const registry = makeFakeRegistry();
  const discovery = createSolanaDiscovery({ registry });
  discovery.start();
  assert.equal(discovery.getAdapters().length, 0);

  registry._register(makeStandardWallet({ name: "Backpack" }));
  const adapters = discovery.getAdapters();
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0].name, "Backpack");
});

test("drops wallets that unregister", () => {
  const phantom = makeStandardWallet({ name: "Phantom" });
  const backpack = makeStandardWallet({ name: "Backpack" });
  const registry = makeFakeRegistry([phantom, backpack]);
  const discovery = createSolanaDiscovery({ registry });
  discovery.start();
  assert.equal(discovery.getAdapters().length, 2);

  registry._unregister(phantom);
  assert.deepEqual(
    discovery.getAdapters().map((a) => a.name),
    ["Backpack"],
  );
});

test("filters wallets that are not wallet-adapter compatible", () => {
  const incompatible = {
    version: "1.0.0",
    name: "Not Compatible",
    icon: "data:image/svg+xml;base64,AA==",
    chains: ["solana:mainnet"],
    accounts: [],
    features: { "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [] }) } },
  };
  const registry = makeFakeRegistry([incompatible, makeStandardWallet({ name: "Phantom" })]);
  const discovery = createSolanaDiscovery({ registry });
  discovery.start();
  assert.deepEqual(
    discovery.getAdapters().map((a) => a.name),
    ["Phantom"],
    "incompatible wallet filtered out",
  );
});

test("stop() unsubscribes — later register events are ignored", () => {
  const registry = makeFakeRegistry();
  const discovery = createSolanaDiscovery({ registry });
  discovery.start();
  discovery.stop();
  registry._register(makeStandardWallet({ name: "Phantom" }));
  assert.equal(discovery.getAdapters().length, 0, "no refresh after stop");
});

test("createSolanaProviderAdapter connects and resolves the base58 address", async () => {
  const wallet = makeStandardWallet();
  const adapter = new StandardWalletAdapter({ wallet });
  const provider = createSolanaProviderAdapter(adapter);
  assert.equal(provider.family, "solana");
  assert.equal(provider.isReal, true);
  assert.equal(provider.walletName, "Fake Phantom");

  const result = await provider.connect();
  assert.equal(result.address, ADDRESS);
  assert.equal(result.provider, provider);
  assert.equal(adapter.connected, true);
});

test("createSolanaProviderAdapter disconnects through the adapter", async () => {
  let disconnected = 0;
  const fakeAdapter = {
    name: "Phantom",
    connect: async () => {},
    disconnect: async () => { disconnected += 1; },
    publicKey: { toBase58: () => ADDRESS },
  };
  const provider = createSolanaProviderAdapter(fakeAdapter);
  const result = await provider.connect();
  assert.equal(result.address, ADDRESS);
  await provider.disconnect();
  assert.equal(disconnected, 1);
});

test("createSolanaProviderAdapter rejects when no public key resolves", async () => {
  const fakeAdapter = { name: "Phantom", connect: async () => {}, publicKey: null };
  const provider = createSolanaProviderAdapter(fakeAdapter);
  await assert.rejects(provider.connect(), /returned no public key/);
});

test("createSolanaProviderAdapter tolerates adapters without disconnect", async () => {
  const fakeAdapter = { name: "Phantom", connect: async () => {}, publicKey: { toBase58: () => ADDRESS } };
  const provider = createSolanaProviderAdapter(fakeAdapter);
  await provider.disconnect(); // must not throw
});
