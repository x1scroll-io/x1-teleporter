/**
 * quote.test.js — THORChain aggregator quote + size-cap (Step 3.3),
 * SECURITY-FIXED (PR #20): the quote is fetched through OUR serverless proxy
 * (/api/thorchain/quote), NOT THORNode directly, and the client NEVER holds
 * the aggregator key (it lives only in the server env; the proxy adds it).
 * The key-holding env names are BANNED from the client bundle — enforced by
 * apiKeyLeak.test.js. Proves:
 *   - the client calls OUR proxy with the documented query params (amounts
 *     in 1e8 base units; affiliate pair omitted while the THORName
 *     placeholder is empty) and NO key header,
 *   - the proxy is MOCKED in every test (the real key is a parked item —
 *     Mr. Esters owns it; the proxy's own behavior is covered by
 *     quoteProxy.test.js),
 *   - a proxy that is unreachable or returns an error body → reason "error"
 *     (fail-closed client: the address is never shown without a fresh quote),
 *   - defensive parsing: happy path, error bodies, non-2xx, malformed,
 *     halted chains, affiliateBps echo,
 *   - the size cap: config-driven (0.05 BTC-equivalent default), over-cap
 *     BLOCKED with a clear message, at-cap allowed, unknown-rate assets
 *     (DOGE/LTC/XRP until the live wiring) skipped with capKnown:false —
 *     never a guessed price.
 *
 * Pure module — runs under `node --test` with no jsdom.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toThorchainBaseUnits,
  fromThorchainBaseUnits,
  quoteUrl,
  parseQuoteResponse,
  createQuoteFetcher,
  swapCapInSourceUnits,
  assertWithinSwapCap,
  THORCHAIN_QUOTE_PROXY_PATH,
} from "./quote.js";
import { THORCHAIN_AFFILIATE_NAME, THORCHAIN_AFFILIATE_BPS, THORCHAIN_MAX_SWAP_BTC_EQUIVALENT } from "./config.js";

const SOL_DEST = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** Response-like object the fetcher's fetchImpl receives. */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROXY ROUTING — the client calls OUR proxy, never THORNode, never a key
// ─────────────────────────────────────────────────────────────────────────────
test("the client routes quotes to OUR proxy path (same-origin; the server holds the key)", () => {
  assert.equal(THORCHAIN_QUOTE_PROXY_PATH, "/api/thorchain/quote");
  const url = quoteUrl(undefined, {
    fromAsset: "BTC.BTC",
    toAsset: "SOL.SOL",
    amountInBaseUnits: "5000000",
    destination: SOL_DEST,
  });
  assert.ok(url.startsWith(THORCHAIN_QUOTE_PROXY_PATH + "?"), url);
  assert.ok(!url.includes("liquify.thorchain.org"), "client no longer targets THORNode directly");
  assert.ok(!url.includes("thornode"), "client no longer targets THORNode directly");
});

test("quoteUrl: our proxy endpoint with the documented params", () => {
  const url = quoteUrl("https://teleporter.example/api/thorchain/quote", {
    fromAsset: "BTC.BTC",
    toAsset: "SOL.SOL",
    amountInBaseUnits: "5000000",
    destination: SOL_DEST,
    refundAddress: "bc1qrefund",
  });
  assert.ok(url.startsWith("https://teleporter.example/api/thorchain/quote?"), url);
  assert.ok(url.includes("from_asset=BTC.BTC"));
  assert.ok(url.includes("to_asset=SOL.SOL"));
  assert.ok(url.includes("amount=5000000"));
  assert.ok(url.includes("destination=" + encodeURIComponent(SOL_DEST)));
  assert.ok(url.includes("refund_address=bc1qrefund"));
  // PARKED ITEM: the affiliate pair is OMITTED while the THORName placeholder
  // is empty — no invented name is ever sent to the quote API.
  assert.ok(!url.includes("affiliate"), "no affiliate params while THORName is unset");
});

test("quoteUrl: affiliate pair included only when a THORName is configured", () => {
  const url = quoteUrl(undefined, {
    fromAsset: "DOGE.DOGE",
    toAsset: "SOL.SOL",
    amountInBaseUnits: "100000000",
    destination: SOL_DEST,
    affiliate: "teleporter",
    affiliateBps: 100,
  });
  assert.ok(url.includes("affiliate=teleporter"));
  assert.ok(url.includes("affiliate_bps=100"));
});

