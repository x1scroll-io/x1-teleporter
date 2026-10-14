/**
 * Cardano wallet discovery (CIP-30) — read window.cardano[<key>] for each
 * CIP-30 wallet. The connect modal's Cardano family discovers exactly the
 * `detection:"cip30"` rows in cardanoRegistry.js.
 *
 * Installed = the wallet's CIP-30 key is present on window.cardano. Connect
 * = `enable()` → the CIP-30 API → read the used address + balance (session
 * only; signTx/signData/submitTx are never called by the bridge — ADA sends
 * are out-of-band via the ChangeNOW deposit address).
 *
 * ISOLATION (binding): Cardano wallets must NEVER appear in the EVM list.
 * This module only ever reports CIP-30 wallets; EVM discovery is
 * EIP-6963-only.
 *
 * DI-clean: it receives `win` (or null) and the wallet table; it never
 * touches the injected globals outside the injected win. node:test injects
 * a fake window.cardano.
 */

import { CARDANO_WALLETS } from "./cardanoRegistry.js";

/** The real window when in a browser; undefined under node:test. */
function defaultWin() {
  return typeof globalThis !== "undefined" ? globalThis.window : undefined;
}

/**
 * Create the Cardano discovery handle — same shape as the other family
 * handles ({ start, stop, getInstalled, getProvider }).
 *
 * @param {{ win?: object|undefined, wallets?: Array, onChange?: (wallets:Array)=>void }} [options]
 */
export function createCardanoDiscovery({
  win = undefined,
  wallets = CARDANO_WALLETS,
  onChange = () => {},
} = {}) {
  const table = Array.isArray(wallets) ? [...wallets] : [];
  let installed = [];

  function windowCardano() {
    const w = win ?? defaultWin();
    return w && typeof w === "object" ? w.cardano : null;
  }

  function scan() {
    const cardano = windowCardano();
    const found = [];
    for (const w of table) {
      if (w.detection !== "cip30") continue;
      const injected = cardano ? cardano[w.cip30Key] : null;
      if (injected && typeof injected === "object") {
        found.push({
          key: w.id,
          name: w.name,
          cip30Key: w.cip30Key,
          installUrl: w.installUrl,
        });
      }
    }
    installed = found;
    onChange([...installed]);
  }

  return {
    start() {
      scan();
    },
    stop() {
      installed = [];
    },
    getInstalled: () => [...installed],

    /**
     * Resolve an installed wallet to a WalletContext provider, or null.
     * Connect = enable() → the CIP-30 API → used address + balance.
     * No signing is ever performed here.
     */
    getProvider(walletId) {
      const w = table.find((x) => x.id === walletId);
      if (!w || w.detection !== "cip30") return null;
      const injected = windowCardano()?.[w.cip30Key];
      if (!injected) return null;

      const provider = {
        family: "cardano",
        walletId,
        name: w.name,
        async connect() {
          const api = await injected.enable();
          const used = await api.getUsedAddresses();
          const address = Array.isArray(used) && used.length ? used[0] : null;
          let balance = null;
          try {
            const bal = await api.getBalance();
            balance = typeof bal === "string" ? BigInt(bal) : null;
          } catch {
            balance = null; // balance is best-effort; the address is what matters
          }
          return { family: "cardano", address, balance, provider: this };
        },
      };
      return provider;
    },
  };
}
