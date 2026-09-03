/**
 * capture-reverse-ethx-synthetic-fixtures.mjs — capture the SYNTHETIC-LABELED
 * ETH.X reverse-leg golden fixtures (the per-asset PCT-DEFAULT oracle for a
 * non-USDC percentage route — the fee lookup fix on v2 @ 1b541e5).
 *
 * WHY SYNTHETIC-LABELED (the honesty rule): NO live ETH.X bridge_out burn
 * exists to anchor — verified 2026-09-03 via getSignaturesForAddress on the
 * X1 mainnet RPC for the ETH.X mint 4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw
 * (only 4 txs exist, ALL recipient-ATA creates, ZERO BridgeOut) + the live
 * Warp config (api.bridge.mainnet.x1.xyz/config — ETH.X dailyVolume 0 on both
 * sides, fetched 2026-09-03). The sample INPUT is therefore synthetic-labeled
 * (mirrors the wSOL.X oracle's shape: 0.4 gross, same wallet set, same pinned
 * EVM destination). The pieces that CAN be anchored to real oracles ARE:
 *   - the fee SHAPE (ETH.X: 25 bps pct, 8 dec) — the live Warp config token
 *     registry (percentageFeeBps 25, flatFeeAmount 0)
 *   - the stage-2 LiFi leg — a REAL live quote capture (relaydepository,
 *     ETH-on-Solana 7vfCXTU… → USDC-on-eth, fromAmount 39700500 = this
 *     sample's exact deterministic release net; see
 *     quote-ethx-usdc-eth-synthetic-0.4.json)
 *
 * WHAT IT WRITES (test/fixtures/golden/reverse-leg/):
 *   step1-x1-burn-ethx-synthetic.json        — the X1 reverse burn tx
 *   step2-release-shape-ethx-synthetic.json  — bridge_in_v2 native-variant
 *                                              shape + release math at 25bps
 *   step3-lifi-out-ethx-synthetic.json       — the deterministic LiFi query
 *   reverse-leg-summary-ethx-synthetic.json  — sample, derived math, quote
 *                                              reference, quote-box strings
 *
 * USAGE
 *   node --import ./tools/jsx-loader.mjs tools/capture-reverse-ethx-synthetic-fixtures.mjs
 *
 * The capture is OFFLINE + deterministic (the frozen quote stands in for the
 * LiFi network). Re-running MUST reproduce byte-identical fixtures — the
 * golden test asserts it.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureReverseLeg, ETHX_SAMPLE_INPUT } from "../test/golden/reverseLegBuilders.mjs";
import { deriveReverseQuote } from "../src/lib/reverseQuote.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const FIXTURE_DIR = join(repo, "test", "fixtures", "golden", "reverse-leg");
const QUOTE_PATH = join(FIXTURE_DIR, "quote-ethx-usdc-eth-synthetic-0.4.json");

function write(name, obj) {
  const path = join(FIXTURE_DIR, name);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  console.log(`wrote ${path}`);
}

mkdirSync(FIXTURE_DIR, { recursive: true });

// ── 0. The frozen LIVE quote (INPUT — the real LiFi oracle for the stage-2
//    leg: ETH-on-Solana → USDC-on-eth, relaydepository, captured 2026-09-03
//    through li.quest with the repo's integrator x1-teleporter-labs). ──
let quote;
try {
  quote = JSON.parse(readFileSync(QUOTE_PATH, "utf8"));
} catch {
  console.error(
    `Missing frozen quote fixture: ${QUOTE_PATH}\n` +
      "Capture it first (read-only GET to li.quest/v1/quote with fromToken = Solana ETH 7vfCXTU…, fromAmount 39700500), then re-run."
  );
  process.exit(1);
}

const capture = await captureReverseLeg({ quote, sampleInput: ETHX_SAMPLE_INPUT });

// ── The quote-box display strings — computed by the REAL fee code
//    (quoteFees via deriveReverseQuote) so the browser harness asserts
//    against the same reference math the golden fixtures capture. ──
const dq = deriveReverseQuote({
  data: quote,
  to: ETHX_SAMPLE_INPUT.to,
  amount: ETHX_SAMPLE_INPUT.amountUser,
  token: ETHX_SAMPLE_INPUT.token,
  toToken: ETHX_SAMPLE_INPUT.toToken,
});
const quoteBox = {
  youSend: `${ETHX_SAMPLE_INPUT.amountUser} ${ETHX_SAMPLE_INPUT.token} on X1`,
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

// ── Write the per-step fixtures (names mirror the summary) ──
const STEP_FILES = {
  step1: "step1-x1-burn-ethx-synthetic.json",
  step2: "step2-release-shape-ethx-synthetic.json",
  step3: "step3-lifi-out-ethx-synthetic.json",
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
  tool: "golden-transaction fixtures — reverse leg X1→Ethereum, SYNTHETIC ETH.X route (per-asset pct-default oracle, fee fix on v2 @ 1b541e5)",
  capturedAt: new Date().toISOString(),
  syntheticLabel: {
    note:
      "SYNTHETIC-LABELED INPUT — no live ETH.X bridge_out burn exists to anchor (honesty rule). " +
      "Verified 2026-09-03: getSignaturesForAddress on the X1 mainnet RPC for the ETH.X mint " +
      "4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw returned only 4 txs (all recipient-ATA creates, " +
      "ZERO BridgeOut); the live Warp config shows ETH.X dailyVolume 0 on both chains. The route SHAPE " +
      "mirrors the wSOL.X ground-truth oracle (same 0.4 gross, same wallet set, same pinned EVM " +
      "destination 0x1870aFAfA…). The fee SHAPE (25 bps pct, 8 dec — NOT the USDC.x flat $1) is " +
      "anchored to the live Warp config token registry; the stage-2 LiFi leg is a REAL live quote " +
      "(relaydepository, ETH-on-Solana → USDC-on-eth).",
    x1ChainCheck: "https://rpc.mainnet.x1.xyz getSignaturesForAddress(4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw) — 4 sigs, no BridgeOut",
    configCheck: "https://api.bridge.mainnet.x1.xyz/config — ETH.X { decimals: 8, flatFeeAmount: 0, percentageFeeBps: 25, dailyVolume: 0 }",
  },
  sampleInput: capture.sampleInput,
  derived: capture.derived,
  quoteReference: capture.quoteReference,
  quoteBox,
  steps: {
    step1X1Burn: {
      file: "step1-x1-burn-ethx-synthetic.json",
      sha256: capture.steps.step1.sha256,
      bytesSha256: capture.steps.step1.bytesSha256,
      seq: capture.steps.step1.artifact.seq,
      skimBase: capture.steps.step1.artifact.skimBase,
      bridgeBase: capture.steps.step1.artifact.bridgeBase,
      feeAtaCreated: capture.steps.step1.artifact.feeAtaCreated,
    },
    step2ReleaseShape: {
      file: "step2-release-shape-ethx-synthetic.json",
      sha256: capture.steps.step2.sha256,
      specSha256: capture.steps.step2.specSha256,
      releaseBase: capture.steps.step2.artifact.releaseBase,
    },
    step3LifiOut: {
      file: "step3-lifi-out-ethx-synthetic.json",
      sha256: capture.steps.step3.sha256,
      toAddress: capture.steps.step3.artifact.toAddress, // THE PIN
    },
  },
  feePins: {
    // THE POINT OF THIS FIXTURE: a non-USDC percentage route must price the
    // Warp fee at 25 bps pct — the per-asset lookup default — NEVER the flat
    // $1 (which is USDC.x-ONLY).
    token: "ETH.X",
    warpFeeKind: "pct",
    warpFeeBps: 25,
    warpFeeBase: capture.derived.warpFeeBase, // 995,000 base @ 8 dec = 0.25% of the 398,000,000 bridge gross
    releaseBase: capture.derived.releaseBase, // 397,005,000 base = 0.397005 ETH released on Solana
  },
  verify:
    "test/goldenReverse.test.js rebuilds every step from the same inputs and asserts byte-identical + sha256 match + the per-asset pct fee pin.",
};
write("reverse-leg-summary-ethx-synthetic.json", summary);

console.log("\n── ETH.X synthetic reverse-leg golden fixtures captured ──");
for (const [k, v] of Object.entries(summary.steps)) {
  console.log(`  ${k}: sha256=${v.sha256}${v.bytesSha256 ? ` bytesSha256=${v.bytesSha256}` : ""}`);
}
console.log(`\nwarpFeeBase=${summary.feePins.warpFeeBase} (25bps of the bridge gross) releaseBase=${summary.feePins.releaseBase}`);
console.log(`quote toAddress (PINNED EVM destination): ${summary.quoteReference.toAddress}`);
