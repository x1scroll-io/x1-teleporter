/**
 * WalletContext — one independent wallet session per chain family (Step 2.1,
 * Phase 2 wallet layer).
 *
 * Holds one session per family (evm, solana, bitcoin, litecoin, dogecoin,
 * xrp, tron). Connecting or disconnecting one family NEVER affects another —
 * the reducer only ever touches `state[family]` (see walletReducer.js) and
 * the isolation tests prove it at both the pure-state and the hook level.
 *
 * This file is intentionally UI-free: it is the state foundation for the
 * connect modal (Step 2.2) which lives INSIDE the one-card tab layout
 * described in docs/BRIEF.md. Mock providers only — no real wallet SDKs are
 * wired in this step (see mockProviders.js).
 *
 * Usage:
 *   <WalletProvider>            // once, at the app root
 *     <App />
 *   </WalletProvider>
 *
 *   function SomeComponent() {
 *     const evm = useWallet("evm");
 *     return <button onClick={evm.connect}>{evm.status}</button>;
 *   }
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { isWalletFamily } from "./families.js";
import { canConnect, createInitialState, walletReducer } from "./walletReducer.js";
import { createMockProvider } from "./mockProviders.js";

export const WalletContext = createContext(null);

/**
 * Provider for the wallet context.
 *
 * @param {{children: React.ReactNode,
 *          providerFactory?: (family: string) => object,
 *          initialState?: object}} props
 *   providerFactory: injected so tests (and later real-wallet steps) can swap
 *   the mock providers without touching the context logic. Defaults to
 *   createMockProvider.
 */
export function WalletProvider({ children, providerFactory = createMockProvider, initialState }) {
  const [state, dispatch] = useReducer(
    walletReducer,
    undefined,
    () => initialState ?? createInitialState(),
  );

  // In-flight guard: prevents a second connect() on the same family from
  // spawning a second provider while the first is still connecting. Belt and
  // braces on top of the reducer-level idempotency.
  const connectingRef = useRef(new Set());

  const connect = useCallback(
    async (family) => {
      if (!isWalletFamily(family)) {
        throw new Error(`useWallet: unknown family "${family}"`);
      }
      if (connectingRef.current.has(family)) return; // already in flight
      if (!canConnect(state, family)) return; // already connected — idempotent no-op
      connectingRef.current.add(family);
      dispatch({ type: "CONNECT_START", family });
      try {
        const provider = providerFactory(family);
        const result = await provider.connect();
        dispatch({
          type: "CONNECT_SUCCESS",
          family,
          address: result.address,
          provider: result.provider ?? provider,
        });
      } catch (error) {
        dispatch({
          type: "CONNECT_ERROR",
          family,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        connectingRef.current.delete(family);
      }
    },
    [providerFactory, state],
  );

  const disconnect = useCallback((family) => {
    if (!isWalletFamily(family)) {
      throw new Error(`useWallet: unknown family "${family}"`);
    }
    dispatch({ type: "DISCONNECT", family });
  }, []);

  const value = useMemo(
    () => ({ sessions: state, connect, disconnect }),
    [state, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Access the raw context (all sessions + actions) — for the Step 2.2 modal. */
export function useWalletContext() {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWalletContext must be used within <WalletProvider>");
  }
  return ctx;
}

/**
 * Hook: one family's session + bound actions.
 *
 * Returns `{ family, status, address?, provider?, error?, connect, disconnect }`.
 * The session fields come straight from context state; connect/disconnect are
 * pre-bound to this family.
 */
export function useWallet(family) {
  const ctx = useWalletContext();
  if (!isWalletFamily(family)) {
    throw new Error(`useWallet: unknown family "${family}"`);
  }
  const session = ctx.sessions[family];
  return {
    family,
    ...session,
    connect: () => ctx.connect(family),
    disconnect: () => ctx.disconnect(family),
  };
}
