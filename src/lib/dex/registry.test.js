/**
 * dex/registry.test.js — the DEX venue registry: verified-only routing, fail-closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEX_REGISTRY, venuesFor, hasVenues } from "../dex/registry.js";

test("eth has multiple verified venues (Uniswap V2/V3 + Balancer + Sushi)", () => {
  const ids = venuesFor("eth").map((v) => v.id).sort();
  assert.ok(ids.includes("uni-v2"));
  assert.ok(ids.includes("uni-v3"));
  assert.ok(ids.includes("balancer"));
  assert.ok(ids.includes("sushi"));
});

test("unverified placeholders are dropped (fail closed)", () => {
  // curve + uni-v4 on eth remain unverified -> not routable
  const ids = venuesFor("eth").map((v) => v.id);
  assert.ok(!ids.includes("curve"));
  assert.ok(!ids.includes("uni-v4"));
  // cardano still has only unverified placeholders -> no venues
  assert.equal(venuesFor("cardano").length, 0);
  assert.equal(hasVenues("cardano"), false);
});

test("the ported venue registry now carries the verified Sui + Solana venues", () => {
  // Headline port (Starport → V2): Sui's Cetus/Turbos/DeepBook and Solana's
  // Raydium/Orca/Meteora are now VERIFIED (were null/false in V2's partial
  // registry), so the MEV/routing surface sees real routers on those chains.
  const sui = venuesFor("sui")
    .map((v) => v.id)
    .sort();
  assert.deepEqual(sui, ["cetus", "deepbook", "turbos"]);
  assert.equal(hasVenues("sui"), true);
  const sol = venuesFor("sol")
    .map((v) => v.id)
    .sort();
  assert.deepEqual(sol, ["meteora", "orca", "raydium", "raydium-amm"]);
  assert.equal(hasVenues("sol"), true);
});

test("every verified venue has a router (never a null router while verified)", () => {
  for (const [chain, list] of Object.entries(DEX_REGISTRY)) {
    for (const v of list) {
      if (v.verified) {
        assert.ok(v.router, `${chain}.${v.id}: verified but router is null`);
      }
    }
  }
});

test("the registry is frozen (no runtime mutation of the MEV surface)", () => {
  assert.ok(Object.isFrozen(DEX_REGISTRY));
  assert.ok(Object.isFrozen(DEX_REGISTRY.eth));
});

test("near + ton carry their verified native-DEX venues (Ref Finance; STON.fi + DeDust)", () => {
  // 2026-09-29 pass — addresses verified from each protocol's OWN SDK
  // (docs/NEAR-TON-DEX-RESEARCH.md). Unverified NEAR/TON venues stay dropped
  // (fail closed).
  const near = venuesFor("near").map((v) => v.id).sort();
  assert.deepEqual(near, ["ref-finance", "trisolaris"]);
  assert.equal(hasVenues("near"), true);

  const ton = venuesFor("ton").map((v) => v.id).sort();
  assert.deepEqual(ton, ["dedust", "stonfi"]);
  assert.equal(hasVenues("ton"), true);

  // Ref Finance = the v2 exchange contract; STON.fi = the v1 router.
  assert.equal(DEX_REGISTRY.near.find((v) => v.id === "ref-finance").router, "v2.ref-finance.near");
  assert.equal(DEX_REGISTRY.ton.find((v) => v.id === "stonfi").router, "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt");
});

test("near + ton unverified venues are present but NOT routable (fail closed)", () => {
  const unverified = (chain) => DEX_REGISTRY[chain].filter((v) => !v.verified).map((v) => v.id).sort();
  assert.deepEqual(unverified("near"), ["jumbo", "orderly", "spin"]);
  assert.deepEqual(unverified("ton"), ["megaton", "tonco"]);
  for (const chain of ["near", "ton"]) {
    for (const v of DEX_REGISTRY[chain].filter((x) => !x.verified)) {
      assert.equal(v.router, null, `${chain}.${v.id} unverified rows must carry router:null`);
    }
  }
});
