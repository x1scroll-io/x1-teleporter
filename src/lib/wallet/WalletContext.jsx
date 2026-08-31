/**
 * WalletContext — one independent wallet session per chain family (Step 2.1,
 * Phase 2 wallet layer; extended Step 2.2 with real-wallet discovery).
 *
 * Holds one session per family (evm, solana, bitcoin, litecoin, dogecoin,
 * xrp, tron). Connecting or disconnecting one family NEVER affects another —
 * the reducer only ever touches `state[family]` (see walletReducer.js) and
 * the isolation tests prove it at both the pure-state and the hook level.
 *
 * This file is intentionally UI-free: it is the state foundation for the
 * connect modal (Step 2.2) which lives INSIDE the one-card tab layout
 * described in docs/BRIEF.md.
 *
 * Step 2.2 additions (discovery-aware connect flow):
 *   - `discovery` prop: a handle from walletDiscovery.js (or a test fake)
 *     exposing `{ start, stop, subscribe, getDiscovered, getProvider }`.
 *     When provided, connect(family, walletId) first asks discovery for a
 *     REAL provider (EIP-6963 EVM wallet / Wallet Standard Solana adapter)
 *     and falls back to the mock provider (mockProviders.js) when nothing
 *     matches — so the mock stays as the test/dev fallback while real
 *     discovery is injected when window exists.
 *   - `connect(family, walletId?)`: walletId selects WHICH discovered wallet
 *     to connect (EVM rdns, Solana adapter name). Omitted → mock fallback.
 *   - `discovered`: live snapshot of discovered wallets, exposed on the
 *     context for the modal's installed-highlighting. Updates when wallets
 *     announce late (subscribe → state).
 *   - `disconnect(family)` now also notifies the session's real provider
 *     (adapter.disconnect) when one is attached — mock providers no-op.
 *
 * Usage:
 *   <WalletProvider discovery={createWalletDiscovery()}>  // once, at app root
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
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { isWalletFamily } from "./families.js";
import { canConnect, createInitialState, walletReducer } from "./walletReducer.js";
import { createMockProvider } from "./mockProviders.js";

export const WalletContext = createContext(null);

/** Frozen "nothing discovered" default for the context value. */
const EMPTY_DISCOVERED = Object.freeze({
  evm: Object.freeze([]),
  solana: Object.freeze([]),
  bitcoin: Object.freeze([]),
  litecoin: Object.freeze([]),
  dogecoin: Object.freeze([]),
  xrp: Object.freeze([]),
  tron: Object.freeze([]),
});

/**
 * Default provider resolution: real discovered wallet first, mock fallback.
 * Only used when no `providerFactory` prop is injected (tests inject their
 * own factory; the app relies on this default + discovery).
 */
function defaultResolveProvider(discovery, family, walletId) {
  const real = discovery?.getProvider?.(family, walletId);
  return real ?? createMockProvider(family);
}

/**
 * Provider for the wallet context.
 *
 * @param {{children: React.ReactNode,
 *          providerFactory?: (family: string, walletId?: string) => object,
 *          initialState?: object,
 *          discovery?: object}} props
 *   providerFactory: injected so tests (and later real-wallet steps) can swap
 *   the provider resolution without touching the context logic. When omitted,
 *   the default resolution is: discovery.getProvider(family, walletId) →
 *   createMockProvider(family).
 *   discovery: walletDiscovery handle (or test fake). When provided the
 *   provider starts it on mount, subscribes to discovery changes (exposed as
 *   `discovered` on the context), stops it on unmount, and uses it to
 *   resolve real providers in connect().
 */
export function WalletProvider({ children, providerFactory, initialState, discovery }) {
  const [state, dispatch] = useReducer(
    walletReducer,
    undefined,
    () => initialState ?? createInitialState(),
  );

  // Live discovery snapshot for the connect modal (installed highlighting).
  const [discovered, setDiscovered] = useState(
    () => discovery?.getDiscovered?.() ?? EMPTY_DISCOVERED,
  );

  // In-flight guard: prevents a second connect() on the same family from
  // spawning a second provider while the first is still connecting. Belt and
  // braces on top of the reducer-level idempotency.
  const connectingRef = useRef(new Set());

  // Discovery lifecycle: start on mount, subscribe to late-announcing
  // wallets, stop on unmount. No-op when no discovery handle is provided.
  useEffect(() => {
    if (!discovery) return undefined;
    discovery.start?.();
    const unsubscribe = discovery.subscribe?.((snapshot) => {
      setDiscovered(snapshot ?? discovery.getDiscovered?.() ?? EMPTY_DISCOVERED);
    });
    return () => {
      unsubscribe?.();
      discovery.stop?.();
    };
  }, [discovery]);

  const resolveProvider = useCallback(
    (family, walletId) =>
      providerFactory
        ? providerFactory(family, walletId)
        : defaultResolveProvider(discovery, family, walletId),
    [providerFactory, discovery],
  );

  const connect = useCallback(
    async (family, walletId) => {
      if (!isWalletFamily(family)) {
        throw new Error(`useWallet: unknown family "${family}"`);
      }
      if (connectingRef.current.has(family)) return; // already in flight
      if (!canConnect(state, family)) return; // already connected — idempotent no-op
      connectingRef.current.add(family);
      dispatch({ type: "CONNECT_START", family });
      try {
        const provider = resolveProvider(family, walletId);
        const result = await provider.connect();
        dispatch({
          type: "CONNECT_SUCCESS",
          family,
          address: result.address,
          provider: result.provider ?? provider,
          // Optional per-family extra: the Bitcoin session carries the
          // payment-address balance (sats) read at connect time.
          balance: result.balance,
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
    [resolveProvider, state],
  );

  const disconnect = useCallback(
    (family) => {
      if (!isWalletFamily(family)) {
        throw new Error(`useWallet: unknown family "${family}"`);
      }
      // Tell the attached real provider to release its session (mock
      // providers no-op). Fire-and-forget: the state reset below is the
      // source of truth for the UI.
      const provider = state[family]?.provider;
      if (provider?.disconnect) {
        Promise.resolve(provider.disconnect()).catch(() => {});
      }
      dispatch({ type: "DISCONNECT", family });
    },
    [state],
  );

  const value = useMemo(
    () => ({ sessions: state, connect, disconnect, discovered }),
    [state, connect, disconnect, discovered],
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
 * pre-bound to this family. `connect` takes an optional walletId (EVM rdns /
 * Solana adapter name) to select a discovered wallet.
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
    connect: (walletId) => ctx.connect(family, walletId),
    disconnect: () => ctx.disconnect(family),
  };
}
