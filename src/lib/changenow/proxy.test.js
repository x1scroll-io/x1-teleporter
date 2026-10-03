/**
 * proxy.test.js — api/changenow/* (the serverless proxies that hold the
 * ChangeNow key server-side).
 *
 * Proves the three proxies' pure builders + the fail-closed contract:
 *   - the quote + min-amount URL builders forward ONLY the whitelisted params,
 *     INCLUDING fromNetwork/toNetwork (a same-name ticker on another chain is a
 *     different asset — the network must travel),
 *   - the create-body builder forwards fromNetwork/toNetwork too and defaults
 *     flow=standard / type=direct,
 *   - every handler FAILS CLOSED (502 no_api_key) when the server key is
 *     missing, before any upstream call,
 *   - the create handler forwards the network fields upstream verbatim.
 *
 * Pure node:test (no jsdom). The create handler's upstream fetch is a
 * monkeypatched global fetch, restored after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import quoteHandler, { buildEstimateUrl } from "../../../api/changenow/quote.js";
import createHandler, { buildExchangeBody, FORWARD_FIELDS } from "../../../api/changenow/create.js";
import minAmountHandler, { buildMinAmountUrl } from "../../../api/changenow/minAmount.js";
import statusHandler, { buildStatusUrl } from "../../../api/changenow/status.js";

const UPSTREAM = "https://api.changenow.io";

function fakeReq({ method = "GET", query = {}, body = {}, origin } = {}) {
  return { headers: origin === undefined ? {} : { origin }, method, query, body };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

// ── pure builders ───────────────────────────────────────────────────────────

test("changenow proxy: the quote URL forwards fromCurrency/fromNetwork/toCurrency/toNetwork/fromAmount/flow only", () => {
  const url = buildEstimateUrl({
    fromCurrency: "xmr", fromNetwork: "xmr", toCurrency: "usdc", toNetwork: "sol",
    fromAmount: "1.5", flow: "standard",
    apiKey: "should-not-forward", extra: "nope",
  });
  assert.ok(url.startsWith(`${UPSTREAM}/v2/exchange/estimated-amount?`));
  assert.ok(url.includes("fromCurrency=xmr"));
  assert.ok(url.includes("fromNetwork=xmr"));
  assert.ok(url.includes("toCurrency=usdc"));
  assert.ok(url.includes("toNetwork=sol"));
  assert.ok(url.includes("fromAmount=1.5"));
  assert.ok(url.includes("flow=standard"));
  assert.ok(!url.includes("apiKey"), "non-whitelisted fields never pass through");
  assert.ok(!url.includes("extra="), "non-whitelisted fields never pass through");
});

test("changenow proxy: the min-amount URL forwards the pair + networks only", () => {
  const url = buildMinAmountUrl({ fromCurrency: "ada", toCurrency: "usdc", fromNetwork: "ada", toNetwork: "sol", junk: "x" });
  assert.ok(url.startsWith(`${UPSTREAM}/v2/exchange/min-amount?`));
  assert.ok(url.includes("fromCurrency=ada"));
  assert.ok(url.includes("toCurrency=usdc"));
  assert.ok(url.includes("fromNetwork=ada"));
  assert.ok(url.includes("toNetwork=sol"));
  assert.ok(!url.includes("junk"), "non-whitelisted fields never pass through");
});

test("changenow proxy: the status URL is /v2/exchange/{id} with the id as an encoded path segment", () => {
  assert.equal(buildStatusUrl("ex1"), `${UPSTREAM}/v2/exchange/ex1`);
  assert.equal(buildStatusUrl("a/b"), `${UPSTREAM}/v2/exchange/a%2Fb`, "a crafted id can never break out of the path");
  assert.equal(buildStatusUrl("  ex2  "), `${UPSTREAM}/v2/exchange/ex2`, "trimmed");
});

test("changenow proxy: the create body pins the network(s) and defaults flow/type", () => {
  assert.ok(FORWARD_FIELDS.includes("fromNetwork") && FORWARD_FIELDS.includes("toNetwork"), "network fields are whitelisted");
  const body = buildExchangeBody({
    fromCurrency: "xmr", fromNetwork: "xmr", toCurrency: "usdc", toNetwork: "sol",
    fromAmount: "1.5", address: "So1anaAddr", refundAddress: "xmrRefund",
    apiKey: "should-not-forward",
  });
  assert.deepEqual(body, {
    fromCurrency: "xmr", fromNetwork: "xmr", toCurrency: "usdc", toNetwork: "sol",
    fromAmount: "1.5", address: "So1anaAddr", refundAddress: "xmrRefund",
    flow: "standard", type: "direct",
  });
});

// ── fail-closed (no server key) ─────────────────────────────────────────────

test("changenow proxy: every handler FAILS CLOSED (502 no_api_key) with no upstream call", async () => {
  const prev = process.env.CHANGENOW_API_KEY;
  delete process.env.CHANGENOW_API_KEY;
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    for (const [handler, req] of [
      [quoteHandler, fakeReq({ query: { fromCurrency: "xmr", toCurrency: "usdc" } })],
      [minAmountHandler, fakeReq({ query: { fromCurrency: "xmr", toCurrency: "usdc" } })],
      [createHandler, fakeReq({ method: "POST", body: { fromCurrency: "xmr", toCurrency: "usdc", fromAmount: "1", address: "a" } })],
      [statusHandler, fakeReq({ query: { id: "ex1" } })],
    ]) {
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.error, "no_api_key");
    }
    assert.equal(called, false, "no upstream call without a server key");
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.CHANGENOW_API_KEY;
    else process.env.CHANGENOW_API_KEY = prev;
  }
});

// ── handler forwards upstream ───────────────────────────────────────────────

test("changenow proxy: the create handler forwards fromNetwork/toNetwork upstream verbatim", async () => {
  const prev = process.env.CHANGENOW_API_KEY;
  process.env.CHANGENOW_API_KEY = "k-server";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ payinAddress: "4AdDress", id: "ex1" }) };
  };
  try {
    const res = fakeRes();
    await createHandler(
      fakeReq({ method: "POST", body: { fromCurrency: "xmr", fromNetwork: "xmr", toCurrency: "usdc", toNetwork: "sol", fromAmount: "1", address: "So1anaAddr" } }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.payinAddress, "4AdDress");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${UPSTREAM}/v2/exchange`);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.fromNetwork, "xmr", "the network param reaches ChangeNOW");
    assert.equal(sent.toNetwork, "sol");
    assert.equal(calls[0].init.headers["x-changenow-api-key"], "k-server", "the SERVER key travels in the header");
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.CHANGENOW_API_KEY;
    else process.env.CHANGENOW_API_KEY = prev;
  }
});

test("changenow proxy: the create handler refuses a payout-less request before the upstream call", async () => {
  const prev = process.env.CHANGENOW_API_KEY;
  process.env.CHANGENOW_API_KEY = "k-server";
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const res = fakeRes();
    await createHandler(fakeReq({ method: "POST", body: { fromCurrency: "xmr", toCurrency: "usdc", fromAmount: "1" } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "missing_params");
    assert.equal(called, false, "no upstream call for an unpayable exchange");
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.CHANGENOW_API_KEY;
    else process.env.CHANGENOW_API_KEY = prev;
  }
});

test("changenow proxy: the status handler refuses a missing id before the upstream call", async () => {
  const prev = process.env.CHANGENOW_API_KEY;
  process.env.CHANGENOW_API_KEY = "k-server";
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const res = fakeRes();
    await statusHandler(fakeReq({ query: {} }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "missing_params");
    assert.equal(called, false, "no upstream call without an exchange id");
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.CHANGENOW_API_KEY;
    else process.env.CHANGENOW_API_KEY = prev;
  }
});

test("changenow proxy: the status handler forwards the id to /v2/exchange/{id} with the server key", async () => {
  const prev = process.env.CHANGENOW_API_KEY;
  process.env.CHANGENOW_API_KEY = "k-server";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ id: "ex1", status: "finished" }) };
  };
  try {
    const res = fakeRes();
    await statusHandler(fakeReq({ query: { id: "ex1" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "finished");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${UPSTREAM}/v2/exchange/ex1`);
    assert.equal(calls[0].init.headers["x-changenow-api-key"], "k-server", "the SERVER key travels in the header");
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.CHANGENOW_API_KEY;
    else process.env.CHANGENOW_API_KEY = prev;
  }
});
