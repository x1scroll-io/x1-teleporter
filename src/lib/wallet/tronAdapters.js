/**
 * Tron real-adapter factory (Step 2.4) — the ONE place the app constructs
 * the @tronweb3/tronwallet-adapters package.
 *
 * docs/WALLET-REGISTRY.md (Tron section) is binding: "Discovery: explicit
 * adapters from @tronweb3/tronwallet-adapters. Never read window.tronWeb
 * directly — several wallets inject it."
 *
 * THIS module is the SOLE src/ file allowed to reference the bare injected
 * tronWeb global (in comments only): noWindowProbe.test.js bans
 * "window.tronWeb" everywhere else and allowlists this file
 * (TRON_ADAPTER_ALLOWLIST) — the same pattern as the impersonation-aware
 * unisat allowlist from Step 2.3. Our code NEVER reads the injected
 * tronWeb/tronLink globals: the adapters own that handling internally
 * (TronLinkAdapter checks window.tronLink, OkxWalletAdapter checks
 * window.okxwallet.tronLink, …). We only construct adapters, subscribe to
 * their readyState, and read adapter.address after connect().
 *
 * Browser-only by construction: it imports the adapters package (which
 * pulls tronweb) and gates adapter construction on a window existing.
 * node:test never imports this module — tronDiscovery.js takes adapters
 * via DI (tests inject fakes), mirroring the laserEyesHandle.js pattern.
 *
 * The registry rows with a wired adapter (tronRegistry.js `adapterName`):
 *   - TronLink    → TronLinkAdapter   (reference wallet)
 *   - OKX Wallet  → OkxWalletAdapter  (registry: window.okxwallet.tronLink)
 *   - Bitget Wallet → BitKeepAdapter
 *   - TokenPocket → TokenPocketAdapter
 *   - Ledger      → LedgerAdapter     (detection via readyState only;
 *                                      connect is the Phase 3 hardware lane)
 *
 * WalletConnectAdapter / ImTokenAdapter are NOT constructed here: the
 * WalletConnect row needs a Reown AppKit projectId (config) and imToken is
 * mobile-only via WalletConnect — both are TODO-gated in tronRegistry.js
 * (no guessed config). Binance/Trust are ⚠️ registry rows (via
 * WalletConnect, unverified) — also not constructed.
 *
 * NO signing: the adapters' signTransaction/signMessage are never called
 * from src/ — this PR is discovery + session + balance only.
 */

import {
  TronLinkAdapter,
  OkxWalletAdapter,
  BitKeepAdapter,
  TokenPocketAdapter,
  LedgerAdapter,
} from "@tronweb3/tronwallet-adapters";
import { TRON_WALLET_IDS } from "./tronRegistry.js";

/**
 * Construct the real adapter list, in registry order.
 *
 * @returns {Array<{registryId: string, adapter: object}>} empty when no
 *   window exists (browser-less environments degrade to nothing discovered).
 */
export function createRealTronAdapters() {
  if (typeof window === "undefined") return [];
  return [
    { registryId: TRON_WALLET_IDS.TRONLINK, adapter: new TronLinkAdapter() },
    { registryId: TRON_WALLET_IDS.OKX, adapter: new OkxWalletAdapter() },
    { registryId: TRON_WALLET_IDS.BITGET, adapter: new BitKeepAdapter() },
    { registryId: TRON_WALLET_IDS.TOKENPOCKET, adapter: new TokenPocketAdapter() },
    { registryId: TRON_WALLET_IDS.LEDGER, adapter: new LedgerAdapter() },
  ];
}