// ─────────────────────────────────────────────────────────────────────────────
// AMOUNT CONVERSION — THORChain's 1e8 base-unit convention
// ─────────────────────────────────────────────────────────────────────────────
test("base-unit conversion: 1e8 convention for every asset (even SOL)", () => {
  assert.equal(toThorchainBaseUnits(0.05), "5000000");
  assert.equal(toThorchainBaseUnits(1), "100000000");
  assert.equal(fromThorchainBaseUnits("5000000"), 0.05);
  assert.equal(fromThorchainBaseUnits(100000000), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// PARSING — defensive, never throws
// ─────────────────────────────────────────────────────────────────────────────
test("parseQuoteResponse: happy path — expectedAmountOut in DECIMAL dest units + slippage + affiliate echo", () => {
  const parsed = parseQuoteResponse(
    {
      expected_amount_out: "4560000",
      slippage_bps: 38,
      memo: "=:SOL.SOL:" + SOL_DEST,
      inbound_address: "bc1q...",
    },
    { affiliateBps: 100 },
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.quote.expectedAmountOut, 0.0456); // 4_560_000 / 1e8 — SOL units
  assert.equal(parsed.quote.expectedAmountOutRaw, 4560000);
  assert.equal(parsed.quote.slippageBps, 38);
  assert.equal(parsed.quote.affiliateBps, 100); // echoes what WE requested
  assert.equal(parsed.quote.memo, "=:SOL.SOL:" + SOL_DEST);
  assert.equal(parsed.quote.halted, false);
});

test("parseQuoteResponse: THORNode error bodies and non-2xx are surfaced, not thrown", () => {
  assert.deepEqual(parseQuoteResponse({ error: "out of sync" }).reason, "error");
  assert.equal(parseQuoteResponse({ error: "out of sync" }).message, "out of sync");
  assert.equal(parseQuoteResponse({ expected_amount_out: "1" }, { status: 500 }).reason, "error");
  assert.match(parseQuoteResponse({ expected_amount_out: "1" }, { status: 500 }).message, /HTTP 500/);
});

test("parseQuoteResponse: proxy fail-closed bodies surface like any error body", () => {
  // The proxy's own 502 no_api_key body (server key missing — parked item)
  // is parsed by the client as a normal error: reason "error".
  const parsed = parseQuoteResponse({ error: "no_api_key" }, { status: 502 });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "error");
  assert.equal(parsed.message, "no_api_key");
});

test("parseQuoteResponse: malformed bodies are rejected defensively", () => {
  assert.equal(parseQuoteResponse(null).reason, "malformed");
  assert.equal(parseQuoteResponse([]).reason, "malformed");
  assert.equal(parseQuoteResponse({}).reason, "malformed"); // no expected_amount_out
  assert.equal(parseQuoteResponse({ expected_amount_out: "abc" }).reason, "malformed");
});

test("parseQuoteResponse: halted chains surface as halted (empty inbound_address)", () => {
  const parsed = parseQuoteResponse({ expected_amount_out: "1", inbound_address: "" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.quote.halted, true);
});

test("parseQuoteResponse: wrapped { quote: {...} } shape is accepted", () => {
  const parsed = parseQuoteResponse({ quote: { expected_amount_out: "1000000", slippage_bps: 10 } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.quote.expectedAmountOut, 0.01);
});

// ─────────────────────────────────────────────────────────────────────────────
// FETCHER — the proxy is MOCKED; the client sends params, never a key
// ─────────────────────────────────────────────────────────────────────────────
test("createQuoteFetcher: fetches OUR proxy with the quote params and NO key header", async () => {
  const calls = [];
  const fetcher = createQuoteFetcher({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ expected_amount_out: "4560000", slippage_bps: 38 });
    },
  });
  const res = await fetcher.fetchQuote({
    fromAsset: "BTC.BTC",
    toAsset: "SOL.SOL",
    amount: 0.05,
    destination: SOL_DEST,
    affiliateBps: 100,
  });
  assert.equal(res.ok, true);
  assert.equal(res.quote.expectedAmountOut, 0.0456);
  assert.equal(res.quote.affiliateBps, 100);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(THORCHAIN_QUOTE_PROXY_PATH + "?"), calls[0].url);
  assert.ok(calls[0].url.includes("amount=5000000"), "amount converted to base units");
  // SECURITY: the client never sends the aggregator key — no header at all.
  assert.equal(calls[0].init, undefined, "no request init (no key header) from the client");
});

test("createQuoteFetcher: a DI baseUrl routes to that proxy base (same-origin default)", async () => {
  const calls = [];
  const fetcher = createQuoteFetcher({
    baseUrl: "https://x1teleporter.com/api/thorchain/quote",
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ expected_amount_out: "1" });
    },
  });
  await fetcher.fetchQuote({ fromAsset: "BTC.BTC", toAsset: "SOL.SOL", amount: 0.01, destination: SOL_DEST });
  assert.ok(calls[0].startsWith("https://x1teleporter.com/api/thorchain/quote?"), calls[0]);
});

test("createQuoteFetcher: PROXY UNREACHABLE → reason error (fail-closed client: no quote, no address)", async () => {
  const fetcher = createQuoteFetcher({
    fetchImpl: async () => {
      throw new Error("DNS");
    },
  });
  const res = await fetcher.fetchQuote({ fromAsset: "BTC.BTC", toAsset: "SOL.SOL", amount: 0.01, destination: SOL_DEST });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "error");
  assert.match(res.message, /DNS/);
});

