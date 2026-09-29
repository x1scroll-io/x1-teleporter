/**
 * nearBalance.js — read a NEAR account balance via the NEAR JSON-RPC
 * `query`/`view_account` method. Returns yoctoNEAR (1 NEAR = 1e24 yocto).
 *
 * DI-clean: the fetch implementation + RPC url are injected, so node:test
 * exercises it with a fake fetch (no network). The real app passes nothing —
 * it uses the global fetch + the public mainnet RPC.
 *
 * BEST-EFFORT by design: the WalletContext treats a balance read failure as
 * "balance unknown" (null); the account id from the connect handshake is what
 * a session needs. This module therefore THROWS on a genuine RPC error and the
 * caller swallows it (nearDiscovery.js).
 */

/** Public NEAR mainnet RPC (the repo's documented default). */
export const NEAR_MAINNET_RPC = "https://rpc.mainnet.near.org";

/**
 * Build a NEAR balance fetcher.
 *
 * @param {{rpcUrl?: string, fetchImpl?: Function}} [options]
 * @returns {(accountId: string) => Promise<bigint>} yoctoNEAR
 */
export function createNearBalanceFetcher({ rpcUrl = NEAR_MAINNET_RPC, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);

  return async function fetchNearBalance(accountId) {
    if (!accountId || typeof accountId !== "string") {
      throw new Error("nearBalance: accountId is required");
    }
    if (!doFetch) throw new Error("nearBalance: no fetch implementation available");

    const res = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "teleporter-near",
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: accountId },
      }),
    });
    if (!res || !res.ok) throw new Error(`nearBalance: RPC HTTP ${res?.status ?? "?"}`);

    const json = await res.json();
    if (!json || json.error) {
      throw new Error(`nearBalance: RPC error ${json?.error?.message ?? "unknown"}`);
    }
    const amount = json.result?.amount;
    if (amount === undefined || amount === null) {
      throw new Error("nearBalance: no amount in the RPC result");
    }
    return BigInt(amount);
  };
}
