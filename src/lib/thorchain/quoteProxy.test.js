/**
 * quoteProxy.test.js — api/thorchain/quote.js (the serverless proxy that
 * holds the THORChain aggregator key server-side, PR #20 SECURITY FIX).
 *
 * The client (src/lib/thorchain/quote.js) calls THIS proxy instead of
 * THORNode directly, so the key (THORCHAIN_API_KEY — server env, no VITE_
 * prefix) never reaches the browser bundle. This suite proves the proxy:
 *   - forwards ONLY the whitelisted quote params upstream (from_asset /
 *     to_asset / amount / destination / refund_address / affiliate /
 *     affiliate_bps — nothing else passes through),
 *   - attaches the key in the documented x-client-id header,
 *   - FAILS CLOSED when the server key is missing (502 no_api_key, no
 *     upstream call) — a quote without the aggregator key would silently
 *     skip affiliate attribution,
 *   - applies the SAME CORS allowlist as the other api/ routes (api/_cors.js):
 *     foreign origin → 403 before any upstream call, allowed origins pass
 *     with CORS headers, no-Origin (same-origin / API_BASE="") passes
 *     through without CORS headers,
 *   - answers the OPTIONS preflight,
 *   - passes upstream status + body through verbatim (the client's
 *     parseQuoteResponse handles THORNode error bodies),
 *   - upstream failure → 502 thorchain_quote_failed.
 *
 * Pure node:test (no jsdom, no network — fetchImpl is injected).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createThorchainQuoteProxy,
  proxyQuoteUrl,
  FORWARD_PARAMS,
  THORCHAIN_QUOTE_PATH,
} from "../../../api/thorchain/quote.js";

const UPSTREAM = "https://liquify.thorchain.org";
const SOL_DEST = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

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
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
}

/** In-memory upstream response. */
function upstreamResponse(body, status = 200) {
  return { status, text: async () => JSON.stringify(body) };
}

/** Build a proxy with an injected fetchImpl that records calls. */
function makeProxy({ key = "k-server", fetchImpl } = {}) {
  const calls = [];
  const proxy = createThorchainQuoteProxy({
    env: { THORCHAIN_API_KEY: key },
    fetchImpl:
      fetchImpl ??
      (async (url, init) => {
        calls.push({ url, init });
        return upstreamResponse({ expected_amount_out: "4560000", slippage_bps: 38 });
      }),
  });
  return { handler: proxy.handler, calls };
}

const QUOTE_QUERY = {
  from_asset: "BTC.BTC",
  to_asset: "SOL.SOL",
  amount: "5000000",
  destination: SOL_DEST,
  refund_address: "bc1qrefund",
};

// ─────────────────────────────────────────────────────────────────────────────
// PARAM WHITELIST (pure) — nothing but the documented params passes through
// ─────────────────────────────────────────────────────────────────────────────
test("whitelist is exactly the documented quote params", () => {
  assert.deepEqual(FORWARD_PARAMS, [
    "from_asset",
    "to_asset",
    "amount",
    "destination",
    "refund_address",
    "affiliate",
    "affiliate_bps",
  ]);
});

test("proxyQuoteUrl: forwards whitelisted params, drops unknown + empty ones", () => {
  const url = proxyQuoteUrl({
    from_asset: "BTC.BTC",
    to_asset: "SOL.SOL",
    amount: "5000000",
    destination: SOL_DEST,
    refund_address: "",
    affiliate: "teleporter",
    affiliate_bps: "100",
    // Anything not on the whitelist must NOT pass through.
    x_client_id: "should-not-forward",
    destination_chain: "should-not-forward",
    from_address: "should-not-forward",
  });
  assert.ok(url.startsWith(UPSTREAM + THORCHAIN_QUOTE_PATH + "?"), url);
  assert.ok(url.includes("from_asset=BTC.BTC"));
  assert.ok(url.includes("to_asset=SOL.SOL"));
  assert.ok(url.includes("amount=5000000"));
  assert.ok(url.includes("destination=" + encodeURIComponent(SOL_DEST)));
  assert.ok(url.includes("affiliate=teleporter"));
  assert.ok(url.includes("affiliate_bps=100"));
  assert.ok(!url.includes("refund_address"), "empty params are dropped");
  assert.ok(!url.includes("x_client_id"), "non-whitelisted params never pass through");
  assert.ok(!url.includes("from_address"), "non-whitelisted params never pass through");
  assert.ok(!url.includes("destination_chain"), "non-whitelisted params never pass through");
});

test("proxyQuoteUrl: no params → bare path (no trailing ?)", () => {
  assert.equal(proxyQuoteUrl({}), UPSTREAM + THORCHAIN_QUOTE_PATH);
});

