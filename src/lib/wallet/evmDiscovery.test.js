/**
 * EVM discovery tests (Step 2.2) — wagmi EIP-6963 path.
 *
 * Two layers:
 *   - Pure node:test with wagmi's mock connector (deterministic, no DOM).
 *   - jsdom: REAL EIP-6963 announce events dispatched on window, flowing
 *     through wagmi's mipd store into config.connectors — the full browser
 *     discovery path, exercised without a browser.
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
import { createConfig, createStorage, http, noopStorage } from "wagmi";
import { mock } from "wagmi/connectors";
import { mainnet } from "viem/chains";
import {
  createDefaultEvmConfig,
  createEvmDiscovery,
  createEvmProviderAdapter,
} from "./evmDiscovery.js";

const EVM_ADDRESS = "0x1111222233334444555566667777888899990000";

function makeConfig({ connectors = [mock({ accounts: [EVM_ADDRESS] })] } = {}) {
  return createConfig({
    chains: [mainnet],
    connectors,
    transports: { [mainnet.id]: http() },
    multiInjectedProviderDiscovery: true,
    storage: createStorage({ storage: noopStorage }),
  });
}

/** A fake injected wallet: answers eip6963:requestProvider with announces. */
function fakeInjectedWallet({ uuid, rdns, name, request }) {
  const provider = { request, on: () => {}, removeListener: () => {}, off: () => {} };
  const announce = () => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { uuid, name, icon: "data:image/svg+xml;base64,AA==", rdns },
          provider,
        },
      }),
    );
  };
  const handler = () => announce();
  window.addEventListener("eip6963:requestProvider", handler);
  return { announce, stop: () => window.removeEventListener("eip6963:requestProvider", handler) };
}

/** Provider request handler for a wallet that supports eth_requestAccounts only. */
function requestWithAccounts(accounts) {
  return async ({ method }) => {
    if (method === "wallet_requestPermissions") throw new Error("not supported");
    if (method === "eth_requestAccounts") return accounts;
    return undefined;
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("pure node: mock connector appears in the snapshot and connects", async () => {
  const discovery = createEvmDiscovery({ config: makeConfig() });
  discovery.start();
  const providers = discovery.getProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, "Mock Connector");

  const adapter = createEvmProviderAdapter(providers[0]);
  const result = await adapter.connect();
  assert.equal(result.address.toLowerCase(), EVM_ADDRESS.toLowerCase());
  assert.equal(result.provider, adapter);
});

test("pure node: default config surfaces only the static injected() fallback", () => {
  const discovery = createEvmDiscovery(); // no window-dependent mipd here
  discovery.start();
  const providers = discovery.getProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].rdns, "injected");
});

test("eip6963: a wallet injected BEFORE the app loads is in the initial snapshot", () => {
  const wallet = fakeInjectedWallet({
    uuid: "u1", rdns: "io.metamask", name: "MetaMask",
    request: requestWithAccounts([EVM_ADDRESS]),
  });
  try {
    const discovery = createEvmDiscovery({ config: createDefaultEvmConfig() });
    discovery.start();
    const rdnsList = discovery.getProviders().map((p) => p.rdns);
    assert.ok(rdnsList.includes("io.metamask"), "EIP-6963 wallet discovered at config creation");
    const meta = discovery.getProviders().find((p) => p.rdns === "io.metamask");
    assert.equal(meta.name, "MetaMask");
  } finally {
    wallet.stop(); // unregister — must not announce into later tests' configs
  }
});

test("eip6963: a wallet announcing LATE is added reactively and onChange fires", async () => {
  const wallet = fakeInjectedWallet({
    uuid: "u1", rdns: "io.metamask", name: "MetaMask",
    request: requestWithAccounts([EVM_ADDRESS]),
  });
  wallet.stop(); // NOT registered for the initial request — injects late
  try {
    const seen = [];
    const discovery = createEvmDiscovery({
      config: createDefaultEvmConfig(),
      onChange: (p) => seen.push(p),
    });
    discovery.start();
    assert.ok(!discovery.getProviders().some((p) => p.rdns === "io.metamask"));

    await flush(); // let wagmi hydration finish so late announces register
    wallet.announce();
    await flush();

    const meta = discovery.getProviders().find((p) => p.rdns === "io.metamask");
    assert.ok(meta, "late-announcing wallet discovered");
    assert.ok(seen.length >= 2, "onChange fired for the late wallet");
  } finally {
    wallet.stop();
  }
});

