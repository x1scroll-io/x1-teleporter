/**
 * nearDiscovery.test.js — DI-clean tests for the NEAR Wallet Selector
 * discovery. A fake selector is injected on the nearDiscovery module's own
 * surface (no window, no DOM, no SDK import). Proves: available-module
 * enumeration, the registry key match, the connect handshake → account id +
 * best-effort balance, and the fail-closed "nothing available → null" path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createNearDiscovery } from "./nearDiscovery.js";
import { NEAR_WALLET_IDS as NEAR_IDS } from "./nearRegistry.js";

/** Fake NEAR Wallet Selector (the shape nearDiscovery consumes). */
function makeFakeSelector({ modules = [], wallets = {} } = {}) {
  const handlers = { signedIn: [], signedOut: [], accountsChanged: [] };
  return {
    store: { getState: () => ({ modules, accounts: [], selectedWalletId: null }) },
    wallet: async (id) => wallets[id] ?? { async signIn() { return []; }, async signOut() {} },
    on(event, cb) {
      (handlers[event] ??= []).push(cb);
      return { unsubscribe: () => { handlers[event] = handlers[event].filter((l) => l !== cb); } };
    },
    _emit(event, payload) {
      for (const cb of handlers[event] ?? []) cb(payload);
    },
  };
}

const module_ = (id, name, available = true) => ({ id, metadata: { name, available } });

test("enumerates the selector's available modules (unavailable ones dropped)", () => {
  const selector = makeFakeSelector({
    modules: [
      module_("my-near-wallet", "MyNearWallet"),
      module_("meteor-wallet", "Meteor Wallet"),
      module_("ledger", "Ledger"),
      module_("walletconnect", "WalletConnect", false), // unavailable → dropped
    ],
  });
  const discovery = createNearDiscovery({ selector });
  discovery.start();
  const installed = discovery.getInstalled();
  assert.deepEqual(
    installed.map((w) => w.key),
    ["my-near-wallet", "meteor-wallet", "ledger"],
  );
  assert.equal(installed[0].name, "MyNearWallet");
  assert.equal(installed[0].source, "near-selector");
});

test("getProvider resolves an available wallet → connect → account id + balance", async () => {
  let signedInWith = null;
  const selector = makeFakeSelector({
    modules: [module_(NEAR_IDS.MY_NEAR_WALLET, "MyNearWallet")],
    wallets: {
      [NEAR_IDS.MY_NEAR_WALLET]: {
        async signIn(params) {
          signedInWith = params;
          return [{ accountId: "alice.near" }];
        },
        async signOut() {},
      },
    },
  });
  const discovery = createNearDiscovery({
    selector,
    contractId: "v2.ref-finance.near",
    balanceFetcher: async (accountId) => (accountId === "alice.near" ? 123n : null),
  });
  discovery.start();

  const provider = discovery.getProvider(NEAR_IDS.MY_NEAR_WALLET);
  assert.ok(provider, "resolves an available NEAR wallet");
  assert.equal(provider.isReal, true);

  const result = await provider.connect();
  assert.equal(result.address, "alice.near");
  assert.equal(result.balance, 123n);
  assert.deepEqual(signedInWith, { contractId: "v2.ref-finance.near" }, "sign-in requests a key for the reference contract");
});

test("getProvider returns null for unknown ids, the deposit row, and uninstalled wallets", () => {
  const selector = makeFakeSelector({ modules: [] });
  const discovery = createNearDiscovery({ selector });
  discovery.start();
  assert.equal(discovery.getProvider(NEAR_IDS.MY_NEAR_WALLET), null, "not available → null");
  assert.equal(discovery.getProvider(NEAR_IDS.DEPOSIT_ADDRESS), null, "the deposit row is never connectable");
  assert.equal(discovery.getProvider("nope"), null, "unknown id → null");
});

test("resolves an ASYNC selector (a promise) and reports modules when ready", async () => {
  const selector = makeFakeSelector({ modules: [module_(NEAR_IDS.SENDER, "Sender")] });
  const discovery = createNearDiscovery({ selector: Promise.resolve(selector) });
  discovery.start();
  assert.deepEqual(discovery.getInstalled(), [], "nothing yet — the selector promise is pending");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(discovery.getInstalled().map((w) => w.key), [NEAR_IDS.SENDER]);
});

test("no selector → fail closed (nothing connectable, never a dead provider)", () => {
  const seen = [];
  const discovery = createNearDiscovery({ selector: null, onChange: (w) => seen.push(w) });
  discovery.start();
  assert.deepEqual(discovery.getInstalled(), []);
  assert.deepEqual(seen, [[]], "onChange fires once with the empty snapshot");
  assert.equal(discovery.getProvider(NEAR_IDS.MY_NEAR_WALLET), null);
});

test("a rejected selector promise degrades to nothing (does not throw)", async () => {
  const discovery = createNearDiscovery({ selector: Promise.reject(new Error("boom")) });
  discovery.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(discovery.getInstalled(), []);
});

test("sign-in events re-notify subscribers", () => {
  const selector = makeFakeSelector({ modules: [module_(NEAR_IDS.METEOR, "Meteor Wallet")] });
  let count = 0;
  const discovery = createNearDiscovery({ selector, onChange: () => { count += 1; } });
  discovery.start();
  assert.equal(count, 1, "initial snapshot");
  selector._emit("signedIn", { walletId: NEAR_IDS.METEOR, accounts: [{ accountId: "bob.near" }] });
  assert.equal(count, 2, "re-scanned on sign-in");
});
