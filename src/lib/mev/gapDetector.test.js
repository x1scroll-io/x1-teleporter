/**
 * gapDetector.test.js — the MEV capture engine's pure gap-math tests.
 *
 * Boundary cases (per the build spec): equal prices → no capture; tiny gap
 * → below threshold; big gap → wouldCapture. Plus the rate/exactness math,
 * the single-venue case, fee-policy configurability, and malformed input
 * (fail-closed). PURE/offline — no network, no fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectCaptureGap,
  rankQuotes,
  gapBpsBetween,
  normalizeQuote,
  rateQ,
  summarizeCaptureDetections,
  CAPTURE_FEE_POLICY_BPS,
  CAPTURE_FEE_POLICY_NOTE,
  RATE_SCALE,
} from "./gapDetector.js";

/** A helper quote: amountOut = amountIn × (1 − spreadBps/10000), i.e. a
 *  rate of (10000 − spreadBps)/10000 per unit at scale. */
const q = (dex, amountIn, ratePerUnitAtScale, pool = null) => ({
  dex,
  pool,
  amountIn: String(amountIn),
  amountOut: String((BigInt(amountIn) * BigInt(ratePerUnitAtScale)) / RATE_SCALE),
});

// The "perfect" rate 1.0000 → RATE_SCALE. A spread of N bps below perfect:
const RATE_AT = (bpsBelow) => RATE_SCALE - (RATE_SCALE * BigInt(bpsBelow)) / 10000n;

test("gapDetector: equal prices across venues → no capture (wouldCapture false)", () => {
  const det = detectCaptureGap({
    pair: { from: "USDC", to: "USDT" },
    chain: "eth",
    buyQuotes: [
      q("uniswap", 1_000_000, RATE_AT(1)), // 0.01% below perfect (fee 1bp)
      q("pancakeswap", 1_000_000, RATE_AT(1)),
    ],
    sellQuotes: [
      q("uniswap", 999_000, RATE_AT(1)),
      q("pancakeswap", 999_000, RATE_AT(1)),
    ],
  });
  assert.equal(det.wouldCapture, false);
  assert.equal(det.gapBps, 0, "identical rates → 0 bps gap");
  assert.match(det.whyNot, /no-arb|below-threshold/);
  assert.equal(det.route.length, 2);
});

test("gapDetector: tiny gap below the round-trip cost → no capture (below-threshold)", () => {
  // A REAL but tiny cross-venue round trip: buy side best is 1bp better than
  // the second venue, sell side best recovers a 1bp gross — but gas (10bps)
  // overwhelms it → below-threshold.
  const det = detectCaptureGap({
    pair: { from: "USDC", to: "USDT" },
    chain: "eth",
    buyQuotes: [
      { dex: "uniswap", amountIn: "1000000", amountOut: "999500" }, // 5bps below perfect
      { dex: "pancakeswap", amountIn: "1000000", amountOut: "999600" }, // best: 4bps below
    ],
    sellQuotes: [
      { dex: "uniswap", amountIn: "999600", amountOut: "1000100" }, // best: 1bp gross
      { dex: "pancakeswap", amountIn: "999600", amountOut: "999600" },
    ],
    gasCostQuoteUnits: 1000, // 10 bps of 1e6 — overwhelms the ~1bp gross
  });
  assert.equal(det.wouldCapture, false);
  assert.match(det.whyNot, /below-threshold/);
  assert.ok(det.grossRoundTripBps > 0, "there IS a gross arb — it is just too small");
  assert.ok(det.netRoundTripBps < 0, "net is negative after gas");
});

