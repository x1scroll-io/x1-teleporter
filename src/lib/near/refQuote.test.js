/**
 * refQuote.test.js — the Ref Finance quote producer (read-only, DI-clean,
 * fail-closed). No network: fetch + the SDK estimator are injected fakes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  refQuote,
  shapeRefPoolsRequest,
  parseRefPoolsResponse,
  normalizeRefEstimate,
  REF_INDEXER_BASE,
} from "./refQuote.js";

const TOKEN_IN = { id: "wrap.near", symbol: "wNEAR", decimals: 24 };
const TOKEN_OUT = { id: "usdt.tether-token.near", symbol: "USDT", decimals: 6 };

test("shapeRefPoolsRequest: deterministic indexer URL", () => {
  assert.deepEqual(shapeRefPoolsRequest(), { url: `${REF_INDEXER_BASE}/list-token-pools`, method: "GET" });
  assert.equal(shapeRefPoolsRequest({ base: "https://x.test" }).url, "https://x.test/list-token-pools");
});

test("parseRefPoolsResponse: normalizes array | {data} | {pools} | garbage", () => {
  assert.deepEqual(parseRefPoolsResponse([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(parseRefPoolsResponse({ data: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(parseRefPoolsResponse({ pools: [{ id: 3 }] }), [{ id: 3 }]);
  assert.deepEqual(parseRefPoolsResponse({ nope: 1 }), []);
});

test("normalizeRefEstimate: picks the best view + computes min-out", () => {
  const q = normalizeRefEstimate([{ estimate: "1000", pool: { id: 7, tokenIds: ["a", "b"] } }], {
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountInRaw: "500",
    slippageBps: 100,
  });
  assert.equal(q.venue, "ref-finance");
  assert.equal(q.chain, "near");
  assert.equal(q.router, "v2.ref-finance.near");
  assert.equal(q.amountOutRaw, "1000");
  assert.equal(q.amountOutMinRaw, "990"); // 1000 * 9900 / 10000
  assert.equal(q.pool, "7");
  assert.deepEqual(q.route, ["a", "b"]);
});

test("normalizeRefEstimate: empty/invalid views → null", () => {
  assert.equal(normalizeRefEstimate([], { tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountInRaw: "1" }), null);
  assert.equal(normalizeRefEstimate([{ foo: 1 }], { tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountInRaw: "1" }), null);
});

test("refQuote: reads the indexer then estimates (injected fetch + estimator)", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /list-token-pools$/);
    return { ok: true, json: async () => ({ data: [{ id: 11 }] }) };
  };
  let seenPools = null;
  const estimateSwap = async ({ simplePools }) => {
    seenPools = simplePools;
    return [{ estimate: "777", pool: { id: 11, tokenIds: [TOKEN_IN.id, TOKEN_OUT.id] } }];
  };
  const q = await refQuote({
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountInRaw: "1000",
    fetchImpl,
    estimateSwap,
    parsePool: (p) => p,
  });
  assert.equal(q.amountOutRaw, "777");
  assert.deepEqual(seenPools, [{ id: 11 }]);
});

test("refQuote: pre-supplied pools skip the fetch entirely", async () => {
  let fetched = false;
  const q = await refQuote({
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountInRaw: "1000",
    pools: [{ id: 5 }],
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, json: async () => [] };
    },
    estimateSwap: async () => [{ estimate: "42", pool: { id: 5 } }],
  });
  assert.equal(fetched, false);
  assert.equal(q.amountOutRaw, "42");
});

test("refQuote: fail-closed on a dead endpoint / bad status / fetch throw", async () => {
  assert.equal(await refQuote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountInRaw: "1", fetchImpl: async () => ({ ok: false }), estimateSwap: async () => [], parsePool: (x) => x }), null);
  assert.equal(await refQuote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountInRaw: "1", fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, estimateSwap: async () => [], parsePool: (x) => x }), null);
  assert.equal(await refQuote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountInRaw: "1", fetchImpl: async () => ({ ok: true, json: async () => [] }), estimateSwap: async () => [], parsePool: (x) => x }), null);
});

test("refQuote: fail-closed when the estimator throws / bad inputs", async () => {
  assert.equal(await refQuote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountInRaw: "1", pools: [{ id: 1 }], estimateSwap: async () => { throw new Error("no pool"); } }), null);
  assert.equal(await refQuote({ tokenIn: null, tokenOut: TOKEN_OUT, amountInRaw: "1", pools: [] }), null);
  assert.equal(await refQuote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountInRaw: "abc", pools: [] }), null);
});
