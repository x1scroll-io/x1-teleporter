/**
 * prices.test.js — LIVE price util: DI-able fetch, 60s cache, fail-soft,
 * USD math. No network, no DOM — pure node:test with injected fetchers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COINGECKO_IDS,
  PRICE_CACHE_MS,
  getPricesUSD,
  defaultPriceFetch,
  resetPriceCache,
  usdValue,
} from "./prices.js";

/** A DI'd fetchPrice that records calls and returns a canned batch. */
function makeFetchPrice(responder) {
  const calls = [];
  const fn = async (ids) => {
    calls.push([...ids]);
    return typeof responder === "function" ? responder(ids) : responder;
  };
  fn.calls = calls;
  return fn;
}

// ── defaultPriceFetch — the Coingecko shape ────────────────────────────────

test("defaultPriceFetch parses the Coingecko simple-price shape", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      "usd-coin": { usd: 1.001 },
      "wrapped-solana": { usd: 150.5 },
      tether: { usd: 1.0 },
      dai: { usd: 0.999 },
    }),
  });
  try {
    const out = await defaultPriceFetch(["usd-coin", "wrapped-solana", "tether", "dai"]);
    assert.equal(out["usd-coin"], 1.001);
    assert.equal(out["wrapped-solana"], 150.5);
    assert.equal(out.tether, 1.0);
    assert.equal(out.dai, 0.999);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("defaultPriceFetch: non-ok response → null (fail-soft)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  try {
    assert.equal(await defaultPriceFetch(["usd-coin"]), null);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("defaultPriceFetch: network throw → null (fail-soft)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  try {
    assert.equal(await defaultPriceFetch(["usd-coin"]), null);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("defaultPriceFetch: zero/missing price → null for that id, others survive", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ "usd-coin": { usd: 0 }, "wrapped-solana": { usd: 150.5 } }),
  });
  try {
    const out = await defaultPriceFetch(["usd-coin", "wrapped-solana"]);
    assert.equal(out["usd-coin"], null, "zero price is not a price");
    assert.equal(out["wrapped-solana"], 150.5);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── getPricesUSD — symbol mapping + cache ──────────────────────────────────

test("getPricesUSD maps Coingecko ids onto every balance-line symbol", async () => {
  const fp = makeFetchPrice({
    "usd-coin": 1.0,
    tether: 1.0,
    dai: 1.0,
    "wrapped-solana": 150.5,
  });
  resetPriceCache();
  const prices = await getPricesUSD({ fetchPrice: fp, now: 1000, force: true });
  assert.deepEqual(prices, {
    USDC: 1.0,
    USDT: 1.0,
    DAI: 1.0,
    WSOL: 150.5,
    "USDC.x": 1.0, // Warp twin of Solana USDC — same id, same price
    "wSOL.X": 150.5, // Warp twin of Solana WSOL — same id, same price
  });
  // one batch call with the deduped id set
  assert.deepEqual(fp.calls[0], ["usd-coin", "tether", "dai", "wrapped-solana"]);
});

test("getPricesUSD caches within the TTL — one fetch across many calls", async () => {
  const fp = makeFetchPrice({ "usd-coin": 1.0, tether: 1.0, dai: 1.0, "wrapped-solana": 150.5 });
  resetPriceCache();
  const a = await getPricesUSD({ fetchPrice: fp, now: 0, force: true });
  const b = await getPricesUSD({ fetchPrice: fp, now: 30_000 }); // inside TTL
  const c = await getPricesUSD({ fetchPrice: fp, now: 59_999 }); // still inside
  assert.equal(a.USDC, 1.0);
  assert.equal(b.USDC, 1.0);
  assert.equal(c.USDC, 1.0);
  assert.equal(fp.calls.length, 1, "cached — exactly one network fetch");
});

test("getPricesUSD refetches after the TTL expires", async () => {
  let price = 1.0;
  const fp = makeFetchPrice(() => ({ "usd-coin": price, tether: 1.0, dai: 1.0, "wrapped-solana": 150.5 }));
  resetPriceCache();
  await getPricesUSD({ fetchPrice: fp, now: 0, force: true });
  assert.equal(fp.calls.length, 1);
  price = 1.05; // market moved
  const fresh = await getPricesUSD({ fetchPrice: fp, now: PRICE_CACHE_MS + 1 });
  assert.equal(fresh.USDC, 1.05, "refetched after TTL");
  assert.equal(fp.calls.length, 2);
});

test("getPricesUSD: fetch failure → null (fail-soft), no cached poison", async () => {
  const fp = makeFetchPrice(() => { throw new Error("boom"); });
  resetPriceCache();
  assert.equal(await getPricesUSD({ fetchPrice: fp, now: 0, force: true }), null);
  // a later successful fetch still works
  const fp2 = makeFetchPrice({ "usd-coin": 1.0, tether: 1.0, dai: 1.0, "wrapped-solana": 150.5 });
  const ok = await getPricesUSD({ fetchPrice: fp2, now: 1, force: true });
  assert.equal(ok.USDC, 1.0);
});

test("getPricesUSD: partial batch — missing id → null symbol, others live", async () => {
  const fp = makeFetchPrice({ "usd-coin": 1.0, "wrapped-solana": 150.5 }); // no tether/dai
  resetPriceCache();
  const prices = await getPricesUSD({ fetchPrice: fp, now: 0, force: true });
  assert.equal(prices.USDC, 1.0);
  assert.equal(prices.USDT, null, "missing id → null, never a throw");
  assert.equal(prices.WSOL, 150.5);
});

// ── usdValue — balance × price math ────────────────────────────────────────

test("usdValue: balance × price with decimals already applied", () => {
  assert.equal(usdValue(27.59, 1.0), 27.59);
  assert.ok(Math.abs(usdValue(0.3, 102.0) - 30.6) < 1e-9, "0.3 × $102 = $30.60 (float-safe)");
  assert.equal(usdValue(5.2, 0.999), 5.1948);
});

test("usdValue: null-in → null-out (no USD when balance or price missing)", () => {
  assert.equal(usdValue(null, 1.0), null);
  assert.equal(usdValue(5.2, null), null);
  assert.equal(usdValue(null, null), null);
});

test("COINGECKO_IDS covers the exact symbols the balance line renders", () => {
  assert.deepEqual(Object.keys(COINGECKO_IDS).sort(), ["DAI", "USDC", "USDC.x", "USDT", "WSOL", "wSOL.X"]);
});
