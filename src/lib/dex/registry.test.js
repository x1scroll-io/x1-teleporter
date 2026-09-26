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
