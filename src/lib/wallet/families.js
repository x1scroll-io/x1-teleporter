/**
 * Canonical wallet-family registry for the Teleporter v2 WalletContext
 * (Step 2.1 — Phase 2 wallet layer).
 *
 * The WalletContext holds ONE independent session per family. The order here
 * is the FIXED order used everywhere (registry docs, the connect modal in
 * Step 2.2, tests) — it is deliberately NOT alphabetical. It matches the
 * consolidated product orders: EVM and Solana first (the two live bridge
 * legs today), then the five THORChain-supported families (Bitcoin,
 * Litecoin, Dogecoin, XRP, Tron).
 *
 * See docs/WALLET-REGISTRY.md for the registry conventions (fixed order,
 * Starport pinned first, installed highlighted, not-installed shown with
 * install links, never hidden).
 */

export const WALLET_FAMILIES = Object.freeze([
  "evm",
  "solana",
  "bitcoin",
  "litecoin",
  "dogecoin",
  "xrp",
  "tron",
]);

/** Human-readable label per family — for UI and docs only. */
export const FAMILY_LABELS = Object.freeze({
  evm: "EVM",
  solana: "Solana",
  bitcoin: "Bitcoin",
  litecoin: "Litecoin",
  dogecoin: "Dogecoin",
  xrp: "XRP",
  tron: "Tron",
});

/** Guard: is this a family the WalletContext manages? */
export function isWalletFamily(family) {
  return WALLET_FAMILIES.includes(family);
}
