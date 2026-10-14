/**
 * routeMinimums.js — the SHARED MINIMUM-AMOUNT GUARDRAIL for every swap rail.
 *
 * WHY THIS EXISTS (the NEAR-intents failure): a route whose legs settle
 * asynchronously (ChangeNow payin → payout, THORChain deposit → swap, a LiFi
 * route whose leg hands off to NEAR intents) can be REFUSED BY THE PROVIDER at
 * settlement time when the amount is tiny. ChangeNow never creates the exchange,
 * THORChain returns the deposit (or refuses below its dust threshold) and a
 * NEAR-intents leg can be held in escrow with no recovery path. The failure is
 * not a loss of the user's own bridge/swap — it is a STRANDED, sub-threshold
 * leg.
 *
 * The guardrail is READ-ONLY on the money path: it REFUSES a route that is
 * below a rail's minimum (fail-closed); it never changes how a valid route
 * executes (no amount edits, no re-routing, no re-quoting).
 *
 * ONE place owns the floor logic — `minimumRouteCheck` — and each rail feeds it
 * its own minimum:
 *   • ChangeNow  → the LIVE per-pair min-amount (src/changenow.ts
 *                  changeNowMinAmount → /v2/exchange/min-amount).
 *   • THORChain  → the destination dust_threshold (inbound_addresses) against a
 *                  slippage-protected minimum-out (the memo `limit`).
 *   • LiFi       → a conservative USD floor (default $15), plus a NEAR-intents
 *                  detection on the quote shape.
 *
 * WARNING SURFACE (owner directive): when a route is NEAR or AT its minimum the
 * check also RETURNS the threshold + a human-readable warning ("Minimum for this
 * route is ~$X. To avoid a stuck settlement, allocate at least 50% more than
 * the minimum.") so the Swap UI can render an inline/popup warning. The warning
 * rides on the SAME result object as the refusal decision — the UI consumes one
 * shape.
 *
 * PURE MODULE: no fetch, no DOM, no wallet, no chrome. Runnable under
 * `node --test` and importable from the browser bundle alike. Every rail passes
 * its already-fetched numbers in; the network fetch itself stays in the rail
 * (and is injectable for tests).
 */

/** Conservative default route floor (USD) when a provider-specific minimum is
 *  unknown. $15 mirrors the Warp reverse 1.5×-of-$10 UX floor (see
 *  warpBridge.js X1_REVERSE_DEST_MIN) so the two guardrails agree. Configurable
 *  per call. */
export const DEFAULT_MIN_ROUTE_FLOOR_USD = 15;

/** The "allocate at least 50% more than the minimum" advice multiplier. */
export const MIN_ROUTE_WARNING_MULTIPLIER = 1.5;

/** Default slippage used to derive the THORChain memo `limit` (minimum-out) from
 *  the quote's expected output. 300 bps = 3% — the quote is already slippage-
 *  aware; this bounds the accepted fill. Configurable (config.js
 *  THORCHAIN_MIN_OUT_SLIPPAGE_BPS). */
export const DEFAULT_THORCHAIN_MIN_OUT_SLIPPAGE_BPS = 300;

/** The universal "50% more than the minimum" advice sentence. */
const ADVICE = " To avoid a stuck settlement, allocate at least 50% more than the minimum.";

const isFin = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

/** Integer-ify for exact (BigInt) comparisons when possible; null for decimals
 *  (a decimal number/string is compared via Number instead). */
