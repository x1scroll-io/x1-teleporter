// api/rpc/_rpc.js — shared factory for the Solana + X1 JSON-RPC passthrough
// proxies (api/rpc/solana.js + api/rpc/x1.js).
//
// WHY THESE PROXIES EXIST (2026-09-01, fix/proxy-solana-x1-rpc): the bridge
// form's Balances line showed `Ethereum: <value>` but `Solana: —` and
// `X1: —` in the user's browser — the app's DIRECT browser fetches to
// api.mainnet-beta.solana.com / rpc.mainnet.x1.xyz (getTokenAccountsByOwner,
// getBalance) failed in the user's network while EVM (Rabby's own RPC)
// worked. The same browser-network block is what broke the reverse stage-2
// signing path (the app couldn't reach Solana/X1 infra from the browser at
// all). ELIMINATE the variable: route every Solana/X1 READ + simulation
// through the app's OWN serverless function (same-origin /api/rpc/*),
// exactly like /api/warp/* and /api/lifi/quote already do for their
// upstreams. The proxy is a GENERIC JSON-RPC passthrough: it forwards the
// request body verbatim and returns the upstream JSON verbatim, so the
// client-side @solana/web3.js Connection behaves identically — only the
// transport changes.
//
// Contract (mirrors api/_warp.js createWarpProxy):
//   - same CORS allowlist (api/_cors.js — 403 on foreign origins, no-Origin
//     passthrough for same-origin fetches, which is the path production
//     actually uses: API_BASE = ""),
//   - FAIL-CLOSED: a missing body/method is a 400; an upstream HTTP error
//     passes the upstream status + body through VERBATIM (the web3.js
//     rpc-client reads the JSON-RPC `error` member itself); a transport
//     failure (network down / 15s timeout) is a 502 with the route's error
//     code so callers can distinguish "not yet" from "broken".
//   - POST accepts the JSON-RPC body {jsonrpc,id,method,params} (single
//     object OR batch array — web3.js sends both shapes); GET accepts
//     ?method=<rpcMethod>&params=<json-encoded array> for curl/tests.

import { cors } from "../_cors.js";

/** The app's Solana RPC default (same endpoint the client uses when
 *  VITE_SOLANA_RPC is unset — src/lib/teleportConstants.js), so the proxied
 *  reads behave exactly like the direct ones did. */
export const DEFAULT_SOLANA_RPC = "https://berty-633y20-fast-mainnet.helius-rpc.com";

/** The app's X1 mainnet RPC default (src/lib/teleportConstants.js X1_RPC). */
export const DEFAULT_X1_RPC = "https://rpc.mainnet.x1.xyz";

/** Upstream timeout (ms) — a hung RPC fails closed as a 502, never hangs. */
export const RPC_TIMEOUT_MS = 15000;

/**
 * Build a JSON-RPC body from the GET query form (?method=&params=).
 * Pure + exported so the GET contract is unit-testable.
 *
 * @param {{method: ?string, params: ?string}} q
 * @returns {{body?: object, error?: string}} { body } on success, or
 *   { error: "missing_method" | "invalid_params" } — params must be a
 *   JSON-encoded ARRAY (JSON-RPC params are positional).
 */
export function buildRpcBodyFromQuery({ method, params } = {}) {
  if (method === undefined || method === null || String(method).trim() === "") {
    return { error: "missing_method" };
  }
  let p = [];
  if (params !== undefined && params !== null && String(params).trim() !== "") {
    try {
      p = JSON.parse(String(params));
    } catch {
      return { error: "invalid_params" };
    }
    if (!Array.isArray(p)) return { error: "invalid_params" };
  }
  return { body: { jsonrpc: "2.0", id: 1, method: String(method).trim(), params: p } };
}

/**
 * Create an RPC passthrough proxy handler (factory — tests inject fetchImpl
 * + upstream; the default export of each api/rpc/*.js uses the real fetch
 * and the chain's mainnet upstream).
 *
 * @param {object} deps
 * @param {string} deps.upstream the upstream JSON-RPC URL this route proxies
 *   (the SAME endpoint the app used to hit directly)
 * @param {string} deps.errorCode the 502 error code for this route, e.g.
 *   "solana_rpc_failed"
 * @param {Function} [deps.fetchImpl] async (url, init) => Response-like
 *   (default: global fetch)
 * @param {number} [deps.timeoutMs] upstream timeout (default RPC_TIMEOUT_MS)
 * @returns {{handler: Function}}
 */
export function createRpcProxy({ upstream, errorCode, fetchImpl, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  if (!upstream) throw new Error("createRpcProxy: `upstream` is required");
  if (!errorCode) throw new Error("createRpcProxy: `errorCode` is required");
  const fetchFn = fetchImpl ?? ((url, init) => fetch(url, init));
  const base = String(upstream).replace(/\/+$/, "");

  async function handler(req, res) {
    if (!cors(req, res)) return;
    if (req.method === "OPTIONS") return res.status(200).end();

    // Resolve the JSON-RPC body: POST carries it in the body (web3.js),
    // GET builds it from ?method=&params= (curl/tests).
    let body;
    if (req.method === "GET") {
      const rawMethod = req.query?.method;
      const method = Array.isArray(rawMethod) ? rawMethod[0] : rawMethod;
      const rawParams = req.query?.params;
      const params = Array.isArray(rawParams) ? rawParams[0] : rawParams;
      const built = buildRpcBodyFromQuery({ method, params });
      if (built.error) {
        return res.status(400).json({
          error: built.error,
          message: built.error === "missing_method"
            ? "GET requires ?method=<rpcMethod>&params=<json-encoded array>."
            : "`params` must be a JSON-encoded array (JSON-RPC params are positional).",
        });
      }
      body = built.body;
    } else {
      body = req.body;
      if (body === undefined || body === null) {
        return res.status(400).json({
          error: "missing_body",
          message: "POST a JSON-RPC body {jsonrpc,id,method,params} (or a batch array).",
        });
      }
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          return res.status(400).json({ error: "invalid_body", message: "The body is not valid JSON." });
        }
      }
      if (Array.isArray(body)) {
        if (body.length === 0) {
          return res.status(400).json({ error: "empty_batch", message: "A JSON-RPC batch cannot be empty." });
        }
      } else if (typeof body !== "object" || body === null || !body.method) {
        return res.status(400).json({
          error: "missing_method",
          message: "The JSON-RPC body must include a `method`.",
        });
      }
    }

    // Forward VERBATIM to the upstream and return its JSON verbatim.
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let upstreamRes;
      try {
        upstreamRes = await fetchFn(base, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
      const text = await upstreamRes.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text }; // non-JSON upstream — keep the text visible
      }
      res.status(upstreamRes.status).json(data);
    } catch (err) {
      res.status(502).json({
        error: errorCode,
        message: String(err?.message || err),
      });
    }
  }

  return { handler };
}
