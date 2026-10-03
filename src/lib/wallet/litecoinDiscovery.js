/**
 * Litecoin wallet discovery (Step 2.4) — the registry's Litecoin table,
 * implemented with namespaced-global detection + minimal per-table connect
 * adapters.
 *
 * Detection (docs/WALLET-REGISTRY.md, Litecoin table): namespaced globals
 * only — window.xfi.litecoin (Ctrl) and window.litescribe (Litescribe).
 * There is no Wallet Standard registration for LTC and no bare legacy
 * global to impersonate, so no impersonation rule is needed here.
 *
 * Connect adapters: Ctrl connects through the registry's documented
 * xfi-family API (request({ method: "request_accounts" }) — the same
 * surface the Bitcoin table documents for window.xfi.bitcoin). Every other
 * row is either a ⚠️ row (Enkrypt/OKX/Trust), a hardware row
 * (Ledger/Trezor — Phase 3 XChainJS lane), or the deposit-address row —
 * ALL of them reject connect() with their clearly-marked TODO. No guessed
 * APIs, no fake "mock" connects.
 *
 * MEMO RULE (memoRule.js): Ctrl carries memoSupport "op_return"; every
 * other connectable row carries "verify" — the modal shows the hand-off
 * note and sends route to the deposit-address row until verified.
 *
 * NO signing: adapters connect + read the address balance only. Sending /
 * memo-on-send is hard-stopped (Pro lane, later step).
 */

import {
  LITECOIN_WALLETS,
  LITECOIN_WALLET_IDS,
} from "./litecoinRegistry.js";

/** Default window accessor — undefined in node (nothing discovered). */
function defaultWin() {
  return typeof globalThis !== "undefined" ? globalThis.window : undefined;
}

/**
 * Namespaced-global detectors, one per registry row with a `global`
 * detection key. Every access is defensive (`?.`) and namespaced.
 */
const GLOBAL_DETECTORS = Object.freeze({
  [LITECOIN_WALLET_IDS.CTRL]: (w) => Boolean(w?.xfi?.litecoin),
  [LITECOIN_WALLET_IDS.LITESCRIBE]: (w) => Boolean(w?.litescribe),
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
  return LITECOIN_WALLETS.filter(
    (entry) => (entry.detection ?? "").split("+").includes("global") && !entry.hardware && !entry.depositAddress,
  )
    .filter((entry) => isInstalledViaGlobal(win, entry.id))
    .map((entry) => ({ key: entry.id, name: entry.name, source: "global" }));
}

/**
 * Create the Litecoin discovery handle — same shape as bitcoinDiscovery /
 * evmDiscovery / solanaDiscovery ({ start, stop, getInstalled, getProvider }).
 *
 * @param {{win?: object, balanceFetcher?: (address: string) => Promise<number>, onChange?: (wallets: Array) => void}} [options]
 *   - win: injected window (tests). Defaults to the real window.
 *   - balanceFetcher: (address) => Promise<sats> (altcoinBalance.js
 *     createLtcBalanceFetcher in the app). Defaults to null (connect then
 *     returns no balance).
 */
export function createLitecoinDiscovery({
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
    /** Take the initial snapshot (no late-announce subscriptions — LTC has no registry). */
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
     * row).
     */
    getProvider(walletId) {
      if (!installed.some((w) => w.key === walletId)) return null;
      return createLitecoinProviderAdapter({
        walletId,
        win: win ?? defaultWin(),
        balanceFetcher,
      });
    },
  };
}

/* ————————————————— provider adapters ————————————————— */

/** First address out of a request_accounts-style result (string or {address}). */
export function firstLtcAddress(accounts) {
  if (!Array.isArray(accounts)) return undefined;
  for (const entry of accounts) {
    if (typeof entry === "string" && entry.length > 0) return entry;
    if (entry && typeof entry.address === "string" && entry.address.length > 0) {
      return entry.address;
    }
  }
  return undefined;
}

/** ⚠️ / unwired rows: connect() rejects with the verification TODO — never a fake connect. */
function createUnverifiedProvider(entry) {
  const note =
    entry.todo ??
    entry.connectTodo ??
    "verify its API at build time (registry ⚠️ row — no guessed APIs)";
  return {
    family: "litecoin",
    id: `litecoin:${entry.id}`,
    isReal: true,
    walletName: entry.name,
    unverified: true,

    async connect() {
      throw new Error(`Litecoin wallet "${entry.name}" is not wired yet — ${note}`);
    },

    async disconnect() {},
  };
}

/**
 * Ctrl (ex-XDEFI) — the registry's only clean LTC→THORChain extension
 * path. Connect API: request({ method: "request_accounts" }) on
 * window.xfi.litecoin (the same xfi-family surface the Bitcoin table
 * documents for window.xfi.bitcoin). Returns the user's selected LTC
 * addresses; the first is the session address. Memo-on-send is a later
 * THORChain-lane step — NO signing here.
 */
function createCtrlAdapter(entry, { win, balanceFetcher }) {
  return {
    family: "litecoin",
    id: "litecoin:ctrl",
    isReal: true,
    walletName: entry.name,

    async connect() {
      const api = win?.xfi?.litecoin;
      if (!api || typeof api.request !== "function") {
        throw new Error("Ctrl (ex-XDEFI) is not available (window.xfi.litecoin missing)");
      }
      const result = await api.request({ method: "request_accounts" });
      const accounts = Array.isArray(result) ? result : result?.addresses;
      const address = firstLtcAddress(accounts);
      if (!address) throw new Error("Ctrl (ex-XDEFI) returned no accounts");
      const balance = balanceFetcher ? await balanceFetcher(address) : undefined;
      return { family: "litecoin", address, balance, provider: this };
    },

    async disconnect() {},
  };
}

/**
 * Build the provider adapter for a Litecoin registry wallet.
 * Exported for tests; the discovery handle guards installed-ness first.
 *
 * @param {{walletId: string, win?: object, balanceFetcher?: Function, registry?: Array}} params
 * @returns {object|null} WalletContext-shaped provider, or null for unknown ids.
 */
export function createLitecoinProviderAdapter({
  walletId,
  win = defaultWin(),
  balanceFetcher = null,
  registry = LITECOIN_WALLETS,
}) {
  const entry = registry.find((e) => e.id === walletId);
  if (!entry) return null;

  // ⚠️ rows and connect-gated rows (Litescribe: API unverified) never fake
  // a connect — reject with the verification note.
  if (entry.status === "verify" || entry.connectTodo) return createUnverifiedProvider(entry);

  if (walletId === LITECOIN_WALLET_IDS.CTRL) {
    return createCtrlAdapter(entry, { win, balanceFetcher });
  }

  // Hardware / deposit-address / anything else unwired: no connect.
  return createUnverifiedProvider(entry);
}
