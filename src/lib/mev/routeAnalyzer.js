/**
 * routeAnalyzer.js — the MULTI-HOP ROUTE-CHOICE analyzer (pure).
 *
 * Mr. Esters' framing correction (2026-09-06): the single same-pair gap sim
 * (gapDetector.js — the SAME pair quoted on MULTIPLE venues on the SAME
 * chain, bought and sold in one atomic round trip) proved ~0 on deep stable
 * pairs — because a ROUND TRIP pays two pool fees + two gas bills and the
 * venues arbitrage each other too tightly on liquid pairs. The real MEV is
 * DISTRIBUTED across the whole multi-hop journey (DOGE→SOL→USDC→X1 /
 * EVM-stable→SOL→fresh-memecoin): every hop has a venue CHOICE (which DEX,
 * which aggregator, which bridge), and the difference between the venue the
 * engine routed and the BEST venue for that hop is capturable value — ONCE
 * PER HOP, one-way, without the round-trip double-fee burden.
 *
 * ── THE MODEL ─────────────────────────────────────────────────────────────
 * A user route = an ordered list of LEGS (swaps + bridges):
 *   source token → [hop1: swap on chain A] → [hop2: bridge A→B] →
 *   [hop3: swap on B] → … → destination token.
 * For EACH leg the engine already fetched quotes from the venue candidates
 * (DEX_DIRECT_FALLBACKS + aggregators + bridge options — CAPTURE_CANDIDATES
 * in routePlanner.js) and ROUTED the leg through one of them. THIS MODULE
 * computes:
 *
 *   1. Per-leg capturable improvement — best-venue quote vs the routed
 *      venue, in bps and $, for every leg with >1 venue. Single-venue legs
 *      contribute 0 (there is no choice to improve).
 *   2. Accumulated route-level capture — the sum of per-leg improvements
 *      net of per-leg cost deltas (fees + gas) across the WHOLE journey.
 *      This is the number that matters (Mr. Esters).
 *   3. Route-choice optimization — the optimal sub-path (best venue per
 *      leg) vs what got routed; the delta IS the capturable value.
 *
 * Output per analyzed route:
 *   { legs: [{hop, from, to, venueChosen, venueBest, gapBps, gapUsd,
 *             netUsd}], routeGapBps, routeGapUsd, routeNetUsd, wouldCapture,
 *     optimalRoute }.
 *
 * 🔴 WHAT THIS MODULE IS: pure, deterministic MATH over quote objects — the
 * same discipline as gapDetector.js. It imports only gapDetector's pure
 * primitives (RATE_SCALE / normalizeQuote / quoteRouteId / rankQuotes /
 * gapBpsBetween), touches no network, constructs no transactions and NEVER
 * returns an executable trade. It returns an ANALYSIS. The gate
 * (captureGate.js runRouteCaptureScan), the routing hook (routePlanner.js
 * observeRouteCapture) and the simulation harness
 * (tools/simulate-mev-multihop.mjs) are separate layers.
 *
 * ── HOW THIS RELATES TO gapDetector.js (documented — kept together) ───────
 * gapDetector.js answers the ROUND-TRIP question (same pair, buy on the
 * cheap venue + sell on the expensive venue, one atomic same-chain round
 * trip). routeAnalyzer answers the ONE-WAY ROUTE-CHOICE question (a user
 * journey's per-hop venue selection — no round trip, no double fees). They
 * are different models; BOTH stay. The analyzer CALLS gapDetector's pure
 * primitives per leg (rankQuotes picks the leg's best venue; gapBpsBetween
 * measures the spread); the round-trip detector itself is untouched.
 *
 * ── THE FEE RULING (same as gapDetector — carried, not re-litigated) ──────
 * Quotes are NET quotes: every venue's amountOut is what the journey leg
 * DELIVERS after that venue's pool/bridge fees (quoter eth_call / pool-state
 * walk / aggregator net output). Pool fees are NEVER subtracted a second
 * time (DEX_FEES_NETTED_NOTE). Only EXPLICIT ADDITIVE costs (gas paid on a
 * destination chain outside the swap, explicit bridge surcharges) may be
 * supplied per venue as gasCostUsd / feeCostUsd — and only the DELTA of
 * those costs between the best venue and the chosen venue enters the net
 * math (default 0/0 → delta 0: switching venues on the same chain costs the
 * same gas). When a leg's venues do not all carry the cost fields the cost
 * delta is reported 0 with costExact:false (we cannot know — we do not
 * guess). CAPTURE_FEE_POLICY_BPS (0, configurable) does not apply per leg:
 * capture value here = route-choice improvement the engine realizes by
 * routing each hop through its best venue; the fee-model-v2 journey charge
 * (fees.ts) applies to USER journeys regardless of venue choice and thus
 * cancels out of every venue comparison.
 *
 * ── USD (reporting only — never on a money path) ─────────────────────────
 * The analyzer is pure over RAW units (BigInt). USD figures enter per leg
 * as usdPerOutUnit — the REAL $ value of one raw output unit of the leg's
 * to-token, computed by the CALLER from real same-round quotes (stable
 * pairs by peg construction; SOL/exotic tokens via real pool/venue rates —
 * the simulation harness documents each). No synthetic prices. A leg
 * without a real conversion contributes null USD (its bps still counts;
 * the route-level $ sums are flagged partial — honest, never silently
 * complete).
 *
 * All amounts are RAW base units (integer strings / BigInt-compatible).
 * Rates are BigInt ratios at RATE_SCALE (1e12) — bps math is exact integer
 * arithmetic (no floating point on money paths). USD is Number (reporting).
 */