test("proxyQuoteUrl: baseUrl trailing slash is normalised", () => {
  const url = proxyQuoteUrl({ from_asset: "BTC.BTC" }, "https://thornode.example/");
  assert.equal(url, "https://thornode.example" + THORCHAIN_QUOTE_PATH + "?from_asset=BTC.BTC");
});

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER — key handling, CORS, passthrough
// ─────────────────────────────────────────────────────────────────────────────
test("proxy: forwards whitelisted params to THORNode with the key in x-client-id", async () => {
  const { handler, calls } = makeProxy();
  const res = fakeRes();
  await handler(fakeReq({ query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { expected_amount_out: "4560000", slippage_bps: 38 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(UPSTREAM + THORCHAIN_QUOTE_PATH + "?"), calls[0].url);
  assert.ok(calls[0].url.includes("from_asset=BTC.BTC"));
  assert.ok(calls[0].url.includes("amount=5000000"));
  assert.equal(calls[0].init.headers["x-client-id"], "k-server", "the SERVER key travels in x-client-id");
  assert.equal(calls[0].init.headers.Accept, "application/json");
});

test("proxy: MISSING SERVER KEY → FAIL CLOSED (502 no_api_key), no upstream call", async () => {
  let called = false;
  const { handler } = makeProxy({
    key: "",
    fetchImpl: async () => {
      called = true;
      return upstreamResponse({});
    },
  });
  const res = fakeRes();
  await handler(fakeReq({ query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "no_api_key");
  assert.equal(called, false, "no upstream call without a server key");
});

test("proxy: whitespace-only key is treated as missing (fail closed)", async () => {
  let called = false;
  const { handler } = makeProxy({
    key: "   ",
    fetchImpl: async () => {
      called = true;
      return upstreamResponse({});
    },
  });
  const res = fakeRes();
  await handler(fakeReq({ query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "no_api_key");
  assert.equal(called, false);
});

test("proxy: FOREIGN origin → 403 before any upstream call (same CORS allowlist as the other api/ routes)", async () => {
  let called = false;
  const { handler } = makeProxy({
    fetchImpl: async () => {
      called = true;
      return upstreamResponse({});
    },
  });
  const res = fakeRes();
  await handler(fakeReq({ origin: "https://evil.example", query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "origin_not_allowed" });
  assert.equal(called, false, "foreign origin is blocked before the upstream call");
});

test("proxy: ALLOWED origin passes with CORS headers", async () => {
  const { handler, calls } = makeProxy();
  const res = fakeRes();
  await handler(fakeReq({ origin: "https://x1teleporter.com", query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "https://x1teleporter.com");
  assert.equal(calls.length, 1);
});

test("proxy: no-Origin (same-origin / API_BASE=\"\") passes through with NO CORS headers", async () => {
  const { handler, calls } = makeProxy();
  const res = fakeRes();
  await handler(fakeReq({ query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  assert.equal(calls.length, 1);
});

test("proxy: OPTIONS preflight is answered (200) for an allowed origin", async () => {
  const { handler, calls } = makeProxy();
  const res = fakeRes();
  await handler(fakeReq({ origin: "https://next.x1teleporter.com", method: "OPTIONS", query: {} }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0, "preflight never reaches the upstream");
});

test("proxy: upstream non-2xx body + status pass through verbatim (client parses THORNode errors)", async () => {
  const { handler } = makeProxy({
    fetchImpl: async () => upstreamResponse({ error: "chain halted" }, 400),
  });
  const res = fakeRes();
  await handler(fakeReq({ query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "chain halted" });
});

test("proxy: upstream network failure → 502 thorchain_quote_failed", async () => {
  const { handler } = makeProxy({
    fetchImpl: async () => {
      throw new Error("upstream DNS");
    },
  });
  const res = fakeRes();
  await handler(fakeReq({ query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "thorchain_quote_failed");
  assert.match(res.body.message, /upstream DNS/);
});

test("proxy: non-JSON upstream body is passed through as { raw } (defensive)", async () => {
  const { handler } = makeProxy({
    fetchImpl: async () => ({ status: 502, text: async () => "<html>bad gateway</html>" }),
  });
  const res = fakeRes();
  await handler(fakeReq({ query: QUOTE_QUERY }), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { raw: "<html>bad gateway</html>" });
});

test("proxy: repeated query params use the first value", async () => {
  const { handler, calls } = makeProxy();
  const res = fakeRes();
  await handler(fakeReq({ query: { from_asset: ["BTC.BTC", "DOGE.DOGE"], to_asset: "SOL.SOL" } }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(calls[0].url.includes("from_asset=BTC.BTC"), calls[0].url);
  assert.ok(!calls[0].url.includes("DOGE"), "only the first value is forwarded");
});
