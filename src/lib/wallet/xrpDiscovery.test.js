/**
 * XRP discovery tests (Step 2.4) — node:test, fully injected (fake window
 * objects). Proves the registry's detection (Crossmark via
 * window.xrpl.crossmark — the only documented XRP browser global), the
 * unmaintained ❌ treatment (Crossmark / GemWallet: connect rejects with
 * the unmaintained note), and the TODO-gating of every other row (Xaman
 * PRIMARY, Joey / Bifrost ⚠️, Ledger / Trezor hardware, Tangem
 * deposit-only) — no guessed APIs, no fake connects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createXrpDiscovery,
  createXrpProviderAdapter,
  enumerateGlobalWallets,
} from "./xrpDiscovery.js";
import {
  XRP_WALLETS,
  XRP_WALLET_IDS as IDS,
} from "./xrpRegistry.js";
import { canSendInApp, memoHandoffNote } from "./memoRule.js";

/** Fake window carrying only the namespaced globals it is given. */
const fakeWin = (globals = {}) => globals;

test("global: Crossmark is detected via window.xrpl.crossmark (the registry key)", () => {
  const win = fakeWin({ xrpl: { crossmark: {} } });
  const wallets = enumerateGlobalWallets(win);
  assert.deepEqual(wallets.map((w) => w.key), [IDS.CROSSMARK]);
  assert.equal(wallets[0].source, "global");
});

test("global: GemWallet has NO documented global — never detected via a guessed key", () => {
  // GemWallet's API is the @gemwallet/api SDK; no namespaced global is
  // documented in the registry — no detection key is guessed.
  const win = fakeWin({ gemwallet: {} });
  assert.deepEqual(enumerateGlobalWallets(win), []);
});

test("global: missing namespaces never throw", () => {
  assert.deepEqual(enumerateGlobalWallets(fakeWin({})), []);
  assert.deepEqual(enumerateGlobalWallets(fakeWin({ xrpl: {} })), []);
  assert.deepEqual(enumerateGlobalWallets(undefined), []);
});

test("the handle enumerates only installed rows; everything else resolves null", () => {
  const discovery = createXrpDiscovery({ win: fakeWin({ xrpl: { crossmark: {} } }) });
  discovery.start();
  assert.deepEqual(discovery.getInstalled().map((w) => w.key), [IDS.CROSSMARK]);

  assert.ok(discovery.getProvider(IDS.CROSSMARK), "installed Crossmark resolves a provider");
  assert.equal(discovery.getProvider(IDS.XAMAN), null, "Xaman is mobile — not installed via globals");
  assert.equal(discovery.getProvider(IDS.GEMWALLET), null);
});

test("Xaman (PRIMARY): connect rejects with the xumm SDK + WalletConnect-verification TODO", async () => {
  const provider = createXrpProviderAdapter({ walletId: IDS.XAMAN });
  assert.ok(provider, "Xaman still renders/resolves");
  assert.equal(provider.walletName, "Xaman (ex-XUMM)");
  await assert.rejects(provider.connect(), /not wired yet/);
  await assert.rejects(provider.connect(), /xumm-sdk/);
  await assert.rejects(provider.connect(), /WalletConnect support in the current version/);
});

test("❌ Crossmark and GemWallet: connect rejects with the unmaintained note (no SDK guessed)", async () => {
  for (const walletId of [IDS.CROSSMARK, IDS.GEMWALLET]) {
    const entry = XRP_WALLETS.find((e) => e.id === walletId);
    assert.equal(entry.unmaintained, true, `${walletId} is flagged unmaintained`);
    assert.equal(entry.status, "unmaintained", `${walletId} status is unmaintained`);
    assert.ok(entry.todo.includes("unmaintained"), `${walletId} carries the unmaintained TODO`);

    const provider = createXrpProviderAdapter({ walletId });
    assert.ok(provider, `${walletId} still renders`);
    await assert.rejects(provider.connect(), /not wired yet/);
    await assert.rejects(provider.connect(), /unmaintained/);
  }
});

test("⚠️ rows (Joey / Bifrost) reject with their WalletConnect-verification TODOs", async () => {
  for (const walletId of [IDS.JOEY, IDS.BIFROST]) {
    const entry = XRP_WALLETS.find((e) => e.id === walletId);
    assert.equal(entry.status, "verify", `${walletId} is a ⚠️ row`);
    assert.ok(entry.todo.length > 0, `${walletId} has a TODO`);

    const provider = createXrpProviderAdapter({ walletId });
    await assert.rejects(provider.connect(), /not wired yet/);
    await assert.rejects(provider.connect(), /WalletConnect/);
  }
});

test("hardware (Ledger / Trezor), Tangem and the deposit row are never connectable", async () => {
  for (const entry of XRP_WALLETS.filter(
    (e) => e.hardware || e.depositAddress || e.depositOnly,
  )) {
    const provider = createXrpProviderAdapter({ walletId: entry.id });
    assert.ok(provider, `${entry.id} resolves defensively`);
    await assert.rejects(provider.connect(), /not wired yet/);
  }

  const tangem = XRP_WALLETS.find((e) => e.id === IDS.TANGEM);
  assert.equal(tangem.depositOnly, true, "Tangem is deposit-address only (registry: not a dApp connector)");
  assert.equal(tangem.status, "ok");
});

test("unknown wallet ids resolve to null (never a provider)", () => {
  assert.equal(createXrpProviderAdapter({ walletId: "monero-wallet" }), null);
});

test("memo rule metadata: Xaman can send in-app (XRPL Memos); the rest hand off", () => {
  const byId = new Map(XRP_WALLETS.map((e) => [e.id, e]));
  assert.equal(canSendInApp(byId.get(IDS.XAMAN)), true, "Xaman payload includes Memos");
  assert.equal(canSendInApp(byId.get(IDS.DEPOSIT_ADDRESS)), true, "the deposit path carries the XRPL Memos field");
  assert.equal(canSendInApp(byId.get(IDS.JOEY)), false);
  assert.equal(canSendInApp(byId.get(IDS.BIFROST)), false);
  assert.equal(canSendInApp(byId.get(IDS.TANGEM)), false, "Tangem: deposit-address only");
  assert.match(memoHandoffNote("xrp", byId.get(IDS.BIFROST)), /XRPL Memos support unverified/);
});
