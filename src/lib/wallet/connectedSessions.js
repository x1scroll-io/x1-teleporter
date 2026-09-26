/**
 * connectedSessions.js — the React-free seam that exposes the CURRENT
 * WalletContext sessions to non-React engine modules.
 *
 * WHY THIS EXISTS
 *   The wallet layer is React (WalletContext.jsx holds one session per family),
 *   but the money path is NOT: the Warp leg (src/warpBridge.js) is a plain
 *   module the engine calls with a `provider`. Historically that module fell
 *   back to reading the raw injected Solana global when no provider was
 *   passed — i.e. it reached for whatever wallet happened to own that global
 *   instead of the wallet the user actually connected through discovery. That
 *   is both wrong (Backpack/Phantom/X1 all race for the same global) and
 *   banned (see noWindowProbe.test.js).
 *
 *   This module is the honest replacement: the WalletContext PUBLISHES its
 *   live sessions here (one per family), and the non-React engine READS the
 *   currently-connected session and resolves the sign-capable surface through
 *   the SAME proven resolver the React path uses (sessionProviders.js). The
 *   connected provider is therefore whatever wallet discovery connected —
 *   never an injected global.
 *
 * NOT STATE: this is a mirror of WalletContext state, kept in sync by an
 * effect there. It holds session OBJECTS (never serialized, never persisted)
 * and is module-local — no window, no globals, no DOM. Pure and testable under
 * `node --test`.
 */

/** family → session (the WalletContext `sessions[family]` object). */
const sessions = new Map();

/**
 * Publish (or clear) one family's current session. Called by WalletContext on
 * every state change: a connected family is stored; a disconnected/errored
 * family is removed so a stale signer can never be resolved after a disconnect.
 *
 * @param {string} family the wallet family key ("solana", "evm", …)
 * @param {object|null} session the session to publish, or null to clear
 */
export function setConnectedSession(family, session) {
  if (family && session) sessions.set(family, session);
  else if (family) sessions.delete(family);
}

/** Remove a family's published session (disconnect). */
export function clearConnectedSession(family) {
  sessions.delete(family);
}

/**
 * The currently-published session for a family, or null. The engine resolves
 * the sign-capable surface from this via sessionProviders.js
 * (resolveEvmProvider / resolveSolanaAdapter) — the same resolvers the React
 * path uses, so the two can never disagree about who signs.
 */
export function getConnectedSession(family) {
  return sessions.get(family) ?? null;
}

/** Snapshot map of every published session (diagnostics/tests). */
export function getConnectedSessions() {
  return new Map(sessions);
}

/** Clear every published session (test isolation / app teardown). */
export function clearAllConnectedSessions() {
  sessions.clear();
}
