// api/changenow/status.js — serverless proxy for ChangeNow's v2 exchange-status
// endpoint (/v2/exchange/{id}).
//
// KEY HYGIENE (same rule as api/changenow/{quote,create,minAmount}.js): the
// ChangeNow API key must NEVER be a VITE_/NEXT_PUBLIC_ var. This proxy reads
// CHANGENOW_API_KEY server-side and attaches it as the `x-changenow-api-key`
// header; the client only ever calls /api/changenow/status?id=….
//
// WHY THIS EXISTS: ChangeNOW's v2 API has no CORS for a browser page, so the
// deposit panel's status poller cannot hit api.changenow.io directly. The
// proxy is the same-origin seam (the client polls here).
//
// SAME CONTRACTS as the sibling proxies:
//   - CORS allowlist (api/_cors.js): 403 on foreign origins, no-Origin passthrough.
//   - Fail-closed: no server key -> 502 no_api_key; missing id -> 400; upstream
//     failure -> 502, never a silent partial.
//   - Param whitelist: ONLY `id` is forwarded (as a path segment, URL-encoded).
//   - 15s upstream timeout.

import { cors } from "../_cors.js";

export const CHANGENOW_API_BASE = "https://api.changenow.io";
export const CHANGENOW_EXCHANGE_STATUS_PATH = "/v2/exchange";
export const CHANGENOW_KEY_HEADER = "x-changenow-api-key";

/**
 * Build the upstream status URL for an exchange id, forwarding ONLY the id as
 * the path segment (URL-encoded, so a crafted id can never break out of the
 * path). Pure + exported for unit testing without a live upstream.
 */
export function buildStatusUrl(id) {
  const clean = String(id ?? "").trim();
  return `${CHANGENOW_API_BASE}${CHANGENOW_EXCHANGE_STATUS_PATH}/${encodeURIComponent(clean)}`;
}

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = typeof req.query?.id === "string" ? req.query.id.trim() : "";
  if (id === "") {
    return res.status(400).json({ error: "missing_params", message: "id is required." });
  }

  const apiKey = typeof process.env.CHANGENOW_API_KEY === "string"
    ? process.env.CHANGENOW_API_KEY.trim()
    : "";
  if (!apiKey) {
    return res.status(502).json({ error: "no_api_key", message: "ChangeNow API key is not configured server-side." });
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(buildStatusUrl(id), {
      headers: { accept: "application/json", [CHANGENOW_KEY_HEADER]: apiKey },
      signal: ctrl.signal,
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(502).json({ error: "changenow_status_failed", message: String(data?.error || data?.message || upstream.status) });
    }
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "changenow_status_failed", message: String(err?.message || err) });
  } finally {
    clearTimeout(t);
  }
}
