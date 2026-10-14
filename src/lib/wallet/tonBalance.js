/**
 * tonBalance.js — read a TON address balance via the toncenter HTTP API
 * (`getAddressBalance`). Returns nanoTON (1 TON = 1e9 nanoTON).
 *
 * DI-clean: the fetch implementation + endpoint are injected, so node:test
 * exercises it with a fake fetch (no network). The real app uses the global
 * fetch + the public mainnet toncenter endpoint (an API key is optional and
 * only raises rate limits).
 *
 * BEST-EFFORT by design: the WalletContext treats a balance read failure as
 * "balance unknown" (null); the address from the connect handshake is what a
 * session needs. This module therefore THROWS on a genuine error and the
 * caller swallows it (tonDiscovery.js).
 */

/** Public TON mainnet toncenter endpoint (v2 HTTP API). */
export const TONCENTER_MAINNET = "https://toncenter.com/api/v2";

/**
 * Build a TON balance fetcher.
 *
 * @param {{endpoint?: string, apiKey?: string|null, fetchImpl?: Function}} [options]
 * @returns {(address: string) => Promise<bigint>} nanoTON
 */
export function createTonBalanceFetcher({ endpoint = TONCENTER_MAINNET, apiKey = null, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);

  return async function fetchTonBalance(address) {
    if (!address || typeof address !== "string") {
      throw new Error("tonBalance: address is required");
    }
    if (!doFetch) throw new Error("tonBalance: no fetch implementation available");

    const url = `${endpoint}/getAddressBalance?address=${encodeURIComponent(address)}`;
    const headers = apiKey ? { "X-API-Key": apiKey } : undefined;
    const res = await doFetch(url, headers ? { headers } : undefined);
    if (!res || !res.ok) throw new Error(`tonBalance: HTTP ${res?.status ?? "?"}`);

    const json = await res.json();
    if (!json || json.ok === false) {
      throw new Error(`tonBalance: API error ${json?.error ?? json?.result ?? "unknown"}`);
    }
    const amount = json.result;
    if (amount === undefined || amount === null || amount === "") {
      throw new Error("tonBalance: no balance in the API result");
    }
    return BigInt(amount);
  };
}
