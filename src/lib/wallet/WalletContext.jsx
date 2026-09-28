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
 *     REAL provider (EIP-6963 EVM wallet / Wallet Standard Solana adapter).
 *     The dev/test mock (mockProviders.js) is only a LAST resort, and only
 *     when `allowMockFallback` is explicitly armed AND the family has nothing
 *     discovered — never for a real user with a real wallet (see
 *     defaultResolveProvider). Production leaves it off.
 *   - `connect(family, walletId?)`: walletId selects WHICH discovered wallet
 *     to connect (EVM rdns, Solana adapter name).
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
import { isWalletFamily, WALLET_FAMILIES, FAMILY_LABELS } from "./families.js";
import { CONNECTED, canConnect, createInitialState, walletReducer } from "./walletReducer.js";
import { createMockProvider } from "./mockProviders.js";
import { STARPORT_NAMES, isStarportKey } from "./modalLogic.js";
import {
  setConnectedSession,
  clearConnectedSession,
} from "./connectedSessions.js";

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
  cardano: Object.freeze([]),
});

/**
 * Default provider resolution: real discovered wallet FIRST. The dev/test mock
 * is a LAST resort — armed only when BOTH of these hold:
 *   1. the mock seam is explicitly enabled (`allowMockFallback` — false in
 *      production; main.jsx arms it only via VITE_FLAG_MOCK_WALLETS), AND
 *   2. the family has GENUINELY nothing discovered (no installed wallet).
 *
 * Otherwise it returns null, and connect() surfaces an honest "no wallet
 * detected" error. Without this gate the pinned Starport row (always
 * actionable) fell through to the mock for a real user — a connected
 * `mock:solana:9xQeWvG8…` / `mock:evm:0x1234…` address that NO wallet ever
 * approved. The mock must never masquerade as a real wallet for a real user.
 *
 * Only used when no `providerFactory` prop is injected (tests inject their own
 * factory; the app relies on this default + discovery).
 */
function defaultResolveProvider(discovery, family, walletId, allowMockFallback = false) {
  const real = resolveDiscovered(discovery, family, walletId);
  if (real) return real;
  if (allowMockFallback && familyDiscoveredEmpty(discovery, family)) {
    return createMockProvider(family);
  }
  return null;
}

/**
 * True when a family has NO discovered (installed) wallet — i.e. the mock
 * fallback could not be shadowing a real wallet. No discovery handle at all
 * counts as empty (nothing was ever announced).
 */
function familyDiscoveredEmpty(discovery, family) {
  const snapshot = discovery?.getDiscovered?.();
  const list = snapshot?.[family];
  return !Array.isArray(list) || list.length === 0;
}

/**
 * Resolve a discovered wallet, tolerating the id-vs-announced-name mismatch
 * between the registry rows and the Wallet Standard registry.
 *
 * Registry rows carry STABLE ids (Starport's is STARPORT_ID = "starport",
 * lowercase), while discovered adapters are keyed by the name the wallet
 * ANNOUNCES ("Starport", capital S). `discovery.getProvider(family, id)`
 * matches on the key, so the Starport row missed, returned nothing, and
 * silently fell back to the dev mock — observed live as a connected address of
 * `mock:solana:9xQeWvG8…` with NO wallet approval ever requested, even though
 * the wallet was registered in the Wallet Standard registry (verified by
 * reading getWallets() on the page: name "Starport", full feature set).
 *
 * STARPORT_NAMES already models this alias pair; this just applies it on the
 * connect path instead of leaving it to the row-rendering code.
 */
function resolveDiscovered(discovery, family, walletId) {
  const direct = discovery?.getProvider?.(family, walletId);
  if (direct) return direct;
  // Alias sweep — ALL families, not just solana. Starport's registry rows carry
  // the stable id "starport" while any discovery layer keys on the announced
  // name "Starport"; the mismatch is per-family, so scoping this to solana (the
  // first place it bit us) left xrp/btc/ltc/doge/tron silently on the mock.
  // Observed: the XRP lane quoted with a refund address of
  // `mock:xrp:rHb9CJAW…`, which THORChain rejected as a THORName.
  const aliases = isStarportKey(walletId) ? STARPORT_NAMES : [];
  for (const alt of aliases) {
    if (alt === walletId) continue;
    const hit = discovery?.getProvider?.(family, alt);
    if (hit) return hit;
  }
  return null;
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
export function WalletProvider({
  children,
  providerFactory,
  initialState,
  discovery,
  // Dev/test seam for the mock providers (mockProviders.js). DEFAULT FALSE —
  // a real user is never handed a mock. main.jsx arms it from
  // VITE_FLAG_MOCK_WALLETS (default off); tests opt in explicitly. Even when
  // armed, the mock only fires for a family with NOTHING discovered.
  allowMockFallback = false,
}) {
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

  // Publish the live sessions to the React-free connectedSessions registry so
  // non-React engine modules (warpBridge.js) resolve the signer from the
  // wallet the user ACTUALLY connected — never an injected global. A
  // disconnected/errored family is cleared so a stale signer can never be
  // resolved after a disconnect.
  useEffect(() => {
    for (const family of WALLET_FAMILIES) {
      const session = state[family];
      if (session?.status === CONNECTED && session.provider) {
        setConnectedSession(family, session);
      } else {
        clearConnectedSession(family);
      }
    }
  }, [state]);

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
        : defaultResolveProvider(discovery, family, walletId, allowMockFallback),
    [providerFactory, discovery, allowMockFallback],
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
        // No real wallet resolved and the mock seam is off/not applicable:
        // fail HONESTLY. Never silently connect a mock address (that is how a
        // real user got a phantom "connected" session no wallet approved).
        if (!provider) {
          throw new Error(
            `No ${FAMILY_LABELS[family] ?? family} wallet detected. Install or enable one, then connect again.`,
          );
        }
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
