/**
 * Tron wallet discovery (Step 2.4) — explicit adapters from
 * @tronweb3/tronwallet-adapters ONLY (docs/WALLET-REGISTRY.md, Tron
 * section: "Discovery: explicit adapters from @tronweb3/tronwallet-adapters.
 * Never read the bare injected tronWeb global directly — several wallets
 * inject it").
 *
 * The adapters are constructed in tronAdapters.js (browser-only, the SOLE
 * allowlisted module — the adapters package owns the injected globals
 * internally). This module is DI-clean: it receives adapter instances (or
 * null) and never touches the injected globals itself — node:test injects
 * fakes, the app injects createRealTronAdapters() at mount.
 *
 * Installed = an adapter whose readyState is "Found" (the package's
 * WalletReadyState.Found — string literals are used here so tests never
 * need the package; see tronAdapters.js). Adapters check for their wallet
 * asynchronously after construction, so the handle subscribes to each
 * adapter's `readyStateChanged` event and refreshes when a wallet appears
 * or disappears.
 *
 * Connect adapters: TronLink / OKX Wallet / Bitget Wallet / TokenPocket
 * connect through their adapter (connect() + address — session only, NO
 * signing: signTransaction/signMessage are never called). Ledger is
 * detection-only (hardware lane TODO), WalletConnect / imToken are gated
 * behind their config TODO, Binance / Trust are ⚠️ registry rows — all of
 * them reject connect() with their clearly-marked TODO. No guessed APIs.
 *
 * ISOLATION (binding): TronLink-family wallets must NEVER appear in the
 * EVM list even if they inject an ethereum-like object. This module only
 * ever reports adapters; EVM discovery (evmDiscovery.js) is EIP-6963-only.
 * The composition-level test (walletDiscovery.test.js) pins the isolation.
 */

import { TRON_WALLETS, TRON_WALLET_IDS } from "./tronRegistry.js";

/** The @tronweb3/tronwallet-adapters WalletReadyState value for "installed". */
export const TRON_READY_FOUND = "Found";

/** The @tronweb3/tronwallet-adapters AdapterState value for "connected". */
export const TRON_STATE_CONNECTED = "Connected";

/**
 * Create the Tron discovery handle — same shape as the other family
 * discovery handles ({ start, stop, getInstalled, getProvider }).
 *
 * @param {{adapters?: Array<{registryId: string, adapter: object}>|null, balanceFetcher?: (address: string) => Promise<number>, onChange?: (wallets: Array) => void}} [options]
 *   - adapters: array of { registryId, adapter } pairs. The app passes
 *     createRealTronAdapters() (tronAdapters.js, browser-only); tests pass
 *     fakes. null → nothing discovered (graceful browser-less default).
 *   - balanceFetcher: (address) => Promise<SUN> (tronBalance.js
 *     createTronBalanceFetcher in the app). Defaults to null.
 */
export function createTronDiscovery({
  adapters = null,
  balanceFetcher = null,
  onChange = () => {},
} = {}) {
  const pairs = Array.isArray(adapters) ? [...adapters] : [];
  let installed = [];
  let offs = [];

  function refresh() {
    installed = pairs
      .filter(({ adapter }) => adapter?.readyState === TRON_READY_FOUND)
      .map(({ registryId, adapter }) => ({
        key: registryId,
        name: adapter?.name ?? registryId,
        source: "adapter",
      }));
    onChange([...installed]);
  }

  /** Adapter events the handle reacts to (readyStateChanged is enough). */
  const EVENTS = ["readyStateChanged"];

  return {
    /** Subscribe to adapter state changes and take the initial snapshot. */
    start() {
      for (const { adapter } of pairs) {
        if (typeof adapter?.on !== "function") continue;
        for (const event of EVENTS) {
          try {
            offs.push(adapter.on(event, refresh));
          } catch {
            // a misbehaving adapter must never break discovery
          }
        }
      }
      refresh();
    },

    /** Unsubscribe from adapter events. Collected state stays readable. */
    stop() {
      for (const off of offs) {
        try {
          off();
        } catch {
          // listener already removed
        }
      }
      offs = [];
    },

    /** Snapshot: [{ key, name, source }] — registry ids (adapter names). */
    getInstalled: () => [...installed],

    /**
     * Resolve an installed wallet to a WalletContext provider, or null
     * (null → the WalletContext mock fallback, e.g. the pinned Starport
     * row).
     */
    getProvider(walletId) {
      const pair = pairs.find((p) => p.registryId === walletId);
      if (!pair || !installed.some((w) => w.key === walletId)) return null;
      return createTronProviderAdapter({
        registryId: walletId,
        adapter: pair.adapter,
        balanceFetcher,
      });
    },
  };
}

/* ————————————————— provider adapters ————————————————— */

/** ⚠️ / hardware / config-gated rows: connect() rejects with the TODO — never a fake connect. */
function createUnverifiedProvider(entry) {
  const note =
    entry.todo ??
    entry.connectTodo ??
    "verify its API at build time (registry ⚠️ row — no guessed APIs)";
  return {
    family: "tron",
    id: `tron:${entry.id}`,
    isReal: true,
    walletName: entry.name,
    unverified: true,

    async connect() {
      throw new Error(`Tron wallet "${entry.name}" is not wired yet — ${note}`);
    },

    async disconnect() {},
  };
}

/**
 * Adapter-connected rows (TronLink / OKX / Bitget / TokenPocket):
 * connect() runs the adapter handshake and resolves the adapter address.
 * Session only — the adapter's signTransaction/signMessage are NEVER
 * called (signing is hard-stopped, Pro lane).
 */
function createAdapterProvider(entry, { adapter, balanceFetcher }) {
  return {
    family: "tron",
    id: `tron-adapter:${entry.adapterName}`,
    isReal: true,
    walletName: entry.name,
    adapter,

    async connect() {
      if (!adapter || typeof adapter.connect !== "function") {
        throw new Error(`Tron wallet "${entry.name}" has no usable adapter`);
      }
      await adapter.connect();
      const address = adapter.address;
      if (typeof address !== "string" || address.length === 0) {
        throw new Error(`Tron wallet "${entry.name}" returned no address`);
      }
      const balance = balanceFetcher ? await balanceFetcher(address) : undefined;
      return { family: "tron", address, balance, provider: this };
    },

    async disconnect() {
      if (typeof adapter?.disconnect === "function") {
        try {
          await adapter.disconnect();
        } catch {
          // already disconnected
        }
      }
    },
  };
}

/**
 * Build the provider adapter for a Tron registry wallet.
 * Exported for tests; the discovery handle guards installed-ness first.
 *
 * @param {{registryId: string, adapter: object, balanceFetcher?: Function, registry?: Array}} params
 * @returns {object|null} WalletContext-shaped provider, or null for unknown ids.
 */
export function createTronProviderAdapter({
  registryId,
  adapter,
  balanceFetcher = null,
  registry = TRON_WALLETS,
}) {
  const entry = registry.find((e) => e.id === registryId);
  if (!entry) return null;

  // ⚠️ rows, config-gated rows (WalletConnect projectId, imToken) and
  // hardware (Ledger — Phase 3 lane) never fake a connect.
  if (entry.status === "verify" || entry.connectTodo || entry.hardware) {
    return createUnverifiedProvider(entry);
  }

  if (entry.adapterName) {
    return createAdapterProvider(entry, { adapter, balanceFetcher });
  }

  // Anything else unwired: no connect.
  return createUnverifiedProvider(entry);
}
