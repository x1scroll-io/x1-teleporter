/**
 * Fee-policy tests (Step 1.3D — src/lib/fees.ts; FEE-MODEL v2, 2026-09-02).
 *
 * Proves the FEE POLICY (Mr. Esters, 2026-09-02 — fee-model v2):
 *   - Teleporter's fee is 0.5% of the route total, CAPPED at $250 max per
 *     trade, charged ONCE per journey, regardless of hop count — no route
 *     class exceeds min(0.5%, $250) Teleporter take (tested by iterating
 *     EVERY class), with ONE named exception: escape-hatch at 5% (the
 *     separate rescue product — Mr. Esters, fee policy),
 *   - CAP MATH: teleporterFee = min(routeTotal × 0.005, 250) — the boundary
 *     is $50,000: $49,999 → $249.995, $50,000 → $250 exactly, $100,000 →
 *     $250 (never more),
 *   - NO MINIMUM: the $25 floor is GONE (fee-model v2) — a $5/$10 bridge
 *     passes the gate (no X1_MIN-style floor anywhere in the fee layer),
 *   - x1-class routes: the ONLY Teleporter fee is the 0.5% capped stage-2/
 *     source skim (integrator fee 0 — the lifi-integrator component is
 *     REMOVED from the class); the Warp fee (USDC.x flat $1 / wSOL.X 25 bps —
 *     VERIFIED on-chain 2026-09-02) is a SEPARATE third-party component
 *     labeled "Warp bridge fee",
 *   - same-chain routes: the 0.5% LiFi integrator IS the once-per-journey
 *     Teleporter fee (capped at $250 in the quote),
 *   - escape-hatch: 5% — NAMED EXCEPTION to the 0.5%-once rule (Mr. Esters,
 *     fee policy): the escape hatch is a rescue service for chains nothing
 *     else serves — a separate rescue product at 5%, deliberately, labeled as
 *     such in the quote. Carve-out: "Teleporter fee is 0.5% once per journey,
 *     capped at $250; the PulseChain escape hatch is a separate rescue product
 *     at 5%, labeled as such in the quote." (No path exists yet),
 *   - the quote box feeds on computeFee via quoteFees() — every fee line is a
 *     component line, never a hardcoded string,
 *   - thorchain-leg (Workstream A): THREE fee lines before send — THORChain
 *     affiliate (PROTOCOL fee to our THORName), our 0.5% capped skim
 *     (Teleporter), the Warp fee (third-party pass-through). The once-per-
 *     journey rule is about Teleporter's fee; the affiliate is a protocol fee
 *     and the Warp fee is a third-party pass-through — neither counts toward
 *     Teleporter's 0.5% (Teleporter's take is still min(0.5%, $250): the skim).
 *   - the one remaining future lane (non-x1-bridge) throws a descriptive
 *     error instead of guessing a rate,
 *   - every fee charged today is represented (old→new mapping).
 *
 * Runs under Node's built-in test runner (node --test, type stripping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFee,
  classifyRoute,
  quoteFees,
  isX1ClassRoute,
  lifiIntegratorFeeFor,
  FEE_RATES,
  FEE_WALLETS,
  TELEPORTER_FEE_CAP_USD,
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
    // POLICY: every rate component on every class here is ≤ 0.5% (the cap;
    // escape-hatch is the named exception at 5% — asserted separately).
    for (const c of fee.components) {
      if (c.kind === "rate") assert.ok(c.rate <= 0.005, `${fee.class} rate ${c.rate} exceeds the 0.5% cap`);
    }
    if (fee.class === "x1-hop") {
      // POLICY: x1-class routes carry NO LiFi integrator component — the
      // integrator fee is 0 on them, the stage-2 skim is the only Teleporter fee.
      assert.ok(
        !fee.hasComponent("lifi-integrator"),
        "x1-hop must never contain the lifi-integrator component (integrator fee is 0 by policy)",
      );
      // Exactly ONE Teleporter component: the 0.5% capped warp-skim.
      const teleporter = fee.components.filter((c) => c.party === "teleporter");
      assert.equal(teleporter.length, 1, "x1-hop has exactly one Teleporter component");
      assert.equal(teleporter[0].id, "warp-skim");
      assert.equal(teleporter[0].rate, 0.005);
      assert.equal(teleporter[0].capUsd, TELEPORTER_FEE_CAP_USD);
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
  assert.equal(fee.headlineRate, 0.005);
  // POLICY: no integrator component on x1-class — only skim (Teleporter) + Warp's fee (third-party).
  assert.ok(!fee.hasComponent("lifi-integrator"), "x1-class routes must not carry the LiFi integrator fee");
  assert.equal(fee.components.length, 2); // warp-skim + warp-flat
  assert.deepEqual(
    fee.components.map((c) => c.id).sort(),
    ["warp-flat", "warp-skim"],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POLICY — THE 0.5%-CAPPED ONCE-PER-JOURNEY INVARIANT
// ─────────────────────────────────────────────────────────────────────────────
test("POLICY: x1-class total Teleporter take is EXACTLY 0.5% with integrator at 0, the Warp fee is a separate third-party component labeled Warp", () => {
  const x1Routes = [
    { from: "sol", to: "x1", routeType: "sol_x1" },
    { from: "eth", to: "x1", routeType: "x1" },
    { from: "x1", to: "sol", routeType: "x1_reverse" },
    { from: "x1", to: "eth", routeType: "x1_onward" },
  ];
  for (const r of x1Routes) {
    const fee = computeFee(r);
    assert.equal(fee.class, "x1-hop");
    // No Teleporter component other than the 0.5% capped skim.
    assert.ok(!fee.hasComponent("lifi-integrator"), `${r.routeType}: integrator must be 0 (no component)`);
    const teleporter = fee.components.filter((c) => c.party === "teleporter");
    assert.equal(teleporter.length, 1, `${r.routeType}: exactly one Teleporter component`);
    assert.equal(teleporter[0].id, "warp-skim");
    assert.equal(teleporter[0].rate, 0.005);
    // The policy number: exactly 0.5% of the journey total (below the cap).
    assert.equal(fee.teleporterFeeUsd(1000), 5, `${r.routeType}: Teleporter take is exactly 0.5%`);
    // Warp's fee is a SEPARATE third-party component, labeled the Warp bridge fee.
    assert.ok(fee.hasComponent("warp-flat"), `${r.routeType}: warp-flat present`);
    const flat = fee.component("warp-flat");
    assert.equal(flat.party, "third-party");
    assert.match(flat.label, /Warp bridge fee/i);
    assert.equal(flat.kind, "flat");
    assert.equal(flat.flatUsd, 1);
    assert.equal(fee.thirdPartyFeeUsd(1000), 1);
    // The FeeStructure exposes the distinction.
    assert.deepEqual(
      fee.thirdPartyComponents.map((c) => c.id),
      ["warp-flat"],
    );
    assert.ok(fee.thirdPartyComponents.every((c) => c.party === "third-party"));
  }
});

test("POLICY: NO route class exceeds 0.5% (capped $250) Teleporter fee — iterate every class (escape-hatch EXCLUDED: it is the named 5% exception)", () => {
  // escape-hatch is a named exception to the 0.5%-once rule — a separate rescue
  // product at 5% (Mr. Esters, fee policy). It is deliberately EXCLUDED from
  // this 0.5% sweep so no future cleanup "fixes" it back to 0.5%; its 5% rate
  // is asserted separately in the escape-hatch class test above.
  const everyClass = [
    { from: "eth", to: "bsc" },                                   // same-chain
    { from: "sol", to: "x1", routeType: "sol_x1" },               // x1-hop
    { from: "eth", to: "x1", routeType: "x1" },                   // x1-hop (LiFi leg 1)
    { from: "x1", to: "sol", routeType: "x1_reverse" },           // x1-hop (reverse)
    { from: "x1", to: "eth", routeType: "x1_onward" },            // x1-hop (onward, LiFi leg 2)
  ];
  for (const r of everyClass) {
    const fee = computeFee(r);
    const take = fee.teleporterFeeUsd(1000);
    assert.ok(
      take <= 0.005 * 1000,
      `${fee.class} (${r.from}->${r.to}${r.routeType ? " " + r.routeType : ""}) Teleporter take $${take} exceeds 0.5%`,
    );
  }
});

test("POLICY: same-chain Teleporter fee is EXACTLY 0.5%, charged once", () => {
  const fee = computeFee({ from: "eth", to: "bsc" });
  assert.equal(fee.class, "same-chain");
  assert.equal(fee.headlineRate, FEE_RATES.SAME_CHAIN); // 0.005 — fee-model v2
  // The 0.5% LiFi integrator IS the once-per-journey Teleporter fee on non-X1 routes.
  const li = fee.component("lifi-integrator");
  assert.equal(li.party, "teleporter");
  assert.equal(li.rate, FEE_RATES.LIFI_INTEGRATOR); // 0.005
  assert.match(li.label, /Teleporter fee/);
  assert.match(li.label, /0\.5%/);
  assert.equal(li.collector, "lifi-integrator");
  assert.equal(li.leg, "lifi-leg");
  assert.equal(li.applied, "lifi-fee");
  assert.equal(li.base, "source");
  assert.equal(fee.teleporterFeeUsd(1000), 5); // exactly 0.5%, once
  assert.equal(fee.feeUsd(1000), 5);
  assert.equal(fee.netUsd(1000), 995);
  assert.equal(fee.thirdPartyFeeUsd(1000), 0);
  assert.deepEqual(fee.thirdPartyComponents, []);
  assert.match(fee.applied, /once-per-journey Teleporter fee/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CAP MATH — teleporterFee = min(routeTotal × 0.005, $250)
// ─────────────────────────────────────────────────────────────────────────────
test("CAP: the $250 boundary — $49,999 → $249.995, $50,000 → $250 exactly, above → never more than $250", () => {
  const fee = computeFee({ from: "x1", to: "eth", routeType: "x1_onward" });
  // Below the boundary: pure 0.5%.
  closeTo(fee.teleporterFeeUsd(49_999), 249.995, 1e-9);
  // AT the boundary: exactly $250 (0.5% of $50,000 = $250 — the cap engages).
  assert.equal(fee.teleporterFeeUsd(50_000), 250);
  // Above the boundary: capped at $250 — never more.
  assert.equal(fee.teleporterFeeUsd(50_001), 250);
  assert.equal(fee.teleporterFeeUsd(100_000), 250);
  assert.equal(fee.teleporterFeeUsd(1_000_000), 250);
  // Same math through the quote-box helper (per-component line + totals).
  const qf = quoteFees({ from: "x1", to: "eth", routeType: "x1_onward" }, 100_000);
  const skimLine = qf.feeLines.find((l) => l.id === "warp-skim");
  assert.equal(skimLine.amountUsd, 250);
  assert.equal(qf.teleporterFeeUsd, 250);
  assert.equal(qf.totalFeeUsd, 251); // 250 + Warp's $1
  assert.equal(qf.netUsd, 100_000 - 251);
});

test("CAP: every route class charges min(0.5%, $250) — sweep ALL classes at $100k", () => {
  const everyClass = [
    { from: "eth", to: "bsc" },                                   // same-chain
    { from: "sol", to: "x1", routeType: "sol_x1" },               // x1-hop
    { from: "eth", to: "x1", routeType: "x1" },                   // x1-hop (LiFi leg 1)
    { from: "x1", to: "sol", routeType: "x1_reverse" },           // x1-hop (reverse)
    { from: "x1", to: "eth", routeType: "x1_onward" },            // x1-hop (onward)
    { from: "btc", to: "sol", thorchain: true },                  // thorchain-leg
  ];
  for (const r of everyClass) {
    const fee = computeFee(r);
    assert.equal(
      fee.teleporterFeeUsd(100_000),
      250,
      `${fee.class} (${r.from}->${r.to}${r.routeType ? " " + r.routeType : ""}) Teleporter take must cap at $250`,
    );
    assert.equal(
      fee.teleporterFeeUsd(10_000),
      50,
      `${fee.class}: 0.5% of $10,000 = $50 (below the cap)`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NO MINIMUM — the $25 floor is gone (fee-model v2)
// ─────────────────────────────────────────────────────────────────────────────
test("NO MINIMUM: a $5 / $10 bridge quotes at the pure 0.5% rate — no floor anywhere in the fee layer", () => {
  for (const amt of [5, 10, 10.5, 25, 100]) {
    // Forward x1-class: fee = 0.5% × delivered + Warp's $1 — never blocked.
    const fwd = quoteFees({ from: "eth", to: "x1", routeType: "x1" }, amt);
    closeTo(fwd.teleporterFeeUsd, amt * 0.005, 1e-12);
    assert.ok(fwd.feeLines.length === 2, "fee lines render for a $5 bridge — no gate");
    // Reverse x1-class: same.
    const rev = quoteFees({ from: "x1", to: "eth", routeType: "x1_onward" }, amt);
    closeTo(rev.teleporterFeeUsd, amt * 0.005, 1e-12);
    // same-chain: single 0.5% line — no floor.
    const sc = quoteFees({ from: "eth", to: "bsc" }, amt);
    closeTo(sc.teleporterFeeUsd, amt * 0.005, 1e-12);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-CLASS RATES + STRUCTURE
// ─────────────────────────────────────────────────────────────────────────────
test("x1-hop class: 0.5% Teleporter skim (max $250) + Warp's flat $1 — sol_x1 (pure Warp)", () => {
  const fee = computeFee({ from: "sol", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.headlineRate, FEE_RATES.X1_HOP_SKIM); // 0.005
  const skim = fee.component("warp-skim");
  assert.equal(skim.rate, 0.005);
  assert.equal(skim.capUsd, 250);
  assert.equal(skim.party, "teleporter");
  assert.equal(skim.collector, "fee-wallet-svm");
  assert.equal(skim.leg, "pre-bridge");
  assert.equal(skim.applied, "pre-bridge-transfer");
  assert.equal(skim.base, "source");
  const flat = fee.component("warp-flat");
  assert.equal(flat.kind, "flat");
  assert.equal(flat.flatUsd, 1);
  assert.equal(flat.party, "third-party");
  assert.equal(flat.collector, "warp-program");
  assert.equal(flat.applied, "on-chain");
  // Quote math: 0.5% skim + $1 Warp pass-through, both off the source amount.
  assert.equal(fee.feeUsd(1000), 6);
  assert.equal(fee.netUsd(1000), 994);
  assert.equal(fee.teleporterFeeUsd(1000), 5);
  assert.equal(fee.thirdPartyFeeUsd(1000), 1);
  assert.ok(!fee.hasComponent("lifi-integrator"), "pure Warp hop has no LiFi leg");
});

test("x1_reverse: skim lands in the X1 fee wallet; same quote math", () => {
  const fee = computeFee({ from: "x1", to: "sol", routeType: "x1_reverse" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.component("warp-skim").collector, "fee-wallet-x1");
  assert.equal(fee.feeUsd(1000), 6);
  assert.equal(fee.netUsd(1000), 994);
  assert.ok(!fee.hasComponent("lifi-integrator"));
});

test("x1_onward: quote math is skim 0.5% + $1; NO leg-2 LiFi integrator (policy)", () => {
  const fee = computeFee({ from: "x1", to: "eth", routeType: "x1_onward" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.component("warp-skim").collector, "fee-wallet-x1");
  // Quote display: 0.5% + $1 (the leg-2 LiFi leg runs with integrator fee 0).
  assert.equal(fee.feeUsd(1000), 6);
  assert.equal(fee.netUsd(1000), 994);
  assert.equal(fee.teleporterFeeUsd(1000), 5);
  // POLICY: the leg-2 integrator component is GONE from the x1-hop class.
  assert.ok(!fee.hasComponent("lifi-integrator"), "x1_onward must not carry a leg-2 integrator fee");
});

test("x1 (EVM→X1): quote math is skim 0.5% + $1; stage-2 skim is on the delivered amount", () => {
  const fee = computeFee({ from: "eth", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  // POLICY quote view: Teleporter skim 0.5% + Warp's $1 — no integrator.
  assert.equal(fee.feeUsd(1000), 6);
  assert.equal(fee.teleporterFeeUsd(1000), 5);
  assert.equal(fee.thirdPartyFeeUsd(1000), 1);
  assert.ok(!fee.hasComponent("lifi-integrator"), "x1 (EVM→X1) must not carry the integrator fee");
  const skim = fee.component("warp-skim");
  assert.equal(skim.rate, 0.005);
  assert.equal(skim.base, "leg-1-delivered"); // stage 2 skims what LiFi delivers
  assert.equal(skim.collector, "fee-wallet-svm");
  closeTo(skim.amountUsd(990), 4.95); // skim on the delivered amount
});

test("escape-hatch class: 5% — the named exception to the 0.5%-once rule, labeled as a rescue product, never stacks the x1-hop skim", () => {
  // escape-hatch is a named exception to the 0.5%-once rule — a separate
  // rescue product at 5% (Mr. Esters, fee policy). The fee rule is about
  // bridging; the escape hatch is a rescue service for chains nothing else
  // serves — a different product, premium price, deliberately, labeled as
  // such in the quote. Carve-out: "Teleporter fee is 0.5% once per journey,
  // capped at $250; the PulseChain escape hatch is a separate rescue product
  // at 5%, labeled as such in the quote."
  const fee = computeFee({ from: "x1", to: "sol", routeType: "x1_reverse", escapeHatch: true });
  assert.equal(fee.class, "escape-hatch");
  assert.equal(fee.headlineRate, FEE_RATES.ESCAPE_HATCH); // 0.05 — the named exception (rescue product)
  const skim = fee.component("escape-hatch-skim");
  assert.equal(skim.rate, 0.05);
  assert.equal(skim.party, "teleporter");
  assert.equal(skim.amountUsd(1000), 50);
  assert.equal(fee.netUsd(1000), 950);
  assert.equal(fee.teleporterFeeUsd(1000), 50);
  assert.match(fee.applied, /NOT yet applied/i);
  assert.match(fee.applied, /NAMED EXCEPTION/i);
  assert.match(skim.label, /rescue/i); // labeled as the rescue product in the quote
  assert.ok(!fee.hasComponent("warp-skim"), "escape hatch must not stack the x1-hop skim");
});

test("thorchain-leg class: THREE fee lines before send — affiliate (protocol) + 0.5% capped skim + Warp's $1; Teleporter take still exactly 0.5%", () => {
  const fee = computeFee({ from: "btc", to: "sol", thorchain: true });
  assert.equal(fee.class, "thorchain-leg");
  assert.equal(fee.headlineRate, FEE_RATES.X1_HOP_SKIM); // 0.005 — Teleporter's take is 0.5%

  // Exactly THREE components, in the documented order.
  assert.deepEqual(
    fee.components.map((c) => c.id),
    ["thorchain-affiliate", "warp-skim", "warp-flat"],
  );

  // 1) THORChain affiliate — a PROTOCOL fee to our THORName, rate from config
  //    (THORCHAIN_AFFILIATE_BPS, start 100 = 1.00%). NEVER a Teleporter fee.
  const aff = fee.component("thorchain-affiliate");
  assert.equal(aff.kind, "rate");
  assert.equal(aff.rate, 0.01); // 100 bps / 10_000
  assert.equal(aff.party, "third-party");
  assert.equal(aff.collector, "thorchain-affiliate");
  assert.equal(aff.leg, "bridge");
  assert.equal(aff.applied, "on-chain");
  assert.match(aff.label, /THORChain affiliate/);
  assert.match(aff.label, /protocol/i);

  // 2) Our 0.5% capped skim — THE Teleporter fee on this lane (0.5%, once).
  const skim = fee.component("warp-skim");
  assert.equal(skim.party, "teleporter");
  assert.equal(skim.rate, 0.005);
  assert.equal(skim.capUsd, 250);
  assert.equal(skim.collector, "fee-wallet-svm");
  assert.equal(skim.leg, "pre-bridge");

  // 3) Warp's $1 — third-party pass-through (verified on-chain 2026-09-02).
  const flat = fee.component("warp-flat");
  assert.equal(flat.party, "third-party");
  assert.equal(flat.flatUsd, 1);
  assert.match(flat.label, /Warp bridge fee/);

  // POLICY: the once-per-journey rule is about Teleporter's fee. The affiliate
  // is a PROTOCOL fee, the Warp $1 is a THIRD-PARTY pass-through — neither
  // counts toward Teleporter's 0.5%. Teleporter's take is EXACTLY 0.5% (the
  // skim only).
  assert.equal(fee.teleporterFeeUsd(1000), 5, "Teleporter take is exactly 0.5% — never more");
  // Third-party + protocol lines are summed separately: affiliate 1% + $1.
  assert.equal(fee.thirdPartyFeeUsd(1000), 11);
  assert.deepEqual(
    fee.thirdPartyComponents.map((c) => c.id),
    ["thorchain-affiliate", "warp-flat"],
  );
  assert.equal(fee.feeUsd(1000), 16); // 10 (affiliate) + 5 (skim) + 1 (warp)
  assert.equal(fee.netUsd(1000), 984);

  // NO double charge: exactly one Teleporter component, no LiFi integrator,
  // no escape-hatch skim on this lane.
  const teleporter = fee.components.filter((c) => c.party === "teleporter");
  assert.equal(teleporter.length, 1);
  assert.equal(teleporter[0].id, "warp-skim");
  assert.ok(!fee.hasComponent("lifi-integrator"), "thorchain-leg has no LiFi leg — no integrator fee");
  assert.ok(!fee.hasComponent("escape-hatch-skim"));
  // The class doc carries the policy distinction (protocol vs third-party vs
  // Teleporter's 0.5%).
  assert.match(fee.applied, /protocol fee/);
  assert.match(fee.applied, /third-party pass-through/);
  assert.match(fee.applied, /counts toward Teleporter/);
});

test("thorchain-leg: affiliate bps comes from config (default 100) and the route can override it", () => {
  // Default: config THORCHAIN_AFFILIATE_BPS (start 100 per the runbook).
  const fee = computeFee({ from: "btc", to: "sol", thorchain: true });
  assert.equal(fee.component("thorchain-affiliate").rate, 100 / 10_000);
  assert.equal(fee.thirdPartyFeeUsd(1000), 11); // 1% affiliate + $1
  // Route override (tests + future config plumbing).
  const fee200 = computeFee({ from: "btc", to: "sol", thorchain: true, affiliateBps: 200 });
  assert.equal(fee200.component("thorchain-affiliate").rate, 0.02);
  assert.equal(fee200.thirdPartyFeeUsd(1000), 21); // 2% affiliate + $1
  // The override never changes Teleporter's take — still exactly 0.5%.
  assert.equal(fee200.teleporterFeeUsd(1000), 5);
});

test("quote box data: thorchain-leg shows EXACTLY three fee lines before send", () => {
  const qf = quoteFees({ from: "btc", to: "sol", thorchain: true }, 1000);
  assert.equal(qf.feeLines.length, 3, "three lines — affiliate + skim + Warp's $1");
  assert.deepEqual(
    qf.feeLines.map((l) => l.id),
    ["thorchain-affiliate", "warp-skim", "warp-flat"],
  );
  // The three lines: protocol affiliate (third-party), Teleporter 0.5% (teleporter),
  // Warp's $1 (third-party).
  assert.deepEqual(
    qf.feeLines.map((l) => l.party),
    ["third-party", "teleporter", "third-party"],
  );
  assert.equal(qf.feeLines[0].amountUsd, 10); // 1% affiliate on $1000
  assert.equal(qf.feeLines[1].amountUsd, 5);  // Teleporter 0.5% skim
  assert.equal(qf.feeLines[2].amountUsd, 1);  // Warp's $1
  assert.equal(qf.teleporterFeeUsd, 5);
  assert.equal(qf.thirdPartyFeeUsd, 11);
  assert.equal(qf.totalFeeUsd, 16);
  assert.equal(qf.netUsd, 984);
});

test("non-x1-bridge is an explicit TODO that throws a descriptive error", () => {
  assert.throws(() => computeFee({ from: "eth", to: "bsc", nonX1Bridge: true }), (e) => {
    assert.ok(e instanceof FeeNotImplementedError);
    assert.equal(e.feeClass, "non-x1-bridge");
    assert.match(e.message, /any-swap phase/);
    return true;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE-BOX DATA — components → lines (the render feeds on quoteFees)
// ─────────────────────────────────────────────────────────────────────────────
test("quote box data: x1-class shows BOTH line items — Teleporter fee + Warp bridge fee — and net reflects all of them", () => {
  for (const r of [
    { from: "sol", to: "x1", routeType: "sol_x1" },
    { from: "eth", to: "x1", routeType: "x1" },
    { from: "x1", to: "sol", routeType: "x1_reverse" },
    { from: "x1", to: "eth", routeType: "x1_onward" },
  ]) {
    const qf = quoteFees(r, 1000);
    assert.equal(qf.feeLines.length, 2, `${r.routeType}: two fee lines`);
    const teleporterLine = qf.feeLines.find((l) => l.party === "teleporter");
    assert.ok(teleporterLine, `${r.routeType}: Teleporter fee line present`);
    assert.match(teleporterLine.label, /Teleporter fee/);
    assert.match(teleporterLine.label, /0\.5%/);
    assert.equal(teleporterLine.amountUsd, 5);
    const warpLine = qf.feeLines.find((l) => l.id === "warp-flat");
    assert.ok(warpLine, `${r.routeType}: Warp bridge fee line present`);
    assert.match(warpLine.label, /Warp bridge fee/i);
    assert.equal(warpLine.amountUsd, 1);
    // Net reflects EVERY component: 1000 − 5 − 1.
    assert.equal(qf.teleporterFeeUsd, 5);
    assert.equal(qf.thirdPartyFeeUsd, 1);
    assert.equal(qf.totalFeeUsd, 6);
    assert.equal(qf.netUsd, 994);
  }
});

test("quote box data: same-chain shows the single Teleporter fee line; net = amount − 0.5%", () => {
  const qf = quoteFees({ from: "eth", to: "bsc" }, 1000);
  assert.equal(qf.feeLines.length, 1);
  assert.equal(qf.feeLines[0].id, "lifi-integrator");
  assert.equal(qf.feeLines[0].party, "teleporter");
  assert.equal(qf.feeLines[0].amountUsd, 5);
  assert.equal(qf.teleporterFeeUsd, 5);
  assert.equal(qf.thirdPartyFeeUsd, 0);
  assert.equal(qf.netUsd, 995);
});

test("quote box data: Warp-handoff mode excludes the warp-flat line (Warp charges their fee on their side)", () => {
  const qf = quoteFees({ from: "sol", to: "x1", routeType: "sol_x1" }, 1000, ["warp-flat"]);
  assert.equal(qf.feeLines.length, 1);
  assert.equal(qf.feeLines[0].id, "warp-skim");
  assert.equal(qf.thirdPartyFeeUsd, 0);
  assert.equal(qf.netUsd, 995);
});

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATOR FEE PARAM — the money-touching propagation
// ─────────────────────────────────────────────────────────────────────────────
test("POLICY: the LiFi fee param is OMITTED (null) on every x1-class routeType, 0.5% on non-X1", () => {
  assert.equal(isX1ClassRoute("sol_x1"), true);
  assert.equal(isX1ClassRoute("x1"), true);
  assert.equal(isX1ClassRoute("x1_reverse"), true);
  assert.equal(isX1ClassRoute("x1_onward"), true);
  assert.equal(isX1ClassRoute("direct"), false);
  // The param the client builds (and the server re-forces): x1-class OMITS
  // the fee key entirely (absent means absent — never fee=0), non-X1 carries
  // fee=0.005.
  assert.equal(lifiIntegratorFeeFor("x1"), null);
  assert.equal(lifiIntegratorFeeFor("x1_onward"), null);
  assert.equal(lifiIntegratorFeeFor("sol_x1"), null);
  assert.equal(lifiIntegratorFeeFor("x1_reverse"), null);
  assert.equal(lifiIntegratorFeeFor("direct"), FEE_RATES.LIFI_INTEGRATOR); // 0.005
});

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING GUARDS — no fee currently charged may silently disappear
// ─────────────────────────────────────────────────────────────────────────────
test("old→new mapping: every fee charged today is represented in FEE_RATES (fee-model v2)", () => {
  // Fee-model v2 (2026-09-02): the Teleporter fee is 0.5% capped at $250 —
  // SUPERSEDES the 2026-08-28 1%-once policy on every class.
  assert.equal(FEE_RATES.X1_HOP_SKIM, 0.005);      // old: 1% skim → new: 0.5% (capped $250)
  assert.equal(FEE_RATES.LIFI_INTEGRATOR, 0.005);  // old: 1% integrator → new: 0.5% (capped $250)
  assert.equal(FEE_RATES.WARP_FLAT_USD, 1);        // Warp's USDC.x flat $1 — VERIFIED on-chain 2026-09-02 (unchanged)
  assert.equal(FEE_RATES.SAME_CHAIN, 0.005);       // old: 1% → new: 0.5% once
  assert.equal(TELEPORTER_FEE_CAP_USD, 250);       // the fee-model v2 cap
  // escape-hatch: 5% — NAMED EXCEPTION to the 0.5%-once rule (Mr. Esters, fee
  // policy): the escape hatch is a separate rescue product at 5%, deliberately,
  // labeled as such in the quote. Carve-out: "Teleporter fee is 0.5% once per
  // journey, capped at $250; the PulseChain escape hatch is a separate rescue
  // product at 5%, labeled as such in the quote."
  assert.equal(FEE_RATES.ESCAPE_HATCH, 0.05);     // 5% — named exception (rescue product)
});

test("fee wallets match the runbook addresses", () => {
  assert.equal(FEE_WALLETS.SVM, "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu");
  assert.equal(FEE_WALLETS.X1, "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu");
});

test("computeFee works without an amount — structure math takes the base at call time", () => {
  const fee = computeFee({ from: "sol", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.feeUsd(500), 3.5); // 2.5 + 1
  assert.equal(fee.netUsd(500), 496.5);
  assert.equal(fee.teleporterFeeUsd(500), 2.5);
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-ASSET WARP COMPONENT SELECTION — the warpFeeBps contract (fix on v2 @
// 1b541e5): computeFee is asset-agnostic by design; the warp-flat/warp-pct
// choice keys off route.warpFeeBps. The TOKEN-level decision lives in the
// callers (reverseQuote.computeReverseLegs / teleportQuote.deriveQuoteFromLifi
// pass warpFeeBps for EVERY non-USDC.x token — flat $1 is USDC.x-ONLY, Mr.
// Esters' verified structure 2026-09-02 — pinned by their own test files).
// This file pins the Fees.ts side of the contract.
// ─────────────────────────────────────────────────────────────────────────────
test("computeFee: warpFeeBps present (25) → warp-pct 0.25% component, NO warp-flat", () => {
  const fee = computeFee({ routeType: "x1_onward", warpFeeBps: 25 });
  assert.equal(fee.class, "x1-hop");
  assert.ok(fee.hasComponent("warp-pct"), "bps present ⇒ warp-pct selected");
  const pct = fee.component("warp-pct");
  assert.equal(pct.kind, "rate");
  assert.equal(pct.rate, 0.0025);
  assert.equal(pct.label, "Warp bridge fee (0.25%)");
  assert.equal(pct.party, "third-party");
  assert.ok(!fee.hasComponent("warp-flat"), "never both shapes");
  assert.equal(fee.thirdPartyFeeUsd(1000), 2.5, "0.25% of the amount as the pass-through line");
});

test("computeFee: warpFeeBps absent → warp-flat $1 (the USDC.x-only shape — legacy callers are USDC.x-only)", () => {
  const fee = computeFee({ routeType: "x1_onward" });
  assert.ok(fee.hasComponent("warp-flat"));
  assert.ok(!fee.hasComponent("warp-pct"));
  assert.equal(fee.thirdPartyFeeUsd(1000), 1);
});

test("quoteFees: an x1_onward quote with warpFeeBps renders ONE 'Warp bridge fee (0.25%)' line at the right amount", () => {
  const qf = quoteFees({ from: "x1", to: "eth", routeType: "x1_onward", warpFeeBps: 25 }, 100);
  const warp = qf.feeLines.find((l) => l.id === "warp-pct");
  assert.ok(warp, "warp-pct line rendered");
  assert.equal(warp.label, "Warp bridge fee (0.25%)");
  assert.equal(warp.amountUsd, 0.25);
  assert.equal(warp.party, "third-party");
  assert.equal(qf.feeLines.find((l) => l.id === "warp-flat"), undefined);
  assert.equal(qf.thirdPartyFeeUsd, 0.25);
  assert.equal(qf.teleporterFeeUsd, 0.5, "Teleporter take stays exactly 0.5% once");
});
