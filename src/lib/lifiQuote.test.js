/**
 * Fee-policy tests for the LiFi quote proxy (api/lifi/quote.js — Step 1.3D).
 *
 * Proves the money-touching core of the policy:
 *   - an x1-class quote request (x1Class=1 + a Solana-ended LiFi leg — the
 *     x1 on-ramp leg 1 EVM→Solana and the x1_onward leg 2 Solana→EVM) has the
 *     fee param OMITTED entirely (absent means absent — never fee=0): the
 *     stage-2 skim is the only Teleporter fee,
 *   - a same-chain quote request is FORCED to carry fee=0.01 — the 1%
 *     integrator IS the once-per-journey Teleporter fee on non-X1 routes,
 *   - the client's fee param is ALWAYS overwritten: the browser can neither
 *     strip the 1% on same-chain routes nor add an integrator fee on x1-class
 *     routes,
 *   - the x1Class marker is validated (an x1-class LiFi leg must touch
 *     Solana — X1 is only reachable through the Solana Warp bridge) and is
 *     stripped before the request is forwarded to LI.Fi.
 *
 * Runs under Node's built-in test runner (node --test) — same pattern as
 * cors.test.js (the api handlers are plain modules; the handler-level tests
 * mock global fetch so no live LI.Fi call is ever made).
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { resolveForcedFee } from "../../api/lifi/quote.js";
import { INTEGRATOR } from "../../api/_lifi.js";

const params = (obj) => new URLSearchParams(obj);

// ── resolveForcedFee: the pure fee decision ─────────────────────────────────

test("resolveForcedFee: x1-class request (x1 on-ramp leg 1, EVM→Solana) → null (OMIT the fee key entirely)", () => {
  assert.equal(
    resolveForcedFee(params({ fromChain: "eth", toChain: "SOL", x1Class: "1" })),
    null,
  );
});

test("resolveForcedFee: x1-class request (x1_onward leg 2, Solana→EVM) → null (OMIT the fee key entirely)", () => {
  assert.equal(
    resolveForcedFee(params({ fromChain: "SOL", toChain: "eth", x1Class: "1" })),
    null,
  );
});

test("resolveForcedFee: same-chain request (no marker) → fee 0.01", () => {
  assert.equal(
    resolveForcedFee(params({ fromChain: "eth", toChain: "SOL" })),
    "0.01",
  );
});

test("resolveForcedFee: same-chain EVM→EVM → fee 0.01", () => {
  assert.equal(
    resolveForcedFee(params({ fromChain: "eth", toChain: "bsc" })),
    "0.01",
  );
});

test("resolveForcedFee: x1Class marker WITHOUT a Solana leg is rejected → fee 0.01 (a same-chain EVM→EVM request can't claim x1-class to dodge the fee)", () => {
  assert.equal(
    resolveForcedFee(params({ fromChain: "eth", toChain: "bsc", x1Class: "1" })),
    "0.01",
  );
});

test("resolveForcedFee: x1Class=0 is treated as same-chain → fee 0.01", () => {
  assert.equal(
    resolveForcedFee(params({ fromChain: "eth", toChain: "SOL", x1Class: "0" })),
    "0.01",
  );
});

test("resolveForcedFee: the client's fee param is never consulted — the server always decides it", () => {
  // A same-chain request that tries to strip the fee (fee=0) still gets 0.01.
  assert.equal(
    resolveForcedFee(params({ fromChain: "eth", toChain: "SOL", fee: "0" })),
    "0.01",
  );
  // An x1-class request that tries to add the integrator fee is OMITTED (null).
  assert.equal(
    resolveForcedFee(params({ fromChain: "eth", toChain: "SOL", x1Class: "1", fee: "0.01" })),
    null,
  );
});

// ── handler level: the full request the browser actually sends ──────────────

function fakeReq(query) {
  return { query, headers: {} };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function runHandler(query) {
  let capturedUrl = null;
  const fetchMock = mock.fn(async (url) => {
    capturedUrl = url;
    return { status: 200, text: async () => JSON.stringify({ ok: true, estimate: { toAmount: "1000000" } }) };
  });
  mock.method(globalThis, "fetch", fetchMock);
  try {
    const { default: handler } = await import("../../api/lifi/quote.js");
    const req = fakeReq(query);
    const res = fakeRes();
    await handler(req, res);
    return { capturedUrl, res };
  } finally {
    mock.restoreAll();
  }
}

test("handler: an x1-class quote request is forwarded to LI.Fi with NO fee param at all (and integrator forced)", async () => {
  const { capturedUrl, res } = await runHandler({
    fromChain: "eth", toChain: "SOL", fromToken: "0xUSDC", toToken: "EPjF...",
    fromAmount: "1000000", fee: "0.5", // browser tried to set its own fee — stripped
    x1Class: "1",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.has("fee"), false, "x1-class quote must OMIT the fee param entirely — absent means absent");
  assert.equal(url.searchParams.get("integrator"), INTEGRATOR, "integrator is server-forced");
  assert.equal(url.searchParams.has("fee"), false, "client's fee=0.5 attempt was stripped, not zeroed");
});

test("handler: a same-chain quote request is forwarded to LI.Fi with fee=0.01", async () => {
  const { capturedUrl, res } = await runHandler({
    fromChain: "eth", toChain: "SOL", fromToken: "0xUSDC", toToken: "EPjF...",
    fromAmount: "1000000", fee: "0", // browser tried to strip the fee — ignored
  });
  assert.equal(res.statusCode, 200);
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get("fee"), "0.01", "same-chain quote must carry fee=0.01");
  assert.equal(url.searchParams.get("integrator"), INTEGRATOR);
});

test("handler: the x1Class marker is stripped before the request reaches LI.Fi", async () => {
  const { capturedUrl } = await runHandler({
    fromChain: "eth", toChain: "SOL", x1Class: "1", fromAmount: "1000000",
  });
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.has("x1Class"), false, "x1Class is our marker, not LI.Fi's — never forwarded");
});

test("handler: x1Class marker on a non-Solana leg is rejected → fee 0.01 forced", async () => {
  const { capturedUrl } = await runHandler({
    fromChain: "eth", toChain: "bsc", x1Class: "1", fromAmount: "1000000",
  });
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get("fee"), "0.01");
});
