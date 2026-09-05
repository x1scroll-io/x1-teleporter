/**
 * quote.js — the Wanchain-family lane's CLIENT-SIDE pure module (XFlows v3
 * rail). Same split as the Rango + THORChain lanes: the client builds the
 * canonical request against OUR serverless proxy (/api/wanchain/quote —
 * api/wanchain/quote.js), which forwards only whitelisted body fields
 * upstream. XFlows is keyless today; if it ever requires a key it lives
 * SERVER-side only (WANCHAIN_API_URL hook in the proxy). This module owns:
 *
 *   shapeQuoteRequest(...) — the deterministic quote-request body + artifact
 *     (proxy path, POST JSON body with the whitelisted fields: fromChainId,
 *     toChainId, fromTokenAddress, toTokenAddress, fromAddress, toAddress,
 *     fromAmount + optional slippage/bridge). Pure/offline.
 *
 *   parseWanchainQuoteResponse(json) — the canonical parse of an XFlows v3
 *     quote response into the engine's normalized quote shape. PURE — the
 *     engine leg + the golden fixtures share it. Handles the honest
 *     failure bodies (success:false with error text — including the real
 *     "get quotes failed … From Chain not supported" bodies pinned in
 *     test/fixtures/golden/wanchain-leg/*.failed.json) and keeps the raw
 *     body for the buildTx continuation.
 *
 * PURE MODULE: no DOM, no fetch, no wallet. Runnable under `node --test`.
 */
import {
  WANCHAIN_QUOTE_PROXY_PATH,
  WANCHAIN_DEFAULT_SLIPPAGE,
} from "./config.js";

/** The body fields the proxy may forward upstream (the whitelist — the
 *  mirror of api/wanchain/quote.js FORWARD_FIELDS; keep the two in sync). */
export const QUOTE_FORWARD_FIELDS = Object.freeze([
  "fromChainId",
  "toChainId",
  "fromTokenAddress",
  "toTokenAddress",
  "fromAddress",
  "toAddress",
  "fromAmount",
  "slippage",
  "bridge",
]);

/**
 * Shape the deterministic quote-request artifact: the OUR-PROXY URL +
 * POST body for a Wanchain-family (XFlows v3) quote. Canonical field order
 * is fixed (what the fixtures pin): fromChainId, toChainId,
 * fromTokenAddress, toTokenAddress, fromAddress, toAddress, fromAmount,
 * then slippage (default 0.01) — bridge only when the caller chooses one
 * (default: the API auto-selects; the docs' optional values: wanbridge |
 * quix).
 *
 * @param {object} args
 * @param {number|string} args.fromChainId the source chain id (XFlows
 *   registry — e.g. 1 = Ethereum)
 * @param {number|string} args.toChainId the destination chain id
 * @param {string} args.fromTokenAddress the source token address (native:
 *   WANCHAIN_NATIVE_ADDRESS 0x0000…0000)
 * @param {string} args.toTokenAddress the destination token address
 * @param {string} args.fromAddress the user's REAL source wallet address
 *   (no placeholders — the live API validates format before routing)
 * @param {string} args.toAddress the destination wallet address
 * @param {string|number} args.fromAmount the source amount in HUMAN units
 *   (the XFlows API quotes in decimal units — docs examples use "10" =
 *   10 USDT; amountOut/amountOutRaw both come back)
 * @param {number} [args.slippage] slippage (default 0.01)
 * @param {string} [args.bridge] optional "wanbridge" | "quix"
 * @param {string} [args.proxyPath] DI proxy path (default the real one)
 * @returns {{url: string, method: string, body: object, json: string}} the
 *   canonical request artifact
 */
