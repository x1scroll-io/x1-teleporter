import { test } from "node:test";
import assert from "node:assert/strict";
import { GOPLUS_CHAIN_IDS, goPlusChainId } from "./taxDetector.js";
import {
  effectiveSlippageBps, postTaxAmount, taxRoutingDecision, taxSeverity,
  buildTaxNotice, TAX_SLIPPAGE_BUFFER_BPS,
} from "./fotHandler.js";

// a FLOKI-like profile (0.3% buy+sell, not a honeypot) — mirrors the live
// GoPlus read for 0xfb5B838b… on BSC
const FLOKI_LIKE = {
  detected: true, buyTaxBps: 30, sellTaxBps: 30,
  honeypot: false, blacklisted: false, cannotSellAll: false, ownerRenounced: true,
  method: "goplus", sources: { goPlus: true, onChain: false },
};
const CLEAN = {
  detected: false, buyTaxBps: 0, sellTaxBps: 0,
  honeypot: false, blacklisted: false, cannotSellAll: false,
  method: "goplus", sources: { goPlus: true, onChain: false },
};
const HONEYPOT = {
  detected: true, buyTaxBps: 500, sellTaxBps: 500,
  honeypot: true, blacklisted: false, cannotSellAll: true,
  method: "goplus", sources: { goPlus: true, onChain: false },
};

test("taxDetector: GoPlus chain map covers the engine chains; RH falls back to on-chain", () => {
  assert.equal(goPlusChainId("bsc"), "56");
  assert.equal(goPlusChainId("eth"), "1");
  assert.equal(goPlusChainId("arb"), "42161");
  assert.equal(goPlusChainId("rh"), null, "RH not on GoPlus → on-chain measure");
  assert.ok(Object.keys(GOPLUS_CHAIN_IDS).length >= 6);
});

test("fotHandler: auto-slippage = measured tax + buffer (never a guess)", () => {
  // 0.3% tax → slippage covers 30bps + 100 buffer = 130bps (not blind 100)
  assert.equal(effectiveSlippageBps(FLOKI_LIKE), 130);
  // clean token → normal slippage
  assert.equal(effectiveSlippageBps(CLEAN), 100);
  // sell side uses sellTaxBps
  assert.equal(effectiveSlippageBps(FLOKI_LIKE, { selling: true }), 130);
  // a 5% tax token → 500 + 100 = 600bps
  const bigTax = { ...CLEAN, detected: true, buyTaxBps: 500, sellTaxBps: 500 };
  assert.equal(effectiveSlippageBps(bigTax), 600);
});

test("fotHandler: postTaxAmount is honest (100 sent → 99.7 after 0.3% tax)", () => {
  const { netBps, netAmount } = postTaxAmount("1000000", FLOKI_LIKE);
  assert.equal(netBps, 9970);
  assert.equal(netAmount, "997000");
});

test("fotHandler: routing decision — taxed → FOT path; honeypot → block", () => {
  const taxed = taxRoutingDecision(FLOKI_LIKE);
  assert.equal(taxed.useFotPath, true);
  assert.equal(taxed.reason, "tax-30bps");
  assert.equal(taxed.slippageBps, 130);

  const clean = taxRoutingDecision(CLEAN);
  assert.equal(clean.useFotPath, false);
  assert.equal(clean.reason, null);

  const hp = taxRoutingDecision(HONEYPOT);
  assert.equal(hp.useFotPath, false);
  assert.equal(hp.reason, "HONEYPOT");
});

test("fotHandler: severity ladder — block / warn / ok", () => {
  assert.equal(taxSeverity(HONEYPOT), "block");
  assert.equal(taxSeverity(FLOKI_LIKE), "warn");
  assert.equal(taxSeverity(CLEAN), "ok");
});

test("fotHandler: buildTaxNotice — clean token → null; taxed → warn with real post-tax", () => {
  assert.equal(buildTaxNotice(CLEAN), null);
  const notice = buildTaxNotice(FLOKI_LIKE, { tokenSymbol: "FLOKI", grossAmountOutHuman: 1000 });
  assert.equal(notice.severity, "warn");
  assert.match(notice.title, /Tax token/);
  assert.match(notice.body, /0.30%/);
  assert.match(notice.body, /1.3% slippage/);
  assert.match(notice.postTaxNote, /997/);
  const block = buildTaxNotice(HONEYPOT, { tokenSymbol: "SCAM" });
  assert.equal(block.severity, "block");
  assert.match(block.title, /SCAM/);
});

test("fotHandler: TAX_SLIPPAGE_BUFFER_BPS is a sane constant", () => {
  assert.equal(TAX_SLIPPAGE_BUFFER_BPS, 100);
});
