/**
 * mevMultihopSimulationFixtures.test.js — the MULTI-HOP simulation fixtures
 * rebuild test (the simulation oracle, offline).
 *
 * The simulation (tools/simulate-mev-multihop.mjs) captured REAL per-leg
 * venue quotes against live pool state and wrote per-route evidence files.
 * This test re-runs the ROUTE ANALYZER over the frozen evidence and asserts
 * the analysis reproduces the recorded headline fields (wouldCapture,
 * economical, route $/bps, optimal sub-path) — the same discipline as the
 * golden oracles: the engine must reproduce the recorded numbers from the
 * recorded quotes, or this test fails. Also asserts the fixtures are
 * REAL-labeled (live captures + the explicitly-labeled DOCUMENTED warp-skim
 * constant + recorded skips — no synthetic quotes on the evidence path).
 *
 * Pure/offline — frozen fixtures, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeRoute } from "../src/lib/mev/routeAnalyzer.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "test", "fixtures", "golden", "mev-multihop");
const INPUTS = join(FIXTURES, "inputs");
const DOCS_JSON = join(here, "..", "docs", "mev-multihop-simulation-2026-09-06.json");

const evidenceFiles = () =>
  readdirSync(INPUTS).filter((f) => f.startsWith("route-") && f.endsWith(".json")).sort();

test("mev-multihop fixtures: the route evidence set is present and REAL-labeled", () => {
  const files = evidenceFiles();
  assert.ok(files.length >= 14, `3 rounds × 7 route archetypes minus failures (got ${files.length})`);
  const routeIds = new Set(files.map((f) => f.replace(/^route-\d+-/, "").replace(/\.json$/, "")));
  assert.ok(routeIds.has("sol-ape-2500-down"), "the core ape route is present");
  assert.ok(routeIds.has("evm-x1-stable-2500-down"), "the stable control is present");
  assert.ok(routeIds.has("x1-exotic-2500-down"), "the X1-exotic route is present");
  for (const f of files) {
    const ev = JSON.parse(readFileSync(join(INPUTS, f), "utf8"));
    assert.ok(Array.isArray(ev.legs) && ev.legs.length >= 1, `${f}: legs present`);
    for (const leg of ev.legs) {
      for (const q of leg.quotes || []) {
        const src = String(q.source ?? "");
        if (/skip/i.test(src) || /DOCUMENTED-warp/.test(src)) continue; // recorded skips + the labeled Warp constant
        assert.match(src, /REAL-live|REAL-xdex|REAL-/i, `${f} hop ${leg.hop} ${q.venue}: quotes are REAL captures (got ${src})`);
        assert.doesNotThrow(() => BigInt(q.amountIn) && BigInt(q.amountOut), `${f} ${q.venue}: amounts parse`);
      }
      assert.ok(leg.venueChosen, `${f} hop ${leg.hop}: venueChosen present`);
    }
  }
});

test("mev-multihop fixtures: the analyzer REPRODUCES every recorded route analysis from the frozen quotes", () => {
  const docs = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
  const recorded = new Map((docs.detections || []).map((d) => [`${d.round}:${d.routeId}`, d]));
  const files = evidenceFiles();
  let checked = 0;
  for (const f of files) {
    const ev = JSON.parse(readFileSync(join(INPUTS, f), "utf8"));
    const rec = recorded.get(`${ev.round}:${ev.routeId}`);
    assert.ok(rec, `${f}: a recorded analysis exists for round ${ev.round} ${ev.routeId}`);
    const a = analyzeRoute({ id: ev.routeId, legs: ev.legs });
    assert.equal(a.wouldCapture, rec.wouldCapture, `${f}: wouldCapture reproduces`);
    assert.equal(a.economical, rec.economical, `${f}: economical reproduces`);
    assert.equal(a.routeGapUsd, rec.routeGapUsd, `${f}: routeGapUsd reproduces`);
    assert.equal(a.routeNetUsd, rec.routeNetUsd, `${f}: routeNetUsd reproduces`);
    assert.equal(a.routeGapBps, rec.routeGapBps, `${f}: routeGapBps reproduces`);
    assert.deepEqual(a.optimalRoute, rec.optimalRoute ?? [], `${f}: optimalRoute reproduces`);
    assert.equal(a.legs.length, rec.legs?.length ?? a.legs.length, `${f}: leg count matches`);
    for (let i = 0; i < a.legs.length; i++) {
      assert.equal(a.legs[i].gapBps, rec.legs?.[i]?.gapBps, `${f} hop ${a.legs[i].hop}: gapBps reproduces`);
      assert.equal(a.legs[i].gapUsd, rec.legs?.[i]?.gapUsd, `${f} hop ${a.legs[i].hop}: gapUsd reproduces`);
      assert.equal(a.legs[i].singleVenue, rec.legs?.[i]?.singleVenue, `${f} hop ${a.legs[i].hop}: singleVenue reproduces`);
    }
    checked++;
  }
  assert.equal(checked, files.length, "every evidence file re-ran and matched its recorded analysis");
});

test("mev-multihop fixtures: the docs report summarizes the recorded analyses honestly", () => {
  const docs = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
  const s = docs.summary || {};
  assert.ok(docs.gate?.MEV_CAPTURE_ENABLED === false, "the report records the gate: gated OFF");
  assert.match(docs.gate?.label ?? "", /gated OFF/);
  assert.ok(s.total >= 14, `the summary covered the routes (${s.total})`);
  assert.equal(s.economicallyCapturable + s.alreadyOptimal + s.costNotCleared + s.belowEconomicBar, s.total, "summary buckets partition the routes");
  assert.ok(s.legsAnalyzed >= s.legsWithVenueChoice, "legs counted consistently");
  const legGap = s.perLegGapBps || {};
  assert.ok(legGap.max !== null && legGap.max <= 50, "per-leg spreads are sane single-digit-to-low-double-digit bps");
  // every recorded route carries the honest whyNot / economical fields
  for (const d of docs.detections || []) {
    assert.equal(typeof d.wouldCapture, "boolean");
    assert.equal(typeof d.economical, "boolean");
    assert.ok(Array.isArray(d.legs));
  }
});
