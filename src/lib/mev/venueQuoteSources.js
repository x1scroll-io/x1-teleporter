/**
 * venueQuoteSources.js — the PER-VENUE QUOTE SOURCE wiring for the MEV
 * capture engine (Phase F): feeds the NEAR + TON native-DEX venue quotes
 * into the chain-agnostic capture detection.
 *
 * ── WHAT THIS MODULE IS (and is NOT) ──────────────────────────────────────
 * The detector math is ALREADY chain-agnostic (gapDetector.js same-pair round
 * trip; routeAnalyzer.js multi-hop route choice — both consume per-venue
 * quotes `{ dex|venue, amountIn, amountOut }` and hold no chain-specific
 * code). What NEAR + TON were missing is the QUOTE PRODUCERS wiring: turning
 * the venues' quote producers (Ref Finance + Jumbo on NEAR; STON.fi + DeDust
 * on TON — docs/NEAR-TON-DEX-RESEARCH.md §4.2) into the normalized quote sets
 * the detectors read, gathered for a planned route, then handed to the
 * existing observation hooks (routePlanner.observeCaptureForSwap /
 * observeRouteCapture). This module is that wiring. It REWRITES NO MATH.
 *
 * The venue quote PRODUCERS already exist (src/lib/near/refQuote.js,
 * src/lib/ton/stonfiQuote.js) — read-only, DI-clean, fail-closed. They emit
 * the engine quote shape `{ venue, chain, amountInRaw, amountOutRaw, pool, … }`.
 * The detectors read `{ dex|venue, amountIn, amountOut, pool }`. So the only
 * shim needed is the field normalization + a per-venue gather, which is what
 * normalizeVenueQuoteForDetector + collectVenueQuotes provide.
 *
 * 🔴 PURE OBSERVATION — NEVER A TRADE. This module builds quote OBJECTS and
 * calls the detection hooks. It constructs no transaction, signs nothing,
 * broadcasts nothing, and holds no key. Every failure (a producer that throws
 * or returns null) is dropped (fail-closed: a missing venue quote simply is
 * not in the set — the detector then honestly reports single-route). The
 * capture gate (MEV_CAPTURE_ENABLED, captureGate.js) stays the kill switch and
 * defaults OFF: this wiring runs detection-only at every gate state.
 *
 * ── THE VENUE SETS ────────────────────────────────────────────────────────
 * A cross-venue capture needs ≥2 venues on the SAME chain. Today each family
 * has one BUILT producer (Ref Finance on NEAR; STON.fi on TON) plus a
 * registry-verified secondary venue (Jumbo / DeDust) whose producer lands
 * with its swap leg — until then a single-venue set reports single-route and
 * moves on (no false detection). The sets are data; inject any producer map.
 */

import { rankQuotes } from "./gapDetector.js";
import { observeCaptureForSwap, observeRouteCapture } from "../../engine/routePlanner.js";
import { refQuote } from "../near/refQuote.js";
import { stonfiQuote } from "../ton/stonfiQuote.js";

/** The NEAR capture venue set — Ref Finance (reference) vs Jumbo. */
export const NEAR_CAPTURE_VENUES = Object.freeze(["ref-finance", "jumbo"]);

/** The TON capture venue set — STON.fi (reference) vs DeDust. */
export const TON_CAPTURE_VENUES = Object.freeze(["stonfi", "dedust"]);

/** chain → its same-chain capture venue set (data). */
export const CAPTURE_VENUES_BY_CHAIN = Object.freeze({
  near: NEAR_CAPTURE_VENUES,
  ton: TON_CAPTURE_VENUES,
});

/**
 * captureVenuesForChain — the venue ids a chain's capture scan consults
 * (a copy; [] for unknown chains).
 * @param {string} chain "near" | "ton" | …
 * @returns {string[]}
 */
export function captureVenuesForChain(chain) {
  const set = CAPTURE_VENUES_BY_CHAIN[chain];
  return set ? [...set] : [];
}

/**
 * normalizeVenueQuoteForDetector — map a producer quote (engine shape:
 * `amountInRaw`/`amountOutRaw`) into the detector quote shape the gap
 * detector + route analyzer read (`dex`/`amountIn`/`amountOut`). Accepts
 * either field spelling so a producer quote is usable as-is.
 *
 * Fail-closed: a quote missing an amount, with a non-integer amount, or with
 * a non-positive amountIn / negative amountOut returns null (the caller skips
 * it — never a malformed quote into the math).
 *
 * @param {object} raw a producer quote (refQuote / stonfiQuote output, or any
 *   object with amountIn[Raw]/amountOut[Raw])
 * @param {{venue?: string|null}} [opts] the venue id to fall back to when the
 *   quote carries neither `venue` nor `dex`
 * @returns {object|null} { dex, pool, amountIn (string), amountOut (string),
 *   chain, source } or null
 */
