/**
 * liquidityGate.js — the HARD DEX-liquidity gate for the Teleporter route flow.
 *
 * WHY THIS EXISTS (the thin-token bridge failure): a route whose source or
 * destination token has no real DEX depth (a long-tail token, or a stable on a
 * chain where its pool is thin — e.g. USDT/DAI on Sonic or Avalanche) can be
 * quoted and then FAIL — or fill at brutal slippage — on the LiFi leg that has
 * to DEX-swap it into a bridgeable asset before the bridge can run. The old
 * protection was ADVISORY ONLY: `routeAdvisory()` in src/Teleporter.jsx warned
 * ("may have limited swap liquidity — USDC is most reliable") but never BLOCKED,
 * so a thin token still reached a doomed quote.
 *
 * This module makes that advisory HARD: it REFUSES a route whose leg cannot be
 * proven to have enough DEX liquidity, BEFORE the user can submit, with a clear
 * actionable message and a "route with USDC instead" suggestion (a suggestion,
 * never a silent switch — the user must see and consent).
 *
 * THE THRESHOLD MODEL (per leg, explicit + easy to tune):
 *   1. HUB tokens (USDC / USDC.x) are ALWAYS allowed — the reliable path is
 *      never gated (owner directive). The bridge hub is the one asset we can
 *      always trust end to end.
 *   2. If a NUMERIC liquidity figure is supplied for the leg (from a reserve /
 *      quote source when available) it is compared to the USD FLOOR
 *      (`DEFAULT_MIN_ROUTE_LIQUIDITY_USD`): >= floor → allowed, < floor →
 *      refused. This is the tunable USD floor.
 *   3. HIGH-LIQUIDITY stables (USDT / DAI / USDG) are allowed wherever the chain
 *      has a VERIFIED DEX venue and is not on the thin list — i.e. wherever they
 *      are actually deep (mainnet majors). On a thin chain they fall through to
 *      the checks below and can be refused — which is exactly the combos the v1
 *      advisory only warned about.
 *   4. Otherwise the leg is judged on the DEX registry: a chain on the thin list
 *      (`THIN_SWAP_CHAINS`) or a chain with NO verified routable venue → refused
 *      (fail-closed — we cannot prove a swap can be sourced).
 *   5. Everything else (non-hub token on a chain with a verified venue, no thin
 *      flag) → allowed.
 *
 * PURE MODULE: imports only the pure DEX registry (no DOM, no wallet, no fetch,
 * no keys). Runs under `node --test` and bundles into the browser app alike.
 */

import { hasVenues } from "./dex/registry.js";

/** The conservative default USD liquidity floor for a NON-hub leg. Configurable
 *  per call (and easy to tune here). $25k is a floor below which a swap into a
 *  bridgeable asset is unlikely to fill cleanly. */
export const DEFAULT_MIN_ROUTE_LIQUIDITY_USD = 25000;

/** Tokens that are ALWAYS allowed — the canonical bridge hub. The gate must
 *  never block the reliable path (owner directive). */
export const HUB_TOKENS = Object.freeze(["USDC", "USDC.X"]);

/** High-liquidity stables: allowed wherever the chain has a verified venue (and
 *  is not thin). They are deep on the major chains but thin on the small ones,
 *  so they are NOT unconditionally exempt — the thin checks still apply. */
export const HIGH_LIQUIDITY_STABLES = Object.freeze(["USDT", "DAI", "USDG"]);

/** Chains where a non-hub DEX swap is KNOWN to be thin. Mirrors the v1 advisory
 *  (`routeAdvisory` THIN_SWAP_CHAINS) — this list turns that advisory HARD.
 *  Explicit + easy to tune: add/remove a chain id here. */
export const THIN_SWAP_CHAINS = Object.freeze(["sonic", "avax"]);

/** Explicit per-combo hard blocks ("chain:SYMBOL" → true). Opt-in escape hatch
 *  to refuse a specific token even where the chain itself looks fine. */
export const LOW_LIQUIDITY_COMBOS = Object.freeze({
  // "sonic:USDT": true, // ← add a "chain:SYMBOL" key to hard-block a combo
});

