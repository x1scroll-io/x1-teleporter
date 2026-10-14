// api/thorchain/quote.js — serverless proxy for THORChain's aggregator quote
// endpoint (/thorchain/quote/swap). SECURITY FIX (PR #20): the THORChain
// aggregator key must NEVER be a VITE_/NEXT_PUBLIC_ var — those compile into
// the browser bundle and leak the key to every visitor. This proxy holds the
// key server-side (THORCHAIN_API_KEY — no prefix, no VITE_/NEXT_PUBLIC_
// variants) and the client calls /api/thorchain/quote instead of THORNode
// directly (see src/lib/thorchain/quote.js).
//
// Same pattern as api/lifi/tools.js + api/lifi/quote.js:
//   - same CORS allowlist (api/_cors.js — 403 on foreign origins, no-Origin
//     passthrough for same-origin fetches, which is the path production
//     actually uses: API_BASE = ""),
//   - fail-closed stance: no server key → no quote (502 no_api_key), and an
//     upstream failure is a 502, never a silent partial,
//   - 15s upstream timeout (same as api/_lifi.js lifiGet).
//
// PARAM WHITELIST: only from_asset / to_asset / amount / destination /
// refund_address / affiliate / affiliate_bps are forwarded — exactly the
// params the client sends (src/lib/thorchain/quote.js quoteUrl). Nothing
// else from the query string passes through to THORNode.
import { cors } from "../_cors.js";

/** THORNode aggregator quote path (same contract the client used to hit
 *  directly — now server-side only). The default base below is the Liquify
 *  gateway's THORNode API ROOT (https://gateway.liquify.com/chain/thorchain_api)
 *  and the /thorchain prefix lives HERE in the path constants, so the resolved
 *  upstream URL is
 *    https://gateway.liquify.com/chain/thorchain_api/thorchain/quote/swap
 *  — LIVE-VERIFIED 2026-09-02: the gateway answers with real THORNode bodies
 *  (HTTP 400 "trading is halted … invalid request" on a quote probe, i.e. the
 *  host + path + header format are all correct against the live backend). */
export const THORCHAIN_QUOTE_PATH = "/thorchain/quote/swap";

/** Default upstream root — the LIVE Liquify gateway's THORNode API prefix.
 *  The previously documented hosts are all RETIRED/DNS-dead: liquify.thorchain.org
 *  (dead — verified HTTP 000) and the *.ninerealms.com mirrors (retired
 *  2026-04-20 per Mr. Esters). Same default root as the Step 3.1 status module
 *  (THORCHAIN_STATUS_BASE_URL). Server override: THORCHAIN_API_URL (no VITE_
 *  prefix) — an override keeps its historical meaning (a THORNode API root;
 *  the /thorchain/* path constants are appended to it). */
export const THORCHAIN_DEFAULT_API_BASE_URL = "https://gateway.liquify.com/chain/thorchain_api";

/** The documented aggregator-key header (integrate-thorchain program). */
export const THORCHAIN_API_KEY_HEADER = "x-client-id";

/** Whitelist of client-forwardable params — the proxy never passes through
 *  anything else. */
export const FORWARD_PARAMS = Object.freeze([
  "from_asset",
  "to_asset",
  "amount",
  "destination",
  "refund_address",
  "affiliate",
  "affiliate_bps",
]);

/** Build the upstream THORNode quote URL from the client query, forwarding
 *  ONLY the whitelisted params (empty ones dropped). Pure + exported so the
 *  whitelist contract is unit-testable without a live upstream.
 *
 * @param {object|URLSearchParams} query the client query (req.query shape)
 * @param {string} [baseUrl] upstream base URL (default:
 *   THORCHAIN_DEFAULT_API_BASE_URL)
 * @returns {string} e.g. https://gateway.liquify.com/chain/thorchain_api/thorchain/quote/swap?from_asset=BTC.BTC&...
 */
export function proxyQuoteUrl(query, baseUrl = THORCHAIN_DEFAULT_API_BASE_URL) {
  const forward = new URLSearchParams();
  for (const name of FORWARD_PARAMS) {
    const raw = query instanceof URLSearchParams ? query.get(name) : query?.[name];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v !== undefined && v !== null && String(v) !== "") forward.set(name, String(v));
  }
  const qs = forward.toString();
  return `${String(baseUrl).replace(/\/+$/, "")}${THORCHAIN_QUOTE_PATH}${qs ? `?${qs}` : ""}`;
}

/**
 * Create the quote proxy handler. Exported as a factory so tests inject a
 * fetchImpl + env; the default export (what Vercel invokes) uses the real
 * fetch and process.env. The key is read at CALL time — never at module
 * load — so a missing key fails closed per request, not at boot.
 *
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl] async (url, init) => Response-like
 *   (default: global fetch)
 * @param {object} [deps.env] env object (default: process.env)
 * @param {string} [deps.baseUrl] upstream base URL override
 * @returns {{handler: Function}}
 */
export function createThorchainQuoteProxy(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const env = deps.env ?? process.env;
  const baseUrl = deps.baseUrl ?? env.THORCHAIN_API_URL ?? THORCHAIN_DEFAULT_API_BASE_URL;

  async function handler(req, res) {
    if (!cors(req, res)) return;
    if (req.method === "OPTIONS") return res.status(200).end();

    // FAIL CLOSED (server-side): no key, no quote. The client never holds
    // the key, so this is the ONLY place the key can be missing — and a
    // quote without the aggregator key would silently skip affiliate
    // attribution, so the proxy refuses instead.
    const apiKey = typeof env.THORCHAIN_API_KEY === "string" ? env.THORCHAIN_API_KEY.trim() : "";
    if (apiKey === "") {
      return res.status(502).json({
        error: "no_api_key",
        message: "THORChain quote unavailable — the server key is not configured (parked item).",
      });
    }

    try {
      const url = proxyQuoteUrl(req.query, baseUrl);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      let upstream;
      try {
        upstream = await fetchImpl(url, {
          headers: { Accept: "application/json", [THORCHAIN_API_KEY_HEADER]: apiKey },
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
        data = { raw: text };
      }
      // Pass the upstream status + body through verbatim — the client's
      // parseQuoteResponse handles THORNode error bodies and non-2xx codes.
      res.status(upstream.status).json(data);
    } catch (err) {
      res.status(502).json({
        error: "thorchain_quote_failed",
        message: String(err?.message || err),
      });
    }
  }

  return { handler };
}

export default createThorchainQuoteProxy().handler;
