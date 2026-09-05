/**
 * goldenRango.test.js — the Phase-5 Rango fixture oracle.
 *
 * The Rango lane is correct iff it reproduces the EXACT construction that
 * produced the REAL captured quotes — byte-for-byte. The fixtures in
 * test/fixtures/golden/rango-leg/ are REAL Rango API responses (read-only
 * quote calls, captured live 2026-09-05 against public-api.rango.exchange
 * with Rango's documented public TEST key — see the fixture README). This
 * test proves:
 *
 *   - the canonical parse (parseRangoQuoteResponse) handles every REAL
 *     fixture: ok, resultType OK, a route with a positive output, a named
 *     swapper, a requestId, fee components — nothing chokes;
 *   - the canonical REQUEST construction (shapeRangoQuoteRequestArtifact —
 *     the engine leg's step1) reproduces the EXACT query the live capture
 *     was fired with (from/to/amount/slippage — the apiKey is appended
 *     server-side by our proxy, never part of the client artifact);
 *   - the construction is deterministic (rebuild twice → same bytes).
 *
 * LIVE-STATUS BOUNDARY (honest): the QUOTE level is REAL (these bodies).
 * The SWAP-EXECUTION anchor is deliberately NOT captured — a real Rango
 * create-transaction needs real funds + a real source wallet = Mr. Esters'
 * live test. The rango-execute leg pins its request SHAPE from the
 * documented API and throws RangoLiveTestGateError on submit (proven in
 * test/engineRango.test.js). Replace nothing here to fake a live anchor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseRangoQuoteResponse } from "../src/lib/rango/quote.js";
import { shapeRangoQuoteRequestArtifact } from "../src/engine/legs/rango/rangoQuoteLeg.js";
import { RANGO_SOURCES, RANGO_DESTINATION_SOL } from "../src/lib/rango/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "golden", "rango-leg");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

/** The exact query strings the live 2026-09-05 captures were fired with
 *  (from the fixture README — from/to/amount/slippage; apiKey is appended
 *  server-side and is not part of the client artifact). */
const LIVE_CAPTURED_QUERIES = Object.freeze({
  sui: "from=SUI.SUI&to=SOLANA.SOL&amount=100000000000&slippage=1",
  xrpl: "from=XRPL.XRP&to=SOLANA.SOL&amount=100000000&slippage=1",
  btc: "from=BTC.BTC&to=SOLANA.SOL&amount=100000000&slippage=1",
});

const REAL_FIXTURES = Object.freeze([
  { file: "quote-sui-sol-100sui.real.json", source: "sui" },
  { file: "quote-xrpl-sol-100xrp.real.json", source: "xrpl" },
  { file: "quote-tron-usdt-sol-100usdt.real.json", source: null }, // address-form asset (TRON USDT)
  { file: "quote-btc-sol-1btc.real.json", source: "btc" },
]);

test("rango golden: every REAL quote fixture parses to an OK route with a positive output + named swapper", () => {
  for (const { file, source } of REAL_FIXTURES) {
    const body = loadFixture(file);
    const q = parseRangoQuoteResponse(body);
    assert.equal(q.ok, true, `${file}: ok`);
    assert.equal(q.resultType, "OK", `${file}: resultType`);
    assert.ok(q.requestId && q.requestId.length > 10, `${file}: requestId present`);
    assert.ok(q.route, `${file}: route present`);
    assert.match(String(q.route.outputAmount), /^[0-9]+$/, `${file}: outputAmount is base-unit digits`);
    assert.ok(Number(q.route.outputAmount) > 0, `${file}: positive output`);
    assert.ok(q.route.swapperId && q.route.swapperId.length > 0, `${file}: swapper named`);
    assert.ok(Array.isArray(q.route.fees) && q.route.fees.length >= 2, `${file}: fee components listed`);
    assert.equal(q.error, null, `${file}: no error`);
    // The raw body is kept verbatim (the create-tx continuation needs it).
    assert.equal(q.raw, body, `${file}: raw kept verbatim`);
    // Destination side of every fixture: SOL on Solana (the lane's landing).
    assert.equal(q.route.to.blockchain, "SOLANA", `${file}: lands on Solana`);
    assert.equal(q.route.to.symbol, "SOL", `${file}: lands as SOL`);
    // Determinism: parsing the same body twice yields the same canonical JSON.
    const again = parseRangoQuoteResponse(body);
    assert.equal(JSON.stringify(again), JSON.stringify(q), `${file}: parse is deterministic`);
  }
});

test("rango golden: the canonical request artifact reproduces the EXACT live-captured query", () => {
  for (const source of ["sui", "xrpl", "btc"]) {
    const src = RANGO_SOURCES[source];
    const artifact = shapeRangoQuoteRequestArtifact({
      source,
      amount: String(src.decimals === 9 ? 100000000000 : 100000000), // the live-captured raw amounts
      slippage: 1,
    });
    // The artifact URL is OUR proxy path + the exact query the live capture
    // fired at Rango (the apiKey is appended by the server, never the client).
    assert.equal(
      artifact.url,
      `/api/rango/quote?${LIVE_CAPTURED_QUERIES[source]}`,
      `${source}: request reproduces the live-captured query`
    );
    assert.equal(artifact.to, RANGO_DESTINATION_SOL.asset, `${source}: destination is SOLANA.SOL`);
    // Determinism: rebuild → identical bytes.
    const rebuilt = shapeRangoQuoteRequestArtifact({
      source,
      amount: String(src.decimals === 9 ? 100000000000 : 100000000),
      slippage: 1,
    });
    assert.equal(JSON.stringify(rebuilt), JSON.stringify(artifact), `${source}: rebuild deterministic`);
    assert.equal(JSON.stringify(rebuilt.params), JSON.stringify(artifact.params), `${source}: params deterministic`);
  }
});

test("rango golden: no referrer params ride along while the fee-class placeholder is empty", () => {
  // The fee ruling is Mr. Esters' (config placeholders empty → nothing
  // invented is ever sent). The artifact's params must NOT carry
  // referrerFee/referrerAddress today.
  const artifact = shapeRangoQuoteRequestArtifact({ source: "sui", amount: "100000000000" });
  assert.equal(artifact.params.referrerFee, undefined, "no referrerFee while placeholder empty");
  assert.equal(artifact.params.referrerAddress, undefined, "no referrerAddress while placeholder empty");
  assert.equal(artifact.url.includes("referrer"), false, "url carries no referrer params");
});