const norm = (s) => String(s ?? "").trim().toUpperCase();
const normChain = (c) => String(c ?? "").trim().toLowerCase();
const isFin = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const asSet = (xs) => (xs instanceof Set ? xs : new Set(Array.isArray(xs) ? xs.map((x) => String(x).toLowerCase()) : []));

/** The USDC hub suggestion attached to every refusal (never auto-applied). */
export const USDC_SUGGESTION = Object.freeze({
  token: "USDC",
  note: "Route with USDC (the bridge hub) — it has the deepest liquidity end to end.",
});

/** True when `symbol` is a token the gate never blocks (USDC / USDC.x). */
export function isHubToken(symbol) {
  return HUB_TOKENS.includes(norm(symbol));
}

/** True when `symbol` is a high-liquidity stable (USDT / DAI / USDG). */
export function isHighLiquidityStable(symbol) {
  return HIGH_LIQUIDITY_STABLES.includes(norm(symbol));
}

/** The refusal message for a leg — clear + actionable, naming the token/chain. */
export function liquidityRefusalMessage({ token, chain } = {}) {
  const t = norm(token);
  const c = normChain(chain).toUpperCase();
  return `${t} on ${c} has insufficient liquidity to bridge — use USDC or a higher-liquidity asset.`;
}

/**
 * Best-effort extraction of a USD liquidity/depth figure from a LiFi quote.
 *
 * LiFi's quote response does NOT reliably expose pool depth, so this returns
 * `null` in the common case (the DEX-registry + USD-floor checks remain the
 * primary signal). It exists so a future reserve-aware source can feed the
 * numeric floor without changing the gate's call sites. We deliberately read
 * only explicit depth-shaped fields — never notional amounts — so we can never
 * mistake a route size for a liquidity figure.
 *
 * @returns {number|null}
 */
export function liquidityUsdFromQuote(quote) {
  const candidates = [
    quote?.liquidityUSD,
    quote?.liquidityUsd,
    quote?.estimate?.liquidityUSD,
    quote?.estimate?.liquidityUsd,
  ];
  for (const v of candidates) if (isFin(v)) return Number(v);
  return null;
}

/**
 * checkLegLiquidity — does ONE leg (source or dest) have enough DEX liquidity
 * to route safely?
 *
 * @param {object} p
 * @param {string} p.chain         chain id ("eth", "sol", "sonic", "x1", …)
 * @param {string} p.token         token symbol on that chain ("USDC", "USDT", …)
 * @param {number} [p.liquidityUsd] known leg liquidity in USD (optional; from a
 *                                  reserve/quote source — when present it is the
 *                                  decisive check against the USD floor)
 * @param {number} [p.minLiquidityUsd] USD floor (default DEFAULT_MIN_ROUTE_LIQUIDITY_USD)
 * @param {string[]|Set} [p.hubTokens]   override the always-allowed hub set
 * @param {string[]|Set} [p.highLiquidityStables] override the stable set
 * @param {string[]|Set} [p.thinChains]  override the thin-chain list
 * @param {object} [p.lowLiquidityCombos] override the "chain:SYMBOL" hard blocks
 * @param {(chain:string)=>boolean} [p.venueFor] venue-availability probe (default hasVenues)
 * @returns {{ok:boolean, side:(string|null), chain:string, token:string,
 *            reason:string, message:(string|null), liquidityUsd:(number|null),
 *            floorUsd:number}}
 */
