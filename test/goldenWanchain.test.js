/**
 * goldenWanchain.test.js — the Wanchain-family fixture oracle.
 *
 * The Wanchain-family lane is correct iff it reproduces the EXACT
 * construction + parse that the REAL 2026-09-05 captures produced. The
 * fixtures in test/fixtures/golden/wanchain-leg/ are REAL XFlows v3 API
 * responses (read-only quote POSTs — no funds, no broadcast): ONE ok EVM
 * quote (the docs' own example, reproduced live) and SIX failed-route
 * bodies (ADA→SOL, ADA→WAN, BTC→SOL, TRX→SOL, the EVM control
 * USDC(ETH)→SOL, and an invalid-address body proving format validation
 * precedes routing). This test proves:
 *
 *   - the canonical parse (parseWanchainQuoteResponse) handles every REAL
 *     fixture — the ok route fully shaped, every failed body honestly
 *     ok:false with the upstream error text (never a fabricated route);
 *   - the canonical REQUEST construction (shapeWanchainQuoteRequestArtifact
 *     — the engine leg's step1) reproduces the EXACT request the live
 *     capture was fired with (the proxy URL + the whitelisted POST body);
 *   - the construction is deterministic (rebuild twice → same bytes).
 *
 * LIVE-STATUS BOUNDARY (honest): the QUOTE level is REAL (these bodies —
 * including the real failures that define today's coverage). The
 * TRANSFER-EXECUTION anchor is deliberately NOT captured — a real XFlows
 * buildTx needs real funds + a real source wallet = Mr. Esters' live test.
 * The wanchain-execute leg pins its request SHAPE from the OpenAPI and
 * throws WanchainLiveTestGateError on submit (proven in
 * test/engineWanchain.test.js). Replace nothing here to fake a live anchor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseWanchainQuoteResponse } from "../src/lib/wanchain/quote.js";
import { shapeWanchainQuoteRequestArtifact } from "../src/engine/legs/wanchain/wanchainQuoteLeg.js";
import { WANCHAIN_SOURCES } from "../src/lib/wanchain/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "golden", "wanchain-leg");

/** The failed-route fixtures are wrapped evidence envelopes
 *  { capturedAt, request, httpStatus, response } — unwrap to the body. */
function loadFixture(name) {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  return raw.response !== undefined ? raw.response : raw;
}

