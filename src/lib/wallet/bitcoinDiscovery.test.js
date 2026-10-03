/**
 * Bitcoin discovery tests (Step 2.3) — node:test, fully injected (fake
 * window objects + fake Wallet Standard registry). Proves the registry's
 * detection order and — critically — the bare injected `unisat` global
 * impersonation rule:
 *   - step-2 wallet present (Bitget/OKX/Wizz via its own namespaced key) →
 *     the bare global is NOT counted as Unisat;
 *   - no step-2 wallet → the bare global DOES count as Unisat.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBitcoinDiscovery,
  detectBareUnisat,
  enumerateInstalledBitcoinWallets,
  enumerateGlobalWallets,
  enumerateStandardBitcoinWallets,
} from "./bitcoinDiscovery.js";
import { BITCOIN_WALLET_IDS as IDS } from "./bitcoinRegistry.js";

/** A Wallet Standard wallet announcing bitcoin chains. */
function makeBtcStandardWallet({ name = "Xverse" } = {}) {
  return {
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,AA==",
    chains: ["bitcoin:mainnet"],
    accounts: [],
    features: {},
  };
}

/** A Wallet Standard wallet that announces ONLY solana (must be ignored). */
function makeSolanaOnlyWallet({ name = "Phantom" } = {}) {
  return {
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,AA==",
    chains: ["solana:mainnet"],
    accounts: [],
    features: {},
  };
}

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

/** Fake window carrying only the namespaced globals it is given. */
function fakeWin(globals = {}) {
  return globals;
}

const keys = (wallets) => wallets.map((w) => w.key).sort();

/* ————————————— Wallet Standard (step 1) ————————————— */

test("standard: enumerates bitcoin-chain Wallet Standard registrations by registry name", () => {
  const registry = makeFakeRegistry([
    makeBtcStandardWallet({ name: "Xverse" }),
    makeBtcStandardWallet({ name: "Phantom" }),
    makeBtcStandardWallet({ name: "Coinbase Wallet" }),
    makeSolanaOnlyWallet({ name: "Phantom" }), // same name, solana-only — ignored
  ]);
  const wallets = enumerateStandardBitcoinWallets(registry);
  assert.deepEqual(keys(wallets), [IDS.COINBASE, IDS.PHANTOM, IDS.XVERSE]);
  assert.ok(wallets.every((w) => w.source === "standard"));
});

test("standard: a solana-only registration is NOT a bitcoin wallet", () => {
  const registry = makeFakeRegistry([makeSolanaOnlyWallet({ name: "Phantom" })]);
  assert.deepEqual(enumerateStandardBitcoinWallets(registry), []);
});

test("standard: unknown bitcoin registrations surface as standard:<name> extras (never hidden)", () => {
  const registry = makeFakeRegistry([makeBtcStandardWallet({ name: "Some Future Wallet" })]);
  const wallets = enumerateStandardBitcoinWallets(registry);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].key, "standard:Some Future Wallet");
});

/* ————————————— Namespaced globals (step 2) ————————————— */

test("global: every registry namespaced detection key maps to its wallet", () => {
  const win = fakeWin({
    XverseProviders: { BitcoinProvider: {} },
    okxwallet: { bitcoin: {} },
    bitkeep: { unisat: {} },
    wizz: {},
    phantom: { bitcoin: {} },
    magicEden: { bitcoin: {} },
    LeatherProvider: {},
    xfi: { bitcoin: {} },
    oyl: {},
    OrangeWalletProviders: { OrangeBitcoinProvider: {} },
    opnet: {},
  });
  const wallets = enumerateGlobalWallets(win);
  assert.deepEqual(keys(wallets), [
    IDS.BITGET,
    IDS.CTRL,
    IDS.LEATHER,
    IDS.MAGIC_EDEN,
    IDS.OKX,
    IDS.OP_NET,
    IDS.ORANGE,
    IDS.OYL,
    IDS.PHANTOM,
    IDS.WIZZ,
    IDS.XVERSE,
  ]);
});

test("global: orange legacy global variants are accepted", () => {
  assert.equal(
    enumerateGlobalWallets(fakeWin({ OrangeBitcoinProvider: {} })).some((w) => w.key === IDS.ORANGE),
    true,
  );
  assert.equal(
    enumerateGlobalWallets(fakeWin({ OrangecryptoProviders: { BitcoinProvider: {} } })).some(
      (w) => w.key === IDS.ORANGE,
    ),
    true,
  );
});

test("global: a missing namespace never throws (defensive access)", () => {
  assert.deepEqual(enumerateGlobalWallets(fakeWin({ okxwallet: {} })), []);
  assert.deepEqual(enumerateGlobalWallets(fakeWin({})), []);
  assert.deepEqual(enumerateGlobalWallets(undefined), []);
});

/* ————————————— Bare injected unisat global + impersonation (step 3) ————————————— */

test("impersonation: the bare injected unisat global alone counts as REAL Unisat", () => {
  const win = fakeWin({ unisat: { requestAccounts: async () => [] } });
  assert.equal(detectBareUnisat(win), true);
  const wallets = enumerateInstalledBitcoinWallets({ win });
  assert.ok(wallets.some((w) => w.key === IDS.UNISAT && w.source === "unisat"));
});

test("impersonation: Bitget present (bitkeep.unisat) → the bare global is NOT Unisat", () => {
  const win = fakeWin({ unisat: {}, bitkeep: { unisat: {} } });
  assert.equal(detectBareUnisat(win), false, "Bitget impersonates the bare global");
  const wallets = enumerateInstalledBitcoinWallets({ win });
  assert.ok(wallets.some((w) => w.key === IDS.BITGET), "Bitget itself is detected");
  assert.ok(!wallets.some((w) => w.key === IDS.UNISAT), "Unisat must NOT be counted");
});