import { RATE_SCALE, normalizeQuote, quoteRouteId, gapBpsBetween, DEX_FEES_NETTED_NOTE } from "./gapDetector.js";

/** The economic bar for a ROUTE-level capture (mirrors the report builder's
 *  single-pair bar): a route is ECONOMICALLY capturable only when the
 *  accumulated net is ≥ $0.10 AND ≥ 1 bps. Strict-math positives below the
 *  bar are quote-rounding noise, not a capture. */
export const ROUTE_EC_MIN_USD = 0.1;
export const ROUTE_EC_MIN_BPS = 1;

/** A note carried on every leg cost report (pool fees are netted inside the
 *  quotes; only explicit additive cost DELTAS enter the net math). */
export const ROUTE_COSTS_NOTE =
  "every venue quote is NET (pool/bridge fees already inside amountOut — never subtracted twice, see " +
  "DEX_FEES_NETTED_NOTE). Only explicit ADDITIVE costs (gasCostUsd/feeCostUsd) enter the per-leg cost DELTA " +
  "between the best venue and the chosen venue; same-chain venue swaps share gas, so the delta is usually 0.";

/**
 * Normalize a venue quote. Accepts the engine's quote field `dex` or the
 * route model's `venue`; both normalize to `venue`. Reads
 * amountIn/amountOut (raw), plus optional cost fields (gasCostUsd /
 * feeCostUsd — explicit ADDITIVE costs, default 0).
 *
 * @param {object} q a raw venue quote
 * @returns {{venue: string, routeId: string, amountIn: bigint,
 *            amountOut: bigint, gasCostUsd: number, feeCostUsd: number}}
 * @throws on malformed quotes (fail-closed)
 */
export function normalizeVenueQuote(q) {
  if (!q || typeof q !== "object") throw new Error("routeAnalyzer: a venue quote must be an object");
  const venue = typeof q.venue === "string" && q.venue ? q.venue : typeof q.dex === "string" && q.dex ? q.dex : null;
  if (!venue) throw new Error("routeAnalyzer: a venue quote needs a venue (or dex) name");
  const n = normalizeQuote({ dex: venue, pool: q.pool ?? null, amountIn: q.amountIn, amountOut: q.amountOut });
  const gasCostUsd = q.gasCostUsd === undefined || q.gasCostUsd === null ? 0 : Number(q.gasCostUsd);
  const feeCostUsd = q.feeCostUsd === undefined || q.feeCostUsd === null ? 0 : Number(q.feeCostUsd);
  if (!Number.isFinite(gasCostUsd) || gasCostUsd < 0) throw new Error(`routeAnalyzer: venue ${venue} gasCostUsd must be a non-negative number`);
  if (!Number.isFinite(feeCostUsd) || feeCostUsd < 0) throw new Error(`routeAnalyzer: venue ${venue} feeCostUsd must be a non-negative number`);
  return { ...n, venue, routeId: quoteRouteId(n), gasCostUsd, feeCostUsd };
}

