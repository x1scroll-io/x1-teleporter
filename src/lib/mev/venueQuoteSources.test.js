/**
 * venueQuoteSources.test.js — the NEAR + TON per-venue quote-source wiring
 * (Phase F): the venue quote PRODUCERS feed the chain-agnostic capture
 * detector. DI-clean — fake producers injected, no network, no broadcast.
 *
 * Spec coverage:
 *   • captureVenuesForChain — the near (ref-finance/jumbo) + ton
 *     (stonfi/dedust) same-chain venue sets,
 *   • normalizeVenueQuoteForDetector — producer shape (amountInRaw/
 *     amountOutRaw) → detector shape (amountIn/amountOut); fail-closed on
 *     malformed/missing amounts,
 *   • collectVenueQuotes — gather per-venue quotes via injected producers,
 *     skip null/throwing producers (fail-closed), keep venue order,
 *   • observeVenueCaptureForSwap — same-pair round trip: near + ton venue
 *     quotes feed gapDetector (wouldCapture, exact sell-leg sizing), gated
 *     OFF report,
 *   • observeVenueRouteCapture — multi-hop: per-leg venue quotes feed
 *     routeAnalyzer (accumulated route delta), skipped legs surfaced,
 *   • the real producer adapters (refQuoteProducer / stonfiQuoteProducer)
 *     wire the actual producers with injected fakes — no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NEAR_CAPTURE_VENUES,
  TON_CAPTURE_VENUES,
  CAPTURE_VENUES_BY_CHAIN,
  captureVenuesForChain,
  normalizeVenueQuoteForDetector,
  collectVenueQuotes,
  observeVenueCaptureForSwap,
  observeVenueRouteCapture,
  refQuoteProducer,
  stonfiQuoteProducer,
  defaultVenueProducers,
} from "./venueQuoteSources.js";

const NEAR_IN = { id: "wrap.near", symbol: "wNEAR" };
const NEAR_OUT = { id: "usdc.near", symbol: "USDC" };
const TON_IN = { id: "EQjvNEARin", symbol: "TON" };
const TON_OUT = { id: "EQusdcOUT", symbol: "USDC" };

/** NEAR producers: ref (1:1 both ways) + jumbo (worse on buy, better on sell). */
const nearProducers = {
  "ref-finance": async ({ amountInRaw }) => ({ venue: "ref-finance", chain: "near", amountInRaw, amountOutRaw: amountInRaw, pool: "1" }),
  jumbo: async ({ tokenOut, amountInRaw }) => ({
    venue: "jumbo",
    chain: "near",
    amountInRaw,
    amountOutRaw: tokenOut?.id === NEAR_OUT.id ? (BigInt(amountInRaw) * 9n) / 10n + "" : (BigInt(amountInRaw) * 12n) / 10n + "",
    pool: "2",
  }),
};

/** TON producers: stonfi (1:1 both ways) + dedust (worse on buy, better on sell). */
const tonProducers = {
  stonfi: async ({ amountInRaw }) => ({ venue: "stonfi", chain: "ton", amountInRaw, amountOutRaw: amountInRaw }),
  dedust: async ({ tokenOut, amountInRaw }) => ({
    venue: "dedust",
    chain: "ton",
    amountInRaw,
    amountOutRaw: tokenOut?.id === TON_OUT.id ? (BigInt(amountInRaw) * 9n) / 10n + "" : (BigInt(amountInRaw) * 12n) / 10n + "",
  }),
};

test("venue sources: the near/ton same-chain capture venue sets are declared", () => {
  assert.deepEqual([...NEAR_CAPTURE_VENUES], ["ref-finance", "jumbo"]);
  assert.deepEqual([...TON_CAPTURE_VENUES], ["stonfi", "dedust"]);
  assert.equal(CAPTURE_VENUES_BY_CHAIN.near, NEAR_CAPTURE_VENUES);
  assert.equal(CAPTURE_VENUES_BY_CHAIN.ton, TON_CAPTURE_VENUES);
  assert.deepEqual(captureVenuesForChain("near"), ["ref-finance", "jumbo"]);
  assert.deepEqual(captureVenuesForChain("ton"), ["stonfi", "dedust"]);
  assert.deepEqual(captureVenuesForChain("sol"), [], "unknown chains have no native capture venue set here");
  // the returned list is a copy (no mutation of the frozen set)
  const list = captureVenuesForChain("near");
  list.push("evil");
  assert.deepEqual([...NEAR_CAPTURE_VENUES], ["ref-finance", "jumbo"]);
});

