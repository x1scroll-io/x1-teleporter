/**
 * routeUnsupported.test.js — the reason-bearing planner contract.
 *
 * Proves the #4 fix: an unplannable route must carry a REASON, never a silent null,
 * while `plan()` keeps its original null semantics so existing callers don't break.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { plan, planOrExplain, classifyRoute, unsupportedReason } from "../src/engine/routePlanner.js";

test("plan() still returns null for unplanned lanes (backward compatibility)", () => {
  assert.equal(plan({ direction: "dex" }), null);
  assert.equal(plan({ direction: "nonsense" }), null);
  assert.equal(plan({ direction: "swap", via: "nope" }), null);
});

test("planOrExplain never returns null — unsupported carries a reason naming the direction", () => {
  const r = planOrExplain({ direction: "nonsense" });
  assert.equal(r.routeKind, "unsupported");
  assert.equal(r.route, null);
  assert.ok(typeof r.reason === "string" && r.reason.length > 20, "reason must be substantive");
  assert.match(r.reason, /direction="nonsense"/);
});

test("planOrExplain names the bad via for swap lanes", () => {
  const r = planOrExplain({ direction: "swap", via: "nope" });
  assert.equal(r.routeKind, "unsupported");
  assert.match(r.reason, /via="nope"/);
  assert.match(r.reason, /jupiter \| xdex \| lifi \| dexDirect/);
});

test("planOrExplain classifies supported routes and still exposes reason=null", () => {
  const fwd = planOrExplain({ direction: "forward" });
  assert.equal(fwd.routeKind, "x1-class");
  assert.ok(fwd.route, "forward must plan");
  assert.equal(fwd.reason, null);

  const rev = planOrExplain({ direction: "reverse" });
  assert.equal(rev.routeKind, "x1-class");

  const sw = planOrExplain({ direction: "swap", via: "jupiter" });
  assert.equal(sw.routeKind, "same-chain");

  const th = planOrExplain({ direction: "thorchain" });
  assert.equal(th.routeKind, "cross-chain");
});

test("classifyRoute maps every planned direction (and null for no route)", () => {
  assert.equal(classifyRoute(null), null);
  assert.equal(classifyRoute({ direction: "forward" }), "x1-class");
  assert.equal(classifyRoute({ direction: "reverse" }), "x1-class");
  assert.equal(classifyRoute({ direction: "swap" }), "same-chain");
  assert.equal(classifyRoute({ direction: "thorchain" }), "cross-chain");
  assert.equal(classifyRoute({ direction: "rango" }), "cross-chain");
  assert.equal(classifyRoute({ direction: "wanchain" }), "cross-chain");
});

test("unsupportedReason is deterministic and actionable (no empty strings)", () => {
  const a = unsupportedReason({ direction: "dex" });
  const b = unsupportedReason({ direction: "dex" });
  assert.equal(a, b);
  assert.ok(a.includes("forward | reverse"));
  assert.ok(unsupportedReason({ direction: "swap" }).includes("via="));
});
