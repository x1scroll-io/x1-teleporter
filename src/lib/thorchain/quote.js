/**
 * quote.js — THORChain aggregator QUOTE fetch + size-cap enforcement
 * (Step 3.3 — fees + quote + caps).
 *
 * docs/BRIEF.md (Workstream A — Panel 1): "Quote via THORChain's free
 * aggregator API ... Show `expected_amount_out` and slippage bps from the
 * quote. Re-fetch quote before the user copies the address; quotes expire."
 *
 * ENDPOINT (SECURITY FIX, PR #20): the quote is fetched through OUR
 * serverless proxy `/api/thorchain/quote` (api/thorchain/quote.js) — the
 * client NEVER calls THORNode directly and NEVER holds the aggregator key.
 * The key lives only in the SERVER env (server-side name only — no VITE_ or
 * NEXT_PUBLIC_ prefix; a VITE_ var would compile into the browser bundle and
 * leak the key to every visitor). The proxy attaches it as the documented
 * `x-client-id` header, forwards to THORNode /thorchain/quote/swap, and
 * passes the THORNode body back verbatim. Client-bundle leakage of the key
 * is impossible by construction — enforced by apiKeyLeak.test.js (zero key
 * references in src/ + dist/).
 *
 * PROXY CONTRACT (params the proxy whitelists — quoteUrl builds exactly
 * these):
 *   GET {THORCHAIN_QUOTE_PROXY_PATH}?from_asset=...&to_asset=...&amount=...
 *      &destination=...&refund_address=...&affiliate=...&affiliate_bps=...
 *   Amounts are in THORChain base units (1e8 convention — even for SOL;
 *   THORChain uses 1e8 for every asset).
 *
 * FAIL-CLOSED SEMANTICS (changed with the proxy move): the client has no key
 * and never needs one, so the client's only failure modes are proxy
 * unreachable / proxy error — surfaced as reason "error". The proxy itself
 * is fail-closed when the SERVER key is missing (502 no_api_key — a quote
 * without the aggregator key would silently skip affiliate attribution;
 * never do that silently).
 *
 * RE-FETCH SEMANTICS (decided + documented): the quote is ALWAYS re-fetched
 * immediately before the deposit address is shown — the deposit stage
 * (THORChainDeposit) renders the address ONLY after a successful fetch (the
 * "get quote" moment). If the fetch fails, the error is surfaced and the
 * address is BLOCKED with a Retry — the address is never shown with a stale
 * or missing quote (per the runbook: quotes expire).
 *
 * SIZE CAP (docs/BRIEF.md): 0.05 BTC-equivalent per swap, from config
 * (THORCHAIN_MAX_SWAP_BTC_EQUIVALENT + THORCHAIN_BTC_EQUIVALENT_RATES) —
 * NOT hardcoded. Enforced at quote time: over-cap requests are BLOCKED with
 * a clear message before any fetch; at-cap is allowed. Assets with a null
 * rate (DOGE/LTC/XRP until the live wiring) are skipped with capKnown:false
 * — the UI shows a note instead of guessing a price.
 *
 * PURE + DI: `fetchImpl` is injected (tests mock the proxy; the component
 * wires the real fetch). No DOM, no wallet. Runnable under `node --test`.
 */

import {
  THORCHAIN_AFFILIATE_NAME,
  THORCHAIN_AFFILIATE_BPS,
  THORCHAIN_MAX_SWAP_BTC_EQUIVALENT,
  THORCHAIN_BTC_EQUIVALENT_RATES,
} from "./config.js";

/** Our serverless quote proxy (same-origin — API_BASE is "" in production).
 *  Server-side implementation: api/thorchain/quote.js. */
export const THORCHAIN_QUOTE_PROXY_PATH = "/api/thorchain/quote";

/** THORChain base-unit convention: 1e8 for every asset (even SOL). */
export const THORCHAIN_BASE_UNITS = 1e8;

// ─────────────────────────────────────────────────────────────────────────────
// AMOUNT CONVERSION — THORChain quotes in 1e8 base units for every asset
// ─────────────────────────────────────────────────────────────────────────────
/** Decimal amount → THORChain base units (1e8 convention). */
export function toThorchainBaseUnits(amount, baseUnits = THORCHAIN_BASE_UNITS) {
  return String(Math.round(Number(amount) * baseUnits));
}

/** THORChain base units → decimal amount (the destination asset's units —
 *  for SOL.SOL that is SOL, matching what the progress stage displays). */
