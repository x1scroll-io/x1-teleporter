/**
 * capture-reverse-golden-fixtures.mjs — regenerate the REVERSE-leg
 * golden-transaction fixtures (Phase 2 of the routing-engine migration).
 *
 * WHAT IT DOES
 *   Rebuilds the reverse leg's three steps from the FIXED sample input
 *   (test/golden/reverseLegBuilders.mjs SAMPLE_INPUT) + the FROZEN live
 *   quote (test/fixtures/golden/reverse-leg/quote-wsol-usdc-eth-0.39501.json),
 *   and writes the fixtures under test/fixtures/golden/reverse-leg/:
 *     step1-x1-burn.json        — the X1 reverse burn tx (serialized)
 *     step2-release-shape.json  — the bridge_in_v2 native-variant spec +
 *                                 derivable account list + release math
 *     step3-lifi-out.json       — the deterministic LiFi query (toAddress PIN)
 *     reverse-leg-summary.json  — sample input, derived amounts, sha256s
 *
 *   The capture is OFFLINE + deterministic: no network, no wallet, no chain.
 *   The frozen quote stands in for the LiFi network call (the oracle is about
 *   tx/query construction given the same inputs — not the live quote).
 *
 * USAGE
 *   node --import ./tools/jsx-loader.mjs tools/capture-reverse-golden-fixtures.mjs
 *
 * The committed fixtures were captured 2026-09-02 from the live v2 proxy
 * (relaydepository route, 0.39501 WSOL → USDC on eth — see the quote
 * fixture's meta + the ground-truth txs in the builders' notes).
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureReverseLeg } from "../test/golden/reverseLegBuilders.mjs";
import { deriveReverseQuote } from "../src/lib/reverseQuote.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const FIXTURE_DIR = join(repo, "test", "fixtures", "golden", "reverse-leg");
const QUOTE_PATH = join(FIXTURE_DIR, "quote-wsol-usdc-eth-0.39501.json");

function write(name, obj) {
  const path = join(FIXTURE_DIR, name);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  console.log(`wrote ${path}`);
}

mkdirSync(FIXTURE_DIR, { recursive: true });

// ── 0. The frozen live quote (INPUT — stands in for the LiFi network) ──
let quote;
try {
  quote = JSON.parse(readFileSync(QUOTE_PATH, "utf8"));
} catch {
  console.error(
    `Missing frozen quote fixture: ${QUOTE_PATH}\n` +
      "Capture it first (read-only GET through the stable v2 proxy), then re-run."
  );
  process.exit(1);
}

const capture = await captureReverseLeg({ quote });

// ── The quote-box display strings — computed by the REAL fee code
//    (quoteFees via deriveReverseQuote) so the browser harness asserts
//    against the same reference math the golden fixtures capture. ──
const dq = deriveReverseQuote({
  data: quote,
  to: capture.sampleInput.to,
  amount: capture.sampleInput.amountUser,
  token: capture.sampleInput.token,
  toToken: capture.sampleInput.toToken,
});
const quoteBox = {
  youSend: `${capture.sampleInput.amountUser} ${capture.sampleInput.token} on X1`,
  feeLines: dq.feeLines.map((l) => ({
    id: l.id,
    label: l.label,
    display: `$${l.amountUsd.toFixed(2)}`,
  })),
  youReceive: `≈ ${dq.net.toFixed(2)} ${dq.recvToken} on ${dq.recvChain}`,
  steps: dq.steps.map((s) => `${s.tool} · ${s.name}`),
  solanaAmount: dq.solanaAmount,
  teleporterFeeUsd: dq.teleporterFeeUsd,
  thirdPartyFeeUsd: dq.thirdPartyFeeUsd,
  netUsd: dq.net,
};

// ── Write the per-step fixtures (names mirror reverse-leg-summary.json) ──
const STEP_FILES = {
  step1: "step1-x1-burn.json",
  step2: "step2-release-shape.json",
  step3: "step3-lifi-out.json",
};
for (const key of Object.keys(STEP_FILES)) {
  const s = capture.steps[key];
  write(STEP_FILES[key], {
    step: s.step,
    sampleInput: capture.sampleInput,
    artifact: s.artifact,
    sha256: s.sha256,
    ...(s.bytesSha256 ? { bytesSha256: s.bytesSha256 } : {}),
    ...(s.spec ? { spec: s.spec, specSha256: s.specSha256 } : {}),
    meta: s.meta,
  });
}

// ── Summary (the report's source of truth) ──
const summary = {
  tool: "golden-transaction fixtures — reverse leg X1→ETH (regression oracle, Phase 2)",
  capturedAt: new Date().toISOString(),
  groundTruth: {
    note: "captured from last night's WORKING reverse run (delivered USDC to Ethereum) + the live txs",
    x1BurnTx: "3q7H3kV4ZrrUPEbQ37DQv1cWRNmJ2V4pSMYZV3xCDYr8VrD58YZV9irDiveeCaYVmBqCxTu3cmxrXhepgJxegPe1",
    solanaReleaseTx: "v6etkXX21dQdfeZf6TabWMv16PEQoKBLhHPEQGnriSkcRRkUgfYkb5jAd2q8KCwuHxSwyYqGExb4PY4rHCGszbk",
    lifiTx: "25fvaCmtgb4EKhwETLgXG3npQqgHcJeGo6VyXxJXMMBtgrhv94ejs2jXSZt8L6NThzuQvBxi2Azt2fwwJhkRRd6q",
    ethReceivingLeg: "0xaf0f3546ec52b349dafb1e9de863e690689ba6562b074b63fb1dd94e07c85284",
  },
  sampleInput: capture.sampleInput,
  derived: capture.derived,
  quoteReference: capture.quoteReference,
  quoteBox,
  steps: {
    step1X1Burn: {
      file: "step1-x1-burn.json",
      sha256: capture.steps.step1.sha256,
      bytesSha256: capture.steps.step1.bytesSha256,
      seq: capture.steps.step1.artifact.seq,
      skimBase: capture.steps.step1.artifact.skimBase,
      bridgeBase: capture.steps.step1.artifact.bridgeBase,
    },
    step2ReleaseShape: {
      file: "step2-release-shape.json",
      sha256: capture.steps.step2.sha256,
      specSha256: capture.steps.step2.specSha256,
      releaseBase: capture.steps.step2.artifact.releaseBase,
    },
    step3LifiOut: {
      file: "step3-lifi-out.json",
      sha256: capture.steps.step3.sha256,
      toAddress: capture.steps.step3.artifact.toAddress, // THE PIN
    },
  },
  verify: "test/goldenReverse.test.js rebuilds every step from the same inputs and asserts byte-identical + sha256 match + the pinned toAddress.",
};
write("reverse-leg-summary.json", summary);

console.log("\n── reverse-leg golden fixtures captured ──");
for (const [k, v] of Object.entries(summary.steps)) {
  console.log(`  ${k}: sha256=${v.sha256}${v.bytesSha256 ? ` bytesSha256=${v.bytesSha256}` : ""}`);
}
console.log(`\nquote toAddress (PINNED EVM destination): ${summary.quoteReference.toAddress}`);
console.log(`quote txPayloadSha256 (LiFi Solana tx bytes): ${summary.quoteReference.txPayloadSha256}`);
