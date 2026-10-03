/**
 * quoteProxy.test.js — api/wanchain/quote.js (the serverless proxy for the
 * Wanchain-family XFlows v3 quote endpoint — same SECURITY FIX pattern as
 * api/rango/quote.js + api/thorchain/quote.js PR #20).
 *
 * The client (src/lib/wanchain/quote.js) calls THIS proxy instead of
 * xflows.wanchain.org directly, so (a) only whitelisted body fields ever
 * reach the upstream, (b) a future API key would live server-side only
 * (WANCHAIN_API_URL hook — XFlows is keyless today, verified live
 * 2026-09-05), and (c) the CORS allowlist applies uniformly. This suite
 * proves the proxy:
 *   - answers OPTIONS + applies the SAME CORS allowlist (foreign origin →
 *     403 before any upstream call, no-Origin passes through),
 *   - refuses non-POST methods (405 — the XFlows quote endpoint is a POST),
 *   - rejects non-JSON bodies (400),
 *   - forwards ONLY the whitelisted body fields upstream (nothing else),
 *   - passes upstream status + body through verbatim (the client's
 *     parseWanchainQuoteResponse handles both OK and failure bodies),
 *   - fails closed: non-JSON upstream body → 502, upstream failure → 502
 *     wanchain_quote_failed.
 *
 * Pure node:test (no jsdom, no network — fetchImpl is injected).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWanchainQuoteProxy,
  proxyQuoteUrl,
  FORWARD_FIELDS,
  WANCHAIN_QUOTE_PATH,
  WANCHAIN_DEFAULT_API_BASE_URL,
} from "../../../api/wanchain/quote.js";

const FOREIGN_ORIGIN = "https://evil.example";
const OK_BODY = {
  success: true,
  data: { amountOut: "9.8", amountOutRaw: "9800000000000000000" },
};

function fakeReq({ origin, method = "POST", body = {} } = {}) {
  return { headers: origin === undefined ? {} : { origin }, method, body };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    end() {
      return this;
    },
  };
}

function fakeFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 200,
      async text() {
        return JSON.stringify(OK_BODY);
      },
    };
  };
  impl.calls = calls;
  return impl;
}

test("wanchain proxy: proxyQuoteUrl hits the XFlows v3 quote path on the default base", () => {
  assert.equal(
    proxyQuoteUrl(),
    `${WANCHAIN_DEFAULT_API_BASE_URL}${WANCHAIN_QUOTE_PATH}`
  );
  assert.equal(proxyQuoteUrl("https://example.test/"), "https://example.test/api/v3/quote", "trailing slash stripped");
  assert.equal(WANCHAIN_QUOTE_PATH, "/api/v3/quote");
});

test("wanchain proxy: FORWARD_FIELDS matches the client whitelist exactly", () => {
  assert.deepEqual(FORWARD_FIELDS, [
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
});

test("wanchain proxy: forwards ONLY the whitelisted body fields upstream, passes the body verbatim", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createWanchainQuoteProxy({ fetchImpl, env: {} });
  const res = fakeRes();
  await handler(
    fakeReq({
      body: {
        fromChainId: 1,
        toChainId: 888,
        fromTokenAddress: "0x0000000000000000000000000000000000000000",
        toTokenAddress: "0x0000000000000000000000000000000000000000",
        fromAddress: "0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200",
        toAddress: "0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200",
        fromAmount: "10",
        inject: "nope",
        evil: { nested: true },
      },
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true, "upstream body passed through verbatim");
  const upstream = fetchImpl.calls[0];
  assert.equal(upstream.url, `${WANCHAIN_DEFAULT_API_BASE_URL}${WANCHAIN_QUOTE_PATH}`);
  assert.equal(upstream.init.method, "POST");
  const sent = JSON.parse(upstream.init.body);
  assert.deepEqual(Object.keys(sent).sort(), [
    "fromAddress",
    "fromAmount",
    "fromChainId",
    "fromTokenAddress",
    "toAddress",
    "toChainId",
    "toTokenAddress",
  ]);
  assert.equal(sent.inject, undefined, "foreign fields stripped");
  assert.equal(sent.evil, undefined, "foreign fields stripped (nested too)");
});

test("wanchain proxy: non-POST methods refused (405); non-JSON body refused (400)", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createWanchainQuoteProxy({ fetchImpl, env: {} });
  const get = fakeRes();
  await handler(fakeReq({ method: "GET", body: undefined }), get);
  assert.equal(get.statusCode, 405);
  assert.equal(get.body.error, "method_not_allowed");
  assert.equal(fetchImpl.calls.length, 0);

  // Express parses JSON bodies before the handler; a raw string body that is
  // not JSON is refused (fail closed), never forwarded as garbage.
  const rawRes = fakeRes();
  const rawHandler = createWanchainQuoteProxy({ fetchImpl, env: {} }).handler;
  const req = { headers: {}, method: "POST", body: "{not json" };
  await rawHandler(req, rawRes);
  assert.equal(rawRes.statusCode, 400);
  assert.equal(rawRes.body.error, "invalid_json");
  assert.equal(fetchImpl.calls.length, 0);
});

test("wanchain proxy: CORS — foreign origin gets a 403 before any upstream call", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createWanchainQuoteProxy({ fetchImpl, env: {} });
  const res = fakeRes();
  await handler(fakeReq({ origin: FOREIGN_ORIGIN, body: { fromChainId: 1 } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "origin_not_allowed");
  assert.equal(fetchImpl.calls.length, 0, "no upstream call from a foreign origin");
});

test("wanchain proxy: CORS — allowed origin passes with CORS headers; no-Origin passes through; OPTIONS answered", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createWanchainQuoteProxy({ fetchImpl, env: {} });
  const res = fakeRes();
  await handler(
    fakeReq({ origin: "https://x1teleporter.com", body: { fromChainId: 1, toChainId: 888, fromTokenAddress: "0x0", toTokenAddress: "0x0", fromAddress: "0x1", toAddress: "0x2", fromAmount: "1" } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://x1teleporter.com");

  const res2 = fakeRes();
  await handler(fakeReq({ body: { fromChainId: 1, toChainId: 888, fromTokenAddress: "0x0", toTokenAddress: "0x0", fromAddress: "0x1", toAddress: "0x2", fromAmount: "1" } }), res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.headers["Access-Control-Allow-Origin"], undefined);

  const pre = fakeRes();
  await handler(fakeReq({ method: "OPTIONS" }), pre);
  assert.equal(pre.statusCode, 200);
});

test("wanchain proxy: fails closed on upstream trouble — non-JSON body → 502, thrown error → 502 wanchain_quote_failed", async () => {
  const notJson = async () => ({
    status: 502,
    async text() {
      return "<html>gateway error</html>";
    },
  });
  const { handler: nonJsonHandler } = createWanchainQuoteProxy({ fetchImpl: notJson, env: {} });
  const res = fakeRes();
  await nonJsonHandler(fakeReq({ body: { fromChainId: 1 } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "wanchain_quote_non_json");
  assert.match(res.body.message, /<html>/);

  const boom = async () => {
    throw new Error("upstream exploded");
  };
  const { handler: failingHandler } = createWanchainQuoteProxy({ fetchImpl: boom, env: {} });
  const res2 = fakeRes();
  await failingHandler(fakeReq({ body: { fromChainId: 1 } }), res2);
  assert.equal(res2.statusCode, 502);
  assert.equal(res2.body.error, "wanchain_quote_failed");
  assert.match(res2.body.message, /upstream exploded/);
});

test("wanchain proxy: WANCHAIN_API_URL env override re-points the upstream base (server-side only)", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createWanchainQuoteProxy({
    fetchImpl,
    env: { WANCHAIN_API_URL: "https://xflows-api.example.test" },
  });
  const res = fakeRes();
  await handler(fakeReq({ body: { fromChainId: 1, toChainId: 888, fromTokenAddress: "0x0", toTokenAddress: "0x0", fromAddress: "0x1", toAddress: "0x2", fromAmount: "1" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(fetchImpl.calls[0].url, "https://xflows-api.example.test/api/v3/quote");
});
