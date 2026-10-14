/**
 * Bitcoin wallet discovery (Step 2.3) — the registry's Bitcoin table,
 * implemented with LaserEyes as the provider abstraction.
 *
 * Detection order (docs/WALLET-REGISTRY.md, Bitcoin collision rules —
 * BINDING):
 *   1. Wallet Standard registrations for Bitcoin (wallets whose `chains`
 *      include `bitcoin:*`).
 *   2. Namespaced globals (window.XverseProviders.BitcoinProvider,
 *      window.okxwallet.bitcoin, window.bitkeep.unisat, window.wizz,
 *      window.phantom.bitcoin, window.magicEden.bitcoin,
 *      window.LeatherProvider, window.xfi.bitcoin, window.oyl,
 *      window.OrangeWalletProviders…, window.opnet).
 *   3. Bare window.unisat — counts as REAL Unisat only when no wallet known
 *      to impersonate it (Bitget / OKX / Wizz, detected via their own
 *      namespaced keys) is present. See detectBareUnisat().
 *
 * `window.unisat` is the ONE legacy injected global this module is
 * sanctioned to read (it implements exactly the registry's impersonation
 * rule). noWindowProbe.test.js bans `window.unisat` everywhere else and
 * allowlists this file (plus the registry data file that documents the
 * key) — see BITCOIN_UNISAT_ALLOWLIST there.
 *
 * LaserEyes role: the registry mandates @omnisat/lasereyes as the provider
 * abstraction ("use it; do not write these adapters by hand"). Wallets with
 * a `laserEyesProvider` in bitcoinRegistry.js connect through the injected
 * laserEyes handle (laserEyesHandle.js — the real client is browser-only;
 * tests inject a fake). Wallets LaserEyes does NOT ship (Bitget via
 * window.bitkeep.unisat, Ctrl via window.xfi.bitcoin) get a MINIMAL
 * per-table connect adapter below — the exact API from the registry table,
 * nothing more, never a generic fallback. ⚠️ rows with an unverified API
 * surface reject connect() with their TODO note (no guessed APIs, and no
 * fake "mock" connect either).
 *
 * NO signing: adapters connect + read the payment-address balance only.
 * PSBT signing is hard-stopped (Pro lane, later step).
 */

import { getWallets } from "@wallet-standard/app";
import {
  BITCOIN_WALLETS,
  BITCOIN_WALLET_IDS,
  BITCOIN_STANDARD_NAME_MAP,
  UNISAT_IMPERSONATORS,
} from "./bitcoinRegistry.js";

/** Wallet Standard chain namespace for Bitcoin ("bitcoin:mainnet", …). */
export const BITCOIN_CHAIN_PREFIX = "bitcoin:";

/** Default window accessor — undefined in node (nothing discovered). */
function defaultWin() {
  return typeof globalThis !== "undefined" ? globalThis.window : undefined;
}

/**
 * Namespaced-global detectors, one per registry row with a `global`
 * detection key. Every access is defensive (`?.`) and namespaced — never
 * the bare legacy globals the noWindowProbe bans.
 */
const GLOBAL_DETECTORS = Object.freeze({
  [BITCOIN_WALLET_IDS.XVERSE]: (w) => Boolean(w?.XverseProviders?.BitcoinProvider),
  [BITCOIN_WALLET_IDS.OKX]: (w) => Boolean(w?.okxwallet?.bitcoin),
  [BITCOIN_WALLET_IDS.BITGET]: (w) => Boolean(w?.bitkeep?.unisat),
  [BITCOIN_WALLET_IDS.WIZZ]: (w) => Boolean(w?.wizz),
  [BITCOIN_WALLET_IDS.PHANTOM]: (w) => Boolean(w?.phantom?.bitcoin),
  [BITCOIN_WALLET_IDS.MAGIC_EDEN]: (w) => Boolean(w?.magicEden?.bitcoin),
  [BITCOIN_WALLET_IDS.LEATHER]: (w) => Boolean(w?.LeatherProvider),
  [BITCOIN_WALLET_IDS.CTRL]: (w) => Boolean(w?.xfi?.bitcoin),
  [BITCOIN_WALLET_IDS.OYL]: (w) => Boolean(w?.oyl),
  [BITCOIN_WALLET_IDS.ORANGE]: (w) =>
    Boolean(
      w?.OrangeWalletProviders?.OrangeBitcoinProvider ||
        w?.OrangeBitcoinProvider ||
        w?.OrangecryptoProviders?.BitcoinProvider,
    ),
  [BITCOIN_WALLET_IDS.OP_NET]: (w) => Boolean(w?.opnet),
});

