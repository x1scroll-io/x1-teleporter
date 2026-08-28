// api/lifi/quote.js — the money path. Forces integrator + fee onto every quote
// so it can't be stripped or tampered from the browser.
//
// FEE POLICY (2026-08-28): Teleporter's fee is exactly 1% of the route total,
// charged once per journey. For x1-class routes (journeys that touch the Warp
// bridge — sol_x1, x1, x1_reverse, x1_onward) the LiFi fee param is OMITTED
// entirely — absent means absent, never fee=0: the stage-2 on-chain skim is
// the only Teleporter fee on that class, and Warp's $1 flat is a third-party
// pass-through. Non-X1 (same-chain) routes keep the 1% integrator — that IS
// their once-per-journey Teleporter fee.
//
// How the server knows the class: our own frontend marks x1-class journeys
// with `x1Class=1` (only ever set for routeTypes x1 / x1_onward — the only
// x1-class routes with a LiFi leg; sol_x1 and x1_reverse never call LiFi).
// The server VALIDATES the marker: an x1-class LiFi leg must have Solana on
// one end (X1 is only reachable through the Solana Warp bridge), otherwise the
// marker is rejected and the 1% integrator fee is forced. The fee param is
// ALWAYS decided server-side: STRIPPED (deleted) on x1-class routes, forced
// to 0.01 on same-chain routes — so the browser can neither strip the 1% on
// same-chain routes nor add an integrator fee on x1-class routes. The marker
// is stripped before the request is forwarded to LI.Fi.
import { lifiGet, INTEGRATOR, INTEGRATOR_FEE } from "../_lifi.js";
import { cors } from "../_cors.js";

const X1_CLASS_MARKER = "x1Class";
const SOL_LIFI_KEY = "SOL";

/** Decide the fee the server will FORCE for this quote request. Pure + exported
 *  so the fee policy is unit-testable without a live LiFi call. Returns null
 *  (OMIT the fee key entirely — absent means absent, never fee=0) for x1-class
 *  requests, INTEGRATOR_FEE ("0.01") otherwise.
 *
 *  x1-class rule: the request must (a) carry x1Class=1 AND (b) have Solana on
 *  one end of the LiFi leg — every x1-class LiFi leg is EVM↔Solana (X1 is only
 *  reachable via the Solana Warp bridge). A marker without a Solana leg is
 *  rejected (falls back to the 1% integrator fee), so a same-chain EVM→EVM
 *  request can never claim x1-class to dodge the fee.
 */
export function resolveForcedFee(params) {
  const isX1Class = params.get(X1_CLASS_MARKER) === "1";
  if (!isX1Class) return INTEGRATOR_FEE;
  const fromChain = params.get("fromChain");
  const toChain = params.get("toChain");
  const touchesSolana = fromChain === SOL_LIFI_KEY || toChain === SOL_LIFI_KEY;
  return touchesSolana ? null : INTEGRATOR_FEE;
}

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const params = new URLSearchParams(req.query);
    // FORCE these — overwrite anything the client sent.
    params.set("integrator", INTEGRATOR);
    const forcedFee = resolveForcedFee(params);
    if (forcedFee === null) {
      // x1-class: NO fee param at all — absent means absent (strip any the
      // browser sent; never fee=0). The stage-2 skim is the only Teleporter fee.
      params.delete("fee");
    } else {
      params.set("fee", forcedFee);
    }
    // The x1Class marker is ours, not LI.Fi's — never forward it upstream.
    params.delete(X1_CLASS_MARKER);
    const { status, data } = await lifiGet(`/quote?${params}`);
    res.status(status).json(data);
  } catch (err) {
    res.status(502).json({ error: "lifi_quote_failed", message: String(err.message || err) });
  }
}
