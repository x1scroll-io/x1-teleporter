/**
 * Wallet discovery composition (Step 2.2).
 *
 * Wires the two discovery modules (wagmi EIP-6963 for EVM, Wallet Standard
 * for Solana) into ONE handle that the WalletContext and the connect modal
 * share:
 *
 *   - `getDiscovered()` — snapshot of everything discovered
 *     ({ evm: [...EIP-6963 entries], solana: [...adapters] }) for the modal's
 *     installed-highlighting.
 *   - `getProvider(family, walletId)` — resolve a discovered wallet to a
 *     WalletContext provider ({ connect, disconnect }). Returns null when no
 *     real provider matches, so the context falls back to the mock provider.
 *   - `subscribe(listener)` — the modal re-renders when wallets announce
 *     late (e.g. an extension injects after the page loads).
 *
 * Browser-safe by construction: with no window and no injected registry the
 * handle degrades to "nothing discovered" instead of touching globals.
 */

import { createEvmDiscovery, createEvmProviderAdapter } from "./evmDiscovery.js";
import { createSolanaDiscovery, createSolanaProviderAdapter } from "./solanaDiscovery.js";
import { createBitcoinDiscovery } from "./bitcoinDiscovery.js";

/** Frozen empty snapshot — the "nothing discovered" default. */
export const EMPTY_DISCOVERED = Object.freeze({
  evm: Object.freeze([]),
  solana: Object.freeze([]),
  bitcoin: Object.freeze([]),
});

/**
 * Create the combined discovery handle.
 *
 * @param {{evmConfig?: object, solanaRegistry?: object, bitcoinWin?: object, bitcoinStandardRegistry?: object, bitcoinLaserEyes?: object, bitcoinBalanceFetcher?: Function}} [options]
 *   - evmConfig: a wagmi config (see evmDiscovery.js). Defaults to
 *     createDefaultEvmConfig() — mipd/EIP-6963 discovery activates only
 *     when a window exists.
 *   - solanaRegistry: the Wallet Standard Wallets API ({ get, on }). Defaults
 *     to the real browser registry (getWallets from @wallet-standard/app).
 *     Tests inject a fake so no window is needed.
 *   - bitcoinWin: injected window for Bitcoin namespaced-global detection
 *     (tests inject a fake; defaults to the real window).
 *   - bitcoinStandardRegistry: the Wallet Standard Wallets API for Bitcoin
 *     registrations (defaults to the real browser registry when a window
 *     exists).
 *   - bitcoinLaserEyes: the LaserEyes handle (laserEyesHandle.js) that
 *     connects LaserEyes-covered Bitcoin wallets. The real handle is
 *     browser-only; BridgeCard's production mount passes
 *     createLaserEyesHandle() (tests inject fakes). When omitted, installed
 *     Bitcoin wallets still enumerate, and getProvider falls back to null
 *     (mock fallback) for LaserEyes-covered ids.
 *   - bitcoinBalanceFetcher: (paymentAddress) => Promise<sats>; the app
 *     passes createBtcBalanceFetcher() (bitcoinBalance.js, mempool.space).
 */
export function createWalletDiscovery({
  evmConfig,
  solanaRegistry,
  bitcoinWin,
  bitcoinStandardRegistry,
  bitcoinLaserEyes,
  bitcoinBalanceFetcher,
} = {}) {
  const listeners = new Set();

  function snapshot() {
    return {
      evm: evm.getProviders(),
      solana: solana.getAdapters(),
      bitcoin: bitcoin.getInstalled(),
    };
  }

  function emit() {
    const snap = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(snap);
      } catch {
        // A misbehaving listener must never break discovery.
      }
    }
  }

  const evm = createEvmDiscovery({ config: evmConfig, onChange: emit });
  const solana = createSolanaDiscovery({ registry: solanaRegistry, onChange: emit });
  const bitcoin = createBitcoinDiscovery({
    win: bitcoinWin,
    standardRegistry: bitcoinStandardRegistry,
    laserEyes: bitcoinLaserEyes,
    balanceFetcher: bitcoinBalanceFetcher,
    onChange: emit,
  });

  return {
    /** Start both discoveries. Safe to call twice (idempotent per handle).
     *  Subscribers are notified by each sub-discovery's initial snapshot. */
    start() {
      evm.start();
      solana.start();
      bitcoin.start();
    },

    /** Stop both discoveries. Discovered state stays readable. */
    stop() {
      evm.stop();
      solana.stop();
      bitcoin.stop();
    },

    /**
     * Subscribe to discovery changes. Listener receives the full snapshot
     * ({ evm, solana }) on every change. Returns an unsubscribe function.
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Current discovery snapshot: { evm: [...], solana: [...], bitcoin: [...] }. */
    getDiscovered: snapshot,

    /**
     * Resolve a discovered wallet to a WalletContext provider, or null.
     *
     * EVM walletId = the wallet's EIP-6963 rdns (or uuid); Solana walletId =
     * the adapter name; Bitcoin walletId = the bitcoinRegistry.js id (e.g.
     * "Xverse", "Unisat") or a `standard:<name>` extra. Starport (and any
     * other id with no discovered wallet) resolves to null — the context
     * then uses the mock fallback.
     */
    getProvider(family, walletId) {
      if (family === "evm") {
        const entry = evm
          .getProviders()
          .find((p) => p.rdns === walletId || p.uuid === walletId);
        return entry ? createEvmProviderAdapter(entry) : null;
      }
      if (family === "solana") {
        const adapter = solana.getAdapters().find((a) => a.name === walletId);
        return adapter ? createSolanaProviderAdapter(adapter) : null;
      }
      if (family === "bitcoin") {
        return bitcoin.getProvider(walletId);
      }
      return null;
    },
  };
}
