/**
 * quote.js — THORChain aggregator QUOTE fetch + size-cap enforcement
 * (Step 3.3 — fees + quote + caps).
 *
 * docs/BRIEF.md (Workstream A — Panel 1): "Quote via THORChain's free
 * aggregator API (key from `integrate-thorchain` Discord; env
 * `THORCHAIN_API_KEY`). Show `expected_amount_out` and slippage bps from the
 * quote. Re-fetch quote before the user copies the address; quotes expire."
 *
 * ENDPOINT (THORChain's free aggregator quote endpoint — the same Liquify
 * gateway the status/inbound modules use):
 *   GET {baseUrl}/thorchain/quote/swap?from_asset=...&to_asset=...&amount=...
 *      &destination=...&refund_address=...&affiliate=...&affiliate_bps=...
 *   Header: `x-client-id: <THORCHAIN_API_KEY>` when a key is configured
 *   (the documented aggregator-key mechanism from the integrate-thorchain
 *   program). Amounts are in THORChain base units (1e8 convention — even for
 *   SOL; THORChain uses 1e8 for every asset).
 *
 * KEY HANDLING (parked item): the REAL key is Mr. Esters' parked item. The
 * key is read from the ENVIRONMENT at call time via readApiKey() — it is
 * NEVER hardcoded in this file or any component. Accepted env names:
 *   - `THORCHAIN_API_KEY`           (the runbook's name — Vercel env var)
 *   - `VITE_THORCHAIN_API_KEY`      (Vite-exposed client name — works today)
 *   - `NEXT_PUBLIC_THORCHAIN_API_KEY` (legacy Next.js name, still exposed)
 * With NO key configured the fetcher FAILS CLOSED with reason "no-api-key"
 * (a quote without the aggregator key would silently skip affiliate
 * attribution — never do that silently). The live wiring happens when Franky
 * supplies the real key.
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
 * PURE + DI: `fetchImpl` and `apiKey` are injected (tests mock the endpoint;
 * the component wires the real fetch). No DOM, no wallet. Runnable under
 * `node --test`.
 */

import { THORCHAIN_STATUS_BASE_URL } from "./statusEndpoint.js";
import {
  THORCHAIN_AFFILIATE_NAME,
  THORCHAIN_AFFILIATE_BPS,
  THORCHAIN_MAX_SWAP_BTC_EQUIVALENT,
  THORCHAIN_BTC_EQUIVALENT_RATES,
} from "./config.js";

/** The THORChain aggregator quote path (THORNode). */
export const THORCHAIN_QUOTE_PATH = "/thorchain/quote/swap";

/** The documented aggregator-key header (integrate-thorchain program). */
export const THORCHAIN_API_KEY_HEADER = "x-client-id";

/** THORChain base-unit convention: 1e8 for every asset (even SOL). */
export const THORCHAIN_BASE_UNITS = 1e8;

// ─────────────────────────────────────────────────────────────────────────────
// ENV — the API key, read at call time, never hardcoded
// ─────────────────────────────────────────────────────────────────────────────
function readEnv() {
  const meta = import.meta;
  if (typeof meta === "undefined") return {};
  const env = meta.env;
  return env && typeof env === "object" ? env : {};
}

/**
 * Resolve the THORChain aggregator API key from an env object. The runbook's
 * name is `THORCHAIN_API_KEY`; the VITE_/NEXT_PUBLIC_ names are the ones a
 * Vite client bundle can actually see (vite.config.js envPrefix exposes both
 * prefixes). Exported for tests — production resolves once per fetch via
 * createQuoteFetcher()'s default.
 */
export function readApiKey(env = readEnv()) {
  for (const name of ["THORCHAIN_API_KEY", "VITE_THORCHAIN_API_KEY", "NEXT_PUBLIC_THORCHAIN_API_KEY"]) {
    const raw = env[name];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  }
  return "";
}

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
 * Build the quote URL for a base URL + params (from_asset / to_asset /
 * amount in base units / destination / optional refund + affiliate). The
 * affiliate pair is OMITTED while THORCHAIN_AFFILIATE_NAME is empty (no
 * placeholder name is ever sent).
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
  const base = String(baseUrl || THORCHAIN_STATUS_BASE_URL).replace(/\/+$/, "");
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
  return `${base}${THORCHAIN_QUOTE_PATH}?${qs(params)}`;
}

/**
 * Parse a raw `/thorchain/quote/swap` body into a canonical quote. Defensive:
 * unknown shapes yield `{ ok:false, reason }` instead of throwing (same
 * pattern as parseInboundAddresses / parseTxStatusResponse).
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
  // Body-level error (THORNode quote errors come back as `{ error: "..." }`).
  const errText = typeof json.error === "string" ? json.error : "";
  if (errText) {
    return { ok: false, reason: "error", message: errText };
  }
  if (typeof meta.status === "number" && (meta.status < 200 || meta.status >= 300)) {
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
// FETCHER — pure + DI (tests mock the endpoint; the component wires fetch)
// ─────────────────────────────────────────────────────────────────────────────
/** Default timer/fetch seams — the browser fetch (tests inject mocks). */
function defaultFetch(url, init) {
  return fetch(url, init);
}

/**
 * Create the quote fetcher.
 *
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl] async (url, init) => Response-like
 *   ({ ok, status, json() }) — default: browser fetch
 * @param {string} [deps.apiKey] the aggregator key — resolved from the env
 *   at call time when omitted (readApiKey()); NEVER hardcoded
 * @param {string} [deps.baseUrl] THORChain API base URL (default: the 3.1
 *   status module's Liquify gateway default)
 * @returns {{fetchQuote: Function}}
 *   fetchQuote(args) → { ok:true, quote } | { ok:false, reason, message }
 *   args: { fromAsset, toAsset, amount (decimal), destination, refundAddress?,
 *          affiliate?, affiliateBps? }
 */
export function createQuoteFetcher(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : readApiKey();
  const baseUrl = deps.baseUrl;

  async function fetchQuote(args) {
    // FAIL CLOSED: no key, no quote. A quote fetched without the aggregator
    // key would silently skip affiliate attribution — never do that silently.
    if (apiKey === "") {
      return {
        ok: false,
        reason: "no-api-key",
        message: "THORChain quote unavailable — THORCHAIN_API_KEY is not configured (parked item).",
      };
    }
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
      const res = await fetchImpl(url, {
        headers: { [THORCHAIN_API_KEY_HEADER]: apiKey },
      });
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
