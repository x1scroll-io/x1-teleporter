// api/_cors.js — shared CORS allowlist for the serverless API functions.
//
// DECISION (Step 1.3B, 2026-08-28): the /api/lifi/* proxy endpoints force OUR
// integrator + fee onto every quote and hold the LiFi API key server-side, so
// they must not be callable from arbitrary websites (that would let any site
// burn our API quota and drive quotes through our fee config). The same
// restriction is applied to api/earnings.js and api/withdraw/[chainId].js,
// which shared the old wide-open `*` helper — leaving them open would have
// been a straight bypass of this step (foreign origins scraping earnings or
// hitting the withdraw-tx builder).
//
// ALLOWLIST (exactly):
//   1. Production:      https://x1teleporter.com
//   2. Custom preview:  https://next.x1teleporter.com
//   3. Vercel previews: *.vercel.app — every preview deployment gets a
//      x1teleporter-*.vercel.app URL; the suffix IS the preview family
//      (the runbook's "production and preview origins").
//
// REJECTION BEHAVIOR (chosen: explicit 403): a disallowed origin gets a 403
// JSON response, not merely missing CORS headers. The 403 also answers the
// OPTIONS preflight, so a browser on a foreign origin is blocked before the
// real request is ever sent — the stronger statement of the two options.
//
// NO Origin header (same-origin page fetches, curl, server-to-server) is
// allowed through WITHOUT CORS headers — there is nothing to restrict:
// browsers only send Origin on cross-origin requests and same-origin requests
// never consult CORS. This is the path production actually uses (the client
// calls /api/* same-origin via API_BASE = "").
//
// Deliberately NOT allowed: http:// (plaintext) variants of anything,
// localhost, bare vercel.app (preview deployments are always subdomains), and
// lookalike/suffix-attack hosts like x1teleporter.com.evil.com.
export const ALLOWED_ORIGINS = Object.freeze([
  "https://x1teleporter.com",
  "https://next.x1teleporter.com",
]);

const VERCEL_PREVIEW_SUFFIX = ".vercel.app";

// Normalize + check an Origin header value against the allowlist.
// Returns true when there is no Origin (nothing to restrict).
export function isAllowedOrigin(origin) {
  if (!origin) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  // Exact match on the two named origins. u.origin is normalized: scheme +
  // host, default port dropped, host lowercased — so casing/trailing-slash
  // variants still match, and userinfo tricks (x1teleporter.com@evil.com)
  // resolve to the real host and fail.
  if (ALLOWED_ORIGINS.includes(u.origin)) return true;
  // Vercel preview family: any https subdomain of vercel.app.
  return u.hostname.toLowerCase().endsWith(VERCEL_PREVIEW_SUFFIX);
}

// Apply CORS for a request. Returns true when the request may proceed (CORS
// headers set for an allowed origin; nothing set when no Origin was sent).
// Returns false when the origin is disallowed — a 403 JSON response has
// already been sent and the handler must return immediately.
export function cors(req, res) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  if (!isAllowedOrigin(origin)) {
    res.status(403).json({ error: "origin_not_allowed" });
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // stepTransaction is a POST with a JSON body → Content-Type must be
  // preflight-allowable for cross-origin callers from allowed origins.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  return true;
}
