/**
 * routeAnalyzer.test.js — the MULTI-HOP route-choice analyzer tests (pure).
 *
 * Spec coverage:
 *   • per-leg venue delta math: best-venue vs routed-venue in bps + $ (BigInt
 *     rates, exact at shared sizes),
 *   • ACCUMULATED route-level capture: per-leg nets sum across the whole
 *     journey (the number that matters),
 *   • optimal-sub-path selection (best venue per leg) vs what got routed,
 *   • boundary: single-venue legs contribute 0 (gapBps null, no $),
 *   • already-optimal routes → wouldCapture false with the honest whyNot,
 *   • rate-implied fallback when venues were quoted at different sizes
 *     (exact:false — never silently exact),
 *   • per-leg cost deltas (explicit additive costs only; pool fees netted
 *     inside quotes — never double counted),
 *   • route-level economic bar (≥ $0.10 AND ≥ 1 bps),
 *   • usd-partial honesty (a leg without a real USD conversion → route $ is
 *     flagged partial, per-leg bps still complete),
 *   • fail-closed on malformed routes/legs/quotes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeRoute,
  analyzeLeg,
  bestVenueQuote,
  chosenVenueQuote,
  normalizeVenueQuote,
  summarizeRouteAnalyses,
  ROUTE_EC_MIN_USD,
  ROUTE_EC_MIN_BPS,
} from "./routeAnalyzer.js";

// A stable-ish USDC→USDT leg: the engine routed "lifi" (the aggregator
// default) but the direct uniswap f100 pool quotes ~5 bps better (the real
// eth signature from the 2026-09-06 single-pair captures).
const usdcUsdtLeg = {
  hop: 1,
  from: "USDC",
  to: "USDT",
  chain: "eth",
  kind: "swap",
  venueChosen: "lifi",
  usdPerOutUnit: 1 / 1e6, // USDT ≈ $1 (peg construction; real-rate note)
  quotes: [
    { venue: "lifi", pool: "lifi-eth-USDC-USDT", amountIn: "2500000000", amountOut: "2493955555", source: "REAL-live" },
    { venue: "uniswap", pool: "uniswap-eth-USDC-USDT-f100", amountIn: "2500000000", amountOut: "2495210000", source: "REAL-live" },
  ],
};

test("routeAnalyzer: normalizeVenueQuote accepts venue or dex and BigInts the amounts", () => {
  const q = normalizeVenueQuote({ dex: "orca", pool: "pool1", amountIn: "1000000000", amountOut: "123" });
  assert.equal(q.venue, "orca");
  assert.equal(q.routeId, "orca:pool1");
  assert.equal(q.amountIn, 1000000000n);
  assert.equal(q.amountOut, 123n);
  assert.equal(q.gasCostUsd, 0);
  assert.equal(q.feeCostUsd, 0);
  assert.throws(() => normalizeVenueQuote({ amountIn: "1", amountOut: "1" }), /needs a venue/);
  assert.throws(() => normalizeVenueQuote({ venue: "x", amountIn: "0", amountOut: "1" }), /non-positive amountIn/);
});

test("routeAnalyzer: bestVenueQuote picks the max-rate venue; chosenVenueQuote matches by name or routeId", () => {
  const quotes = [
    { venue: "lifi", amountIn: "2500000000", amountOut: "2493955555" },
    { venue: "uniswap", amountIn: "2500000000", amountOut: "2495210000" },
  ];
  const best = bestVenueQuote(quotes);
  assert.equal(best.venue, "uniswap", "uniswap out-quotes lifi");
  assert.equal(chosenVenueQuote(quotes, "lifi").venue, "lifi");
  assert.equal(chosenVenueQuote(quotes, "uniswap").venue, "uniswap");
  assert.equal(chosenVenueQuote(quotes, "nonexistent"), null);
});

test("routeAnalyzer: per-leg delta math is exact at shared sizes (bps + $)", () => {
  const leg = analyzeLeg(usdcUsdtLeg);
  assert.equal(leg.venueChosen, "lifi");
  assert.equal(leg.venueBest, "uniswap");
  assert.equal(leg.singleVenue, false);
  assert.equal(leg.exact, true);
  // rates: lifi 2493955555/2500000000 vs uniswap 2495210000/2500000000
  // gapBps = (best − chosen) / best × 10000 (integer bps)
  const expectedBps = Number(((2495210000n - 2493955555n) * 10000n) / 2495210000n);
  assert.equal(leg.gapBps, Number(expectedBps));
  assert.ok(leg.gapBps >= 5 && leg.gapBps <= 6, `realistic eth signature ~5 bps (got ${leg.gapBps})`);
  // delta raw = 2495210000 − 2493955555 = 1254445 raw USDT; $ = × 1e-6
  assert.equal(leg.deltaOutRaw, "1254445");
  assert.equal(leg.gapUsd, 1.2544, "≈ $1.25 on the $2,500 leg");
  assert.equal(leg.netUsd, 1.2544, "no declared additive costs → cost delta 0, net = gap");
  assert.equal(leg.costDeltaUsd, 0);
  assert.equal(leg.costExact, true);
});

test("routeAnalyzer: cost deltas net against the gap (best venue pricier reduces capture; cheaper increases it)", () => {
  // The best venue (uniswap) declares an explicit additive gas cost; lifi
  // declares none → delta = costBest − costChosen = 0.09 − 0.
  const withCosts = analyzeLeg({
    ...usdcUsdtLeg,
    quotes: [
      { venue: "lifi", amountIn: "2500000000", amountOut: "2493955555" },
      { venue: "uniswap", amountIn: "2500000000", amountOut: "2495210000", gasCostUsd: 0.09, feeCostUsd: 0 },
    ],
  });
  assert.equal(withCosts.costDeltaUsd, 0.09);
  assert.equal(withCosts.netUsd, Math.round((1.254445 - 0.09) * 10000) / 10000);
  assert.equal(withCosts.costExact, false, "only one venue declared costs → flagged not exact");

  // Both declare: exact cost delta.
  const bothCosts = analyzeLeg({
    ...usdcUsdtLeg,
    quotes: [
      { venue: "lifi", amountIn: "2500000000", amountOut: "2493955555", gasCostUsd: 0.1, feeCostUsd: 0.01 },
      { venue: "uniswap", amountIn: "2500000000", amountOut: "2495210000", gasCostUsd: 0.09, feeCostUsd: 0 },
    ],
  });
  assert.equal(bothCosts.costExact, true);
  assert.equal(bothCosts.costDeltaUsd, -0.02, "best venue is cheaper → the delta ADDS to net");
  assert.equal(bothCosts.netUsd, Math.round((1.254445 + 0.02) * 10000) / 10000);
});

test("routeAnalyzer: rate-implied fallback when venue sizes differ (exact:false, never silent)", () => {
  const leg = analyzeLeg({
    hop: 1,
    from: "SOL",
    to: "USDC",
    chain: "sol",
    venueChosen: "orca",
    usdPerOutUnit: 1 / 1e6,
    quotes: [
      { venue: "orca", amountIn: "5000000000", amountOut: "99900000" }, // 5 SOL
      { venue: "jupiter", amountIn: "500000000", amountOut: "10020000" }, // 0.5 SOL (different size!)
    ],
  });
  assert.equal(leg.exact, false);
  assert.match(leg.exactNote, /rate-implied/);
  assert.ok(leg.gapBps !== null && leg.gapBps > 0, "rates still comparable");
});

test("routeAnalyzer: single-venue legs contribute 0 (gapBps null, no $, no net)", () => {
  const leg = analyzeLeg({
    hop: 2,
    from: "USDC",
    to: "USDC",
    chain: "eth",
    kind: "bridge",
    venueChosen: "lifi",
    usdPerOutUnit: 1 / 1e6,
    quotes: [{ venue: "lifi", pool: "lifi-eth-sol-USDC", amountIn: "2495210000", amountOut: "2489000000" }],
  });
  assert.equal(leg.singleVenue, true);
  assert.equal(leg.gapBps, null);
  assert.equal(leg.gapUsd, null);
  assert.equal(leg.netUsd, null);
  assert.equal(leg.venueBest, "lifi", "single venue is its own best");
});

test("routeAnalyzer: analyzeRoute accumulates per-leg nets across the journey and picks the optimal sub-path", () => {
  // 3-hop ape journey: eth swap (lifi routed, uniswap best — ~5 bps) →
  // bridge (single venue — 0) → Solana ape leg USDC→EXOTIC (cpmm routed,
  // jupiter best — wide).
  const route = {
    id: "test-ape",
    legs: [
      usdcUsdtLeg,
      {
        hop: 2,
        from: "USDC",
        to: "USDC",
        chain: "eth-sol",
        kind: "bridge",
        venueChosen: "lifi",
        usdPerOutUnit: 1 / 1e6,
        quotes: [{ venue: "lifi", amountIn: "2495210000", amountOut: "2489000000" }],
      },
      {
        hop: 3,
        from: "USDC",
        to: "EXOTIC",
        chain: "sol",
        kind: "swap",
        venueChosen: "raydium-cpmm",
        usdPerOutUnit: 1 / 5.15e11, // exotic ≈ $0.00194 (real pool rate) — value per raw unit
        quotes: [
          { venue: "jupiter", amountIn: "2489000000", amountOut: "1282515834808065" },
          { venue: "raydium-cpmm", amountIn: "2489000000", amountOut: "1280319724902352" },
        ],
      },
    ],
  };
  const a = analyzeRoute(route);
  assert.equal(a.routeId, "test-ape");
  assert.equal(a.legs.length, 3);
  assert.equal(a.wouldCapture, true);
  assert.equal(a.economical, true, "accumulated net clears the $0.10 / 1 bps bar");

  // leg 1 net ≈ $1.2544; leg 2 = 0 (single venue); leg 3 net = delta tokens × $/token
  const leg3DeltaUsd = Math.round(Number(1282515834808065n - 1280319724902352n) * (1 / 5.15e11) * 10000) / 10000;
  const expectedTotal = Math.round((1.2544 + leg3DeltaUsd) * 10000) / 10000;
  assert.equal(a.routeGapUsd, expectedTotal);
  assert.equal(a.routeNetUsd, expectedTotal);
  assert.equal(a.routeUsdPartial, false);
  const expectedBps = Math.round((a.routeGapUsd / notionalOf(route)) * 10000 * 10000) / 10000;
  assert.equal(a.routeGapBps, expectedBps, "dollar-weighted route bps = Σ gapUsd ÷ Σ routed output notional × 10000");
  assert.ok(a.routeGapBps > 1, `route bps ${a.routeGapBps} exceeds the 1 bps bar`);
  assert.deepEqual(a.optimalRoute, [
    { hop: 1, venue: "uniswap" },
    { hop: 2, venue: "lifi" },
    { hop: 3, venue: "jupiter" },
  ]);
  // leg records carry the per-hop breakdown
  assert.equal(a.legs[0].gapBps !== null && a.legs[0].gapUsd > 1, true);
  assert.equal(a.legs[1].gapBps, null);
  assert.ok(a.legs[2].gapBps > 5, `ape leg spread is wide (got ${a.legs[2].gapBps} bps)`);
});

function notionalOf(route) {
  let n = 0;
  for (const leg of route.legs) {
    if (leg.usdPerOutUnit == null) continue;
    const chosen = leg.quotes.find((q) => (q.venue || q.dex) === leg.venueChosen);
    if (chosen) n += Number(chosen.amountOut) * leg.usdPerOutUnit;
  }
  return n;
}

test("routeAnalyzer: an already-optimal route captures nothing (honest whyNot)", () => {
  const route = {
    id: "test-optimal",
    legs: [
      {
        hop: 1,
        from: "SOL",
        to: "USDC",
        chain: "sol",
        venueChosen: "jupiter", // already the best
        usdPerOutUnit: 1 / 1e6,
        quotes: [
          { venue: "jupiter", amountIn: "5000000000", amountOut: "102000000" },
          { venue: "orca", amountIn: "5000000000", amountOut: "101900000" },
        ],
      },
    ],
  };
  const a = analyzeRoute(route);
  assert.equal(a.wouldCapture, false);
  assert.match(a.whyNot, /already-optimal/);
  assert.equal(a.economical, false);
  assert.equal(a.routeNetUsd, 0);
});

test("routeAnalyzer: a single-venue route contributes 0 with the honest whyNot", () => {
  const a = analyzeRoute({
    id: "test-single",
    legs: [
      {
        hop: 1,
        from: "USDC",
        to: "USDC.x",
        chain: "eth-x1",
        venueChosen: "lifi",
        usdPerOutUnit: 1 / 1e6,
        quotes: [{ venue: "lifi", amountIn: "2500000000", amountOut: "2489000000" }],
      },
    ],
  });
  assert.equal(a.wouldCapture, false);
  assert.match(a.whyNot, /single-venue route/);
  assert.equal(a.routeNetUsd, null, "no leg carried a gap → no route $");
});

test("routeAnalyzer: below the economic bar → wouldCapture true (strict) but economical false", () => {
  // A tiny real gap: 0.3 bps — strict-positive net, but quote-rounding noise.
  const a = analyzeRoute({
    id: "test-noise",
    legs: [
      {
        hop: 1,
        from: "USDC",
        to: "USDT",
        chain: "eth",
        venueChosen: "lifi",
        usdPerOutUnit: 1 / 1e6,
        quotes: [
          { venue: "lifi", amountIn: "2500000000", amountOut: "2495000000" },
          { venue: "uniswap", amountIn: "2500000000", amountOut: "2495075000" }, // 0.3 bps better
        ],
      },
    ],
  });
  assert.equal(a.wouldCapture, true, "strict math: positive net");
  assert.equal(a.economical, false, `$${a.routeNetUsd} < $${ROUTE_EC_MIN_USD} or bps < ${ROUTE_EC_MIN_BPS} → not economically capturable`);
});

test("routeAnalyzer: usd-partial routes are flagged (per-leg bps complete, route $ partial)", () => {
  const a = analyzeRoute({
    id: "test-partial",
    legs: [
      {
        hop: 1,
        from: "USDC",
        to: "USDT",
        chain: "eth",
        venueChosen: "lifi",
        usdPerOutUnit: 1 / 1e6,
        quotes: [
          { venue: "lifi", amountIn: "2500000000", amountOut: "2493955555" },
          { venue: "uniswap", amountIn: "2500000000", amountOut: "2495210000" },
        ],
      },
      {
        hop: 2,
        from: "EXOTIC",
        to: "EXOTIC2",
        chain: "sol",
        venueChosen: "raydium-cpmm",
        usdPerOutUnit: null, // no real USD conversion for this leg
        quotes: [
          { venue: "jupiter", amountIn: "1000000000", amountOut: "500000000000" },
          { venue: "raydium-cpmm", amountIn: "1000000000", amountOut: "490000000000" },
        ],
      },
    ],
  });
  assert.equal(a.routeUsdPartial, true);
  assert.match(a.routeUsdPartialNote, /1 of 2 legs/);
  assert.equal(a.legs[1].gapBps !== null, true, "bps complete even without USD");
  assert.equal(a.legs[1].gapUsd, null);
  assert.equal(a.routeGapUsd, a.legs[0].gapUsd, "route $ covers the usd-carrying legs only");
});

test("routeAnalyzer: fail-closed on malformed input", () => {
  assert.throws(() => analyzeRoute(null), /route is required/);
  assert.throws(() => analyzeRoute({ legs: [] }), /needs legs/);
  assert.throws(() => analyzeRoute({ legs: [{ hop: 1, venueChosen: "x", quotes: [] }] }), /no venue quotes/);
  assert.throws(() => analyzeRoute({ legs: [{ hop: 1, quotes: [{ venue: "a", amountIn: "1", amountOut: "2" }] }] }), /needs venueChosen/);
  assert.throws(
    () =>
      analyzeRoute({
        legs: [
          {
            hop: 1,
            venueChosen: "ghost",
            quotes: [{ venue: "a", amountIn: "1", amountOut: "2" }],
          },
        ],
      }),
    /venueChosen "ghost" has no quote/,
  );
});

test("routeAnalyzer: summarizeRouteAnalyses aggregates the honest numbers", () => {
  const ok = analyzeRoute({
    id: "s1",
    legs: [
      {
        hop: 1,
        from: "USDC",
        to: "USDT",
        venueChosen: "lifi",
        usdPerOutUnit: 1 / 1e6,
        quotes: [
          { venue: "lifi", amountIn: "2500000000", amountOut: "2493955555" },
          { venue: "uniswap", amountIn: "2500000000", amountOut: "2495210000" },
        ],
      },
    ],
  });
  const noise = analyzeRoute({
    id: "s2",
    legs: [
      {
        hop: 1,
        from: "SOL",
        to: "USDC",
        venueChosen: "orca",
        usdPerOutUnit: 1 / 1e6,
        quotes: [
          { venue: "orca", amountIn: "5000000000", amountOut: "101950000" },
          { venue: "jupiter", amountIn: "5000000000", amountOut: "101951000" },
        ],
      },
    ],
  });
  const single = analyzeRoute({
    id: "s3",
    legs: [
      {
        hop: 1,
        from: "USDC",
        to: "USDC.x",
        venueChosen: "lifi",
        usdPerOutUnit: 1 / 1e6,
        quotes: [{ venue: "lifi", amountIn: "2500000000", amountOut: "2489000000" }],
      },
    ],
  });
  const s = summarizeRouteAnalyses([ok, noise, single]);
  assert.equal(s.total, 3);
  assert.equal(s.wouldCapture, 2, "ok + noise are strict-positive");
  assert.equal(s.economicallyCapturable, 1, "only ok clears the $0.10/1bps bar");
  assert.equal(s.singleVenue, 1);
  assert.equal(s.alreadyOptimal, 0);
  assert.equal(s.belowEconomicBar, 1, "noise is strict-positive but below the economic bar");
  assert.equal(s.costNotCleared, 0);
  assert.equal(s.legsAnalyzed, 3);
  assert.equal(s.legsWithVenueChoice, 2);
});