export function fromThorchainBaseUnits(raw, baseUnits = THORCHAIN_BASE_UNITS) {
  return Number(raw) / baseUnits;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL + PARSING
// ─────────────────────────────────────────────────────────────────────────────
function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

/**
 * Build the PROXY quote URL for a base URL + params (from_asset / to_asset /
 * amount in base units / destination / optional refund + affiliate). The
 * affiliate pair is OMITTED while THORCHAIN_AFFILIATE_NAME is empty (no
 * placeholder name is ever sent). The proxy whitelists exactly these params
 * (see api/thorchain/quote.js FORWARD_PARAMS) — the client passes them; the
 * proxy adds the key.
 *
 * @param {object} args
 * @param {string} args.fromAsset e.g. "BTC.BTC"
 * @param {string} args.toAsset e.g. "SOL.SOL"
 * @param {string|number} args.amountInBaseUnits the swap amount in 1e8 units
 * @param {string} args.destination the destination address (Solana pubkey)
 * @param {string} [args.refundAddress] source-chain refund address
 * @param {string} [args.affiliate] THORName (config; empty → omitted)
 * @param {string|number} [args.affiliateBps] affiliate bps (config)
 */
export function quoteUrl(baseUrl, args) {
  const base = String(baseUrl || THORCHAIN_QUOTE_PROXY_PATH).replace(/\/+$/, "");
  const params = {
    from_asset: args.fromAsset,
    to_asset: args.toAsset,
    amount: args.amountInBaseUnits,
    destination: args.destination,
    refund_address: args.refundAddress,
  };
  const hasAffiliate =
    args.affiliate !== undefined && args.affiliate !== null && String(args.affiliate).trim() !== "";
  if (hasAffiliate) {
    params.affiliate = args.affiliate;
    params.affiliate_bps = args.affiliateBps ?? THORCHAIN_AFFILIATE_BPS;
  }
  return `${base}${qs(params) ? `?${qs(params)}` : ""}`;
}

/**
 * Parse a raw `/thorchain/quote/swap` body into a canonical quote. Defensive:
 * unknown shapes yield `{ ok:false, reason }` instead of throwing (same
 * pattern as parseInboundAddresses / parseTxStatusResponse). The proxy passes
 * the THORNode body through verbatim, so this parses the same shapes as
 * before the proxy move.
 *
 * @param {unknown} json parsed JSON body
 * @param {object} [meta]
 * @param {number} [meta.status] HTTP status (non-2xx → error)
 * @param {string|number} [meta.affiliateBps] the bps WE requested — the
 *   quote response does not always echo it, so the canonical quote carries
 *   the requested value (the fee class reads the same config value).
 * @returns {{ok:true, quote:object}|{ok:false, reason:string, message?:string}}
 *   quote: { expectedAmountOut (decimal dest units), expectedAmountOutRaw
 *   (base units), affiliateBps, slippageBps, memo, halted, raw }
 */
export function parseQuoteResponse(json, meta = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "malformed", message: "empty or non-object quote response" };
  }
  // Body-level error (THORNode quote errors come back as `{ error: "..." }`;
  // the proxy's own failures — no_api_key, thorchain_quote_failed — use the
  // same shape).
  const errText = typeof json.error === "string" ? json.error : "";
  if (errText) {
    return { ok: false, reason: "error", message: errText };
  }
  if (typeof meta.status === "number" && (meta.status < 200 || meta.status >= 300)) {
    // Some THORNode/gateway error bodies (e.g. a HALTED POOL — verified live
    // 2026-09-05: HTTP 400 `{ code:3, message:"failed to simulate swap: ...
    // trading is halted, can't process swap: invalid request" }`) carry the
    // reason in a `message` field with NO `error` field. Surface that wire
    // message verbatim (the caller's halt translation keys off it) instead of
    // collapsing it into a bare "HTTP 400" line the user can't act on.
    const wireMsg =
      typeof json.message === "string" && json.message.trim() !== ""
        ? json.message.trim()
        : "";
    if (wireMsg) {
      return { ok: false, reason: "error", message: wireMsg };
    }
    return { ok: false, reason: "error", message: `quote endpoint returned HTTP ${meta.status}` };
  }

  const body = json.quote && typeof json.quote === "object" ? json.quote : json;
  const rawOut = body.expected_amount_out;
  if (rawOut === undefined || rawOut === null || rawOut === "") {
    return { ok: false, reason: "malformed", message: "quote response has no expected_amount_out" };
  }
  const expectedAmountOutRaw = Number(rawOut);
  if (!Number.isFinite(expectedAmountOutRaw)) {
    return { ok: false, reason: "malformed", message: "quote expected_amount_out is not a number" };
  }
  const slippageBps = Number(body.slippage_bps);
  const quote = {
    expectedAmountOut: fromThorchainBaseUnits(expectedAmountOutRaw),
    expectedAmountOutRaw,
    affiliateBps: meta.affiliateBps !== undefined && meta.affiliateBps !== null ? Number(meta.affiliateBps) : null,
    slippageBps: Number.isFinite(slippageBps) ? slippageBps : null,
    memo: typeof body.memo === "string" ? body.memo : null,
    // Halted chains surface as an empty inbound_address on quote responses.
    halted: body.halted === true || (typeof body.inbound_address === "string" && body.inbound_address === ""),
    raw: body,
  };
  return { ok: true, quote };
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCHER — pure + DI (tests mock the proxy; the component wires fetch)
// ─────────────────────────────────────────────────────────────────────────────
/** Default timer/fetch seams — the browser fetch (tests inject mocks). */
function defaultFetch(url, init) {
  return fetch(url, init);
}

