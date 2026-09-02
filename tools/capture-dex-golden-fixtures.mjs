/**
 * capture-dex-golden-fixtures.mjs — writes the Phase-4 DEX-leg golden
 * fixtures (test/fixtures/golden/dex-leg/) from the canonical builders
 * (test/golden/dexLegBuilders.mjs — the single source of truth shared with
 * test/goldenDex.test.js, so the test can never drift from what was
 * captured).
 *
 * The INPUT fixtures (the frozen live captures — jupiter-quote-input.json,
 * xdex-pool-snapshot.json, lifi-samechain-quote-input.json) live in the same
 * directory and are consumed, not rewritten. Run: node --import
 * ./tools/jsx-loader.mjs tools/capture-dex-golden-fixtures.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureDexLeg, DEX_FIXTURES } from "../test/golden/dexLegBuilders.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "..", "test", "fixtures", "golden", "dex-leg");

const c = captureDexLeg();

const steps = {
  "jupiter-step1-quote-request.json": c.steps.jupiterStep1QuoteRequest,
  "jupiter-step2-swap-request.json": c.steps.jupiterStep2SwapRequest,
  "xdex-step1-swap-quote.json": c.steps.xdexStep1SwapQuote,
  "xdex-step2-swap-ix.json": c.steps.xdexStep2SwapIx,
  "lifi-step1-samechain-swap-request.json": c.steps.lifiStep1SameChainSwapRequest,
};
for (const [file, obj] of Object.entries(steps)) {
  writeFileSync(join(FIX, file), JSON.stringify(obj, null, 2) + "\n");
  console.log("wrote", file);
}

// The summary records the step fixture files + hashes (mirror of the other
// phases' summaries). The input fixtures are NOT rewritten (frozen captures).
const summary = {
  tool: c.tool,
  capturedAt: c.capturedAt,
  liveStatus: c.liveStatus,
  samples: c.samples,
  evidence: c.evidence,
  steps: {
    jupiterStep1QuoteRequest: {
      file: "jupiter-step1-quote-request.json",
      sha256: c.steps.jupiterStep1QuoteRequest.sha256,
      url: c.steps.jupiterStep1QuoteRequest.artifact.url,
      urlSha256: c.steps.jupiterStep1QuoteRequest.urlSha256,
    },
    jupiterStep2SwapRequest: {
      file: "jupiter-step2-swap-request.json",
      sha256: c.steps.jupiterStep2SwapRequest.sha256,
      url: c.steps.jupiterStep2SwapRequest.artifact.url,
      bodySha256: c.steps.jupiterStep2SwapRequest.bodySha256,
    },
    xdexStep1SwapQuote: {
      file: "xdex-step1-swap-quote.json",
      sha256: c.steps.xdexStep1SwapQuote.sha256,
      outRaw: c.steps.xdexStep1SwapQuote.artifact.outRaw,
      minOutRaw: c.steps.xdexStep1SwapQuote.artifact.minOutRaw,
    },
    xdexStep2SwapIx: {
      file: "xdex-step2-swap-ix.json",
      sha256: c.steps.xdexStep2SwapIx.sha256,
      dataSha256: c.steps.xdexStep2SwapIx.dataSha256,
      txSha256: c.steps.xdexStep2SwapIx.txSha256,
      discriminator: c.steps.xdexStep2SwapIx.artifact.discriminator,
    },
    lifiStep1SameChainSwapRequest: {
      file: "lifi-step1-samechain-swap-request.json",
      sha256: c.steps.lifiStep1SameChainSwapRequest.sha256,
      upstreamUrl: c.steps.lifiStep1SameChainSwapRequest.artifact.upstreamUrl,
      urlSha256: c.steps.lifiStep1SameChainSwapRequest.urlSha256,
    },
  },
  verify:
    "test/goldenDex.test.js rebuilds every step from the same inputs and asserts " +
    "byte-identical + sha256 match + the dex-leg invariants (raw amounts, verbatim quote " +
    "forwarding, the observed XDEX discriminator, the forced same-chain fee).",
};
writeFileSync(join(FIX, "dex-leg-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log("wrote dex-leg-summary.json");
console.log("\nNOTE: input fixtures (jupiter-quote-input.json, xdex-pool-snapshot.json,\n" +
  "lifi-samechain-quote-input.json) are the frozen LIVE captures — never rewritten here.");