test("eip6963: duplicate announces (same uuid) yield one connector", async () => {
  const wallet = fakeInjectedWallet({
    uuid: "u1", rdns: "io.metamask", name: "MetaMask",
    request: requestWithAccounts([EVM_ADDRESS]),
  });
  wallet.stop();
  try {
    const discovery = createEvmDiscovery({ config: createDefaultEvmConfig() });
    discovery.start();
    await flush();
    wallet.announce();
    wallet.announce(); // same uuid — mipd dedupes
    await flush();
    const metas = discovery.getProviders().filter((p) => p.rdns === "io.metamask");
    assert.equal(metas.length, 1, "deduped by uuid");
  } finally {
    wallet.stop();
  }
});

test("eip6963: discovered wallet connects through the real EIP-1193 provider", async () => {
  const wallet = fakeInjectedWallet({
    uuid: "u1", rdns: "io.metamask", name: "MetaMask",
    request: requestWithAccounts([EVM_ADDRESS]),
  });
  try {
    const discovery = createEvmDiscovery({ config: createDefaultEvmConfig() });
    discovery.start();
    const meta = discovery.getProviders().find((p) => p.rdns === "io.metamask");
    const adapter = createEvmProviderAdapter(meta);
    const result = await adapter.connect();
    assert.equal(result.address.toLowerCase(), EVM_ADDRESS.toLowerCase());
  } finally {
    wallet.stop();
  }
});

test("stop() detaches onChange (the wagmi config keeps its own list)", async () => {
  const wallet = fakeInjectedWallet({
    uuid: "u1", rdns: "io.metamask", name: "MetaMask",
    request: requestWithAccounts([EVM_ADDRESS]),
  });
  wallet.stop();
  try {
    let calls = 0;
    const discovery = createEvmDiscovery({ config: createDefaultEvmConfig(), onChange: () => { calls += 1; } });
    discovery.start();
    await flush();
    discovery.stop();
    wallet.announce();
    await flush();
    assert.equal(calls, 1, "onChange not fired after stop");
  } finally {
    wallet.stop();
  }
});

test("createEvmProviderAdapter surfaces connect failures", async () => {
  const config = makeConfig({
    connectors: [mock({ accounts: [], features: { connectError: new Error("user rejected the request") } })],
  });
  const discovery = createEvmDiscovery({ config });
  discovery.start();
  const adapter = createEvmProviderAdapter(discovery.getProviders()[0]);
  await assert.rejects(adapter.connect(), /user rejected the request/);
});

test("createEvmProviderAdapter rejects when the wallet returns no accounts", async () => {
  const config = makeConfig({ connectors: [mock({ accounts: [] })] });
  const discovery = createEvmDiscovery({ config });
  discovery.start();
  const adapter = createEvmProviderAdapter(discovery.getProviders()[0]);
  await assert.rejects(adapter.connect(), /returned no accounts/);
});

test("createEvmProviderAdapter rejects when no connector was injected", async () => {
  const adapter = createEvmProviderAdapter({ uuid: "x", name: "Ghost", rdns: "com.ghost" });
  await assert.rejects(adapter.connect(), /no usable connector/);
});

test("createEvmProviderAdapter disconnect releases the connector session", async () => {
  const config = makeConfig();
  const discovery = createEvmDiscovery({ config });
  discovery.start();
  const adapter = createEvmProviderAdapter(discovery.getProviders()[0]);
  await adapter.connect();
  await adapter.disconnect(); // mock connector disconnect is a no-op — must not throw
});
