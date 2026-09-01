// api/_warp.js — shared helpers for the Warp status/signatures serverless
// proxies (api/warp/status.js + api/warp/signatures.js).
//
// WHY THESE PROXIES EXIST (2026-09-01, fix/proxy-warp-poll): the REVERSE
// release poll (X1 burn → Solana release) was failing in the browser while
// being provably correct server-side. Burns executed on X1, guardians
// released on Solana (verified: every burn `status: executed` with
// `destTxSig` present, 7/5 guardian sigs) — yet the UI stayed stuck on
// "Still awaiting the release". The poller (src/warpBridge.js pollWarpStatus)
// fetched api.bridge.mainnet.x1.xyz DIRECTLY from the browser; the deployed
// build contained the correct detection logic, CORS was `*`, the API returned
// the right shape with `from=x1` — and the browser session still didn't
// advance, and it could NOT be reproduced/debugged from the server. ELIMINATE
// the variable: route the poll through the app's OWN serverless function
// (same-origin /api/warp/*), exactly like /api/lifi/quote already does for
// LiFi. The poll is now a deterministic same-origin fetch to the app's
// backend — no CORS, no cache, no browser-network variance.

import { cors } from "./_cors.js";

/** The Warp status API base (same host the browser used to hit directly). */
export const WARP_API_MAINNET = "https://api.bridge.mainnet.x1.xyz";

/** Build the upstream Warp API URL for a source transaction.
 *    kind="status"     → {base}/transactions/{sig}?from={from}
 *    kind="signatures" → {base}/transactions/{sig}/signatures?from={from}
 *  Pure + exported so the URL contract is unit-testable without a live fetch.
 */
export function buildWarpUrl({ sig, from, kind = "status", baseUrl = WARP_API_MAINNET }) {
  const qs = new URLSearchParams();
  if (from !== undefined && from !== null && String(from) !== "") qs.set("from", String(from));
  const q = qs.toString();
  const suffix = kind === "signatures" ? "/signatures" : "";
  return `${String(baseUrl).replace(/\/+$/, "")}/transactions/${encodeURIComponent(String(sig))}${suffix}${q ? `?${q}` : ""}`;
}

/**
 * Create a Warp proxy handler (factory — tests inject fetchImpl + baseUrl;
 * the default export of each api/warp/*.js uses the real fetch and the
 * mainnet base). Mirrors api/thorchain/quote.js createThorchainQuoteProxy:
 *   - same CORS allowlist (api/_cors.js — 403 on foreign origins, no-Origin
 *     passthrough for same-origin fetches, which is the path production
 *     actually uses: API_BASE = ""),
 *   - FAIL-CLOSED: a missing `sig` is a 400; an upstream HTTP error passes
 *     the upstream status + body through VERBATIM (the poller reads the
 *     nested { transaction: { status, destTxSig } } shape and treats a 404
 *     before guardian sigs as awaiting_guardians — never an exception); a
 *     transport failure (network down / 15s timeout) is a 502 so the poller
 *     can distinguish "not yet" from "broken".
 *
 * @param {object} [deps]
 * @param {"status"|"signatures"} [deps.kind]
 * @param {Function} [deps.fetchImpl] async (url, init) => Response-like
 *   (default: global fetch)
 * @param {string} [deps.baseUrl] upstream base URL override
 * @returns {{handler: Function}}
 */
export function createWarpProxy({ kind = "status", fetchImpl, baseUrl } = {}) {
  const fetchFn = fetchImpl ?? ((url, init) => fetch(url, init));
  const base = baseUrl ?? process.env.WARP_API_BASE ?? WARP_API_MAINNET;
  const endpoint = kind === "signatures" ? "signatures" : "status";

  async function handler(req, res) {
    if (!cors(req, res)) return;
    if (req.method === "OPTIONS") return res.status(200).end();

    const rawSig = req.query?.sig;
    const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig;
    if (sig === undefined || sig === null || String(sig).trim() === "") {
      return res.status(400).json({
        error: "missing_sig",
        message: "The `sig` query param (the source transaction signature) is required.",
      });
    }
    const rawFrom = req.query?.from;
    const from = Array.isArray(rawFrom) ? rawFrom[0] : rawFrom;

    const url = buildWarpUrl({ sig, from, kind: endpoint, baseUrl: base });
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      let upstream;
      try {
        upstream = await fetchFn(url, {
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
      // Pass the upstream status + body through verbatim — the poller handles
      // non-ok gracefully (404 = awaiting_guardians, fail/terminal = failed).
      res.status(upstream.status).json(data);
    } catch (err) {
      res.status(502).json({
        error: `warp_${endpoint}_failed`,
        message: String(err?.message || err),
      });
    }
  }

  return { handler };
}
