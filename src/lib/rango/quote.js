/**
 * quote.js — the Rango lane's CLIENT-SIDE pure module (Phase-5 scaffold).
 *
 * Same split the THORChain lane uses (src/lib/thorchain/quote.js): the
 * client holds NO Rango API key — it builds the canonical request against
 * OUR serverless proxy (/api/rango/quote — api/rango/quote.js), which
 * appends the server-side RANGO_API_KEY and forwards only whitelisted
 * params. This module owns:
 *
 *   rangoAssetId({blockchain, symbol, address}) — the canonical Rango asset
 *     string: "CHAIN.SYMBOL" for natives (address null), "CHAIN--address"
 *     for tokens with an address (verified live 2026-09-05: "SUI.SUI",
 *     "XRPL.XRP", "BTC.BTC", "SOLANA.SOL" and "TRON--TR7NH…" all parse).
 *
 *   shapeQuoteRequestArtifact(...) — the deterministic quote-request
 *     artifact the engine's rango-quote leg pins (proxy path + whitelisted
 *     params + the server-side referrer pair ONLY when the config
 *     placeholders are set — nothing invented is ever sent). Pure/offline.
 *
 *   parseRangoQuoteResponse(json) — the canonical parse of a Rango quote
 *     response into the engine's normalized quote shape. PURE — the engine
 *     leg + the golden fixtures share it, and it is the function the
 *     stage layer calls once a live lane lands. Handles the honest
 *     non-OK resultTypes (NO_ROUTE / HIGH_IMPACT / INPUT_LIMIT_ISSUE) and
 *     keeps the raw body (the create-tx continuation needs the requestId
 *     and the route verbatim).
 *
 * PURE MODULE: no DOM, no fetch, no wallet. Runnable under `node --test`.
 */
import {
  RANGO_QUOTE_PROXY_PATH,
  RANGO_DEFAULT_SLIPPAGE_PERCENT,
  RANGO_REFERRER_FEE,
  RANGO_REFERRER_ADDRESS,
} from "./config.js";

/**
 * The canonical Rango asset string for a token:
 *   - address null/empty (a native token) → "CHAIN.SYMBOL"  (e.g. SUI.SUI)
 *   - address present → "CHAIN--address"                     (e.g. TRON--TR7NH…)
 * This matches the asset forms the live API accepted (2026-09-05 probes).
 *
 * @param {{blockchain: string, symbol: string, address: string|null}} token
 * @returns {string} the Rango asset string
 */
export function rangoAssetId({ blockchain, symbol, address }) {
  if (!blockchain || !symbol) {
    throw new Error("rangoAssetId: blockchain and symbol are required");
  }
  return address ? `${blockchain}--${address}` : `${blockchain}.${symbol}`;
}

/** The request params the proxy may forward upstream (the whitelist — the
 *  mirror of api/rango/quote.js FORWARD_PARAMS; keep the two in sync). The
 *  referrer pair is NOT client-forwardable: it is decided server-side from
 *  the config placeholders (never tamperable from the browser). */
export const QUOTE_FORWARD_PARAMS = Object.freeze(["from", "to", "amount", "slippage"]);

/**
 * Shape the deterministic quote-request artifact: the OUR-PROXY URL +
 * params for a Rango quote. Canonical param order is fixed (what the
 * fixtures pin): from, to, amount, slippage — then the server-side
 * referrer pair ONLY when RANGO_REFERRER_FEE is configured (currently
 * EMPTY → no referrer params, mirroring the THORChain affiliate
 * placeholder discipline).
 *
 * @param {object} args
 * @param {string} args.from the Rango source asset string (e.g. "SUI.SUI")
 * @param {string} args.to the Rango destination asset string (e.g. "SOLANA.SOL")
 * @param {string|number} args.amount RAW source amount in base units
 *   (10^decimals — never human units; a quote for 100 SUI = "100000000000")
 * @param {number} [args.slippage] slippage percent (default:
 *   RANGO_DEFAULT_SLIPPAGE_PERCENT — the API's own 0.5% default, explicit)
 * @param {string} [args.proxyPath] DI proxy path (default the real one)
 * @returns {{url: string, params: object}} the canonical request
 */
