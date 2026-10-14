/**
 * Dogecoin discovery tests (Step 2.4) — node:test, fully injected (fake
 * window objects). Proves the registry's namespaced-global detection
 * (window.xfi.dogecoin → Ctrl, window.doge → MyDoge, window.dogeLabs →
 * DogeLabs), the Ctrl connect adapter (request_accounts on the
 * xfi.dogecoin surface), and the TODO-gating of every unverified row —
 * including MyDoge's balance-only + deposit-address memo hand-off rule.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDogecoinDiscovery,
  createDogecoinProviderAdapter,
  enumerateGlobalWallets,
  firstDogeAddress,
} from "./dogecoinDiscovery.js";
import {
  DOGECOIN_WALLETS,
  DOGECOIN_WALLET_IDS as IDS,
} from "./dogecoinRegistry.js";
import { canSendInApp, memoHandoffNote } from "./memoRule.js";

const DOGE_ADDRESS = "DQyfNhuqN9mseL9YmgW8Sh7GNDjUn6oC1R";

/** Fake window carrying only the namespaced globals it is given. */
const fakeWin = (globals = {}) => globals;

const keys = (wallets) => wallets.map((w) => w.key).sort();

test("global: every registry namespaced detection key maps to its wallet", () => {
  const win = fakeWin({ xfi: { dogecoin: {} }, doge: {}, dogeLabs: {} });
  assert.deepEqual(keys(enumerateGlobalWallets(win)), [IDS.CTRL, IDS.DOGELABS, IDS.MYDOGE]);
  assert.ok(enumerateGlobalWallets(win).every((w) => w.source === "global"));
});

test("global: a missing namespace never throws (defensive access)", () => {
  assert.deepEqual(enumerateGlobalWallets(fakeWin({ xfi: {} })), []);
  assert.deepEqual(
    enumerateGlobalWallets(fakeWin({ doge: {} })).map((w) => w.key),
    [IDS.MYDOGE],
  );
  assert.deepEqual(enumerateGlobalWallets(undefined), []);
});

test("global: the ⚠️ rows with no documented key are never detected via globals", () => {
  const win = fakeWin({ enkrypt: {}, okxwallet: {}, trustwallet: {}, bitkeep: {} });
  assert.deepEqual(enumerateGlobalWallets(win), []);
});

test("the handle enumerates, snapshots and resolves providers", () => {
  const seen = [];
  const discovery = createDogecoinDiscovery({
    win: fakeWin({ xfi: { dogecoin: {} } }),
    onChange: (w) => seen.push(w),
  });
  discovery.start();

  assert.deepEqual(keys(discovery.getInstalled()), [IDS.CTRL]);
  assert.equal(seen.length, 1, "initial snapshot emitted");

  const provider = discovery.getProvider(IDS.CTRL);
  assert.ok(provider, "installed wallet resolves a provider");
  assert.equal(provider.walletName, "Ctrl (ex-XDEFI)");

  assert.equal(discovery.getProvider(IDS.MYDOGE), null, "not installed → null (mock fallback)");
  discovery.stop();
});

test("Ctrl connects via window.xfi.dogecoin request_accounts (registry API) + balance", async () => {
  const win = fakeWin({
    xfi: {
      dogecoin: {
        request: async ({ method }) => {
          assert.equal(method, "request_accounts");
          return [DOGE_ADDRESS];
        },
      },
    },
  });
  const provider = createDogecoinProviderAdapter({
    walletId: IDS.CTRL,
    win,
    balanceFetcher: async () => 1_234_567_890,
  });
  const result = await provider.connect();
  assert.equal(result.address, DOGE_ADDRESS);
  assert.equal(result.balance, 1_234_567_890);
  assert.equal(result.family, "dogecoin");
});

test("Ctrl accepts object-shaped accounts ({ address }) defensively", async () => {
  const win = fakeWin({ xfi: { dogecoin: { request: async () => [{ address: DOGE_ADDRESS }] } } });
  const provider = createDogecoinProviderAdapter({ walletId: IDS.CTRL, win });
  const result = await provider.connect();
  assert.equal(result.address, DOGE_ADDRESS);
});

