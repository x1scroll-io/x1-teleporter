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
  // curve + uni-v4 on eth are unverified -> not routable
  const ids = venuesFor("eth").map((v) => v.id);
  assert.ok(!ids.includes("curve"));
  assert.ok(!ids.includes("uni-v4"));
  // sui has only unverified placeholders -> no venues
  assert.equal(venuesFor("sui").length, 0);
  assert.equal(hasVenues("sui"), false);
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
