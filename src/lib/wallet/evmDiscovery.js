/**
 * EVM wallet discovery via wagmi EIP-6963 support (Step 2.2 — wallet
 * discovery + connect modal).
 *
 * Per docs/BRIEF.md (Cross-cutting — Wallet layer): EVM discovery uses
 * EIP-6963 (eip6963:announceProvider events) and wagmi handles that out of
 * the box — we use wagmi, we do NOT hand-roll the protocol.
 *
 * How it works here:
 *   - `createDefaultEvmConfig()` builds a wagmi config with
 *     `multiInjectedProviderDiscovery: true` (wagmi's default). wagmi listens
 *     for `eip6963:announceProvider` on window, dispatches
 *     `eip6963:requestProvider`, dedupes by uuid (the `mipd` store), and
 *     exposes every discovered wallet as a CONNECTOR on `config.connectors`.
 *     Late-injecting wallets are added reactively.
 *   - The static `injected()` connector is included (canonical wagmi setup):
 *     it is the legacy fallback for wallets that only expose the injected
 *     global. wagmi reads that global itself — OUR code never does.
 *   - `createEvmDiscovery()` wraps a wagmi config in the same discovery
 *     handle shape as solanaDiscovery.js: `{ start, stop, getProviders }`
 *     with an onChange callback. Snapshot entries are
 *     `{ uuid, name, icon, rdns, provider }` where `provider` is the wagmi
 *     connector — the connect flow goes through `connector.connect()`.
 *
 * There is NO code anywhere in this module (or in src/) that reads the
 * injected EVM global directly — see noWindowProbe.test.js, which fails the
 * build if that pattern (or the Solana/Bitcoin/Tron injected globals) ever
 * appears in src/.
 */

import { createConfig, createStorage, http, injected, noopStorage } from "wagmi";
import { mainnet } from "viem/chains";

/** The chain wagmi needs configured for the discovery config. */
export const EVM_DISCOVERY_CHAINS = Object.freeze([mainnet]);

/**
 * Build the canonical wagmi config for EIP-6963 discovery.
 *
 * `multiInjectedProviderDiscovery` (default true) is what turns EIP-6963
 * announce events into connectors. ssr stays FALSE deliberately: with ssr
 * wagmi skips EIP-6963 providers in the INITIAL connector list, which would
 * miss wallets that injected before the app loaded. noopStorage keeps the
 * config side-effect free (discovery never persists/rehydrates connections)
 * and makes hydration synchronous-ish so late announces register fast.
 *
 * @param {{connectors?: Array}} [options] connectors to seed the config
 *   (defaults to the injected() fallback connector). Tests inject the mock
 *   connector or none.
 */
export function createDefaultEvmConfig({ connectors = [injected()] } = {}) {
  return createConfig({
    chains: EVM_DISCOVERY_CHAINS,
    connectors,
    transports: { [mainnet.id]: http() },
    multiInjectedProviderDiscovery: true,
    // noopStorage: discovery never persists/rehydrates connections — the
    // config exists purely to surface EIP-6963 connectors.
    storage: createStorage({ storage: noopStorage }),
  });
}

/**
 * Create an EVM discovery handle around a wagmi config.
 *
 * @param {{config?: object, onChange?: (providers: Array) => void}} [options]
 *   - config: a wagmi config (from createDefaultEvmConfig or a test config).
 *     Defaults to createDefaultEvmConfig().
 *   - onChange: called with a fresh snapshot whenever the connector list
 *     changes (a wallet announced late), and once from start().
 * @returns {{start: () => void, stop: () => void, getProviders: () => Array}}
 */
export function createEvmDiscovery({ config = null, onChange = () => {} } = {}) {
  const wagmiConfig = config ?? createDefaultEvmConfig();
  const offs = [];

  function snapshot() {
    return wagmiConfig.connectors.map((connector) => ({
      uuid: connector.uid,
      name: connector.name,
      icon: connector.icon,
      // For EIP-6963-discovered wallets wagmi sets the connector id to the
      // wallet's rdns; the static injected() fallback is id "injected".
      rdns: typeof connector.rdns === "string" ? connector.rdns : connector.id,
      provider: connector,
    }));
  }

  return {
    /** Subscribe to connector changes and emit the initial snapshot. */
    start() {
      const unsubscribe = wagmiConfig._internal?.connectors?.subscribe?.(() => onChange(snapshot()));
      if (typeof unsubscribe === "function") offs.push(unsubscribe);
      onChange(snapshot());
    },

    /** Unsubscribe. Already-collected providers stay readable. */
    stop() {
      for (const off of offs) {
        try {
          off();
        } catch {
          // listener already removed
        }
      }
      offs.length = 0;
    },

    /** Snapshot of discovered providers: [{uuid, name, icon, rdns, provider}]. */
    getProviders: snapshot,
  };
}

/**
 * Wrap a discovered EVM entry (wagmi connector) into the WalletContext
 * provider shape: `{ family, id, isReal, connect, disconnect }`.
 *
 * connect() runs the wagmi connector handshake and resolves the first
 * account as the wallet address. Connection only — no signing, no
 * transaction building (Phase 3 territory).
 *
 * @param {{uuid: string, name: string, icon?: string, rdns?: string, provider: object}} discovered
 * @returns {{family: "evm", id: string, isReal: true, connect: () => Promise<{family, address, provider}>, disconnect: () => Promise<void>}}
 */
export function createEvmProviderAdapter(discovered) {
  const { provider, rdns, uuid, name } = discovered;
  return {
    family: "evm",
    id: `eip6963:${rdns ?? uuid}`,
    isReal: true,
    walletName: name,
    discovered,

    async connect() {
      if (!provider || typeof provider.connect !== "function") {
        throw new Error(`EIP-6963 wallet "${name}" injected no usable connector`);
      }
      const result = await provider.connect();
      const address = result?.accounts?.[0];
      if (typeof address !== "string" || address.length === 0) {
        throw new Error(`EIP-6963 wallet "${name}" returned no accounts`);
      }
      return { family: "evm", address, provider: this };
    },

    async disconnect() {
      // Release the wagmi connector session. Some connectors (mock) are
      // no-ops; injected wallets own their session UI.
      if (typeof provider.disconnect === "function") {
        try {
          await provider.disconnect();
        } catch {
          // already disconnected
        }
      }
    },
  };
}
