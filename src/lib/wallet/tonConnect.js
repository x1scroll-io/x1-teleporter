/**
 * tonConnect.js — the ONE place the app constructs TON Connect
 * (@tonconnect/ui).
 *
 * docs/NEAR-TON-DEX-RESEARCH.md (TON connectors) is binding: "TON discovery
 * uses TON Connect and nothing else." TON Connect owns the bridge transport
 * (QR / universal link / deep link) and the wallet list; our code only
 * enumerates the list, opens TON Connect's own modal for a chosen wallet, and
 * reads the connected account (see tonDiscovery.js).
 *
 * Browser-only by construction: it imports @tonconnect/ui (a web-component
 * UI) and needs a window + a hosted manifest. node:test NEVER imports this
 * module — tonDiscovery.js takes the TON Connect handle via DI (tests inject
 * a fake), mirroring the tronAdapters.js / nearSelector.js pattern.
 *
 * ── FAIL-CLOSED ON THE MANIFEST ───────────────────────────────────────────
 * TON Connect REQUIRES a `manifestUrl` — a /tonconnect-manifest.json hosted
 * on the dApp's own origin (name, url, iconUrl) that wallets fetch to show
 * the connect prompt. We do NOT guess one: without a configured manifest this
 * factory returns null, discovery reports ZERO connectable wallets, and the
 * modal falls through to the deposit-address row. Host the manifest and pass
 * its URL (env-driven) to go live.
 *
 * ── UX CAVEAT ─────────────────────────────────────────────────────────────
 * TON Connect's connect UI is wallet-app-owned (QR / deeplink). This adapter
 * delegates to TON Connect's modal for the chosen wallet and resolves the
 * account once the bridge reports a connection — so the bridge's connect
 * modal hands the last mile to TON Connect rather than faking a popup. See
 * the research note for the full rationale.
 *
 * NO signing: TON Connect is used for detection + connect only. Signing a
 * swap is the later TON swap-routing step and is NOT wired here.
 */

import { TonConnectUI } from "@tonconnect/ui";

/**
 * Build the app's TON Connect handle (the DI shape tonDiscovery.js consumes).
 *
 * @param {{manifestUrl?: string|null, ui?: object}} [options]
 *   - manifestUrl: the dApp's hosted tonconnect-manifest.json URL. REQUIRED
 *     (fail-closed — no manifest, no connector).
 *   - ui: inject a pre-built TonConnectUI (tests/dev); otherwise one is built.
 * @returns {object|null} the handle, or null when there is no window/manifest.
 */
export function createTonConnectHandle({ manifestUrl = null, ui = null } = {}) {
  if (typeof window === "undefined") return null;
  const instance = ui ?? (manifestUrl ? new TonConnectUI({ manifestUrl }) : null);
  if (!instance) return null; // no manifest → fail closed to the deposit row

  return {
    /** The connectable wallet list (registry + injected wallets). */
    getWallets: () => instance.getWallets(),

    /** Subscribe to connection status changes (returns an unsubscribe fn). */
    onStatusChange: (cb) => instance.onStatusChange(cb),

    /** The current connected account, or null. */
    getAccount: () => instance.account ?? null,

    /**
     * Connect a specific wallet: open TON Connect's modal for it (falling
     * back to the general modal) and resolve the connected account. NO
     * transaction is signed — this is the connect handshake alone.
     */
    async connect(walletId) {
      if (walletId && typeof instance.openSingleWalletModal === "function") {
        await instance.openSingleWalletModal(walletId);
      } else {
        await instance.openModal();
      }
      if (instance.connected && instance.account) {
        return { address: instance.account.address, chain: instance.account.chain };
      }
      return await new Promise((resolve, reject) => {
        let off = null;
        const done = (fn) => {
          try {
            if (typeof off === "function") off();
          } catch {
            // already unsubscribed
          }
          fn();
        };
        off = instance.onStatusChange(
          (wallet) => {
            if (wallet && instance.account) {
              done(() => resolve({ address: instance.account.address, chain: instance.account.chain }));
            }
          },
          (err) => done(() => reject(err instanceof Error ? err : new Error(String(err)))),
        );
      });
    },

    /** Disconnect + clear the local session. */
    async disconnect() {
      if (typeof instance.disconnect === "function") await instance.disconnect();
    },
  };
}
