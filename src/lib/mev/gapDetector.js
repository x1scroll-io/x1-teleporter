/**
 * gapDetector.js — the PRICE-GAP CAPTURE DETECTOR (pure).
 *
 * The MEV/price-gap capture engine's core math. Mr. Esters' concept: when
 * the routing engine sees the SAME token pair quoted on MULTIPLE DEXes on
 * the SAME chain (Uniswap vs PancakeSwap on an EVM chain, Raydium vs Orca
 * on Solana), a price difference between the venues is capturable value —
 * buy on the cheap venue, sell on the expensive venue, in one atomic
 * same-chain round trip. The protocol keeps 100% of that value, silently,
 * in the background, DURING a user's routing pass (the quotes are already
 * on the wire — the detector just reads them).
 *
 * 🔴 WHAT THIS MODULE IS: pure, deterministic gap MATH over quote objects.
 * It imports nothing, touches no network, constructs no transactions and
 * NEVER returns an executable trade. It returns a DETECTION:
 *   { pair, chain, gapBps, grossValue, netValueAfterCosts, wouldCapture,
 *     route: [cheapDex, expensiveDex] }.
 * The gate (captureGate.js), the routing hook (routePlanner.js) and the
 * simulation harness (tools/simulate-mev-capture.mjs) are separate layers.
 *
 * ── THE FEE RULING (documented — adjustable via CAPTURE_FEE_POLICY_BPS) ──
 * Mr. Esters: "protocol keeps 100%, silent." The fee-model-v2 charge
 * (0.5% capped $250 once-per-journey — src/lib/fees.ts) applies to USER
 * journeys. An internal capture leg is NOT a user journey — the protocol IS
 * the taker, so the 0.5% journey fee does NOT apply to capture legs
 * (charging ourselves and then reporting the remainder would be theater).
 * Capture value = gross round trip − the pool fees BOTH legs already paid
 * (netted inside the quotes — NOT double counted, see below) − gas.
 * The policy is a CONFIG CONSTANT (CAPTURE_FEE_POLICY_BPS, default 0) so
 * the ruling is adjustable in one place if Mr. Esters ever wants capture
 * legs to pay a fee to the same accounting the user journeys pay.
 *
 * ── POOL FEES ARE ALREADY INSIDE THE QUOTES (why they are not subtracted
 *    a second time) ────────────────────────────────────────────────────────
 * Every quote this engine uses is a NET quote:
 *   - EVM: the QuoterV2 / PancakeSwap QuoterV2 eth_call response is the
 *     amountOut AFTER the pool fee (the quoter simulates the fee-inclusive
 *     swap).
 *   - Solana: whirlpoolQuote / raydiumClmmQuote walk the pool state and
 *     return amountOut net of the LP fee (feeAmount reported separately).
 * So when the detector computes sellOut − buyIn, both pool fees are ALREADY
 * reflected in the numbers. The threshold language "swap fees on both legs
 * + gas" is honored by construction: a round trip only nets positive when
 * the price gap exceeds the fees both legs paid + gas. Each quote may carry
 * its pool fee rate (`feeBps`) as CONTEXT (the report lists it); the net
 * math does not subtract it again (that would double count).
 *
 * ── THE ROUND TRIP (atomic shape) ─────────────────────────────────────────
 * For pair X→Y with a starting amount X0 of X:
 *   1. BUY leg — swap X0 → Y on every candidate venue; the venue returning
 *      the most Y per X is the cheap venue (Y is cheapest there). bestBuy.
 *   2. SELL leg — swap the bestBuy output Y1 → X on every candidate venue;
 *      the venue returning the most X per Y is the expensive venue (Y is
 *      most expensive there). bestSell.
 *   3. grossReturn = bestSell.amountOut (X units). The capture is
 *      grossReturn − X0 (X units), positive only when the venues disagree
 *      enough to beat the two pool fees + gas.
 * The pure detector takes the two quote sets as inputs. The CALLER
 * (harness / routing layer) is responsible for fetching the sell quotes at
 * amountIn = bestBuy.amountOut (the exact round-trip size); when it does,
 * `exact: true` and the net math is exact. When the sell quotes were sized
 * differently the detector falls back to rate-implied math and flags
 * `exact: false` (honest — never silently exact).
 *
 * All amounts are RAW base units (integer strings / BigInt-compatible).
 * Rates are computed as BigInt ratios at 1e12 scale, so bps math is exact
 * integer arithmetic (no floating point on money paths).
 */

/** The CAPTURE FEE POLICY — bps the capture leg pays to the Teleporter fee
 *  accounting. RULING (see header): 0 — internal capture legs are not user
 *  journeys; the protocol is the taker; fee-model v2 (fees.ts) applies to
 *  user journeys. ADJUSTABLE: raise this if the policy ever changes. */
