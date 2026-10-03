/**
 * Tests for the Step 1.3B CORS allowlist (api/_cors.js). Runs under Node's
 * built-in test runner (node --test) — same pattern as the other suites.
 *
 * The api functions are Vercel Node serverless functions, so the CORS logic
 * lives in a shared module (api/_cors.js) that the handlers import and this
 * suite imports directly.
 *
 * Covers the runbook requirement ("a foreign origin is rejected") plus the
 * full allowlist contract:
 *   (a) production origin allowed,
 *   (b) custom preview origin allowed,
 *   (c) any https *.vercel.app preview deployment allowed,
 *   (d) foreign origin (https://evil.example) REJECTED — handler-level: 403
 *       JSON sent, no CORS headers, cors() returns false,
 *   (e) lookalike/suffix-attack + plaintext + malformed origins rejected,
 *   (f) no Origin header passes through (same-origin / non-browser callers).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_ORIGINS, isAllowedOrigin, cors } from "../../api/_cors.js";

function fakeReq(origin) {
  return { headers: origin === undefined ? {} : { origin } };
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
  };
}

// ── allowlist contents ──────────────────────────────────────────────────────

test("allowlist is exactly production + custom preview origins", () => {
  assert.deepEqual(ALLOWED_ORIGINS, [
    "https://x1teleporter.com",
    "https://next.x1teleporter.com",
  ]);
});

// ── isAllowedOrigin: allowed ────────────────────────────────────────────────

test("production origin is allowed", () => {
  assert.equal(isAllowedOrigin("https://x1teleporter.com"), true);
});

test("custom preview origin is allowed", () => {
  assert.equal(isAllowedOrigin("https://next.x1teleporter.com"), true);
});

test("any https *.vercel.app preview deployment is allowed", () => {
  assert.equal(isAllowedOrigin("https://x1teleporter-git-cors-fix-abc123.vercel.app"), true);
  assert.equal(isAllowedOrigin("https://x1teleporter-7q9w8e.vercel.app"), true);
});

test("no Origin header is allowed through (same-origin / non-browser)", () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(""), true);
});

// ── isAllowedOrigin: rejected ───────────────────────────────────────────────

test("foreign origin is rejected", () => {
  assert.equal(isAllowedOrigin("https://evil.example"), false);
});

test("plaintext http variants are rejected", () => {
  assert.equal(isAllowedOrigin("http://x1teleporter.com"), false);
  assert.equal(isAllowedOrigin("http://next.x1teleporter.com"), false);
  assert.equal(isAllowedOrigin("http://evil.example"), false);
});

test("lookalike / suffix-attack origins are rejected", () => {
  assert.equal(isAllowedOrigin("https://x1teleporter.com.evil.com"), false);
  assert.equal(isAllowedOrigin("https://evil-x1teleporter.com"), false);
  assert.equal(isAllowedOrigin("https://x1teleporter.com@evil.com"), false);
});

test("bare vercel.app and non-https vercel.app subdomains are rejected", () => {
  assert.equal(isAllowedOrigin("https://vercel.app"), false);
  assert.equal(isAllowedOrigin("http://x1teleporter.vercel.app"), false);
});

test("malformed Origin values are rejected", () => {
  assert.equal(isAllowedOrigin("not-a-url"), false);
  assert.equal(isAllowedOrigin("https://"), false);
  assert.equal(isAllowedOrigin("https:///path"), false);
});

test("localhost is rejected (client is same-origin in prod; API_BASE is empty)", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173"), false);
  assert.equal(isAllowedOrigin("https://localhost:5173"), false);
});

// ── handler-level behavior: cors(req, res) ──────────────────────────────────

test("cors(): foreign origin -> 403 JSON sent, no CORS headers, returns false", () => {
  const req = fakeReq("https://evil.example");
  const res = fakeRes();
  const proceed = cors(req, res);
  assert.equal(proceed, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "origin_not_allowed" });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("cors(): allowed origin -> CORS headers set, returns true, no 403", () => {
  const req = fakeReq("https://x1teleporter.com");
  const res = fakeRes();
  const proceed = cors(req, res);
  assert.equal(proceed, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "https://x1teleporter.com");
  assert.match(res.headers["access-control-allow-methods"], /GET/);
  assert.match(res.headers["access-control-allow-methods"], /POST/);
  assert.match(res.headers["access-control-allow-methods"], /OPTIONS/);
  assert.equal(res.headers["access-control-allow-headers"], "Content-Type");
  assert.equal(res.headers["vary"], "Origin");
});

test("cors(): vercel.app preview origin -> allowed with echoed origin", () => {
  const req = fakeReq("https://x1teleporter-git-cors-fix-abc123.vercel.app");
  const res = fakeRes();
  assert.equal(cors(req, res), true);
  assert.equal(
    res.headers["access-control-allow-origin"],
    "https://x1teleporter-git-cors-fix-abc123.vercel.app"
  );
});

test("cors(): no Origin -> allowed through, no CORS headers set", () => {
  const req = fakeReq(undefined);
  const res = fakeRes();
  const proceed = cors(req, res);
  assert.equal(proceed, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});
