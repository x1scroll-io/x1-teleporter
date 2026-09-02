/**
 * lifiSolanaTx.test.js — regression tests for the reverse-leg submit bug.
 *
 * THE BUG (pinned): the reverse leg ALWAYS broke at the LiFi hop (WSOL on
 * Solana → USDC on ETH) with "Connect your Solana/X1 wallet to sign" — the
 * LiFi tx was never built or submitted. Root cause: a wallet-provider SHAPE
 * mismatch. The v2 session's `provider` is the CONNECT WRAPPER
 * (createSolanaProviderAdapter → `{ family, id, isReal, walletName, adapter,
 * connect, disconnect }`) — the sign functions live at `provider.adapter`
 * (the Wallet Standard adapter). executeLiFiSolanaTx read the RAW provider
 * shape (`solWallet?.provider`) and checked it for sign fns, which ALWAYS
 * failed on a real session — and even failed on the form's ALREADY-RESOLVED
 * adapter (passed as `solWallet`, which has no `.provider` property at all,
 * so the old code resolved `sol` to null). Stage 1 (the burn) worked because
 * it resolves through resolveSolanaAdapter, which unwraps `.adapter`;
 * stage 2 (LiFi) did not.
 *
 * These tests pin the fixed behavior: the LiFi path resolves the signer
 * through the SAME resolver as stage 1 (resolveSolanaAdapter), accepts the
 * already-resolved adapter shape, and preserves the honest error when
 * nothing can sign.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, MessageV0, VersionedTransaction } from "@solana/web3.js";

import { executeLiFiSolanaTx, resolveSolSigner } from "./lifiSolanaTx.js";
import { resolveSolanaAdapter } from "./wallet/sessionProviders.js";

/** A real, offline-deserializable Solana tx payload (any blockhash works). */
function makeB64Tx() {
  const compiled = MessageV0.compile({
    payerKey: Keypair.generate().publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  });
  return Buffer.from(new VersionedTransaction(compiled).serialize()).toString("base64");
}

const B64 = makeB64Tx();

/** A minimal LI.Fi quote carrying the executable Solana tx (no proxy fetch). */
function makeQuote() {
  return { transactionRequest: { data: B64 } };
}

/** Pre-send simulation override: always passes (Step 1.3A gate satisfied). */
const simOk = async () => ({ ok: true, logs: [], unitsConsumed: 0 });

/** The v2 CONNECT WRAPPER shape (createSolanaProviderAdapter output). */
function makeWrapper(adapter) {
  return {
    family: "solana",
    id: `wallet-standard:${adapter.name || "test"}`,
    isReal: true,
    walletName: adapter.name || "Test Wallet",
    adapter,
    async connect() {
      await adapter.connect?.();
      return { family: "solana", address: "mock-address", provider: this };
    },
    async disconnect() {},
  };
}

/** A Wallet Standard adapter (sign fns live here, NOT on the wrapper). */
function makeAdapter({ name = "Test Wallet", signAndSend = true } = {}) {
  const calls = { signAndSendTransaction: 0, signTransaction: 0 };
  const adapter = {
    name,
    publicKey: { toBase58: () => "mock-pubkey" },
    async connect() {},
    async signAndSendTransaction() {
      calls.signAndSendTransaction += 1;
      return { signature: "adapter-sign-and-send-sig" };
    },
    async signTransaction() {
      calls.signTransaction += 1;
      return { serialize: () => new Uint8Array(0) };
    },
  };
  if (!signAndSend) delete adapter.signAndSendTransaction;
  return { adapter, calls };
}

// ── THE REGRESSION: wrapper-shape session must reach the adapter's sign fn ──

test("reverse stage 2: wrapper-shape session → LiFi execute uses adapter.signAndSendTransaction (no 'Connect your Solana/X1 wallet to sign')", async () => {
  const { adapter, calls } = makeAdapter();
  // The v2 WalletContext session: { family, address, provider: WRAPPER }.
  const session = { family: "solana", address: "mock-address", provider: makeWrapper(adapter) };

  const sig = await executeLiFiSolanaTx({
    lifiData: makeQuote(),
    solWallet: session,
    simulate: simOk,
  });

  assert.equal(sig, "adapter-sign-and-send-sig");
  assert.equal(calls.signAndSendTransaction, 1);
  assert.equal(calls.signTransaction, 0);
});