test("impersonation: OKX present (okxwallet.bitcoin) → the bare global is NOT Unisat", () => {
  const win = fakeWin({ unisat: {}, okxwallet: { bitcoin: {} } });
  assert.equal(detectBareUnisat(win), false);
  const wallets = enumerateInstalledBitcoinWallets({ win });
  assert.ok(!wallets.some((w) => w.key === IDS.UNISAT));
});

test("impersonation: Wizz present (wizz) → the bare global is NOT Unisat", () => {
  const win = fakeWin({ unisat: {}, wizz: {} });
  assert.equal(detectBareUnisat(win), false);
  const wallets = enumerateInstalledBitcoinWallets({ win });
  assert.ok(!wallets.some((w) => w.key === IDS.UNISAT));
});

test("impersonation: an unrelated step-2 wallet does NOT suppress Unisat", () => {
  const win = fakeWin({ unisat: {}, phantom: { bitcoin: {} } });
  assert.equal(detectBareUnisat(win), true, "Phantom does not impersonate the bare global");
  const wallets = enumerateInstalledBitcoinWallets({ win });
  assert.ok(wallets.some((w) => w.key === IDS.UNISAT));
});

test("impersonation: a real Unisat Wallet Standard registration still counts even with impersonators present", () => {
  // The bare global is suppressed, but the REAL extension (registered via
  // Wallet Standard) is legitimately installed.
  const registry = makeFakeRegistry([makeBtcStandardWallet({ name: "Unisat" })]);
  const win = fakeWin({ unisat: {}, bitkeep: { unisat: {} } });
  const wallets = enumerateInstalledBitcoinWallets({ win, standardRegistry: registry });
  assert.ok(wallets.some((w) => w.key === IDS.UNISAT && w.source === "standard"));
});

test("impersonation: no window at all → Unisat not detected, no throw", () => {
  assert.equal(detectBareUnisat(undefined), false);
  assert.deepEqual(enumerateInstalledBitcoinWallets({ win: undefined, standardRegistry: null }), []);
});

/* ————————————— Dedupe + full order ————————————— */

test("a wallet in BOTH Wallet Standard and namespaced global appears once", () => {
  const registry = makeFakeRegistry([makeBtcStandardWallet({ name: "Phantom" })]);
  const win = fakeWin({ phantom: { bitcoin: {} } });
  const wallets = enumerateInstalledBitcoinWallets({ win, standardRegistry: registry });
  assert.equal(wallets.filter((w) => w.key === IDS.PHANTOM).length, 1);
});

test("the handle enumerates, subscribes and stops (Wallet Standard lifecycle)", () => {
  const xverse = makeBtcStandardWallet({ name: "Xverse" });
  const phantom = makeBtcStandardWallet({ name: "Phantom" });
  const registry = makeFakeRegistry([xverse]);
  const seen = [];
  const discovery = createBitcoinDiscovery({ win: fakeWin({}), standardRegistry: registry, onChange: (w) => seen.push(w) });
  discovery.start();

  assert.deepEqual(keys(discovery.getInstalled()), [IDS.XVERSE]);
  assert.equal(seen.length, 1, "initial snapshot emitted");

  registry._register(phantom);
  assert.deepEqual(keys(discovery.getInstalled()), [IDS.PHANTOM, IDS.XVERSE]);
  assert.equal(seen.length, 2, "late registration emitted");

  registry._unregister(xverse);
  assert.deepEqual(keys(discovery.getInstalled()), [IDS.PHANTOM]);
  assert.equal(seen.length, 3, "unregister emitted");

  discovery.stop();
  registry._register(makeBtcStandardWallet({ name: "Leather" }));
  assert.equal(seen.length, 3, "no refresh after stop");
});

test("getProvider resolves installed wallets and returns null for the rest", () => {
  const registry = makeFakeRegistry([makeBtcStandardWallet({ name: "Xverse" })]);
  const laserEyes = { connect: async () => ({ paymentAddress: "bc1qabc" }), disconnect() {} };
  const discovery = createBitcoinDiscovery({
    win: fakeWin({}),
    standardRegistry: registry,
    laserEyes,
    balanceFetcher: async () => 123,
  });
  discovery.start();

  const provider = discovery.getProvider(IDS.XVERSE);
  assert.ok(provider, "installed wallet resolves a provider");
  assert.equal(provider.walletName, "Xverse");

  assert.equal(discovery.getProvider(IDS.UNISAT), null, "not installed → null (mock fallback)");
  assert.equal(discovery.getProvider("standard:Some Future Wallet"), null, "standard extras have no adapter");
});

test("global-detected wallets also resolve providers (win injected)", () => {
  const discovery = createBitcoinDiscovery({
    win: fakeWin({ phantom: { bitcoin: {} } }),
    standardRegistry: makeFakeRegistry(),
    laserEyes: { connect: async () => ({ paymentAddress: "bc1qxyz" }), disconnect() {} },
  });
  discovery.start();
  assert.ok(discovery.getProvider(IDS.PHANTOM), "phantom via window.phantom.bitcoin");
});

test("the bare-global Unisat detection flows through the handle only when un-impersonated", () => {
  const bare = createBitcoinDiscovery({
    win: fakeWin({ unisat: {} }),
    standardRegistry: makeFakeRegistry(),
  });
  bare.start();
  assert.ok(bare.getProvider(IDS.UNISAT), "bare unisat counts when alone");

  const impersonated = createBitcoinDiscovery({
    win: fakeWin({ unisat: {}, wizz: {} }),
    standardRegistry: makeFakeRegistry(),
  });
  impersonated.start();
  assert.equal(impersonated.getProvider(IDS.UNISAT), null, "wizz impersonates the bare global");
});
