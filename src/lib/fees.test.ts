/**
 * Fee-unification tests for Step 1.3C (src/lib/fees.ts).
 *
 * Proves:
 *   - every fee class exists and returns the runbook-spec'd rate,
 *   - a route NEVER falls into two classes and rates never stack,
 *   - the structure carries collector / leg / application point so callers
 *     don't re-derive fee math,
 *   - the two future lanes (thorchain-leg, non-x1-bridge) throw descriptive
 *     errors instead of guessing a rate,
 *   - every fee charged today is represented (old→new mapping).
 *
 * Runs under Node's built-in test runner (node --test, type stripping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFee,
  classifyRoute,
  FEE_RATES,
  FEE_WALLETS,
  FeeNotImplementedError,
} from "./fees.ts";

const closeTo = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────
test("classifyRoute: same-chain for every non-X1 LiFi route", () => {
  assert.equal(classifyRoute({ from: "eth", to: "bsc" }), "same-chain");
  assert.equal(classifyRoute({ from: "eth", to: "sol" }), "same-chain");
  assert.equal(classifyRoute({ from: "sol", to: "eth" }), "same-chain");
  assert.equal(classifyRoute({ from: "sol", to: "sol" }), "same-chain");
  assert.equal(classifyRoute({ from: "eth", to: "bsc", routeType: "direct" }), "same-chain");
});

test("classifyRoute: x1-hop for every route that touches the Warp bridge", () => {
  assert.equal(classifyRoute({ from: "sol", to: "x1" }), "x1-hop"); // derived sol_x1
  assert.equal(classifyRoute({ from: "eth", to: "x1" }), "x1-hop"); // derived x1
  assert.equal(classifyRoute({ from: "x1", to: "sol", routeType: "x1_reverse" }), "x1-hop");
  assert.equal(classifyRoute({ from: "x1", to: "eth", routeType: "x1_onward" }), "x1-hop");
});

test("classifyRoute: opt-in future lanes", () => {
  assert.equal(classifyRoute({ from: "eth", to: "bsc", escapeHatch: true }), "escape-hatch");
  assert.equal(classifyRoute({ from: "x1", to: "sol", routeType: "x1_reverse", escapeHatch: true }), "escape-hatch");
  assert.equal(classifyRoute({ from: "eth", to: "bsc", thorchain: true }), "thorchain-leg");
  assert.equal(classifyRoute({ from: "eth", to: "bsc", nonX1Bridge: true }), "non-x1-bridge");
});

test("classifyRoute: conflicting opt-ins throw — a route can only be one class", () => {
  assert.throws(
    () => classifyRoute({ from: "eth", to: "bsc", escapeHatch: true, thorchain: true }),
    /Conflicting fee-class opt-ins/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// NO ROUTE IS CHARGED TWICE (the mandatory test)
// ─────────────────────────────────────────────────────────────────────────────
test("NO ROUTE IS CHARGED TWICE: exactly one class, one headline rate, no stacked rates", () => {
  const routes = [
    { from: "eth", to: "bsc" },                                   // same-chain only
    { from: "sol", to: "x1" },                                    // x1-hop only (sol_x1)
    { from: "eth", to: "x1" },                                    // x1-hop only — has a LiFi leg, must NOT also be same-chain
    { from: "x1", to: "sol", routeType: "x1_reverse" },           // x1-hop only (reverse)
    { from: "x1", to: "eth", routeType: "x1_onward" },            // x1-hop only (onward)
    { from: "sol", to: "eth" },                                   // same-chain only (cross-VM direct)
  ];
  for (const r of routes) {
    const fee = computeFee(r);
    // Exactly one class.
    assert.ok(fee.class === "same-chain" || fee.class === "x1-hop", `${r.from}->${r.to} → ${fee.class}`);
    // The headline rate is the class's OWN — never a blend of two classes.
    assert.equal(
      fee.headlineRate,
      fee.class === "x1-hop" ? FEE_RATES.X1_HOP_SKIM : FEE_RATES.SAME_CHAIN,
    );
    // The escape-hatch component never appears on a live class.
    assert.ok(!fee.hasComponent("escape-hatch-skim"));
    if (fee.class === "x1-hop") {
      // The same-chain 0.5% rate never appears anywhere in an x1-hop structure.
      assert.ok(
        !fee.components.some((c) => c.kind === "rate" && c.rate === FEE_RATES.SAME_CHAIN),
        "x1-hop must never contain the same-chain 0.5% rate",
      );
      // Pure-Warp routes have no LiFi leg, so no integrator component.
      if (r.from === "sol" && r.to === "x1") assert.ok(!fee.hasComponent("lifi-integrator"));
      if (r.routeType === "x1_reverse") assert.ok(!fee.hasComponent("lifi-integrator"));
      // Lookup is exclusive: a class never exposes another class's components.
      assert.throws(() => fee.component("escape-hatch-skim"), /exactly one fee class/);
    } else {
      assert.ok(!fee.hasComponent("warp-skim"), "same-chain must never contain the warp-skim component");
      assert.ok(!fee.hasComponent("warp-flat"), "same-chain must never contain the warp flat");
      assert.throws(() => fee.component("warp-skim"), /exactly one fee class/);
    }
  }
});

test("double-charge trap: EVM→X1 (LiFi leg + Warp hop) is exactly ONE class (x1-hop), never same-chain", () => {
  const fee = computeFee({ from: "eth", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.headlineRate, 0.01);
  const rates = fee.components.filter((c) => c.kind === "rate").map((c) => c.rate);
  assert.ok(!rates.includes(0.005), "same-chain's 0.5% must never stack onto the x1-hop skim");
  assert.equal(fee.components.length, 3); // lifi-integrator + warp-skim + warp-flat
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-CLASS RATES + STRUCTURE
// ─────────────────────────────────────────────────────────────────────────────
test("same-chain class: runbook spec 0.5% headline; the rate charged today is the 1% LiFi integrator (not yet wired)", () => {
  const fee = computeFee({ from: "eth", to: "bsc" });
  assert.equal(fee.class, "same-chain");
  assert.equal(fee.headlineRate, FEE_RATES.SAME_CHAIN); // 0.005 — runbook spec
  const li = fee.component("lifi-integrator");
  assert.equal(li.rate, FEE_RATES.LIFI_INTEGRATOR);     // 0.01 — actually charged today
  assert.equal(li.collector, "lifi-integrator");
  assert.equal(li.leg, "lifi-leg");
  assert.equal(li.applied, "lifi-fee");
  assert.equal(li.base, "source");
  assert.equal(fee.feeUsd(1000), 10); // today's charge: 1% integrator
  assert.equal(fee.netUsd(1000), 990);
  assert.match(fee.applied, /NOT wired yet/);
});

test("x1-hop class: 1% pre-bridge skim + Warp's flat $1 — sol_x1 (pure Warp)", () => {
  const fee = computeFee({ from: "sol", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.headlineRate, FEE_RATES.X1_HOP_SKIM); // 0.01
  const skim = fee.component("warp-skim");
  assert.equal(skim.rate, 0.01);
  assert.equal(skim.collector, "fee-wallet-svm");
  assert.equal(skim.leg, "pre-bridge");
  assert.equal(skim.applied, "pre-bridge-transfer");
  assert.equal(skim.base, "source");
  const flat = fee.component("warp-flat");
  assert.equal(flat.kind, "flat");
  assert.equal(flat.flatUsd, 1);
  assert.equal(flat.collector, "warp-program");
  assert.equal(flat.applied, "on-chain");
  // Quote math: 1% skim + $1 flat, both off the source amount.
  assert.equal(fee.feeUsd(1000), 11);
  assert.equal(fee.netUsd(1000), 989);
  assert.ok(!fee.hasComponent("lifi-integrator"), "pure Warp hop has no LiFi leg");
});

test("x1_reverse: skim lands in the X1 fee wallet; same quote math", () => {
  const fee = computeFee({ from: "x1", to: "sol", routeType: "x1_reverse" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.component("warp-skim").collector, "fee-wallet-x1");
  assert.equal(fee.feeUsd(1000), 11);
  assert.equal(fee.netUsd(1000), 989);
  assert.ok(!fee.hasComponent("lifi-integrator"));
});

test("x1_onward: quote math is skim 1% + $1; the leg-2 LiFi integrator is represented on the leg-1 net", () => {
  const fee = computeFee({ from: "x1", to: "eth", routeType: "x1_onward" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.component("warp-skim").collector, "fee-wallet-x1");
  // Quote display today: 1% + $1 (the leg-2 LiFi fee is quoted live when leg 2 fires).
  assert.equal(fee.feeUsd(1000), 11);
  // But the leg-2 integrator IS in the structure — on the leg-1 net that arrives.
  const leg2 = fee.component("lifi-integrator");
  assert.equal(leg2.rate, 0.01);
  assert.equal(leg2.base, "leg-2-delivered");
  closeTo(leg2.amountUsd(989), 9.89);
});

test("x1 (EVM→X1): source-side quote math is integrator 1% + $1; stage-2 skim is on the delivered amount", () => {
  const fee = computeFee({ from: "eth", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  // Quote box today: feeUsd = 1% of input (integrator), bridgeFee = $1.
  assert.equal(fee.feeUsd(1000), 11);
  const skim = fee.component("warp-skim");
  assert.equal(skim.rate, 0.01);
  assert.equal(skim.base, "leg-1-delivered"); // stage 2 skims what LiFi delivers
  assert.equal(skim.collector, "fee-wallet-svm");
  closeTo(skim.amountUsd(990), 9.9); // skim on the delivered amount
  assert.equal(fee.component("lifi-integrator").base, "source");
});

test("escape-hatch class: 5% rate defined, marked NOT yet applied, never stacks the x1-hop skim", () => {
  const fee = computeFee({ from: "x1", to: "sol", routeType: "x1_reverse", escapeHatch: true });
  assert.equal(fee.class, "escape-hatch");
  assert.equal(fee.headlineRate, FEE_RATES.ESCAPE_HATCH); // 0.05
  const skim = fee.component("escape-hatch-skim");
  assert.equal(skim.rate, 0.05);
  assert.equal(skim.amountUsd(1000), 50);
  assert.equal(fee.netUsd(1000), 950);
  assert.match(fee.applied, /NOT yet applied/i);
  assert.ok(!fee.hasComponent("warp-skim"), "escape hatch must not stack the x1-hop 1% skim");
});

test("thorchain-leg + non-x1-bridge are explicit TODOs that throw a descriptive error", () => {
  assert.throws(() => computeFee({ from: "eth", to: "bsc", thorchain: true }), (e) => {
    assert.ok(e instanceof FeeNotImplementedError);
    assert.equal(e.feeClass, "thorchain-leg");
    assert.match(e.message, /THORChain/);
    return true;
  });
  assert.throws(() => computeFee({ from: "eth", to: "bsc", nonX1Bridge: true }), (e) => {
    assert.ok(e instanceof FeeNotImplementedError);
    assert.equal(e.feeClass, "non-x1-bridge");
    assert.match(e.message, /any-swap phase/);
    return true;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING GUARDS — no fee currently charged may silently disappear
// ─────────────────────────────────────────────────────────────────────────────
test("old→new mapping: every fee charged today is represented in FEE_RATES", () => {
  assert.equal(FEE_RATES.X1_HOP_SKIM, 0.01);      // old: SKIM_BPS=100 / INTEGRATOR_FEE 1% skim
  assert.equal(FEE_RATES.LIFI_INTEGRATOR, 0.01);  // old: INTEGRATOR_FEE on every LiFi quote
  assert.equal(FEE_RATES.WARP_FLAT_USD, 1);       // old: WARP_FLAT_FEE $1
  assert.equal(FEE_RATES.SAME_CHAIN, 0.005);      // runbook spec (deferred to any-swap phase)
  assert.equal(FEE_RATES.ESCAPE_HATCH, 0.05);     // runbook spec (deferred)
});

test("fee wallets match the runbook addresses", () => {
  assert.equal(FEE_WALLETS.SVM, "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu");
  assert.equal(FEE_WALLETS.X1, "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu");
});

test("computeFee works without an amount — structure math takes the base at call time", () => {
  const fee = computeFee({ from: "sol", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.feeUsd(500), 6); // 5 + 1
  assert.equal(fee.netUsd(500), 494);
});