test("reverse stage 2: form passes the ALREADY-RESOLVED adapter (defaultReverseStage2Runner shape) → signs directly, no throw", async () => {
  const { adapter, calls } = makeAdapter();
  // defaultReverseStage2Runner passes `solWallet: solAdapter` where solAdapter
  // is the resolveSolanaAdapter output — the raw adapter, NO `.provider` key.
  // The old code read `solWallet?.provider` → null → threw the honest error
  // even though a perfectly good adapter was right there.
  const sig = await executeLiFiSolanaTx({
    lifiData: makeQuote(),
    solWallet: adapter,
    simulate: simOk,
  });

  assert.equal(sig, "adapter-sign-and-send-sig");
  assert.equal(calls.signAndSendTransaction, 1);
});

test("reverse stage 2: v1 session with a legacy injected provider (sign fns at provider top level) → signs via that provider", async () => {
  const { adapter, calls } = makeAdapter();
  // v1 Teleporter.jsx solWallet: { addr, provider: <legacy injected wallet> }.
  const legacyWallet = { addr: "mock-address", provider: adapter, label: "Phantom" };

  const sig = await executeLiFiSolanaTx({
    lifiData: makeQuote(),
    solWallet: legacyWallet,
    simulate: simOk,
  });

  assert.equal(sig, "adapter-sign-and-send-sig");
  assert.equal(calls.signAndSendTransaction, 1);
});

test("reverse stage 2: listSolProviders fallback entry ({ key, label, provider: wrapper }) → unwraps and signs", async () => {
  const { adapter, calls } = makeAdapter();
  const wrapper = makeWrapper(adapter);

  const sig = await executeLiFiSolanaTx({
    lifiData: makeQuote(),
    solWallet: null,
    listSolProviders: () => [{ key: "testwallet", label: "Test Wallet", provider: wrapper }],
    simulate: simOk,
  });

  assert.equal(sig, "adapter-sign-and-send-sig");
  assert.equal(calls.signAndSendTransaction, 1);
});

// ── The honest error is preserved when nothing can sign ──

test("reverse stage 2: wrapper WITHOUT an adapter → still throws 'Connect your Solana/X1 wallet to sign'", async () => {
  const wrapper = makeWrapper({ name: "Broken Wallet" }); // no sign fns, no adapter
  const session = { family: "solana", address: "mock-address", provider: wrapper };

  await assert.rejects(
    () => executeLiFiSolanaTx({ lifiData: makeQuote(), solWallet: session, simulate: simOk }),
    { message: "Connect your Solana/X1 wallet to sign" },
  );
});

test("reverse stage 2: no wallet at all → still throws the honest error", async () => {
  await assert.rejects(
    () => executeLiFiSolanaTx({ lifiData: makeQuote(), solWallet: null, simulate: simOk }),
    { message: "Connect your Solana/X1 wallet to sign" },
  );
});

// ── Consistency: stage 1 + stage 2 resolve through the SAME resolver ──

test("consistency: resolveSolSigner (stage 2) returns the SAME adapter as resolveSolanaAdapter (stage 1) for a wrapper session", async () => {
  const { adapter } = makeAdapter();
  const session = { family: "solana", address: "mock-address", provider: makeWrapper(adapter) };

  const stage1 = await resolveSolanaAdapter(session); // the proven stage-1 resolver
  const stage2 = await resolveSolSigner(session, null); // the LiFi-path resolver

  assert.equal(stage1, adapter);
  assert.equal(stage2, adapter);
  assert.equal(stage1, stage2);
});

test("consistency: resolveSolSigner passes a raw adapter through unchanged (form path)", async () => {
  const { adapter } = makeAdapter();
  assert.equal(await resolveSolSigner(adapter, null), adapter);
});

test("consistency: resolveSolSigner returns null when nothing can sign (same as resolveSolanaAdapter)", async () => {
  const wrapper = makeWrapper({ name: "Broken Wallet" });
  const session = { family: "solana", address: "mock-address", provider: wrapper };
  assert.equal(await resolveSolanaAdapter(session), null);
  assert.equal(await resolveSolSigner(session, null), null);
  assert.equal(await resolveSolSigner(null, null), null);
});
