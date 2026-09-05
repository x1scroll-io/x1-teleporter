/**
 * engineRango.test.js — engine coverage for the Phase-5 Rango route:
 * RoutePlanner shape (planRango + plan({direction:"rango"}) + the
 * RANGO_LEG_IDS/RANGO_STAGES contract), the rango-quote leg's build
 * artifact, and — the critical guard — the rango-execute leg's submit()
 * throwing RangoLiveTestGateError: the swap-execution anchor is READY FOR
 * LIVE TEST and is NOT wired for autonomous broadcast (no live funds are
 * ever moved by this leg or any test here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RoutePlanner,
  planRango,
  plan,
  RANGO_LEG_IDS,
  RANGO_STAGES,
  buildRangoLegs,
  legById,
} from "../src/engine/routePlanner.js";
import { runLeg } from "../src/engine/legContract.js";
import {
  RangoLiveTestGateError,
  RANGO_LIVE_TEST_GATE_MESSAGE,
  shapeRangoSwapRequestArtifact,
  createRangoExecuteLeg,
} from "../src/engine/legs/rango/rangoExecuteLeg.js";
import { createRangoQuoteLeg } from "../src/engine/legs/rango/rangoQuoteLeg.js";
import { RANGO_SOURCES } from "../src/lib/rango/config.js";

const SOL_DEST = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

test("rango engine: planRango plans the two-leg route shape (quote gate → guarded execute)", () => {
  const route = planRango({ source: "sui" });
  assert.equal(route.id, "rango-sui-sol");
  assert.equal(route.direction, "rango");
  assert.equal(route.sourceChain, "sui");
  assert.equal(route.destChain, "sol");
  assert.deepEqual(route.legs.map((l) => l.id), RANGO_LEG_IDS);
  assert.deepEqual(route.legs.map((l) => l.id), ["rango-quote", "rango-execute"]);
  // Stage grouping covers every leg exactly once.
  const staged = Object.values(route.stages).flatMap((s) => s.legIds);
  assert.deepEqual(staged, RANGO_LEG_IDS);
  assert.equal(route.stages.quote.legIds[0], "rango-quote");
  assert.equal(route.stages.execute.legIds[0], "rango-execute");
  // Other sources plan the same shape with their own id.
  assert.equal(planRango({ source: "btc" }).id, "rango-btc-sol");
  assert.equal(planRango({ source: "xrpl" }).id, "rango-xrpl-sol");
  // Both legs are family external (no in-app signer exists for the lane).
  for (const leg of route.legs) assert.equal(leg.family, "external");
});

test("rango engine: the planner entry plans direction rango; RoutePlanner exposes the surface", () => {
  const viaEntry = plan({ direction: "rango", source: "sui" });
  assert.equal(viaEntry.id, "rango-sui-sol");
  assert.equal(plan({ direction: "rango" }).id, planRango().id, "entry routes to planRango");
  assert.equal(plan({ direction: "swap", via: "jupiter" }).id, "swap-sol-sol-jupiter", "existing directions untouched");
  assert.equal(plan({ direction: "nonsense" }), null);
  assert.equal(RoutePlanner.planRango({ source: "btc" }).id, "rango-btc-sol");
  assert.deepEqual(RoutePlanner.RANGO_LEG_IDS, RANGO_LEG_IDS);
  assert.equal(RoutePlanner.RANGO_STAGES, RANGO_STAGES);
  assert.equal(legById(planRango(), "rango-quote").id, "rango-quote");
  assert.equal(buildRangoLegs().length, 2);
});

test("rango engine: the quote leg builds the canonical request artifact (raw base units, no referrer params)", async () => {
  const leg = createRangoQuoteLeg();
  const ctx = { source: "sui", amount: "100000000000", slippage: 1 };
  const results = {};
  const built = await leg.phases.build(ctx, results);
  assert.equal(built.needed, true);
  assert.equal(built.artifact.source, "sui");
  assert.equal(built.artifact.from, RANGO_SOURCES.sui.asset);
  assert.equal(built.artifact.to, "SOLANA.SOL");
  assert.equal(built.artifact.url, "/api/rango/quote?from=SUI.SUI&to=SOLANA.SOL&amount=100000000000&slippage=1");
  // Validation gates.
  await assert.rejects(() => leg.phases.build({ amount: "100" }), /source is required/);
  await assert.rejects(() => leg.phases.build({ source: "sui", amount: "0" }), /positive raw amount/);
  await assert.rejects(() => leg.phases.build({ source: "cardano", amount: "100" }), /unknown source/);
});

test("rango engine: the execute leg builds the canonical swap-create request (no placeholders)", async () => {
  const leg = createRangoExecuteLeg();
  const built = await leg.phases.build({
    source: "sui",
    amount: "100000000000",
    fromAddress: "0x1111111111111111111111111111111111111111",
    toAddress: SOL_DEST,
    slippage: 1,
    requestId: "1c695edb-9b6d-4501-a0f8-7035256e4301",
  });
  const artifact = built.artifact;
  assert.equal(artifact.source, "sui");
  assert.equal(artifact.from, "SUI.SUI");
  assert.equal(artifact.to, "SOLANA.SOL");
  assert.equal(artifact.fromAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(artifact.toAddress, SOL_DEST);
  assert.equal(artifact.params.disableEstimate, "true");
  assert.equal(artifact.params.requestId, "1c695edb-9b6d-4501-a0f8-7035256e4301");
  assert.equal(artifact.url.startsWith("/api/rango/swap?"), true);
  assert.ok(artifact.url.includes("fromAddress=") && artifact.url.includes("toAddress="));
  assert.equal(artifact.params.referrerFee, undefined, "no referrer fee while the placeholder is empty");
  // The destination record rides along (the run ctx needs decimals).
  assert.equal(artifact.destination.asset, "SOLANA.SOL");
  assert.equal(artifact.destination.decimals, 9);
  // Validation: no placeholder addresses ever. (shapeRangoSwapRequestArtifact
  // is a PURE sync function — assert.throws, not assert.rejects.)
  await assert.rejects(() => leg.phases.build({ source: "sui", amount: "1", toAddress: SOL_DEST }), /fromAddress/);
  await assert.rejects(() => leg.phases.build({ source: "sui", amount: "1", fromAddress: "0x1111111111111111111111111111111111111111" }), /toAddress/);
  assert.throws(
    () =>
      shapeRangoSwapRequestArtifact({
        source: "sui",
        amount: "1",
        fromAddress: "",
        toAddress: SOL_DEST,
      }),
    /no placeholders/
  );
});

test("rango engine: 🔴 THE GUARD — submit() always throws RangoLiveTestGateError (never broadcasts)", async () => {
  const leg = createRangoExecuteLeg();
  const ctx = {
    source: "sui",
    amount: "100000000000",
    fromAddress: "0x1111111111111111111111111111111111111111",
    toAddress: SOL_DEST,
  };
  // Direct submit call → the honest gate error.
  await assert.rejects(() => leg.phases.submit(ctx, {}), (err) => {
    assert.ok(err instanceof RangoLiveTestGateError, "throws RangoLiveTestGateError");
    assert.equal(err.name, "RangoLiveTestGateError");
    assert.match(err.message, /READY FOR LIVE TEST/);
    assert.match(err.message, /Mr\. Esters fires live tests/);
    assert.equal(err.message, RANGO_LIVE_TEST_GATE_MESSAGE);
    return true;
  });
  // runLeg propagates the throw (the contract: a throwing phase stops the leg).
  await assert.rejects(() => runLeg(leg, ctx), RangoLiveTestGateError);
  // The gate marker is on the leg metadata too (surfaced to operators).
  assert.equal(leg.meta.liveTestAnchor, "rango-swap-execution");
  // And the leg itself is the guarded stub: no simulate/requestSignature
  // phases exist — nothing here could sign or broadcast even accidentally.
  assert.equal(leg.phases.simulate, undefined);
  assert.equal(leg.phases.requestSignature, undefined);
});