export function normalizeVenueQuoteForDetector(raw, { venue = null } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const amountIn = raw.amountIn ?? raw.amountInRaw;
  const amountOut = raw.amountOut ?? raw.amountOutRaw;
  if (amountIn == null || amountOut == null) return null;
  const dex = raw.venue ?? raw.dex ?? venue;
  if (!dex) return null;
  let ai;
  let ao;
  try {
    ai = BigInt(String(amountIn));
    ao = BigInt(String(amountOut));
  } catch {
    return null;
  }
  if (ai <= 0n || ao < 0n) return null;
  return {
    dex: String(dex),
    pool: raw.pool ?? null,
    amountIn: ai.toString(),
    amountOut: ao.toString(),
    chain: raw.chain ?? null,
    source: raw.source ?? null,
  };
}

/**
 * collectVenueQuotes — gather the per-venue quotes for a chain's capture
 * venue set (or an explicit list) by calling the injected producers, then
 * normalize each into the detector shape. Producers are keyed by venue id
 * and called with the SAME common args the producers accept:
 *   producer({ venue, chain, tokenIn, tokenOut, amountInRaw, ...extra })
 *
 * Fail-closed + best-effort: a producer that throws or returns null/malformed
 * is simply omitted (a missing venue is honest — the detector reports
 * single-route). The order follows the venue list (DEFAULT ROUTING ORDER).
 *
 * @param {object} args
 * @param {string} args.chain "near" | "ton"
 * @param {string[]} [args.venues] explicit venue list (default: the chain set)
 * @param {object} [args.tokenIn]  token ref (id/symbol)
 * @param {object} [args.tokenOut] token ref
 * @param {string|number} args.amountInRaw raw base-unit input
 * @param {object} [args.producers] { [venue]: (args) => Promise<quote|null> }
 * @param {object} [args.quoteArgs] extra args forwarded to every producer
 * @returns {Promise<object[]>} detector-shaped quotes (malformed/null skipped)
 */
export async function collectVenueQuotes({ chain, venues = null, tokenIn = null, tokenOut = null, amountInRaw, producers = {}, quoteArgs = {} } = {}) {
  const list = Array.isArray(venues) && venues.length > 0 ? [...venues] : captureVenuesForChain(chain);
  const out = [];
  for (const venue of list) {
    const producer = producers[venue];
    if (typeof producer !== "function") continue;
    let raw = null;
    try {
      raw = await producer({ venue, chain, tokenIn, tokenOut, amountInRaw, ...quoteArgs });
    } catch {
      raw = null; // fail-closed: a producer error is a missing venue, never a throw
    }
    const quote = normalizeVenueQuoteForDetector(raw, { venue });
    if (quote) out.push(quote);
  }
  return out;
}

/**
 * observeVenueCaptureForSwap — the SAME-PAIR round-trip wiring: gather the
 * chain's multi-venue BUY quotes (X→Y at amountInRaw) + SELL quotes (Y→X,
 * sized at the best buy output for exact round-trip math), then run the
 * existing observation hook observeCaptureForSwap (captureGate.runCaptureScan
 * — pure detection, gated OFF by default). Returns null when no venue
 * produced a quote (nothing to observe).
 *
 * @param {object} args see collectVenueQuotes + { pair?, gasCostQuoteUnits? }
 * @returns {Promise<object|null>} the scan { detection, gate, report, payout }
 */
export async function observeVenueCaptureForSwap({
  chain,
  pair = null,
  tokenIn = null,
  tokenOut = null,
  amountInRaw,
  producers = {},
  venues = null,
  quoteArgs = {},
  gasCostQuoteUnits = 0n,
  onLog = null,
} = {}) {
  const buyQuotes = await collectVenueQuotes({ chain, venues, tokenIn, tokenOut, amountInRaw, producers, quoteArgs });
  if (buyQuotes.length === 0) return null;
  const bestBuy = rankQuotes(buyQuotes).best;
  if (!bestBuy) return null;
  // Size the sell leg at the best buy output → exact round-trip math (the
  // detector flags exact:false otherwise — see gapDetector.detectCaptureGap).
  const sellQuotes = await collectVenueQuotes({
    chain,
    venues,
    tokenIn: tokenOut,
    tokenOut: tokenIn,
    amountInRaw: bestBuy.amountOut.toString(),
    producers,
    quoteArgs,
  });
  if (sellQuotes.length === 0) return null;
  const scan = observeCaptureForSwap({
    chain,
    pair: pair ?? { from: tokenIn?.symbol ?? null, to: tokenOut?.symbol ?? null },
    buyQuotes,
    sellQuotes,
    gasCostQuoteUnits,
  });
  if (typeof onLog === "function") onLog(scan.report);
  return scan;
}

