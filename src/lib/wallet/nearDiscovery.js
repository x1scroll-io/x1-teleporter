/**
 * NEAR wallet discovery (Step 2.5, Phase 2 wallet layer) — the NEAR Wallet
 * Selector. The connect modal's NEAR family discovers the modules the
 * selector exposes (see nearRegistry.js — every row is a real
 * @near-wallet-selector module).
 *
 * Installed/available = a module in `selector.store.getState().modules`
 * whose `metadata.available !== false`. The selector's module factories
 * resolve to `null` (or `available:false`) when a wallet is NOT present, so
 * `state.modules` is the connectable set. Connect =
 * `selector.wallet(id).signIn({ contractId })` → the signed-in account id
 * (session only; this module NEVER signs a transaction or message — the NEAR
 * swap lane is a later step).
 *
 * ── WHY NO DEAD CONNECT BUTTON (fail-closed) ──────────────────────────────
 * When nothing is available (no selector, non-browser, or no wallet), this
 * module reports ZERO connectable wallets. The modal then falls through to
 * the always-present deposit-address row (nearRegistry.js) — never a dead
 * Connect button.
 *
 * ── DI-CLEAN ──────────────────────────────────────────────────────────────
 * This module receives the selector handle via injection (a resolved selector
 * OR a promise that resolves to one). node:test injects a fake selector; it
 * never imports the SDK and never touches the browser. The browser-only SDK
 * factory lives in nearSelector.js (imported by the app, never by tests).
 */

import { NEAR_WALLETS } from "./nearRegistry.js";

/** Reference wallet = the module the selector may fall back to when the
 *  caller does not name one (`selector.wallet()` with no id). Not needed
 *  here — kept for documentation. */

/**
 * Create the NEAR discovery handle — same shape as the other family handles
 * ({ start, stop, getInstalled, getProvider }).
 *
 * @param {{
 *   selector?: object|Promise<object>|null, // a NEAR Wallet Selector (or a promise for one)
 *   contractId?: string|null,               // the contractId the connect handshake requests a key for
 *   balanceFetcher?: ((accountId: string) => Promise<bigint>) | null,
 *   onChange?: (wallets: Array) => void,
 * }} [options]
 */
export function createNearDiscovery({
  selector = null,
  contractId = null,
  balanceFetcher = null,
  onChange = () => {},
} = {}) {
  let installed = [];
  let offs = [];
  let live = null; // the resolved selector object (null until resolved)

  /** Read the selector's modules → the connectable wallet entries. */
  function scan() {
    if (!live) {
      installed = [];
      onChange([]);
      return;
    }
    let modules = [];
    try {
      modules = live?.store?.getState?.()?.modules ?? [];
    } catch {
      modules = [];
    }
    const table = new Map(NEAR_WALLETS.map((w) => [w.id, w]));
    const found = [];
    for (const m of Array.isArray(modules) ? modules : []) {
      if (!m || typeof m.id !== "string") continue;
      if (m.metadata?.available === false) continue; // explicitly unavailable
      const meta = table.get(m.id);
      found.push({
        key: m.id,
        name: meta?.name ?? m.metadata?.name ?? m.id,
        source: "near-selector",
      });
    }
    installed = found;
    onChange([...installed]);
  }

  /** Normalize a subscription return (rxjs Subscription | function | void). */
  function asOff(sub) {
    if (typeof sub === "function") return sub;
    if (sub && typeof sub.unsubscribe === "function") return () => sub.unsubscribe();
    return null;
  }

  /** Attach to a resolved selector: subscribe to sign-in changes + scan. */
  function attach(sel) {
    live = sel;
    if (sel && typeof sel.on === "function") {
      for (const evt of ["signedIn", "signedOut", "accountsChanged"]) {
        try {
          const off = asOff(sel.on(evt, scan));
          if (off) offs.push(off);
        } catch {
          // a selector without this event — nothing to do
        }
      }
    }
    scan();
  }

  return {
    /** Resolve the selector (sync or async) and take the initial snapshot. */
    start() {
      if (selector && typeof selector.then === "function") {
        selector
          .then((sel) => {
            if (sel) attach(sel);
            else scan();
          })
          .catch(() => {
            // selector setup failed — fail closed to "nothing connectable".
            live = null;
            installed = [];
            onChange([]);
          });
      } else if (selector) {
        attach(selector);
      } else {
        scan();
      }
    },

    /** Unsubscribe from selector events. Collected state stays readable. */
    stop() {
      for (const off of offs) {
        try {
          off();
        } catch {
          // already removed
        }
      }
      offs = [];
    },

    /** Snapshot: [{ key, name, source }] — NEAR Wallet Selector module ids. */
    getInstalled: () => [...installed],

    /**
     * Resolve an available wallet to a WalletContext provider, or null
     * (null → the WalletContext mock/deposit fallback). Connect is the
     * selector's sign-in handshake → the account id (+ best-effort balance).
     * NO transaction/message is ever signed here.
     */
    getProvider(walletId) {
      const entry = NEAR_WALLETS.find((w) => w.id === walletId);
      if (!entry || entry.depositAddress) return null;
      if (!live) return null;
      if (!installed.some((w) => w.key === walletId)) return null; // not available → null

      const sel = live;
      const name = entry.name;
      return {
        family: "near",
        id: `near:${walletId}`,
        isReal: true,
        walletName: name,

        async connect() {
          const wallet = await sel.wallet(walletId);
          if (!wallet || typeof wallet.signIn !== "function") {
            throw new Error(`NEAR wallet "${name}" is not connectable (no sign-in)`);
          }
          const accounts = await wallet.signIn(contractId ? { contractId } : {});
          const address = Array.isArray(accounts) && accounts.length ? accounts[0]?.accountId ?? null : null;
          if (!address) throw new Error(`NEAR wallet "${name}" returned no account`);
          let balance = null;
          try {
            balance = balanceFetcher ? await balanceFetcher(address) : null;
          } catch {
            balance = null; // balance is best-effort; the account id is what matters
          }
          return { family: "near", address, balance, provider: this };
        },

        async disconnect() {
          try {
            const wallet = await sel.wallet(walletId);
            if (wallet && typeof wallet.signOut === "function") await wallet.signOut();
          } catch {
            // already signed out
          }
        },
      };
    },
  };
}
