// api/changenow/create.js — create a ChangeNow exchange (the deposit-address step).
//
// Same key hygiene + CORS + fail-closed contracts as quote.js: the key is read
// server-side (x-changenow-api-key header), never in the bundle; foreign origins
// 403; upstream failure -> 502.
//
// POST body whitelist: fromCurrency / toCurrency / fromAmount / address (payout)
// / refundAddress / extraId (memo/destination-tag for XRP/ADA-style payouts) /
// flow / type. `address` is REQUIRED (the payout destination) — the server
// refuses to create an exchange that cannot pay out.

import { cors } from "../_cors.js";

export const CHANGENOW_API_BASE = "https://api.changenow.io";
export const CHANGENOW_EXCHANGE_PATH = "/v2/exchange";
export const CHANGENOW_KEY_HEADER = "x-changenow-api-key";

/** Whitelist of client-forwardable body fields (empty values dropped). */
export const FORWARD_FIELDS = Object.freeze([
  "fromCurrency", "toCurrency", "fromAmount", "address", "refundAddress", "extraId", "flow", "type",
]);

export function buildExchangeBody(body) {
  const out = {};
  for (const k of FORWARD_FIELDS) {
    const v = body?.[k];
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  if (out.flow === undefined) out.flow = "standard";
  if (out.type === undefined) out.type = "direct";
  return out;
}

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const apiKey = typeof process.env.CHANGENOW_API_KEY === "string"
    ? process.env.CHANGENOW_API_KEY.trim()
    : "";
  if (!apiKey) return res.status(502).json({ error: "no_api_key", message: "ChangeNow API key is not configured server-side." });

  const body = buildExchangeBody(req.body);
  if (!body.fromCurrency || !body.toCurrency || !body.address || !body.fromAmount) {
    return res.status(400).json({ error: "missing_params", message: "fromCurrency/toCurrency/fromAmount/address are required." });
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(`${CHANGENOW_API_BASE}${CHANGENOW_EXCHANGE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", [CHANGENOW_KEY_HEADER]: apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(502).json({ error: "changenow_create_failed", message: String(data?.error || data?.message || upstream.status) });
    }
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "changenow_create_failed", message: String(err?.message || err) });
  } finally {
    clearTimeout(t);
  }
}
