// api/_lifi.js — shared helpers for the LiFi serverless functions.
// Vercel runs each /api/*.js as a serverless function. These run server-side,
// so the integrator string + API key never reach the browser.

export const LIFI = "https://li.quest/v1";

// HARDCODED — must match the integration registered at portal.li.fi exactly.
// (Do NOT read from process.env here: a stale/wrong Vercel env var was
// overriding this with "x1scroll-teleporter" and breaking fee collection.)
// INTEGRATOR_FEE = the LiFi integrator fee param forced onto every non-X1
// (same-chain) quote — the once-per-journey Teleporter fee for that lane.
// FEE-MODEL v2 (2026-09-02): 0.5% (was 1%). OPS: the LiFi portal config for
// x1-teleporter-labs must charge 0.5% to match — verify before any
// same-chain go-live (the x1-class lanes never send this param).
export const INTEGRATOR = "x1-teleporter-labs";
export const INTEGRATOR_FEE = "0.005";
export const FEE_WALLET_EVM = process.env.FEE_WALLET_EVM || "";
export const FEE_WALLET_SVM = process.env.FEE_WALLET_SVM || "";

export function lifiHeaders() {
  const h = { Accept: "application/json" };
  if (process.env.LIFI_API_KEY) h["x-lifi-api-key"] = process.env.LIFI_API_KEY;
  return h;
}

export async function lifiGet(pathAndQuery) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${LIFI}${pathAndQuery}`, { headers: lifiHeaders(), signal: ctrl.signal });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: r.status, data };
  } finally { clearTimeout(t); }
}

// CORS moved to api/_cors.js — an allowlist (production + preview origins
// only, explicit 403 for everything else). Import `cors` from "../_cors.js".
// See api/_cors.js for the allowlist + rejection decisions (Step 1.3B).
