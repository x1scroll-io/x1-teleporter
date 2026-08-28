/**
 * Fee-policy tests (Step 1.3D — src/lib/fees.ts).
 *
 * Proves the FEE POLICY (Mr. Esters, 2026-08-28):
 *   - Teleporter's fee is EXACTLY 1% of the route total, charged ONCE per
 *     journey, regardless of hop count — no route class exceeds 1% Teleporter
 *     take (tested by iterating EVERY class),
 *   - x1-class routes: the ONLY Teleporter fee is the 1% stage-2/source skim
 *     (integrator fee 0 — the lifi-integrator component is REMOVED from the
 *     class); Warp's $1 is a SEPARATE third-party component labeled
 *     "Warp bridge fee",
 *   - same-chain routes: the 1% LiFi integrator IS the once-per-journey
 *     Teleporter fee (the runbook's 0.5% headline is SUPERSEDED by the policy
 *     — charged rate and policy rate agree at 1%, once),
 *   - escape-hatch: rate capped at 1% (policy supersedes the runbook's 5% —
 *     the cap applies to every class; no path exists yet),
 *   - the quote box feeds on computeFee via quoteFees() — every fee line is a
 *     component line, never a hardcoded string,
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
  quoteFees,
  isX1ClassRoute,
  lifiIntegratorFeeFor,
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
    // POLICY: every rate component on every class is ≤ 1% (the cap).
    for (const c of fee.components) {
      if (c.kind === "rate") assert.ok(c.rate <= 0.01, `${fee.class} rate ${c.rate} exceeds the 1% cap`);
    }
    if (fee.class === "x1-hop") {
      // POLICY: x1-class routes carry NO LiFi integrator component — the
      // integrator fee is 0 on them, the stage-2 skim is the only Teleporter fee.
      assert.ok(
        !fee.hasComponent("lifi-integrator"),
        "x1-hop must never contain the lifi-integrator component (integrator fee is 0 by policy)",
      );
      // Exactly ONE Teleporter component: the 1% warp-skim.
      const teleporter = fee.components.filter((c) => c.party === "teleporter");
      assert.equal(teleporter.length, 1, "x1-hop has exactly one Teleporter component");
      assert.equal(teleporter[0].id, "warp-skim");
      assert.equal(teleporter[0].rate, 0.01);
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
  // POLICY: no integrator component on x1-class — only skim (Teleporter) + Warp's $1 (third-party).
  assert.ok(!fee.hasComponent("lifi-integrator"), "x1-class routes must not carry the LiFi integrator fee");
  assert.equal(fee.components.length, 2); // warp-skim + warp-flat
  assert.deepEqual(
    fee.components.map((c) => c.id).sort(),
    ["warp-flat", "warp-skim"],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POLICY — THE 1% ONCE-PER-JOURNEY INVARIANT
// ─────────────────────────────────────────────────────────────────────────────
test("POLICY: x1-class total Teleporter take is EXACTLY 1% with integrator at 0, Warp's $1 is a separate third-party component labeled Warp", () => {
  const x1Routes = [
    { from: "sol", to: "x1", routeType: "sol_x1" },
    { from: "eth", to: "x1", routeType: "x1" },
    { from: "x1", to: "sol", routeType: "x1_reverse" },
    { from: "x1", to: "eth", routeType: "x1_onward" },
  ];
  for (const r of x1Routes) {
    const fee = computeFee(r);
    assert.equal(fee.class, "x1-hop");
    // No Teleporter component other than the 1% skim.
    assert.ok(!fee.hasComponent("lifi-integrator"), `${r.routeType}: integrator must be 0 (no component)`);
    const teleporter = fee.components.filter((c) => c.party === "teleporter");
    assert.equal(teleporter.length, 1, `${r.routeType}: exactly one Teleporter component`);
    assert.equal(teleporter[0].id, "warp-skim");
    assert.equal(teleporter[0].rate, 0.01);
    // The policy number: exactly 1% of the journey total.
    assert.equal(fee.teleporterFeeUsd(1000), 10, `${r.routeType}: Teleporter take is exactly 1%`);
    // Warp's $1 is a SEPARATE third-party component, labeled the Warp bridge fee.
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

test("POLICY: NO route class exceeds 1% Teleporter fee — iterate every class", () => {
  const everyClass = [
    { from: "eth", to: "bsc" },                                   // same-chain
    { from: "sol", to: "x1", routeType: "sol_x1" },               // x1-hop
    { from: "eth", to: "x1", routeType: "x1" },                   // x1-hop (LiFi leg 1)
    { from: "x1", to: "sol", routeType: "x1_reverse" },           // x1-hop (reverse)
    { from: "x1", to: "eth", routeType: "x1_onward" },            // x1-hop (onward, LiFi leg 2)
    { from: "x1", to: "sol", routeType: "x1_reverse", escapeHatch: true }, // escape-hatch (policy-capped)
  ];
  for (const r of everyClass) {
    const fee = computeFee(r);
    const take = fee.teleporterFeeUsd(1000);
    assert.ok(
      take <= 0.01 * 1000,
      `${fee.class} (${r.from}->${r.to}${r.routeType ? " " + r.routeType : ""}) Teleporter take $${take} exceeds 1%`,
    );
  }
});

test("POLICY: same-chain Teleporter fee is EXACTLY 1%, charged once", () => {
  const fee = computeFee({ from: "eth", to: "bsc" });
  assert.equal(fee.class, "same-chain");
  assert.equal(fee.headlineRate, FEE_RATES.SAME_CHAIN); // 0.01 — policy supersedes the runbook 0.5%
  // The 1% LiFi integrator IS the once-per-journey Teleporter fee on non-X1 routes.
  const li = fee.component("lifi-integrator");
  assert.equal(li.party, "teleporter");
  assert.equal(li.rate, FEE_RATES.LIFI_INTEGRATOR); // 0.01
  assert.match(li.label, /Teleporter fee/);
  assert.equal(li.collector, "lifi-integrator");
  assert.equal(li.leg, "lifi-leg");
  assert.equal(li.applied, "lifi-fee");
  assert.equal(li.base, "source");
  assert.equal(fee.teleporterFeeUsd(1000), 10); // exactly 1%, once
  assert.equal(fee.feeUsd(1000), 10);
  assert.equal(fee.netUsd(1000), 990);
  assert.equal(fee.thirdPartyFeeUsd(1000), 0);
  assert.deepEqual(fee.thirdPartyComponents, []);
  assert.match(fee.applied, /once-per-journey Teleporter fee/);
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-CLASS RATES + STRUCTURE
// ─────────────────────────────────────────────────────────────────────────────
test("x1-hop class: 1% Teleporter skim + Warp's flat $1 — sol_x1 (pure Warp)", () => {
  const fee = computeFee({ from: "sol", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.headlineRate, FEE_RATES.X1_HOP_SKIM); // 0.01
  const skim = fee.component("warp-skim");
  assert.equal(skim.rate, 0.01);
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
  // Quote math: 1% skim + $1 Warp pass-through, both off the source amount.
  assert.equal(fee.feeUsd(1000), 11);
  assert.equal(fee.netUsd(1000), 989);
  assert.equal(fee.teleporterFeeUsd(1000), 10);
  assert.equal(fee.thirdPartyFeeUsd(1000), 1);
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

test("x1_onward: quote math is skim 1% + $1; NO leg-2 LiFi integrator (policy)", () => {
  const fee = computeFee({ from: "x1", to: "eth", routeType: "x1_onward" });
  assert.equal(fee.class, "x1-hop");
  assert.equal(fee.component("warp-skim").collector, "fee-wallet-x1");
  // Quote display: 1% + $1 (the leg-2 LiFi leg runs with integrator fee 0).
  assert.equal(fee.feeUsd(1000), 11);
  assert.equal(fee.netUsd(1000), 989);
  assert.equal(fee.teleporterFeeUsd(1000), 10);
  // POLICY: the leg-2 integrator component is GONE from the x1-hop class.
  assert.ok(!fee.hasComponent("lifi-integrator"), "x1_onward must not carry a leg-2 integrator fee");
});

test("x1 (EVM→X1): quote math is skim 1% + $1; stage-2 skim is on the delivered amount", () => {
  const fee = computeFee({ from: "eth", to: "x1" });
  assert.equal(fee.class, "x1-hop");
  // POLICY quote view: Teleporter skim 1% + Warp's $1 — no integrator.
  assert.equal(fee.feeUsd(1000), 11);
  assert.equal(fee.teleporterFeeUsd(1000), 10);
  assert.equal(fee.thirdPartyFeeUsd(1000), 1);
  assert.ok(!fee.hasComponent("lifi-integrator"), "x1 (EVM→X1) must not carry the integrator fee");
  const skim = fee.component("warp-skim");
  assert.equal(skim.rate, 0.01);
  assert.equal(skim.base, "leg-1-delivered"); // stage 2 skims what LiFi delivers
  assert.equal(skim.collector, "fee-wallet-svm");
  closeTo(skim.amountUsd(990), 9.9); // skim on the delivered amount
});

test("escape-hatch class: 1% policy cap, marked NOT yet applied, never stacks the x1-hop skim", () => {
  const fee = computeFee({ from: "x1", to: "sol", routeType: "x1_reverse", escapeHatch: true });
  assert.equal(fee.class, "escape-hatch");
  assert.equal(fee.headlineRate, FEE_RATES.ESCAPE_HATCH); // 0.01 — policy cap (supersedes runbook 5%)
  const skim = fee.component("escape-hatch-skim");
  assert.equal(skim.rate, 0.01);
  assert.equal(skim.party, "teleporter");
  assert.equal(skim.amountUsd(1000), 10);
  assert.equal(fee.netUsd(1000), 990);
  assert.equal(fee.teleporterFeeUsd(1000), 10);
  assert.match(fee.applied, /NOT yet applied/i);
  assert.match(fee.applied, /superseded/i);
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
    assert.equal(teleporterLine.amountUsd, 10);
    const warpLine = qf.feeLines.find((l) => l.id === "warp-flat");
    assert.ok(warpLine, `${r.routeType}: Warp bridge fee line present`);
    assert.match(warpLine.label, /Warp bridge fee/i);
    assert.equal(warpLine.amountUsd, 1);
    // Net reflects EVERY component: 1000 − 10 − 1.
    assert.equal(qf.teleporterFeeUsd, 10);
    assert.equal(qf.thirdPartyFeeUsd, 1);
    assert.equal(qf.totalFeeUsd, 11);
    assert.equal(qf.netUsd, 989);
  }
});

test("quote box data: same-chain shows the single Teleporter fee line; net = amount − 1%", () => {
  const qf = quoteFees({ from: "eth", to: "bsc" }, 1000);
  assert.equal(qf.feeLines.length, 1);
  assert.equal(qf.feeLines[0].id, "lifi-integrator");
  assert.equal(qf.feeLines[0].party, "teleporter");
  assert.equal(qf.feeLines[0].amountUsd, 10);
  assert.equal(qf.teleporterFeeUsd, 10);
  assert.equal(qf.thirdPartyFeeUsd, 0);
  assert.equal(qf.netUsd, 990);
});

test("quote box data: Warp-handoff mode excludes the warp-flat line (Warp charges their $1 on their side)", () => {
  const qf = quoteFees({ from: "sol", to: "x1", routeType: "sol_x1" }, 1000, ["warp-flat"]);
  assert.equal(qf.feeLines.length, 1);
  assert.equal(qf.feeLines[0].id, "warp-skim");
  assert.equal(qf.thirdPartyFeeUsd, 0);
  assert.equal(qf.netUsd, 990);
});

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATOR FEE PARAM — the money-touching propagation
// ─────────────────────────────────────────────────────────────────────────────
test("POLICY: LiFi integrator fee param is 0 on every x1-class routeType, 1% on non-X1", () => {
  assert.equal(isX1ClassRoute("sol_x1"), true);
  assert.equal(isX1ClassRoute("x1"), true);
  assert.equal(isX1ClassRoute("x1_reverse"), true);
  assert.equal(isX1ClassRoute("x1_onward"), true);
  assert.equal(isX1ClassRoute("direct"), false);
  // The param the client builds (and the server re-forces): 0 vs 0.01.
  assert.equal(lifiIntegratorFeeFor("x1"), 0);
  assert.equal(lifiIntegratorFeeFor("x1_onward"), 0);
  assert.equal(lifiIntegratorFeeFor("sol_x1"), 0);
  assert.equal(lifiIntegratorFeeFor("x1_reverse"), 0);
  assert.equal(lifiIntegratorFeeFor("direct"), FEE_RATES.LIFI_INTEGRATOR); // 0.01
});

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING GUARDS — no fee currently charged may silently disappear
// ─────────────────────────────────────────────────────────────────────────────
test("old→new mapping: every fee charged today is represented in FEE_RATES", () => {
  assert.equal(FEE_RATES.X1_HOP_SKIM, 0.01);      // old: SKIM_BPS=100 / 1% skim
  assert.equal(FEE_RATES.LIFI_INTEGRATOR, 0.01);  // old: INTEGRATOR_FEE on every LiFi quote (now: non-X1 only)
  assert.equal(FEE_RATES.WARP_FLAT_USD, 1);       // old: WARP_FLAT_FEE $1 (now: third-party pass-through)
  // POLICY (2026-08-28): both spec rates were superseded — the policy sets the
  // fee at exactly 1% once per journey and caps EVERY class at 1% Teleporter
  // take. The runbook's 0.5% same-chain and 5% escape-hatch headlines no
  // longer apply (no escape-hatch path exists, so no money moved).
  assert.equal(FEE_RATES.SAME_CHAIN, 0.01);       // policy: 1% once (supersedes runbook 0.5%)
  assert.equal(FEE_RATES.ESCAPE_HATCH, 0.01);     // policy: 1% cap (supersedes runbook 5%)
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
  assert.equal(fee.teleporterFeeUsd(500), 5);
});
