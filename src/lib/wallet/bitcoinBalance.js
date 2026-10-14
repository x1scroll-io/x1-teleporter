/**
 * Bitcoin balance reading (Step 2.3) — public API, no key required.
 *
 * Uses mempool.space's public REST API (https://mempool.space/api/address/
 * {address}), which needs no API key. The fetcher is INJECTED so node:test
 * proves the math with a mocked response and the browser uses `fetch` —
 * nothing here touches the network in tests.
 *
 * Balance = (chain funded − chain spent) + (mempool funded − mempool spent)
 * in SATOSHIS, per the mempool.space address endpoint shape:
 *   { chain_stats:   { funded_txo_sum, spent_txo_sum, ... },
 *     mempool_stats: { funded_txo_sum, spent_txo_sum, ... } }
 * Pending mempool deltas are included so a just-sent deposit shows up.
 *
 * This module NEVER constructs transactions, signs anything, or requests
 * wallet APIs — it is a read-only public-chain lookup keyed on the payment
 * address. PSBT/signing is hard-stopped (Pro lane, later step).
 */

/** Default mempool.space API base URL. */
export const MEMPOOL_SPACE_API = "https://mempool.space/api";

/**
 * Parse a mempool.space address-response object into a satoshi balance.
 * Pure — exported for direct unit testing.
 *
 * @param {{chain_stats?: {funded_txo_sum?: number, spent_txo_sum?: number},
 *          mempool_stats?: {funded_txo_sum?: number, spent_txo_sum?: number}}} data
 * @returns {number} balance in satoshis (≥ 0; a drained address is 0)
 */
export function balanceFromMempoolAddress(data) {
  const chain = data?.chain_stats ?? {};
  const mempool = data?.mempool_stats ?? {};
  const funded =
    Number(chain.funded_txo_sum ?? 0) + Number(mempool.funded_txo_sum ?? 0);
  const spent =
    Number(chain.spent_txo_sum ?? 0) + Number(mempool.spent_txo_sum ?? 0);
  return Math.max(0, funded - spent);
}

/**
 * Parse ONLY the confirmed (chain) side of a mempool.space address-response
 * into a satoshi balance — the SPENDABLE balance. Pending mempool deltas are
 * excluded: a just-sent (or just-received) unconfirmed tx is NOT spendable
 * yet, so spendable reads (a send form's MAX fill) must never count it.
 * Pure — exported for direct unit testing.
 *
 * @param {{chain_stats?: {funded_txo_sum?: number, spent_txo_sum?: number},
 *          mempool_stats?: {funded_txo_sum?: number, spent_txo_sum?: number}}} data
 * @returns {number} confirmed balance in satoshis (≥ 0; a drained address is 0)
 */
export function confirmedFromMempoolAddress(data) {
  const chain = data?.chain_stats ?? {};
  const funded = Number(chain.funded_txo_sum ?? 0);
  const spent = Number(chain.spent_txo_sum ?? 0);
  return Math.max(0, funded - spent);
}

/**
 * Create a balance fetcher for a payment address.
 *
 * @param {{fetcher?: (url: string, init?: object) => Promise<{ok: boolean, json: () => Promise<object>}>, apiUrl?: string, spendableOnly?: boolean}} [options]
 *   - fetcher: injected HTTP fetch (defaults to global fetch). Tests mock it.
 *   - apiUrl: mempool.space base URL (defaults to the public mainnet API).
 *   - spendableOnly: when true, resolve the CONFIRMED balance only (pending
 *     mempool deltas excluded) — the spendable amount a MAX fill may use.
 *     Default false keeps the historical total (confirmed + pending) for the
 *     wallet layer's connect-time reads and existing callers.
 * @returns {(address: string) => Promise<number>} resolves satoshis; rejects
 *   with a descriptive error on transport or HTTP failure.
 */
export function createBtcBalanceFetcher({
  fetcher = (typeof globalThis !== "undefined" ? globalThis.fetch : undefined),
  apiUrl = MEMPOOL_SPACE_API,
  spendableOnly = false,
} = {}) {
  if (typeof fetcher !== "function") {
    throw new Error("createBtcBalanceFetcher: no fetch implementation available");
  }
  return async function fetchBtcBalance(address) {
    if (typeof address !== "string" || address.length === 0) {
      throw new Error("fetchBtcBalance: a payment address is required");
    }
    const url = `${apiUrl}/address/${encodeURIComponent(address)}`;
    let response;
    try {
      response = await fetcher(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new Error(`fetchBtcBalance: mempool.space request failed (${error?.message ?? error})`);
    }
    if (!response?.ok) {
      throw new Error(`fetchBtcBalance: mempool.space responded ${response?.status ?? "unknown"}`);
    }
    const data = await response.json();
    // Spendable reads (a send form's MAX) count CONFIRMED funds only;
    // the wallet layer's total reads keep confirmed + pending.
    return spendableOnly
      ? confirmedFromMempoolAddress(data)
      : balanceFromMempoolAddress(data);
  };
}

/**
 * Format satoshis as a BTC amount string for display ("0.00123456 BTC").
 * Pure — the modal renders this; tests pin the formatting.
 *
 * @param {number} sats
 * @returns {string}
 */
export function formatBtcBalance(sats) {
  if (typeof sats !== "number" || !Number.isFinite(sats) || sats < 0) {
    return "—";
  }
  const btc = sats / 100_000_000;
  // 8 decimals max, trailing zeros trimmed ("0.00123456", "1", "0.5").
  return `${btc.toFixed(8).replace(/\.?0+$/, "")} BTC`;
}
