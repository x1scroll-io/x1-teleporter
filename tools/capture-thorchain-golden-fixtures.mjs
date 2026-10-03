/**
 * capture-thorchain-golden-fixtures.mjs — (re)generate the THORChain-leg
 * golden fixtures (Phase 3 of the routing-engine migration).
 *
 * WHAT IT DOES
 *   Rebuilds the THORChain lane's two steps from the FIXED sample input
 *   (test/golden/thorchainLegBuilders.mjs SAMPLE_INPUT) + the SYNTHETIC
 *   THORNode input bodies, and writes the fixtures under
 *   test/fixtures/golden/thorchain-leg/:
 *     inbound-addresses-body.json  — INPUT (synthetic /thorchain/inbound_addresses)
 *     quote-body-btc-sol.json      — INPUT (synthetic /thorchain/quote/swap body)
 *     step1-quote-request.json     — the quote request (canonical URL + sha256)
 *     step2-deposit-payload.json   — the vault address + deposit memo
 *     thorchain-leg-summary.json   — sample input, derived, sha256s, fee lines
 *
 *   The capture is OFFLINE + deterministic: no network, no wallet, no chain.
 *
 * LIVE-STATUS NOTE: the THORChain lane has NOT gone live yet (the aggregator
 * key is a parked item; the UI is flag-gated) — the INPUT bodies are
 * SYNTHETIC THORNode-shaped fixtures, loudly labeled. They pin the CURRENT
 * code's CONSTRUCTION as the oracle. On the first operator deposit, replace
 * the synthetic inputs with live read-only captures (same procedure as the
 * forward/reverse frozen quotes) and re-run this script.
 *
 * USAGE
 *   node --import ./tools/jsx-loader.mjs tools/capture-thorchain-golden-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureThorchainLeg } from "../test/golden/thorchainLegBuilders.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const FIXTURE_DIR = join(repo, "test", "fixtures", "golden", "thorchain-leg");

function write(name, obj) {
  const path = join(FIXTURE_DIR, name);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  console.log(`wrote ${path}`);
}

mkdirSync(FIXTURE_DIR, { recursive: true });

const capture = captureThorchainLeg();

// ── Input bodies (SYNTHETIC — the lane is not live yet) ──
write("inbound-addresses-body.json", {
  tool: "golden-transaction fixtures — THORChain leg (INPUT, synthetic)",
  note:
    "SYNTHETIC THORNode /thorchain/inbound_addresses body (the lane has NOT gone live — " +
    "no live capture exists yet). Shape mirrors what THORNode returns (a bare array of " +
    "vault entries; parseInboundAddresses accepts both the bare array and the " +
    "{ addresses: [...] } wrapper). DOGE is marked halted to pin the paused-chain gate. " +
    "Replace with a live capture on the first operator deposit.",
  body: capture.inputBodies.inbound,
});
write("quote-body-btc-sol.json", {
  tool: "golden-transaction fixtures — THORChain leg (INPUT, synthetic)",
  note:
    "SYNTHETIC THORNode /thorchain/quote/swap response body (the shape the proxy " +
    "api/thorchain/quote.js passes through verbatim). expected_amount_out is in THORChain " +
    "1e8 base units. SYNTHETIC — the aggregator key is a parked item server-side, so no " +
    "live quote exists yet. Replace with a live capture on the first operator deposit.",
  body: capture.inputBodies.quote,
});

// ── Per-step fixtures ──
const STEP_FILES = {
  step1: "step1-quote-request.json",
  step2: "step2-deposit-payload.json",
};
for (const key of Object.keys(STEP_FILES)) {
  const s = capture.steps[key];
  write(STEP_FILES[key], {
    step: s.step,
    sampleInput: capture.sampleInput,
    artifact: s.artifact,
    sha256: s.sha256,
    ...(s.urlSha256 ? { urlSha256: s.urlSha256 } : {}),
    ...(s.memoSha256 ? { memoSha256: s.memoSha256 } : {}),
    meta: s.meta,
  });
}

// ── Summary (the report's source of truth) ──
const summary = {
  tool: "golden-transaction fixtures — THORChain leg BTC→SOL.SOL (regression oracle, Phase 3)",
  capturedAt: new Date().toISOString(),
  liveStatus: {
    note:
      "The THORChain lane is the NEXT roadmap item — it has NOT gone live (aggregator key " +
      "parked server-side; UI flag-gated). The input bodies are SYNTHETIC THORNode-shaped " +
      "fixtures; the oracle pins the CURRENT code's CONSTRUCTION. The engine must reproduce " +
      "the artifacts exactly for the same inputs.",
    replaceWith: "On the first operator deposit: capture the live inbound_addresses body + a " +
      "read-only proxy quote (same procedure as the forward/reverse frozen quotes), then re-run " +
      "tools/capture-thorchain-golden-fixtures.mjs.",
  },
  sampleInput: capture.sampleInput,
  derived: capture.derived,
  steps: {
    step1QuoteRequest: {
      file: "step1-quote-request.json",
      sha256: capture.steps.step1.sha256,
      url: capture.steps.step1.artifact.url,
      urlSha256: capture.steps.step1.urlSha256,
    },
    step2DepositPayload: {
      file: "step2-deposit-payload.json",
      sha256: capture.steps.step2.sha256,
      depositAddress: capture.steps.step2.artifact.depositAddress,
      memo: capture.steps.step2.artifact.memo,
      memoSha256: capture.steps.step2.memoSha256,
    },
  },
  verify: "test/goldenThorchain.test.js rebuilds every step from the same inputs and asserts byte-identical + sha256 match + the deposit-address flow invariants (destination pin, no-affiliate, cap).",
};
write("thorchain-leg-summary.json", summary);

console.log("\n── thorchain-leg golden fixtures captured ──");
console.log(`  step1 quote-request : sha256=${summary.steps.step1QuoteRequest.sha256}`);
console.log(`  step2 deposit-payload: sha256=${summary.steps.step2DepositPayload.sha256}`);
console.log(`  url   : ${summary.steps.step1QuoteRequest.url}`);
console.log(`  memo  : ${summary.steps.step2DepositPayload.memo}`);
