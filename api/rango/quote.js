// api/rango/quote.js — serverless proxy for Rango's basic quote endpoint
// (GET {base}/basic/quote). Phase-5 scaffold.
//
// KEY HYGIENE (same rule as api/thorchain/quote.js — PR #20 SECURITY FIX):
// the Rango API key must NEVER be a VITE_/NEXT_PUBLIC_ var — those compile
// into the browser bundle. Rango attaches the key as the `apiKey` QUERY
// PARAM (docs …/api-key-and-rate-limits — verified live 2026-09-05:
// keyless calls to api.rango.exchange 401 with an empty body). This proxy
// appends the key server-side from RANGO_API_KEY (no prefix, no VITE_
// variants) and the client calls /api/rango/quote instead of Rango
// directly (see src/lib/rango/quote.js shapeQuoteRequestArtifact).
//
// Same pattern as api/thorchain/quote.js:
//   - same CORS allowlist (api/_cors.js — 403 on foreign origins, no-Origin
//     passthrough for same-origin fetches, which is the path production
//     actually uses: API_BASE = ""),
//   - fail-closed stance: no server key → no quote (502 no_api_key), and an
//     upstream failure is a 502, never a silent partial,
//   - 15s upstream timeout (same as api/_lifi.js lifiGet).
//
// PARAM WHITELIST: only from / to / amount / slippage are forwarded —
// exactly the quote params the client sends (src/lib/rango/quote.js
// QUOTE_FORWARD_PARAMS). Nothing else from the query string passes through
// to Rango. The referrer pair (referrerFee / referrerAddress) is NOT
// client-forwardable: it is decided server-side by the config placeholders
// (src/lib/rango/config.js — empty until Mr. Esters rules the fee class),
// so the browser can neither strip nor invent affiliate fees.
import { cors } from "../_cors.js";

// SERVER-SIDE referrer-fee placeholder — mirrors src/lib/rango/config.js
// RANGO_REFERRER_FEE (api/ functions never import src/: each function is
// self-contained, same rule as api/_lifi.js's hardcoded INTEGRATOR_FEE).
// EMPTY until Mr. Esters rules the Rango lane's fee class — while empty,
// quotes carry NO referrerFee (nothing invented is ever sent). When ruled
// (e.g. "0.5" = fee-model v2 as a source-side charge), set it HERE and in
// src/lib/rango/config.js — both must match exactly.
const RANGO_REFERRER_FEE = "";

/** The Rango basic-quote path (appended to the API base). */
export const RANGO_QUOTE_PATH = "/basic/quote";

/** Default upstream base — the PRIVATE-key host. The docs publish a PUBLIC
 *  TEST key (c6381a79-2817-4602-83bf-6a641a409e32) that ONLY works against
 *  https://public-api.rango.exchange — for trials set the server override
 *  RANGO_API_URL=https://public-api.rango.exchange (never bake the test key
 *  into code). Server override: RANGO_API_URL (no VITE_ prefix). */
export const RANGO_DEFAULT_API_BASE_URL = "https://api.rango.exchange";

/** Whitelist of client-forwardable params — the proxy never passes through
 *  anything else (keep in sync with src/lib/rango/quote.js
 *  QUOTE_FORWARD_PARAMS). */
export const FORWARD_PARAMS = Object.freeze(["from", "to", "amount", "slippage"]);

/** Build the upstream Rango quote URL from the client query, forwarding
 *  ONLY the whitelisted params (empty ones dropped) + the server-side
 *  apiKey + the referrerFee pair ONLY when the config placeholder is set.
 *  Pure + exported so the whitelist contract is unit-testable without a
 *  live upstream.
 *
 * @param {object|URLSearchParams} query the client query (req.query shape)
 * @param {string} apiKey the server-side Rango API key
 * @param {string} [baseUrl] upstream base URL (default:
 *   RANGO_DEFAULT_API_BASE_URL)
 * @returns {string} e.g. https://api.rango.exchange/basic/quote?from=SUI.SUI&...
 */
export function proxyQuoteUrl(query, apiKey, baseUrl = RANGO_DEFAULT_API_BASE_URL) {
  const forward = new URLSearchParams();
  for (const name of FORWARD_PARAMS) {
    const raw = query instanceof URLSearchParams ? query.get(name) : query?.[name];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v !== undefined && v !== null && String(v) !== "") forward.set(name, String(v));
  }
  if (RANGO_REFERRER_FEE !== "") forward.set("referrerFee", String(RANGO_REFERRER_FEE));
  forward.set("apiKey", apiKey);
  const qs = forward.toString();
  return `${String(baseUrl).replace(/\/+$/, "")}${RANGO_QUOTE_PATH}${qs ? `?${qs}` : ""}`;
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
export function createRangoQuoteProxy(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const env = deps.env ?? process.env;
  const baseUrl = deps.baseUrl ?? env.RANGO_API_URL ?? RANGO_DEFAULT_API_BASE_URL;

  async function handler(req, res) {
    if (!cors(req, res)) return;
    if (req.method === "OPTIONS") return res.status(200).end();

    // FAIL CLOSED (server-side): no key, no quote. The client never holds
    // the key, so this is the ONLY place the key can be missing — and Rango
    // 401s keyless calls, so the proxy refuses instead of leaking 401 noise.
    const apiKey = typeof env.RANGO_API_KEY === "string" ? env.RANGO_API_KEY.trim() : "";
    if (apiKey === "") {
      return res.status(502).json({
        error: "no_api_key",
        message: "Rango quote unavailable — the server key is not configured (parked item).",
      });
    }

    try {
      const url = proxyQuoteUrl(req.query, apiKey, baseUrl);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      let upstream;
      try {
        upstream = await fetchImpl(url, {
          headers: { Accept: "application/json" },
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
      // parseRangoQuoteResponse handles Rango error bodies and non-OK
      // resultTypes (NO_ROUTE / HIGH_IMPACT / INPUT_LIMIT_ISSUE).
      res.status(upstream.status).json(data);
    } catch (err) {
      res.status(502).json({
        error: "rango_quote_failed",
        message: String(err?.message || err),
      });
    }
  }

  return { handler };
}

export default createRangoQuoteProxy().handler;