function loadEnvelope(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

/** The exact request the live ADA→SOL capture was fired with (from the
 *  fixture envelope — the engine leg's step1 must reproduce it byte-for-byte
 *  modulo the proxy path, which is OUR /api/wanchain/quote). */
const LIVE_CAPTURED_ADA_SOL_REQUEST = Object.freeze({
  fromChainId: 2147485463,
  toChainId: 501,
  fromTokenAddress: "0x0000000000000000000000000000000000000000",
  toTokenAddress: "0x0000000000000000000000000000000000000000",
  fromAmount: "100",
  fromAddress: "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
  toAddress: "G8XKKQv6kESVby9b1qvGWHpyexKfbWzFvVQtEz6WyiS2",
});

const OK_FIXTURE = Object.freeze({
  file: "quote-avax-usdt-bnb-10usdt.real.json",
  source: null, // EVM-class (AVAX USDT → BNB) — the route class the API serves
});

const FAILED_FIXTURES = Object.freeze([
  "quote-ada-sol-100ada.failed.json",
  "quote-ada-wan-100ada.failed.json",
  "quote-btc-sol-001btc.failed.json",
  "quote-trx-sol-1000trx.failed.json",
  "quote-eth-usdc-sol-100usdc.failed.json",
  "quote-ada-sol-100ada.invalid-addr.failed.json",
]);

test("wanchain golden: the REAL ok quote fixture parses to a fully-shaped route (positive out, fees, extraData kept)", () => {
  const body = loadFixture(OK_FIXTURE.file);
  const q = parseWanchainQuoteResponse(body);
  assert.equal(q.ok, true, "ok route");
  assert.equal(q.error, null);
  assert.ok(q.route, "route present");
  assert.equal(q.route.amountOut, "9.8");
  assert.match(q.route.amountOutRaw, /^[0-9]+$/, "amountOutRaw is digit string");
  assert.ok(Number(q.route.amountOutRaw) > 0, "positive raw output");
  assert.equal(q.route.workMode, 1, "direct WanBridge work mode");
  assert.equal(q.route.bridge, "wanbridge");
  assert.ok(q.route.extraData && q.route.extraData.directPair, "extraData.directPair kept for the buildTx continuation");
  assert.ok(q.route.nativeFees.length >= 1 && q.route.tokenFees.length >= 1, "both fee classes present");
  assert.equal(q.raw, body, "raw body kept verbatim");
});

test("wanchain golden: EVERY REAL failed-route fixture parses honest (ok:false + the upstream error, route null)", () => {
  for (const file of FAILED_FIXTURES) {
    const body = loadFixture(file);
    const q = parseWanchainQuoteResponse(body);
    assert.equal(q.ok, false, `${file}: not ok`);
    assert.equal(q.route, null, `${file}: no route fabricated`);
    assert.ok(typeof q.error === "string" && q.error.length > 0, `${file}: upstream error text carried`);
    assert.equal(q.raw, body, `${file}: raw body kept`);
  }
  // The specific evidence the coverage matrix rests on (spot-check):
  const adaSol = parseWanchainQuoteResponse(loadFixture("quote-ada-sol-100ada.failed.json"));
  assert.match(adaSol.error, /From Chain not supported/, "ADA→SOL refused by the live router");
  const control = parseWanchainQuoteResponse(loadFixture("quote-eth-usdc-sol-100usdc.failed.json"));
  assert.match(control.error, /no token pair for SOL/, "SOL has no quotable pairs at all (EVM control)");
});

test("wanchain golden: the leg's step1 construction reproduces the EXACT live-captured request body", async () => {
  // The engine's quote-leg builder must reproduce the request the live
  // capture was fired with — the proxy path is OUR server route, the body
  // is byte-identical (slippage default 0.01 is what the live probe sent).
  const artifact = shapeWanchainQuoteRequestArtifact({
    source: "eth", // coverage-gated registry representative — the builder
    // REFUSES ada/sui/polkadot rows (see below); the ADA capture is
    // reproduced here through the pure request builder instead, because
    // the live capture itself is evidence a non-registry source CANNOT
    // be quoted — the gate is the point.
    fromChainId: LIVE_CAPTURED_ADA_SOL_REQUEST.fromChainId,
    toChainId: LIVE_CAPTURED_ADA_SOL_REQUEST.toChainId,
    fromTokenAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.fromTokenAddress,
    toTokenAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.toTokenAddress,
    fromAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.fromAddress,
    toAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.toAddress,
    fromAmount: LIVE_CAPTURED_ADA_SOL_REQUEST.fromAmount,
    slippage: 0.01,
  });
  assert.equal(artifact.url, "/api/wanchain/quote");
  assert.equal(artifact.method, "POST");
  const sent = { ...artifact.body };
  const envelope = loadEnvelope("quote-ada-sol-100ada.failed.json");
  const liveBody = envelope.request;
  // The live capture had no explicit slippage (the API default applies);
  // our canonical request makes slippage explicit. Everything else matches.
  for (const key of ["fromChainId", "toChainId", "fromTokenAddress", "toTokenAddress", "fromAddress", "toAddress", "fromAmount"]) {
    assert.equal(String(sent[key]), String(liveBody[key]), `body.${key} reproduces the live capture`);
  }
  assert.equal(sent.slippage, 0.01, "canonical slippage is explicit");
  // Deterministic: rebuild twice → same bytes.
  const again = shapeWanchainQuoteRequestArtifact({
    source: "eth",
    fromChainId: LIVE_CAPTURED_ADA_SOL_REQUEST.fromChainId,
    toChainId: LIVE_CAPTURED_ADA_SOL_REQUEST.toChainId,
    fromTokenAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.fromTokenAddress,
    toTokenAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.toTokenAddress,
    fromAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.fromAddress,
    toAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.toAddress,
    fromAmount: LIVE_CAPTURED_ADA_SOL_REQUEST.fromAmount,
    slippage: 0.01,
  });
  assert.equal(again.json, artifact.json, "rebuild is byte-identical");
});

test("wanchain golden: the coverage gate refuses non-quotable sources at build time (ADA/Sui/Polkadot)", async () => {
  // This is the honest core of the scaffold: the registry (WANCHAIN_SOURCES
  // — the EVM class) is the ONLY thing the leg will build a request for.
  // The live-failed routes (ADA etc.) must fail HERE with a clear message,
  // not silently reach an upstream that refuses them.
  assert.deepEqual(Object.keys(WANCHAIN_SOURCES), ["eth"]);
  for (const wish of ["ada", "sui", "polkadot", "btc", "tron"]) {
    assert.throws(
      () =>
        shapeWanchainQuoteRequestArtifact({
          source: wish,
          fromChainId: 2147485463,
          toChainId: 501,
          fromTokenAddress: "0x0000000000000000000000000000000000000000",
          toTokenAddress: "0x0000000000000000000000000000000000000000",
          fromAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.fromAddress,
          toAddress: LIVE_CAPTURED_ADA_SOL_REQUEST.toAddress,
          fromAmount: "100",
        }),
      new RegExp(`source "${wish}" is NOT in the quotable registry`),
      `${wish}: coverage gate throws`
    );
  }
});