export const CAPTURE_FEE_POLICY_BPS = 0;

/** The documented ruling, carried on every detection report. */
export const CAPTURE_FEE_POLICY_NOTE =
  "fee-model-v2 (0.5% capped $250 once-per-journey, src/lib/fees.ts) applies to USER journeys; " +
  "internal capture legs are not user journeys — the protocol IS the taker, so CAPTURE_FEE_POLICY_BPS " +
  "defaults to 0 (configurable). Capture value = gross round trip − pool fees both legs already paid " +
  "(netted inside the quotes) − gas.";

/** Rate scale: rates are amountOut * RATE_SCALE / amountIn (BigInt). */
export const RATE_SCALE = 1_000_000_000_000n; // 1e12

/** The DEX-fee note carried on every cost report (see the header — the pool
 *  fees are netted inside the quotes; this is why costBps is gas + policy
 *  and NOT the pool fee tiers again). */
export const DEX_FEES_NETTED_NOTE =
  "pool fees on both legs are ALREADY netted inside the quotes (quoter eth_call / pool-state walk " +
  "return amountOut after the LP fee) — subtracting them again would double count; the fee rates are " +
  "reported as context only.";

/**
 * Normalize a quote's amount fields to BigInt and validate its shape.
 * A quote: { dex, chain?, from?, to?, amountIn, amountOut, feeBps?,
 *            pool?, source?, capturedAt?, gasEstimate? } — the detector only
 *            reads dex/amountIn/amountOut/pool; the rest is carried context.
 *
 * @param {object} quote a raw quote object
 * @returns {{dex: string, pool: string|null, amountIn: bigint,
 *            amountOut: bigint}} normalized
 * @throws on malformed quotes (fail-closed: bad quote in → no detection)
 */
export function normalizeQuote(quote) {
  if (!quote || typeof quote !== "object") throw new Error("gapDetector: a quote must be an object");
  if (typeof quote.dex !== "string" || !quote.dex) throw new Error("gapDetector: a quote needs a dex name");
  const amountIn = BigInt(String(quote.amountIn));
  const amountOut = BigInt(String(quote.amountOut));
  if (amountIn <= 0n) throw new Error(`gapDetector: quote ${quote.dex} has non-positive amountIn`);
  if (amountOut < 0n) throw new Error(`gapDetector: quote ${quote.dex} has negative amountOut`);
  const pool = quote.pool ? String(quote.pool) : null;
  return { dex: String(quote.dex), pool, amountIn, amountOut };
}

/**
 * rateQ — amountOut per amountIn at RATE_SCALE precision (BigInt).
 * @returns {bigint} amountOut * RATE_SCALE / amountIn
 */
export function rateQ(quote) {
  const n = normalizeQuote(quote);
  return (n.amountOut * RATE_SCALE) / n.amountIn;
}

/** The identity used for best/second ranking: pool when present (a fee-tier
 *  pool is a distinct route on the same dex), else the dex name. */
export function quoteRouteId(quote) {
  const n = normalizeQuote(quote);
  return n.pool ? `${n.dex}:${n.pool}` : n.dex;
}

/**
 * Rank a quote set: pick the best (max rate) and the second-best DISTINCT
 * route. Quotes are de-duplicated by route id keeping the best rate, so a
 * double-quoted dex/pool cannot crowd the ranking.
 *
 * @param {Array<object>} quotes
 * @returns {{best: object|null, second: object|null}} normalized best/second
 */
export function rankQuotes(quotes) {
  if (!Array.isArray(quotes) || quotes.length === 0) return { best: null, second: null };
  const byRoute = new Map();
  for (const q of quotes) {
    const n = normalizeQuote(q);
    const id = quoteRouteId(n);
    const prev = byRoute.get(id);
    if (!prev || rateQ(n) > rateQ(prev)) byRoute.set(id, { ...n, routeId: id });
  }
  const ranked = [...byRoute.values()].sort((a, b) => (rateQ(b) > rateQ(a) ? 1 : rateQ(b) < rateQ(a) ? -1 : 0));
  return { best: ranked[0] ?? null, second: ranked[1] ?? null };
}

/** gap between best and second route in bps (BigInt-safe integer bps:
 *  (best − second) * 10000 / best). Null when fewer than two distinct
 *  routes quoted. */
export function gapBpsBetween(best, second) {
  if (!best || !second) return null;
  const rBest = rateQ(best);
  const rSecond = rateQ(second);
  if (rBest <= 0n) return null;
  return Number(((rBest - rSecond) * 10000n) / rBest);
}

/** True when every quote in the list shares the same amountIn. */
export function quotesShareSize(quotes) {
  if (!Array.isArray(quotes) || quotes.length === 0) return true;
  const first = normalizeQuote(quotes[0]).amountIn;
  return quotes.every((q) => normalizeQuote(q).amountIn === first);
}

