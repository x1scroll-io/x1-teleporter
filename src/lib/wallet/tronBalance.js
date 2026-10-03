/**
 * Tron balance reading (Step 2.4) — public Trongrid endpoint, no key
 * required. The fetcher is INJECTED so node:test proves the math with a
 * mocked response and the browser uses `fetch` — nothing here touches the
 * network in tests.
 *
 * Endpoint (verified live from the build host, no key):
 *   - https://api.trongrid.io/v1/accounts/{address} — returns
 *     `data[0].balance` in SUN (1 TRX = 1,000,000 SUN). An address with no
 *     activity returns `data: []` → balance 0.
 *
 * This module NEVER constructs transactions, signs anything, or requests
 * wallet APIs — a read-only public-chain lookup keyed on the wallet
 * address. Signing is hard-stopped (Pro lane, later step).
 */

/** Public Trongrid API base URL (mainnet). */
export const TRONGRID_API = "https://api.trongrid.io";

/**
 * Parse a Trongrid v1/accounts response into a SUN balance. Pure —
 * exported for direct unit testing.
 *
 * @param {{data?: Array<{balance?: number}>}} data
 * @returns {number} balance in SUN (≥ 0; an unknown address is 0)
 */
export function balanceFromTrongridAccount(data) {
  const raw = data?.data?.[0]?.balance;
  const sun = Number(raw ?? 0);
  return Math.max(0, Number.isFinite(sun) ? sun : 0);
}

/**
 * Create a Tron balance fetcher for an address.
 *
 * @param {{fetcher?: (url: string, init?: object) => Promise<{ok: boolean, json: () => Promise<object>}>, apiUrl?: string}} [options]
 *   - fetcher: injected HTTP fetch (defaults to global fetch). Tests mock it.
 *   - apiUrl: Trongrid base URL (defaults to the public mainnet API).
 * @returns {(address: string) => Promise<number>} resolves SUN; rejects
 *   with a descriptive error on transport or HTTP failure.
 */
export function createTronBalanceFetcher({
  fetcher = typeof globalThis !== "undefined" ? globalThis.fetch : undefined,
  apiUrl = TRONGRID_API,
} = {}) {
  if (typeof fetcher !== "function") {
    throw new Error("createTronBalanceFetcher: no fetch implementation available");
  }
  return async function fetchTronBalance(address) {
    if (typeof address !== "string" || address.length === 0) {
      throw new Error("fetchTronBalance: a wallet address is required");
    }
    const url = `${apiUrl}/v1/accounts/${encodeURIComponent(address)}`;
    let response;
    try {
      response = await fetcher(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new Error(`fetchTronBalance: Trongrid request failed (${error?.message ?? error})`);
    }
    if (!response?.ok) {
      throw new Error(`fetchTronBalance: Trongrid responded ${response?.status ?? "unknown"}`);
    }
    const data = await response.json();
    return balanceFromTrongridAccount(data);
  };
}

/**
 * Format SUN as a TRX amount string for display ("12.345678 TRX").
 * Pure — the modal renders this; tests pin the formatting.
 *
 * @param {number} sun
 * @returns {string}
 */
export function formatTronBalance(sun) {
  if (typeof sun !== "number" || !Number.isFinite(sun) || sun < 0) return "—";
  const trx = sun / 1_000_000;
  return `${trx.toFixed(6).replace(/\.?0+$/, "")} TRX`;
}
