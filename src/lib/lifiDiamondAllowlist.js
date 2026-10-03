/**
 * lifiDiamondAllowlist.js — known-good LI.Fi Diamond contract addresses.
 *
 * WHY THIS EXISTS (Step 1.1 amendment)
 *   The rest of the approval validation compares fields from the SAME LI.Fi
 *   response (approvalAddress === transactionRequest.to, tool key present in
 *   /v1/tools). A tampered or malicious response can satisfy every one of
 *   those checks while still pointing at an attacker's contract. This file is
 *   the INDEPENDENT anchor: the approval target must be LI.Fi's Diamond
 *   contract, whose address is published and stable per chain and which we
 *   pin here from LI.Fi's own deployment records.
 *
 * SOURCE OF TRUTH (cited, verified 2026-08-27)
 *   LI.Fi publish per-chain Diamond deployments in the official contracts
 *   repo deployment log:
 *     https://github.com/lifinance/contracts/blob/main/deployments/_deployments_log_file.json
 *   → LiFiDiamond.<chain>.production[*].ADDRESS
 *   (per-chain artifacts also live at
 *     https://github.com/lifinance/contracts/tree/main/deployments/<chain>.diamond.json )
 *
 *   The Diamond is deployed deterministically (CREATE2), so the production
 *   address is the SAME on every chain:
 *     0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
 *   Every entry below was additionally verified on-chain via eth_getCode
 *   (contract code present at that address) on public RPCs, 2026-08-27.
 *
 * UPDATING
 *   If LI.Fi ever redeploys a Diamond on some chain, update ONE entry here —
 *   this file is intentionally the single place chain→Diamond addresses live.
 *   Do NOT add an address you cannot cite from the source above.
 *
 * FAIL-CLOSED
 *   Any chain not listed here, or any address that differs from the listed
 *   Diamond, is rejected by validateLiFiApproval (see lifiApproval.js).
 */

// chainId → LI.Fi Diamond (lowercase — comparison is case-insensitive).
// Only the EVM chains the Teleporter app supports (src/Teleporter.jsx CHAINS).
// Solana / Tron / X1 are not EVM and have no Diamond — they never reach this.
export const LIFI_DIAMOND_ALLOWLIST = {
  1: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // Ethereum (mainnet)
  10: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // Optimism
  56: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // BNB Chain
  137: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // Polygon
  146: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // Sonic
  8453: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // Base
  42161: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // Arbitrum
  43114: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // Avalanche
};

/** Source citation for the allowlist (see header comment). */
export const LIFI_DIAMOND_SOURCE_URL =
  "https://github.com/lifinance/contracts/blob/main/deployments/_deployments_log_file.json";

/** Normalize a chain id (number, decimal string, or 0x hex) or null. */
export function normalizeChainId(chainId) {
  const n = Number(chainId);
  return Number.isFinite(n) ? n : null;
}

/** True if we have a pinned Diamond for this chain. */
export function isKnownLiFiDiamondChain(chainId) {
  const n = normalizeChainId(chainId);
  return n !== null && Object.prototype.hasOwnProperty.call(LIFI_DIAMOND_ALLOWLIST, n);
}

/** True if `address` is the pinned LI.Fi Diamond for `chainId`. */
export function isKnownLiFiDiamond(chainId, address) {
  const n = normalizeChainId(chainId);
  if (n === null) return false;
  const expected = LIFI_DIAMOND_ALLOWLIST[n];
  if (!expected) return false;
  return typeof address === "string" && address.trim().toLowerCase() === expected;
}
