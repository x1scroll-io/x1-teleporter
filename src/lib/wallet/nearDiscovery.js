/**
 * NEAR wallet discovery (Step 2.5, Phase 2 wallet layer) — the NEAR Wallet
 * Selector. The connect modal's NEAR family discovers the modules the
 * selector exposes (see nearRegistry.js — every row is a real
 * @near-wallet-selector module).
 *
 * ── INSTALL DETECTION (fail-closed: only a POSITIVE signal counts) ─────────
 * `metadata.available` is NOT an install signal. The selector's own module
 * factories hard-code `available: true` for the web/injected wallets
 * (my-near-wallet, meteor-wallet, nightly) and report Ledger as available
 * whenever the browser exposes WebHID (`navigator.hid`) — none of which means
 * a wallet is actually present. Trusting it is the fail-open bug this module
 * fixes: every NEAR row claimed "Installed" with nothing installed.
 *
 * A wallet is reported installed ONLY when a positive PRESENCE PROBE fires
 * against the browser's injected globals (see NEAR_PRESENCE_PROBES):
 *   - meteor-wallet → window.meteorWallet   (the @meteorwallet/sdk injection;
 *     it self-reports via isExtensionInstalled() === window.meteorWallet != null)
 *   - nightly       → window.nightly        (the Nightly extension injection)
 *   - sender        → window.near.isSender  (the Sender extension injection)
 * MyNearWallet is a redirect/popup WEB wallet with no injected global, and
 * Ledger is WebHID hardware with no passive presence signal, so neither can be
 * positively detected → they always fall through to "Install" (their registry
 * installUrl), exactly like TON today.
 *
 * Connect = `selector.wallet(id).signIn({ contractId })` → the signed-in
 * account id (session only; this module NEVER signs a transaction or message —
 * the NEAR swap lane is a later step). The handshake is bounded by a TIMEOUT
 * (NEAR_CONNECT_TIMEOUT_MS) so a wallet that never answers can never leave the
 * UI stuck on "Connecting…" — on timeout the connect rejects, the modal shows
 * an honest error, and the deposit-address row is the fallback.
 *
 * ── WHY NO DEAD CONNECT BUTTON (fail-closed) ──────────────────────────────
 * When nothing is positively detected (no selector, non-browser, or no
 * injected wallet), this module reports ZERO connectable wallets. The modal
 * then shows the registry rows with their "Install" links and the
 * always-present deposit-address row (nearRegistry.js) — never a dead Connect
 * button that hangs.
 *
 * ── DI-CLEAN ──────────────────────────────────────────────────────────────
 * This module receives the selector handle AND the browser window via
 * injection (a resolved selector OR a promise that resolves to one; `win`, the
 * real window in the app, a fake in tests). node:test injects a fake selector
 * + fake window; it never imports the SDK and never touches the browser. The
 * browser-only SDK factory lives in nearSelector.js (imported by the app,
 * never by tests).
 */

import { NEAR_WALLETS, NEAR_WALLET_IDS } from "./nearRegistry.js";

/**
 * Connect-handshake timeout (ms). A wallet that never answers must never leave
 * the UI stuck on "Connecting…" — 15s is long enough for a real approval popup
 * and short enough to fail closed to the deposit-address fallback.
 */
export const NEAR_CONNECT_TIMEOUT_MS = 15000;

/**
 * Positive presence probes: NEAR module id → "is this wallet actually here?".
 * A wallet is reported installed ONLY when its probe returns true. Wallets
 * with no reliable passive presence signal are deliberately absent (→ they
 * always show "Install").
 */
export const NEAR_PRESENCE_PROBES = Object.freeze({
  // Meteor injects window.meteorWallet (@meteorwallet/sdk isExtensionInstalled).
  [NEAR_WALLET_IDS.METEOR]: (win) => Boolean(win?.meteorWallet),
  // Nightly injects window.nightly (its module then reads window.nightly.near).
  [NEAR_WALLET_IDS.NIGHTLY]: (win) => Boolean(win?.nightly),
  // Sender injects window.near.isSender (the selector's own sender probe).
  [NEAR_WALLET_IDS.SENDER]: (win) => Boolean(win?.near?.isSender),
});

