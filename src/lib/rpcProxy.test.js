/**
 * rpcProxy.test.js — api/rpc/solana.js + api/rpc/x1.js (the serverless
 * JSON-RPC passthrough proxies) + src/lib/proxiedConnection.js (the
 * client-side transport shim that routes Solana/X1 READS + simulation
 * through them).
 *
 * Live symptom (fix/proxy-solana-x1-rpc): the bridge form's Balances line
 * showed `Ethereum: <value>` but `Solana: —` / `X1: —` — the app's DIRECT
 * browser fetches to api.mainnet-beta.solana.com / rpc.mainnet.x1.xyz
 * (getTokenAccountsByOwner, getBalance) failed in the user's network while
 * EVM (Rabby's own RPC) worked; the same block broke the reverse stage-2
 * signing path. This suite proves:
 *   - api/rpc/{solana,x1} forward method+params to the SAME upstream the app
 *     used to hit directly and return the upstream JSON verbatim (POST and
 *     GET forms),
 *   - the Connection transport shim POSTs reads to the proxy path
 *     (/api/rpc/...) — never the external host — and routes WRITE broadcasts
 *     (sendTransaction/sendRawTransaction) DIRECTLY to the real RPC
 *     (writes stay with the wallet; the proxy is READS + simulation only),
 *   - balances.js reads work through the shim end-to-end (real web3.js
 *     Connection, mocked fetch answering getTokenAccountsByOwner),
 *   - fail-closed: upstream transport failure → 502 { error: solana_rpc_failed
 *     | x1_rpc_failed }, malformed requests → 400,
 *   - the same CORS allowlist as every other api/ route (403 foreign origin,
 *     OPTIONS preflight answered).
 *
 * Pure node:test (no jsdom, no network — fetchImpl is injected everywhere).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSolanaRpcProxy } from "../../api/rpc/solana.js";
import { createX1RpcProxy } from "../../api/rpc/x1.js";
import {
  DEFAULT_SOLANA_RPC,
  DEFAULT_X1_RPC,
  buildRpcBodyFromQuery,
} from "../../api/rpc/_rpc.js";
import {
  createProxiedFetch,
  createProxiedConnection,
  isBroadcastRpc,
  RPC_PROXY_PATHS,
} from "./proxiedConnection.js";
import { fetchSvmTokenBalances, SOLANA_MINTS } from "./balances.js";

// ── test doubles ────────────────────────────────────────────────────────────

function fakeReq({ origin, method = "POST", query = {}, body = null } = {}) {
  return { headers: origin === undefined ? {} : { origin }, method, query, body };
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

/** In-memory upstream response (text() so the proxy's parse path is real). */
function upstreamResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

/** A JSON-RPC response the real web3.js rpc-client can consume. The `id`
 *  MUST be a STRING — createRpcResult superstruct-validates
 *  `id: superstruct.string()` (jayson's convention). */
function rpcResult(result, id = "1") {
  return upstreamResponse({ jsonrpc: "2.0", result, id });
}

function makeSolanaProxy({ fetchImpl } = {}) {
  const calls = [];
  const proxy = createSolanaRpcProxy({
    fetchImpl:
      fetchImpl ??
      (async (url, init) => {
        calls.push({ url, init });
        return rpcResult(123456);
      }),
  });
  return { handler: proxy.handler, calls };
}

function makeX1Proxy({ fetchImpl } = {}) {
  const calls = [];
  const proxy = createX1RpcProxy({
    fetchImpl:
      fetchImpl ??
      (async (url, init) => {
        calls.push({ url, init });
        return rpcResult({ value: 7 });
      }),
  });
  return { handler: proxy.handler, calls };
}

const BODY = { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["So11111111111111111111111111111111111111112"] };

// ── api/rpc/solana ──────────────────────────────────────────────────────────

