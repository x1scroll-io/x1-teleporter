/**
 * Wallet discovery composition (Step 2.2, extended Step 2.4).
 *
 * Wires the per-family discovery modules into ONE handle that the
 * WalletContext and the connect modal share:
 *
 *   - `getDiscovered()` — snapshot of everything discovered for ALL seven
 *     families ({ evm, solana, bitcoin, litecoin, dogecoin, xrp, tron })
 *     for the modal's installed-highlighting.
 *   - `getProvider(family, walletId)` — resolve a discovered wallet to a
 *     WalletContext provider ({ connect, disconnect }). Returns null when no
 *     real provider matches, so the context falls back to the mock provider.
 *   - `subscribe(listener)` — the modal re-renders when wallets announce
 *     late (e.g. an extension injects after the page loads).
 *
 * Browser-safe by construction: with no window and no injected registry /
 * adapters the handle degrades to "nothing discovered" instead of touching
 * globals.
 *
 * Family isolation (docs/BRIEF.md, binding): each family's discovery never
 * touches another family's list. In particular the Tron discovery reports
 * ONLY adapter-detected wallets (never ethereum-style injections)
 * and the EVM discovery is EIP-6963-only — so a TronLink-family wallet can
 * never appear in the EVM list (isolation test in walletDiscovery.test.js).
 */

import { createEvmDiscovery, createEvmProviderAdapter } from "./evmDiscovery.js";
import { createSolanaDiscovery, createSolanaProviderAdapter } from "./solanaDiscovery.js";
import { createBitcoinDiscovery } from "./bitcoinDiscovery.js";
import { createLitecoinDiscovery } from "./litecoinDiscovery.js";
import { createDogecoinDiscovery } from "./dogecoinDiscovery.js";
import { createXrpDiscovery } from "./xrpDiscovery.js";
import { createTronDiscovery } from "./tronDiscovery.js";

/** Frozen empty snapshot — the "nothing discovered" default. */
export const EMPTY_DISCOVERED = Object.freeze({
  evm: Object.freeze([]),
  solana: Object.freeze([]),
  bitcoin: Object.freeze([]),
  litecoin: Object.freeze([]),
  dogecoin: Object.freeze([]),
  xrp: Object.freeze([]),
  tron: Object.freeze([]),
});

/**
 * Create the combined discovery handle.
 *
 * @param {object} [options] — every sub-discovery is injectable for tests:
 *   - evmConfig: a wagmi config (see evmDiscovery.js).
 *   - solanaRegistry: the Wallet Standard Wallets API ({ get, on }).
 *   - bitcoinWin / bitcoinStandardRegistry / bitcoinLaserEyes /
 *     bitcoinBalanceFetcher: Bitcoin DI (see bitcoinDiscovery.js).
 *   - litecoinWin / litecoinBalanceFetcher: Litecoin DI (see
 *     litecoinDiscovery.js / altcoinBalance.js).
 *   - dogecoinWin / dogecoinBalanceFetcher: Dogecoin DI.
 *   - xrpWin / xrpBalanceFetcher: XRP DI (see xrpDiscovery.js /
 *     xrpBalance.js).
 *   - tronAdapters: array of { registryId, adapter } pairs — the app
 *     passes createRealTronAdapters() (tronAdapters.js, browser-only);
 *     tests pass fakes (see tronDiscovery.js).
 *   - tronBalanceFetcher: (address) => Promise<SUN> (tronBalance.js).
 */
export function createWalletDiscovery({
  evmConfig,
  solanaRegistry,
  bitcoinWin,
  bitcoinStandardRegistry,
  bitcoinLaserEyes,
  bitcoinBalanceFetcher,
  litecoinWin,
  litecoinBalanceFetcher,
  dogecoinWin,
  dogecoinBalanceFetcher,
  xrpWin,
  xrpBalanceFetcher,
  tronAdapters,
  tronBalanceFetcher,
} = {}) {
  const listeners = new Set();

  function snapshot() {
    return {
      evm: evm.getProviders(),
      solana: solana.getAdapters(),
      bitcoin: bitcoin.getInstalled(),
      litecoin: litecoin.getInstalled(),
      dogecoin: dogecoin.getInstalled(),
      xrp: xrp.getInstalled(),
      tron: tron.getInstalled(),
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
  const litecoin = createLitecoinDiscovery({
    win: litecoinWin,
    balanceFetcher: litecoinBalanceFetcher,
    onChange: emit,
  });
  const dogecoin = createDogecoinDiscovery({
    win: dogecoinWin,
    balanceFetcher: dogecoinBalanceFetcher,
    onChange: emit,
  });
  const xrp = createXrpDiscovery({
    win: xrpWin,
    balanceFetcher: xrpBalanceFetcher,
    onChange: emit,
  });
  const tron = createTronDiscovery({
    adapters: tronAdapters,
    balanceFetcher: tronBalanceFetcher,
    onChange: emit,
  });

  return {
    /** Start all discoveries. Safe to call twice (idempotent per handle).
     *  Subscribers are notified by each sub-discovery's initial snapshot. */
    start() {
      evm.start();
      solana.start();
      bitcoin.start();
      litecoin.start();
      dogecoin.start();
      xrp.start();
      tron.start();
    },

    /** Stop all discoveries. Discovered state stays readable. */
    stop() {
      evm.stop();
      solana.stop();
      bitcoin.stop();
      litecoin.stop();
      dogecoin.stop();
      xrp.stop();
      tron.stop();
    },

    /**
     * Subscribe to discovery changes. Listener receives the full snapshot
     * ({ evm, solana, bitcoin, litecoin, dogecoin, xrp, tron }) on every
     * change. Returns an unsubscribe function.
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Current discovery snapshot (all seven families). */
    getDiscovered: snapshot,

    /**
     * Resolve a discovered wallet to a WalletContext provider, or null.
     *
     * EVM walletId = the wallet's EIP-6963 rdns (or uuid); Solana walletId =
     * the adapter name; Bitcoin/Litecoin/Dogecoin/XRP walletId = the
     * registry id (e.g. "Xverse", "Ctrl", "Crossmark"); Tron walletId = the
     * registry id / adapter name (e.g. "TronLink", "OKX Wallet"). Starport
     * (and any other id with no discovered wallet) resolves to null — the
     * context then uses the mock fallback.
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
      if (family === "litecoin") {
        return litecoin.getProvider(walletId);
      }
      if (family === "dogecoin") {
        return dogecoin.getProvider(walletId);
      }
      if (family === "xrp") {
        return xrp.getProvider(walletId);
      }
      if (family === "tron") {
        return tron.getProvider(walletId);
      }
      return null;
    },
  };
}