/**
 * Is a NEAR wallet POSITIVELY present in this window? Only a probe that
 * returns true counts as installed — an unknown id (or one with no probe)
 * is never reported installed. Never throws.
 *
 * @param {string} walletId a NEAR Wallet Selector module id
 * @param {object|null} win  the browser window (or a test fake)
 * @returns {boolean}
 */
export function isNearWalletPresent(walletId, win) {
  const probe = NEAR_PRESENCE_PROBES[walletId];
  if (typeof probe !== "function") return false;
  try {
    return probe(win) === true;
  } catch {
    return false; // a hostile/throwing global is "not present", never a crash
  }
}

/**
 * Race a promise against a timeout. On expiry the returned promise rejects
 * with `message` (and the race keeps the original promise observed, so it can
 * never surface as an unhandled rejection). ms <= 0 disables the guard.
 */
function withTimeout(promise, ms, message) {
  if (typeof ms !== "number" || ms <= 0) return promise;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Create the NEAR discovery handle — same shape as the other family handles
 * ({ start, stop, getInstalled, getProvider }).
 *
 * @param {{
 *   selector?: object|Promise<object>|null, // a NEAR Wallet Selector (or a promise for one)
 *   contractId?: string|null,               // the contractId the connect handshake requests a key for
 *   balanceFetcher?: ((accountId: string) => Promise<bigint>) | null,
 *   win?: object|null,                      // the browser window (injected; default = global window)
 *   timeoutMs?: number,                     // connect-handshake timeout (default NEAR_CONNECT_TIMEOUT_MS)
 *   onChange?: (wallets: Array) => void,
 * }} [options]
 */
export function createNearDiscovery({
  selector = null,
  contractId = null,
  balanceFetcher = null,
  win = typeof window !== "undefined" ? window : null,
  timeoutMs = NEAR_CONNECT_TIMEOUT_MS,
  onChange = () => {},
} = {}) {
  let installed = [];
  let offs = [];
  let live = null; // the resolved selector object (null until resolved)

  /** Read the selector's modules → the POSITIVELY-detected wallet entries. */
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
      if (m.metadata?.available === false) continue; // selector says hidden
      // Fail-closed: REQUIRE a positive presence probe. `metadata.available`
      // is unreliable (web wallets hard-code true) — never trust it alone.
      if (!isNearWalletPresent(m.id, win)) continue;
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

    /** Snapshot: [{ key, name, source }] — positively-detected NEAR module ids. */
    getInstalled: () => [...installed],

    /**
     * Resolve an INSTALLED wallet to a WalletContext provider, or null
     * (null → the WalletContext mock/deposit fallback). Connect is the
     * selector's sign-in handshake → the account id (+ best-effort balance),
     * bounded by `timeoutMs` so it can never hang. NO transaction/message is
     * ever signed here.
     */
    getProvider(walletId) {
      const entry = NEAR_WALLETS.find((w) => w.id === walletId);
      if (!entry || entry.depositAddress) return null;
      if (!live) return null;
      if (!installed.some((w) => w.key === walletId)) return null; // not detected → null

      const sel = live;
      const name = entry.name;
      return {
        family: "near",
        id: `near:${walletId}`,
        isReal: true,
        walletName: name,

        async connect() {
          // The handshake can hang forever (a wallet that never answers). Bound
          // it — on timeout the connect rejects and the UI fails closed to the
          // deposit-address fallback instead of a stuck "Connecting…".
          const wallet = await withTimeout(
            Promise.resolve().then(() => sel.wallet(walletId)),
            timeoutMs,
            `NEAR wallet "${name}" is not responding — no wallet detected`,
          );
          if (!wallet || typeof wallet.signIn !== "function") {
            throw new Error(`NEAR wallet "${name}" is not connectable (no sign-in)`);
          }
          const accounts = await withTimeout(
            wallet.signIn(contractId ? { contractId } : {}),
            timeoutMs,
            `NEAR wallet "${name}" did not respond in time — use the deposit address instead`,
          );
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
