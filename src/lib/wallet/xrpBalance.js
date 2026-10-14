/**
 * XRP Ledger balance reading (Step 2.4) — public XRPL node, no key
 * required. The fetcher is INJECTED so node:test proves the math with a
 * mocked response and the browser uses `fetch` — nothing here touches the
 * network in tests.
 *
 * Endpoint (verified live from the build host, no key):
 *   - https://s1.ripple.com:51234 — the public XRPL JSON-RPC node.
 *     Method: account_info (ledger_index "current", strict), which
 *     returns `result.account_data.Balance` in DROPS (1 XRP = 1,000,000
 *     drops) as a string.
 *
 * This module NEVER constructs transactions, signs anything, or requests
 * wallet APIs — a read-only public-chain lookup keyed on the wallet
 * address. Signing / Xaman payload signing is hard-stopped (Pro lane,
 * later step).
 */

/** Public XRPL JSON-RPC node (mainnet). */
export const XRPL_PUBLIC_NODE = "https://s1.ripple.com:51234";

/**
 * Parse an account_info response into a drops balance. Pure — exported for
 * direct unit testing.
 *
 * @param {{result?: {account_data?: {Balance?: string|number}}}} data
 * @returns {number} balance in drops (≥ 0; an unfunded/absent account is 0)
 */
export function balanceFromAccountInfo(data) {
  const raw = data?.result?.account_data?.Balance;
  const drops = Number(raw ?? 0);
  return Math.max(0, Number.isFinite(drops) ? drops : 0);
}

/**
 * Create an XRP balance fetcher for an address.
 *
 * @param {{fetcher?: (url: string, init?: object) => Promise<{ok: boolean, json: () => Promise<object>}>, nodeUrl?: string}} [options]
 *   - fetcher: injected HTTP fetch (defaults to global fetch). Tests mock it.
 *   - nodeUrl: public XRPL JSON-RPC node (defaults to the mainnet node).
 * @returns {(address: string) => Promise<number>} resolves drops; rejects
 *   with a descriptive error on transport or HTTP failure.
 */
export function createXrpBalanceFetcher({
  fetcher = typeof globalThis !== "undefined" ? globalThis.fetch : undefined,
  nodeUrl = XRPL_PUBLIC_NODE,
} = {}) {
  if (typeof fetcher !== "function") {
    throw new Error("createXrpBalanceFetcher: no fetch implementation available");
  }
  return async function fetchXrpBalance(address) {
    if (typeof address !== "string" || address.length === 0) {
      throw new Error("fetchXrpBalance: a wallet address is required");
    }
    const body = {
      method: "account_info",
      params: [{ account: address, ledger_index: "current", strict: true }],
    };
    let response;
    try {
      response = await fetcher(nodeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`fetchXrpBalance: XRPL node request failed (${error?.message ?? error})`);
    }
    if (!response?.ok) {
      throw new Error(`fetchXrpBalance: XRPL node responded ${response?.status ?? "unknown"}`);
    }
    const data = await response.json();
    return balanceFromAccountInfo(data);
  };
}

/**
 * Format drops as an XRP amount string for display ("12.345678 XRP").
 * Pure — the modal renders this; tests pin the formatting.
 *
 * @param {number} drops
 * @returns {string}
 */
export function formatXrpBalance(drops) {
  if (typeof drops !== "number" || !Number.isFinite(drops) || drops < 0) return "—";
  const xrp = drops / 1_000_000;
  return `${xrp.toFixed(6).replace(/\.?0+$/, "")} XRP`;
}