test("venue sources: normalizeVenueQuoteForDetector maps producer shape → detector shape (fail-closed)", () => {
  const q = normalizeVenueQuoteForDetector({ venue: "ref-finance", chain: "near", amountInRaw: "1000", amountOutRaw: "990", pool: "p1", source: "ref-indexer" });
  assert.deepEqual(q, { dex: "ref-finance", pool: "p1", amountIn: "1000", amountOut: "990", chain: "near", source: "ref-indexer" });
  // already detector-shaped (amountIn/amountOut) is accepted too
  assert.equal(normalizeVenueQuoteForDetector({ dex: "jumbo", amountIn: "5", amountOut: "4" }).dex, "jumbo");
  // venue fallback from the caller
  assert.equal(normalizeVenueQuoteForDetector({ amountInRaw: "5", amountOutRaw: "4" }, { venue: "jumbo" }).dex, "jumbo");
  // fail-closed cases
  assert.equal(normalizeVenueQuoteForDetector(null), null);
  assert.equal(normalizeVenueQuoteForDetector({ amountInRaw: "5" }), null, "missing amountOut");
  assert.equal(normalizeVenueQuoteForDetector({ amountInRaw: "5", amountOutRaw: "4" }), null, "no venue/dex and no fallback");
  assert.equal(normalizeVenueQuoteForDetector({ amountInRaw: "abc", amountOutRaw: "4" }, { venue: "x" }), null, "non-integer");
  assert.equal(normalizeVenueQuoteForDetector({ amountInRaw: "0", amountOutRaw: "4" }, { venue: "x" }), null, "non-positive amountIn");
  assert.equal(normalizeVenueQuoteForDetector({ amountInRaw: "5", amountOutRaw: "-1" }, { venue: "x" }), null, "negative amountOut");
});

test("venue sources: collectVenueQuotes gathers via injected producers, skipping null/throw (fail-closed)", async () => {
  const producers = {
    "ref-finance": async ({ amountInRaw }) => ({ venue: "ref-finance", amountInRaw, amountOutRaw: "100" }),
    jumbo: async () => null, // honest missing venue
    dead: async () => { throw new Error("rpc down"); },
  };
  const quotes = await collectVenueQuotes({ chain: "near", venues: ["ref-finance", "jumbo"], tokenIn: NEAR_IN, tokenOut: NEAR_OUT, amountInRaw: "100", producers });
  assert.equal(quotes.length, 1, "only the live venue survives");
  assert.equal(quotes[0].dex, "ref-finance");
  // no producers at all → empty set (never a throw)
  assert.deepEqual(await collectVenueQuotes({ chain: "ton", amountInRaw: "1", producers: {} }), []);
});

test("venue sources: near venue quotes feed gapDetector (same-pair round trip, exact)", async () => {
  const scan = await observeVenueCaptureForSwap({
    chain: "near",
    pair: { from: "wNEAR", to: "USDC" },
    tokenIn: NEAR_IN,
    tokenOut: NEAR_OUT,
    amountInRaw: "1000000",
    producers: nearProducers,
  });
  assert.ok(scan, "the scan runs when venues quote");
  assert.equal(scan.detection.chain, "near");
  assert.equal(scan.detection.wouldCapture, true);
  assert.equal(scan.detection.exact, true, "the sell leg is sized at the best buy output");
  assert.equal(scan.detection.route.length, 2);
  assert.ok(scan.detection.gapBps > 0);
  assert.equal(scan.gate.label, "gated OFF");
  assert.match(scan.report, /gated OFF/);
  // the scan carries the NEAR drop-as-is payout annotation shape (null here —
  // no NEAR treasury address is configured by default; fail-closed)
  assert.equal(scan.payout, null);
});

test("venue sources: ton venue quotes feed gapDetector (same-pair round trip)", async () => {
  const scan = await observeVenueCaptureForSwap({
    chain: "ton",
    pair: { from: "TON", to: "USDC" },
    tokenIn: TON_IN,
    tokenOut: TON_OUT,
    amountInRaw: "1000000",
    producers: tonProducers,
  });
  assert.ok(scan);
  assert.equal(scan.detection.chain, "ton");
  assert.equal(scan.detection.wouldCapture, true);
  assert.equal(scan.gate.label, "gated OFF");
});

test("venue sources: no venue quote → no scan (never a throw)", async () => {
  assert.equal(await observeVenueCaptureForSwap({ chain: "near", tokenIn: NEAR_IN, tokenOut: NEAR_OUT, amountInRaw: "1", producers: {} }), null);
  assert.equal(await observeVenueCaptureForSwap({ chain: "near", amountInRaw: "1", producers: { "ref-finance": async () => null } }), null);
});

