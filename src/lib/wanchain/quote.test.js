/**
 * quote.test.js — src/lib/wanchain/quote.js (the Wanchain-family lane's
 * client-side pure module: the deterministic quote-request artifact for the
 * XFlows v3 API and the canonical response parse).
 *
 * Pure node:test — no jsdom, no network. The REAL 2026-09-05 fixture bodies
 * are asserted here for the parse contract (the golden oracle
 * test/goldenWanchain.test.js does the full fixture pass); this suite covers
 * the module's unit contract: whitelisted body fields, the human-units
 * amount rule, the coverage-gate registry, and the honest parse of BOTH the
 * one REAL ok quote and the REAL failed-route bodies (success:false with
 * the upstream's error text — captured live, never synthesized).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  shapeQuoteRequest,
  parseWanchainQuoteResponse,
  isOkResponse,
  QUOTE_FORWARD_FIELDS,
} from "./quote.js";
import {
  WANCHAIN_SOURCES,
  WANCHAIN_SOURCE_KEYS,
  WANCHAIN_NATIVE_ADDRESS,
  WANCHAIN_DEFAULT_SLIPPAGE,
  isWanchainQuotableSource,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "..", "..", "test", "fixtures", "golden", "wanchain-leg");

function loadFixture(name) {
  // The failed-route fixtures are wrapped { capturedAt, request, httpStatus,
  // response } evidence envelopes — unwrap to the response body. The ok
  // fixture is the raw API body (success:true).
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  return raw.response !== undefined ? raw.response : raw;
}

const ADA = "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x"; // CIP-19 mainnet vector
const SOL = "G8XKKQv6kESVby9b1qvGWHpyexKfbWzFvVQtEz6WyiS2";

test("wanchain quote: shapeQuoteRequest — canonical POST body, human-unit amount, whitelist sync", () => {
  const a = shapeQuoteRequest({
    fromChainId: 1,
    toChainId: 888,
    fromTokenAddress: WANCHAIN_NATIVE_ADDRESS,
    toTokenAddress: WANCHAIN_NATIVE_ADDRESS,
    fromAddress: "0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200",
    toAddress: "0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200",
    fromAmount: "10",
  });
  assert.equal(a.url, "/api/wanchain/quote");
  assert.equal(a.method, "POST");
  assert.deepEqual(Object.keys(a.body), [
    "fromChainId",
    "toChainId",
    "fromTokenAddress",
    "toTokenAddress",
    "fromAddress",
    "toAddress",
    "fromAmount",
    "slippage",
  ]);
  assert.equal(a.body.fromChainId, 1, "chainIds are numbers (the API's registry ids)");
  assert.equal(a.body.slippage, WANCHAIN_DEFAULT_SLIPPAGE, "explicit 0.01 default");
  // Whitelist sync: the client forwards exactly what the proxy forwards.
  assert.deepEqual(QUOTE_FORWARD_FIELDS, [
    "fromChainId",
    "toChainId",
    "fromTokenAddress",
    "toTokenAddress",
    "fromAddress",
    "toAddress",
    "fromAmount",
    "slippage",
    "bridge",
  ]);
  // Human units are the XFlows contract (its response carries amountOut AND
  // amountOutRaw) — but garbage still refuses.
  assert.throws(() => shapeQuoteRequest({ fromChainId: 1, toChainId: 888, fromTokenAddress: "0x0", toTokenAddress: "0x0", fromAddress: "0x1", toAddress: "0x2", fromAmount: "-5" }), /positive fromAmount/);
  assert.throws(() => shapeQuoteRequest({ fromChainId: 1, toChainId: 888, fromTokenAddress: "0x0", toTokenAddress: "0x0", fromAddress: "", toAddress: "0x2", fromAmount: "1" }), /fromAddress and toAddress are required/);
  // Optional bridge rides along only when chosen.
  const b = shapeQuoteRequest({
    fromChainId: 1,
    toChainId: 56,
    fromTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    toTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
    fromAddress: "0x1",
    toAddress: "0x2",
    fromAmount: "10",
    bridge: "wanbridge",
  });
  assert.equal(b.body.bridge, "wanbridge");
});

test("wanchain quote: parseWanchainQuoteResponse over the REAL ok fixture (EVM quote — the one route class the API serves)", () => {
  const body = loadFixture("quote-avax-usdt-bnb-10usdt.real.json");
  const q = parseWanchainQuoteResponse(body);
  assert.equal(q.ok, true);
  assert.equal(q.error, null);
  assert.equal(q.route.amountOut, "9.8");
  assert.equal(q.route.amountOutRaw, "9800000000000000000", "raw amount carried as a string");
  assert.equal(q.route.workMode, 1);
  assert.equal(q.route.bridge, "wanbridge");
  assert.equal(q.route.approvalAddress, "0x88888dd82A91f0406ED42BF750bAF881e64894F6");
  assert.ok(Array.isArray(q.route.nativeFees) && q.route.nativeFees.length >= 1, "network fee carried");
  assert.equal(q.route.nativeFees[0].nativeFeeSymbol, "AVAX");
  assert.ok(Array.isArray(q.route.tokenFees) && q.route.tokenFees.length >= 1, "token fee carried");
  assert.equal(q.route.extraData !== null, true, "extraData kept for the buildTx continuation");
  assert.equal(q.raw, body, "raw body kept verbatim");
});

test("wanchain quote: parseWanchainQuoteResponse over the REAL failed-route bodies (honest passthrough)", () => {
  // ADA → SOL: the flagship route the docs' product matrix implies — the
  // live API refuses it. The parse must say ok:false with the upstream
  // error, never a fabricated route.
  const adaSol = loadFixture("quote-ada-sol-100ada.failed.json");
  const q1 = parseWanchainQuoteResponse(adaSol);
  assert.equal(q1.ok, false);
  assert.equal(q1.route, null);
  assert.match(q1.error, /get quotes failed/);
  assert.match(q1.error, /From Chain not supported/);
  assert.equal(q1.raw, adaSol);

  // Control: EVM USDC → SOL also has no pair ("no token pair for SOL").
  const ethSol = loadFixture("quote-eth-usdc-sol-100usdc.failed.json");
  const q2 = parseWanchainQuoteResponse(ethSol);
  assert.equal(q2.ok, false);
  assert.match(q2.error, /no token pair for SOL/);

  // The invalid-address body (format validation happens before routing).
  const badAddr = loadFixture("quote-ada-sol-100ada.invalid-addr.failed.json");
  const q3 = parseWanchainQuoteResponse(badAddr);
  assert.equal(q3.ok, false);
  assert.equal(q3.error, "Invalid fromAddress");

  // Non-object garbage.
  const garbage = parseWanchainQuoteResponse(null);
  assert.equal(garbage.ok, false);
  assert.equal(garbage.error, "invalid_wanchain_quote_body");
  assert.equal(isOkResponse(null), false);
});

test("wanchain quote: config — the quotable registry is the live-verified set (EVM class ONLY)", () => {
  assert.deepEqual(WANCHAIN_SOURCE_KEYS, ["eth"], "only the EVM representative is quotable today");
  assert.equal(WANCHAIN_SOURCES.eth.chainId, 1);
  assert.equal(isWanchainQuotableSource("eth"), true);
  // Cardano / Sui / Polkadot / native UTXOs are NOT quotable through any
  // public Wanchain HTTP API (verified live 2026-09-05 — every probe
  // failed; see the fixtures). The registry must not silently grow
  // wishlist chains — re-verify with a live probe FIRST.
  for (const wish of ["ada", "cardano", "sui", "polkadot", "dot", "btc", "tron"]) {
    assert.equal(isWanchainQuotableSource(wish), false, `${wish} is not in the quotable registry`);
    assert.equal(WANCHAIN_SOURCES[wish], undefined);
  }
  assert.equal(WANCHAIN_NATIVE_ADDRESS, "0x0000000000000000000000000000000000000000");
});

test("wanchain quote: the ADA + SOL address vectors used by the live probes are structurally valid (context)", () => {
  // The failed-route evidence is only meaningful if the addresses were
  // valid-format (so the failure is a ROUTE failure, not an address
  // failure). The invalid-addr fixture proves the API validates format
  // BEFORE routing — and the CIP-19 vector passes that gate.
  assert.equal(ADA.length, 103, "CIP-19 mainnet base address is 103 chars");
  assert.equal(SOL.length, 44, "base58 Solana pubkey is 44 chars");
  assert.equal(WANCHAIN_SOURCES.eth.decimals, 18);
});