test("Ctrl rejects when window.xfi.dogecoin is missing", async () => {
  const provider = createDogecoinProviderAdapter({ walletId: IDS.CTRL, win: {} });
  await assert.rejects(provider.connect(), /xfi\.dogecoin missing/);
});

test("firstDogeAddress unwraps strings and {address} objects", () => {
  assert.equal(firstDogeAddress([DOGE_ADDRESS]), DOGE_ADDRESS);
  assert.equal(firstDogeAddress([{ address: DOGE_ADDRESS }]), DOGE_ADDRESS);
  assert.equal(firstDogeAddress([]), undefined);
  assert.equal(firstDogeAddress(["", DOGE_ADDRESS]), DOGE_ADDRESS);
});

test("MyDoge: detection wired (window.doge) but connect rejects with the memo/verify TODO", async () => {
  const discovery = createDogecoinDiscovery({ win: fakeWin({ doge: {} }) });
  discovery.start();
  const provider = discovery.getProvider(IDS.MYDOGE);
  assert.ok(provider, "MyDoge resolves (detection key per the registry table)");
  await assert.rejects(provider.connect(), /not wired yet/);
  await assert.rejects(provider.connect(), /balance-only \+ deposit-address/);
});

test("DogeLabs: detection wired (window.dogeLabs) but connect rejects with the TODO", async () => {
  const discovery = createDogecoinDiscovery({ win: fakeWin({ dogeLabs: {} }) });
  discovery.start();
  const provider = discovery.getProvider(IDS.DOGELABS);
  assert.ok(provider, "DogeLabs resolves (detection key per the registry table)");
  await assert.rejects(provider.connect(), /not wired yet/);
});

test("⚠️ rows produce TODOs, not guessed connects (Enkrypt / OKX / Trust / Bitget)", async () => {
  const verifyRows = DOGECOIN_WALLETS.filter((e) => e.status === "verify");
  assert.ok(verifyRows.length >= 5, "all registry ⚠️ rows present");
  for (const entry of verifyRows) {
    assert.ok(
      typeof entry.todo === "string" && entry.todo.length > 0,
      `${entry.id} has a verification TODO (no guessed APIs)`,
    );
    const provider = createDogecoinProviderAdapter({ walletId: entry.id });
    assert.ok(provider, `${entry.id} still renders/resolves`);
    await assert.rejects(
      provider.connect(),
      /not wired yet/,
      `${entry.id} connect() rejects with its TODO instead of guessing`,
    );
  }
});

test("hardware and deposit-address rows are never connectable", async () => {
  for (const entry of DOGECOIN_WALLETS.filter((e) => e.hardware || e.depositAddress)) {
    const provider = createDogecoinProviderAdapter({ walletId: entry.id });
    assert.ok(provider, `${entry.id} resolves defensively`);
    await assert.rejects(provider.connect(), /not wired yet/);
  }
});

test("unknown wallet ids resolve to null (never a provider)", () => {
  assert.equal(createDogecoinProviderAdapter({ walletId: "monero-wallet" }), null);
});

test("memo rule metadata: Ctrl can send in-app; MyDoge/DogeLabs hand off (balance-only)", () => {
  const byId = new Map(DOGECOIN_WALLETS.map((e) => [e.id, e]));
  assert.equal(canSendInApp(byId.get(IDS.CTRL)), true, "Ctrl supports the OP_RETURN memo");
  assert.equal(canSendInApp(byId.get(IDS.MYDOGE)), false, "MyDoge memo unverified — balance-only + deposit-address");
  assert.equal(canSendInApp(byId.get(IDS.DOGELABS)), false);
  assert.equal(canSendInApp(byId.get(IDS.ENKRYPT)), false);
  assert.match(memoHandoffNote("dogecoin", byId.get(IDS.MYDOGE)), /OP_RETURN memo unverified/);
});