function toBig(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : null;
  const s = String(v).trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/** a < b, exact via BigInt when both are integers, else via Number. */
function lt(a, b) {
  const A = toBig(a), B = toBig(b);
  if (A !== null && B !== null) return A < B;
  return Number(a) < Number(b);
}

/** Format a positive integer base-unit amount to a human decimal string. */
function formatUnits(value, decimals) {
  const b = toBig(value);
  if (b === null) return String(value);
  const dec = Number(decimals);
  if (!Number.isFinite(dec) || dec <= 0) return b.toString();
  const s = b.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec);
  const frac = s.slice(s.length - dec).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function maybeUnits(v, decimals) {
  if (v === null || v === undefined || v === "") return null;
  const b = toBig(v);
  if (b === null) return typeof v === "string" ? v : String(v);
  return decimals === null || decimals === undefined ? b.toString() : formatUnits(b, decimals);
}

/** Scale an amount (integer base units or decimal) by a multiplier. */
function scaleAmount(v, mult) {
  const b = toBig(v);
  if (b !== null) {
    const mscaled = BigInt(Math.round(Number(mult) * 1000));
    return (b * mscaled) / 1000n;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n * Number(mult) : null;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** "$15" / "$12.50" — trimmed of trailing zeros. */
export function fmtUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return x % 1 === 0 ? String(x) : x.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The human-readable warning for a threshold. Prefers the USD form; falls back
 * to the native-unit form ("Minimum for this route is ~0.001 BTC. …").
 *
 * @returns {string|null}
 */
export function minimumRouteWarning({ floorUsd = null, floorAmount = null, unit = "", decimals = null } = {}) {
  if (isFin(floorUsd)) {
    return `Minimum for this route is ~$${fmtUsd(floorUsd)}.${ADVICE}`;
  }
  if (floorAmount !== null && floorAmount !== undefined && floorAmount !== "") {
    const shown = maybeUnits(floorAmount, decimals);
    return `Minimum for this route is ~${shown}${unit ? " " + unit : ""}.${ADVICE}`;
  }
  return null;
}

/**
 * minimumRouteCheck — the ONE floor/minimum check every rail calls.
 *
 * The check is decided in this priority:
 *   1. `refuseNearIntents` + `usesNearIntents` → refused outright (opt-in).
 *   2. a native-unit minimum (`minimumAmount`, e.g. ChangeNow's min-amount or
 *      THORChain's dust) → refused when `amount` < it.
 *   3. a USD floor (`minimumUsd`) → refused when `amountUsd` < it.
 *   4. `refuseUnverifiable` + a minimum is known but the amount is not → refused
 *      (fail-closed — we cannot PROVE the route clears the floor).
 *
 * @param {object} p
 * @param {string} [p.rail]  label used in messages ("changenow" | "thorchain" | "lifi")
 * @param {number|string|bigint} [p.amount]        requested amount, in `unit`s
 * @param {number|string|bigint} [p.minimumAmount] provider minimum, same units
 * @param {number} [p.amountUsd]   route notional in USD (when priceable)
 * @param {number} [p.minimumUsd]  USD floor
 * @param {string} [p.unit]        human unit label for native amounts ("BTC")
 * @param {number} [p.decimals]    decimals (renders `minimumAmount` human in warnings)
 * @param {boolean} [p.usesNearIntents] the LiFi quote carries a NEAR-intents step
 * @param {boolean} [p.refuseNearIntents] refuse ANY NEAR-intents route (opt-in)
 * @param {boolean} [p.refuseUnverifiable] refuse when the amount is unknown (fail-closed)
 * @param {number} [p.warningMultiplier] default 1.5 ("50% more than the minimum")
 * @returns {{
 *   ok:boolean, rail:string, reason:string|null, message:string|null,
 *   threshold:{usd:number|null, amount:(string|number|bigint|null), unit:string|null, human:(string|null)},
 *   recommended:{usd:number|null, amount:(bigint|number|null), human:(string|null)},
 *   warning:string|null, usesNearIntents:boolean,
 *   amountUsd:number|null, amount:(string|number|bigint|null)
 * }}
 */
export function minimumRouteCheck(p = {}) {
  const rail = p.rail ?? "route";
  const unit = p.unit ?? "";
  const decimals = p.decimals ?? null;
  const warningMultiplier = isFin(p.warningMultiplier) ? Number(p.warningMultiplier) : MIN_ROUTE_WARNING_MULTIPLIER;
  const usesNearIntents = p.usesNearIntents === true;
  const refuseNearIntents = p.refuseNearIntents === true;
  const refuseUnverifiable = p.refuseUnverifiable === true;

  const minimumUsd = isFin(p.minimumUsd) ? Number(p.minimumUsd) : null;
  const minimumAmount = p.minimumAmount ?? null;
  const amountUsd = isFin(p.amountUsd) ? Number(p.amountUsd) : null;
  const amount = p.amount ?? null;

  const threshold = {
    usd: minimumUsd,
    amount: minimumAmount,
    unit: unit || null,
    human: minimumAmount !== null && minimumAmount !== undefined ? maybeUnits(minimumAmount, decimals) : null,
  };
  const recommended = {
    usd: minimumUsd !== null ? round2(minimumUsd * warningMultiplier) : null,
    amount: minimumAmount !== null && minimumAmount !== undefined ? scaleAmount(minimumAmount, warningMultiplier) : null,
    human:
      minimumAmount !== null && minimumAmount !== undefined && decimals !== null
        ? maybeUnits(scaleAmount(minimumAmount, warningMultiplier), decimals)
        : null,
  };

  const hasNative = minimumAmount !== null && minimumAmount !== undefined && minimumAmount !== "" && amount !== null && amount !== undefined && amount !== "";
  const hasUsd = minimumUsd !== null && amountUsd !== null;

  let ok = true;
  let reason = null;
  let core = null;

  if (refuseNearIntents && usesNearIntents) {
    ok = false;
    reason = "near-intents-route";
    core = "This route settles through NEAR intents, which can hold a sub-threshold leg in escrow. Refusing it.";
  } else if (hasNative) {
    if (lt(amount, minimumAmount)) {
      ok = false;
      reason = "below-minimum";
      const shown = maybeUnits(minimumAmount, decimals);
      core = `Amount ${amount}${unit ? " " + unit : ""} is below the ${rail} minimum of ${shown}${unit ? " " + unit : ""}.`;
    }
  } else if (hasUsd) {
    if (lt(amountUsd, minimumUsd)) {
      ok = false;
      reason = "below-usd-floor";
      core = `Amount ~$${fmtUsd(amountUsd)} is below the $${fmtUsd(minimumUsd)} minimum for this route.`;
    }
  } else if (refuseUnverifiable && (minimumUsd !== null || (minimumAmount !== null && minimumAmount !== undefined && minimumAmount !== ""))) {
    ok = false;
    reason = "unverifiable-minimum";
    core =
      minimumUsd !== null
        ? `Cannot verify this route clears the $${fmtUsd(minimumUsd)} minimum (the amount could not be priced). Refusing (fail-closed).`
        : `Cannot verify this route clears the ${rail} minimum (the amount is unknown). Refusing (fail-closed).`;
  }

  const warningText = minimumRouteWarning({ floorUsd: minimumUsd, floorAmount: minimumAmount, unit, decimals });

  // "near or at the minimum" → expose the warning; comfortable headroom → none.
  let exposeWarning = false;
  if (!ok) {
    exposeWarning = true;
  } else if (minimumUsd !== null) {
    exposeWarning = hasUsd ? lt(amountUsd, recommended.usd) : true;
  } else if (minimumAmount !== null && minimumAmount !== undefined && minimumAmount !== "") {
    exposeWarning = hasNative ? lt(amount, recommended.amount) : true;
  }

  const message = !ok ? (core && warningText ? `${core} ${warningText}` : core || warningText) : null;

  return {
    ok,
    rail,
    reason,
    message,
    threshold,
    recommended,
    warning: exposeWarning ? warningText : null,
    usesNearIntents,
    amountUsd,
    amount,
  };
}

// ─────────────────────────────────────────────────────────── per-rail wrappers

/**
 * ChangeNow rail — the minimum is the LIVE per-pair min-amount (in FROM-currency
 * units). Refuse when `amount` < `minAmount`.
 */
export function checkChangeNowMinimum({ amount = null, minAmount = null, route = null, warningMultiplier } = {}) {
  const unit = String(route?.from ?? "").toUpperCase();
  return minimumRouteCheck({ rail: "changenow", amount, minimumAmount: minAmount, unit, warningMultiplier });
}

/**
 * THORChain rail — derive the slippage-protected minimum-out (the memo `limit`)
 * from the quote's expected output, then refuse when that limit is below the
 * destination dust threshold.
 *
 * @param {object} p
 * @param {number|string|bigint} p.expectedOutBase expected output, dest base units (1e8)
 * @param {number|string|bigint} [p.dustThresholdBase] destination dust_threshold
 * @param {number} [p.slippageBps] default DEFAULT_THORCHAIN_MIN_OUT_SLIPPAGE_BPS
 * @param {number} [p.decimals] destination asset decimals (8 for THORChain)
 * @param {string} [p.unit] human unit label (the destination chain)
 * @returns {object} a minimumRouteCheck result + { limitBase, expectedOutBase, slippageBps, dustThresholdBase }
 */
export function checkThorchainMinimum({
  expectedOutBase = null,
  dustThresholdBase = null,
  slippageBps = DEFAULT_THORCHAIN_MIN_OUT_SLIPPAGE_BPS,
  decimals = 8,
  unit = "",
  warningMultiplier,
} = {}) {
  const lim = thorchainMinOutLimit({ expectedOutBase, slippageBps, dustThresholdBase });
  if (!lim.ok) {
    const res = minimumRouteCheck({ rail: "thorchain", amount: null, minimumAmount: null, unit, decimals, warningMultiplier });
    return {
      ...res,
      ok: false,
      reason: lim.reason,
      message: "THORChain: could not compute a minimum-out (a missing or non-positive expected output). Refusing (fail-closed).",
      limitBase: null,
      expectedOutBase: null,
      slippageBps: lim.slippageBps,
      dustThresholdBase: null,
    };
  }
  const res = minimumRouteCheck({
    rail: "thorchain",
    amount: lim.limitBase,
    minimumAmount: lim.dustThresholdBase,
    unit,
    decimals,
    warningMultiplier,
  });
  return {
    ...res,
    limitBase: lim.limitBase,
    expectedOutBase: lim.expectedOutBase,
    slippageBps: lim.slippageBps,
    dustThresholdBase: lim.dustThresholdBase,
  };
}

/**
 * Compute the THORChain memo minimum-out (`limit`) in destination base units:
 * `floor(expectedOut × (1 − slippage))`. Pure.
 *
 * @returns {{ok:true, limitBase:bigint, expectedOutBase:bigint, slippageBps:number,
 *            dustThresholdBase:(bigint|null)}
 *          |{ok:false, reason:"bad-expected-out", limitBase:null}}
 */
export function thorchainMinOutLimit({ expectedOutBase = null, slippageBps = DEFAULT_THORCHAIN_MIN_OUT_SLIPPAGE_BPS, dustThresholdBase = null } = {}) {
  const out = toBig(expectedOutBase);
  if (out === null || out <= 0n) return { ok: false, reason: "bad-expected-out", limitBase: null };
  const bps = isFin(slippageBps) ? Math.max(0, Math.min(10000, Math.round(Number(slippageBps)))) : 0;
  const limitBase = (out * BigInt(10000 - bps)) / 10000n;
  return { ok: true, limitBase, expectedOutBase: out, slippageBps: bps, dustThresholdBase: toBig(dustThresholdBase) };
}

// ────────────────────────────────────────────────────── LiFi / NEAR-intents

const NEAR_TOKEN_RE = /(^|[^a-z0-9])near([^a-z0-9]|$)/i;
const INTENTS_RE = /intents?/i;

/**
 * Best-effort NEAR-intents detection on a LiFi quote/route shape.
 *
 * We deliberately DO NOT scan arbitrary strings (a symbol, an amount or a
 * description would produce false positives). We inspect only provider
 * ROUTING-IDENTITY fields — tool names/keys/types on the quote and inside its
 * `includedSteps` / `steps` / `route` tree — and match the tokens "near" or
 * "intents".
 *
 * If LiFi ever changes the shape of its NEAR-intents step this can miss it; the
 * USD floor (checkLifiMinimum) still applies as an independent guard. This is
 * documented, not guessed: a miss degrades to the floor check, never to a
 * silently-accepted sub-threshold route through a KNOWN marker.
 *
 * @returns {{usesNearIntents:boolean, markers:string[]}}
 */
export function detectNearIntents(quote) {
  const markers = [];
  const seen = new Set();
  const consider = (v) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (s === "" || seen.has(s)) return;
    seen.add(s);
    if (INTENTS_RE.test(s) || NEAR_TOKEN_RE.test(s)) markers.push(s);
  };
  const ID_KEYS = ["tool", "toolKey", "toolName", "type"];
  const walk = (node, depth = 0) => {
    if (node === null || node === undefined || depth > 8) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const k of ID_KEYS) if (k in node) consider(node[k]);
    for (const k of ["toolDetails"]) {
      const v = node[k];
      if (v && typeof v === "object") {
        consider(v.key);
        consider(v.name);
      }
    }
    for (const k of ["includedSteps", "steps", "route", "subRoutes", "action", "estimate", "fromChain", "toChain"]) {
      if (k in node) walk(node[k], depth + 1);
    }
  };
  walk(quote);
  return { usesNearIntents: markers.length > 0, markers };
}

/**
 * LiFi rail — a conservative USD floor (default $15) plus the NEAR-intents
 * check. Refuses (fail-closed) when the route is below the floor, and — when a
 * NEAR-intents step is detected and the amount cannot be priced — refuses too,
 * because that is precisely the strand scenario this guardrail exists for.
 *
 * @param {object} p
 * @param {object} [p.quote] the raw LiFi quote (for NEAR-intents detection)
 * @param {number} [p.amountUsd] route notional in USD
 * @param {number} [p.floorUsd] default DEFAULT_MIN_ROUTE_FLOOR_USD (15)
 * @param {boolean} [p.usesNearIntents] override detection
 * @param {boolean} [p.refuseNearIntents] refuse ANY NEAR-intents route (opt-in)
 * @param {boolean} [p.refuseUnverifiable] default true (fail-closed on unknown amount)
 */
export function checkLifiMinimum({
  quote = null,
  amountUsd = null,
  floorUsd = DEFAULT_MIN_ROUTE_FLOOR_USD,
  usesNearIntents,
  refuseNearIntents = false,
  refuseUnverifiable = true,
  warningMultiplier,
} = {}) {
  const det = usesNearIntents === undefined || usesNearIntents === null
    ? detectNearIntents(quote)
    : { usesNearIntents: usesNearIntents === true, markers: [] };
  const res = minimumRouteCheck({
    rail: "lifi",
    amountUsd,
    minimumUsd: floorUsd,
    usesNearIntents: det.usesNearIntents,
    refuseNearIntents,
    refuseUnverifiable,
    warningMultiplier,
  });
  return { ...res, usesNearIntents: det.usesNearIntents, markers: det.markers, floorUsd };
}