/**
 * observeVenueRouteCapture — the MULTI-HOP route-choice wiring: for each leg
 * of a planned route (a leg names its chain + the routed venue + the token
 * pair + the leg's input amount), gather that leg's per-venue quotes via the
 * injected producers, then run the existing observation hook
 * observeRouteCapture (captureGate.runRouteCaptureScan — pure multi-hop
 * detection, gated OFF by default).
 *
 * Legs whose chain has no venue set / no producer simply carry [] quotes and
 * are omitted from the analyzed shape ONLY if they have no quotes at all
 * (a leg with no quotes cannot be analyzed — it is skipped, honest). The
 * routed venue must appear among a leg's gathered quotes for that leg to be
 * analyzed (routeAnalyzer.analyzeLeg requires it); a leg whose routed venue
 * produced no quote is skipped with a reason rather than throwing.
 *
 * @param {object} args
 * @param {object} args.route { id?, legs: [{ hop?, from, to, chain, venueChosen,
 *   tokenIn?, tokenOut?, amountInRaw, usdPerOutUnit? }] }
 * @param {object} args.producers { [venue]: (args) => Promise<quote|null> }
 * @param {object} [args.quoteArgsByChain] { near: {...}, ton: {...} }
 * @param {(line:string)=>void} [args.onLog]
 * @returns {Promise<object|null>} the scan { analysis, gate, report, payouts }
 */
export async function observeVenueRouteCapture({ route, producers = {}, quoteArgsByChain = {}, onLog = null } = {}) {
  if (!route || !Array.isArray(route.legs)) return null;
  const legs = [];
  const skipped = [];
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i] ?? {};
    const hop = leg.hop ?? i + 1;
    const quotes = await collectVenueQuotes({
      chain: leg.chain,
      tokenIn: leg.tokenIn ?? null,
      tokenOut: leg.tokenOut ?? null,
      amountInRaw: leg.amountInRaw,
      producers,
      quoteArgs: quoteArgsByChain?.[leg.chain] ?? {},
    });
    if (quotes.length === 0) {
      skipped.push({ hop, reason: "no venue quote gathered for the leg (no producer / all fail-closed)" });
      continue;
    }
    if (leg.venueChosen && !quotes.some((q) => q.dex === leg.venueChosen)) {
      skipped.push({ hop, reason: `routed venue "${leg.venueChosen}" produced no quote among [${quotes.map((q) => q.dex).join(", ")}]` });
      continue;
    }
    legs.push({
      hop,
      from: leg.from ?? null,
      to: leg.to ?? null,
      chain: leg.chain ?? null,
      venueChosen: leg.venueChosen,
      quotes,
      ...(leg.usdPerOutUnit !== undefined ? { usdPerOutUnit: leg.usdPerOutUnit } : {}),
    });
  }
  if (legs.length === 0) return null;
  const scan = observeRouteCapture({ id: route.id ?? null, legs });
  if (skipped.length) scan.skipped = skipped;
  if (typeof onLog === "function") onLog(scan.report);
  return scan;
}

// ── the real producers (adapters) ─────────────────────────────────────────
//
// The built venue producers the app injects. Each adapter maps the common
// collectVenueQuotes call-shape ({ venue, chain, tokenIn, tokenOut,
// amountInRaw, … }) onto the concrete producer. Production wires the REAL
// producers (refQuote / stonfiQuote — DI-clean, fail-closed); tests inject
// fakes, and the two adapters are exercised with injected fakes so node:test
// never touches the network.

/**
 * refQuoteProducer — the Ref Finance (NEAR) venue producer. Delegates to
 * src/lib/near/refQuote.js (read-only; fail-closed → null).
 * @param {object} args { tokenIn, tokenOut, amountInRaw, … refQuote opts }
 * @returns {Promise<object|null>}
 */
export function refQuoteProducer({ tokenIn, tokenOut, amountInRaw, ...rest } = {}) {
  return refQuote({ tokenIn, tokenOut, amountInRaw, ...rest });
}

/**
 * stonfiQuoteProducer — the STON.fi (TON) venue producer. Delegates to
 * src/lib/ton/stonfiQuote.js (read-only; fail-closed → null). Maps the common
 * tokenIn/tokenOut refs onto the producer's offer/ask addresses.
 * @param {object} args { tokenIn, tokenOut, amountInRaw, … stonfiQuote opts }
 * @returns {Promise<object|null>}
 */
export function stonfiQuoteProducer({ tokenIn, tokenOut, amountInRaw, ...rest } = {}) {
  return stonfiQuote({
    offerAddress: tokenIn?.id ?? tokenIn ?? null,
    askAddress: tokenOut?.id ?? tokenOut ?? null,
    amountInRaw,
    ...rest,
  });
}

/**
 * defaultVenueProducers — the producers map the app injects for a chain's
 * capture scan: the BUILT producers (refQuote on NEAR; stonfiQuote on TON).
 * The secondary venues (Jumbo / DeDust) are added when their producers land;
 * a single-venue set honestly reports single-route until then. Injection
 * points ({ refQuoteImpl, stonfiQuoteImpl, … }) let tests supply fakes.
 *
 * @param {object} [opts]
 * @returns {{ [venue: string]: Function }}
 */
export function defaultVenueProducers({ refQuoteImpl = refQuoteProducer, stonfiQuoteImpl = stonfiQuoteProducer, ...rest } = {}) {
  return {
    "ref-finance": (args) => refQuoteImpl({ ...rest, ...args }),
    stonfi: (args) => stonfiQuoteImpl({ ...rest, ...args }),
  };
}
