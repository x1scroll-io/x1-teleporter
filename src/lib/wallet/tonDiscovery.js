/**
 * TON wallet discovery (Step 2.5, Phase 2 wallet layer) — TON Connect. The
 * connect modal's TON family discovers the wallets TON Connect exposes (see
 * tonRegistry.js — every row's id is a real TON Connect `appName`).
 *
 * ── HOW TON CONNECT WORKS (and why discovery looks like this) ─────────────
 * TON Connect is a BRIDGE protocol: the dApp and the wallet app communicate
 * through a bridge URL. There is no browser-extension global to probe — the
 * wallet list is the CONNECTABLE SET (`getWallets()`), not a strict
 * "installed extensions" list. Discovery therefore reports the TON Connect
 * wallet list as the connectable set; connect = the TON Connect connect
 * handshake (a QR / universal link / deep link the wallet app answers) →
 * the account address (session only; NO transaction is ever signed here).
 *
 * ── UX CAVEAT (documented — see docs/NEAR-TON-DEX-RESEARCH.md) ────────────
 * TON Connect's connect UI (QR code / deeplink) is wallet-app-owned and does
 * not always fit a browser connect modal. The browser adapter (tonConnect.js)
 * delegates to TON Connect's own modal for the chosen wallet; when the bridge
 * is not wired, discovery reports ZERO wallets and the modal falls through to
 * the always-present deposit-address row. Never a dead Connect button.
 *
 * ── DI-CLEAN ──────────────────────────────────────────────────────────────
 * This module receives the TON Connect handle via injection. node:test
 * injects a fake handle; the module never imports the SDK and never touches
 * the browser. The browser-only SDK factory lives in tonConnect.js.
 */

import { TON_WALLETS } from "./tonRegistry.js";

/**
 * Create the TON discovery handle — same shape as the other family handles
 * ({ start, stop, getInstalled, getProvider }).
 *
 * @param {{
 *   tonConnect?: {
 *     getWallets: () => Array|Promise<Array>,
 *     connect: (walletId?: string) => Promise<{address: string}|null>,
 *     onStatusChange?: (cb: Function) => (Function|void),
 *     disconnect?: () => Promise<void>,
 *   }|Promise<object>|null,
 *   balanceFetcher?: ((address: string) => Promise<bigint>) | null,
 *   onChange?: (wallets: Array) => void,
 * }} [options]
 */
export function createTonDiscovery({
  tonConnect = null,
  balanceFetcher = null,
  onChange = () => {},
} = {}) {
  let installed = [];
  let offs = [];
  let live = null; // the resolved TON Connect handle
  let walletList = []; // the connectable set (from getWallets)

  function scan() {
    if (!live) {
      installed = [];
      onChange([]);
      return;
    }
    const table = new Map(TON_WALLETS.map((w) => [w.id, w]));
    const found = [];
    for (const w of Array.isArray(walletList) ? walletList : []) {
      const id = w?.appName ?? w?.app_name;
      if (typeof id !== "string") continue;
      const meta = table.get(id);
      found.push({
        key: id,
        name: meta?.name ?? w.name ?? id,
        source: "ton-connect",
      });
    }
    installed = found;
    onChange([...installed]);
  }

  function loadWallets() {
    let res;
    try {
      res = live.getWallets();
    } catch {
      res = null;
    }
    if (res && typeof res.then === "function") {
      res
        .then((list) => {
          walletList = Array.isArray(list) ? list : [];
          scan();
        })
        .catch(() => {
          walletList = [];
          scan();
        });
    } else {
      walletList = Array.isArray(res) ? res : [];
      scan();
    }
  }

  function asOff(sub) {
    if (typeof sub === "function") return sub;
    if (sub && typeof sub.unsubscribe === "function") return () => sub.unsubscribe();
    return null;
  }

  function attach(sel) {
    live = sel;
    if (sel && typeof sel.onStatusChange === "function") {
      try {
        const off = asOff(sel.onStatusChange(() => scan()));
        if (off) offs.push(off);
      } catch {
        // no status subscription — nothing to do
      }
    }
    loadWallets();
  }

  return {
    /** Resolve the TON Connect handle (sync or async) + take the initial snapshot. */
    start() {
      if (tonConnect && typeof tonConnect.then === "function") {
        tonConnect
          .then((sel) => {
            if (sel) attach(sel);
            else scan();
          })
          .catch(() => {
            live = null;
            installed = [];
            walletList = [];
            onChange([]);
          });
      } else if (tonConnect) {
        attach(tonConnect);
      } else {
        scan();
      }
    },

    /** Unsubscribe from TON Connect status changes. Collected state stays readable. */
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

    /** Snapshot: [{ key, name, source }] — TON Connect appNames. */
    getInstalled: () => [...installed],

    /**
     * Resolve a connectable wallet to a WalletContext provider, or null
     * (null → the WalletContext mock/deposit fallback). Connect is the TON
     * Connect handshake → the account address (+ best-effort balance). NO
     * transaction is ever signed here.
     */
    getProvider(walletId) {
      const entry = TON_WALLETS.find((w) => w.id === walletId);
      if (!entry || entry.depositAddress) return null;
      if (!live) return null;
      if (!installed.some((w) => w.key === walletId)) return null; // not in the connectable set → null

      const handle = live;
      const name = entry.name;
      return {
        family: "ton",
        id: `ton:${walletId}`,
        isReal: true,
        walletName: name,

        async connect() {
          const account = await handle.connect(walletId);
          const address = account?.address ?? null;
          if (!address) throw new Error(`TON wallet "${name}" returned no account`);
          let balance = null;
          try {
            balance = balanceFetcher ? await balanceFetcher(address) : null;
          } catch {
            balance = null; // balance is best-effort; the address is what matters
          }
          return { family: "ton", address, balance, provider: this };
        },

        async disconnect() {
          if (typeof handle.disconnect !== "function") return;
          try {
            await handle.disconnect();
          } catch {
            // already disconnected
          }
        },
      };
    },
  };
}