export function shapeQuoteRequestArtifact({
  from,
  to,
  amount,
  slippage = RANGO_DEFAULT_SLIPPAGE_PERCENT,
  proxyPath = RANGO_QUOTE_PROXY_PATH,
}) {
  if (!from || !to) {
    throw new Error("shapeQuoteRequestArtifact: from and to are required");
  }
  const amountStr = String(amount);
  if (!/^[0-9]+$/.test(amountStr)) {
    throw new Error(`shapeQuoteRequestArtifact: amount must be raw base units (got "${amountStr}")`);
  }
  const params = { from, to, amount: amountStr, slippage: String(slippage) };
  if (RANGO_REFERRER_FEE !== "") {
    params.referrerFee = String(RANGO_REFERRER_FEE);
  }
  const qs = new URLSearchParams(params);
  return { url: `${proxyPath}?${qs.toString()}`, params };
}

/** True when a Rango resultType means a usable route (OK — the only one). */
export function isOkResultType(resultType) {
  return resultType === "OK";
}

/**
 * The canonical parse of a Rango quote response (the /basic/quote body).
 * Pure + shared by the engine leg, the stage layer (once live) and the
 * golden fixtures (which pin REAL 2026-09-05 responses).
 *
 * @param {object} json the parsed Rango quote response body
 * @returns {object} the normalized quote:
 *   { ok, resultType, requestId, error, errorCode, route|null, raw }
 *   route (when ok): { from: {blockchain,symbol,address,decimals},
 *     to: same, outputAmount, outputAmountMin, outputAmountUsd, swapperId,
 *     swapperTitle, estimatedTimeInSeconds, fees: [{name, expenseType,
 *     amount, blockchain, symbol, decimals}], feeUsd, amountRestriction,
 *     pathCount } — amounts stay STRINGS in base units (the engine never
 *     floats money); `raw` is the verbatim body for the create-tx
 *     continuation (requestId + route must be passed down unmodified).
 */
export function parseRangoQuoteResponse(json) {
  if (!json || typeof json !== "object") {
    return {
      ok: false,
      resultType: null,
      requestId: null,
      error: "invalid_rango_quote_body",
      errorCode: null,
      route: null,
      raw: json,
    };
  }
  const resultType = json.resultType || null;
  const requestId = json.requestId || null;
  const routeBody = json.route && typeof json.route === "object" ? json.route : null;
  const ok = isOkResultType(resultType) && routeBody !== null;

  let route = null;
  if (routeBody) {
    const fees = Array.isArray(routeBody.fee)
      ? routeBody.fee.map((f) => ({
          name: f?.name ?? null,
          expenseType: f?.expenseType ?? null,
          amount: f?.amount ?? null,
          blockchain: f?.token?.blockchain ?? null,
          symbol: f?.token?.symbol ?? null,
          decimals: f?.token?.decimals ?? null,
        }))
      : [];
    route = {
      from: {
        blockchain: routeBody.from?.blockchain ?? null,
        symbol: routeBody.from?.symbol ?? null,
        address: routeBody.from?.address ?? null,
        decimals: routeBody.from?.decimals ?? null,
      },
      to: {
        blockchain: routeBody.to?.blockchain ?? null,
        symbol: routeBody.to?.symbol ?? null,
        address: routeBody.to?.address ?? null,
        decimals: routeBody.to?.decimals ?? null,
      },
      outputAmount: routeBody.outputAmount ?? null,
      outputAmountMin: routeBody.outputAmountMin ?? null,
      outputAmountUsd: routeBody.outputAmountUsd ?? null,
      swapperId: routeBody.swapper?.id ?? null,
      swapperTitle: routeBody.swapper?.title ?? null,
      estimatedTimeInSeconds: routeBody.estimatedTimeInSeconds ?? null,
      fees,
      feeUsd: routeBody.feeUsd ?? null,
      amountRestriction: routeBody.amountRestriction ?? null,
      pathCount: Array.isArray(routeBody.path) ? routeBody.path.length : 0,
    };
  }

  return {
    ok,
    resultType,
    requestId,
    error: ok ? null : json.error ?? null,
    errorCode: json.errorCode ?? null,
    route,
    raw: json,
  };
}
