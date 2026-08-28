/**
 * Solana wallet discovery via the Wallet Standard registry (Step 2.2 —
 * wallet discovery + connect modal).
 *
 * Discovers installed Solana wallets WITHOUT ever touching the injected
 * Solana global. The Wallet Standard registry (`getWallets()` from @wallet-standard/app)
 * is the canonical mechanism: wallet extensions register themselves through
 * `wallet-standard:register-wallet` / `wallet-standard:app-ready` window
 * events, and the registry surfaces them via `get()` plus `register` /
 * `unregister` events.
 *
 * Why the raw registry instead of @solana/wallet-adapter-react's
 * auto-detect? wallet-adapter-react's detection hook (useStandardWalletAdapters)
 * is a thin React wrapper around this same registry. Hand-rolling on the
 * registry directly keeps the module dependency-light and testable in pure
 * node:test (inject a fake registry) with zero DOM/React requirements. The
 * wallet-adapter-react package is installed and stays available for the
 * Phase 3 connect-state layer.
 *
 * Each registered Wallet Standard wallet is wrapped in a
 * `StandardWalletAdapter` (from @solana/wallet-standard), so discovery
 * yields the adapter list the rest of the app expects. The connect flow
 * (`createSolanaProviderAdapter`) wraps an adapter into the same
 * `{ connect, disconnect }` interface the WalletContext expects; the mock
 * provider (mockProviders.js) remains the fallback when nothing is
 * discovered.
 *
 * There is NO code anywhere in this module (or in src/) that reads the
 * injected Solana global — see noWindowProbe.test.js, which fails the build
 * if that pattern (or the other injected globals) ever appears in src/.
 */

import { isWalletAdapterCompatibleStandardWallet } from "@solana/wallet-adapter-base";
import { StandardWalletAdapter } from "@solana/wallet-standard";
import { getWallets } from "@wallet-standard/app";

/**
 * Create a Solana Wallet Standard discovery handle.
 *
 * @param {{registry?: {get: () => Array, on: (event: string, listener: Function) => () => void}, onChange?: (adapters: Array) => void}} [options]
 *   - registry: the Wallet Standard Wallets API (`{ get, on }`). Defaults to
 *     the real browser registry (`getWallets()` from @wallet-standard/app).
 *     Tests inject a fake registry so no window is needed.
 *   - onChange: called with a fresh adapter snapshot whenever the registry
 *     changes (register/unregister). Also called once from start().
 * @returns {{start: () => void, stop: () => void, getAdapters: () => Array}}
 */
export function createSolanaDiscovery({ registry = null, onChange = () => {} } = {}) {
  // getWallets() is a module-level singleton with browser side effects on
  // first call (dispatches wallet-standard:app-ready). Only touch it when no
  // registry was injected — i.e. real browser usage, never in tests.
  const source = registry ?? getWallets();

  let adapters = [];
  let offs = [];

  function snapshot() {
    return [...adapters];
  }

  function refresh() {
    adapters = source
      .get()
      .filter(isWalletAdapterCompatibleStandardWallet)
      .map((wallet) => new StandardWalletAdapter({ wallet }));
    onChange(snapshot());
  }

  return {
    /** Subscribe to registry changes and take the initial snapshot. */
    start() {
      offs.push(source.on("register", refresh));
      offs.push(source.on("unregister", refresh));
      refresh();
    },

    /** Unsubscribe from registry changes. Collected adapters stay readable. */
    stop() {
      for (const off of offs) {
        try {
          off();
        } catch {
          // listener already removed — nothing to do
        }
      }
      offs = [];
    },

    /** Snapshot of discovered adapters (StandardWalletAdapter instances). */
    getAdapters: snapshot,
  };
}

/**
 * Wrap a discovered Solana adapter into the WalletContext provider shape:
 * `{ family, id, isReal, connect, disconnect }`.
 *
 * connect() runs the adapter connection handshake and resolves the adapter's
 * public key (base58) as the wallet address. Connection only — no signing,
 * no transaction building (Phase 3 territory).
 *
 * @param {{name: string, icon?: string, connect: () => Promise<void>, disconnect?: () => Promise<void>, publicKey?: {toBase58: () => string}}} adapter
 * @returns {{family: "solana", id: string, isReal: true, connect: () => Promise<{family, address, provider}>, disconnect: () => Promise<void>}}
 */
export function createSolanaProviderAdapter(adapter) {
  return {
    family: "solana",
    id: `wallet-standard:${adapter.name}`,
    isReal: true,
    walletName: adapter.name,
    adapter,

    async connect() {
      await adapter.connect();
      const publicKey = adapter.publicKey;
      if (!publicKey || typeof publicKey.toBase58 !== "function") {
        throw new Error(`Solana wallet "${adapter.name}" returned no public key`);
      }
      return { family: "solana", address: publicKey.toBase58(), provider: this };
    },

    async disconnect() {
      if (typeof adapter.disconnect !== "function") return;
      try {
        await adapter.disconnect();
      } catch {
        // Already disconnected — the adapter throws on double-disconnect.
      }
    },
  };
}
