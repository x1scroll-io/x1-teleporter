/**
 * goldenThorchain.test.js — THE REGRESSION ORACLE for the THORChain-leg
 * migration (Phase 3 of the routing-engine migration).
 *
 * The routing engine that will migrate the THORChain lane (BTC/DOGE/LTC/XRP
 * → SOL.SOL — the Buy/THORChain tab's deposit-address flow) is correct IF
 * AND ONLY IF it reproduces the EXACT artifacts the current reference
 * implementation constructs — byte-for-byte. This test is the oracle: it
 * REBUILDS each step of the THORChain leg from the fixed sample input + the
 * frozen (synthetic — the lane has not gone live) THORNode input bodies and
 * asserts the rebuilt artifacts are IDENTICAL to the captured golden
 * fixtures (canonical JSON equality + sha256 match).
 *
 *   step1  the QUOTE REQUEST  (quote.js quoteUrl via OUR proxy path —
 *          /api/thorchain/quote, amounts in 1e8 base units, destination =
 *          the Solana session pubkey, affiliate pair omitted while the
 *          THORName placeholder is empty) + the size-cap gate
 *          (assertWithinSwapCap — 0.05 BTC-equivalent from config)
 *   step2  the DEPOSIT PAYLOAD (inboundAddresses.js parseInboundAddresses
 *          by-chain selection + memo.js buildDepositMemo —
 *          `=:SOL.SOL:<solanaDest>[/<refund>]` in THORNode SwapMemo.String()
 *          scheme) + the quote PARSE (parseQuoteResponse canonical quote)
 *
 * Fixtures: test/fixtures/golden/thorchain-leg/*.json
 * Rebuild:  test/golden/thorchainLegBuilders.mjs (single source of truth —
 *           the capture script and this test share it, so the test can never
 *           drift from what was captured).
 *
 * LIVE-STATUS BOUNDARY (honest): the THORChain lane is the NEXT roadmap item
 * — no live quote/inbound capture exists (the aggregator key is parked
 * server-side). The INPUT bodies are SYNTHETIC THORNode-shaped fixtures; the
 * oracle pins the CURRENT code's CONSTRUCTION — the engine must reproduce it
 * exactly. Replace the synthetic inputs with live captures on the first
 * operator deposit (documented in the fixture READMEs + the capture script).
 *
 * The engine must make this file pass UNCHANGED. Do not weaken assertions to
 * accommodate the engine — fix the engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureThorchainLeg,
  canonicalJson,
  sha256Of,
  sha256Text,
  buildStep1QuoteRequest,
  buildStep2DepositPayload,
  buildQuoteParse,
  inboundByChain,
  feeLinesForSource,
  SAMPLE_INPUT,
  BTC_VAULT_ADDRESS,
  INBOUND_BODY,
  QUOTE_BODY,
  THORCHAIN_AFFILIATE_NAME,
  THORCHAIN_MAX_SWAP_BTC_EQUIVALENT,
} from "./golden/thorchainLegBuilders.mjs";
import { SOLANA_ADDRESS } from "./golden/forwardLegBuilders.mjs";
import {
  THORCHAIN_SOURCE_ASSETS,
  THORCHAIN_DESTINATION_ASSET,
  SWAP_OPCODE,
} from "../src/lib/thorchain/memo.js";
import { swapCapInSourceUnits, THORCHAIN_QUOTE_PROXY_PATH } from "../src/lib/thorchain/quote.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "golden", "thorchain-leg");
const read = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const INBOUND = read("inbound-addresses-body.json").body;
const QUOTE_BODY_FIX = read("quote-body-btc-sol.json").body;
const FIX_STEP1 = read("step1-quote-request.json");
const FIX_STEP2 = read("step2-deposit-payload.json");
const SUMMARY = read("thorchain-leg-summary.json");

// ── Sample-input + input-body self-consistency (the fixture chain of
//    custody: the sample, the synthetic bodies, and the summary agree) ──
test("golden thorchain: fixture input is the documented sample + the synthetic THORNode bodies", () => {
  assert.equal(SAMPLE_INPUT.sourceChain, "BTC");
  assert.equal(SAMPLE_INPUT.fromAsset, "BTC.BTC");
  assert.equal(SAMPLE_INPUT.toAsset, "SOL.SOL");
  assert.equal(SAMPLE_INPUT.amount, 0.01);
  assert.equal(SAMPLE_INPUT.solanaAddress, SOLANA_ADDRESS);
  assert.equal(SAMPLE_INPUT.refundAddress, null); // external-send state: no refund segment

  // The synthetic inbound body: 4 chains, BTC is the sample's, DOGE halted.
  assert.equal(INBOUND.length, 4);
  assert.equal(INBOUND[0].chain, "BTC");
  assert.equal(INBOUND[0].halted, false);
  assert.equal(INBOUND[0].address, BTC_VAULT_ADDRESS);
  assert.equal(INBOUND[1].chain, "DOGE");
  assert.equal(INBOUND[1].halted, true); // pins the paused-chain gate
  assert.equal(QUOTE_BODY_FIX.expected_amount_out, "49750000"); // synthetic 1e8 base
  assert.equal(QUOTE_BODY_FIX.inbound_address, BTC_VAULT_ADDRESS);

  // Summary agrees with the sample + fixtures.
  assert.equal(SUMMARY.sampleInput.sourceChain, "BTC");
  assert.equal(SUMMARY.derived.amountInBaseUnits, "1000000");
  assert.equal(SUMMARY.derived.depositAddress, BTC_VAULT_ADDRESS);
  assert.equal(SUMMARY.steps.step1QuoteRequest.urlSha256, FIX_STEP1.urlSha256);
  assert.equal(SUMMARY.steps.step2DepositPayload.memo, FIX_STEP2.artifact.memo);
});

// ── STEP 1 — the quote request (canonical proxy URL + cap gate) ──
test("golden thorchain step1: quote-request rebuild is byte-identical (canonical URL + sha256)", () => {
  const rebuilt = buildStep1QuoteRequest({});

  // 1) The fixture itself must be the exact request the code builds today.
  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP1.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP1.sha256);

  // 2) The oracle invariants — the deposit-stage request contract:
  const a = rebuilt.artifact;
  assert.equal(a.sourceChain, "BTC");
  assert.equal(a.fromAsset, "BTC.BTC");
  assert.equal(a.toAsset, "SOL.SOL"); // destination pinned to SOL.SOL (brief)
  assert.equal(a.amount, 0.01);
  assert.equal(a.amountInBaseUnits, "1000000"); // THORChain 1e8 convention
  assert.equal(a.destination, SOLANA_ADDRESS); // the Solana session pubkey
  assert.equal(a.refundAddress, null); // absent → refunds default to the sender

  // Cap: BTC rate = 1 (config) → the 0.05 BTC-equivalent cap is KNOWN; the
  // sample (0.01) is at-cap → allowed BEFORE any fetch (assertWithinSwapCap).
  assert.deepEqual(a.capDecision, { ok: true, capKnown: true });
  assert.equal(swapCapInSourceUnits("BTC").capAmount, THORCHAIN_MAX_SWAP_BTC_EQUIVALENT);

  // The canonical serialized request: OUR proxy path, no THORNode host, no
  // key header param, NO affiliate params while the THORName placeholder is
  // empty — nothing invented ever goes to the quote API.
  assert.ok(a.url.startsWith(THORCHAIN_QUOTE_PROXY_PATH + "?"), a.url);
  assert.ok(!a.url.includes("liquify"), "client never targets THORNode directly");
  assert.ok(!a.url.includes("thornode"), "client never targets THORNode directly");
  assert.ok(a.url.includes("from_asset=BTC.BTC"));
  assert.ok(a.url.includes("to_asset=SOL.SOL"));
  assert.ok(a.url.includes("amount=1000000"));
  assert.ok(a.url.includes("destination=" + encodeURIComponent(SOLANA_ADDRESS)));
  assert.ok(!a.url.includes("refund_address"), "no refund segment in the sample request");
  assert.ok(!a.url.includes("affiliate"), "no affiliate params while the THORName is unset");
  assert.equal(THORCHAIN_AFFILIATE_NAME, ""); // parked-item invariant (config)

  // urlSha256 pins the exact serialized bytes of the canonical request
  // (a fixture SIBLING — never an artifact field; the browser legs cannot
  // use node:crypto, so hashes are pinned test-side).
  assert.equal(FIX_STEP1.urlSha256, sha256Text(a.url));
  assert.equal(SUMMARY.derived.urlSha256, sha256Text(a.url));
});

// ── STEP 2 — the deposit payload (vault selection + the deposit memo) ──
test("golden thorchain step2: deposit-payload rebuild is byte-identical (vault + memo + sha256)", () => {
  const rebuilt = buildStep2DepositPayload({});

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP2.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP2.sha256);

  const a = rebuilt.artifact;
  assert.equal(a.chain, "BTC");
  assert.equal(a.depositAddress, BTC_VAULT_ADDRESS); // the BTC vault from the inbound body
  assert.equal(a.depositAddress, inboundByChain().BTC.address);
  assert.equal(a.halted, false);

  // The memo — THORNode SwapMemo.String() scheme, destination = the Solana
  // session pubkey (wallet rule 4: never user-typed), no refund segment.
  assert.equal(a.memo, `=:SOL.SOL:${SOLANA_ADDRESS}`);
  assert.equal(a.memoParts.opcode, SWAP_OPCODE);
  assert.equal(a.memoParts.asset, THORCHAIN_DESTINATION_ASSET);
  assert.equal(a.memoParts.destination, SOLANA_ADDRESS);
  assert.equal(a.memoParts.refundAddress, null);
  assert.equal(a.memoParts.limit, null); // limit NOT wired (documented)
  assert.equal(a.memoParts.affiliate, null); // THORName placeholder empty
  assert.equal(a.memoParts.affiliateBps, null);
  assert.equal(FIX_STEP2.memoSha256, sha256Text(a.memo)); // hash SIBLING
  assert.equal(SUMMARY.derived.memoSha256, sha256Text(a.memo));
});

// ── Step-2 selection gates (the reference UI blocks these states) ──
test("golden thorchain step2 gates: halted chains are NOT selectable; unknown chains/missing entries throw", () => {
  // DOGE is halted in the fixture body — the deposit stage greys it out and
  // the payload builder must refuse it (mirror of the UI's paused gate).
  assert.throws(() => buildStep2DepositPayload({ sourceChain: "DOGE" }), /halted by THORChain/);
  // Unknown source chain (not in THORCHAIN_SOURCE_ASSETS).
  assert.throws(() => buildStep2DepositPayload({ sourceChain: "ETH" }), /unknown sourceChain/);
  // A chain with no inbound entry at all.
  const partial = { BTC: inboundByChain().BTC };
  assert.throws(() => buildStep2DepositPayload({ sourceChain: "LTC", byChain: partial }), /no inbound entry/);
});

// ── The quote parse (canonical quote given the proxy body — fail-closed) ──
test("golden thorchain: quote parse rebuild matches the summary (expectedAmountOut / slippage / halted)", () => {
  const parsed = buildQuoteParse(QUOTE_BODY_FIX);
  assert.equal(parsed.ok, true);
  const q = parsed.quote;
  assert.equal(q.expectedAmountOutRaw, 49750000); // 1e8 base units
  assert.equal(q.expectedAmountOut, 0.4975); // decimal SOL units (display + landing detection)
  assert.equal(q.slippageBps, 50);
  assert.equal(q.affiliateBps, null); // no affiliate requested (config empty)
  assert.equal(q.halted, false); // inbound_address non-empty → not halted
  assert.deepEqual(q, SUMMARY.derived.quote);

  // A halted chain surfaces on quote responses as an empty inbound_address —
  // the parser must report halted (the deposit stage blocks on it).
  const halted = buildQuoteParse({ ...QUOTE_BODY_FIX, inbound_address: "" });
  assert.equal(halted.quote.halted, true);
});

// ── Fee lines (the REAL fee code — the browser harness asserts these) ──
test("golden thorchain: the three pre-send fee lines match the summary display strings", () => {
  const lines = feeLinesForSource("BTC");
  assert.deepEqual(lines.map((l) => l.id), ["thorchain-affiliate", "warp-skim", "warp-flat"]);
  assert.deepEqual(lines, SUMMARY.derived.feeLines);
  // Fee-model v2: Teleporter skim display = 0.50% (was 1.00%).
  assert.deepEqual(lines.map((l) => l.display), ["1.00%", "0.50%", "$1 flat"]);
  assert.equal(lines[1].party, "teleporter"); // our 0.5% — the once-per-journey Teleporter fee
  assert.equal(lines[1].label, "Teleporter fee (0.5%, max $250)");
  assert.equal(lines[2].label, "Warp bridge fee ($1 flat)"); // verified on-chain 2026-09-02
});

// ── Full capture: reproducible + deterministic ──
test("golden thorchain: full capture is reproducible + deterministic (rebuild twice, same bytes)", () => {
  const c1 = captureThorchainLeg();
  const c2 = captureThorchainLeg();
  for (const k of ["step1", "step2"]) {
    assert.equal(c1.steps[k].sha256, c2.steps[k].sha256, `${k} sha256 stable`);
    assert.equal(canonicalJson(c1.steps[k].artifact), canonicalJson(c2.steps[k].artifact), `${k} artifact stable`);
  }
  // Derived values agree with the summary + the per-step fixtures.
  assert.equal(c1.derived.amountInBaseUnits, "1000000");
  assert.equal(c1.derived.memo, FIX_STEP2.artifact.memo);
  assert.equal(c1.derived.url, FIX_STEP1.artifact.url);
  assert.equal(c1.derived.urlSha256, FIX_STEP1.urlSha256);
  assert.equal(c1.derived.memoSha256, FIX_STEP2.memoSha256);
  assert.equal(c1.steps.step1.sha256, SUMMARY.steps.step1QuoteRequest.sha256);
  assert.equal(c1.steps.step2.sha256, SUMMARY.steps.step2DepositPayload.sha256);
});
