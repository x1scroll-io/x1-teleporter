/**
 * Bitcoin provider-adapter tests (Step 2.3) — node:test, DI everywhere.
 *
 * The binding address rule from docs/WALLET-REGISTRY.md: ALWAYS the PAYMENT
 * address (bc1q native segwit, purpose "payment"), NEVER the ordinals /
 * taproot address (bc1p). The LaserEyes-covered adapters resolve the
 * payment address through the injected laserEyes handle (which, in the
 * browser, is laserEyesHandle.js reading the LaserEyes store's
 * `paymentAddress` — never `address`). These tests prove the adapters can
 * only ever produce a payment address, and that balance reads target it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBitcoinProviderAdapter, firstBtcAddress } from "./bitcoinDiscovery.js";
import { BITCOIN_WALLET_IDS as IDS, BITCOIN_WALLETS } from "./bitcoinRegistry.js";

const PAYMENT = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"; // native segwit (payment)
const ORDINALS = "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297"; // taproot (ordinals)

/** Fake LaserEyes handle — records the requested provider type. */
function fakeLaserEyes({ store = { paymentAddress: PAYMENT, address: ORDINALS, accounts: [PAYMENT] } } = {}) {
  const calls = [];
  return {
    calls,
    async connect(providerType) {
      calls.push(providerType);
      return store;
    },
    disconnect() {},
  };
}

const fakeBalanceFetcher = async () => 400_000;

/* ————————————— LaserEyes-covered wallets ————————————— */

test("payment-address rule: connect returns the bc1q payment address, NEVER the ordinals bc1p", async () => {
  const laserEyes = fakeLaserEyes();
  const provider = createBitcoinProviderAdapter({
    walletId: IDS.XVERSE,
    laserEyes,
    balanceFetcher: fakeBalanceFetcher,
  });

  assert.equal(provider.walletName, "Xverse");
  assert.equal(provider.isReal, true);
  assert.equal(laserEyes.calls.length, 0);

  const result = await provider.connect();
  assert.equal(laserEyes.calls.length, 1);
  assert.equal(laserEyes.calls[0], "xverse", "connects the Xverse LaserEyes provider");

  assert.equal(result.address, PAYMENT, "session address is the payment (bc1q) address");
  assert.notEqual(result.address, ORDINALS, "the ordinals (bc1p) address must never be used");
  assert.equal(result.address.startsWith("bc1q"), true);
  assert.equal(result.balance, 400_000, "balance read for the payment address");
  assert.equal(result.family, "bitcoin");
});

test("every ✅ LaserEyes-covered registry wallet maps to its own provider type", async () => {
  const expected = {
    [IDS.XVERSE]: "xverse",
    [IDS.UNISAT]: "unisat",
    [IDS.LEATHER]: "leather",
    [IDS.OKX]: "okx",
    [IDS.PHANTOM]: "phantom",
    [IDS.WIZZ]: "wizz",
    [IDS.OYL]: "oyl",
    [IDS.ORANGE]: "orange",
  };
  for (const [walletId, providerType] of Object.entries(expected)) {
    const laserEyes = fakeLaserEyes();
    const provider = createBitcoinProviderAdapter({ walletId, laserEyes, balanceFetcher: fakeBalanceFetcher });
    assert.ok(provider, `${walletId} resolves a provider`);
    const result = await provider.connect();
    assert.equal(laserEyes.calls[0], providerType, `${walletId} → ${providerType}`);
    assert.equal(result.address, PAYMENT);
  }
});

test("⚠️ LaserEyes-covered rows (Magic Eden, OP_NET) stay behind their verify TODO", async () => {
  // LaserEyes ships providers for these, but the registry marks them ⚠️
  // (ME: verify still shipping; OP_NET: niche) — connect rejects with the
  // TODO until verified in a real browser. No guessed shipping.
  for (const walletId of [IDS.MAGIC_EDEN, IDS.OP_NET]) {
    const provider = createBitcoinProviderAdapter({
      walletId,
      laserEyes: fakeLaserEyes(),
      balanceFetcher: fakeBalanceFetcher,
    });
    assert.ok(provider, `${walletId} still renders`);
    await assert.rejects(provider.connect(), /not wired yet/);
  }
});

test("payment-address rule: no payment address → connect REJECTS (never falls back to ordinals)", async () => {
  // A store that only has the ordinals address — the adapter must refuse.
  const laserEyes = fakeLaserEyes({ store: { address: ORDINALS, accounts: [ORDINALS] } });
  const provider = createBitcoinProviderAdapter({
    walletId: IDS.PHANTOM,
    laserEyes,
    balanceFetcher: fakeBalanceFetcher,
  });
  await assert.rejects(provider.connect(), /no payment address/i);
});

test("payment-address rule: balance is fetched for the payment address, not the ordinals", async () => {
  const fetchedFor = [];
  const balanceFetcher = async (address) => {
    fetchedFor.push(address);
    return 999;
  };
  const provider = createBitcoinProviderAdapter({
    walletId: IDS.UNISAT,
    laserEyes: fakeLaserEyes(),
    balanceFetcher,
  });
  const result = await provider.connect();
  assert.equal(result.balance, 999);
  assert.deepEqual(fetchedFor, [PAYMENT]);
});

