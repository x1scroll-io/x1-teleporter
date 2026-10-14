/**
 * Pure wallet-session state for the Teleporter v2 WalletContext (Step 2.1).
 *
 * Deliberately framework-free: the reducer, guards and helpers here are plain
 * functions so node:test can prove the isolation guarantees WITHOUT a DOM or
 * React. The React context (WalletContext.jsx) is a thin wrapper around this
 * module — all state transitions flow through `walletReducer`.
 *
 * Isolation by construction: every action carries a `family`, and the reducer
 * only ever reads/writes `state[family]`. No action can touch another
 * family's session. The tests in walletReducer.test.js prove this for every
 * family and every transition.
 */

import { WALLET_FAMILIES } from "./families.js";

/** Per-family session statuses. */
export const DISCONNECTED = "disconnected";
export const CONNECTING = "connecting";
export const CONNECTED = "connected";
export const ERROR = "error";

export const STATUSES = Object.freeze([DISCONNECTED, CONNECTING, CONNECTED, ERROR]);

/**
 * A fresh, empty session for one family. Every family starts here:
 * `{ status: "disconnected" }` — no address, no provider, no error.
 */
export function initialFamilyState() {
  return { status: DISCONNECTED };
}

/** Full initial context state: one independent session per family. */
export function createInitialState(families = WALLET_FAMILIES) {
  const state = {};
  for (const family of families) {
    state[family] = initialFamilyState();
  }
  return state;
}

export const INITIAL_STATE = createInitialState();

/**
 * Reducer for the whole wallet context.
 *
 * Guarantees:
 *  - Only `state[action.family]` is ever read or written — cross-family
 *    contamination is impossible at the state level.
 *  - CONNECT_START is idempotent: re-starting an already connecting or
 *    connected family is a no-op (returns the SAME state object).
 *  - DISCONNECT resets the session to a fresh `initialFamilyState()`.
 *  - Unknown families are ignored (defensive; the context guards earlier).
 */
export function walletReducer(state, action) {
  switch (action.type) {
    case "CONNECT_START": {
      const current = state[action.family];
      if (!current) return state;
      if (current.status === CONNECTING || current.status === CONNECTED) return state;
      return { ...state, [action.family]: { status: CONNECTING } };
    }
    case "CONNECT_SUCCESS": {
      if (!state[action.family]) return state;
      return {
        ...state,
        [action.family]: {
          status: CONNECTED,
          address: action.address,
          provider: action.provider,
          // Optional: the Bitcoin session carries the payment-address
          // balance (sats) read at connect time. Omitted for other
          // families (and for mock providers) so existing sessions stay
          // shape-stable.
          ...(action.balance !== undefined ? { balance: action.balance } : {}),
          error: undefined,
        },
      };
    }
    case "CONNECT_ERROR": {
      if (!state[action.family]) return state;
      return {
        ...state,
        [action.family]: {
          status: ERROR,
          error: action.error,
          address: undefined,
          provider: undefined,
        },
      };
    }
    case "DISCONNECT": {
      if (!state[action.family]) return state;
      return { ...state, [action.family]: initialFamilyState() };
    }
    default:
      return state;
  }
}

/**
 * Action-level guard: may we start a connect for this family right now?
 *  - disconnected / error → yes (error allows retry)
 *  - connecting / connected → no (connect is idempotent; disconnect first to
 *    re-establish). Unknown family → no.
 */
export function canConnect(state, family) {
  const session = state[family];
  if (!session) return false;
  return session.status === DISCONNECTED || session.status === ERROR;
}
