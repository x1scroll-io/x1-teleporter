/**
 * mevMultihop.test.js — the MULTI-HOP route-choice capture ENGINE tests
 * (routing-layer wiring + the dead-gated journey constructor + the
 * analyze→optimal→compose round trip).
 *
 * Spec coverage:
 *   • observeRouteCapture (the multi-hop routing hook): runs the route
 *     analyzer over a planned multi-hop route's per-leg venue quotes and
 *     reports "route capture opportunity: X bps across N hops (gated OFF)",
 *   • planCaptureRouteJourney: folds composeRoute over an ordered list of
 *     the repo's OWN planned routes (one per hop — the optimal sub-path's
 *     legs); the route carries the capture gate (false) and is dead-gated
 *     (the composed legs' submit() throws DexDirectLiveTestGateError /
 *     the existing live-test gates), atomic:false with the honest note,
 *   • the FULL round trip: analyze a multi-hop route over REAL fixture
 *     quotes → select the optimal sub-path → construct the capture journey
 *     from existing planner routes → assert the composed legs ARE the
 *     optimal venues' legs.
 *
 * Pure/offline (frozen fixtures + planner routes — no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RoutePlanner } from "../src/engine/index.js";
import { DexDirectLiveTestGateError } from "../src/engine/legs/dexDirect/liveTestGate.js";
import { analyzeRoute } from "../src/lib/mev/routeAnalyzer.js";
import { solInput } from "./golden/dexDirectBuilders.mjs";

// The REAL Solana captures (2026-09-05, frozen) — the SOL→USDC leg's venue
// quotes (orca + raydium CLMM + the aggregator) at the same size.
function solUsdcLegQuotes() {
  const orcaSnap = solInput("orca");
  const rdSnap = solInput("raydiumClmm");
  const amountIn = orcaSnap.sample.amountInRaw; // 0.1 SOL raw — the leg size
  return [
    {
      venue: "orca",
      pool: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
      amountIn,
      amountOut: orcaSnap.quote.amountOut,
      source: "REAL-live-capture-2026-09-05",
    },
    {
      venue: "raydium",
      pool: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv",
      amountIn,
      amountOut: rdSnap.quote.amountOutRaw,
      source: "REAL-live-capture-2026-09-05",
    },
  ];
}

test("mev-multihop: observeRouteCapture runs the analyzer over a multi-hop route and reports (gated OFF)", () => {
  const { analysis, gate, report } = RoutePlanner.observeRouteCapture({
    id: "route-sol-ape-test",
    legs: [
      {
        hop: 1,
        from: "SOL",
        to: "USDC",
        chain: "sol",
        kind: "swap",
        venueChosen: "orca",
        usdPerOutUnit: 1 / 1e6,
        quotes: solUsdcLegQuotes(),
      },
    ],
  });
  assert.equal(analysis.kind, "route-capture-analysis");
  assert.equal(analysis.routeId, "route-sol-ape-test");
  assert.equal(gate.enabled, false, "MEV_CAPTURE_ENABLED=false under node (the repo default)");
  assert.equal(gate.executable, false);
  assert.equal(gate.label, "gated OFF");
  assert.match(report, /gated OFF/);
  assert.ok(Array.isArray(analysis.optimalRoute));
});

test("mev-multihop: planCaptureRouteJourney folds composeRoute over the repo's OWN planned routes", () => {
  // The optimal sub-path of a 3-hop ape journey, constructed from existing
  // planner routes: leg1 = eth USDC→USDT swap via the uniswap dexDirect
  // route; leg2 = the LiFi EVM swap route (single venue — the bridge shape);
  // leg3 = the Solana USDC→EXOTIC swap via the raydium dexDirect route.
  const legRoutes = [
    RoutePlanner.planDexDirect({ dex: "uniswap", chain: "eth" }),
    RoutePlanner.planLifiEvmSwap({ chain: "eth" }),
    RoutePlanner.planDexDirect({ dex: "raydium", chain: "sol" }),
  ];
  const journey = RoutePlanner.planCaptureRouteJourney({ legRoutes, id: "capture-journey-test", optimal: true });
  assert.equal(journey.id, "capture-journey-test");
  assert.equal(journey.direction, "swap");
  assert.deepEqual(journey.legs.map((l) => l.id), ["uniswap-swap", "lifi-evm-swap", "raydium-swap"], "the ACTUAL engine legs, in hop order");
  assert.equal(journey.composedOf.length, 3, "composeRoute records every source route");
  assert.equal(Object.keys(journey.stages).length, 3, "every source route's stages survive the fold (composeRoute contract)");
  assert.equal(journey.capture.kind, "multi-hop-route-choice");
  assert.equal(journey.capture.atomic, false, "a journey is NOT an atomic same-block pair");
  assert.match(journey.capture.atomicNote, /NOT a same-block round trip/);
  assert.equal(journey.capture.legCount, 3);
  assert.equal(journey.capture.optimal, true, "annotation: the leg routes are the analyzer's optimal sub-path");
  assert.equal(journey.capture.gate.enabled, false);
  assert.equal(journey.capture.gate.executable, false);
  for (const leg of journey.legs) {
    assert.equal(typeof leg.phases.build, "function");
    // Every leg that HAS a submit phase is one of the repo's guarded legs
    // (asserted gated in the next test); quote/construction legs (e.g.
    // lifi-evm-swap — LiFi's live lane submits through the engine's own
    // executor) carry build only.
    assert.ok(typeof leg.phases.submit === "function" || leg.phases.submit === undefined, `${leg.id} submit is a function or absent`);
  }
});

test("mev-multihop: the capture journey is DEAD-GATED — every leg's submit throws the live-test gate", async () => {
  const journey = RoutePlanner.planCaptureRouteJourney({
    legRoutes: [
      RoutePlanner.planDexDirect({ dex: "orca", chain: "sol" }),
      RoutePlanner.planDexDirect({ dex: "raydium", chain: "sol" }),
    ],
  });
  assert.equal(journey.capture.gate.label, "gated OFF");
  for (const leg of journey.legs) {
    await assert.rejects(
      leg.phases.submit(),
      (e) => e instanceof DexDirectLiveTestGateError,
      `${leg.id} submit must be gated`,
    );
  }
});

test("mev-multihop: planCaptureRouteJourney rejects bad input (fail-closed)", () => {
  assert.throws(() => RoutePlanner.planCaptureRouteJourney({}), /legRoutes are required/);
  assert.throws(() => RoutePlanner.planCaptureRouteJourney({ legRoutes: [RoutePlanner.planJupiterSwap()] }), /≥2 planned routes/);
  assert.throws(() => RoutePlanner.planCaptureRouteJourney({ legRoutes: [{ legs: [] }, { legs: [] }] }), /planned route with legs/);
});

test("mev-multihop: the FULL round trip — analyze a real-fixture route, take the optimal sub-path, compose it from existing planner routes", () => {
  // 1. Analyze a 2-hop route over REAL frozen quotes: SOL→USDC (orca routed,
  //    real orca + raydium quotes) then USDC→EXOTIC (raydium-cpmm routed,
  //    jupiter better — real signature of the 2026-09-06 ape capture).
  const analysis = analyzeRoute({
    id: "route-full-roundtrip",
    legs: [
      {
        hop: 1,
        from: "SOL",
        to: "USDC",
        chain: "sol",
        kind: "swap",
        venueChosen: "orca",
        usdPerOutUnit: 1 / 1e6,
        quotes: solUsdcLegQuotes(),
      },
      {
        hop: 2,
        from: "USDC",
        to: "EXOTIC",
        chain: "sol",
        kind: "swap",
        venueChosen: "raydium-cpmm",
        usdPerOutUnit: 1 / 5.15e11,
        quotes: [
          { venue: "jupiter", amountIn: "100000000", amountOut: "51694744030872", source: "REAL-live-2026-09-06" },
          { venue: "raydium-cpmm", amountIn: "100000000", amountOut: "51668699362575", source: "REAL-live-2026-09-06" },
        ],
      },
    ],
  });
  assert.ok(analysis.legs.some((l) => !l.singleVenue), "the route has venue choice");
  const opt = new Map(analysis.optimalRoute.map((o) => [o.hop, o.venue]));

  // 2. Construct the optimal sub-path from the repo's OWN planner routes.
  const byVenue = {
    jupiter: RoutePlanner.planJupiterSwap(),
    orca: RoutePlanner.planDexDirect({ dex: "orca", chain: "sol" }),
    raydium: RoutePlanner.planDexDirect({ dex: "raydium", chain: "sol" }),
    "raydium-cpmm": RoutePlanner.planDexDirect({ dex: "raydium", chain: "sol" }),
  };
  const legRoutes = analysis.legs.map((l) => {
    const venue = opt.get(l.hop);
    const route = byVenue[venue] || byVenue[l.venueChosen];
    assert.ok(route, `hop ${l.hop}: a planner route exists for optimal venue ${venue}`);
    return route;
  });
  const journey = RoutePlanner.planCaptureRouteJourney({ legRoutes, id: "capture-journey-optimal", optimal: true });

  // 3. The composed legs ARE the optimal venues' legs (the engine's real
  //    swap legs — no hand-rolled calldata).
  const expectedLegIds = analysis.optimalRoute.map((o) => {
    if (o.venue === "jupiter") return "jupiter-swap";
    if (o.venue === "orca") return "orca-swap";
    return "raydium-swap";
  });
  assert.deepEqual(journey.legs.map((l) => l.id), expectedLegIds);
  assert.equal(journey.capture.gate.enabled, false);
});

test("mev-multihop: engine facade re-exports the multi-hop capture surface", () => {
  assert.equal(typeof RoutePlanner.observeRouteCapture, "function");
  assert.equal(typeof RoutePlanner.planCaptureRouteJourney, "function");
  assert.equal(typeof RoutePlanner.observeCaptureForSwap, "function", "the single-pair hook is untouched");
  assert.equal(typeof RoutePlanner.planCaptureSwapPair, "function", "the single-pair constructor is untouched");
  assert.equal(RoutePlanner.plan({ direction: "forward" }).id, "forward-eth-x1", "default routing unchanged");
});
