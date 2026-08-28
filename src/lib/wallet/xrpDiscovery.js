/**
 * XRP wallet discovery (Step 2.4) — the registry's XRP Ledger table.
 *
 * XRPL is mobile-first: the only browser-extension detection the registry
 * documents is Crossmark's `window.xrpl.crossmark` (❌ unmaintained).
 * GemWallet's API is the @gemwallet/api SDK with no namespaced global
 * documented — detection stays unwired (never guess). Xaman (the PRIMARY)
 * is a mobile app: no injected global; its connect path (xumm SDK QR
 * sign-in) is TODO-gated behind the WalletConnect-verification note.
 *
 * Connect adapters: EVERY XRP row is gated (Xaman → xumm SDK + API
 * credentials TODO; Joey/Bifrost → WalletConnect verify; Crossmark/
 * GemWallet → unmaintained; Ledger/Trezor → Phase 3 hardware lane; Tangem
 * → deposit-address only; deposit row → never connectable). All of them
 * reject connect() with their clearly-marked TODO — no guessed APIs, no
 * fake "mock" connects.
 *
 * MEMO RULE (memoRule.js): the THORChain memo goes in the XRPL `Memos`
 * field (NOT a destination tag). Xaman carries memoSupport "memos";
 * everyone else "verify" or "none" — the modal shows the hand-off note and
 * sends route to the deposit-address row until verified.
 *
 * NO signing: this module never signs payloads. Xaman payload signing is
 * hard-stopped (Pro lane, later step).
 */

import { XRP_WALLETS, XRP_WALLET_IDS } from "./xrpRegistry.js";

/** Default window accessor — undefined in node (nothing discovered). */
function defaultWin() {
  return typeof globalThis !== "undefined" ? globalThis.window : undefined;
}

/**
 * Namespaced-global detectors. Crossmark is the ONLY row with a documented
 * global key (window.xrpl.crossmark). Every access is defensive (`?.`).
 */
const GLOBAL_DETECTORS = Object.freeze({
  [XRP_WALLET_IDS.CROSSMARK]: (w) => Boolean(w?.xrpl?.crossmark),
});

/** Is a registry wallet installed via its namespaced global? */
export function isInstalledViaGlobal(win, walletId) {
  return Boolean(GLOBAL_DETECTORS[walletId]?.(win));
}

/**
 * Enumerate the registry's global-detected wallets from a window-like
 * object. Pure + injectable (tests pass a fake win).
 *
 * @param {object|undefined} win
 * @returns {Array<{key: string, name: string, source: "global"}>}
 */
export function enumerateGlobalWallets(win = defaultWin()) {
  if (!win) return [];
  return XRP_WALLETS.filter(
    (entry) => (entry.detection ?? "").split("+").includes("global") && !entry.hardware && !entry.depositAddress,
  )
    .filter((entry) => isInstalledViaGlobal(win, entry.id))
    .map((entry) => ({ key: entry.id, name: entry.name, source: "global" }));
}

/**
 * Create the XRP discovery handle — same shape as the other family
 * discovery handles ({ start, stop, getInstalled, getProvider }).
 *
 * @param {{win?: object, balanceFetcher?: (address: string) => Promise<number>, onChange?: (wallets: Array) => void}} [options]
 *   - win: injected window (tests). Defaults to the real window.
 *   - balanceFetcher: (address) => Promise<drops> (xrpBalance.js
 *     createXrpBalanceFetcher in the app). Defaults to null.
 */
export function createXrpDiscovery({
  win = undefined,
  balanceFetcher = null,
  onChange = () => {},
} = {}) {
  let installed = [];

  function refresh() {
    installed = enumerateGlobalWallets(win ?? defaultWin());
    onChange([...installed]);
  }

  return {
    /** Take the initial snapshot (no late-announce subscriptions — no XRP standard registry). */
    start() {
      refresh();
    },

    /** No-op (kept for handle-shape symmetry). Collected state stays readable. */
    stop() {},

    /** Snapshot: [{ key, name, source }] — registry ids. */
    getInstalled: () => [...installed],

    /**
     * Resolve an installed wallet to a WalletContext provider, or null
     * (null → the WalletContext mock fallback, e.g. the pinned Starport
     * row). Crossmark is the only installable row today; its provider
     * rejects connect() with the unmaintained note.
     */
    getProvider(walletId) {
      if (!installed.some((w) => w.key === walletId)) return null;
      return createXrpProviderAdapter({
        walletId,
        win: win ?? defaultWin(),
        balanceFetcher,
      });
    },
  };
}

/* ————————————————— provider adapters ————————————————— */

/** ⚠️ / ❌ / unwired rows: connect() rejects with the TODO — never a fake connect. */
function createUnverifiedProvider(entry) {
  const note =
    entry.todo ??
    entry.connectTodo ??
    "verify its API at build time (registry ⚠️ row — no guessed APIs)";
  return {
    family: "xrp",
    id: `xrp:${entry.id}`,
    isReal: true,
    walletName: entry.name,
    unverified: true,

    async connect() {
      throw new Error(`XRP wallet "${entry.name}" is not wired yet — ${note}`);
    },

    async disconnect() {},
  };
}

/**
 * Build the provider adapter for an XRP registry wallet.
 * Exported for tests; the discovery handle guards installed-ness first.
 *
 * Every row is TODO-gated in this discovery/session PR (Xaman needs the
 * xumm SDK + API credentials; the rest are ⚠️/❌/hardware/deposit-only) —
 * no row fakes a connect.
 *
 * @param {{walletId: string, win?: object, balanceFetcher?: Function, registry?: Array}} params
 * @returns {object|null} WalletContext-shaped provider, or null for unknown ids.
 */
export function createXrpProviderAdapter({
  walletId,
  win = defaultWin(),
  balanceFetcher = null,
  registry = XRP_WALLETS,
}) {
  const entry = registry.find((e) => e.id === walletId);
  if (!entry) return null;
  return createUnverifiedProvider(entry);
}
