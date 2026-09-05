/**
 * engineWanchain.test.js — engine coverage for the Wanchain-family route
 * (XFlows v3): RoutePlanner shape (planWanchain + plan({direction:
 * "wanchain"}) + the WANCHAIN_LEG_IDS/WANCHAIN_STAGES contract), the
 * wanchain-quote leg's build artifact + its coverage gate, and — the
 * critical guard — the wanchain-execute leg's submit() throwing
 * WanchainLiveTestGateError: the transfer-execution anchor is READY FOR
 * LIVE TEST and is NOT wired for autonomous broadcast (no live funds are
 * ever moved by this leg or any test here).
 *
 * VERIFIED CONTEXT (2026-09-05 — see test/fixtures/golden/wanchain-leg/):
 * the Wanchain-family quote API serves EVM-chain pairs only; every non-EVM
 * probe failed. The leg's coverage gate therefore refuses non-registry
 * sources at build time — the tests pin that gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RoutePlanner,
  planWanchain,
  plan,
  WANCHAIN_LEG_IDS,
  WANCHAIN_STAGES,
  buildWanchainLegs,
  legById,
} from "../src/engine/routePlanner.js";
import { runLeg } from "../src/engine/legContract.js";
import {
  WanchainLiveTestGateError,
  WANCHAIN_LIVE_TEST_GATE_MESSAGE,
  shapeWanchainBuildTxRequestArtifact,
  createWanchainExecuteLeg,
} from "../src/engine/legs/wanchain/wanchainExecuteLeg.js";
import { createWanchainQuoteLeg } from "../src/engine/legs/wanchain/wanchainQuoteLeg.js";
import { WANCHAIN_SOURCES, WANCHAIN_NATIVE_ADDRESS } from "../src/lib/wanchain/config.js";

const EVM_FROM = "0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200";
const SOL_DEST = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

test("wanchain engine: planWanchain plans the two-leg route shape (quote gate → guarded execute)", () => {
  const route = planWanchain({ source: "eth" });
  assert.equal(route.id, "wanchain-eth");
  assert.equal(route.direction, "wanchain");
  assert.equal(route.sourceChain, "eth");
  assert.equal(route.destChain, "sol");
  assert.deepEqual(route.legs.map((l) => l.id), WANCHAIN_LEG_IDS);
  assert.deepEqual(route.legs.map((l) => l.id), ["wanchain-quote", "wanchain-execute"]);
  // Stage grouping covers every leg exactly once.
  const staged = Object.values(route.stages).flatMap((s) => s.legIds);
  assert.deepEqual(staged, WANCHAIN_LEG_IDS);
  assert.equal(route.stages.quote.legIds[0], "wanchain-quote");
  assert.equal(route.stages.execute.legIds[0], "wanchain-execute");
  // Both legs are family external (no in-app signer exists for the lane).
  for (const leg of route.legs) assert.equal(leg.family, "external");
});

test("wanchain engine: the planner entry plans direction wanchain; RoutePlanner exposes the surface", () => {
  const viaEntry = plan({ direction: "wanchain", source: "eth" });
  assert.equal(viaEntry.id, "wanchain-eth");
  assert.equal(plan({ direction: "wanchain" }).id, planWanchain().id, "entry routes to planWanchain");
  assert.equal(plan({ direction: "rango" }).id, "rango-sui-sol", "existing directions untouched");
  assert.equal(plan({ direction: "forward" }).id, "forward-eth-x1", "existing directions untouched");
  assert.equal(plan({ direction: "nonsense" }), null);
  assert.equal(RoutePlanner.planWanchain({ source: "eth" }).id, "wanchain-eth");
  assert.deepEqual(RoutePlanner.WANCHAIN_LEG_IDS, WANCHAIN_LEG_IDS);
  assert.equal(RoutePlanner.WANCHAIN_STAGES, WANCHAIN_STAGES);
  assert.equal(legById(planWanchain(), "wanchain-quote").id, "wanchain-quote");
  assert.equal(buildWanchainLegs().length, 2);
});

test("wanchain engine: the quote leg builds the canonical request artifact (whitelisted body, human units)", async () => {
  const leg = createWanchainQuoteLeg();
  const ctx = {
    source: "eth",
    toChainId: 888,
    toTokenAddress: WANCHAIN_NATIVE_ADDRESS,
    fromAddress: EVM_FROM,
    toAddress: EVM_FROM,
    fromAmount: "10",
  };
  const built = await leg.phases.build(ctx, {});
  assert.equal(built.needed, true);
  assert.equal(built.artifact.source, "eth");
  assert.equal(built.artifact.fromChainId, WANCHAIN_SOURCES.eth.chainId);
  assert.equal(built.artifact.method, "POST");
  assert.equal(built.artifact.url, "/api/wanchain/quote");
  assert.equal(built.artifact.body.fromAmount, "10");
  assert.equal(built.artifact.body.slippage, 0.01, "explicit canonical slippage");
  // Validation gates (required fields, no placeholders).
  await assert.rejects(() => leg.phases.build({ source: "eth", fromAmount: "1" }), /toChainId is required/);
  await assert.rejects(
    () => leg.phases.build({ source: "eth", toChainId: 888, toTokenAddress: WANCHAIN_NATIVE_ADDRESS, fromAmount: "1", toAddress: EVM_FROM }),
    /fromAddress/
  );
  await assert.rejects(
    () => leg.phases.build({ source: "eth", toChainId: 888, toTokenAddress: WANCHAIN_NATIVE_ADDRESS, fromAmount: "0", fromAddress: EVM_FROM, toAddress: EVM_FROM }),
    /positive fromAmount/
  );
});

test("wanchain engine: 🔴 THE COVERAGE GATE — the quote leg refuses non-quotable sources at build time", async () => {
  const leg = createWanchainQuoteLeg();
  // The live-verified truth: the Wanchain-family API quotes EVM pairs only.
  // ADA/Sui/Polkadot/native-UTXO routes all FAILED live probes (fixtures in
  // test/fixtures/golden/wanchain-leg/) — the leg must refuse them HERE
  // with a clear message instead of building a request an upstream refuses.
  for (const wish of ["ada", "sui", "polkadot", "btc", "tron", "cardano"]) {
    await assert.rejects(
      () =>
        leg.phases.build({
          source: wish,
          toChainId: 501,
          toTokenAddress: WANCHAIN_NATIVE_ADDRESS,
          fromAddress: "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
          toAddress: SOL_DEST,
          fromAmount: "100",
        }),
      new RegExp(`source "${wish}" is not quotable`),
      `${wish}: coverage gate rejects`
    );
  }
  assert.deepEqual(Object.keys(WANCHAIN_SOURCES), ["eth"], "registry = the live-quotable set only");
});

test("wanchain engine: the execute leg builds the canonical buildTx request (no placeholders)", async () => {
  const leg = createWanchainExecuteLeg();
  const built = await leg.phases.build({
    source: "eth",
    toChainId: 888,
    toTokenAddress: WANCHAIN_NATIVE_ADDRESS,
    fromAddress: EVM_FROM,
    toAddress: EVM_FROM,
    fromAmount: "10",
    slippage: 0.01,
  });
  const artifact = built.artifact;
  assert.equal(artifact.source, "eth");
  assert.equal(artifact.method, "POST");
  assert.equal(artifact.url, "/api/wanchain/buildTx");
  assert.equal(artifact.body.fromAmount, "10");
  assert.equal(artifact.body.slippage, 0.01);
  // Validation: no placeholder addresses ever. (shapeWanchainBuildTxRequestArtifact
  // is a PURE sync function — assert.throws, not assert.rejects.)
  await assert.rejects(() => leg.phases.build({ source: "eth", toChainId: 888, fromAmount: "1", toAddress: EVM_FROM }), /fromAddress/);
  await assert.rejects(() => leg.phases.build({ source: "eth", toChainId: 888, fromAmount: "1", fromAddress: EVM_FROM }), /toAddress/);
  assert.throws(
    () =>
      shapeWanchainBuildTxRequestArtifact({
        source: "eth",
        toChainId: 888,
        toTokenAddress: WANCHAIN_NATIVE_ADDRESS,
        fromAddress: "",
        toAddress: EVM_FROM,
        fromAmount: "1",
      }),
    /no placeholders/
  );
});

test("wanchain engine: 🔴 THE GUARD — submit() always throws WanchainLiveTestGateError (never broadcasts)", async () => {
  const leg = createWanchainExecuteLeg();
  const ctx = {
    source: "eth",
    toChainId: 888,
    toTokenAddress: WANCHAIN_NATIVE_ADDRESS,
    fromAddress: EVM_FROM,
    toAddress: EVM_FROM,
    fromAmount: "10",
  };
  // Direct submit call → the honest gate error.
  await assert.rejects(() => leg.phases.submit(ctx, {}), (err) => {
    assert.ok(err instanceof WanchainLiveTestGateError, "throws WanchainLiveTestGateError");
    assert.equal(err.name, "WanchainLiveTestGateError");
    assert.match(err.message, /READY FOR LIVE TEST/);
    assert.match(err.message, /Mr\. Esters fires live tests/);
    assert.equal(err.message, WANCHAIN_LIVE_TEST_GATE_MESSAGE);
    return true;
  });
  // runLeg propagates the throw (the contract: a throwing phase stops the leg).
  await assert.rejects(() => runLeg(leg, ctx), WanchainLiveTestGateError);
  // The gate marker is on the leg metadata too (surfaced to operators).
  assert.equal(leg.meta.liveTestAnchor, "wanchain-buildtx-execution");
  // And the leg itself is the guarded stub: no simulate/requestSignature
  // phases exist — nothing here could sign or broadcast even accidentally.
  assert.equal(leg.phases.simulate, undefined);
  assert.equal(leg.phases.requestSignature, undefined);
});