test("gapDetector: big gap exceeding the round-trip cost → wouldCapture with the atomic route", () => {
  // pancakeswap sells USDT ~10bps cheaper (buy side best), uniswap buys it
  // back ~10bps richer (sell side best): a genuine cross-venue round trip.
  const buyQuotes = [
    { dex: "uniswap", amountIn: "1000000", amountOut: "998900" }, // 0.11% fee-ish
    { dex: "pancakeswap", amountIn: "1000000", amountOut: "1001000" }, // 10bps better
  ];
  // sell side sized EXACTLY at the best buy output (1,001,000):
  const sellQuotes = [
    { dex: "uniswap", amountIn: "1001000", amountOut: "1002000" }, // recovers 10bps more
    { dex: "pancakeswap", amountIn: "1001000", amountOut: "1000000" },
  ];
  const det = detectCaptureGap({ pair: { from: "USDC", to: "USDT" }, chain: "eth", buyQuotes, sellQuotes, gasCostQuoteUnits: 0 });
  assert.equal(det.wouldCapture, true);
  assert.equal(det.exact, true, "sell quotes sized at the best buy output → exact");
  assert.equal(det.route[0], "pancakeswap", "buy on the cheap venue");
  assert.equal(det.route[1], "uniswap", "sell on the expensive venue");
  assert.ok(det.gapBps > 0);
  assert.ok(det.netRoundTripBps > 0);
  assert.ok(BigInt(det.netValueAfterCostsRaw) > 0n);
});

test("gapDetector: net math is exact when sell quotes are sized at the best buy output", () => {
  const buyQuotes = [
    { dex: "a", amountIn: "1000000", amountOut: "1000500" },
    { dex: "b", amountIn: "1000000", amountOut: "999500" },
  ];
  const sellQuotes = [
    { dex: "a", amountIn: "1000500", amountOut: "1001000" }, // exact size
    { dex: "b", amountIn: "1000500", amountOut: "999000" },
  ];
  const det = detectCaptureGap({ buyQuotes, sellQuotes });
  assert.equal(det.exact, true);
  // gross = 1,001,000 − 1,000,000 = 1,000 (10 bps); net = same (no gas).
  assert.equal(det.grossValueRaw, "1000");
  assert.equal(det.grossRoundTripBps, 10);
  assert.equal(det.netValueAfterCostsRaw, "1000");
  assert.equal(det.netRoundTripBps, 10);
  assert.equal(det.wouldCapture, true);
});

test("gapDetector: rate-implied (non-exact) sell sizing is flagged, never silent", () => {
  const det = detectCaptureGap({
    buyQuotes: [{ dex: "a", amountIn: "1000000", amountOut: "1000500" }],
    sellQuotes: [{ dex: "b", amountIn: "777000", amountOut: "777500" }], // wrong size
  });
  assert.equal(det.exact, false);
  assert.match(det.exactNote, /rate-implied/);
});

test("gapDetector: gas in quote units reduces the net (and can kill a marginal capture)", () => {
  const buyQuotes = [{ dex: "a", amountIn: "1000000", amountOut: "1000500" }];
  const sellQuotes = [{ dex: "b", amountIn: "1000500", amountOut: "1001000" }];
  const noGas = detectCaptureGap({ buyQuotes, sellQuotes });
  const withGas = detectCaptureGap({ buyQuotes, sellQuotes, gasCostQuoteUnits: "2000" });
  assert.equal(noGas.wouldCapture, true);
  assert.equal(withGas.wouldCapture, false, "20bps of gas exceeds the 10bps gross");
  assert.equal(withGas.costBps.gasBps, 20);
  assert.equal(withGas.costBps.totalBps, 20);
  assert.equal(noGas.costBps.gasBps, 0);
});

test("gapDetector: single-venue (no second route) → no capture, gapBps null, honest whyNot", () => {
  const det = detectCaptureGap({
    buyQuotes: [{ dex: "orca", amountIn: "1000000000", amountOut: "130000000" }],
    sellQuotes: [{ dex: "orca", amountIn: "130000000", amountOut: "999000000" }],
  });
  assert.equal(det.wouldCapture, false);
  assert.equal(det.gapBps, null);
  assert.match(det.whyNot, /single-route/);
});

test("gapDetector: duplicate quotes of the same route cannot crowd the ranking", () => {
  const { best, second } = rankQuotes([
    { dex: "uniswap", amountIn: "1000000", amountOut: "999000" },
    { dex: "uniswap", amountIn: "1000000", amountOut: "999100" }, // same dex, better — should win
    { dex: "pancakeswap", amountIn: "1000000", amountOut: "998000" },
  ]);
  assert.equal(best.dex, "uniswap");
  assert.equal(best.amountOut, BigInt("999100"));
  assert.equal(second.dex, "pancakeswap");
});

