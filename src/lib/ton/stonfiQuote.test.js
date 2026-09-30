/**
 * stonfiQuote.test.js — the STON.fi quote producer (read-only, DI-clean,
 * fail-closed). No network: the pool estimate + fetch are injected fakes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stonfiQuote,
  stonfiQuoteFromApi,
  shapeStonfiQuoteRequest,
  normalizeStonfiEstimate,
  STONFI_API_BASE,
} from "./stonfiQuote.js";

const OFFER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const ASK = "EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw";

test("shapeStonfiQuoteRequest: deterministic simulate URL", () => {
  const { url, method } = shapeStonfiQuoteRequest({ offerAddress: OFFER, askAddress: ASK, amountInRaw: "1000", slippageTolerance: 0.01 });
  assert.equal(method, "GET");
  assert.ok(url.startsWith(`${STONFI_API_BASE}/v1/swap/simulate?`));
  assert.match(url, /offer_address=/);
  assert.match(url, /ask_address=/);
  assert.match(url, /units=1000/);
});

test("normalizeStonfiEstimate: computes min-out + carries fees", () => {
  const q = normalizeStonfiEstimate(
    { jettonToReceive: 9000n, protocolFeePaid: 3n, refFeePaid: 1n },
    { offerAddress: OFFER, askAddress: ASK, amountInRaw: "10000", slippageBps: 100 },
  );
  assert.equal(q.venue, "stonfi");
  assert.equal(q.chain, "ton");
  assert.equal(q.router, "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt");
  assert.equal(q.amountOutRaw, "9000");
  assert.equal(q.amountOutMinRaw, "8910"); // 9000 * 9900 / 10000
  assert.equal(q.protocolFeeRaw, "3");
  assert.equal(q.refFeeRaw, "1");
  assert.equal(normalizeStonfiEstimate(null, { offerAddress: OFFER, askAddress: ASK, amountInRaw: "1" }), null);
});

test("stonfiQuote: SDK pool path (fake pool.getExpectedOutputs)", async () => {
  const pool = { getExpectedOutputs: async (provider, { amount, jettonWallet }) => ({ jettonToReceive: amount * 2n, protocolFeePaid: 0n, refFeePaid: 0n }) };
  const q = await stonfiQuote({ pool, provider: {}, offerJettonWalletAddress: "EQxyz", amountInRaw: "100", offerAddress: OFFER, askAddress: ASK });
  assert.equal(q.amountOutRaw, "200");
});

test("stonfiQuote: estimateImpl override path", async () => {
  const q = await stonfiQuote({ estimateImpl: async () => ({ jettonToReceive: 55n }), amountInRaw: "10", offerAddress: OFFER, askAddress: ASK });
  assert.equal(q.amountOutRaw, "55");
});

test("stonfiQuote: fail-closed (no pool/provider, bad amount, estimate throw)", async () => {
  assert.equal(await stonfiQuote({ amountInRaw: "10" }), null);
  assert.equal(await stonfiQuote({ pool: {}, provider: {}, amountInRaw: "nope" }), null);
  assert.equal(await stonfiQuote({ pool: { getExpectedOutputs: async () => { throw new Error("rpc down"); } }, provider: {}, amountInRaw: "1" }), null);
  assert.equal(await stonfiQuote({ estimateImpl: async () => ({}) , amountInRaw: "1" }), null); // no jettonToReceive
});

test("stonfiQuoteFromApi: parses ask_units", async () => {
  const q = await stonfiQuoteFromApi({ fetchImpl: async () => ({ ok: true, json: async () => ({ ask_units: "1234" }) }), offerAddress: OFFER, askAddress: ASK, amountInRaw: "100" });
  assert.equal(q.amountOutRaw, "1234");
});

test("stonfiQuoteFromApi: fail-closed on dead endpoint / throw / no output", async () => {
  assert.equal(await stonfiQuoteFromApi({ fetchImpl: async () => ({ ok: false }), offerAddress: OFFER, askAddress: ASK, amountInRaw: "1" }), null);
  assert.equal(await stonfiQuoteFromApi({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, offerAddress: OFFER, askAddress: ASK, amountInRaw: "1" }), null);
  assert.equal(await stonfiQuoteFromApi({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }), offerAddress: OFFER, askAddress: ASK, amountInRaw: "1" }), null);
  assert.equal(await stonfiQuoteFromApi({ offerAddress: OFFER, askAddress: ASK, amountInRaw: "1" }), null); // no fetchImpl
});
