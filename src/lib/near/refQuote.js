/**
 * src/lib/near/refQuote.js — the Ref Finance quote PRODUCER (read-only,
 * DI-clean, fail-closed).
 *
 * This is the NEAR side of the "per-venue quote producers" the MEV capture
 * scan (docs/NEAR-TON-DEX-RESEARCH.md §4.2) and the nearSwapLeg both consume:
 * it turns a pair + raw amount into a normalized quote `{ venue, amountInRaw,
 * amountOutRaw, pool, route }` by (a) reading the Ref indexer pool list and
 * (b) running the OFFICIAL @ref-finance/ref-sdk `estimateSwap` over it.
 *
 * ── DI-CLEAN ──────────────────────────────────────────────────────────────
 *   fetchImpl   — injected fetch (the real global `fetch` in the app; a fake
 *                 in tests). Never reached for the SDK-only path.
 *   estimateSwap — injected estimator (default: the sdkNear loader wrapper).
 *   parsePool    — injected pool normalizer (default: the ref-sdk parsePool).
 * Nothing is imported from the SDK at module top level — the defaults resolve
 * through the lazy loaders in sdkNear.js, so node:test never touches the
 * network and the Vite main bundle never carries the SDK.
 *
 * ── FAIL-CLOSED ───────────────────────────────────────────────────────────
 * Every failure (dead endpoint, non-OK HTTP, malformed JSON, SDK throw)
 * returns `null` — this producer NEVER throws an unhandled error and NEVER
 * signs or broadcasts anything. A null is the honest "no quote" the caller
 * skips.
 */

import { loadRefSdk, REF_FINANCE_CONTRACT_ID, WRAP_NEAR_CONTRACT_ID } from "../sdk/sdkNear.js";

/** The Ref Finance public indexer/pricing endpoint (read-only). */
export const REF_INDEXER_BASE = "https://api.ref.finance";
/** The pools-list path on the indexer (the same list the Ref UI consumes). */
export const REF_POOLS_PATH = "/list-token-pools";

/**
 * The deterministic pools-request descriptor (URL + method). Pure — the leg /
 * capture layer pins it; tests assert it without any network.
 * @param {{base?: string}} [opts]
 * @returns {{url: string, method: string}}
 */
export function shapeRefPoolsRequest({ base = REF_INDEXER_BASE } = {}) {
  return { url: `${base}${REF_POOLS_PATH}`, method: "GET" };
}

/**
 * Normalize the indexer pools response into a plain array (fail-soft: a
 * non-array body yields []).
 * @param {any} json
 * @returns {Array<object>} PoolRPCView[]
 */
export function parseRefPoolsResponse(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.pools)) return json.pools;
  return [];
}

/**
 * Normalize an EstimateSwapView[] result into the engine's quote shape.
 * @param {Array} views EstimateSwapView[]
 * @param {{tokenIn: object, tokenOut: object, amountInRaw: string,
 *   slippageBps?: number}} args
 * @returns {object|null}
 */
export function normalizeRefEstimate(views, { tokenIn, tokenOut, amountInRaw, slippageBps = 100 }) {
  if (!Array.isArray(views) || views.length === 0) return null;
  const best = views.find((v) => v && v.estimate != null) ?? null;
  if (!best) return null;
  const outRaw = String(best.estimate);
  const outMin = (BigInt(outRaw) * BigInt(10000 - slippageBps)) / 10000n;
  return {
    venue: "ref-finance",
    chain: "near",
    protocol: "amm",
    router: REF_FINANCE_CONTRACT_ID,
    tokenIn: tokenIn?.id ?? String(tokenIn),
    tokenOut: tokenOut?.id ?? String(tokenOut),
    amountInRaw: String(amountInRaw),
    amountOutRaw: outRaw,
    amountOutMinRaw: outMin.toString(),
    pool: best.pool?.id != null ? String(best.pool.id) : null,
    route: Array.isArray(best.pool?.tokenIds) ? best.pool.tokenIds : null,
    routeCount: views.length,
    slippageBps,
    source: "ref-indexer+sdk.estimateSwap",
  };
}

/**
 * Produce a Ref Finance quote. Read-only; fail-closed.
 *
 * @param {object} args
 * @param {object} args.tokenIn  TokenMetadata-like ({ id, symbol, decimals })
 * @param {object} args.tokenOut TokenMetadata-like
 * @param {string|number} args.amountInRaw raw (base-unit) input amount
 * @param {Function} [args.fetchImpl]      injected fetch
 * @param {string}   [args.base]           indexer base (default REF_INDEXER_BASE)
 * @param {Array}    [args.pools]          pre-fetched simplePools (skips the fetch)
 * @param {Function} [args.estimateSwap]   injected estimator
 * @param {Function} [args.parsePool]      injected pool normalizer
 * @param {number}   [args.slippageBps]
 * @returns {Promise<object|null>} the normalized quote, or null (fail-closed)
 */
export async function refQuote({
  tokenIn,
  tokenOut,
  amountInRaw,
  fetchImpl = null,
  base = REF_INDEXER_BASE,
  pools = null,
  estimateSwap = null,
  parsePool = null,
  slippageBps = 100,
} = {}) {
  if (!tokenIn || !tokenOut) return null;
  const amountIn = String(amountInRaw ?? "");
  if (!/^[0-9]+$/.test(amountIn)) return null;

  try {
    let sdkPromise = null;
    const getSdk = () => {
      if (!sdkPromise) sdkPromise = loadRefSdk();
      return sdkPromise;
    };

    // Pools: use the caller's, or read the indexer (needs fetchImpl + a pool
    // normalizer). The pool normalizer defaults to the SDK's parsePool.
    let simplePools = pools;
    if (simplePools === null) {
      if (typeof fetchImpl !== "function") return null;
      const { url } = shapeRefPoolsRequest({ base });
      const res = await fetchImpl(url, { method: "GET" });
      if (!res || res.ok === false) return null;
      const json = await res.json();
      const rawPools = parseRefPoolsResponse(json);
      if (rawPools.length === 0) return null;
      const poolNormalizer = parsePool ?? (await getSdk()).parsePool;
      simplePools = poolNormalizer ? rawPools.map((p) => poolNormalizer(p)) : rawPools;
    }

    const estimator = estimateSwap ?? (await getSdk()).estimateSwap;
    const views = await estimator({
      tokenIn,
      tokenOut,
      amountIn,
      simplePools,
    });
    return normalizeRefEstimate(views, { tokenIn, tokenOut, amountInRaw: amountIn, slippageBps });
  } catch {
    return null; // fail-closed — a dead endpoint or an SDK drift never throws out
  }
}

export { REF_FINANCE_CONTRACT_ID, WRAP_NEAR_CONTRACT_ID };
