/**
 * liquidityGate.test.js — the HARD DEX-liquidity gate (src/lib/liquidityGate.js).
 *
 * Proves the refusal contract the UI relies on:
 *   - a THIN-liquidity token is REFUSED with the actionable message,
 *   - USDC / USDC.x (the hub) is ALWAYS allowed — even on a no-venue chain,
 *   - high-liquidity stables (USDT/DAI) are allowed on major chains but REFUSED
 *     on the thin chains (the combos the v1 advisory only warned about),
 *   - the numeric USD floor is decisive when a liquidity figure is known,
 *   - route legs are derived correctly (X1 = Warp, no DEX leg),
 *   - the refusal carries the USDC suggestion (never a silent switch).
 *
 * Runs under Node's built-in test runner (node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLegLiquidity,
  checkRouteLiquidity,
  routeLegs,
  liquidityRefusalMessage,
  isHubToken,
  isHighLiquidityStable,
  liquidityUsdFromQuote,
  DEFAULT_MIN_ROUTE_LIQUIDITY_USD,
  USDC_SUGGESTION,
} from "./liquidityGate.js";

const REFUSAL_RES = /has insufficient liquidity to bridge/;

// ── hub tokens are never gated ──────────────────────────────────────────────

test("USDC is always allowed, even on a chain with no verified DEX venue", () => {
  // cardano has ONLY unverified venues → hasVenues() === false. USDC must still
  // pass (the bridge hub is the reliable path the gate must never block).
  const r = checkLegLiquidity({ chain: "cardano", token: "USDC" });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "hub-token");
  assert.equal(r.message, null);
});

test("USDC.x on X1 is a hub token (allowed)", () => {
  assert.equal(checkLegLiquidity({ chain: "x1", token: "USDC.x" }).ok, true);
  assert.equal(isHubToken("usdc.x"), true);
  assert.equal(isHubToken("usdc"), true);
  assert.equal(isHubToken("USDT"), false);
});

test("hub tokens win even when a thin numeric figure is supplied", () => {
  // A provided low figure must NOT override the hub exemption.
  const r = checkLegLiquidity({ chain: "sonic", token: "USDC", liquidityUsd: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "hub-token");
});

// ── thin tokens are refused, with the correct message ───────────────────────

test("a thin-liquidity token is REFUSED with the actionable message", () => {
  // Non-hub stable on a thin chain (sonic) → refused. This is the combo the v1
  // advisory flagged but never blocked.
  const r = checkLegLiquidity({ chain: "sonic", token: "USDT" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "thin-chain");
  assert.match(r.message, REFUSAL_RES);
  assert.match(r.message, /USDT on SONIC/);
  assert.match(r.message, /use USDC/);
});

test("the refusal message is the canonical, correct string", () => {
  assert.equal(
    liquidityRefusalMessage({ token: "USDT", chain: "sonic" }),
    "USDT on SONIC has insufficient liquidity to bridge — use USDC or a higher-liquidity asset.",
  );
});

test("a non-hub token on a chain with NO verified venue is refused (fail closed)", () => {
  const r = checkLegLiquidity({ chain: "cardano", token: "USDT" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-venue");
  assert.match(r.message, REFUSAL_RES);
});

test("an explicit combo block refuses even a normally-allowed stable", () => {
  const r = checkLegLiquidity({
    chain: "eth",
    token: "DAI",
    lowLiquidityCombos: { "eth:DAI": true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "thin-combo");
  assert.match(r.message, /DAI on ETH/);
});

// ── high-liquidity stables: allowed on majors, refused on thin chains ───────

test("USDT/DAI are allowed on major chains (verified venues, not thin)", () => {
  assert.equal(checkLegLiquidity({ chain: "eth", token: "USDT" }).ok, true);
  assert.equal(checkLegLiquidity({ chain: "eth", token: "DAI" }).ok, true);
  assert.equal(checkLegLiquidity({ chain: "arb", token: "DAI" }).ok, true);
  assert.equal(checkLegLiquidity({ chain: "eth", token: "USDT" }).reason, "high-liquidity-stable");
  assert.equal(isHighLiquidityStable("usdt"), true);
});

test("USDT/DAI are refused on the thin chains (sonic/avax)", () => {
  for (const chain of ["sonic", "avax"]) {
    for (const token of ["USDT", "DAI"]) {
      const r = checkLegLiquidity({ chain, token });
      assert.equal(r.ok, false, `${chain}:${token} should be refused`);
      assert.match(r.message, REFUSAL_RES);
    }
  }
});

// ── the numeric USD floor is decisive when a figure is known ────────────────

test("a numeric liquidity figure below the floor is refused; above is allowed", () => {
  const below = checkLegLiquidity({ chain: "eth", token: "USDT", liquidityUsd: 1000 });
  assert.equal(below.ok, false);
  assert.equal(below.reason, "below-liquidity-floor");
  assert.match(below.message, REFUSAL_RES);

  const above = checkLegLiquidity({ chain: "eth", token: "USDT", liquidityUsd: 5_000_000 });
  assert.equal(above.ok, true);
  assert.equal(above.reason, "above-liquidity-floor");
});

test("the USD floor is configurable (easy to tune)", () => {
  const r = checkLegLiquidity({ chain: "eth", token: "USDT", liquidityUsd: 10_000, minLiquidityUsd: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.floorUsd, 5000);
  const r2 = checkLegLiquidity({ chain: "eth", token: "USDT", liquidityUsd: 10_000, minLiquidityUsd: 50_000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.floorUsd, 50_000);
});

test("a non-hub token on a verified, non-thin chain is allowed (venue-backed)", () => {
  // e.g. wSOL on Solana — non-stable, but Solana has verified venues.
  const r = checkLegLiquidity({ chain: "sol", token: "WSOL" });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "verified-venue");
});

// ── route-leg derivation ────────────────────────────────────────────────────

test("routeLegs skips the X1 side (Warp, no DEX leg)", () => {
  // EVM → X1: only the source leg is a DEX/swappable leg.
  assert.deepEqual(routeLegs({ from: "eth", to: "x1", srcToken: "USDT", dstToken: "USDC.x" }), [
    { side: "source", chain: "eth", token: "USDT" },
  ]);
  // X1 → EVM: only the destination leg.
  assert.deepEqual(routeLegs({ from: "x1", to: "eth", srcToken: "USDC.x", dstToken: "USDT" }), [
    { side: "dest", chain: "eth", token: "USDT" },
  ]);
  // direct EVM↔EVM: both legs.
  assert.deepEqual(routeLegs({ from: "eth", to: "bsc", srcToken: "USDC", dstToken: "DAI" }), [
    { side: "source", chain: "eth", token: "USDC" },
    { side: "dest", chain: "bsc", token: "DAI" },
  ]);
});

test("checkRouteLiquidity allows a USDC route, refuses a thin one (with suggestion)", () => {
  const good = checkRouteLiquidity({ from: "eth", to: "x1", srcToken: "USDC", dstToken: "USDC.x" });
  assert.equal(good.ok, true);
  assert.equal(good.failures.length, 0);
  assert.equal(good.message, null);
  assert.equal(good.suggestion, null);

  const bad = checkRouteLiquidity({ from: "sonic", to: "x1", srcToken: "USDT", dstToken: "USDC.x" });
  assert.equal(bad.ok, false);
  assert.equal(bad.failures.length, 1);
  assert.equal(bad.reason, "thin-chain");
  assert.match(bad.message, REFUSAL_RES);
  assert.deepEqual(bad.suggestion, USDC_SUGGESTION);
  assert.equal(bad.suggestion.token, "USDC");
});

test("checkRouteLiquidity forwards per-leg liquidity figures", () => {
  const r = checkRouteLiquidity({
    from: "eth",
    to: "bsc",
    srcToken: "USDT",
    dstToken: "DAI",
    srcLiquidityUsd: 1_000_000, // deep
    dstLiquidityUsd: 100, // thin
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 1);
  assert.equal(r.legs.find((l) => l.side === "dest").reason, "below-liquidity-floor");
});

test("DEFAULT_MIN_ROUTE_LIQUIDITY_USD is exposed and finite", () => {
  assert.equal(typeof DEFAULT_MIN_ROUTE_LIQUIDITY_USD, "number");
  assert.ok(DEFAULT_MIN_ROUTE_LIQUIDITY_USD > 0);
});

// ── quote-extraction helper (shape-tolerant; null in the common case) ───────

test("liquidityUsdFromQuote reads only explicit depth fields, never a notional", () => {
  assert.equal(liquidityUsdFromQuote({ estimate: { fromAmount: "999999999999" } }), null);
  assert.equal(liquidityUsdFromQuote(null), null);
  assert.equal(liquidityUsdFromQuote({ estimate: { liquidityUSD: "42000" } }), 42000);
  assert.equal(liquidityUsdFromQuote({ liquidityUsd: 1234 }), 1234);
});
