/**
 * Litecoin discovery tests (Step 2.4) — node:test, fully injected (fake
 * window objects). Proves the registry's namespaced-global detection
 * (window.xfi.litecoin → Ctrl, window.litescribe → Litescribe), the Ctrl
 * connect adapter (request_accounts on the xfi.litecoin surface), and the
 * TODO-gating of every unverified row (no guessed APIs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLitecoinDiscovery,
  createLitecoinProviderAdapter,
  enumerateGlobalWallets,
  firstLtcAddress,
} from "./litecoinDiscovery.js";
import {
  LITECOIN_WALLETS,
  LITECOIN_WALLET_IDS as IDS,
} from "./litecoinRegistry.js";
import { canSendInApp } from "./memoRule.js";

const LTC_ADDRESS = "LbTjMGN7gELw4KbeyQf6cTCq859hD18guE";

/** Fake window carrying only the namespaced globals it is given. */
const fakeWin = (globals = {}) => globals;

const keys = (wallets) => wallets.map((w) => w.key).sort();

test("global: every registry namespaced detection key maps to its wallet", () => {
  const win = fakeWin({ xfi: { litecoin: {} }, litescribe: {} });
  assert.deepEqual(keys(enumerateGlobalWallets(win)), [IDS.CTRL, IDS.LITESCRIBE]);
  assert.ok(enumerateGlobalWallets(win).every((w) => w.source === "global"));
});

test("global: a missing namespace never throws (defensive access)", () => {
  assert.deepEqual(enumerateGlobalWallets(fakeWin({ xfi: {} })), []);
  assert.deepEqual(enumerateGlobalWallets(fakeWin({})), []);
  assert.deepEqual(enumerateGlobalWallets(undefined), []);
});

test("global: the ⚠️ rows with no documented key are never detected via globals", () => {
  // Enkrypt/OKX/Trust have detection "todo" — no key guessed.
  const win = fakeWin({ enkrypt: {}, okxwallet: {}, trustwallet: {} });
  assert.deepEqual(enumerateGlobalWallets(win), []);
});

test("the handle enumerates, snapshots and resolves providers", () => {
  const seen = [];
  const discovery = createLitecoinDiscovery({
    win: fakeWin({ xfi: { litecoin: {} } }),
    onChange: (w) => seen.push(w),
  });
  discovery.start();

  assert.deepEqual(keys(discovery.getInstalled()), [IDS.CTRL]);
  assert.equal(seen.length, 1, "initial snapshot emitted");

  const provider = discovery.getProvider(IDS.CTRL);
  assert.ok(provider, "installed wallet resolves a provider");
  assert.equal(provider.walletName, "Ctrl (ex-XDEFI)");

  assert.equal(discovery.getProvider(IDS.LITESCRIBE), null, "not installed → null (mock fallback)");
  discovery.stop();
});

test("Ctrl connects via window.xfi.litecoin request_accounts (registry API) + balance", async () => {
  const win = fakeWin({
    xfi: {
      litecoin: {
        request: async ({ method }) => {
          assert.equal(method, "request_accounts");
          return [LTC_ADDRESS];
        },
      },
    },
  });
  const provider = createLitecoinProviderAdapter({
    walletId: IDS.CTRL,
    win,
    balanceFetcher: async () => 82_430_950,
  });
  const result = await provider.connect();
  assert.equal(result.address, LTC_ADDRESS);
  assert.equal(result.balance, 82_430_950);
  assert.equal(result.family, "litecoin");
});

test("Ctrl accepts object-shaped accounts ({ address }) defensively", async () => {
  const win = fakeWin({ xfi: { litecoin: { request: async () => [{ address: LTC_ADDRESS }] } } });
  const provider = createLitecoinProviderAdapter({ walletId: IDS.CTRL, win });
  const result = await provider.connect();
  assert.equal(result.address, LTC_ADDRESS);
});

test("Ctrl rejects when window.xfi.litecoin is missing", async () => {
  const provider = createLitecoinProviderAdapter({ walletId: IDS.CTRL, win: {} });
  await assert.rejects(provider.connect(), /xfi\.litecoin missing/);
});

test("firstLtcAddress unwraps strings and {address} objects", () => {
  assert.equal(firstLtcAddress([LTC_ADDRESS]), LTC_ADDRESS);
  assert.equal(firstLtcAddress([{ address: LTC_ADDRESS }]), LTC_ADDRESS);
  assert.equal(firstLtcAddress([]), undefined);
  assert.equal(firstLtcAddress(undefined), undefined);
  assert.equal(firstLtcAddress(["", LTC_ADDRESS]), LTC_ADDRESS, "skips empty entries");
});

test("Litescribe: installed rows resolve a provider, but connect rejects with the memo/API TODO", async () => {
  const discovery = createLitecoinDiscovery({ win: fakeWin({ litescribe: {} }) });
  discovery.start();
  const provider = discovery.getProvider(IDS.LITESCRIBE);
  assert.ok(provider, "Litescribe resolves (detection wired per the registry key)");
  await assert.rejects(provider.connect(), /not wired yet/);
  await assert.rejects(provider.connect(), /OP_RETURN memo support/);
});

test("⚠️ rows produce TODOs, not guessed connects (Enkrypt / OKX / Trust)", async () => {
  const verifyRows = LITECOIN_WALLETS.filter((e) => e.status === "verify");
  assert.ok(verifyRows.length >= 3, "all registry ⚠️ rows present");
  for (const entry of verifyRows) {
    assert.ok(
      typeof entry.todo === "string" && entry.todo.length > 0,
      `${entry.id} has a verification TODO (no guessed APIs)`,
    );
    const provider = createLitecoinProviderAdapter({ walletId: entry.id });
    assert.ok(provider, `${entry.id} still renders/resolves`);
    await assert.rejects(
      provider.connect(),
      /not wired yet/,
      `${entry.id} connect() rejects with its TODO instead of guessing`,
    );
  }
});

test("hardware and deposit-address rows are never connectable", async () => {
  for (const entry of LITECOIN_WALLETS.filter((e) => e.hardware || e.depositAddress)) {
    const provider = createLitecoinProviderAdapter({ walletId: entry.id });
    assert.ok(provider, `${entry.id} resolves defensively`);
    await assert.rejects(provider.connect(), /not wired yet/);
  }
});

test("unknown wallet ids resolve to null (never a provider)", () => {
  assert.equal(createLitecoinProviderAdapter({ walletId: "monero-wallet" }), null);
});

test("memo rule metadata: Ctrl can send in-app; every other row hands off", () => {
  const byId = new Map(LITECOIN_WALLETS.map((e) => [e.id, e]));
  assert.equal(canSendInApp(byId.get(IDS.CTRL)), true, "Ctrl supports the OP_RETURN memo");
  assert.equal(canSendInApp(byId.get(IDS.LITESCRIBE)), false, "Litescribe memo unverified");
  assert.equal(canSendInApp(byId.get(IDS.ENKRYPT)), false);
  assert.equal(canSendInApp(byId.get(IDS.OKX)), false);
  assert.equal(canSendInApp(byId.get(IDS.TRUST)), false);
  assert.equal(canSendInApp(byId.get(IDS.DEPOSIT_ADDRESS)), true, "the deposit path supports OP_RETURN memos");
});
