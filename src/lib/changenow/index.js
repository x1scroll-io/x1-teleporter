/**
 * changenow/index.js — the ChangeNOW (instant-swap) RAIL CLIENT.
 *
 * ChangeNOW is the SERVING rail for the LONG-TAIL source chains
 * (src/lib/teleportRail.js LONGTAIL_CHAINS — XMR/ADA/ATOM/NEAR/ZEC/DASH/BCH):
 * the sources no DEX rail can carry (privacy coins can't be routed through a
 * DEX; ADA/ATOM/NEAR/BCH have no native rail wired). The rail's execution
 * shape is DEPOSIT-ADDRESS — the user sends from their own external wallet and
 * the console never signs.
 *
 * This module is the ONLY client-side place that knows a long-tail chain's
 * ChangeNOW identity. It speaks to the SERVER-SIDE proxy (api/changenow/*),
 * which holds the API key and enforces CORS — the browser bundle never sees a
 * key and never calls ChangeNOW directly.
 *
 * NETWORK PARAM (why it matters): ChangeNOW keys a ticker to a NETWORK — a
 * same-name ticker on another chain is a DIFFERENT asset. Every long-tail
 * chain here is single-network, so the network is PINNED and ALWAYS sent
 * (fromNetwork on the quote; fromNetwork + toNetwork on the create). Omitting
 * it lets ChangeNOW guess and can price/pay the wrong asset.
 *
 * FAIL-CLOSED (the whole point): a long-tail coin is only offered when
 * ChangeNOW returns a REAL quote for the source→destination pair — a positive
 * `toAmount` (the rate) and, when the min endpoint answers, an amount at/above
 * the provider's per-pair minimum. Any error / empty / non-positive response
 * returns a not-ok result, so the caller (picker/rail) withholds the coin
 * instead of fabricating a rate. Nothing here invents a number.
 *
 * PURE-ish: every network call takes an injectable `fetchImpl` (defaults to
 * the global fetch) so the whole module runs under `node --test` with no live
 * upstream, and imports without a DOM.
 */
import { LONGTAIL_CHAINS, isLongtailChain } from "../teleportRail.js";

/** Same-origin proxy base — the key stays SERVER-side (api/changenow/*). */
export const CHANGENOW_API_BASE = "/api/changenow";

/** The long-tail source params for a chain, or null (non-long-tail chains
 *  have no ChangeNOW source identity here). */
export function changeNowSourceFor(chain) {
  if (!isLongtailChain(chain)) return null;
  const c = LONGTAIL_CHAINS[chain];
  return Object.freeze({
    fromCurrency: c.ticker,
    fromNetwork: c.network, // never omit — single-network asset
    asset: c.asset,
    decimals: c.decimals,
  });
}

/**
 * Build the /api/changenow/quote query for a long-tail source → dest pair.
 * Returns `{ qs, src }` or null when the source is not ChangeNOW-servable or
 * the inputs are missing (fail-closed — never a partial query).
 */
export function buildChangeNowQuoteQuery({ fromChain, toCurrency, toNetwork, amount } = {}) {
  const src = changeNowSourceFor(fromChain);
  if (!src) return null;
  const to = String(toCurrency ?? "").trim().toLowerCase();
  if (!to) return null;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  const qs = new URLSearchParams();
  qs.set("fromCurrency", src.fromCurrency);
  qs.set("fromNetwork", src.fromNetwork);
  qs.set("toCurrency", to);
  if (toNetwork) qs.set("toNetwork", String(toNetwork).trim());
  qs.set("fromAmount", String(amt));
  qs.set("flow", "standard");
  return { qs, src };
}

/**
 * Parse a ChangeNOW estimated-amount response, FAIL-CLOSED. A usable quote
 * needs a real, positive `toAmount` (the rate). `minAmount` is honored when
 * present (a sub-minimum amount is refused). Returns a frozen quote or null —
 * never a fabricated one.
 */
export function parseChangeNowEstimate(data, { amount = null } = {}) {
  if (!data || typeof data !== "object") return null;
  const toAmount = Number(data.toAmount);
  if (!Number.isFinite(toAmount) || toAmount <= 0) return null;
  const minRaw = Number(data.minAmount);
  const minAmount = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : null;
  const amt = Number(amount);
  if (minAmount != null && Number.isFinite(amt) && amt < minAmount) return null;
  return Object.freeze({
    toAmount,
    minAmount,
    rateId: data.rateId ?? null,
    validUntil: data.validUntil ?? null,
    transactionSpeedForecast: data.transactionSpeedForecast ?? null,
    warningMessage: data.warningMessage ?? null,
    raw: data,
  });
}

