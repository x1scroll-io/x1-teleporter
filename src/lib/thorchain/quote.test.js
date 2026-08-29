/**
 * quote.test.js — THORChain aggregator quote + size-cap (Step 3.3).
 *
 * The quote endpoint is MOCKED in every test (the REAL THORCHAIN_API_KEY is
 * a parked item — Mr. Esters owns it; see docs/BRIEF.md open items). Proves:
 *   - the key comes from the ENV at call time (readApiKey — runbook name
 *     plus the VITE_/NEXT_PUBLIC_ client-exposed names), never hardcoded,
 *   - with NO key the fetcher FAILS CLOSED (reason "no-api-key") — a quote
 *     is never fetched without the aggregator key,
 *   - the URL is the THORChain aggregator quote endpoint with the documented
 *     query params (amounts in 1e8 base units; affiliate pair omitted while
 *     the THORName placeholder is empty),
 *   - the key travels in the documented x-client-id header,
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
  readApiKey,
  toThorchainBaseUnits,
  fromThorchainBaseUnits,
  quoteUrl,
  parseQuoteResponse,
  createQuoteFetcher,
  swapCapInSourceUnits,
  assertWithinSwapCap,
  THORCHAIN_QUOTE_PATH,
  THORCHAIN_API_KEY_HEADER,
} from "./quote.js";
import { THORCHAIN_AFFILIATE_NAME, THORCHAIN_AFFILIATE_BPS, THORCHAIN_MAX_SWAP_BTC_EQUIVALENT } from "./config.js";

const SOL_DEST = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** Response-like object the fetcher's fetchImpl receives. */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ─────────────────────────────────────────────────────────────────────────────
// API KEY — env at call time, never hardcoded
// ─────────────────────────────────────────────────────────────────────────────
test("readApiKey: resolves the runbook name THORCHAIN_API_KEY from env", () => {
  assert.equal(readApiKey({ THORCHAIN_API_KEY: "k-123" }), "k-123");
});

test("readApiKey: falls back to the VITE_ and NEXT_PUBLIC_ client-exposed names", () => {
  assert.equal(readApiKey({ VITE_THORCHAIN_API_KEY: "v-k" }), "v-k");
  assert.equal(readApiKey({ NEXT_PUBLIC_THORCHAIN_API_KEY: "np-k" }), "np-k");
  // Runbook name wins when multiple are present.
  assert.equal(readApiKey({ THORCHAIN_API_KEY: "k-1", VITE_THORCHAIN_API_KEY: "v-1" }), "k-1");
});

test("readApiKey: empty when unset — the fetcher fails closed, never guesses", () => {
  assert.equal(readApiKey({}), "");
  assert.equal(readApiKey({ THORCHAIN_API_KEY: "   " }), "");
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
// URL BUILDING
// ─────────────────────────────────────────────────────────────────────────────
test("quoteUrl: THORChain aggregator quote endpoint with the documented params", () => {
  const url = quoteUrl("https://liquify.thorchain.org", {
    fromAsset: "BTC.BTC",
    toAsset: "SOL.SOL",
    amountInBaseUnits: "5000000",
    destination: SOL_DEST,
    refundAddress: "bc1qrefund",
  });
  assert.ok(url.startsWith("https://liquify.thorchain.org" + THORCHAIN_QUOTE_PATH + "?"), url);
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
// FETCHER — mocked endpoint, key from env at call time
// ─────────────────────────────────────────────────────────────────────────────
test("createQuoteFetcher: fetches the quote endpoint with the key in the x-client-id header", async () => {
  const calls = [];
  const fetcher = createQuoteFetcher({
    apiKey: "k-env",
    baseUrl: "https://liquify.thorchain.org",
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
  assert.ok(calls[0].url.includes("amount=5000000"), "amount converted to base units");
  assert.equal(calls[0].init.headers[THORCHAIN_API_KEY_HEADER], "k-env", "key travels in x-client-id");
  assert.equal(THORCHAIN_API_KEY_HEADER, "x-client-id");
});

test("createQuoteFetcher: NO KEY → FAIL CLOSED with reason no-api-key (nothing is fetched)", async () => {
  let fetched = false;
  const fetcher = createQuoteFetcher({
    apiKey: "", // empty — as when THORCHAIN_API_KEY is unset
    fetchImpl: async () => {
      fetched = true;
      return jsonResponse({ expected_amount_out: "1" });
    },
  });
  const res = await fetcher.fetchQuote({ fromAsset: "BTC.BTC", toAsset: "SOL.SOL", amount: 0.01, destination: SOL_DEST });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-api-key");
  assert.match(res.message, /THORCHAIN_API_KEY/);
  assert.equal(fetched, false, "no network call without a key");
});

test("createQuoteFetcher: network errors surface as reason error", async () => {
  const fetcher = createQuoteFetcher({
    apiKey: "k",
    fetchImpl: async () => {
      throw new Error("DNS");
    },
  });
  const res = await fetcher.fetchQuote({ fromAsset: "BTC.BTC", toAsset: "SOL.SOL", amount: 0.01, destination: SOL_DEST });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "error");
  assert.match(res.message, /DNS/);
});

test("createQuoteFetcher: endpoint error bodies surface the THORNode message", async () => {
  const fetcher = createQuoteFetcher({
    apiKey: "k",
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
