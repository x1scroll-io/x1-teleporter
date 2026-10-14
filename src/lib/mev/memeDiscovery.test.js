/**
 * memeDiscovery.test.js — the SELF-DISCOVERING meme feed tests (APE
 * UNIVERSE build #1). Pure parse/filter/dedupe/threshold coverage over the
 * REAL API responses captured live (test/fixtures/meme-discovery/ — the
 * BONK 21-venue search response, the BONK + WIF /tokens venue maps, the
 * GeckoTerminal solana trending response, and the pump-drowned WIF search
 * noise), plus the discoverMemes orchestration with DI fetch.
 *
 * Spec coverage:
 *   • parseDexScreener: real BONK search response → 21 normalized solana
 *     pair rows; the REAL BONK mint (DezXAZ…pB263 — the mint the scratch
 *     hardcoding got WRONG); cross-chain rows dropped,
 *   • parseGeckoTerminal: real solana trending response → 20 pool rows;
 *     "solana_<mint>" ids stripped; symbols resolved via included tokens;
 *     dex relationship parsed; reserve_in_usd → liquidityUsd,
 *   • buildVenueMap: the WIF 30-pair venue map → per-AMM aggregates
 *     (raydium ≈ $6.05M / orca ≈ $190.6k / meteora ≈ $34.7k — the venue
 *     granularity the gap sweep excludes by whole AMM); pump venues
 *     STRIPPED from the noise fixture (pumpfun/pumpswap never count),
 *   • filterCandidates (the capture precondition): single-venue tokens
 *     filtered at minVenues 2, below-floor venues not counted, volume
 *     floor, floor boundary inclusive, WIF passes with exactly its 2 deep
 *     venues (raydium + orca) — the real-capture pair,
 *   • dedupeByMint: same mint from two sources merges venue maps without
 *     double-counting a dex; first-map priority,
 *   • discoverMemes orchestration (DI fetch): GeckoTerminal seed + DEX
 *     Screener venue expansion + search seed → BONK candidate with the
 *     exact output shape the sweep + APE UNIVERSE tab consume.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DISCOVERY_CHAINS,
  discoverMemes,
  parseDexScreener,
  parseGeckoTerminal,
  buildVenueMap,
  venuesToArray,
  poolVersionFromDexId,
  dedupeByMint,
  filterCandidates,
  isPumpVenue,
  normalizeMint,
  addressFromGeckoTokenId,
  DEFAULT_MEME_SEED_SYMBOLS,
} from "./memeDiscovery.js";

const fx = (name) =>
  JSON.parse(readFileSync(new URL(`../../../test/fixtures/meme-discovery/${name}`, import.meta.url), "utf8"));

const SOL = { chain: "sol", dsChainId: "solana", gtNetwork: "solana" };
const REAL_BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const REAL_WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

// ── parseDexScreener ────────────────────────────────────────────────────────

test("parseDexScreener: real BONK search response → 21 solana rows; the REAL mint dominates the lookalikes", () => {
  const rows = parseDexScreener(fx("dex-screener-search-bonk.json"), SOL);
  assert.equal(rows.length, 21); // the 21-row search response captured live
  const mints = new Set(rows.map((r) => r.address));
  assert.equal(mints.size, 4, "the search surface mixes the real Bonk with 3 lookalikes — venue floors sort them");
  assert.ok(mints.has(REAL_BONK), "the REAL BONK mint — not the stale hardcoded guess");
  const real = rows.filter((r) => r.address === REAL_BONK);
  assert.equal(real.length, 18, "the real Bonk dominates the response");
  const r = real[0];
  assert.equal(r.chain, "sol");
  assert.equal(r.symbol, "Bonk");
  assert.ok(r.liquidityUsd > 0 && r.volumeUsd > 0 && r.priceUsd > 0, "numeric fields parsed");
  assert.ok(rows.every((x) => Number.isFinite(x.liquidityUsd)), "no NaN liquidity");
});

test("parseDexScreener: cross-chain rows are dropped (venue maps must not mix chains)", () => {
  const raw = fx("dex-screener-search-bonk.json");
  raw.pairs.push({
    chainId: "ethereum", dexId: "uniswap-v3", baseToken: { address: "0x" + "ab".repeat(20), symbol: "BONK" },
    liquidity: { usd: "999999999" }, volume: { h24: "1" }, priceUsd: "0.01",
  });
  const rows = parseDexScreener(raw, SOL);
  assert.equal(rows.length, 21, "the ethereum lookalike row never enters a solana venue map");
});

test("parseDexScreener: junk-tolerant (missing pairs / null liquidity never throw)", () => {
  assert.deepEqual(parseDexScreener({}, SOL), []);
  assert.deepEqual(parseDexScreener({ pairs: null }, SOL), []);
  const rows = parseDexScreener({ pairs: [{ chainId: "solana", baseToken: null }] }, SOL);
  assert.deepEqual(rows, []);
  const junk = parseDexScreener({ pairs: [{ chainId: "solana", baseToken: { address: REAL_BONK }, liquidity: { usd: "oops" }, volume: { h24: undefined } }] }, SOL);
  assert.equal(junk[0].liquidityUsd, 0);
  assert.equal(junk[0].volumeUsd, 0);
});

// ── parseGeckoTerminal ──────────────────────────────────────────────────────

test("parseGeckoTerminal: real solana trending response → 20 pool rows, ids stripped, symbols resolved", () => {
  const rows = parseGeckoTerminal(fx("gecko-trending-solana.json"), SOL);
  assert.equal(rows.length, 20); // the live trending page
  const stonk = rows.find((r) => r.symbol === "STONK");
  assert.ok(stonk, "STONK (the live trending leader at capture time) is present");
  assert.ok(!stonk.address.startsWith("solana_"), "network prefix stripped from the mint");
  assert.equal(stonk.dexId, "orca");
  assert.ok(stonk.liquidityUsd > 1_000_000, "reserve_in_usd → liquidityUsd");
  assert.ok(stonk.volumeUsd > 1_000_000, "volume_usd.h24 → volumeUsd");
  assert.ok(rows.every((r) => r.address && r.dexId), "every pool has an address + dex");
});

test("parseGeckoTerminal: token symbols fall back to null when included is absent", () => {
  const raw = fx("gecko-trending-solana.json");
  delete raw.included;
  const rows = parseGeckoTerminal(raw, SOL);
  assert.equal(rows.length, 20);
  assert.ok(rows.every((r) => r.symbol === null), "no crash, null symbol, address still derived");
});

test("addressFromGeckoTokenId: solana_/base_/eth_ prefixes strip to the raw address", () => {
  assert.equal(addressFromGeckoTokenId(`solana_${REAL_BONK}`), REAL_BONK);
  const evm = "0x" + "cd".repeat(20);
  assert.equal(addressFromGeckoTokenId(`base_${evm}`), evm);
  assert.equal(addressFromGeckoTokenId("no-underscore-id"), "no-underscore-id");
  assert.equal(addressFromGeckoTokenId(null), null);
});

// ── venue identity helpers ──────────────────────────────────────────────────

test("normalizeMint: evm lowercases (checksum-insensitive), svm base58 untouched", () => {
  const evm = "0x" + "AB".repeat(20);
  assert.equal(normalizeMint(evm, "evm"), `0x${"ab".repeat(20)}`);
  assert.equal(normalizeMint(REAL_BONK, "svm"), REAL_BONK, "base58 case is meaningful — never lowercased");
  assert.equal(normalizeMint("  "), null);
  assert.equal(normalizeMint(null), null);
});

test("isPumpVenue: pumpfun/pumpswap/pump.fun flagged, real AMMs clean", () => {
  assert.ok(isPumpVenue("pumpfun"));
  assert.ok(isPumpVenue("pumpswap"));
  assert.ok(isPumpVenue("pump.fun"));
  assert.ok(!isPumpVenue("raydium"));
  assert.ok(!isPumpVenue("orca"));
  assert.ok(!isPumpVenue("meteora"));
  assert.ok(!isPumpVenue(null));
  assert.ok(!isPumpVenue("whirlpool"));
});

// ── buildVenueMap (venue = one AMM's aggregate depth) ───────────────────────

test("buildVenueMap: WIF 30-pair map → per-AMM aggregates (the venue-gap capture unit)", () => {
  const rows = parseDexScreener(fx("dex-screener-tokens-wif.json"), SOL);
  assert.equal(rows.length, 30); // orca 10 + raydium 6 + meteora 14
  const map = buildVenueMap(rows);
  assert.equal(map.size, 1, "every pair is the SAME real WIF mint");
  const wif = map.get(REAL_WIF);
  assert.ok(wif, "the real dogwifhat mint is the key — symbol ($WIF) is display-only");
  assert.equal(wif.pairCount, 30);
  assert.equal(wif.venueCount, 3, "three AMMs: raydium, orca, meteora");
  const venues = venuesToArray(wif.venues);
  const byDex = Object.fromEntries(venues.map((v) => [v.dex, v]));
  assert.equal(Math.round(byDex.raydium.liquidityUsd), 6_049_074, "raydium aggregate (main $6.04M pool + dust)");
  assert.equal(byDex.raydium.pairCount, 6);
  assert.equal(Math.round(byDex.orca.liquidityUsd), 190_987);
  assert.equal(byDex.orca.pairCount, 10);
  assert.equal(Math.round(byDex.meteora.liquidityUsd), 34_700);
  assert.equal(byDex.meteora.pairCount, 14);
  assert.equal(Math.round(wif.liquidityUsd), 6_274_762, "token total = Σ venues");
  assert.ok(venues[0].dex === "raydium", "venues sorted by liquidity desc");
});

test("buildVenueMap: pump venues STRIPPED — the pump-drowned WIF search noise yields no pump rows", () => {
  const rows = parseDexScreener(fx("dex-screener-search-wif-noise.json"), SOL);
  const pumpRows = rows.filter((r) => isPumpVenue(r.dexId));
  assert.equal(pumpRows.length, 6, "fixture has 6 pump.fun/pumpswap lookalikes (pumpfun×3 + pumpswap×3)");
  const map = buildVenueMap(rows);
  for (const tok of map.values()) {
    for (const v of tok.venues.values()) {
      assert.ok(!isPumpVenue(v.dex), "no pump venue survives into a venue map");
    }
  }
  // only the 2 real-raydium fakes survive as observations; none has a
  // second venue → nothing here can pass the capture precondition
  assert.equal(map.size, 2);
  for (const tok of map.values()) {
    assert.equal(tok.venueCount, 1);
  }
});

// ── filterCandidates (the capture precondition) ─────────────────────────────

function tokenWithVenues(address, venueLiqs, volume = 1_000_000, symbol = "TEST") {
  const venues = new Map();
  venueLiqs.forEach((liq, i) => {
    venues.set(`dex${i}`, { dex: `dex${i}`, liquidityUsd: liq, volumeUsd: volume, pairCount: 1 });
  });
  return { address, symbol, chain: "sol", priceUsd: 1, liquidityUsd: venueLiqs.reduce((a, b) => a + b, 0), volumeUsd: volume, venueCount: venueLiqs.length, pairCount: venueLiqs.length, venues };
}

test("filterCandidates: single-venue tokens are filtered (the proven non-capturable case)", () => {
  const map = new Map([
    ["mintA", tokenWithVenues("mintA", [5_000_000])], // 1 venue, deep — still NOT capturable
    ["mintB", tokenWithVenues("mintB", [200_000, 40_000])], // 2 venues, one below the $50k floor
  ]);
  const out = filterCandidates(map);
  assert.deepEqual(out, [], "single-venue and below-floor tokens never pass minVenues 2");
  // same map, minVenues 1 → the deep single-venue token becomes visible (and
  // mintB's $200k venue now counts too)
  const relaxed = filterCandidates(map, { minVenues: 1 });
  assert.equal(relaxed.length, 2);
  assert.equal(relaxed[0].mint, "mintA", "sorted by liquidity desc — the $5M venue first");
});

test("filterCandidates: venue floor boundary is inclusive (exactly $50k counts)", () => {
  const map = new Map([["edge", tokenWithVenues("edge", [50_000, 50_000])]]);
  const out = filterCandidates(map, { minLiquidityUsd: 50_000 });
  assert.equal(out.length, 1);
  assert.equal(out[0].venueCount, 2);
  const outStrict = filterCandidates(map, { minLiquidityUsd: 50_001 });
  assert.deepEqual(outStrict, [], "one dollar above the floor → neither venue counts");
});

test("filterCandidates: volume floor filters token-wide (Σ venues) below it", () => {
  const map = new Map([["quiet", tokenWithVenues("quiet", [100_000, 100_000], 5_000)]]);
  assert.deepEqual(filterCandidates(map, { minVolume24Usd: 10_000 }), [], "2 liquid venues but $5k volume → filtered");
  const pass = filterCandidates(map, { minVolume24Usd: 5_000 });
  assert.equal(pass.length, 1, "at its own volume level it passes");
});

test("filterCandidates: real WIF venue map passes with exactly its 2 deep venues", () => {
  const rows = parseDexScreener(fx("dex-screener-tokens-wif.json"), SOL);
  const map = buildVenueMap(rows);
  const out = filterCandidates(map, { minLiquidityUsd: 50_000, minVolume24Usd: 10_000, minVenues: 2 });
  assert.equal(out.length, 1);
  const wif = out[0];
  assert.equal(wif.mint, REAL_WIF);
  assert.equal(wif.symbol, "$WIF");
  assert.equal(wif.venueCount, 2, "raydium + orca are the two ≥$50k AMMs (meteora ~$34.7k excluded) — the real-capture pair");
  assert.deepEqual(wif.venues.map((v) => v.dex), ["raydium", "orca", "meteora"], "all non-pump venues are reported; eligibility is the count");
});

test("filterCandidates: real BONK venue map passes (the 21-venue capture surface)", () => {
  const rows = parseDexScreener(fx("dex-screener-tokens-bonk.json"), SOL);
  const map = buildVenueMap(rows);
  const out = filterCandidates(map, { minLiquidityUsd: 50_000, minVolume24Usd: 10_000, minVenues: 2 });
  assert.equal(out.length, 1);
  const bonk = out[0];
  assert.equal(bonk.mint, REAL_BONK);
  assert.ok(bonk.venueCount >= 2, `BONK has ≥2 deep AMM venues (got ${bonk.venueCount})`);
  assert.ok(bonk.liquidityUsd > 100_000 && bonk.volume24Usd > 100_000);
  // stricter discovery floor → fewer/no candidates (the sweep can tighten)
  const strict = filterCandidates(map, { minLiquidityUsd: 10_000_000 });
  assert.deepEqual(strict, [], "a $10M per-venue discovery floor admits nothing — thresholds are the safety knob");
});

test("filterCandidates: output shape is exactly the consumer contract", () => {
  const map = new Map([["shape", tokenWithVenues("shape", [100_000, 90_000, 5_000], 250_000, "SHAPE")]]);
  const [c] = filterCandidates(map);
  assert.deepEqual(Object.keys(c).sort(), ["chain", "liquidityUsd", "mint", "priceUsd", "symbol", "venueCount", "venues", "volume24Usd"].sort());
  assert.deepEqual(Object.keys(c.venues[0]).sort(), ["dex", "liquidityUsd", "pairCount", "volumeUsd"].sort());
  assert.equal(c.venueCount, 2, "the $5k venue does not count toward eligibility");
  assert.equal(c.venues.length, 3, "but is still reported for display");
});

// ── dedupeByMint ────────────────────────────────────────────────────────────

test("dedupeByMint: same mint from two sources merges without double-counting a dex", () => {
  const gtTok = tokenWithVenues(REAL_WIF, [6_000_000, 150_000], 900_000, "$WIF");
  gtTok.venues = new Map([
    ["raydium", { dex: "raydium", liquidityUsd: 6_000_000, volumeUsd: 800_000, pairCount: 1 }],
    ["orca", { dex: "orca", liquidityUsd: 150_000, volumeUsd: 100_000, pairCount: 1 }],
  ]);
  gtTok.liquidityUsd = 6_150_000;
  const dsMap = new Map([[
    REAL_WIF,
    { address: REAL_WIF, symbol: "$WIF", chain: "sol", priceUsd: 1, liquidityUsd: 6_049_074, volumeUsd: 800_000, venueCount: 3, pairCount: 30, venues: new Map([["raydium", { dex: "raydium", liquidityUsd: 6_049_074, volumeUsd: 700_000, pairCount: 6 }], ["orca", { dex: "orca", liquidityUsd: 190_643, volumeUsd: 90_000, pairCount: 10 }], ["meteora", { dex: "meteora", liquidityUsd: 34_700, volumeUsd: 10_000, pairCount: 14 }]]) },
  ]]);
  const merged = dedupeByMint([dsMap, gtTok ? new Map([[REAL_WIF, gtTok]]) : new Map()]);
  const wif = merged.get(REAL_WIF);
  assert.equal(wif.venueCount, 3, "same 3 dexes — no duplication");
  assert.equal(wif.venues.get("raydium").liquidityUsd, 6_049_074, "first map (DS truth) wins the dex");
  assert.equal(wif.liquidityUsd, 6_049_074 + 190_643 + 34_700, "totals = one pass per dex");
  assert.equal(wif.pairCount, 30 + 2, "pairCount sums observations (evidence rows)");
});

test("dedupeByMint: GeckoTerminal-only tokens keep their pools as venues (fallback path)", () => {
  const gtOnly = new Map([["gtMint", tokenWithVenues("gtMint", [300_000, 80_000], 60_000, "GTONLY")]]);
  const merged = dedupeByMint([new Map(), gtOnly]);
  assert.equal(merged.size, 1);
  assert.equal(merged.get("gtMint").venueCount, 2, "no DS data → GT pools are the venue map");
});

// ── discoverMemes orchestration (DI fetch) ──────────────────────────────────

function mockFetch(routes) {
  return async (url) => {
    const hit = routes.find((r) => String(url).includes(r.match));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit.body };
  };
}

test("discoverMemes: live pipeline shape — GT trending seed + DS venue expansion + search seed → BONK", async () => {
  const fetchImpl = mockFetch([
    { match: "/trending_pools", body: fx("gecko-trending-solana.json") },
    { match: "/latest/dex/search", body: fx("dex-screener-search-bonk.json") },
    { match: "/latest/dex/tokens/", body: fx("dex-screener-tokens-bonk.json") },
  ]);
  const out = await discoverMemes({
    chain: "sol",
    seedSymbols: ["BONK"],
    minLiquidityUsd: 50_000,
    minVolume24Usd: 10_000,
    minVenues: 2,
    fetchImpl,
  });
  assert.ok(out.length >= 1, "BONK must surface from the live-shaped pipeline");
  const bonk = out.find((c) => c.mint === REAL_BONK);
  assert.ok(bonk, "the candidate keyed by the REAL BONK mint");
  assert.equal(bonk.chain, "sol");
  assert.ok(bonk.venueCount >= 2);
  assert.ok(bonk.sources.includes("dexscreener-search"), "BONK was surfaced by the symbol-search seed");
  assert.ok(bonk.sources.includes("dexscreener-tokens"), "and venue-expanded through /tokens");
  assert.ok(!bonk.sources.includes("geckoterminal-trending"), "honest provenance: BONK was NOT trending when the fixture was captured");
  assert.ok(!Number.isNaN(Date.parse(bonk.discoveredAt)), "discoveredAt is an ISO timestamp");
  // sorted by liquidity desc
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i - 1].liquidityUsd >= out[i].liquidityUsd);
  }
});

test("discoverMemes: stricter thresholds + maxCandidates are respected (sweep knob)", async () => {
  const fetchImpl = mockFetch([
    { match: "/trending_pools", body: fx("gecko-trending-solana.json") },
    { match: "/latest/dex/tokens/", body: fx("dex-screener-tokens-wif.json") },
  ]);
  const narrow = await discoverMemes({ chain: "sol", minLiquidityUsd: 10_000_000, minVenues: 2, fetchImpl });
  assert.deepEqual(narrow, [], "a $10M per-venue floor admits nothing right now — the sweep can demand more depth");
  const capped = await discoverMemes({ chain: "sol", maxCandidates: 1, fetchImpl });
  assert.ok(capped.length <= 1);
});

test("discoverMemes: unknown chain fails closed; empty seed degrades to []", async () => {
  await assert.rejects(() => discoverMemes({ chain: "zeta" }), /unknown chain/);
  const empty = await discoverMemes({ chain: "sol", fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.deepEqual(empty, [], "API failure → no candidates, no throw (observation layer)");
});

test("DEFAULT_MEME_SEED_SYMBOLS covers the popular-meme universe (symbols — never mints)", () => {
  for (const s of ["BONK", "WIF", "POPCAT", "PENGU", "TRUMP"]) {
    assert.ok(DEFAULT_MEME_SEED_SYMBOLS.includes(s));
  }
  assert.ok(DEFAULT_MEME_SEED_SYMBOLS.every((s) => /^[A-Z0-9]+$/.test(s)), "seeds are searchable symbols");
});

test("DISCOVERY_CHAINS: sol first, EVM coverage structured in (eth/bas/bsc/pol)", () => {
  assert.equal(DISCOVERY_CHAINS.sol.dsChainId, "solana");
  assert.equal(DISCOVERY_CHAINS.sol.gtNetwork, "solana");
  assert.equal(DISCOVERY_CHAINS.bas.dsChainId, "base");
  assert.equal(DISCOVERY_CHAINS.eth.gtNetwork, "eth");
  assert.equal(DISCOVERY_CHAINS.bsc.gtNetwork, "bsc");
  assert.equal(DISCOVERY_CHAINS.pol.dsChainId, "polygon");
});

test("DISCOVERY_CHAINS: arb/opt/rh added (the session-tested capture surfaces)", () => {
  assert.equal(DISCOVERY_CHAINS.arb.gtNetwork, "arbitrum");
  assert.equal(DISCOVERY_CHAINS.arb.dsChainId, "arbitrum");
  assert.equal(DISCOVERY_CHAINS.opt.gtNetwork, "optimism");
  assert.equal(DISCOVERY_CHAINS.rh.gtNetwork, "robinhood");
  assert.equal(DISCOVERY_CHAINS.rh.dsChainId, "robinhood");
  assert.equal(DISCOVERY_CHAINS.rh.family, "evm");
  assert.match(DISCOVERY_CHAINS.rh.note || "", /USDG/, "RH has NO USDC — the note documents USDG");
});

test("buildVenueMap (EVM): pool-INSTANCE venues — v2/v3-tier/v4 stay separate (cross-version gap surface)", () => {
  // The architecture correction: on EVM, one dexId ("uniswap") hosts v2 + v3
  // fee tiers + v4 pools of the SAME token. Each pool is its own venue with
  // its own price — collapsing by dexId throws away the cross-version gap.
  const rows = [
    { address: "0xAAAA", symbol: "TEST", chain: "arb", family: "evm", dexId: "uniswap_v2", pairAddress: "0xP1", fee: null, liquidityUsd: 1_000_000, volumeUsd: 500_000, priceUsd: 1.00 },
    { address: "0xAAAA", symbol: "TEST", chain: "arb", family: "evm", dexId: "uniswap-v3-arbitrum", pairAddress: "0xP2", fee: 500, liquidityUsd: 2_000_000, volumeUsd: 800_000, priceUsd: 0.997 },
    { address: "0xAAAA", symbol: "TEST", chain: "arb", family: "evm", dexId: "uniswap-v3-arbitrum", pairAddress: "0xP3", fee: 3000, liquidityUsd: 3_000_000, volumeUsd: 600_000, priceUsd: 0.998 },
    { address: "0xAAAA", symbol: "TEST", chain: "arb", family: "evm", dexId: "uniswap-v4-ethereum", pairAddress: "0xP4", fee: null, liquidityUsd: 4_000_000, volumeUsd: 900_000, priceUsd: 1.004 },
  ];
  const map = buildVenueMap(rows);
  const t = map.get("0xAAAA");
  assert.equal(t.venueCount, 4, "four POOL venues — v2 + two v3 tiers + v4 are NOT collapsed");
  const venues = venuesToArray(t.venues);
  assert.equal(venues.length, 4);
  const v4 = venues.find((v) => v.version?.version === "v4");
  assert.ok(v4, "v4 pool resolved its version from the dexId");
  assert.equal(v4.pairAddress, "0xP4");
  const v3s = venues.filter((v) => v.version?.version === "v3");
  assert.equal(v3s.length, 2, "both v3 fee tiers are separate venues");
  // the per-pool prices differ → the gap signal exists (0.997 vs 1.004 = 70bps)
  const prices = venues.map((v) => v.priceUsd).filter(Boolean);
  assert.ok(Math.max(...prices) - Math.min(...prices) > 0.005, "cross-version price spread is visible per pool");
});

test("poolVersionFromDexId: version + fee tier resolution across dexId patterns", () => {
  assert.equal(poolVersionFromDexId("uniswap-v3-base").version, "v3");
  assert.equal(poolVersionFromDexId("uniswap-v4-ethereum").version, "v4");
  assert.equal(poolVersionFromDexId("pons-v2-dex").version, "v2");
  assert.equal(poolVersionFromDexId("ramses-v3-robinhood").version, "v3");
  assert.equal(poolVersionFromDexId("uniswap_v2").version, "v2");
  assert.equal(poolVersionFromDexId("aerodrome").version, "unknown", "unversioned dexIds stay unknown (safe default)");
  assert.equal(poolVersionFromDexId("uniswap-v3-base", { fee: 3000 }).feeTier, 3000);
});
