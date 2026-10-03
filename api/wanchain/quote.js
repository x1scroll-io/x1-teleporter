// api/wanchain/quote.js — serverless proxy for the Wanchain-family quote
// endpoint (XFlows v3: POST https://xflows.wanchain.org/api/v3/quote).
//
// WHY A PROXY (same reasoning as api/rango/quote.js + api/thorchain/quote.js):
//   1. KEY HYGIENE: XFlows is keyless TODAY (verified live 2026-09-05). If
//      Wanchain ever adds a key, it must NEVER be a VITE_/NEXT_PUBLIC_ var —
//      it would compile into the browser bundle. This proxy is the seam: a
//      future key lives server-side only (see the WANCHAIN_API_URL override
//      below) and the client never knows it.
//   2. PARAM WHITELIST: only the documented quote fields pass through
//      (FORWARD_FIELDS — the mirror of src/lib/wanchain/quote.js
//      QUOTE_FORWARD_FIELDS; keep the two in sync). Nothing else from the
//      request body reaches the upstream.
//   3. Same CORS allowlist as every other api/ route (api/_cors.js — 403 on
//      foreign origins; no-Origin passthrough for same-origin fetches).
//
// FAIL-CLOSED stance (same as the Rango proxy): an upstream failure is a
// 502, never a silent partial; a non-JSON upstream body is surfaced as a
// 502 with the raw text (never parsed into a fake success).
import { cors } from "../_cors.js";

/** The Wanchain-family (XFlows v3) quote path (appended to the API base). */
export const WANCHAIN_QUOTE_PATH = "/api/v3/quote";

/** Default upstream base — the XFlows v3 public API (keyless, verified
 *  live 2026-09-05). Server override: WANCHAIN_API_URL (no VITE_ prefix) —
 *  e.g. a future keyed host or a testnet mirror. */
export const WANCHAIN_DEFAULT_API_BASE_URL = "https://xflows.wanchain.org";

/** Whitelist of client-forwardable body fields — the proxy never forwards
 *  anything else (keep in sync with src/lib/wanchain/quote.js
 *  QUOTE_FORWARD_FIELDS). */
export const FORWARD_FIELDS = Object.freeze([
  "fromChainId",
  "toChainId",
  "fromTokenAddress",
  "toTokenAddress",
  "fromAddress",
  "toAddress",
  "fromAmount",
  "slippage",
  "bridge",
]);

/** Build the upstream XFlows v3 quote URL (base + path). Pure + exported so
 *  the proxy contract is unit-testable without a live upstream. */
export function proxyQuoteUrl(baseUrl = WANCHAIN_DEFAULT_API_BASE_URL) {
  return `${String(baseUrl).replace(/\/+$/, "")}${WANCHAIN_QUOTE_PATH}`;
}

/**
 * Create the quote proxy handler. Exported as a factory so tests inject a
 * fetchImpl + env; the default export (what Vercel invokes) uses the real
 * fetch and process.env. Reads the optional server override at call time.
 *
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl] async (url, init) => Response-like
 *   (default: global fetch)
 * @param {object} [deps.env] env object (default: process.env)
 * @returns {{handler: Function}}
 */
export function createWanchainQuoteProxy(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const env = deps.env ?? process.env;

  async function handler(req, res) {
    if (!cors(req, res)) return;
    if (req.method === "OPTIONS") return res.status(200).end();
    // The XFlows v3 quote endpoint is a POST with a JSON body. Anything
    // else is refused (fail closed — no GET fallback, no silent pass).
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method_not_allowed", message: "POST only" });
    }

    const baseUrl = typeof env.WANCHAIN_API_URL === "string" && env.WANCHAIN_API_URL.trim() !== ""
      ? env.WANCHAIN_API_URL.trim()
      : WANCHAIN_DEFAULT_API_BASE_URL;

    let body;
    try {
      body = typeof req.body === "object" && req.body !== null ? req.body : JSON.parse(req.body || "{}");
    } catch {
      return res.status(400).json({ error: "invalid_json", message: "request body must be JSON" });
    }

    // Whitelist: forward ONLY the documented fields (empty ones dropped).
    const forward = {};
    for (const name of FORWARD_FIELDS) {
      const v = body[name];
      if (v !== undefined && v !== null && String(v) !== "") forward[name] = v;
    }

    try {
      const url = proxyQuoteUrl(baseUrl);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      let upstream;
      try {
        upstream = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(forward),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
      const text = await upstream.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON upstream body — fail closed, surface the raw text.
        return res.status(502).json({
          error: "wanchain_quote_non_json",
          message: String(text).slice(0, 500),
        });
      }
      // Pass the upstream status + body through verbatim — the client's
      // parseWanchainQuoteResponse handles both the OK shape and the real
      // failure bodies ({success:false, error:"…"}).
      res.status(upstream.status).json(data);
    } catch (err) {
      res.status(502).json({
        error: "wanchain_quote_failed",
        message: String(err?.message || err),
      });
    }
  }

  return { handler };
}

export default createWanchainQuoteProxy().handler;
