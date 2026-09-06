/**
 * sdkBitcoin.test.js — import smoke test for the grabbed official bitcoinjs
 * readiness module (src/lib/sdk/sdkBitcoin.js). Offline: the SDK resolves
 * with the pinned export surface, and real p2wpkh derivation + PSBT
 * construction execute (no network, no funds).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  btcAddressFromPubkey,
  buildPayment,
  loadBitcoinSdk,
  newPsbt,
} from "./sdkBitcoin.js";

// The secp256k1 generator point as a compressed pubkey — valid, fixed,
// offline. (Deriving an address from it never spends anything.)
const PUBKEY = Buffer.from(
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "hex",
);

test("sdkBitcoin: official bitcoinjs-lib resolves with the pinned export surface", async () => {
  const ns = await loadBitcoinSdk();
  assert.equal(typeof ns.Psbt, "function");
  assert.equal(typeof ns.payments, "object");
  assert.equal(typeof ns.networks, "object");
});

test("sdkBitcoin: wrapper functions exist (future-leg surface)", () => {
  assert.equal(typeof buildPayment, "function");
  assert.equal(typeof newPsbt, "function");
  assert.equal(typeof btcAddressFromPubkey, "function");
});

test("sdkBitcoin: p2wpkh derivation executes offline (bc1q… address)", async () => {
  const payment = await buildPayment({ pubkey: PUBKEY, networkName: "bitcoin" });
  assert.match(payment.address, /^bc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/);
  assert.ok(payment.output instanceof Uint8Array, "p2wpkh output bytes");
  const viaHelper = await btcAddressFromPubkey({ pubkey: PUBKEY, networkName: "bitcoin" });
  assert.equal(viaHelper, payment.address);
});

test("sdkBitcoin: testnet network maps to tb1q…", async () => {
  const payment = await buildPayment({ pubkey: PUBKEY, networkName: "testnet" });
  assert.match(payment.address, /^tb1q/);
});

test("sdkBitcoin: PSBT construction executes offline", async () => {
  const psbt = await newPsbt({ networkName: "bitcoin" });
  assert.equal(typeof psbt.addInput, "function");
  assert.equal(typeof psbt.addOutput, "function");
});