/** True when every quote in a list shares the same amountIn (raw). */
export function legQuotesShareSize(quotes) {
  if (!Array.isArray(quotes) || quotes.length === 0) return true;
  const first = normalizeQuote(quotes[0]).amountIn;
  return quotes.every((q) => normalizeQuote(q).amountIn === first);
}

/**
 * The best venue quote of a leg's option set (max rate; de-duplicated by
 * route id keeping the best). Null when the leg has no quotes. Works on
 * raw venue quotes (venue|dex field) AND preserves the cost fields
 * (gasCostUsd/feeCostUsd) of the winning quote.
 */
export function bestVenueQuote(quotes) {
  if (!Array.isArray(quotes) || quotes.length === 0) return null;
  const norm = quotes.map(normalizeVenueQuote);
  const byRoute = new Map();
  for (const q of norm) {
    const prev = byRoute.get(q.routeId);
    if (!prev || q.amountOut * prev.amountIn > prev.amountOut * q.amountIn) byRoute.set(q.routeId, q);
  }
  return [...byRoute.values()].sort((a, b) => (b.amountOut * a.amountIn > a.amountOut * b.amountIn ? 1 : -1))[0] ?? null;
}

/**
 * Find the venue quote whose route matches the chosen venue label. The
 * label may be a bare venue name ("jupiter") or a route id ("uniswap:
 * pool-addr"); a bare name matches any quote whose venue name equals it
 * (the highest-rate one when the venue was quoted on several pools).
 *
 * @param {Array<object>} quotes venue quotes (normalized inside)
 * @param {string} venueChosen the label of the routed venue
 * @returns {object|null} the matching quote (best rate when several)
 */
export function chosenVenueQuote(quotes, venueChosen) {
  if (!Array.isArray(quotes) || quotes.length === 0) return null;
  const wanted = String(venueChosen);
  const byName = [];
  for (const raw of quotes) {
    const q = normalizeVenueQuote(raw);
    if (q.routeId === wanted || q.venue === wanted) byName.push(q);
  }
  if (byName.length === 0) return null;
  return byName.sort((a, b) => (b.amountOut * a.amountIn > a.amountOut * b.amountIn ? 1 : -1))[0];
}

/**
 * Analyze ONE leg: best-venue vs chosen-venue spread + the net improvement.
 * Pure. Single-venue legs produce a zero-contribution record (gapBps null).
 *
 * @param {object} leg { hop, from, to, chain?, kind?, venueChosen, quotes,
 *   usdPerOutUnit? } — quotes at the SAME amountIn (the leg's routed size)
 *   for exact math; mixed sizes fall back to rate-implied (exact:false).
 * @returns {object} the per-leg analysis record
 */