/** The shared amountIn of a quote list (null when empty or mixed sizes). */
export function sharedAmountIn(quotes) {
  if (!quotesShareSize(quotes)) return null;
  return quotes.length ? normalizeQuote(quotes[0]).amountIn : null;
}

/**
 * detectCaptureGap — the detector. Given the SAME pair's buy-side quotes
 * (X→Y, each sized X0) and sell-side quotes (Y→X — ideally each sized at
 * the best buy output, see `exact`), compute the round-trip capture math.
 *
 * @param {object} args
 * @param {Array<object>} args.buyQuotes  X→Y quotes across venues (amountIn = X0)
 * @param {Array<object>} args.sellQuotes Y→X quotes across venues
 * @param {object} [args.pair]            { from, to } symbols (report context)
 * @param {string} [args.chain]           chain key (report context)
 * @param {string|number|bigint} [args.gasCostQuoteUnits] gas for both legs,
 *        expressed in X base units (the harness converts chain-native gas →
 *        quote-token units). Default 0n.
 * @param {number} [args.protocolFeeBps]  capture fee policy bps — default
 *        CAPTURE_FEE_POLICY_BPS (0; see the ruling in the header).
 * @returns {object} the DETECTION (never a trade — see the module header)
 */
export function detectCaptureGap({ buyQuotes, sellQuotes, pair = null, chain = null, gasCostQuoteUnits = 0n, protocolFeeBps = CAPTURE_FEE_POLICY_BPS } = {}) {
  if (!Array.isArray(buyQuotes) || buyQuotes.length === 0) {
    throw new Error("gapDetector.detectCaptureGap: buyQuotes are required (X→Y across venues)");
  }
  if (!Array.isArray(sellQuotes) || sellQuotes.length === 0) {
    throw new Error("gapDetector.detectCaptureGap: sellQuotes are required (Y→X across venues)");
  }
  const gas = BigInt(String(gasCostQuoteUnits ?? 0));
  if (gas < 0n) throw new Error("gapDetector.detectCaptureGap: gasCostQuoteUnits cannot be negative");
  if (!Number.isInteger(protocolFeeBps) || protocolFeeBps < 0) {
    throw new Error("gapDetector.detectCaptureGap: protocolFeeBps must be a non-negative integer");
  }

  const buyRank = rankQuotes(buyQuotes);
  const sellRank = rankQuotes(sellQuotes);
  const bestBuy = buyRank.best;
  const bestSell = sellRank.best;
  const amountIn = bestBuy.amountIn; // X0

  // Exactness: the round-trip is exact when every sell quote was sized at
  // the best buy output (the caller's job). Otherwise rate-implied.
  const sellSizedExact = quotesShareSize(sellQuotes) && sharedAmountIn(sellQuotes) === bestBuy.amountOut;
  let grossReturn; // X units returned by the sell leg
  if (sellSizedExact) {
    grossReturn = bestSell.amountOut;
  } else {
    // rate-implied: bestSell.amountOut per its own amountIn, scaled to bestBuyOut
    grossReturn = (rateQ(bestSell) * bestBuy.amountOut) / RATE_SCALE;
  }

  const grossRoundTrip = grossReturn - amountIn; // X units (pool-fee-netted both legs)
  const grossRoundTripBps = Number(((grossReturn - amountIn) * 10000n) / amountIn);
  const gasBps = amountIn > 0n ? Number((gas * 10000n) / amountIn) : 0;
  const protocolFeeUnits = (grossReturn * BigInt(protocolFeeBps)) / 10000n;
  const netValueAfterCosts = grossReturn - amountIn - gas - protocolFeeUnits;
  const netRoundTripBps = amountIn > 0n ? Number((netValueAfterCosts * 10000n) / amountIn) : 0;
  const totalCostBps = gasBps + protocolFeeBps;

  const buyGap = gapBpsBetween(buyRank.best, buyRank.second);
  const sellGap = gapBpsBetween(sellRank.best, sellRank.second);

  // WHY-NOT logic (honest, explicit):
  let wouldCapture = netValueAfterCosts > 0n;
  let whyNot = null;
  if (!wouldCapture) {
    if (!buyRank.second && !sellRank.second) {
      whyNot = "single-route: fewer than two distinct venues quoted — there is no cross-venue gap to capture";
    } else if (grossRoundTrip <= 0n) {
      whyNot = "no-arb: the best round trip through the quoted venues returns at or below the starting amount (both pool fees already netted)";
    } else if (netValueAfterCosts <= 0n) {
      whyNot = "below-threshold: the gross gap does not exceed the round-trip cost (gas" +
        (protocolFeeBps > 0 ? " + capture fee policy" : "") + ")";
    } else {
      whyNot = "unknown";
    }
  }

  const buyRoute = bestBuy ? (bestBuy.pool ? `${bestBuy.dex}(${bestBuy.pool})` : bestBuy.dex) : null;
  const sellRoute = bestSell ? (bestSell.pool ? `${bestSell.dex}(${bestSell.pool})` : bestSell.dex) : null;

  return {
    kind: "capture-detection",
    pair: pair ? { from: pair.from ?? null, to: pair.to ?? null } : null,
    chain: chain ?? null,
    amountInRaw: amountIn.toString(),
    amountInRoute: buyRoute,
    buySide: {
      best: bestBuy
        ? { route: buyRoute, dex: bestBuy.dex, pool: bestBuy.pool, amountInRaw: bestBuy.amountIn.toString(), amountOutRaw: bestBuy.amountOut.toString() }
        : null,
      second: buyRank.second
        ? { route: buyRank.second.pool ? `${buyRank.second.dex}(${buyRank.second.pool})` : buyRank.second.dex, dex: buyRank.second.dex, pool: buyRank.second.pool }
        : null,
      gapBps: buyGap,
    },
    sellSide: {
      best: bestSell
        ? { route: sellRoute, dex: bestSell.dex, pool: bestSell.pool, amountInRaw: bestSell.amountIn.toString(), amountOutRaw: bestSell.amountOut.toString() }
        : null,
      second: sellRank.second
        ? { route: sellRank.second.pool ? `${sellRank.second.dex}(${sellRank.second.pool})` : sellRank.second.dex, dex: sellRank.second.dex, pool: sellRank.second.pool }
        : null,
      gapBps: sellGap,
    },
    /** The headline gap: best-vs-second on the buy side (bps). Null when
     *  fewer than two distinct venues quoted. */
    gapBps: buyGap,
    /** Gross round trip in bps of X0 — BOTH pool fees already netted. */
    grossRoundTripBps,
    /** Cost breakdown (bps of X0). Pool fees are netted inside the quotes —
     *  see DEX_FEES_NETTED_NOTE; they are NOT subtracted again. */
    costBps: {
      note: DEX_FEES_NETTED_NOTE,
      feePolicyNote: CAPTURE_FEE_POLICY_NOTE,
      gasBps,
      protocolFeeBps,
      totalBps: totalCostBps,
    },
    /** Net round trip in bps of X0 (gross − gas − capture fee policy). */
    netRoundTripBps,
    grossValueRaw: grossRoundTrip.toString(),
    netValueAfterCostsRaw: netValueAfterCosts.toString(),
    wouldCapture,
    whyNot,
    /** The atomic execution shape: [cheap venue, expensive venue] — buy X→Y
     *  where Y is cheapest, sell Y→X where Y is most expensive. NEVER an
     *  instruction to trade: a DETECTION only. */
    route: [buyRoute, sellRoute].filter(Boolean),
    exact: sellSizedExact,
    exactNote: sellSizedExact
      ? "sell quotes were sized at the best buy output — the round-trip math is exact"
      : "sell quotes were NOT sized at the best buy output — round-trip math is rate-implied (bestSell rate × bestBuy output); a capture harness must size the sell leg at the best buy output",
  };
}

