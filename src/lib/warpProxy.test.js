/**
 * warpProxy.test.js — api/warp/status.js + api/warp/signatures.js (the
 * serverless proxies that make the release poll a SAME-ORIGIN fetch;
 * fix/proxy-warp-poll).
 *
 * The live reverse flow (X1 burn → Solana release) was stuck at "Still
 * awaiting the release" while server-side every burn was `status: executed`
 * with `destTxSig` present — the direct browser→Warp-API fetch was the
 * non-deterministic variable. The proxies route the poll through the app's
 * own backend (/api/warp/status + /api/warp/signatures), exactly like
 * /api/lifi/quote does for LiFi. This suite proves each handler:
 *   - forwards `sig` + `from` to the correct upstream URL and returns the
 *     upstream JSON verbatim (status AND signatures endpoints),
 *   - passes upstream HTTP errors through with the upstream status + body
 *     (fail-closed pass-through — the poller treats a 404 as
 *     awaiting_guardians, never an exception),
 *   - 400 missing_sig when no signature is supplied,
 *   - 502 warp_{status,signatures}_failed on a transport failure (network
 *     down / timeout) — so the poller can distinguish "not yet" from
 *     "broken",
 *   - applies the SAME CORS allowlist as the other api/ routes (api/_cors.js):
 *     foreign origin → 403 before any upstream call,
 *   - answers the OPTIONS preflight.
 *
 * Pure node:test (no jsdom, no network — fetchImpl is injected).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWarpStatusProxy,
} from "../../api/warp/status.js";
import {
  createWarpSignaturesProxy,
} from "../../api/warp/signatures.js";
import { buildWarpUrl, WARP_API_MAINNET } from "../../api/_warp.js";

const SIG = "4eiHySR4X4QpBzGyNMVPKzeALSnm7558WWA9RWeZ6TLe1RKH6iQf7zDSAfwxDsvrqJwQB5QSZmn6L1X1ULfx2JvH";
const DEST = "2LsDtErwXZaipeS9SE2ruN7EwFNr4hftBnnHqojSzqmWvnJRsxXvjzHG9sV2RAvbK8g2FLEuReBahBsTTaLrBEGG";

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

/** In-memory upstream response (text() so the proxy's parse path is real). */
function upstreamResponse(body, status = 200) {
  return { status, text: async () => JSON.stringify(body) };
}

function makeStatusProxy({ fetchImpl } = {}) {
  const calls = [];
  const proxy = createWarpStatusProxy({
    fetchImpl:
      fetchImpl ??
      (async (url, init) => {
        calls.push({ url, init });
        return upstreamResponse({ transaction: { status: "executed", destTxSig: DEST } });
      }),
  });
  return { handler: proxy.handler, calls };
}

function makeSignaturesProxy({ fetchImpl } = {}) {
  const calls = [];
  const proxy = createWarpSignaturesProxy({
    fetchImpl:
      fetchImpl ??
      (async (url, init) => {
        calls.push({ url, init });
        return upstreamResponse({ signatures: [{ guardian: "g1" }] });
      }),
  });
  return { handler: proxy.handler, calls };
}

// ── URL building (pure) ─────────────────────────────────────────────────────

test("buildWarpUrl: status endpoint = {base}/transactions/{sig}?from={from}", () => {
  assert.equal(
    buildWarpUrl({ sig: SIG, from: "x1" }),
    `${WARP_API_MAINNET}/transactions/${SIG}?from=x1`,
  );
});

test("buildWarpUrl: signatures endpoint appends /signatures", () => {
  assert.equal(
    buildWarpUrl({ sig: SIG, from: "x1", kind: "signatures" }),
    `${WARP_API_MAINNET}/transactions/${SIG}/signatures?from=x1`,
  );
});

test("buildWarpUrl: omits from when absent, encodes the sig, honors baseUrl", () => {
  assert.equal(buildWarpUrl({ sig: "a b/c", from: undefined }), `${WARP_API_MAINNET}/transactions/a%20b%2Fc`);
  assert.equal(
    buildWarpUrl({ sig: SIG, from: "sol", baseUrl: "https://example.test/" }),
    "https://example.test/transactions/" + SIG + "?from=sol",
  );
});