test("createQuoteFetcher: proxy error bodies surface the server message (fail-closed server)", async () => {
  // The proxy fails closed when the SERVER key is missing (502 no_api_key) —
  // the client surfaces it, never guesses a quote.
  const fetcher = createQuoteFetcher({
    fetchImpl: async () => jsonResponse({ error: "no_api_key" }, 502),
  });
  const res = await fetcher.fetchQuote({ fromAsset: "BTC.BTC", toAsset: "SOL.SOL", amount: 0.01, destination: SOL_DEST });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "error");
  assert.match(res.message, /no_api_key/);
});

test("createQuoteFetcher: endpoint error bodies surface the THORNode message", async () => {
  const fetcher = createQuoteFetcher({
    fetchImpl: async () => jsonResponse({ error: "chain halted" }, 400),
  });
  const res = await fetcher.fetchQuote({ fromAsset: "BTC.BTC", toAsset: "SOL.SOL", amount: 0.01, destination: SOL_DEST });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "error");
  assert.match(res.message, /chain halted/);
});

// ─────────────────────────────────────────────────────────────────────────────
// SIZE CAP — config value (0.05 BTC-equivalent), enforced at quote time
// ─────────────────────────────────────────────────────────────────────────────
test("size cap: config default is 0.05 BTC-equivalent (docs/BRIEF.md — config value, not hardcoded)", () => {
  assert.equal(THORCHAIN_MAX_SWAP_BTC_EQUIVALENT, 0.05);
  // BTC is 1:1 — the cap in BTC units is 0.05.
  assert.deepEqual(swapCapInSourceUnits("BTC"), { ok: true, capKnown: true, capAmount: 0.05 });
});

test("size cap: over-cap is BLOCKED with a clear message; at-cap is allowed", () => {
  const over = assertWithinSwapCap({ asset: "BTC", amount: 0.051 });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "over-cap");
  assert.match(over.message, /exceeds/);
  assert.match(over.message, /0\.05 BTC-equivalent/);
  assert.match(over.message, /reduce the amount/);
  assert.equal(over.capAmount, 0.05);

  // At-cap exactly → allowed.
  const at = assertWithinSwapCap({ asset: "BTC", amount: 0.05 });
  assert.equal(at.ok, true);
  assert.equal(at.capKnown, true);
  // Under-cap → allowed.
  assert.equal(assertWithinSwapCap({ asset: "BTC", amount: 0.001 }).ok, true);
});

test("size cap: assets with no BTC-equivalent rate yet are SKIPPED with capKnown:false — never a guessed price", () => {
  // DOGE/LTC/XRP are null until the live wiring (parked item) — the check
  // reports capKnown:false and the UI shows a note; it does not invent a rate.
  for (const asset of ["DOGE", "LTC", "XRP"]) {
    const cap = swapCapInSourceUnits(asset);
    assert.equal(cap.ok, true);
    assert.equal(cap.capKnown, false, `${asset} cap unknown until the live BTC-equivalent rate lands`);
    const check = assertWithinSwapCap({ asset, amount: 9999 });
    assert.equal(check.ok, true);
    assert.equal(check.capKnown, false);
  }
});

test("size cap: DI rates enforce the cap in source units for non-BTC assets", () => {
  const rates = { BTC: 1, DOGE: 300_000 }; // 300k DOGE per BTC (test fixture)
  const cap = swapCapInSourceUnits("DOGE", { rates });
  assert.deepEqual(cap, { ok: true, capKnown: true, capAmount: 0.05 * 300_000 });
  // 20_000 DOGE ≈ 0.0667 BTC → over the cap → blocked.
  const over = assertWithinSwapCap({ asset: "DOGE", amount: 20_000, rates });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "over-cap");
  // 10_000 DOGE ≈ 0.0333 BTC → at/under the cap → allowed.
  assert.equal(assertWithinSwapCap({ asset: "DOGE", amount: 10_000, rates }).ok, true);
});

test("size cap: DI maxBtcEquivalent overrides the config value (config-driven, not hardcoded)", () => {
  assert.equal(assertWithinSwapCap({ asset: "BTC", amount: 0.02, maxBtcEquivalent: 0.01 }).ok, false);
  assert.equal(assertWithinSwapCap({ asset: "BTC", amount: 0.01, maxBtcEquivalent: 0.01 }).ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG PLACEHOLDERS — the parked items stay parked (boundary guard)
// ─────────────────────────────────────────────────────────────────────────────
test("PARKED ITEM GUARD: the THORName placeholder is empty and the affiliate bps default is 100", () => {
  // No real THORName may exist in config — it is Mr. Esters' parked item.
  assert.equal(THORCHAIN_AFFILIATE_NAME, "", "THORName placeholder is empty until Franky registers it");
  assert.equal(THORCHAIN_AFFILIATE_BPS, 100, "affiliate_bps starts at 100 (docs/BRIEF.md)");
});