/**
 * summarizeCaptureDetections — aggregate a list of detections for reports
 * (the honest numbers: how many would capture, bps distribution, how often
 * gaps were TOO SMALL). Pure.
 *
 * @param {Array<object>} detections from detectCaptureGap
 * @returns {object} { total, wouldCapture, tooSmall, singleRoute,
 *   bpsMin/Max/Avg (gapBps over detections with a gap), netBps distribution }
 */
export function summarizeCaptureDetections(detections) {
  const list = Array.isArray(detections) ? detections : [];
  const wouldCapture = list.filter((d) => d.wouldCapture);
  const singleRoute = list.filter((d) => d.gapBps === null);
  const withGap = list.filter((d) => d.gapBps !== null);
  const tooSmall = withGap.filter((d) => !d.wouldCapture);
  const bps = withGap.map((d) => d.gapBps);
  const netBps = list.map((d) => d.netRoundTripBps);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    total: list.length,
    wouldCapture: wouldCapture.length,
    tooSmall: tooSmall.length,
    singleRoute: singleRoute.length,
    gapBps: {
      min: bps.length ? Math.min(...bps) : null,
      max: bps.length ? Math.max(...bps) : null,
      avg: avg(bps),
      distribution: {
        "0-1bps": bps.filter((b) => b < 1).length,
        "1-5bps": bps.filter((b) => b >= 1 && b < 5).length,
        "5-20bps": bps.filter((b) => b >= 5 && b < 20).length,
        "20+bps": bps.filter((b) => b >= 20).length,
      },
    },
    netRoundTripBps: { min: netBps.length ? Math.min(...netBps) : null, max: netBps.length ? Math.max(...netBps) : null, avg: avg(netBps) },
  };
}
