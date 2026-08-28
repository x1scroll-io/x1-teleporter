/**
 * Litecoin + Dogecoin balance reading (Step 2.4) — public APIs, no key
 * required. The fetchers are INJECTED so node:test proves the math with
 * mocked responses and the browser uses `fetch` — nothing here touches the
 * network in tests.
 *
 * Endpoints (both verified live from the build host, no key):
 *   - LTC: https://litecoinspace.org/api — the Litecoin Foundation's
 *     explorer, mempool.space-style API. The address endpoint returns the
 *     exact same JSON shape as mempool.space (chain_stats/mempool_stats
 *     with funded_txo_sum/spent_txo_sum in satoshis), so this module
 *     reuses the pure parser from bitcoinBalance.js.
 *   - DOGE: https://api.blockcypher.com/v1/doge/main — free tier, no key
 *     required at build time (rate-limited). The /addrs/{addr}/balance
 *     endpoint returns `{ balance, unconfirmed_balance, final_balance }`
 *     in satoshis; `final_balance` (confirmed + pending) is used so a
 *     just-sent deposit shows up.
 *
 * This module NEVER constructs transactions, signs anything, or requests
 * wallet APIs — read-only public-chain lookups keyed on the wallet address.
 * Signing is hard-stopped (Pro lane, later step).
 */

import { balanceFromMempoolAddress } from "./bitcoinBalance.js";

/** LitecoinSpace public API base URL (mempool.space-compatible JSON). */
export const LITECOIN_SPACE_API = "https://litecoinspace.org/api";

/** BlockCypher public DOGE API base URL (free tier, no key at build time). */
export const BLOCKCYPHER_DOGE_API = "https://api.blockcypher.com/v1/doge/main";

/**
 * Parse a BlockCypher DOGE balance response into satoshis. Pure — exported
 * for direct unit testing.
 *
 * @param {{balance?: number, unconfirmed_balance?: number, final_balance?: number}} data
 * @returns {number} balance in satoshis (final_balance = confirmed + pending)
 */
export function balanceFromBlockcypher(data) {
  const finalBalance = Number(data?.final_balance ?? data?.balance ?? 0);
  return Math.max(0, Number.isFinite(finalBalance) ? finalBalance : 0);
}

/**
 * Create a Litecoin balance fetcher for an address.
 *
 * @param {{fetcher?: (url: string, init?: object) => Promise<{ok: boolean, json: () => Promise<object>}>, apiUrl?: string}} [options]
 *   - fetcher: injected HTTP fetch (defaults to global fetch). Tests mock it.
 *   - apiUrl: LitecoinSpace base URL (defaults to the public mainnet API).
 * @returns {(address: string) => Promise<number>} resolves satoshis; rejects
 *   with a descriptive error on transport or HTTP failure.
 */
export function createLtcBalanceFetcher({
  fetcher = typeof globalThis !== "undefined" ? globalThis.fetch : undefined,
  apiUrl = LITECOIN_SPACE_API,
} = {}) {
  if (typeof fetcher !== "function") {
    throw new Error("createLtcBalanceFetcher: no fetch implementation available");
  }
  return async function fetchLtcBalance(address) {
    if (typeof address !== "string" || address.length === 0) {
      throw new Error("fetchLtcBalance: a wallet address is required");
    }
    const url = `${apiUrl}/address/${encodeURIComponent(address)}`;
    let response;
    try {
      response = await fetcher(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new Error(`fetchLtcBalance: LitecoinSpace request failed (${error?.message ?? error})`);
    }
    if (!response?.ok) {
      throw new Error(`fetchLtcBalance: LitecoinSpace responded ${response?.status ?? "unknown"}`);
    }
    const data = await response.json();
    // LitecoinSpace is mempool.space-compatible — reuse the pure parser.
    return balanceFromMempoolAddress(data);
  };
}

/**
 * Create a Dogecoin balance fetcher for an address.
 *
 * @param {{fetcher?: (url: string, init?: object) => Promise<{ok: boolean, json: () => Promise<object>}>, apiUrl?: string}} [options]
 *   - fetcher: injected HTTP fetch (defaults to global fetch). Tests mock it.
 *   - apiUrl: BlockCypher DOGE base URL (defaults to the public API).
 * @returns {(address: string) => Promise<number>} resolves satoshis; rejects
 *   with a descriptive error on transport or HTTP failure.
 */
export function createDogeBalanceFetcher({
  fetcher = typeof globalThis !== "undefined" ? globalThis.fetch : undefined,
  apiUrl = BLOCKCYPHER_DOGE_API,
} = {}) {
  if (typeof fetcher !== "function") {
    throw new Error("createDogeBalanceFetcher: no fetch implementation available");
  }
  return async function fetchDogeBalance(address) {
    if (typeof address !== "string" || address.length === 0) {
      throw new Error("fetchDogeBalance: a wallet address is required");
    }
    const url = `${apiUrl}/addrs/${encodeURIComponent(address)}/balance`;
    let response;
    try {
      response = await fetcher(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new Error(`fetchDogeBalance: BlockCypher request failed (${error?.message ?? error})`);
    }
    if (!response?.ok) {
      throw new Error(`fetchDogeBalance: BlockCypher responded ${response?.status ?? "unknown"}`);
    }
    const data = await response.json();
    return balanceFromBlockcypher(data);
  };
}

/**
 * Format satoshis as an LTC amount string for display ("1.23456789 LTC").
 * Pure — the modal renders this; tests pin the formatting.
 *
 * @param {number} sats
 * @returns {string}
 */
export function formatLtcBalance(sats) {
  if (typeof sats !== "number" || !Number.isFinite(sats) || sats < 0) return "—";
  const ltc = sats / 100_000_000;
  return `${ltc.toFixed(8).replace(/\.?0+$/, "")} LTC`;
}

/**
 * Format satoshis as a DOGE amount string for display ("1234.56789012 DOGE").
 * Pure — the modal renders this; tests pin the formatting.
 *
 * @param {number} sats
 * @returns {string}
 */
export function formatDogeBalance(sats) {
  if (typeof sats !== "number" || !Number.isFinite(sats) || sats < 0) return "—";
  const doge = sats / 100_000_000;
  return `${doge.toFixed(8).replace(/\.?0+$/, "")} DOGE`;
}