test("gapDetector: pool-tagged quotes rank as distinct routes on the same dex", () => {
  const { best, second } = rankQuotes([
    { dex: "uniswap", pool: "f100", amountIn: "1000000", amountOut: "999000" },
    { dex: "uniswap", pool: "f500", amountIn: "1000000", amountOut: "998500" },
  ]);
  assert.equal(best.pool, "f100");
  assert.equal(second.pool, "f500");
  assert.equal(gapBpsBetween(best, second), 5, "(9990 − 9985) / 9990 ≈ 5 bps");
});

test("gapDetector: CAPTURE_FEE_POLICY_BPS defaults to 0 (the ruling) and is adjustable per call", () => {
  assert.equal(CAPTURE_FEE_POLICY_BPS, 0);
  assert.match(CAPTURE_FEE_POLICY_NOTE, /protocol IS the taker/);
  const buyQuotes = [{ dex: "a", amountIn: "1000000", amountOut: "1001000" }];
  const sellQuotes = [{ dex: "b", amountIn: "1001000", amountOut: "1002000" }];
  const free = detectCaptureGap({ buyQuotes, sellQuotes });
  const taxed = detectCaptureGap({ buyQuotes, sellQuotes, protocolFeeBps: 20 }); // 0.2% policy
  assert.equal(free.wouldCapture, true);
  assert.equal(taxed.costBps.protocolFeeBps, 20);
  assert.ok(taxed.netValueAfterCostsRaw < free.netValueAfterCostsRaw, "a capture fee policy reduces the net");
  assert.equal(taxed.wouldCapture, false, "20bps policy fee on the ~20bps gross return → net negative");
});

test("gapDetector: malformed quotes fail closed (never a silent detection)", () => {
  assert.throws(() => detectCaptureGap({ buyQuotes: [], sellQuotes: [] }), /buyQuotes are required/);
  assert.throws(() => detectCaptureGap({ buyQuotes: [{ dex: "a", amountIn: "1", amountOut: "2" }], sellQuotes: [] }), /sellQuotes are required/);
  assert.throws(() => detectCaptureGap({ buyQuotes: [{ amountIn: "1", amountOut: "2" }], sellQuotes: [{ dex: "b", amountIn: "1", amountOut: "2" }] }), /dex name/);
  assert.throws(() => detectCaptureGap({ buyQuotes: [{ dex: "a", amountIn: "0", amountOut: "2" }], sellQuotes: [{ dex: "b", amountIn: "1", amountOut: "2" }] }), /non-positive amountIn/);
  assert.throws(() => detectCaptureGap({ buyQuotes: [{ dex: "a", amountIn: "1", amountOut: "2" }], sellQuotes: [{ dex: "b", amountIn: "1", amountOut: "2" }], gasCostQuoteUnits: "-5" }), /cannot be negative/);
  assert.throws(() => normalizeQuote(null), /must be an object/);
});

test("gapDetector: summarizeCaptureDetections reports the honest distribution", () => {
  const mk = (gapBps) => ({
    wouldCapture: gapBps >= 20,
    gapBps: gapBps >= 0 ? gapBps : null,
    netRoundTripBps: gapBps >= 20 ? gapBps - 5 : gapBps - 30,
  });
  const dets = [mk(0), mk(2), mk(10), mk(25), mk(60), { wouldCapture: false, gapBps: null, netRoundTripBps: -2 }];
  const s = summarizeCaptureDetections(dets);
  assert.equal(s.total, 6);
  assert.equal(s.wouldCapture, 2);
  assert.equal(s.tooSmall, 3, "0/2/10 bps gaps were too small");
  assert.equal(s.singleRoute, 1);
  assert.equal(s.gapBps.max, 60);
  assert.equal(s.gapBps.distribution["20+bps"], 2);
});

test("gapDetector: rateQ is BigInt-exact at RATE_SCALE", () => {
  assert.equal(rateQ({ dex: "a", amountIn: "1000000", amountOut: "1000000" }), RATE_SCALE);
  assert.equal(rateQ({ dex: "a", amountIn: "1000000", amountOut: "999000" }), RATE_SCALE - RATE_SCALE / 1000n);
});
