/**
 * nearDiscovery.test.js — DI-clean tests for the NEAR Wallet Selector
 * discovery. A fake selector AND a fake window are injected on the module's
 * own surface (no real window, no DOM, no SDK import). Proves: POSITIVE
 * presence detection (never `metadata.available`), the registry key match, the
 * connect handshake → account id + best-effort balance, the 15s connect
 * TIMEOUT, and the fail-closed "nothing detected → null" path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNearDiscovery,
  isNearWalletPresent,
  NEAR_CONNECT_TIMEOUT_MS,
} from "./nearDiscovery.js";
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

/* ————————————— INSTALL DETECTION (fail-closed) ————————————— */

test("metadata.available alone does NOT mark a wallet installed (the fail-open bug)", () => {
  // The selector hard-codes `available: true` for the web/injected wallets —
  // exactly the signal the old code trusted. With nothing injected it must
  // report ZERO installed wallets.
  const selector = makeFakeSelector({
    modules: [
      module_("my-near-wallet", "MyNearWallet"),
      module_("meteor-wallet", "Meteor Wallet"),
      module_("nightly", "Nightly"),
      module_("ledger", "Ledger"),
      module_("sender", "Sender"),
    ],
  });
  const discovery = createNearDiscovery({ selector, win: {} });
  discovery.start();
  assert.deepEqual(
    discovery.getInstalled(),
    [],
    "no positive presence signal → nothing installed (rows fall through to Install)",
  );
});

test("detects Meteor / Nightly / Sender via their injected globals", () => {
  const selector = makeFakeSelector({
    modules: [
      module_("my-near-wallet", "MyNearWallet"),
      module_("meteor-wallet", "Meteor Wallet"),
      module_("nightly", "Nightly"),
      module_("sender", "Sender"),
    ],
  });
  const discovery = createNearDiscovery({
    selector,
    win: { meteorWallet: {}, nightly: {}, near: { isSender: true } },
  });
  discovery.start();
  assert.deepEqual(
    discovery.getInstalled().map((w) => w.key),
    ["meteor-wallet", "nightly", "sender"],
    "only the positively-detected wallets are installed",
  );
  assert.equal(discovery.getInstalled()[0].source, "near-selector");
});

test("MyNearWallet and Ledger are NEVER installable (no passive presence signal)", () => {
  const selector = makeFakeSelector({
    modules: [module_("my-near-wallet", "MyNearWallet"), module_("ledger", "Ledger")],
  });
  // Even a window that advertises WebHID (what the selector's Ledger module
  // treats as `available`) must NOT count as an installed Ledger, and the
  // MyNearWallet popup web wallet has no injected global at all.
  const discovery = createNearDiscovery({
    selector,
    win: { navigator: { hid: {} } },
  });
  discovery.start();
  assert.deepEqual(discovery.getInstalled(), []);
  assert.equal(discovery.getProvider(NEAR_IDS.MY_NEAR_WALLET), null, "MyNearWallet → Install, not connectable");
  assert.equal(discovery.getProvider(NEAR_IDS.LEDGER), null, "Ledger → Install, not connectable");
});

test("isNearWalletPresent: positive probes only; a throwing global is never present", () => {
  assert.equal(isNearWalletPresent("meteor-wallet", { meteorWallet: {} }), true);
  assert.equal(isNearWalletPresent("meteor-wallet", {}), false);
  assert.equal(isNearWalletPresent("sender", { near: { isSender: true } }), true);
  assert.equal(isNearWalletPresent("sender", { near: {} }), false);
  assert.equal(isNearWalletPresent("my-near-wallet", { myNearWallet: {} }), false, "no probe → never present");
  assert.equal(isNearWalletPresent("nope", {}), false);
  const hostile = {};
  Object.defineProperty(hostile, "meteorWallet", { get() { throw new Error("boom"); } });
  assert.equal(isNearWalletPresent("meteor-wallet", hostile), false, "a throwing getter must not crash");
});

/* ————————————— CONNECT ————————————— */

