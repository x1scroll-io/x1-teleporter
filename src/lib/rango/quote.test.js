/**
 * quote.test.js — src/lib/rango/quote.js (the Rango lane's client-side pure
 * module: canonical asset strings, the deterministic quote-request artifact,
 * and the canonical response parse).
 *
 * Pure node:test — no jsdom, no network. The REAL 2026-09-05 fixture bodies
 * are asserted here for the parse contract (the golden oracle
 * test/goldenRango.test.js does the full fixture pass); this suite covers
 * the module's unit contract: asset-string forms, whitelisted params,
 * raw-base-unit enforcement, the empty-referrer default, and the honest
 * non-OK resultTypes (a SYNTHETIC error body — the API's NO_ROUTE shape —
 * labeled as such; Rango's live quotes are all OK today).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  rangoAssetId,
  shapeQuoteRequestArtifact,
  parseRangoQuoteResponse,
  isOkResultType,
  QUOTE_FORWARD_PARAMS,
} from "./quote.js";
import {
  RANGO_DEFAULT_SLIPPAGE_PERCENT,
  RANGO_SOURCES,
  RANGO_DESTINATION_SOL,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "..", "..", "test", "fixtures", "golden", "rango-leg");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

test("rango quote: rangoAssetId canonical forms — CHAIN.SYMBOL for natives, CHAIN--address for tokens", () => {
  assert.equal(rangoAssetId({ blockchain: "SUI", symbol: "SUI", address: null }), "SUI.SUI");
  assert.equal(rangoAssetId({ blockchain: "XRPL", symbol: "XRP", address: null }), "XRPL.XRP");
  assert.equal(rangoAssetId({ blockchain: "SOLANA", symbol: "SOL", address: null }), "SOLANA.SOL");
  assert.equal(
    rangoAssetId({ blockchain: "TRON", symbol: "USDT", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }),
    "TRON--TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
  );
  assert.throws(() => rangoAssetId({ blockchain: "", symbol: "SUI", address: null }), /blockchain and symbol are required/);
  assert.throws(() => rangoAssetId({ blockchain: "SUI", symbol: "", address: null }), /blockchain and symbol are required/);
});

test("rango quote: shapeQuoteRequestArtifact — canonical order, raw base units, explicit slippage default", () => {
  const a = shapeQuoteRequestArtifact({
    from: RANGO_SOURCES.sui.asset,
    to: RANGO_DESTINATION_SOL.asset,
    amount: "100000000000",
  });
  // Canonical param order (what the live captures fired): from, to, amount, slippage.
  assert.equal(a.url, "/api/rango/quote?from=SUI.SUI&to=SOLANA.SOL&amount=100000000000&slippage=0.5");
  assert.deepEqual(Object.keys(a.params), ["from", "to", "amount", "slippage"]);
  assert.equal(a.params.slippage, String(RANGO_DEFAULT_SLIPPAGE_PERCENT), "explicit 0.5 default (the API default)");
  // Whitelist sync: the client forwards exactly what the proxy forwards.
  assert.deepEqual(QUOTE_FORWARD_PARAMS, ["from", "to", "amount", "slippage"]);

  const b = shapeQuoteRequestArtifact({
    from: "BTC.BTC",
    to: "SOLANA.SOL",
    amount: "100000000",
    slippage: 1,
  });
  assert.equal(b.params.slippage, "1");
  assert.equal(b.url, "/api/rango/quote?from=BTC.BTC&to=SOLANA.SOL&amount=100000000&slippage=1");

  assert.throws(() => shapeQuoteRequestArtifact({ from: "SUI.SUI", to: "SOLANA.SOL", amount: "100.5" }), /raw base units/);
  assert.throws(() => shapeQuoteRequestArtifact({ from: "", to: "SOLANA.SOL", amount: "1" }), /from and to are required/);
});

test("rango quote: parseRangoQuoteResponse over a REAL fixture — canonical shape, no floats on money", () => {
  const body = loadFixture("quote-sui-sol-100sui.real.json");
  const q = parseRangoQuoteResponse(body);
  assert.equal(q.ok, true);
  assert.equal(q.resultType, "OK");
  assert.equal(q.route.swapperId, "NearIntent");
  assert.equal(q.route.to.symbol, "SOL");
  assert.match(q.route.outputAmount, /^[0-9]+$/, "outputAmount stays a base-unit string");
  assert.match(q.route.outputAmountMin, /^[0-9]+$/);
  assert.equal(typeof q.route.outputAmountUsd, "number", "usd is a display number");
  const names = q.route.fees.map((f) => f.name);
  assert.ok(names.includes("Network Fee") && names.includes("Rango Fee"), "fee components carried");
  for (const f of q.route.fees) {
    assert.ok(f.blockchain && f.symbol && f.expenseType, "fee component fully shaped");
  }
});

test("rango quote: parseRangoQuoteResponse honest non-OK handling (SYNTHETIC NO_ROUTE body — Rango's error shape)", () => {
  // Synthetic: Rango's documented NO_ROUTE / error response shape. Labeled
  // synthetic — no live NO_ROUTE capture exists (all live probes were OK).
  const noRoute = {
    requestId: "00000000-0000-4000-8000-000000000000",
    resultType: "NO_ROUTE",
    route: null,
    error: "No routes found for this swap",
    errorCode: 1301,
    traceId: 123,
  };
  const q = parseRangoQuoteResponse(noRoute);
  assert.equal(q.ok, false);
  assert.equal(q.resultType, "NO_ROUTE");
  assert.equal(q.route, null);
  assert.equal(q.error, "No routes found for this swap");
  assert.equal(isOkResultType("NO_ROUTE"), false);

  const highImpact = parseRangoQuoteResponse({
    resultType: "HIGH_IMPACT",
    route: { outputAmount: "1" },
  });
  assert.equal(highImpact.ok, false, "HIGH_IMPACT is not an OK route");

  const garbage = parseRangoQuoteResponse(null);
  assert.equal(garbage.ok, false);
  assert.equal(garbage.error, "invalid_rango_quote_body");

  const empty = parseRangoQuoteResponse({ resultType: "OK", route: null, error: null });
  assert.equal(empty.ok, false, "OK with no route is not usable");
});

test("rango quote: config — the source registry is the live-verified set (no Cardano/Polkadot)", () => {
  assert.deepEqual(Object.keys(RANGO_SOURCES).sort(), ["btc", "sui", "tron", "xrpl"]);
  assert.equal(RANGO_DESTINATION_SOL.asset, "SOLANA.SOL");
  // CARDANO + POLKADOT are NOT served by Rango today (verified live
  // 2026-09-05 — the registry must not silently grow wishlist chains).
  assert.equal(RANGO_SOURCES.cardano, undefined);
  assert.equal(RANGO_SOURCES.polkadot, undefined);
});
