/**
 * LaserEyes handle (Step 2.3) — the ONE place the app touches the real
 * @omnisat/lasereyes client.
 *
 * docs/WALLET-REGISTRY.md (Bitcoin section) mandates LaserEyes: "it already
 * ships one explicit provider per wallet below and handles the bare injected
 * `unisat` global impersonation problem. Use it; do not write these
 * adapters by hand." The
 * registry's provider table maps straight onto LaserEyes provider types —
 * see bitcoinRegistry.js `laserEyesProvider`.
 *
 * THIS module is browser-only by construction:
 *   - It imports @omnisat/lasereyes (which pulls in its React entry) and
 *     constructs a LaserEyesClient. node:test never imports it — the wallet
 *     layer injects a laserEyes handle (or a fake) via DI (bitcoinDiscovery
 *     / walletDiscovery), so tests stay hermetic.
 *   - The client's connect() handshake needs a real extension (Xverse
 *     sats-connect RPC, Phantom requestAccounts, …) — that is the
 *     could-not-test item (operator preview check with real wallets).
 *
 * Address rule (binding, docs/WALLET-REGISTRY.md): ALWAYS the PAYMENT
 * address (`bc1q` native segwit, purpose "payment"). NEVER the ordinals /
 * taproot address (`bc1p`). LaserEyes stores BOTH — `address` (ordinals)
 * and `paymentAddress` (payment). `extractPaymentSession` below reads ONLY
 * `paymentAddress` and throws when it is missing; it never falls back to
 * the ordinals address. Sending from the wrong one burns inscriptions.
 *
 * NO signing here: this module exposes connect/disconnect/balance-read
 * only. PSBT signing is hard-stopped (Pro lane, later step) — the client
 * has signPsbt() but nothing in src/ calls it.
 */

import { LaserEyesClient, createStores } from "@omnisat/lasereyes";

/**
 * Pull the payment session out of a LaserEyes store snapshot.
 * Pure + exported so tests can pin the exact store shape we depend on.
 *
 * @param {{address?: string, paymentAddress?: string, accounts?: string[]}} store
 *   the value of the LaserEyes $store map after connect().
 * @returns {{paymentAddress: string, ordinalsAddress?: string, accounts: string[]}}
 * @throws {Error} when no payment address resolved — the caller must NEVER
 *   substitute the ordinals address.
 */
export function extractPaymentSession(store) {
  const paymentAddress = store?.paymentAddress;
  if (typeof paymentAddress !== "string" || paymentAddress.length === 0) {
    throw new Error(
      "Bitcoin wallet returned no payment address (bc1q) — refusing to use the ordinals address",
    );
  }
  return {
    paymentAddress,
    ordinalsAddress: typeof store?.address === "string" ? store.address : undefined,
    accounts: Array.isArray(store?.accounts) ? [...store.accounts] : [],
  };
}

/**
 * Create the LaserEyes handle the bitcoin provider adapters use.
 *
 * @param {{client?: LaserEyesClient}} [options] injectable client (tests /
 *   advanced use). Defaults to a lazily-created real client backed by
 *   createStores().
 * @returns {{
 *   connect: (providerType: string) => Promise<{paymentAddress: string, ordinalsAddress?: string, accounts: string[]}>,
 *   disconnect: () => void,
 *   client: LaserEyesClient,
 * }}
 */
export function createLaserEyesHandle({ client = null } = {}) {
  const laserEyes = client ?? new LaserEyesClient(createStores());

  return {
    client: laserEyes,

    /**
     * Connect a specific LaserEyes provider (per-wallet, per the registry
     * table) and resolve the PAYMENT address.
     *
     * @param {string} providerType one of the @omnisat/lasereyes provider
     *   constants (XVERSE, UNISAT, LEATHER, OKX, PHANTOM, MAGIC_EDEN, WIZZ,
     *   OYL, ORANGE, OP_NET).
     */
    async connect(providerType) {
      await laserEyes.connect(providerType);
      return extractPaymentSession(laserEyes.$store.get());
    },

    /** Release the LaserEyes session. */
    disconnect() {
      laserEyes.disconnect();
    },
  };
}