export function analyzeLeg(leg) {
  if (!leg || typeof leg !== "object") throw new Error("routeAnalyzer.analyzeLeg: a leg is required");
  if (!Array.isArray(leg.quotes) || leg.quotes.length === 0) {
    throw new Error(`routeAnalyzer.analyzeLeg: hop ${leg.hop ?? "?"} (${leg.from ?? "?"}→${leg.to ?? "?"}) has no venue quotes`);
  }
  if (typeof leg.venueChosen !== "string" || !leg.venueChosen) {
    throw new Error(`routeAnalyzer.analyzeLeg: hop ${leg.hop ?? "?"} needs venueChosen (which venue was routed)`);
  }
  const quotes = leg.quotes.map(normalizeVenueQuote);
  const best = bestVenueQuote(quotes);
  if (!best) throw new Error(`routeAnalyzer.analyzeLeg: hop ${leg.hop ?? "?"} — no quotable venue`);
  const chosen = chosenVenueQuote(quotes, leg.venueChosen);
  if (!chosen) {
    throw new Error(
      `routeAnalyzer.analyzeLeg: hop ${leg.hop ?? "?"} venueChosen "${leg.venueChosen}" has no quote among ` +
        `[${quotes.map((q) => q.venue).join(", ")}]`,
    );
  }

  const singleVenue = quotes.length < 2 || (best.routeId === chosen.routeId && quotes.filter((q) => q.routeId !== best.routeId).length === 0);
  const exact = legQuotesShareSize(quotes);
  const sameSize = chosen.amountIn === best.amountIn;

  // The raw-unit improvement of routing the best venue instead of the chosen
  // venue, on the leg's routed input size. Exact when both quotes share the
  // size; rate-implied otherwise (flagged — never silently exact).
  let deltaOutRaw;
  if (exact || sameSize) {
    deltaOutRaw = best.amountOut - chosen.amountOut;
  } else {
    // rate-implied: (rateBest − rateChosen) applied to the chosen size
    const rateBest = (best.amountOut * RATE_SCALE) / best.amountIn;
    const rateChosen = (chosen.amountOut * RATE_SCALE) / chosen.amountIn;
    deltaOutRaw = ((rateBest - rateChosen) * chosen.amountIn) / RATE_SCALE;
  }

  const gapBps = singleVenue ? null : gapBpsBetween(best, chosen);
  const usdPerOutUnit = leg.usdPerOutUnit === undefined || leg.usdPerOutUnit === null ? null : Number(leg.usdPerOutUnit);
  if (usdPerOutUnit !== null && (!Number.isFinite(usdPerOutUnit) || usdPerOutUnit < 0)) {
    throw new Error(`routeAnalyzer.analyzeLeg: hop ${leg.hop ?? "?"} usdPerOutUnit must be a non-negative number`);
  }
  const gapUsd = gapBps === null || usdPerOutUnit === null ? null : Number(deltaOutRaw) * usdPerOutUnit;

  // Explicit additive cost DELTA (best venue vs chosen venue). Pool fees
  // are netted inside the quotes — NEVER here. The delta is computed only
  // when at least one venue DECLARES an additive cost; otherwise 0 (same-
  // chain venue swaps share gas; we never guess a nonzero delta from
  // missing fields). costExact is false when only some venues declared
  // costs (the delta is then computed from the declared ones + zeros —
  // flagged, never silently exact).
  const anyDeclared = quotes.some((q) => (q.gasCostUsd ?? 0) > 0 || (q.feeCostUsd ?? 0) > 0);
  const allDeclared = quotes.every((q) => (q.gasCostUsd ?? 0) > 0 || (q.feeCostUsd ?? 0) > 0);
  const costDeltaUsd = anyDeclared
    ? best.gasCostUsd + best.feeCostUsd - (chosen.gasCostUsd + chosen.feeCostUsd)
    : 0;
  const netUsd = gapUsd === null ? null : gapUsd - costDeltaUsd;
  const costExact = !anyDeclared || allDeclared;

  return {
    hop: leg.hop ?? null,
    from: leg.from ?? null,
    to: leg.to ?? null,
    chain: leg.chain ?? null,
    kind: leg.kind ?? null,
    venueChosen: chosen.venue,
    venueBest: best.venue,
    routeChosen: chosen.routeId,
    routeBest: best.routeId,
    singleVenue,
    exact,
    exactNote: exact
      ? "all venues quoted at the leg's routed size — the improvement math is exact"
      : "venues were NOT all quoted at the leg's routed size — improvement math is rate-implied (flagged, never silently exact)",
    gapBps,
    deltaOutRaw: deltaOutRaw.toString(),
    gapUsd: gapUsd === null ? null : roundUsd(gapUsd),
    costDeltaUsd: roundUsd(costDeltaUsd),
    costExact,
    costNote: anyDeclared
      ? "cost delta = (gas+fee of the best venue) − (gas+fee of the chosen venue); pool fees are netted inside the quotes — never subtracted twice"
      : "no venue declared explicit additive costs — cost delta 0 (same-chain venue swaps share gas; pool fees are netted inside the quotes)",
    netUsd: netUsd === null ? null : roundUsd(netUsd),
    netNote: "net = gapUsd − costDeltaUsd (explicit additive costs only; pool fees netted inside the quotes)",
  };
}