test("getProvider resolves an installed wallet → connect → account id + balance", async () => {
  let signedInWith = null;
  const selector = makeFakeSelector({
    modules: [module_(NEAR_IDS.METEOR, "Meteor Wallet")],
    wallets: {
      [NEAR_IDS.METEOR]: {
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
    win: { meteorWallet: {} },
    contractId: "v2.ref-finance.near",
    balanceFetcher: async (accountId) => (accountId === "alice.near" ? 123n : null),
  });
  discovery.start();

  const provider = discovery.getProvider(NEAR_IDS.METEOR);
  assert.ok(provider, "resolves an installed NEAR wallet");
  assert.equal(provider.isReal, true);

  const result = await provider.connect();
  assert.equal(result.address, "alice.near");
  assert.equal(result.balance, 123n);
  assert.deepEqual(signedInWith, { contractId: "v2.ref-finance.near" }, "sign-in requests a key for the reference contract");
});

test("connect TIMES OUT and fails closed (never hangs on Connecting…)", async () => {
  const selector = makeFakeSelector({
    modules: [module_(NEAR_IDS.SENDER, "Sender")],
    wallets: {
      // A wallet that never answers the handshake.
      [NEAR_IDS.SENDER]: { signIn: () => new Promise(() => {}), async signOut() {} },
    },
  });
  const discovery = createNearDiscovery({
    selector,
    win: { near: { isSender: true } },
    timeoutMs: 20, // short for the test; production default is 15s
  });
  discovery.start();

  const provider = discovery.getProvider(NEAR_IDS.SENDER);
  assert.ok(provider);
  await assert.rejects(
    () => provider.connect(),
    /did not respond in time/,
    "a hung handshake rejects instead of hanging forever",
  );
});

test("the connect timeout defaults to 15s (NEAR_CONNECT_TIMEOUT_MS)", () => {
  assert.equal(NEAR_CONNECT_TIMEOUT_MS, 15000);
});

/* ————————————— FAIL-CLOSED EDGES ————————————— */

test("getProvider returns null for unknown ids, the deposit row, and undetected wallets", () => {
  const selector = makeFakeSelector({ modules: [] });
  const discovery = createNearDiscovery({ selector, win: {} });
  discovery.start();
  assert.equal(discovery.getProvider(NEAR_IDS.METEOR), null, "not detected → null");
  assert.equal(discovery.getProvider(NEAR_IDS.DEPOSIT_ADDRESS), null, "the deposit row is never connectable");
  assert.equal(discovery.getProvider("nope"), null, "unknown id → null");
});

test("resolves an ASYNC selector (a promise) and reports modules when ready", async () => {
  const selector = makeFakeSelector({ modules: [module_(NEAR_IDS.SENDER, "Sender")] });
  const discovery = createNearDiscovery({ selector: Promise.resolve(selector), win: { near: { isSender: true } } });
  discovery.start();
  assert.deepEqual(discovery.getInstalled(), [], "nothing yet — the selector promise is pending");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(discovery.getInstalled().map((w) => w.key), [NEAR_IDS.SENDER]);
});

test("no selector → fail closed (nothing connectable, never a dead provider)", () => {
  const seen = [];
  const discovery = createNearDiscovery({ selector: null, win: {}, onChange: (w) => seen.push(w) });
  discovery.start();
  assert.deepEqual(discovery.getInstalled(), []);
  assert.deepEqual(seen, [[]], "onChange fires once with the empty snapshot");
  assert.equal(discovery.getProvider(NEAR_IDS.METEOR), null);
});

test("a rejected selector promise degrades to nothing (does not throw)", async () => {
  const discovery = createNearDiscovery({ selector: Promise.reject(new Error("boom")), win: {} });
  discovery.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(discovery.getInstalled(), []);
});

test("sign-in events re-notify subscribers", () => {
  const selector = makeFakeSelector({ modules: [module_(NEAR_IDS.METEOR, "Meteor Wallet")] });
  let count = 0;
  const discovery = createNearDiscovery({ selector, win: { meteorWallet: {} }, onChange: () => { count += 1; } });
  discovery.start();
  assert.equal(count, 1, "initial snapshot");
  selector._emit("signedIn", { walletId: NEAR_IDS.METEOR, accounts: [{ accountId: "bob.near" }] });
  assert.equal(count, 2, "re-scanned on sign-in");
});
