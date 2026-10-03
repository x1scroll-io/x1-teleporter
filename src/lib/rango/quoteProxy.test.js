/**
 * quoteProxy.test.js — api/rango/quote.js (the serverless proxy that holds
 * the Rango API key server-side — Phase-5 scaffold, same SECURITY FIX as
 * api/thorchain/quote.js PR #20).
 *
 * The client (src/lib/rango/quote.js) calls THIS proxy instead of Rango
 * directly, so the key (RANGO_API_KEY — server env, no VITE_ prefix) never
 * reaches the browser bundle. Rango attaches the key as the `apiKey` QUERY
 * PARAM (verified live 2026-09-05: keyless calls 401). This suite proves
 * the proxy:
 *   - forwards ONLY the whitelisted quote params upstream (from / to /
 *     amount / slippage — nothing else passes through),
 *   - appends the server-side apiKey (never a client param),
 *   - FAILS CLOSED when the server key is missing (502 no_api_key, no
 *     upstream call),
 *   - applies the SAME CORS allowlist as the other api/ routes
 *     (api/_cors.js): foreign origin → 403 before any upstream call,
 *     allowed origins pass with CORS headers, no-Origin passes through,
 *   - answers the OPTIONS preflight,
 *   - passes upstream status + body through verbatim (the client's
 *     parseRangoQuoteResponse handles Rango bodies),
 *   - upstream failure → 502 rango_quote_failed.
 *
 * Pure node:test (no jsdom, no network — fetchImpl is injected).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRangoQuoteProxy,
  proxyQuoteUrl,
  FORWARD_PARAMS,
  RANGO_QUOTE_PATH,
  RANGO_DEFAULT_API_BASE_URL,
} from "../../../api/rango/quote.js";

const TEST_KEY = "test-key-123";
const FOREIGN_ORIGIN = "https://evil.example";

function fakeReq({ origin, method = "GET", query = {} } = {}) {
  return { headers: origin === undefined ? {} : { origin }, method, query };
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
        return JSON.stringify({ requestId: "abc", resultType: "OK", route: { outputAmount: "1" } });
      },
    };
  };
  impl.calls = calls;
  return impl;
}

test("rango proxy: proxyQuoteUrl — whitelisted params only + server apiKey appended", () => {
  const url = proxyQuoteUrl(
    { from: "SUI.SUI", to: "SOLANA.SOL", amount: "100000000000", slippage: "1", apiKey: "client-tamper", evil: "x" },
    TEST_KEY
  );
  assert.equal(
    url,
    `${RANGO_DEFAULT_API_BASE_URL}${RANGO_QUOTE_PATH}?from=SUI.SUI&to=SOLANA.SOL&amount=100000000000&slippage=1&apiKey=${TEST_KEY}`
  );
  assert.ok(!url.includes("evil"), "non-whitelisted params never pass through");
  assert.ok(!url.includes("client-tamper"), "a client-sent apiKey is stripped (server key wins)");
  // Empty client values are dropped; the key is always last.
  const sparse = proxyQuoteUrl({ from: "", amount: undefined }, TEST_KEY);
  assert.equal(sparse, `${RANGO_DEFAULT_API_BASE_URL}${RANGO_QUOTE_PATH}?apiKey=${TEST_KEY}`);
});

test("rango proxy: FORWARD_PARAMS matches the client whitelist exactly", () => {
  assert.deepEqual(FORWARD_PARAMS, ["from", "to", "amount", "slippage"]);
});

test("rango proxy: FAILS CLOSED without the server key (502 no_api_key, no upstream call)", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createRangoQuoteProxy({ fetchImpl, env: {} });
  const res = fakeRes();
  await handler(fakeReq({ query: { from: "SUI.SUI", to: "SOLANA.SOL", amount: "1", slippage: "1" } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "no_api_key");
  assert.equal(fetchImpl.calls.length, 0, "no upstream call without a key");
});

test("rango proxy: forwards whitelisted params + the server key upstream, passes the body verbatim", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createRangoQuoteProxy({ fetchImpl, env: { RANGO_API_KEY: TEST_KEY } });
  const res = fakeRes();
  await handler(
    fakeReq({
      query: { from: "SUI.SUI", to: "SOLANA.SOL", amount: "100000000000", slippage: "1", inject: "nope" },
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.resultType, "OK");
  assert.equal(fetchImpl.calls.length, 1);
  const upstream = fetchImpl.calls[0].url;
  assert.ok(upstream.startsWith(`${RANGO_DEFAULT_API_BASE_URL}${RANGO_QUOTE_PATH}?`), "hits the basic quote path");
  assert.ok(upstream.includes("from=SUI.SUI") && upstream.includes("to=SOLANA.SOL"));
  assert.ok(upstream.includes(`apiKey=${TEST_KEY}`), "server key appended");
  assert.ok(!upstream.includes("inject"), "foreign params stripped");
});

test("rango proxy: CORS — foreign origin gets a 403 before any upstream call", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createRangoQuoteProxy({ fetchImpl, env: { RANGO_API_KEY: TEST_KEY } });
  const res = fakeRes();
  await handler(fakeReq({ origin: FOREIGN_ORIGIN, query: { from: "SUI.SUI" } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "origin_not_allowed");
  assert.equal(fetchImpl.calls.length, 0, "no upstream call from a foreign origin");
});

test("rango proxy: CORS — allowed origin passes with CORS headers; no-Origin passes through", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createRangoQuoteProxy({ fetchImpl, env: { RANGO_API_KEY: TEST_KEY } });
  const res = fakeRes();
  await handler(fakeReq({ origin: "https://x1teleporter.com", query: { from: "SUI.SUI" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://x1teleporter.com");
  // No-Origin (same-origin fetches / curl / server-to-server): allowed, no CORS headers.
  const res2 = fakeRes();
  await handler(fakeReq({ query: { from: "SUI.SUI" } }), res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.headers["Access-Control-Allow-Origin"], undefined);
});

test("rango proxy: OPTIONS preflight answered; upstream failure → 502 rango_quote_failed", async () => {
  const fetchImpl = fakeFetch();
  const { handler } = createRangoQuoteProxy({ fetchImpl, env: { RANGO_API_KEY: TEST_KEY } });
  const pre = fakeRes();
  await handler(fakeReq({ method: "OPTIONS" }), pre);
  assert.equal(pre.statusCode, 200);

  const boom = async () => {
    throw new Error("upstream exploded");
  };
  const { handler: failingHandler } = createRangoQuoteProxy({ fetchImpl: boom, env: { RANGO_API_KEY: TEST_KEY } });
  const res = fakeRes();
  await failingHandler(fakeReq({ query: { from: "SUI.SUI" } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "rango_quote_failed");
  assert.match(res.body.message, /upstream exploded/);
});