test("api/rpc/solana: POST forwards method+params to the app's Solana RPC and returns the upstream JSON verbatim", async () => {
  const { handler, calls } = makeSolanaProxy();
  const res = fakeRes();
  await handler(fakeReq({ body: BODY }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { jsonrpc: "2.0", result: 123456, id: "1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEFAULT_SOLANA_RPC, "same upstream the app used to hit directly");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), BODY, "body forwarded verbatim");
});

test("api/rpc/solana: batch array bodies pass through (web3.js _rpcBatchRequest shape)", async () => {
  const { handler, calls } = makeSolanaProxy({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return rpcResult([{ jsonrpc: "2.0", result: 1, id: 1 }]);
    },
  });
  const res = fakeRes();
  const batch = [BODY, { ...BODY, id: 2, method: "getSlot" }];
  await handler(fakeReq({ body: batch }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(calls[0].init.body), batch);
});

test("api/rpc/solana: GET ?method=&params= builds the JSON-RPC body", async () => {
  const { handler, calls } = makeSolanaProxy();
  const res = fakeRes();
  await handler(
    fakeReq({
      method: "GET",
      query: { method: "getBalance", params: JSON.stringify(["So11111111111111111111111111111111111111112"]) },
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).method, "getBalance");
  assert.deepEqual(JSON.parse(calls[0].init.body).params, ["So11111111111111111111111111111111111111112"]);
});

test("api/rpc/solana: passes an upstream HTTP error through with the upstream status + body", async () => {
  const { handler } = makeSolanaProxy({
    fetchImpl: async () => upstreamResponse({ error: { code: -32005, message: "rate limited" } }, 429),
  });
  const res = fakeRes();
  await handler(fakeReq({ body: BODY }), res);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { error: { code: -32005, message: "rate limited" } });
});

test("api/rpc/solana: transport failure → 502 solana_rpc_failed (fail-closed)", async () => {
  const { handler } = makeSolanaProxy({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  const res = fakeRes();
  await handler(fakeReq({ body: BODY }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "solana_rpc_failed");
});

test("api/rpc/solana: 400 missing_method on a body without a method (no upstream call)", async () => {
  const { handler, calls } = makeSolanaProxy();
  const res = fakeRes();
  await handler(fakeReq({ body: { jsonrpc: "2.0", id: 1 } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "missing_method");
  assert.equal(calls.length, 0);
});

test("api/rpc/solana: 400 missing_body on an empty POST (no upstream call)", async () => {
  const { handler, calls } = makeSolanaProxy();
  const res = fakeRes();
  await handler(fakeReq({ body: undefined }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "missing_body");
  assert.equal(calls.length, 0);
});

test("api/rpc/solana: foreign origin → 403 before any upstream call (same CORS allowlist)", async () => {
  const { handler, calls } = makeSolanaProxy();
  const res = fakeRes();
  await handler(fakeReq({ origin: "https://evil.example", body: BODY }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "origin_not_allowed");
  assert.equal(calls.length, 0, "no upstream call from a disallowed origin");
});

test("api/rpc/solana: answers the OPTIONS preflight", async () => {
  const { handler } = makeSolanaProxy();
  const res = fakeRes();
  await handler(fakeReq({ method: "OPTIONS", query: {} }), res);
  assert.equal(res.statusCode, 200);
});

// ── api/rpc/x1 ──────────────────────────────────────────────────────────────

test("api/rpc/x1: POST forwards method+params to the X1 mainnet RPC and returns the upstream JSON verbatim", async () => {
  const { handler, calls } = makeX1Proxy();
  const res = fakeRes();
  await handler(fakeReq({ body: BODY }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { jsonrpc: "2.0", result: { value: 7 }, id: "1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEFAULT_X1_RPC, "same upstream the app used to hit directly");
  assert.deepEqual(JSON.parse(calls[0].init.body), BODY, "body forwarded verbatim");
});

test("api/rpc/x1: transport failure → 502 x1_rpc_failed (fail-closed)", async () => {
  const { handler } = makeX1Proxy({
    fetchImpl: async () => { throw new Error("timeout"); },
  });
  const res = fakeRes();
  await handler(fakeReq({ body: BODY }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "x1_rpc_failed");
});

test("api/rpc/x1: foreign origin → 403 before any upstream call (same CORS allowlist)", async () => {
  const { handler, calls } = makeX1Proxy();
  const res = fakeRes();
  await handler(fakeReq({ origin: "https://evil.example", body: BODY }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "origin_not_allowed");
  assert.equal(calls.length, 0);
});

test("api/rpc/x1: answers the OPTIONS preflight", async () => {
  const { handler } = makeX1Proxy();
  const res = fakeRes();
  await handler(fakeReq({ method: "OPTIONS", query: {} }), res);
  assert.equal(res.statusCode, 200);
});

// ── GET query builder (pure) ────────────────────────────────────────────────

test("buildRpcBodyFromQuery: method + json-encoded array params", () => {
  assert.deepEqual(
    buildRpcBodyFromQuery({ method: "getBalance", params: '["addr"]' }),
    { body: { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["addr"] } },
  );
});

test("buildRpcBodyFromQuery: missing method → error", () => {
  assert.deepEqual(buildRpcBodyFromQuery({}), { error: "missing_method" });
  assert.deepEqual(buildRpcBodyFromQuery({ method: "  " }), { error: "missing_method" });
});

test("buildRpcBodyFromQuery: non-array / malformed params → error", () => {
  assert.deepEqual(buildRpcBodyFromQuery({ method: "getBalance", params: '{"a":1}' }), { error: "invalid_params" });
  assert.deepEqual(buildRpcBodyFromQuery({ method: "getBalance", params: "not-json" }), { error: "invalid_params" });
});

test("buildRpcBodyFromQuery: params omitted → empty array", () => {
  assert.deepEqual(buildRpcBodyFromQuery({ method: "getSlot" }), {
    body: { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] },
  });
});

// ── routing decision (pure) ─────────────────────────────────────────────────

test("isBroadcastRpc: reads + simulation are NOT broadcasts (they go through the proxy)", () => {
  for (const m of ["getBalance", "getTokenAccountsByOwner", "getAccountInfo", "getLatestBlockhash", "getSlot", "simulateTransaction", "getVersion"]) {
    assert.equal(isBroadcastRpc({ jsonrpc: "2.0", id: 1, method: m, params: [] }), false, `${m} should be proxied`);
  }
});

test("isBroadcastRpc: write broadcasts are routed DIRECT (never proxied)", () => {
  for (const m of ["sendTransaction", "sendRawTransaction"]) {
    assert.equal(isBroadcastRpc({ jsonrpc: "2.0", id: 1, method: m, params: [] }), true, `${m} should stay direct`);
  }
});

test("isBroadcastRpc: a batch containing a broadcast is treated as a broadcast", () => {
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "getBalance", params: [] },
    { jsonrpc: "2.0", id: 2, method: "sendRawTransaction", params: ["sig"] },
  ];
  assert.equal(isBroadcastRpc(batch), true);
});

// ── the transport shim ──────────────────────────────────────────────────────

test("createProxiedFetch: a READ body POSTs to the proxy path with the body verbatim", async () => {
  const calls = [];
  const proxiedFetch = createProxiedFetch({
    proxyPath: RPC_PROXY_PATHS.solana,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return upstreamResponse({ jsonrpc: "2.0", result: 1, id: 1 });
    },
  });
  const bodyText = JSON.stringify(BODY);
  await proxiedFetch("https://api.mainnet-beta.solana.com", { method: "POST", body: bodyText });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/rpc/solana", "read goes to the same-origin proxy, NOT the external host");
  assert.equal(calls[0].init.body, bodyText, "JSON-RPC body forwarded verbatim");
  assert.equal(calls[0].init.method, "POST");
});

test("createProxiedFetch: a WRITE broadcast goes DIRECT to the real RPC (never the proxy)", async () => {
  const calls = [];
  const proxiedFetch = createProxiedFetch({
    proxyPath: RPC_PROXY_PATHS.x1,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return upstreamResponse({ jsonrpc: "2.0", result: "sig", id: 1 });
    },
  });
  const bodyText = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendRawTransaction", params: ["base64tx"] });
  const originalInit = { method: "POST", body: bodyText, headers: { "Content-Type": "application/json" } };
  await proxiedFetch("https://rpc.mainnet.x1.xyz", originalInit);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://rpc.mainnet.x1.xyz", "broadcast stays direct to the real RPC");
  assert.equal(calls[0].init, originalInit, "original init passed through untouched");
});

test("createProxiedConnection: a real Connection routes reads to /api/rpc/solana", async () => {
  const calls = [];
  const conn = await createProxiedConnection("https://api.mainnet-beta.solana.com", RPC_PROXY_PATHS.solana, {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body });
      // getBalance validates against jsonRpcResultAndContext(number): the
      // result is { context: { slot }, value }.
      return rpcResult({ context: { slot: 1 }, value: 123456 });
    },
  });

  // web3.js 1.x Connection methods require PublicKey INSTANCES (they call
  // `.toBase58()` on their args) — same as the app's other call sites.
  const { PublicKey } = await import("@solana/web3.js");
  const bal = await conn.getBalance(new PublicKey("So11111111111111111111111111111111111111112"));
  assert.equal(bal, 123456);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/rpc/solana", "the Connection's fetch hit the proxy path, not the external host");
  assert.match(calls[0].body, /"getBalance"/);
});

// ── balances.js through the shim (the live symptom) ─────────────────────────

test("balances.js reads work through the proxied Connection (getTokenAccountsByOwner via /api/rpc/solana)", async () => {
  const calls = [];
  const conn = await createProxiedConnection("https://api.mainnet-beta.solana.com", RPC_PROXY_PATHS.solana, {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body });
      const req = JSON.parse(init.body);
      // Answer getTokenAccountsByOwner with a jsonParsed token account
      // (the exact shape web3.js superstruct-validates for the read
      // fetchSvmTokenBalances does).
      if (req.method === "getTokenAccountsByOwner") {
        return rpcResult({
          context: { slot: 100 },
          value: [
            {
              pubkey: "11111111111111111111111111111111",
              account: {
                executable: false,
                owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                lamports: 2039280,
                data: {
                  program: "spl-token",
                  parsed: {
                    info: {
                      tokenAmount: {
                        amount: "1234567",
                        decimals: 6,
                        uiAmount: 1.234567,
                        uiAmountString: "1.234567",
                      },
                    },
                  },
                  space: 165,
                },
                rentEpoch: 0,
              },
            },
          ],
        });
      }
      return rpcResult(null);
    },
  });

  const wallet = "So11111111111111111111111111111111111111112";
  const balances = await fetchSvmTokenBalances({ connection: conn, wallet, mints: SOLANA_MINTS });

  // Same base amount for both mints: 1,234,567 / 10^6 = 1.234567 USDC and
  // 1,234,567 / 10^9 = 0.001234567 WSOL (9 decimals) — the per-mint decimals
  // from SOLANA_MINTS drive the conversion.
  assert.deepEqual(balances, { USDC: 1.234567, WSOL: 0.001234567 });
  assert.ok(calls.length >= 2, "one getTokenAccountsByOwner per mint (USDC + WSOL)");
  assert.ok(
    calls.every((c) => c.url === "/api/rpc/solana"),
    "every read went through the same-origin proxy — never the external host",
  );
});
