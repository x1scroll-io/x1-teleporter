// api/changenow/quote.js — serverless proxy for ChangeNow's v2 estimate endpoint.
//
// KEY HYGIENE (same rule as api/thorchain/quote.js + api/rango/quote.js): the
// ChangeNow API key must NEVER be a VITE_/NEXT_PUBLIC_ var (those compile into
// the browser bundle). The proxy reads CHANGENOW_API_KEY server-side and attaches
// it as the `x-changenow-api-key` header; the client only ever calls /api/changenow/quote.
//
// SAME CONTRACTS as the other proxies:
//   - CORS allowlist (api/_cors.js): 403 on foreign origins, no-Origin passthrough
//     for same-origin fetches (the production path: API_BASE = "").
//   - Fail-closed: no server key -> 502 no_api_key; upstream failure -> 502, never
//     a silent partial.
//   - Param whitelist: only the quote params below are forwarded upstream.
//   - 15s upstream timeout.

import { cors } from "../_cors.js";

export const CHANGENOW_API_BASE = "https://api.changenow.io";
export const CHANGENOW_ESTIMATE_PATH = "/v2/exchange/estimated-amount";
export const CHANGENOW_KEY_HEADER = "x-changenow-api-key";

/** Whitelist of client-forwardable params (empty values dropped). */
export const FORWARD_PARAMS = Object.freeze([
  "fromCurrency", "toCurrency", "fromAmount", "fromNetwork", "toNetwork", "flow",
]);

/**
 * Build the upstream estimate URL from the client query, forwarding ONLY the
 * whitelisted params. Pure + exported for unit testing without a live upstream.
 */
export function buildEstimateUrl(query) {
  const params = new URLSearchParams();
  for (const k of FORWARD_PARAMS) {
    const v = query?.[k];
    if (typeof v === "string" && v.trim() !== "") params.set(k, v.trim());
  }
  return `${CHANGENOW_API_BASE}${CHANGENOW_ESTIMATE_PATH}?${params.toString()}`;
}

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = typeof process.env.CHANGENOW_API_KEY === "string"
    ? process.env.CHANGENOW_API_KEY.trim()
    : "";
  if (!apiKey) {
    return res.status(502).json({ error: "no_api_key", message: "ChangeNow API key is not configured server-side." });
  }

  const url = buildEstimateUrl(req.query);
  if (url.endsWith("?") || url.endsWith("=?")) {
    return res.status(400).json({ error: "missing_params", message: "fromCurrency/toCurrency/fromAmount are required." });
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(url, {
      headers: { accept: "application/json", [CHANGENOW_KEY_HEADER]: apiKey },
      signal: ctrl.signal,
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(502).json({ error: "changenow_quote_failed", message: String(data?.error || data?.message || upstream.status) });
    }
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "changenow_quote_failed", message: String(err?.message || err) });
  } finally {
    clearTimeout(t);
  }
}
