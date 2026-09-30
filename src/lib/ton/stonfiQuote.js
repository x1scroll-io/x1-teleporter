/**
 * src/lib/ton/stonfiQuote.js — the STON.fi quote PRODUCER (read-only,
 * DI-clean, fail-closed).
 *
 * The TON side of the "per-venue quote producers" (docs/NEAR-TON-DEX-RESEARCH.md
 * §4.2) + the tonSwapLeg's quote step. Two read-only paths, both fail-closed:
 *
 *   1. SDK path — `stonfiQuote({ pool, provider, ... })` calls the OFFICIAL
 *      @ston-fi/sdk `Pool.getExpectedOutputs(provider, { amount, jettonWallet })`
 *      (→ { jettonToReceive, protocolFeePaid, refFeePaid }). The pool +
 *      provider are injected (the app resolves them via the tonSwapLeg's
 *      router; tests inject a fake pool / fake provider).
 *   2. API path — `stonfiQuoteFromApi({ fetchImpl, ... })` reads the public
 *      STON.fi simulate endpoint (read-only) and normalizes the response.
 *
 * ── DI-CLEAN ──────────────────────────────────────────────────────────────
 * The SDK path never imports the SDK at module top (it calls the pool object
 * the caller injected); the API path takes an injected fetchImpl. node:test
 * touches no network.
 *
 * ── FAIL-CLOSED ───────────────────────────────────────────────────────────
 * Every failure (dead endpoint, non-OK HTTP, malformed JSON, SDK throw)
 * returns `null` — this producer NEVER throws an unhandled error and NEVER
 * signs or broadcasts. A null is the honest "no quote".
 */

/** The STON.fi public API base (read-only). */
export const STONFI_API_BASE = "https://api.ston.fi";
/** The simulate path on the STON.fi API (quote). */
export const STONFI_SWAP_SIMULATE_PATH = "/v1/swap/simulate";

/** STON.fi v1 router — the registry's verified swap entry point. */
export const STONFI_ROUTER_V1_ADDRESS = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";

/**
 * The deterministic simulate-request descriptor (URL + query params). Pure.
 * @param {{apiBase?: string, offerAddress: string, askAddress: string,
 *   amountInRaw: string|number, slippageTolerance?: number}} args
 * @returns {{url: string, method: string}}
 */
export function shapeStonfiQuoteRequest({
  apiBase = STONFI_API_BASE,
  offerAddress,
  askAddress,
  amountInRaw,
  slippageTolerance = 0.01,
} = {}) {
  const qs = new URLSearchParams({
    offer_address: String(offerAddress ?? ""),
    ask_address: String(askAddress ?? ""),
    units: String(amountInRaw ?? ""),
    slippage_tolerance: String(slippageTolerance),
  });
  return { url: `${apiBase}${STONFI_SWAP_SIMULATE_PATH}?${qs.toString()}`, method: "GET" };
}

/**
 * Normalize an SDK Pool.getExpectedOutputs result into the engine quote shape.
 * @param {{jettonToReceive?: bigint, protocolFeePaid?: bigint, refFeePaid?: bigint}} raw
 * @param {{offerAddress: string, askAddress: string, amountInRaw: string,
 *   slippageBps?: number}} args
 * @returns {object|null}
 */
export function normalizeStonfiEstimate(raw, { offerAddress, askAddress, amountInRaw, slippageBps = 100 }) {
  if (!raw || raw.jettonToReceive == null) return null;
  const outRaw = BigInt(raw.jettonToReceive).toString();
  const outMin = (BigInt(outRaw) * BigInt(10000 - slippageBps)) / 10000n;
  return {
    venue: "stonfi",
    chain: "ton",
    protocol: "amm",
    router: STONFI_ROUTER_V1_ADDRESS,
    tokenIn: offerAddress ?? null,
    tokenOut: askAddress ?? null,
    amountInRaw: String(amountInRaw),
    amountOutRaw: outRaw,
    amountOutMinRaw: outMin.toString(),
    protocolFeeRaw: raw.protocolFeePaid != null ? BigInt(raw.protocolFeePaid).toString() : null,
    refFeeRaw: raw.refFeePaid != null ? BigInt(raw.refFeePaid).toString() : null,
    slippageBps,
    source: "stonfi-sdk.Pool.getExpectedOutputs",
  };
}

/**
 * Produce a STON.fi quote through the official SDK Pool estimate. Read-only;
 * fail-closed.
 *
 * @param {object} args
 * @param {object} [args.pool]      an @ston-fi/sdk Pool (e.g. DEX.v1.Pool)
 * @param {object} [args.provider]  a @ton/ton ContractProvider (the reader)
 * @param {string} [args.offerJettonWalletAddress] the offer jetton's wallet
 *   address (owned by the router) — the pool method's `jettonWallet`
 * @param {string|number} args.amountInRaw raw (base-unit) offer amount
 * @param {string} args.offerAddress offer jetton minter address (label only)
 * @param {string} args.askAddress   ask jetton minter address (label only)
 * @param {Function} [args.estimateImpl] override the estimate call
 *   (`({ pool, provider, amount, jettonWallet }) => Promise<{jettonToReceive…}>`)
 * @param {number} [args.slippageBps]
 * @returns {Promise<object|null>}
 */
export async function stonfiQuote({
  pool = null,
  provider = null,
  offerJettonWalletAddress = null,
  amountInRaw,
  offerAddress = null,
  askAddress = null,
  estimateImpl = null,
  slippageBps = 100,
} = {}) {
  const amountIn = String(amountInRaw ?? "");
  if (!/^[0-9]+$/.test(amountIn)) return null;
  try {
    let raw = null;
    if (typeof estimateImpl === "function") {
      raw = await estimateImpl({ pool, provider, amount: BigInt(amountIn), jettonWallet: offerJettonWalletAddress });
    } else if (pool && typeof pool.getExpectedOutputs === "function" && provider) {
      raw = await pool.getExpectedOutputs(provider, {
        amount: BigInt(amountIn),
        jettonWallet: offerJettonWalletAddress,
      });
    } else {
      return null;
    }
    return normalizeStonfiEstimate(raw, { offerAddress, askAddress, amountInRaw: amountIn, slippageBps });
  } catch {
    return null; // fail-closed
  }
}

/**
 * Produce a STON.fi quote through the public API. Read-only; fail-closed.
 * @param {{fetchImpl: Function, apiBase?: string, offerAddress: string,
 *   askAddress: string, amountInRaw: string|number, slippageTolerance?: number,
 *   slippageBps?: number}} args
 * @returns {Promise<object|null>}
 */
export async function stonfiQuoteFromApi({
  fetchImpl,
  apiBase = STONFI_API_BASE,
  offerAddress,
  askAddress,
  amountInRaw,
  slippageTolerance = 0.01,
  slippageBps = 100,
} = {}) {
  if (typeof fetchImpl !== "function") return null;
  const amountIn = String(amountInRaw ?? "");
  if (!/^[0-9]+$/.test(amountIn)) return null;
  try {
    const { url, method } = shapeStonfiQuoteRequest({ apiBase, offerAddress, askAddress, amountInRaw: amountIn, slippageTolerance });
    const res = await fetchImpl(url, { method });
    if (!res || res.ok === false) return null;
    const json = await res.json();
    const outRaw = json?.ask_units ?? json?.expected_output ?? json?.output_units;
    if (outRaw == null) return null;
    return normalizeStonfiEstimate(
      { jettonToReceive: BigInt(outRaw) },
      { offerAddress, askAddress, amountInRaw: amountIn, slippageBps },
    );
  } catch {
    return null; // fail-closed
  }
}