export function shapeQuoteRequest({
  fromChainId,
  toChainId,
  fromTokenAddress,
  toTokenAddress,
  fromAddress,
  toAddress,
  fromAmount,
  slippage = WANCHAIN_DEFAULT_SLIPPAGE,
  bridge,
  proxyPath = WANCHAIN_QUOTE_PROXY_PATH,
}) {
  if (fromChainId === undefined || toChainId === undefined) {
    throw new Error("shapeQuoteRequest: fromChainId and toChainId are required");
  }
  if (!fromTokenAddress || !toTokenAddress) {
    throw new Error("shapeQuoteRequest: fromTokenAddress and toTokenAddress are required");
  }
  if (!fromAddress || !toAddress) {
    throw new Error("shapeQuoteRequest: fromAddress and toAddress are required (the live API validates them)");
  }
  if (!Number.isFinite(Number(fromAmount)) || Number(fromAmount) <= 0) {
    throw new Error(`shapeQuoteRequest: a positive fromAmount is required (got "${fromAmount}")`);
  }
  const body = {
    fromChainId: Number(fromChainId),
    toChainId: Number(toChainId),
    fromTokenAddress,
    toTokenAddress,
    fromAddress,
    toAddress,
    fromAmount: String(fromAmount),
    slippage: Number(slippage),
    ...(bridge ? { bridge } : {}),
  };
  return {
    url: proxyPath,
    method: "POST",
    body,
    json: JSON.stringify(body),
  };
}

/** True when an XFlows v3 response means a usable route. */
export function isOkResponse(json) {
  return Boolean(json && json.success === true && json.data && typeof json.data === "object");
}

/**
 * The canonical parse of a Wanchain-family (XFlows v3) quote response.
 * Pure + shared by the engine leg, the stage layer (once live) and the
 * golden fixtures (which pin REAL 2026-09-05 responses — one OK EVM quote
 * + the real failed-route bodies).
 *
 * @param {object} json the parsed XFlows v3 quote response body
 * @returns {object} the normalized quote:
 *   { ok, error|null, route|null, raw }
 *   route (when ok): { fromChainId, toChainId, fromTokenAddress,
 *     toTokenAddress, amountOut (human), amountOutRaw (base units string),
 *     amountOutMin, amountOutMinRaw, slippage, priceImpact, workMode,
 *     bridge, approvalAddress, nativeFees, tokenFees, extraData } — `raw`
 *     is the verbatim body for the buildTx continuation (extraData must be
 *     passed down unmodified).
 */
export function parseWanchainQuoteResponse(json) {
  if (!json || typeof json !== "object") {
    return {
      ok: false,
      error: "invalid_wanchain_quote_body",
      route: null,
      raw: json,
    };
  }
  if (json.success !== true) {
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "wanchain_quote_failed",
      route: null,
      raw: json,
    };
  }
  const d = json.data && typeof json.data === "object" ? json.data : null;
  if (!d) {
    return { ok: false, error: "wanchain_quote_empty_data", route: null, raw: json };
  }
  const route = {
    fromChainId: d.fromChainId ?? d.extraData?.directPair?.fromChainId ?? null,
    toChainId: d.toChainId ?? d.extraData?.directPair?.toChainId ?? null,
    fromTokenAddress: d.extraData?.directPair?.fromTokenAddress ?? null,
    toTokenAddress: d.extraData?.directPair?.toTokenAddress ?? null,
    amountOut: d.amountOut ?? null,
    amountOutRaw: d.amountOutRaw != null ? String(d.amountOutRaw) : null,
    amountOutMin: d.amountOutMin ?? null,
    amountOutMinRaw: d.amountOutMinRaw != null ? String(d.amountOutMinRaw) : null,
    slippage: d.slippage ?? null,
    priceImpact: d.priceImpact ?? null,
    workMode: d.workMode ?? null,
    bridge: d.bridge ?? null,
    approvalAddress: d.approvalAddress ?? null,
    nativeFees: Array.isArray(d.nativeFees) ? d.nativeFees : [],
    tokenFees: Array.isArray(d.tokenFees) ? d.tokenFees : [],
    extraData: d.extraData ?? null,
  };
  return { ok: true, error: null, route, raw: json };
}