/** Is a registry wallet installed via its namespaced global? */
export function isInstalledViaGlobal(win, walletId) {
  return Boolean(GLOBAL_DETECTORS[walletId]?.(win));
}

/**
 * The three-step impersonation rule for bare `window.unisat` (registry
 * collision rules, step 3): the bare global counts as REAL Unisat only when
 * no wallet known to impersonate it — detected via ITS OWN namespaced key
 * (Bitget → window.bitkeep.unisat, OKX → window.okxwallet.bitcoin, Wizz →
 * window.wizz) — is present. This is the only place in src/ that reads the
 * bare global.
 *
 * @param {object|undefined} win injected window (tests pass a fake object;
 *   defaults to the real window).
 * @returns {boolean} true when the bare global is present AND not
 *   impersonated.
 */
export function detectBareUnisat(win = defaultWin()) {
  if (!win || !win.unisat) return false;
  const impersonator = UNISAT_IMPERSONATORS.find((id) => isInstalledViaGlobal(win, id));
  return impersonator === undefined;
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
  return BITCOIN_WALLETS.filter(
    (entry) =>
      // "global" or "global+standard" (Xverse, Phantom register BOTH ways)
      (entry.detection ?? "").split("+").includes("global") &&
      !entry.hardware &&
      !entry.depositAddress,
  )
    .filter((entry) => isInstalledViaGlobal(win, entry.id))
    .map((entry) => ({ key: entry.id, name: entry.name, source: "global" }));
}

/**
 * Wallet Standard registrations that announce Bitcoin chains (step 1 of
 * the detection order). Known names map to registry ids; unknown bitcoin
 * wallets surface as `standard:<name>` extras (never hidden, per the
 * "every announced provider gets its own entry" rule) with no connect
 * adapter until the registry gains a row for them.
 *
 * @param {{get: () => Array}|null} registry Wallet Standard Wallets API.
 * @returns {Array<{key: string, name: string, source: "standard"}>}
 */
export function enumerateStandardBitcoinWallets(registry) {
  const wallets = registry?.get?.() ?? [];
  const found = [];
  for (const wallet of wallets) {
    const chains = Array.isArray(wallet?.chains) ? wallet.chains : [];
    if (!chains.some((c) => typeof c === "string" && c.startsWith(BITCOIN_CHAIN_PREFIX))) {
      continue;
    }
    const name = typeof wallet?.name === "string" ? wallet.name : "Unknown";
    const id = BITCOIN_STANDARD_NAME_MAP[name.toLowerCase()];
    found.push({ key: id ?? `standard:${name}`, name, source: "standard" });
  }
  return found;
}

/**
 * Full installed-wallet enumeration in registry detection order
 * (standard → namespaced globals → bare window.unisat), deduped by key.
 * Pure — exported for direct testing.
 *
 * @param {{win?: object, standardRegistry?: object}} [deps]
 * @returns {Array<{key: string, name: string, source: string}>}
 */
export function enumerateInstalledBitcoinWallets({ win = defaultWin(), standardRegistry = null } = {}) {
  const byKey = new Map();
  for (const wallet of enumerateStandardBitcoinWallets(standardRegistry)) {
    byKey.set(wallet.key, wallet);
  }
  for (const wallet of enumerateGlobalWallets(win)) {
    if (!byKey.has(wallet.key)) byKey.set(wallet.key, wallet);
  }
  // Step 3: bare window.unisat — impersonation-aware.
  if (detectBareUnisat(win) && !byKey.has(BITCOIN_WALLET_IDS.UNISAT)) {
    byKey.set(BITCOIN_WALLET_IDS.UNISAT, {
      key: BITCOIN_WALLET_IDS.UNISAT,
      name: "Unisat",
      source: "unisat",
    });
  }
  return [...byKey.values()];
}