/**
 * Create the quote fetcher. The client sends ONLY the quote params to OUR
 * proxy — it never holds, reads, or sends the aggregator key (the proxy
 * adds it server-side). There is deliberately NO apiKey option here.
 *
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl] async (url, init) => Response-like
 *   ({ ok, status, json() }) — default: browser fetch
 * @param {string} [deps.baseUrl] the proxy base URL (default:
 *   THORCHAIN_QUOTE_PROXY_PATH — same-origin, API_BASE = "")
 * @returns {{fetchQuote: Function}}
 *   fetchQuote(args) → { ok:true, quote } | { ok:false, reason, message }
 *   args: { fromAsset, toAsset, amount (decimal), destination, refundAddress?,
 *          affiliate?, affiliateBps? }
 */
export function createQuoteFetcher(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const baseUrl = deps.baseUrl;

  async function fetchQuote(args) {
    const url = quoteUrl(baseUrl, {
      fromAsset: args.fromAsset,
      toAsset: args.toAsset,
      amountInBaseUnits: toThorchainBaseUnits(args.amount),
      destination: args.destination,
      refundAddress: args.refundAddress,
      affiliate: args.affiliate,
      affiliateBps: args.affiliateBps,
    });
    try {
      // No key header — the proxy adds the key. A proxy error body (e.g.
      // the server-side fail-closed 502 no_api_key) is parsed below like any
      // THORNode error body.
      const res = await fetchImpl(url);
      const body = res && typeof res.json === "function" ? await res.json() : res;
      const parsed = parseQuoteResponse(body, {
        status: typeof res?.status === "number" ? res.status : undefined,
        affiliateBps: args.affiliateBps,
      });
      if (parsed.ok) return parsed;
      return { ok: false, reason: parsed.reason, message: parsed.message };
    } catch (e) {
      return {
        ok: false,
        reason: "error",
        message: `THORChain quote fetch failed: ${e?.message || String(e)}`,
      };
    }
  }

  return { fetchQuote };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIZE CAP — config-driven, enforced at quote time, never hardcoded
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The cap for a source asset in SOURCE units (0.05 BTC-equivalent × the
 * asset's BTC-equivalent rate). Assets with a null rate have NO known cap —
 * the check skips them (capKnown:false) rather than guessing a price; the UI
 * shows a note. TODO(3.3+live): the DOGE/LTC/XRP rates land with the live
 * quote wiring (parked item).
 *
 * @param {string} asset "BTC" | "DOGE" | "LTC" | "XRP"
 * @param {object} [opts]
 * @param {object} [opts.rates] per-asset BTC-equivalent rates
 *   (default THORCHAIN_BTC_EQUIVALENT_RATES)
 * @param {number} [opts.maxBtcEquivalent] the cap (default
 *   THORCHAIN_MAX_SWAP_BTC_EQUIVALENT)
 * @returns {{ok:true, capKnown:true, capAmount:number}
 *          |{ok:true, capKnown:false}}
 */
export function swapCapInSourceUnits(asset, opts = {}) {
  const rates = opts.rates ?? THORCHAIN_BTC_EQUIVALENT_RATES;
  const maxBtcEquivalent = opts.maxBtcEquivalent ?? THORCHAIN_MAX_SWAP_BTC_EQUIVALENT;
  const rate = rates[asset];
  if (rate === undefined || rate === null) {
    return { ok: true, capKnown: false };
  }
  return { ok: true, capKnown: true, capAmount: maxBtcEquivalent * rate };
}

/**
 * Enforce the per-swap size cap at quote time.
 *
 * @param {object} args
 * @param {string} args.asset "BTC" | "DOGE" | "LTC" | "XRP"
 * @param {number} args.amount the requested swap amount in source units
 * @param {object} [args.rates] DI — per-asset BTC-equivalent rates
 * @param {number} [args.maxBtcEquivalent] DI — the cap in BTC-equivalent
 * @returns {{ok:true, capKnown:true}|{ok:true, capKnown:false}
 *          |{ok:false, reason:"over-cap", message:string, capAmount:number}}
 *   - over-cap → blocked with a clear message (the caller must NOT fetch a
 *     quote or show a deposit address)
 *   - at-cap (amount <= capAmount) → allowed
 *   - unknown rate → allowed with capKnown:false (UI shows a note)
 */
export function assertWithinSwapCap(args) {
  const cap = swapCapInSourceUnits(args.asset, {
    rates: args.rates,
    maxBtcEquivalent: args.maxBtcEquivalent,
  });
  if (!cap.capKnown) return { ok: true, capKnown: false };
  if (Number(args.amount) > cap.capAmount) {
    return {
      ok: false,
      reason: "over-cap",
      message:
        `This swap (${args.amount} ${args.asset}) exceeds the ${cap.capAmount} ${args.asset} ` +
        `per-swap cap (${args.maxBtcEquivalent ?? THORCHAIN_MAX_SWAP_BTC_EQUIVALENT} BTC-equivalent) ` +
        `until Solana pool depth improves — reduce the amount.`,
      capAmount: cap.capAmount,
    };
  }
  return { ok: true, capKnown: true };
}
