/**
 * sessionProviders.test.js — resolve sign-capable providers from
 * WalletContext sessions (Phase 3 bridge form wiring).
 *
 * The v2 wallet layer's session.provider is the CONNECT adapter
 * ({ connect, disconnect }), not a signing surface. The bridge form resolves
 * the real thing:
 *   EVM    — an EIP-1193 provider with request(); the real adapter wraps the
 *            discovered EIP-6963 wagmi connector at discovered.provider
 *            (getProvider() → EIP-1193). Raw request() providers pass through.
 *   Solana — the Wallet Standard adapter with signAndSendTransaction /
 *            signTransaction (+ publicKey); the real session provider wraps
 *            it at provider.adapter.
 * Null when the session can't sign (mock providers resolve to null by
 * design) — the caller surfaces an honest connect prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEvmProvider, resolveSolanaAdapter } from "./sessionProviders.js";

// ── EVM ────────────────────────────────────────────────────────────────────

test("resolveEvmProvider: raw EIP-1193 provider (request) passes through", async () => {
  const p = { request: async () => "0x" };
  assert.equal(await resolveEvmProvider({ provider: p }), p);
});

test("resolveEvmProvider: real adapter shape — discovered wagmi connector resolves via getProvider", async () => {
  const eip1193 = { request: async () => "0x" };
  const session = {
    provider: {
      family: "evm",
      discovered: { provider: { getProvider: async () => eip1193 } },
    },
  };
  assert.equal(await resolveEvmProvider(session), eip1193);
});

test("resolveEvmProvider: getProvider failure or non-provider result → null", async () => {
  const session = {
    provider: { discovered: { provider: { getProvider: async () => { throw new Error("connector gone"); } } } },
  };
  assert.equal(await resolveEvmProvider(session), null);
  const session2 = { provider: { discovered: { provider: { getProvider: async () => ({}) } } } };
  assert.equal(await resolveEvmProvider(session2), null, "a getProvider result without request() can't sign");
});

test("resolveEvmProvider: no signing surface → null (mock providers by design)", async () => {
  assert.equal(await resolveEvmProvider(null), null);
  assert.equal(await resolveEvmProvider({}), null);
  assert.equal(await resolveEvmProvider({ provider: {} }), null);
  assert.equal(await resolveEvmProvider({ provider: { discovered: {} } }), null);
  assert.equal(await resolveEvmProvider({ provider: { isMock: true, connect: async () => {} } }), null);
});

// ── Solana ─────────────────────────────────────────────────────────────────

test("resolveSolanaAdapter: real adapter shape — Wallet Standard adapter behind provider.adapter wins", async () => {
  const adapter = { publicKey: {}, signAndSendTransaction: async () => ({}) };
  const session = { provider: { family: "solana", adapter, connect: async () => {} } };
  assert.equal(await resolveSolanaAdapter(session), adapter);
});

test("resolveSolanaAdapter: raw provider with sign methods passes through", async () => {
  const p = { publicKey: {}, signTransaction: async () => ({}) };
  assert.equal(await resolveSolanaAdapter({ provider: p }), p);
});

test("resolveSolanaAdapter: nothing sign-capable → null (mock providers by design)", async () => {
  assert.equal(await resolveSolanaAdapter(null), null);
  assert.equal(await resolveSolanaAdapter({ provider: {} }), null);
  assert.equal(await resolveSolanaAdapter({ provider: { adapter: {} } }), null);
  assert.equal(await resolveSolanaAdapter({ provider: { publicKey: {} } }), null, "publicKey alone can't sign");
  assert.equal(
    await resolveSolanaAdapter({ provider: { adapter: { publicKey: {} } } }),
    null,
  );
});
