/**
 * mevSimulationFixtures.test.js — the MEV-capture SIMULATION fixtures
 * rebuild test (the simulation oracle, offline).
 *
 * The simulation (tools/simulate-mev-capture.mjs) captured REAL quotes
 * against live pool state and wrote per-round evidence files. This test
 * re-runs the DETECTOR over the frozen evidence with the recorded gas and
 * asserts the detection reproduces byte-for-byte (gap bps, net bps, net
 * value, wouldCapture, route) — the same discipline as the golden oracles:
 * the engine must reproduce the recorded numbers from the recorded quotes,
 * or this test fails. Also asserts the fixtures are REAL-labeled (no
 * synthetic quotes on the evidence path).
 *
 * Pure/offline — frozen fixtures, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectCaptureGap } from "../src/lib/mev/gapDetector.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "test", "fixtures", "golden", "mev-capture");
const INPUTS = join(FIXTURES, "inputs");
const DOCS_JSON = join(here, "..", "docs", "mev-simulation-2026-09-06.json");

const evidenceFiles = () =>
  readdirSync(INPUTS).filter((f) => f.startsWith("round-") && f.endsWith("-evidence.json")).sort();

test("mev-sim fixtures: the 8-round × 4-chain evidence set is present and REAL-labeled", () => {
  const files = evidenceFiles();
  assert.equal(files.length, 32, "8 rounds × 4 chains (eth/arb/bsc/sol) of evidence files");
  const chains = new Set(files.map((f) => f.split("-")[2]));
  assert.deepEqual([...chains].sort(), ["arb", "bsc", "eth", "sol"]);
  for (const f of files) {
    const ev = JSON.parse(readFileSync(join(INPUTS, f), "utf8"));
    for (const side of ["buy", "sell"]) {
      for (const q of ev[side] || []) {
        if (!q.amountOut) continue; // an ok:false record (revert / aggregator skip)
        assert.match(String(q.source), /REAL-live/, `${f} ${side} ${q.dex}: quotes are REAL captures (got ${q.source})`);
      }
    }
  }
});

test("mev-sim fixtures: the detector REPRODUCES every recorded detection from the frozen quotes", () => {
  const docs = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
  const byRoundChain = new Map();
  for (const d of docs.detections) byRoundChain.set(`${d.round}:${d.chain}`, d);
  const gas = docs.gas || {};

  const files = evidenceFiles();
  let checked = 0;
  for (const f of files) {
    const ev = JSON.parse(readFileSync(join(INPUTS, f), "utf8"));
    const round = ev.round;
    const chain = ev.chain;
    const recorded = byRoundChain.get(`${round}:${chain}`);
    assert.ok(recorded, `${f}: a recorded detection exists for round ${round} ${chain}`);

    const ok = (list) => (list || []).filter((q) => q.ok !== false && q.amountOut !== undefined && q.amountOut !== null);
    const buyQuotes = ok(ev.buy).map((q) => ({ dex: q.dex, pool: q.pool ?? null, amountIn: q.amountIn, amountOut: q.amountOut }));
    const sellQuotes = ok(ev.sell).map((q) => ({ dex: q.dex, pool: q.pool ?? null, amountIn: q.amountIn, amountOut: q.amountOut }));
    assert.ok(buyQuotes.length >= 1 && sellQuotes.length >= 1, `${f}: both legs quoted`);

    const gasUnits = gas[round]?.[chain]?.gasCostQuoteUnits ?? "0";
    const det = detectCaptureGap({
      pair: { from: ev.pair?.from ?? null, to: ev.pair?.to ?? null },
      chain,
      buyQuotes,
      sellQuotes,
      gasCostQuoteUnits: gasUnits,
    });

    assert.equal(det.gapBps, recorded.gapBps, `${f}: gapBps reproduces`);
    assert.equal(det.netRoundTripBps, recorded.netRoundTripBps, `${f}: netRoundTripBps reproduces`);
    assert.equal(det.wouldCapture, recorded.wouldCapture, `${f}: wouldCapture reproduces`);
    assert.deepEqual(det.route, recorded.route ?? [], `${f}: route reproduces`);
    if (recorded.netValueAfterCostsRaw !== null && recorded.netValueAfterCostsRaw !== undefined) {
      assert.equal(det.netValueAfterCostsRaw, recorded.netValueAfterCostsRaw, `${f}: netValueAfterCostsRaw reproduces`);
    }
    checked++;
  }
  assert.equal(checked, 32, "all 32 evidence files re-ran and matched their recorded detections");
});

test("mev-sim fixtures: capture-log quotes are parseable and the summary is honest (0 economically capturable)", () => {
  const log = JSON.parse(readFileSync(join(FIXTURES, "capture-log.json"), "utf8"));
  assert.ok(log.length >= 100, `a real quote log exists (${log.length} quotes)`);
  for (const q of log) {
    assert.doesNotThrow(() => BigInt(q.amountIn) && BigInt(q.amountOut), `quote ${q.dex} ${q.chain} parses`);
    assert.ok(q.dex && q.chain && q.source);
  }
  const docs = JSON.parse(readFileSync(DOCS_JSON, "utf8"));
  assert.ok(docs.summary.total >= 32, "the report summarized the detections");
  assert.equal(docs.economic.economicallyCapturable, 0, "the honest bar: zero economically capturable round trips in the sample");
  assert.ok(docs.economic.byChain.sol.wouldCapture >= 4, "the strict-math positives were all Solana noise-level nets");
  for (const d of docs.detections) {
    if (d.wouldCapture) {
      assert.ok(d.netValueAfterCostsUsd !== null && d.netValueAfterCostsUsd < 0.1, "strict positives are all sub-$0.10 noise");
    }
  }
});
