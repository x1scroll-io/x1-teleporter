/**
 * capture-golden-fixtures.mjs — regenerate the golden-transaction fixtures
 * (Tool 1 — the regression oracle for the routing-engine migration).
 *
 * WHAT IT DOES
 *   Rebuilds the forward leg's three transaction steps from the FIXED sample
 *   input (test/golden/forwardLegBuilders.mjs SAMPLE_INPUT) + the FROZEN
 *   live quote (test/fixtures/golden/forward-leg/quote-eth-sol-usdc-25.65.json),
 *   and writes the fixtures under test/fixtures/golden/forward-leg/:
 *     step1-approval.json        — exact-amount ERC-20 approval calldata + params
 *     step2a-x1-ata-prep.json    — X1 recipient ATA create tx (serialized)
 *     step2b-warp-lock.json      — the stage-2 Solana lock tx (serialized)
 *     step3-bridge-in-v2.json    — the 14-row spec + concrete account list
 *     forward-leg-summary.json   — sample input, derived amounts, sha256 per step
 *
 *   The capture is OFFLINE + deterministic: no network, no wallet, no chain.
 *   The frozen quote stands in for the LiFi network call (the oracle is about
 *   tx construction given the same inputs — not the live quote).
 *
 * USAGE
 *   node --import ./tools/jsx-loader.mjs tools/capture-golden-fixtures.mjs
 *
 * The committed fixtures were captured 2026-09-02 from the live v2 proxy
 * (Relay route, 25.65 USDC ETH→SOL — see the quote fixture's meta).
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureForwardLeg } from "../test/golden/forwardLegBuilders.mjs";
import { deriveQuoteFromLifi } from "../src/lib/teleportQuote.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const FIXTURE_DIR = join(repo, "test", "fixtures", "golden", "forward-leg");
const QUOTE_PATH = join(FIXTURE_DIR, "quote-eth-sol-usdc-25.65.json");

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

const capture = await captureForwardLeg({ quote });

// ── The quote-box display strings — computed by the REAL fee code (quoteFees
//    via deriveQuoteFromLifi) so the browser harness asserts against the same
//    reference math the golden fixtures capture, never hand-typed numbers. ──
const dq = deriveQuoteFromLifi({
  data: quote,
  from: capture.sampleInput.from,
  token: capture.sampleInput.token,
  amount: capture.sampleInput.amountUser,
  destToken: capture.sampleInput.destToken,
});
const quoteBox = {
  youSend: `${capture.sampleInput.amountUser} ${capture.sampleInput.token} on Ethereum`,
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

// ── Write the per-step fixtures (names mirror forward-leg-summary.json) ──
const STEP_FILES = {
  step1: "step1-approval.json",
  step2a: "step2a-x1-ata-prep.json",
  step2b: "step2b-warp-lock.json",
  step3: "step3-bridge-in-v2.json",
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
  tool: "golden-transaction fixtures — forward leg ETH→X1 (regression oracle)",
  capturedAt: new Date().toISOString(),
  sampleInput: capture.sampleInput,
  derived: capture.derived,
  quoteReference: capture.quoteReference,
  quoteBox,
  steps: {
    step1Approval: {
      file: "step1-approval.json",
      sha256: capture.steps.step1.sha256,
      calldata: capture.steps.step1.calldata,
    },
    step2aX1AtaPrep: {
      file: "step2a-x1-ata-prep.json",
      sha256: capture.steps.step2a.sha256,
      bytesSha256: capture.steps.step2a.bytesSha256,
    },
    step2bWarpLock: {
      file: "step2b-warp-lock.json",
      sha256: capture.steps.step2b.sha256,
      bytesSha256: capture.steps.step2b.bytesSha256,
      seq: capture.steps.step2b.artifact.seq,
      skimBase: capture.steps.step2b.artifact.skimBase,
      bridgeBase: capture.steps.step2b.artifact.bridgeBase,
    },
    step3BridgeInV2: {
      file: "step3-bridge-in-v2.json",
      sha256: capture.steps.step3.sha256,
      specSha256: capture.steps.step3.specSha256,
    },
  },
  verify: "test/golden.test.js rebuilds every step from the same inputs and asserts byte-identical + sha256 match.",
};
write("forward-leg-summary.json", summary);

console.log("\n── forward-leg golden fixtures captured ──");
for (const [k, v] of Object.entries(summary.steps)) {
  console.log(`  ${k}: sha256=${v.sha256}${v.bytesSha256 ? ` bytesSha256=${v.bytesSha256}` : ""}`);
}
console.log(`\nquote txDataSha256 (stage-1 bridge calldata reference): ${summary.quoteReference.txDataSha256}`);
