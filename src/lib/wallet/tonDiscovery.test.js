/**
 * tonDiscovery.test.js — DI-clean tests for the TON Connect discovery. A fake
 * TON Connect handle is injected on the tonDiscovery module's own surface (no
 * window, no DOM, no SDK import). Proves: wallet-list enumeration, the
 * registry appName match, the connect handshake → address + best-effort
 * balance, and the fail-closed "no handle → nothing" path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTonDiscovery } from "./tonDiscovery.js";
import { TON_WALLET_IDS as TON_IDS } from "./tonRegistry.js";

/** Fake TON Connect handle (the shape tonDiscovery consumes). */
function makeFakeTonConnect({ wallets = [], account = { address: "EQFakeAddress" } } = {}) {
  const listeners = [];
  return {
    getWallets: async () => wallets,
    connect: async () => account,
    onStatusChange(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    disconnect: async () => {},
    _emit(wallet) {
      for (const cb of listeners) cb(wallet);
    },
  };
}

const tonWallet = (appName, name) => ({ appName, name });

const flush = () => new Promise((r) => setTimeout(r, 0));

test("enumerates the TON Connect wallet list (the connectable set)", async () => {
  const tonConnect = makeFakeTonConnect({
    wallets: [
      tonWallet("tonkeeper", "Tonkeeper"),
      tonWallet("tonhub", "Tonhub"),
      tonWallet("mytonwallet", "MyTonWallet"),
    ],
  });
  const discovery = createTonDiscovery({ tonConnect });
  discovery.start();
  await flush(); // getWallets() is async (TON Connect's list is remote)
  assert.deepEqual(
    discovery.getInstalled().map((w) => w.key),
    ["tonkeeper", "tonhub", "mytonwallet"],
  );
  assert.equal(discovery.getInstalled()[0].name, "Tonkeeper");
  assert.equal(discovery.getInstalled()[0].source, "ton-connect");
});

test("getProvider resolves a listed wallet → connect → address + balance", async () => {
  const tonConnect = makeFakeTonConnect({
    wallets: [tonWallet(TON_IDS.TONKEEPER, "Tonkeeper")],
    account: { address: "EQC-tonkeeper-user" },
  });
  const discovery = createTonDiscovery({
    tonConnect,
    balanceFetcher: async (addr) => (addr === "EQC-tonkeeper-user" ? 42n : null),
  });
  discovery.start();
  await flush(); // the wallet list resolves asynchronously

  const provider = discovery.getProvider(TON_IDS.TONKEEPER);
  assert.ok(provider, "resolves a listed TON wallet");
  assert.equal(provider.isReal, true);

  const result = await provider.connect();
  assert.equal(result.address, "EQC-tonkeeper-user");
  assert.equal(result.balance, 42n);
});

test("getProvider returns null for unknown ids, the deposit row, and unlisted wallets", () => {
  const tonConnect = makeFakeTonConnect({ wallets: [] });
  const discovery = createTonDiscovery({ tonConnect });
  discovery.start();
  assert.equal(discovery.getProvider(TON_IDS.TONKEEPER), null, "not in the connectable set → null");
  assert.equal(discovery.getProvider(TON_IDS.DEPOSIT_ADDRESS), null, "the deposit row is never connectable");
  assert.equal(discovery.getProvider("nope"), null, "unknown id → null");
});

test("resolves an ASYNC handle (a promise) and reports wallets when ready", async () => {
  const tonConnect = makeFakeTonConnect({ wallets: [tonWallet(TON_IDS.TONHUB, "Tonhub")] });
  const discovery = createTonDiscovery({ tonConnect: Promise.resolve(tonConnect) });
  discovery.start();
  assert.deepEqual(discovery.getInstalled(), [], "nothing yet — the handle promise is pending");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(discovery.getInstalled().map((w) => w.key), [TON_IDS.TONHUB]);
});

test("no TON Connect handle → fail closed (nothing connectable, never a dead provider)", () => {
  const seen = [];
  const discovery = createTonDiscovery({ tonConnect: null, onChange: (w) => seen.push(w) });
  discovery.start();
  assert.deepEqual(discovery.getInstalled(), []);
  assert.deepEqual(seen, [[]], "onChange fires once with the empty snapshot");
  assert.equal(discovery.getProvider(TON_IDS.TONKEEPER), null);
});

test("status changes re-notify subscribers", async () => {
  const tonConnect = makeFakeTonConnect({ wallets: [tonWallet(TON_IDS.MYTONWALLET, "MyTonWallet")] });
  let count = 0;
  const discovery = createTonDiscovery({ tonConnect, onChange: () => { count += 1; } });
  discovery.start();
  await flush();
  assert.equal(count, 1, "initial snapshot");
  tonConnect._emit({ appName: TON_IDS.MYTONWALLET });
  assert.equal(count, 2, "re-scanned on status change");
});
