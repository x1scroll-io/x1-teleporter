/**
 * proxiedConnection.js — the RPC-transport shim for Solana + X1
 * (fix/proxy-solana-x1-rpc).
 *
 * WHY: the bridge form's Balances line showed `Solana: —` and `X1: —` in
 * the user's browser while `Ethereum: <value>` worked — the app's DIRECT
 * browser fetches to api.mainnet-beta.solana.com / rpc.mainnet.x1.xyz
 * (getTokenAccountsByOwner, getBalance) failed in the user's network, while
 * EVM (Rabby's own RPC) worked. The same browser-network block is what broke
 * the reverse stage-2 signing path (the app couldn't reach Solana/X1 infra
 * from the browser at all). The fix mirrors the already-proven /api/warp/*
 * + /api/lifi/quote pattern: route every Solana/X1 READ + simulation through
 * the app's OWN serverless functions (/api/rpc/solana, /api/rpc/x1) —
 * same-origin fetches, no CORS, no browser-network variance.
 *
 * MECHANISM: @solana/web3.js Connection (1.x — installed 1.98.4) accepts a
 * custom `fetch` in its ConnectionConfig (the documented `fetch?: FetchFn`
 * option). EVERY RPC call — reads, simulation, sends — funnels through that
 * one function (createRpcClient → rpc-client → fetch(url, { method: "POST",
 * body: <json-rpc string>, ... })). So instead of swapping a dozen call
 * sites to hand-rolled raw fetches, we build the SAME Connection the app
 * already uses and only override its transport:
 *
 *   new Connection(endpoint, { commitment: "confirmed", fetch: proxiedFetch })
 *
 *   - READ + SIMULATION methods → POST the JSON-RPC body to the same-origin
 *     proxy path (/api/rpc/solana | /api/rpc/x1), which forwards it to the
 *     real chain server-side and returns the JSON verbatim.
 *   - WRITE broadcasts (sendTransaction / sendRawTransaction) → routed
 *     DIRECTLY to the real RPC endpoint, unchanged from today. The proxy is
 *     for READS + simulation only; writes stay with the connected wallet
 *     adapter (signAndSendTransaction) or the app's direct deterministic
 *     broadcast — never through a public relay.
 *
 * The `endpoint` argument stays the REAL chain URL: the Connection's
 * identity (rpcEndpoint, ws derivation) is unchanged; only the HTTP
 * transport is swapped. Subscriptions are not used by any read path here
 * (all reads are HTTP request/response), and confirmTransaction falls back
 * to getSignatureStatus polling when the ws socket is unavailable.
 */

/** JSON-RPC methods that BROADCAST a transaction — never routed through the
 *  proxy (writes stay direct-to-RPC / with the connected wallet). */
export const BROADCAST_METHODS = Object.freeze([
  "sendTransaction",
  "sendRawTransaction",
]);

/** True when the JSON-RPC body (single object or batch array) contains a
 *  broadcast method. Pure + exported so the routing decision is
 *  unit-testable without a Connection. */
export function isBroadcastRpc(body) {
  if (!body) return false;
  const items = Array.isArray(body) ? body : [body];
  return items.some(
    (r) => r && typeof r.method === "string" && BROADCAST_METHODS.includes(r.method),
  );
}

/** The same-origin proxy paths (must match the api/ functions that ship). */
export const RPC_PROXY_PATHS = Object.freeze({
  solana: "/api/rpc/solana",
  x1: "/api/rpc/x1",
});

/**
 * Build the transport function the proxied Connection runs every RPC call
 * through (web3.js ConnectionConfig.fetch). Pure + exported so the routing
 * contract is unit-testable without constructing a Connection:
 *
 *   - READ + SIMULATION methods → POST the JSON-RPC body to `proxyPath`
 *     (same-origin, no CORS / browser-network variance);
 *   - WRITE broadcasts (sendTransaction / sendRawTransaction) → the ORIGINAL
 *     url+init, unchanged from today (the proxy is READS + simulation only).
 *
 * @param {object} [opts]
 * @param {string} [opts.proxyPath] same-origin proxy path, e.g.
 *   RPC_PROXY_PATHS.solana
 * @param {Function} [opts.fetchImpl] async (url, init) => Response-like
 *   (test seam; default: global fetch)
 * @returns {(url: string, init: object) => Promise<Response>}
 */
export function createProxiedFetch({ proxyPath, fetchImpl = null } = {}) {
  const fetchFn = fetchImpl ?? ((url, init) => fetch(url, init));

  return async (url, init) => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : JSON.stringify(init?.body ?? { jsonrpc: "2.0", id: 1, method: "getVersion", params: [] });

    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }

    if (body && isBroadcastRpc(body)) {
      // WRITE broadcast — the proxy is for READS + simulation only. Send
      // straight to the real RPC (the behavior the app had before this
      // shim); signAndSendTransaction via the connected wallet is untouched.
      return fetchFn(url, init);
    }

    // READ / SIMULATION — same-origin proxy (no CORS, no browser-network
    // variance). The JSON-RPC body is forwarded verbatim and the upstream
    // JSON comes back verbatim (api/rpc/_rpc.js).
    return fetchFn(proxyPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyText,
    });
  };
}

/**
 * Build a @solana/web3.js Connection whose HTTP transport POSTs to the
 * app's own serverless RPC proxy instead of the raw chain endpoint.
 *
 * @param {string} endpoint the REAL chain RPC URL (kept as the Connection's
 *   declared endpoint — only the transport is swapped)
 * @param {string} proxyPath the same-origin proxy path, e.g.
 *   RPC_PROXY_PATHS.solana ("/api/rpc/solana")
 * @param {object} [opts]
 * @param {string} [opts.commitment] Connection commitment (default
 *   "confirmed" — the app's existing default everywhere)
 * @param {object} [opts.web3] injected @solana/web3.js module (test seam;
 *   default: dynamic import)
 * @param {Function} [opts.fetchImpl] async (url, init) => Response-like
 *   (test seam; default: global fetch)
 * @returns {Promise<object>} a web3.js Connection (proxied transport)
 */
export async function createProxiedConnection(endpoint, proxyPath, { commitment = "confirmed", web3 = null, fetchImpl = null } = {}) {
  const { Connection } = web3 ?? (await import("@solana/web3.js"));
  const proxiedFetch = createProxiedFetch({ proxyPath, fetchImpl });
  return new Connection(endpoint, { commitment, fetch: proxiedFetch });
}