test("venue sources: near venue quotes feed routeAnalyzer (multi-hop per-leg deltas)", async () => {
  const route = {
    id: "near-ape-hop",
    legs: [
      {
        hop: 1,
        from: "USDC",
        to: "EXOTIC",
        chain: "near",
        venueChosen: "jumbo",
        tokenIn: NEAR_IN,
        tokenOut: NEAR_OUT,
        amountInRaw: "100000000",
        usdPerOutUnit: 1 / 1e6,
      },
    ],
  };
  const scan = await observeVenueRouteCapture({ route, producers: nearProducers });
  assert.ok(scan);
  assert.equal(scan.analysis.kind, "route-capture-analysis");
  assert.equal(scan.analysis.wouldCapture, true);
  assert.equal(scan.analysis.legs.length, 1);
  assert.equal(scan.analysis.legs[0].venueBest, "ref-finance");
  assert.equal(scan.analysis.legs[0].venueChosen, "jumbo");
  assert.ok(scan.analysis.legs[0].gapBps > 0);
  assert.equal(scan.gate.label, "gated OFF");
  assert.match(scan.report, /gated OFF/);
});

test("venue sources: route capture skips legs whose routed venue produced no quote (surfaced, never silent)", async () => {
  const route = {
    id: "near-mixed",
    legs: [
      { hop: 1, from: "A", to: "B", chain: "near", venueChosen: "ghost", tokenIn: NEAR_IN, tokenOut: NEAR_OUT, amountInRaw: "1000" },
      { hop: 2, from: "B", to: "C", chain: "ton", venueChosen: "stonfi", tokenIn: TON_IN, tokenOut: TON_OUT, amountInRaw: "1000" },
    ],
  };
  const scan = await observeVenueRouteCapture({ route, producers: { ...nearProducers, ...tonProducers } });
  assert.ok(scan);
  assert.equal(scan.analysis.legs.length, 1, "only the quotable leg is analyzed");
  assert.ok(Array.isArray(scan.skipped) && scan.skipped.some((s) => s.hop === 1 && /ghost/.test(s.reason)));
  assert.equal(await observeVenueRouteCapture({ route: { id: "none", legs: [{ hop: 1, chain: "near", venueChosen: "x" }] }, producers: {} }), null);
});

test("venue sources: the real producer adapters wire refQuote/stonfiQuote with injected fakes (no network)", async () => {
  // refQuoteProducer → real refQuote, SDK estimate + pools injected
  const refProducer = (args) =>
    refQuoteProducer({ ...args, pools: [{ id: 5 }], estimateSwap: async () => [{ estimate: "777", pool: { id: 5 } }] });
  const nearQuotes = await collectVenueQuotes({
    chain: "near",
    venues: ["ref-finance"],
    tokenIn: NEAR_IN,
    tokenOut: NEAR_OUT,
    amountInRaw: "1000",
    producers: { "ref-finance": refProducer },
  });
  assert.equal(nearQuotes.length, 1);
  assert.equal(nearQuotes[0].dex, "ref-finance");
  assert.equal(nearQuotes[0].amountIn, "1000");
  assert.equal(nearQuotes[0].amountOut, "777");

  // stonfiQuoteProducer → real stonfiQuote, estimate injected
  const tonProducer = (args) => stonfiQuoteProducer({ ...args, estimateImpl: async () => ({ jettonToReceive: 55n }) });
  const tonQuotes = await collectVenueQuotes({
    chain: "ton",
    venues: ["stonfi"],
    tokenIn: TON_IN,
    tokenOut: TON_OUT,
    amountInRaw: "10",
    producers: { stonfi: tonProducer },
  });
  assert.equal(tonQuotes.length, 1);
  assert.equal(tonQuotes[0].dex, "stonfi");
  assert.equal(tonQuotes[0].amountOut, "55");
});

test("venue sources: defaultVenueProducers exposes the built producers keyed by venue (injection points)", async () => {
  const producers = defaultVenueProducers({
    refQuoteImpl: async () => ({ venue: "ref-finance", amountInRaw: "100", amountOutRaw: "90" }),
    stonfiQuoteImpl: async () => ({ venue: "stonfi", amountInRaw: "100", amountOutRaw: "80" }),
  });
  assert.deepEqual(Object.keys(producers).sort(), ["ref-finance", "stonfi"]);
  const quotes = await collectVenueQuotes({ chain: "near", venues: ["ref-finance"], tokenIn: NEAR_IN, tokenOut: NEAR_OUT, amountInRaw: "100", producers });
  assert.equal(quotes[0].amountOut, "90");
  const tq = await collectVenueQuotes({ chain: "ton", venues: ["stonfi"], tokenIn: TON_IN, tokenOut: TON_OUT, amountInRaw: "100", producers });
  assert.equal(tq[0].amountOut, "80");
});
