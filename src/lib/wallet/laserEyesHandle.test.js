/**
 * LaserEyes integration smoke tests (Step 2.3) — jsdom + the REAL
 * @omnisat/lasereyes package (the registry-mandated library).
 *
 * These pin the exact integration points our wallet layer depends on, so a
 * LaserEyes version bump that breaks the contract fails CI:
 *   1. createStores() produces the store fields we read (paymentAddress /
 *      address / accounts).
 *   2. The LaserEyesClient constructs in a browser-like env.
 *   3. The provider-type constants match the strings bitcoinRegistry.js
 *      uses as `laserEyesProvider`.
 *   4. extractPaymentSession (laserEyesHandle.js) reads ONLY the payment
 *      address from a real store snapshot and refuses to fall back to the
 *      ordinals address.
 *
 * NOT tested here (could-not-test): the actual wallet handshake
 * (client.connect(providerType) needs a real extension in a real browser —
 * operator preview check). node:test never constructs the client's connect
 * path; the wallet layer injects a fake laserEyes handle.
 */

import { JSDOM } from "jsdom";

// jsdom globals must exist BEFORE @omnisat/lasereyes is imported.
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
import {
  LaserEyesClient,
  createStores,
  XVERSE,
  UNISAT,
  LEATHER,
  OKX,
  PHANTOM,
  MAGIC_EDEN,
  WIZZ,
  OYL,
  ORANGE,
  OP_NET,
} from "@omnisat/lasereyes";
import { extractPaymentSession } from "./laserEyesHandle.js";
import { BITCOIN_WALLET_IDS as IDS, BITCOIN_WALLETS } from "./bitcoinRegistry.js";

const PAYMENT = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const ORDINALS = "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";

test("createStores() exposes the exact store fields the wallet layer reads", () => {
  const stores = createStores();
  const value = stores.$store.get();
  assert.equal(typeof value.paymentAddress, "string", "paymentAddress field exists");
  assert.equal(typeof value.address, "string", "address (ordinals) field exists");
  assert.ok(Array.isArray(value.accounts), "accounts array exists");
});

test("the real LaserEyesClient constructs in a browser-like environment", () => {
  const client = new LaserEyesClient(createStores());
  assert.ok(client.$store, "store map attached");
  assert.ok(client.$providerMap, "per-wallet provider map attached");
  assert.ok(Object.keys(client.$providerMap).length >= 10, "one provider per registry wallet");
  client.dispose();
});

test("provider-type constants match bitcoinRegistry.js laserEyesProvider strings", () => {
  // Guards against a LaserEyes version bump renaming provider types.
  const byWallet = {
    [IDS.XVERSE]: XVERSE,
    [IDS.UNISAT]: UNISAT,
    [IDS.LEATHER]: LEATHER,
    [IDS.OKX]: OKX,
    [IDS.PHANTOM]: PHANTOM,
    [IDS.MAGIC_EDEN]: MAGIC_EDEN,
    [IDS.WIZZ]: WIZZ,
    [IDS.OYL]: OYL,
    [IDS.ORANGE]: ORANGE,
    [IDS.OP_NET]: OP_NET,
  };
  for (const [walletId, constant] of Object.entries(byWallet)) {
    const entry = BITCOIN_WALLETS.find((e) => e.id === walletId);
    assert.ok(entry, `${walletId} is in the registry`);
    assert.equal(
      entry.laserEyesProvider,
      constant,
      `${walletId} registry provider string matches the LaserEyes constant`,
    );
  }
});

test("extractPaymentSession reads ONLY the payment address from a real store snapshot", () => {
  const stores = createStores();
  stores.$store.set({
    ...stores.$store.get(),
    address: ORDINALS,
    paymentAddress: PAYMENT,
    accounts: [PAYMENT],
  });
  const session = extractPaymentSession(stores.$store.get());
  assert.equal(session.paymentAddress, PAYMENT);
  assert.equal(session.ordinalsAddress, ORDINALS, "ordinals exposed but never used as the session address");
  assert.deepEqual(session.accounts, [PAYMENT]);
});

test("extractPaymentSession rejects a store with ONLY an ordinals address", () => {
  const stores = createStores();
  stores.$store.set({ ...stores.$store.get(), address: ORDINALS, paymentAddress: "" });
  assert.throws(() => extractPaymentSession(stores.$store.get()), /no payment address/i);
});

test("extractPaymentSession rejects an empty store (pre-connect)", () => {
  assert.throws(() => extractPaymentSession(createStores().$store.get()), /no payment address/i);
  assert.throws(() => extractPaymentSession(undefined), /no payment address/i);
});