// ── api/warp/status ─────────────────────────────────────────────────────────

test("api/warp/status: forwards sig+from and returns the upstream JSON verbatim", async () => {
  const { handler, calls } = makeStatusProxy();
  const res = fakeRes();
  await handler(fakeReq({ query: { sig: SIG, from: "x1" } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { transaction: { status: "executed", destTxSig: DEST } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WARP_API_MAINNET}/transactions/${SIG}?from=x1`);
});

test("api/warp/status: passes an upstream 404 through with the upstream body (fail-closed pass-through)", async () => {
  const { handler } = makeStatusProxy({
    fetchImpl: async () => upstreamResponse({ error: "not found" }, 404),
  });
  const res = fakeRes();
  await handler(fakeReq({ query: { sig: SIG, from: "x1" } }), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "not found" });
});

test("api/warp/status: 400 missing_sig without a sig (fail-closed, no upstream call)", async () => {
  const { handler, calls } = makeStatusProxy();
  const res = fakeRes();
  await handler(fakeReq({ query: { from: "x1" } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "missing_sig");
  assert.equal(calls.length, 0, "no upstream call when sig is missing");
});

test("api/warp/status: transport failure → 502 warp_status_failed", async () => {
  const { handler } = makeStatusProxy({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  const res = fakeRes();
  await handler(fakeReq({ query: { sig: SIG, from: "x1" } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "warp_status_failed");
});

test("api/warp/status: foreign origin → 403 before any upstream call (same CORS allowlist)", async () => {
  const { handler, calls } = makeStatusProxy();
  const res = fakeRes();
  await handler(fakeReq({ origin: "https://evil.example", query: { sig: SIG, from: "x1" } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "origin_not_allowed");
  assert.equal(calls.length, 0, "no upstream call from a disallowed origin");
});

test("api/warp/status: answers the OPTIONS preflight", async () => {
  const { handler } = makeStatusProxy();
  const res = fakeRes();
  await handler(fakeReq({ method: "OPTIONS", query: {} }), res);
  assert.equal(res.statusCode, 200);
});

// ── api/warp/signatures ─────────────────────────────────────────────────────

test("api/warp/signatures: forwards sig+from and returns the upstream JSON verbatim", async () => {
  const { handler, calls } = makeSignaturesProxy();
  const res = fakeRes();
  await handler(fakeReq({ query: { sig: SIG, from: "x1" } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { signatures: [{ guardian: "g1" }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WARP_API_MAINNET}/transactions/${SIG}/signatures?from=x1`);
});

test("api/warp/signatures: passes an upstream 404 through with the upstream body (fail-closed pass-through)", async () => {
  const { handler } = makeSignaturesProxy({
    fetchImpl: async () => upstreamResponse({ error: "not found" }, 404),
  });
  const res = fakeRes();
  await handler(fakeReq({ query: { sig: SIG, from: "x1" } }), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "not found" });
});

test("api/warp/signatures: 400 missing_sig without a sig (fail-closed, no upstream call)", async () => {
  const { handler, calls } = makeSignaturesProxy();
  const res = fakeRes();
  await handler(fakeReq({ query: {} }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "missing_sig");
  assert.equal(calls.length, 0, "no upstream call when sig is missing");
});

test("api/warp/signatures: transport failure → 502 warp_signatures_failed", async () => {
  const { handler } = makeSignaturesProxy({
    fetchImpl: async () => { throw new Error("timeout"); },
  });
  const res = fakeRes();
  await handler(fakeReq({ query: { sig: SIG, from: "x1" } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "warp_signatures_failed");
});

test("api/warp/signatures: foreign origin → 403 before any upstream call (same CORS allowlist)", async () => {
  const { handler, calls } = makeSignaturesProxy();
  const res = fakeRes();
  await handler(fakeReq({ origin: "https://evil.example", query: { sig: SIG, from: "x1" } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "origin_not_allowed");
  assert.equal(calls.length, 0, "no upstream call from a disallowed origin");
});

test("api/warp/signatures: answers the OPTIONS preflight", async () => {
  const { handler } = makeSignaturesProxy();
  const res = fakeRes();
  await handler(fakeReq({ method: "OPTIONS", query: {} }), res);
  assert.equal(res.statusCode, 200);
});
