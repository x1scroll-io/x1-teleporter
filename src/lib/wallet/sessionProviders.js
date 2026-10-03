/**
 * sessionProviders.js — resolve sign-capable providers from WalletContext
 * sessions (Phase 3 bridge form).
 *
 * The v2 wallet layer (Step 2.1/2.2) holds ONE session per family, but a
 * session's `provider` is the CONNECT adapter (`{ connect, disconnect }`),
 * not a signing surface. The bridge form needs the real thing:
 *
 *   EVM     — an EIP-1193 provider with `request()` (eth_call /
 *             eth_sendTransaction). The real adapter wraps the discovered
 *             EIP-6963 wagmi connector at `provider.discovered.provider`,
 *             which exposes `getProvider()` → the EIP-1193 provider. A raw
 *             provider with `request` (test fakes, future adapters) passes
 *             through as-is.
 *   Solana  — the Wallet Standard adapter with `signAndSendTransaction` /
 *             `signTransaction` + `publicKey` (runStage2 signs via it). The
 *             real session provider wraps it at `provider.adapter`.
 *   NEAR    — the NEAR Wallet Selector wallet (with `signAndSendTransaction`).
 *             The connect adapter does not sign (session-only), so the
 *             resolver looks for the sign-capable surface the NEAR swap lane
 *             attaches — at `provider.wallet` (a selector wallet), or the raw
 *             provider itself when it exposes `signAndSendTransaction`.
 *   TON     — the TON Connect handle (with `sendTransaction` / `signData`).
 *             Resolved at `provider.tonConnect` (or `provider.wallet`), or the
 *             raw provider when it exposes `sendTransaction`.
 *
 * Both NEAR/TON resolvers return null when the session exposes no sign-capable
 * surface yet (the connect adapters are session-only by design — the NEAR/TON
 * swap lives are later steps) — the caller surfaces an honest "connect a real
 * wallet" error instead of a silent dead-end.
 *
 * Both resolvers return null when the session can't sign — the caller
 * surfaces an honest "connect a real wallet" error instead of a silent
 * dead-end (and the mock providers, which have no signing surface, resolve
 * to null by design).
 */

/**
 * Resolve the EIP-1193 provider (`{ request }`) from an EVM session.
 *
 * @param {object|null} session the WalletContext `sessions.evm` session
 * @returns {Promise<object|null>} the provider, or null when the session
 *   has no usable signing surface.
 */
export async function resolveEvmProvider(session) {
  if (!session?.provider) return null;
  const p = session.provider;
  if (typeof p.request === "function") return p; // raw EIP-1193 (or test fake)

  // Real adapter shape: wraps the discovered EIP-6963 wagmi connector.
  const connector = p.discovered?.provider;
  if (connector && typeof connector.getProvider === "function") {
    try {
      const prov = await connector.getProvider();
      return prov && typeof prov.request === "function" ? prov : null;
    } catch {
      return null;
    }
  }
  return null;
}

function canSignSolana(x) {
  return Boolean(
    x &&
      (typeof x.signAndSendTransaction === "function" ||
        typeof x.signTransaction === "function"),
  );
}

/**
 * Sync sign-capability check for a Solana/X1 session (hint-level UI gate:
 * whether the handoff state can offer a Retry). The async resolver is the
 * authoritative check used by the send path.
 */
export function solanaSessionCanSign(session) {
  if (!session?.provider) return false;
  return canSignSolana(session.provider) || canSignSolana(session.provider.adapter);
}

/**
 * Resolve the sign-capable Solana adapter from a Solana/X1 session.
 *
 * @param {object|null} session the WalletContext `sessions.solana` session
 * @returns {Promise<object|null>} the adapter (`publicKey` +
 *   signAndSendTransaction/signTransaction), or null when the session can't
 *   sign (mock providers resolve to null by design).
 */
export async function resolveSolanaAdapter(session) {
  if (!session?.provider) return null;
  const p = session.provider;
  if (canSignSolana(p)) return p; // raw adapter (or test fake)
  if (canSignSolana(p.adapter)) return p.adapter; // real Wallet Standard wrapper
  return null;
}

// ── NEAR (NEAR Wallet Selector) ─────────────────────────────────────────────

/** A NEAR sign surface exposes signAndSendTransaction / signAndSendTransactions. */
function canSignNear(x) {
  return Boolean(
    x &&
      (typeof x.signAndSendTransaction === "function" ||
        typeof x.signAndSendTransactions === "function"),
  );
}

/**
 * Sync sign-capability hint for a NEAR session (UI gate for the Retry offer).
 * The async resolver is the authoritative check used by the send path.
 */
export function nearSessionCanSign(session) {
  if (!session?.provider) return false;
  const p = session.provider;
  return canSignNear(p) || canSignNear(p.wallet);
}

/**
 * Resolve the sign-capable NEAR wallet from a NEAR session.
 *
 * @param {object|null} session the WalletContext `sessions.near` session
 * @returns {Promise<object|null>} the selector wallet (signAndSendTransaction),
 *   or null when the session has no signing surface yet (mock providers + the
 *   session-only connect adapters resolve to null by design).
 */
export async function resolveNearProvider(session) {
  if (!session?.provider) return null;
  const p = session.provider;
  if (canSignNear(p)) return p; // raw selector wallet (or test fake)
  if (canSignNear(p.wallet)) return p.wallet; // real adapter wraps the wallet
  return null;
}

// ── TON (TON Connect) ───────────────────────────────────────────────────────

/** A TON sign surface exposes sendTransaction / signData. */
function canSignTon(x) {
  return Boolean(
    x &&
      (typeof x.sendTransaction === "function" || typeof x.signData === "function"),
  );
}

/** Sync sign-capability hint for a TON session. */
export function tonSessionCanSign(session) {
  if (!session?.provider) return false;
  const p = session.provider;
  return canSignTon(p) || canSignTon(p.tonConnect) || canSignTon(p.wallet);
}

/**
 * Resolve the sign-capable TON Connect handle from a TON session.
 *
 * @param {object|null} session the WalletContext `sessions.ton` session
 * @returns {Promise<object|null>} the TON Connect handle (sendTransaction),
 *   or null when the session has no signing surface yet (mock providers + the
 *   session-only connect adapter resolve to null by design).
 */
export async function resolveTonProvider(session) {
  if (!session?.provider) return null;
  const p = session.provider;
  if (canSignTon(p)) return p; // raw TON Connect handle (or test fake)
  if (canSignTon(p.tonConnect)) return p.tonConnect; // real adapter wraps the handle
  if (canSignTon(p.wallet)) return p.wallet;
  return null;
}