/** Parse a /v2/exchange/min-amount response → a positive number or null. */
export function parseChangeNowMinAmount(data) {
  const v = typeof data === "number" ? data : data?.minAmount;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** JSON GET that never throws — returns `{ ok, status, data }`. */
async function getJson(url, fetchImpl) {
  try {
    const resp = await fetchImpl(url);
    const data = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/**
 * Fetch a live ChangeNOW quote for a long-tail source pair. Fetches the
 * estimate (the rate) and, in parallel, the per-pair minimum. FAIL-CLOSED:
 *   - no quote when the estimate is missing/malformed/non-positive,
 *   - no quote when the min endpoint answers and `amount` is below it.
 * The returned quote always carries a real `toAmount`; `minAmount` may be null
 * only when the provider did not answer the min endpoint (never invented).
 */
export async function quoteChangeNow({ fromChain, toCurrency, toNetwork, amount, fetchImpl = fetch } = {}) {
  const built = buildChangeNowQuoteQuery({ fromChain, toCurrency, toNetwork, amount });
  if (!built) return { ok: false, reason: "unsupported_source" };

  const [est, min] = await Promise.all([
    getJson(`${CHANGENOW_API_BASE}/quote?${built.qs}`, fetchImpl),
    getJson(`${CHANGENOW_API_BASE}/minAmount?${built.qs}`, fetchImpl),
  ]);

  if (!est.ok || est.data?.error || est.data?.message) {
    return { ok: false, reason: String(est.data?.error || est.data?.message || est.status || "quote_failed") };
  }

  const parsed = parseChangeNowEstimate(est.data, { amount });
  if (!parsed) return { ok: false, reason: "unusable_quote" };

  // The min endpoint is authoritative when it answers; fall back to the
  // estimate's own minAmount (may be null). Never fabricate a minimum.
  const liveMin = min.ok ? parseChangeNowMinAmount(min.data) : null;
  const minAmount = liveMin ?? parsed.minAmount;
  const amt = Number(amount);
  if (minAmount != null && Number.isFinite(amt) && amt < minAmount) {
    return { ok: false, reason: "below_minimum", minAmount };
  }

  return {
    ok: true,
    source: built.src,
    quote: Object.freeze({ ...parsed, minAmount }),
  };
}

/** FAIL-CLOSED predicate: can ChangeNOW actually serve this source→dest pair
 *  (a real rate at/above the minimum)? Drives whether a long-tail coin is
 *  offered. Any failure → false. */
export async function canServeChangeNowRoute(opts = {}) {
  const r = await quoteChangeNow(opts);
  return r.ok === true;
}

/**
 * Build the /api/changenow/create body (the deposit-address step). `address`
 * (the payout destination) is REQUIRED — the rail never creates an exchange
 * that cannot pay out. Returns null when anything needed is missing.
 */
export function buildChangeNowCreateBody({
  fromChain, toCurrency, toNetwork, amount, address, refundAddress, extraId, flow, type,
} = {}) {
  const src = changeNowSourceFor(fromChain);
  if (!src) return null;
  const to = String(toCurrency ?? "").trim().toLowerCase();
  const addr = String(address ?? "").trim();
  const amt = Number(amount);
  if (!to || !addr || !Number.isFinite(amt) || amt <= 0) return null;
  const body = {
    fromCurrency: src.fromCurrency,
    fromNetwork: src.fromNetwork, // never omit — single-network asset
    toCurrency: to,
    fromAmount: amt,
    address: addr,
    flow: flow || "standard",
    type: type || "direct",
  };
  if (toNetwork) body.toNetwork = String(toNetwork).trim();
  if (refundAddress) body.refundAddress = String(refundAddress).trim();
  if (extraId) body.extraId = String(extraId).trim();
  return body;
}

/**
 * Create the ChangeNOW exchange and return the payin (deposit) address.
 * FAIL-CLOSED: no `payinAddress` in the response → not ok.
 */
export async function createChangeNowExchange(opts = {}, { fetchImpl = fetch } = {}) {
  const body = buildChangeNowCreateBody(opts);
  if (!body) return { ok: false, reason: "missing_params" };
  let resp;
  try {
    resp = await fetchImpl(`${CHANGENOW_API_BASE}/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok || data?.error || data?.message) {
    return { ok: false, reason: String(data?.error || data?.message || resp.status || "create_failed") };
  }
  if (!data?.payinAddress) return { ok: false, reason: "no_payin_address" };
  return { ok: true, exchange: data, request: body };
}