export function checkLegLiquidity({
  chain,
  token,
  side = null,
  liquidityUsd = null,
  minLiquidityUsd = DEFAULT_MIN_ROUTE_LIQUIDITY_USD,
  hubTokens = HUB_TOKENS,
  highLiquidityStables = HIGH_LIQUIDITY_STABLES,
  thinChains = THIN_SWAP_CHAINS,
  lowLiquidityCombos = LOW_LIQUIDITY_COMBOS,
  venueFor = hasVenues,
} = {}) {
  const c = normChain(chain);
  const t = norm(token);
  const floor = isFin(minLiquidityUsd) ? Number(minLiquidityUsd) : DEFAULT_MIN_ROUTE_LIQUIDITY_USD;
  const hubs = new Set(Array.isArray(hubTokens) ? hubTokens.map(norm) : hubTokens);
  const stables = new Set(Array.isArray(highLiquidityStables) ? highLiquidityStables.map(norm) : highLiquidityStables);
  const thin = asSet(thinChains);
  const combos = lowLiquidityCombos || {};
  const knownLiq = isFin(liquidityUsd) ? Number(liquidityUsd) : null;

  const base = { side, chain: c, token: t, liquidityUsd: knownLiq, floorUsd: floor };
  const allow = (reason) => ({ ...base, ok: true, reason, message: null });
  const refuse = (reason, message) => ({ ...base, ok: false, reason, message: message ?? liquidityRefusalMessage({ token: t, chain: c }) });

  // 1. hub token → never gated (the reliable path)
  if (hubs.has(t)) return allow("hub-token");

  // 2. a known liquidity figure is decisive against the USD floor
  if (knownLiq !== null) {
    if (knownLiq < floor) return refuse("below-liquidity-floor");
    return allow("above-liquidity-floor");
  }

  // 3. explicit per-combo hard block
  if (combos[`${c}:${t}`]) return refuse("thin-combo");

  // 4. high-liquidity stable on a real (verified, non-thin) chain → allowed
  if (stables.has(t) && !thin.has(c) && venueFor(c)) return allow("high-liquidity-stable");

  // 5. thin chain → refused (a non-hub swap here can't be proven deep)
  if (thin.has(c)) return refuse("thin-chain");

  // 6. no verified routable venue → refused (fail closed)
  if (!venueFor(c)) return refuse("no-venue");

  // 7. verified venue, not thin → allowed
  return allow("verified-venue");
}

/**
 * The legs a route must have liquidity for. X1 is reached only through the
 * Solana Warp bridge (no DEX leg there), so a chain of "x1" is never checked.
 *
 * @returns {Array<{side:string, chain:string, token:string}>}
 */
export function routeLegs({ from, to, srcToken, dstToken } = {}) {
  const legs = [];
  const f = normChain(from);
  const t = normChain(to);
  if (f && f !== "x1" && srcToken) legs.push({ side: "source", chain: f, token: srcToken });
  if (t && t !== "x1" && dstToken) legs.push({ side: "dest", chain: t, token: dstToken });
  return legs;
}

/**
 * checkRouteLiquidity — does the WHOLE route clear the liquidity gate?
 *
 * @param {object} p
 * @param {string} p.from      source chain id
 * @param {string} p.to        destination chain id
 * @param {string} p.srcToken  source token symbol
 * @param {string} p.dstToken  destination token symbol
 * @param {Array}  [p.legs]    explicit leg list (overrides from/to derivation);
 *                             each leg may carry its own `liquidityUsd`.
 * @param {number} [p.srcLiquidityUsd] known source-leg liquidity (USD)
 * @param {number} [p.dstLiquidityUsd] known dest-leg liquidity (USD)
 * @param {object} [p...rest]  forwarded to checkLegLiquidity (floor, overrides)
 * @returns {{ok:boolean, legs:Array, failures:Array, reason:(string|null),
 *            message:(string|null), suggestion:(object|null)}}
 */
export function checkRouteLiquidity({
  from,
  to,
  srcToken,
  dstToken,
  legs = null,
  srcLiquidityUsd = null,
  dstLiquidityUsd = null,
  ...opts
} = {}) {
  const checkLegs = Array.isArray(legs) && legs.length
    ? legs
    : routeLegs({ from, to, srcToken, dstToken });

  const results = checkLegs.map((leg) => {
    const liq =
      leg.liquidityUsd !== undefined && leg.liquidityUsd !== null
        ? leg.liquidityUsd
        : leg.side === "source"
        ? srcLiquidityUsd
        : leg.side === "dest"
        ? dstLiquidityUsd
        : null;
    return checkLegLiquidity({ ...opts, side: leg.side ?? null, chain: leg.chain, token: leg.token, liquidityUsd: liq });
  });

  const failures = results.filter((r) => !r.ok);
  const first = failures[0] || null;

  return {
    ok: failures.length === 0,
    legs: results,
    failures,
    reason: first ? first.reason : null,
    message: first ? first.message : null,
    suggestion: failures.length ? { ...USDC_SUGGESTION } : null,
  };
}