/**
 * Create the Bitcoin discovery handle — same shape as evmDiscovery /
 * solanaDiscovery ({ start, stop, getInstalled, getProvider }).
 *
 * @param {{win?: object, standardRegistry?: object, laserEyes?: object, balanceFetcher?: (address: string) => Promise<number>, onChange?: (wallets: Array) => void}} [options]
 *   - win: injected window (tests). Defaults to the real window.
 *   - standardRegistry: Wallet Standard Wallets API ({ get, on }). Defaults
 *     to the real browser registry — only when a window exists.
 *   - laserEyes: the LaserEyes handle (laserEyesHandle.js) used to connect
 *     LaserEyes-covered wallets. Tests inject a fake; the app passes
 *     createLaserEyesHandle().
 *   - balanceFetcher: (paymentAddress) => Promise<sats>. Defaults to null
 *     (connect then returns no balance); the app passes
 *     createBtcBalanceFetcher().
 */
export function createBitcoinDiscovery({
  win = undefined,
  standardRegistry = null,
  laserEyes = null,
  balanceFetcher = null,
  onChange = () => {},
} = {}) {
  const hasWindow = Boolean(win ?? defaultWin());
  // Mirror solanaDiscovery: the real Wallet Standard registry is a browser
  // singleton — only touch it when a window exists; tests inject a fake.
  const source = standardRegistry ?? (hasWindow ? getWallets() : null);

  let installed = [];
  let offs = [];

  function refresh() {
    installed = enumerateInstalledBitcoinWallets({ win: win ?? defaultWin(), standardRegistry: source });
    onChange([...installed]);
  }

  return {
    /** Subscribe to registry changes and take the initial snapshot. */
    start() {
      if (source?.on) {
        offs.push(source.on("register", refresh));
        offs.push(source.on("unregister", refresh));
      }
      refresh();
    },

    /** Unsubscribe. Collected state stays readable. */
    stop() {
      for (const off of offs) {
        try {
          off();
        } catch {
          // listener already removed
        }
      }
      offs = [];
    },

    /** Snapshot: [{ key, name, source }] — registry ids + standard extras. */
    getInstalled: () => [...installed],

    /**
     * Resolve an installed wallet to a WalletContext provider, or null
     * (null → the WalletContext mock fallback, e.g. the pinned Starport
     * row). Wallets are matched by registry id; `standard:<name>` extras
     * have no adapter and resolve to null.
     */
    getProvider(walletId) {
      if (!installed.some((w) => w.key === walletId)) return null;
      return createBitcoinProviderAdapter({
        walletId,
        win: win ?? defaultWin(),
        laserEyes,
        balanceFetcher,
      });
    },
  };
}

/* ————————————————— provider adapters ————————————————— */

/** First address out of a requestAccounts-style result (string or {address}). */
export function firstBtcAddress(accounts) {
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
    "verify its API at build time (registry ⚠️ row — no guessed APIs)";
  return {
    family: "bitcoin",
    id: `bitcoin:${entry.id}`,
    isReal: true,
    walletName: entry.name,
    unverified: true,

    async connect() {
      throw new Error(`Bitcoin wallet "${entry.name}" is not wired yet — ${note}`);
    },

    async disconnect() {},
  };
}

/**
 * LaserEyes-covered wallets (registry `laserEyesProvider` set): connect
 * through the injected LaserEyes handle. The handle resolves the PAYMENT
 * address only (extractPaymentSession throws rather than fall back to the
 * ordinals address). Balance is read for that payment address when a
 * fetcher is wired.
 */
function createLaserEyesProviderAdapter(entry, { laserEyes, balanceFetcher }) {
  return {
    family: "bitcoin",
    id: `lasereyes:${entry.laserEyesProvider}`,
    isReal: true,
    walletName: entry.name,
    laserEyesProvider: entry.laserEyesProvider,

    async connect() {
      if (!laserEyes || typeof laserEyes.connect !== "function") {
        throw new Error(
          `Bitcoin wallet "${entry.name}" is installed but the LaserEyes handle is not wired`,
        );
      }
      const session = await laserEyes.connect(entry.laserEyesProvider);
      // Payment-address rule enforced at BOTH layers: the handle resolves
      // the payment address via extractPaymentSession, and the adapter
      // re-checks so a buggy/malicious handle can never put the ordinals
      // (bc1p) address into the session.
      const paymentAddress = session?.paymentAddress;
      if (typeof paymentAddress !== "string" || paymentAddress.length === 0) {
        throw new Error(
          `Bitcoin wallet "${entry.name}" returned no payment address (bc1q) — refusing to use the ordinals address`,
        );
      }
      const balance = balanceFetcher ? await balanceFetcher(paymentAddress) : undefined;
      return { family: "bitcoin", address: paymentAddress, balance, provider: this };
    },

    async disconnect() {
      if (typeof laserEyes?.disconnect === "function") laserEyes.disconnect();
    },
  };
}