/** Round USD to 4dp for reports (reporting only — never on a money path). */
function roundUsd(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * analyzeRoute — THE analyzer. Given an ordered leg list (each leg carrying
 * its venue options' quotes + the routed venue), compute the per-leg venue
 * deltas, the ACCUMULATED route-level capture (the number that matters),
 * the optimal sub-path, and the honest wouldCapture verdict.
 *
 * @param {object} route { id, legs: [leg…] } — see analyzeLeg for the leg
 *   shape. Legs are ordered (hop 1 = source side); the route's journey $ is
 *   the sum of each analyzed leg's output notional (real usdPerOutUnit).
 * @returns {object} the ROUTE analysis (never a trade)
 */
export function analyzeRoute(route) {
  if (!route || typeof route !== "object") throw new Error("routeAnalyzer.analyzeRoute: a route is required");
  if (!Array.isArray(route.legs) || route.legs.length === 0) throw new Error("routeAnalyzer.analyzeRoute: a route needs legs");
  const legs = route.legs.map((leg, i) => analyzeLeg({ ...leg, hop: leg.hop ?? i + 1 }));

  let routeGapUsd = 0;
  let routeNetUsd = 0;
  let notionalUsd = 0;
  let legsWithUsd = 0;
  let legsWithUnvaluedGap = 0;
  for (const l of legs) {
    if (l.gapUsd !== null && l.netUsd !== null) {
      routeGapUsd += l.gapUsd;
      routeNetUsd += l.netUsd;
      legsWithUsd++;
    } else if (!l.singleVenue && BigInt(l.deltaOutRaw) > 0n) {
      // a REAL improvement that could not be valued in $ (no conversion)
      legsWithUnvaluedGap++;
    }
  }
  // Output notionals (routed amountOut × real usdPerOutUnit) for the
  // dollar-weighted route bps — recomputed from the raw quotes.
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    const usdPerOutUnit = leg.usdPerOutUnit === undefined || leg.usdPerOutUnit === null ? null : Number(leg.usdPerOutUnit);
    if (usdPerOutUnit === null) continue;
    const chosen = chosenVenueQuote(leg.quotes, leg.venueChosen);
    if (!chosen) continue;
    notionalUsd += Number(chosen.amountOut) * usdPerOutUnit;
  }

  const routeUsdPartial = legsWithUnvaluedGap > 0;
  const routeGapBps = notionalUsd > 0 && legsWithUsd > 0 ? (routeGapUsd / notionalUsd) * 10000 : null;
  const routeNetBps = notionalUsd > 0 && legsWithUsd > 0 ? (routeNetUsd / notionalUsd) * 10000 : null;
  const routeGapBpsNote =
    "dollar-weighted across the analyzed legs: Σ leg gapUsd ÷ Σ leg output notional (routed amountOut × real usdPerOutUnit) × 10000 — " +
    "the accumulated capture as bps of the journey's routed value";

  // WHY-NOT logic (honest, explicit — the same discipline as gapDetector):
  // a leg "has an improvement" when it is multi-venue AND the best venue
  // delivers more raw output than the chosen venue (deltaOutRaw > 0 — real
  // value; integer-bps rounding can read 0 while the $ delta is real).
  const improvedLegs = legs.filter((l) => !l.singleVenue && BigInt(l.deltaOutRaw) > 0n);
  const multiVenueLegs = legs.filter((l) => !l.singleVenue);
  let wouldCapture = false;
  let whyNot = null;
  if (improvedLegs.length === 0) {
    whyNot = multiVenueLegs.length === 0
      ? "single-venue route: no leg has more than one quotable venue — there is no route-choice value to capture (bridge legs with one serving carrier contribute 0)"
      : "already-optimal: every multi-venue leg was already routed through its best venue — the engine left nothing on the table";
  } else if (legsWithUsd === 0) {
    whyNot = "usd-partial: no leg carried a real USD conversion — the route-level $ capture cannot be computed (per-leg bps are reported)";
  } else if (routeNetUsd <= 0) {
    whyNot = `below-threshold: the accumulated venue improvement ($${roundUsd(routeGapUsd)}) does not exceed the accumulated per-leg cost deltas ($${roundUsd(routeNetUsd - routeGapUsd)})`;
  } else {
    wouldCapture = true;
  }
  const economical = Boolean(wouldCapture && routeNetUsd !== null && routeNetUsd >= ROUTE_EC_MIN_USD && routeGapBps !== null && routeGapBps >= ROUTE_EC_MIN_BPS);

  return {
    kind: "route-capture-analysis",
    routeId: route.id ?? null,
    legs,
    routeGapBps: routeGapBps === null ? null : roundUsd(routeGapBps),
    routeNetBps: routeNetBps === null ? null : roundUsd(routeNetBps),
    routeGapBpsNote,
    routeGapUsd: legsWithUsd ? roundUsd(routeGapUsd) : null,
    routeNetUsd: legsWithUsd ? roundUsd(routeNetUsd) : null,
    routeUsdPartial,
    routeUsdPartialNote: routeUsdPartial
      ? `${legsWithUnvaluedGap} of ${legs.length} legs carry a real venue improvement that could not be valued in $ (no real conversion) — the route-level $ sums cover the valued legs; per-leg bps are complete`
      : "every improved leg carried a real USD conversion — the route-level $ sums are complete",
    wouldCapture,
    whyNot,
    economical,
    economicBar: { minUsd: ROUTE_EC_MIN_USD, minBps: ROUTE_EC_MIN_BPS },
    /** The optimal sub-path: the best venue per leg (single-venue legs keep
     *  their only venue). The delta vs what got routed IS the capture. */
    optimalRoute: legs.map((l) => ({ hop: l.hop, venue: l.venueBest })),
    costNote: ROUTE_COSTS_NOTE,
    nettedFeesNote: DEX_FEES_NETTED_NOTE,
  };
}

/**
 * summarizeRouteAnalyses — aggregate a list of route analyses for reports
 * (the honest numbers: how many routes would capture, bps/$ distribution,
 * how many were single-venue / already-optimal / below-threshold). Pure.
 *
 * @param {Array<object>} analyses from analyzeRoute
 * @returns {object} summary
 */
export function summarizeRouteAnalyses(analyses) {
  const list = Array.isArray(analyses) ? analyses : [];
  const withUsd = list.filter((a) => a.routeNetUsd !== null);
  const wouldCapture = list.filter((a) => a.wouldCapture);
  const economical = list.filter((a) => a.economical);
  const singleVenue = list.filter((a) => a.legs.every((l) => l.singleVenue));
  const alreadyOptimal = list.filter((a) => !a.wouldCapture && !singleVenue.includes(a) && /already-optimal/.test(a.whyNot ?? ""));
  const costNotCleared = list.filter((a) => !a.wouldCapture && !singleVenue.includes(a) && !alreadyOptimal.includes(a));
  const belowEconomicBar = wouldCapture.filter((a) => !a.economical);
  const gapBps = list.flatMap((a) => a.legs.filter((l) => l.gapBps !== null).map((l) => l.gapBps));
  const routeNetUsdVals = withUsd.map((a) => a.routeNetUsd);
  const routeNetBpsVals = withUsd.map((a) => a.routeNetBps).filter((x) => x !== null);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const bucket = (arr, edges) => edges.map(([lo, hi], i) => ({ label: `${lo}-${hi === Infinity ? "+" : hi}bps`, count: arr.filter((x) => x >= lo && (hi === Infinity || x < hi)).length }));
  return {
    total: list.length,
    wouldCapture: wouldCapture.length,
    economicallyCapturable: economical.length,
    singleVenue: singleVenue.length,
    alreadyOptimal: alreadyOptimal.length,
    costNotCleared: costNotCleared.length,
    belowEconomicBar: belowEconomicBar.length,
    perLegGapBps: {
      min: gapBps.length ? Math.min(...gapBps) : null,
      max: gapBps.length ? Math.max(...gapBps) : null,
      avg: avg(gapBps),
      distribution: bucket(gapBps, [[0, 1], [1, 5], [5, 20], [20, Infinity]]),
    },
    routeNetUsd: {
      min: routeNetUsdVals.length ? Math.min(...routeNetUsdVals) : null,
      max: routeNetUsdVals.length ? Math.max(...routeNetUsdVals) : null,
      avg: avg(routeNetUsdVals),
    },
    routeNetBps: {
      min: routeNetBpsVals.length ? Math.min(...routeNetBpsVals) : null,
      max: routeNetBpsVals.length ? Math.max(...routeNetBpsVals) : null,
      avg: avg(routeNetBpsVals),
    },
    legsAnalyzed: list.reduce((s, a) => s + a.legs.length, 0),
    legsWithVenueChoice: list.reduce((s, a) => s + a.legs.filter((l) => !l.singleVenue).length, 0),
  };
}