test("a missing laserEyes handle is a hard error (never a silent mock connect)", async () => {
  const provider = createBitcoinProviderAdapter({ walletId: IDS.XVERSE, laserEyes: null });
  await assert.rejects(provider.connect(), /LaserEyes handle is not wired/);
});

test("disconnect releases the LaserEyes session", async () => {
  let disconnected = 0;
  const laserEyes = { connect: async () => ({ paymentAddress: PAYMENT }), disconnect: () => { disconnected += 1; } };
  const provider = createBitcoinProviderAdapter({ walletId: IDS.OKX, laserEyes });
  await provider.disconnect();
  assert.equal(disconnected, 1);
});

/* ————————————— Non-LaserEyes wallets (per-table adapters) ————————————— */

test("Bitget connects via window.bitkeep.unisat (Unisat-compatible), never the bare injected global", async () => {
  const win = { bitkeep: { unisat: { requestAccounts: async () => [PAYMENT] } } };
  const provider = createBitcoinProviderAdapter({
    walletId: IDS.BITGET,
    win,
    balanceFetcher: fakeBalanceFetcher,
  });
  assert.equal(provider.walletName, "Bitget Wallet");
  const result = await provider.connect();
  assert.equal(result.address, PAYMENT);
  assert.equal(result.balance, 400_000);
});

test("Bitget rejects when window.bitkeep.unisat is missing", async () => {
  const provider = createBitcoinProviderAdapter({ walletId: IDS.BITGET, win: {} });
  await assert.rejects(provider.connect(), /bitkeep\.unisat missing/);
});

test("Ctrl connects via window.xfi.bitcoin request_accounts (registry API)", async () => {
  const win = { xfi: { bitcoin: { request: async ({ method }) => {
    assert.equal(method, "request_accounts");
    return [PAYMENT];
  } } } };
  const provider = createBitcoinProviderAdapter({ walletId: IDS.CTRL, win, balanceFetcher: fakeBalanceFetcher });
  const result = await provider.connect();
  assert.equal(result.address, PAYMENT);
  assert.equal(result.balance, 400_000);
});

test("Ctrl accepts object-shaped accounts ({ address }) defensively", async () => {
  const win = { xfi: { bitcoin: { request: async () => [{ address: PAYMENT, publicKey: "x" }] } } };
  const provider = createBitcoinProviderAdapter({ walletId: IDS.CTRL, win });
  const result = await provider.connect();
  assert.equal(result.address, PAYMENT);
});

test("Ctrl rejects when window.xfi.bitcoin is missing", async () => {
  const provider = createBitcoinProviderAdapter({ walletId: IDS.CTRL, win: {} });
  await assert.rejects(provider.connect(), /xfi\.bitcoin missing/);
});

test("firstBtcAddress unwraps strings and {address} objects", () => {
  assert.equal(firstBtcAddress([PAYMENT]), PAYMENT);
  assert.equal(firstBtcAddress([{ address: PAYMENT }]), PAYMENT);
  assert.equal(firstBtcAddress([]), undefined);
  assert.equal(firstBtcAddress(undefined), undefined);
  assert.equal(firstBtcAddress(["", PAYMENT]), PAYMENT, "skips empty entries");
});

/* ————————————— ⚠️ rows: TODOs, not guesses ————————————— */

test("⚠️ rows produce TODOs, not guessed connects (Magic Eden / Coinbase / Enkrypt / Keplr / Leap / Trust / OP_NET)", async () => {
  const verifyRows = BITCOIN_WALLETS.filter((e) => e.status === "verify");
  assert.ok(verifyRows.length >= 6, "all registry ⚠️ rows present");
  for (const entry of verifyRows) {
    // Every ⚠️ row must carry an explicit todo note naming what to verify.
    assert.ok(
      typeof entry.todo === "string" && entry.todo.length > 0,
      `${entry.id} has a verification TODO (no guessed APIs)`,
    );
    const provider = createBitcoinProviderAdapter({ walletId: entry.id });
    assert.ok(provider, `${entry.id} still renders/resolves`);
    await assert.rejects(
      provider.connect(),
      /not wired yet/,
      `${entry.id} connect() rejects with its TODO instead of guessing`,
    );
  }
});

test("hardware and deposit-address rows are never connectable", async () => {
  for (const entry of BITCOIN_WALLETS.filter((e) => e.hardware || e.depositAddress)) {
    const provider = createBitcoinProviderAdapter({ walletId: entry.id });
    assert.ok(provider, `${entry.id} resolves defensively`);
    await assert.rejects(provider.connect(), /not wired yet/);
  }
});

test("unknown wallet ids resolve to null (never a provider)", () => {
  assert.equal(createBitcoinProviderAdapter({ walletId: "monero-wallet" }), null);
});