/**
 * Bitget — LaserEyes ships NO Bitget provider, so this adapter speaks the
 * registry's documented surface: Bitget injects a Unisat-compatible object
 * at window.bitkeep.unisat ("Unisat-compatible API", registry table) and is
 * NEVER reached via bare window.unisat (collision rule). requestAccounts()
 * resolves the payment address (Unisat semantics: accounts[0]).
 */
function createBitgetAdapter(entry, { win, balanceFetcher }) {
  return {
    family: "bitcoin",
    id: "bitcoin:bitget",
    isReal: true,
    walletName: entry.name,

    async connect() {
      const api = win?.bitkeep?.unisat;
      if (!api || typeof api.requestAccounts !== "function") {
        throw new Error("Bitget Wallet is not available (window.bitkeep.unisat missing)");
      }
      const accounts = await api.requestAccounts();
      const address = firstBtcAddress(accounts);
      if (!address) throw new Error("Bitget Wallet returned no accounts");
      const balance = balanceFetcher ? await balanceFetcher(address) : undefined;
      return { family: "bitcoin", address, balance, provider: this };
    },

    async disconnect() {},
  };
}

/**
 * Ctrl (ex-XDEFI) — no LaserEyes provider; the registry's connect API is
 * request({ method: "request_accounts" }) on window.xfi.bitcoin. Returns
 * the user's selected BTC addresses; payment (native segwit) first. No
 * signing — memo-on-send is a later THORChain-lane step.
 */
function createCtrlAdapter(entry, { win, balanceFetcher }) {
  return {
    family: "bitcoin",
    id: "bitcoin:ctrl",
    isReal: true,
    walletName: entry.name,

    async connect() {
      const api = win?.xfi?.bitcoin;
      if (!api || typeof api.request !== "function") {
        throw new Error("Ctrl (ex-XDEFI) is not available (window.xfi.bitcoin missing)");
      }
      const result = await api.request({ method: "request_accounts" });
      const accounts = Array.isArray(result) ? result : result?.addresses;
      const address = firstBtcAddress(accounts);
      if (!address) throw new Error("Ctrl (ex-XDEFI) returned no accounts");
      const balance = balanceFetcher ? await balanceFetcher(address) : undefined;
      return { family: "bitcoin", address, balance, provider: this };
    },

    async disconnect() {},
  };
}

/**
 * Build the provider adapter for a Bitcoin registry wallet.
 * Exported for tests; the discovery handle guards installed-ness first.
 *
 * @param {{walletId: string, win?: object, laserEyes?: object, balanceFetcher?: Function, registry?: Array}} params
 * @returns {object|null} WalletContext-shaped provider, or null for unknown ids.
 */
export function createBitcoinProviderAdapter({
  walletId,
  win = defaultWin(),
  laserEyes = null,
  balanceFetcher = null,
  registry = BITCOIN_WALLETS,
}) {
  const entry = registry.find((e) => e.id === walletId);
  if (!entry) return null;

  // ⚠️ rows never fake a connect — reject with the verification note.
  if (entry.status === "verify") return createUnverifiedProvider(entry);

  if (entry.laserEyesProvider) {
    return createLaserEyesProviderAdapter(entry, { laserEyes, balanceFetcher });
  }
  if (walletId === BITCOIN_WALLET_IDS.BITGET) {
    return createBitgetAdapter(entry, { win, balanceFetcher });
  }
  if (walletId === BITCOIN_WALLET_IDS.CTRL) {
    return createCtrlAdapter(entry, { win, balanceFetcher });
  }

  // Hardware / deposit-address / anything else unwired: no connect.
  return createUnverifiedProvider(entry);
}
