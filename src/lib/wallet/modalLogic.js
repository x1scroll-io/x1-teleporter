/**
 * Connect-modal data logic (Step 2.2) — PURE and browser-free.
 *
 * Implements the binding modal rules from docs/WALLET-REGISTRY.md:
 *   1. Fixed order — families render in WALLET_FAMILIES order (families.js).
 *   2. Starport pinned first — Starport occupies the top slot of every
 *      family, always visible, always first.
 *   3. Installed highlighted — discovered wallets are flagged `installed`.
 *   4. Not-installed still shown — with their install link, never hidden.
 *   5. Never hide a wallet — every registry entry is always present.
 *
 * Beyond the registry, every ANNOUNCED provider gets its own entry too
 * (docs/BRIEF.md, wallet layer: "Every announced provider gets its own
 * entry in the wallet modal"): discovered wallets that are not in the
 * registry are appended after the registry rows as installed entries, so
 * nothing a wallet injected is ever hidden. The only exclusion is wagmi's
 * generic "injected" fallback connector — it is not an announced provider
 * (see normalizeEvmDiscovered).
 *
 * This module has no React, no DOM, no discovery side effects — everything
 * is a pure function of (family, discovered, registry), so node:test proves
 * the ordering rules without a browser.
 */

import { WALLET_FAMILIES, FAMILY_LABELS } from "./families.js";

/** Stable id of the pinned Starport wallet in every family. */
export const STARPORT_ID = "starport";

/**
 * Canonical id of the Starport wallet used by the X1 ecosystem.
 * Kept as a constant so later steps can match a real Starport adapter
 * (EVM rdns or Solana adapter name) against the pinned row.
 */
export const STARPORT_NAMES = Object.freeze(["starport", "Starport"]);

/**
 * Small registry map: known wallets per family (id → metadata).
 *
 * `id` is the stable match key used by discovery:
 *   - EVM: the wallet's EIP-6963 `rdns` (e.g. "io.metamask").
 *   - Solana: the Wallet Standard adapter name (e.g. "Phantom").
 *   - Starport: pinned row; no real adapter yet — matched only if a
 *     discovered wallet's rdns/name is in STARPORT_NAMES.
 *
 * `reference: true` marks the family's reference wallet (docs/WALLET-
 * REGISTRY.md, "Connect modal layout": MetaMask / Phantom / Xverse / Xaman /
 * TronLink …) which renders second, right after Starport.
 *
 * `installUrl` is where a user gets the wallet if it is not installed.
 * Starport has no public install link yet (null) — it stays pinned and
 * connectable via the dev mock fallback until its real adapter is wired
 * (later step).
 *
 * Phantom is MULTI-CHAIN: it may appear in the Solana list (Wallet
 * Standard), the EVM list (EIP-6963, rdns "app.phantom"), and the Bitcoin
 * list (multi-chain Wallet Standard). Each appearance is a SEPARATE entry
 * and a separate session — per WalletContext isolation, one session per
 * family, never merged across families.
 *
 * This map is intentionally SMALL (Starport + reference + a couple of
 * majors per family); the full canonical tables in docs/WALLET-REGISTRY.md
 * get wired in later steps behind the same modalLogic.
 */
export const WALLET_REGISTRY = Object.freeze({
  evm: Object.freeze([
    Object.freeze({ id: STARPORT_ID, name: "Starport", pinned: true, installUrl: null }),
    Object.freeze({ id: "io.metamask", name: "MetaMask", reference: true, installUrl: "https://metamask.io/download/" }),
    Object.freeze({ id: "com.coinbase.wallet", name: "Coinbase Wallet", installUrl: "https://www.coinbase.com/wallet/downloads" }),
    Object.freeze({ id: "app.phantom", name: "Phantom", installUrl: "https://phantom.app/" }),
    Object.freeze({ id: "io.rabby", name: "Rabby", installUrl: "https://rabby.io/" }),
  ]),
  solana: Object.freeze([
    Object.freeze({ id: STARPORT_ID, name: "Starport", pinned: true, installUrl: null }),
    Object.freeze({ id: "Phantom", name: "Phantom", reference: true, installUrl: "https://phantom.app/" }),
    Object.freeze({ id: "Backpack", name: "Backpack", installUrl: "https://backpack.app/" }),
    Object.freeze({ id: "Solflare", name: "Solflare", installUrl: "https://solflare.com/" }),
  ]),
  bitcoin: Object.freeze([
    Object.freeze({ id: STARPORT_ID, name: "Starport", pinned: true, installUrl: null }),
    Object.freeze({ id: "Xverse", name: "Xverse", reference: true, installUrl: "https://www.xverse.app/" }),
    Object.freeze({ id: "Phantom", name: "Phantom", installUrl: "https://phantom.app/" }),
    Object.freeze({ id: "Unisat", name: "Unisat", installUrl: "https://unisat.io/" }),
  ]),
  litecoin: Object.freeze([
    Object.freeze({ id: STARPORT_ID, name: "Starport", pinned: true, installUrl: null }),
    Object.freeze({ id: "Ctrl", name: "Ctrl (ex-XDEFI)", reference: true, installUrl: "https://ctrl.xyz/" }),
    Object.freeze({ id: "Litescribe", name: "Litescribe", installUrl: "https://www.litescribe.io/" }),
  ]),
  dogecoin: Object.freeze([
    Object.freeze({ id: STARPORT_ID, name: "Starport", pinned: true, installUrl: null }),
    Object.freeze({ id: "Ctrl", name: "Ctrl (ex-XDEFI)", reference: true, installUrl: "https://ctrl.xyz/" }),
    Object.freeze({ id: "MyDoge", name: "MyDoge", installUrl: "https://mydoge.com/" }),
  ]),
  xrp: Object.freeze([
    Object.freeze({ id: STARPORT_ID, name: "Starport", pinned: true, installUrl: null }),
    Object.freeze({ id: "Xaman", name: "Xaman", reference: true, installUrl: "https://xaman.app/" }),
  ]),
  tron: Object.freeze([
    Object.freeze({ id: STARPORT_ID, name: "Starport", pinned: true, installUrl: null }),
    Object.freeze({ id: "TronLink", name: "TronLink", reference: true, installUrl: "https://www.tronlink.org/" }),
  ]),
});

/**
 * Normalize discovered EVM providers (EIP-6963 entries) into the match
 * shape modalLogic consumes: `{ key, name, icon, raw }`. `key` is the rdns
 * (falling back to uuid for wallets that omit rdns).
 *
 * wagmi's generic "injected" fallback connector is filtered out here: it
 * represents whatever owns the legacy injected global, not an announced
 * EIP-6963 provider, and the brief forbids treating it as a wallet entry.
 */
export function normalizeEvmDiscovered(providers) {
  return (providers ?? [])
    .filter((p) => p.rdns !== "injected")
    .map((p) => ({
      key: p.rdns ?? p.uuid,
      name: p.name,
      icon: p.icon,
      raw: p,
    }));
}

/**
 * Normalize discovered Solana adapters (Wallet Standard) into the match
 * shape modalLogic consumes: `{ key, name, icon, raw }`. `key` is the
 * adapter name.
 */
export function normalizeSolanaDiscovered(adapters) {
  return (adapters ?? []).map((a) => ({
    key: a.name,
    name: a.name,
    icon: a.icon,
    raw: a,
  }));
}

/** Does a discovered match key correspond to Starport? */
export function isStarportKey(key) {
  return STARPORT_NAMES.includes(key) || key === STARPORT_ID;
}

/**
 * Build the ordered wallet rows for one family.
 *
 * Order (binding, docs/WALLET-REGISTRY.md "Connect modal layout" — a
 * fixed-order list, NOT detected-first sorting):
 *   1. Pinned wallets first (Starport) — always visible, always first.
 *   2. The family's reference wallet (MetaMask / Phantom / Xverse / Xaman /
 *      TronLink …).
 *   3. Every other registry wallet, ALPHABETICAL — installed ones
 *      highlighted IN PLACE, not-installed ones shown with an install link.
 *   4. Announced providers outside the registry, appended (never hidden).
 *
 * Every registry entry for the family appears exactly once. Starport's
 * pinned row is matched against discovery too: if a real Starport wallet
 * ever announces (rdns/name in STARPORT_NAMES) it flips to installed while
 * STAYING in the pinned first slot.
 *
 * @param {{family: string, discovered?: Array<{key: string}>, registry?: object}} params
 * @returns {Array<{id, name, pinned, reference, installed, installUrl, discovered}>}
 */
export function buildFamilyWalletRows({ family, discovered = [], registry = WALLET_REGISTRY }) {
  const entries = registry[family] ?? [];
  const byKey = new Map();
  for (const item of discovered) {
    if (item?.key) byKey.set(item.key, item);
  }

  /** Find the discovered match for a registry entry (null if not installed). */
  function findMatch(entry) {
    if (entry.pinned && isStarportKey(entry.id)) {
      // Starport matches by its own id OR any discovered wallet whose
      // rdns/name is a known Starport name.
      return (
        byKey.get(entry.id) ??
        [...byKey.values()].find((v) => STARPORT_NAMES.includes(v.key)) ??
        null
      );
    }
    return byKey.get(entry.id) ?? null;
  }

  function toRow(entry) {
    const match = findMatch(entry);
    return {
      id: entry.id,
      name: entry.name,
      pinned: entry.pinned === true,
      reference: entry.reference === true,
      installed: match !== null,
      installUrl: entry.installUrl ?? null,
      discovered: match,
    };
  }

  const pinned = entries.filter((e) => e.pinned).map(toRow);
  const reference = entries.filter((e) => !e.pinned && e.reference).map(toRow);
  const rest = entries
    .filter((e) => !e.pinned && !e.reference)
    .map(toRow)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Announced providers outside the registry get their own entry, appended
  // after the fixed list — installed, never hidden (docs/BRIEF.md).
  const registryKeys = new Set(entries.map((e) => e.id));
  const extras = discovered.filter(
    (d) => d.key && !registryKeys.has(d.key) && !isStarportKey(d.key),
  );
  const extraRows = extras.map((d) => ({
    id: d.key,
    name: d.name ?? d.key,
    pinned: false,
    reference: false,
    installed: true,
    installUrl: null,
    discovered: d,
  }));

  return [...pinned, ...reference, ...rest, ...extraRows];
}

/**
 * Family rows for the modal's first step: fixed WALLET_FAMILIES order with
 * labels. Pure convenience over families.js — kept here so the modal has a
 * single data entry point.
 */
export function buildFamilyRows(families = WALLET_FAMILIES) {
  return families.map((family) => ({ family, label: FAMILY_LABELS[family] }));
}
