/**
 * memeDiscovery.js — APE UNIVERSE build #1: the SELF-DISCOVERING meme
 * candidate feed (pure-ish; fetch injected for tests).
 *
 * WHY THIS MODULE EXISTS (the problem it fixes):
 *   The MEV capture engine's real-capture tests proved the venue-gap
 *   mechanism (2 real WIF captures, 8.89 + 16.3 bps) but were limited by
 *   HARDCODED mint guessing — the scratch sweep's mint table went stale
 *   (its BONK mint was wrong; the real dogwifhat does not even surface in
 *   a DEX Screener symbol search because meme turnover drowns canonical
 *   symbols in pump.fun lookalikes). This module replaces mint guessing
 *   with live, keyless self-discovery: it finds what is actually trading
 *   on ≥2 liquid venues RIGHT NOW, on-chain, per chain.
 *
 * WHAT IT FEEDS (two consumers, one shape):
 *   1. The capture sweep (tools/mev-discover-sweep.mjs --discover) — the
 *      ≥2-liquid-venues filter IS the capture precondition (single-venue
 *      tokens cannot be gap-captured — the sim + real tests proved it).
 *   2. The APE UNIVERSE degen feed / dashboard tab (docs/APE-UNIVERSE.md)
 *      — the same module powers the meme ticker rows.
 *
 * PIPELINE (live, keyless — both APIs verified working):
 *   1. SEED    — GeckoTerminal /api/v2/networks/{network}/trending_pools
 *                (dynamic: real pools with volume + reserve; per-network =
 *                per-chain from day one). Optional extra seed: DEX Screener
 *                /latest/dex/search?q={symbol} over a curated symbol list
 *                (DEFAULT_MEME_SEED_SYMBOLS) — unreliable alone (pump
 *                lookalike dominance — see docs/MEME-DISCOVERY.md), but the
 *                venue map + pump-skip + liquidity floors drop the junk.
 *   2. VENUES  — DEX Screener /latest/dex/tokens/{mints} (batch ≤30 per
 *                call): EVERY pair per mint across AMMs → per-dex venue
 *                aggregates (the capture unit: Jupiter excludes whole AMMs,
 *                so a "venue" = one AMM's aggregate depth for the token).
 *                Tokens the venue API does not know fall back to their
 *                GeckoTerminal pools (pool ≈ venue).
 *   3. FILTER  — pump.fun skip (rug risk — see PUMP note), chain match,
 *                per-venue liquidity floor (minLiquidityUsd), venue count
 *                ≥ minVenues, token-wide 24h volume ≥ minVolume24Usd.
 *
 * SAFETY: these are DISPLAY/discovery thresholds (the degen feed bar). The
 * capture sweep can pass stricter values — the module is pure filtering;
 * the money path is never here. src/ modules must stay browser-safe: no
 * node builtins, fetch via dependency injection (global fetch default).
 *
 * OUTPUT SHAPE (the contract — documented for both consumers):
 *   discoverMemes() → [{
 *     symbol, mint, chain, priceUsd,
 *     liquidityUsd,      // Σ across the token's non-pump venues
 *     volume24Usd,       // Σ 24h volume across its non-pump venues
 *     venueCount,        // venues passing the per-venue liquidity floor
 *     venues: [{ dex, liquidityUsd, volumeUsd, pairCount }],
 *     sources: [...], discoveredAt (ISO)
 *   }] sorted by liquidityUsd desc.
 */

// ── chain registry (canonical chain keys = repo teleportConstants ids) ────
// gtNetwork = GeckoTerminal network slug; dsChainId = DEX Screener chainId.
// sol first (the proven capture surface), then the EVM networks the task
// scopes (eth/bas/bsc/pol). Adding a chain = one row here (docs/MEME-
// DISCOVERY.md "how to add chains").
export const DISCOVERY_CHAINS = Object.freeze({
  sol: Object.freeze({ gtNetwork: "solana", dsChainId: "solana", family: "svm", label: "Solana" }),
  eth: Object.freeze({ gtNetwork: "eth", dsChainId: "ethereum", family: "evm", label: "Ethereum" }),
  bas: Object.freeze({ gtNetwork: "base", dsChainId: "base", family: "evm", label: "Base" }),
  bsc: Object.freeze({ gtNetwork: "bsc", dsChainId: "bsc", family: "evm", label: "BNB Chain" }),
  pol: Object.freeze({ gtNetwork: "polygon", dsChainId: "polygon", family: "evm", label: "Polygon" }),
  arb: Object.freeze({ gtNetwork: "arbitrum", dsChainId: "arbitrum", family: "evm", label: "Arbitrum" }),
  opt: Object.freeze({ gtNetwork: "optimism", dsChainId: "optimism", family: "evm", label: "Optimism" }),
  rh: Object.freeze({ gtNetwork: "robinhood", dsChainId: "robinhood", family: "evm", label: "Robinhood Chain", note: "Arbitrum-Orbit L2 (chain 4663) — standard EVM. Gas ETH, stable USDG (NO USDC). Uniswap-dominant (~85%) + Pons. Uni pools at RH-owned factory 0x1f7d7550 (canonical addresses are stubs). docs/RH-CHAIN-DEX.md" }),
});

export const DISCOVERY_CHAIN_KEYS = Object.freeze(Object.keys(DISCOVERY_CHAINS));

/** Default discovery thresholds — tunable per call; the sweep passes its
 *  own (stricter) values. minLiquidityUsd is the PER-VENUE floor: a venue
 *  counts toward minVenues only when its aggregate liquidity ≥ this. */
export const MEME_DISCOVERY_DEFAULTS = Object.freeze({
  minLiquidityUsd: 50_000,
  minVolume24Usd: 10_000,
  minVenues: 2,
  maxCandidates: 25,
});

/** The popular-meme symbol universe (curated seed — SYMBOLS, not mints:
 *  the search resolves the current symbol→mint, so turnover cannot go
 *  stale. Optional extra seed; GeckoTerminal trending is the primary,
 *  fully-dynamic seed.) */
export const DEFAULT_MEME_SEED_SYMBOLS = Object.freeze([
  "BONK", "WIF", "POPCAT", "PENGU", "MEW", "GOAT", "FARTCOIN", "MOODENG", "TRUMP", "BODEN", "PNUT", "MOTHER",
]);

/** 🔴 pump.fun skip (rug risk — the task's hard rule; no pump.fun API is
 *  ever queried, and pump venues are stripped from every stage):
 *  - A VENUE is a pump venue when its dex id matches this (pumpfun,
 *    pumpswap, pump.fun …). Those pairs/pools never count toward liquidity,
 *    volume, or venueCount.
 *  - A TOKEN whose only venues are pump venues can never pass minVenues ≥ 2
 *    — it dies in the filter. (A pump-BORN token that migrated to a real
 *    AMM with deep liquidity may still qualify — its real-AMM venues are
 *    real; the floors are the safety, documented in docs/MEME-DISCOVERY.md.)
 */
export const PUMP_DEX_PATTERN = /pump/i;

/** GeckoTerminal trending page size (their default; page param supported). */
export const GECKO_TRENDING_PAGE_LIMIT = 20;

/** DEX Screener /tokens batch limit (their documented max per call). */
export const DEXSCREENER_TOKENS_BATCH = 30;

/** Rate-limit courtesy sleeps between batched calls (ms) — both APIs are
 *  keyless public endpoints; stay well under their per-minute budgets. */
export const API_POLITE_DELAY_MS = 250;

/** How many GeckoTerminal trending pages to walk per network (their
 *  trending endpoint is one deep page of the hottest pools; page 1 is the
 *  discovery bar — more pages = longer tails). */
export const GECKO_TRENDING_MAX_PAGES = 1;

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const DS_BASE = "https://api.dexscreener.com/latest/dex";

// ── small pure helpers ──────────────────────────────────────────────────────

/** Normalize a token address for identity: EVM addresses lowercase
 *  (checksum-insensitive); SVM/base58 addresses are used as-is (case is
 *  meaningful in base58 — lowercasing would corrupt them). */
export function normalizeMint(address, family = "svm") {
  if (!address || typeof address !== "string") return null;
  const a = address.trim();
  if (!a) return null;
  return family === "evm" ? a.toLowerCase() : a;
}

/** Is this a GeckoTerminal token id's embedded address? GT ids look like
 *  "solana_<mint>" / "base_0x…". Strips the "<network>_" prefix. */
export function addressFromGeckoTokenId(id) {
  if (!id || typeof id !== "string") return null;
  const i = id.indexOf("_");
  return i === -1 ? id : id.slice(i + 1);
}

/** Number parsing that never throws on API junk → 0. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── parse: DEX Screener ─────────────────────────────────────────────────────
// Raw API → normalized pair observations (pure; NO filtering here — the
// filter stage owns thresholds + the pump skip).

/**
 * parseDexScreener — normalize a DEX Screener response (either the search
 * response { pairs: […] } or the /tokens/{mints} response { pairs: […] })
 * into per-pair observations for one chain.
 *
 * @param {object} json raw API response
 * @param {object} opts { chain (canonical key), dsChainId }
 * @returns {Array<object>} pair observations:
 *   [{ address (normalized mint), symbol, chain, pairAddress, dexId,
 *      liquidityUsd, volumeUsd, priceUsd }] — pairs on OTHER chains are
 *   dropped (a search response can mix chains; the venue map must not).
 */
export function parseDexScreener(json, { chain, dsChainId } = {}) {
  if (!json || !Array.isArray(json.pairs)) return [];
  if (!chain || !dsChainId) throw new Error("memeDiscovery.parseDexScreener: chain + dsChainId are required");
  const out = [];
  for (const p of json.pairs) {
    if (!p || p.chainId !== dsChainId) continue;
    const base = p.baseToken;
    if (!base || !base.address) continue;
    out.push({
      address: normalizeMint(base.address, DISCOVERY_CHAINS[chain]?.family),
      symbol: base.symbol ?? null,
      name: base.name ?? null,
      chain,
      family: DISCOVERY_CHAINS[chain]?.family ?? null,
      pairAddress: p.pairAddress ?? null,
      dexId: p.dexId ?? null,
      fee: p.fee != null ? Number(p.fee) : null, // v3 fee tier when the API exposes it (100/500/3000/10000)
      liquidityUsd: num(p.liquidity?.usd),
      volumeUsd: num(p.volume?.h24),
      priceUsd: num(p.priceUsd),
    });
  }
  return out;
}

// ── parse: GeckoTerminal ────────────────────────────────────────────────────
// Raw API → normalized pool observations (pure). One trending pool IS one
// venue observation (a pool trades one base token on one dex).

/**
 * parseGeckoTerminal — normalize a GeckoTerminal pools response (the
 * trending_pools or tokens/{address}/pools shapes both carry the same
 * pool schema) into pool observations.
 *
 * @param {object} json raw API response ({ data: [pool…], included?: […] })
 * @param {object} opts { chain, gtNetwork }
 * @returns {Array<object>} pool observations:
 *   [{ address (mint from the base_token relationship id), symbol (from
 *      included when present), chain, poolAddress, dexId, liquidityUsd
 *      (≈ reserve_in_usd), volumeUsd (h24), priceUsd, geckoTokenId }]
 */
export function parseGeckoTerminal(json, { chain, gtNetwork } = {}) {
  if (!json || !Array.isArray(json.data)) return [];
  if (!chain || !gtNetwork) throw new Error("memeDiscovery.parseGeckoTerminal: chain + gtNetwork are required");
  const tokensById = new Map();
  for (const inc of json.included ?? []) {
    if (inc?.type === "token" && inc?.id && inc?.attributes) {
      tokensById.set(inc.id, inc.attributes);
    }
  }
  const out = [];
  for (const pool of json.data) {
    const attrs = pool?.attributes ?? {};
    const rel = pool?.relationships ?? {};
    const baseTok = rel.base_token?.data ?? null;
    if (!baseTok?.id) continue; // a pool without a base token is not a meme candidate
    const address = normalizeMint(addressFromGeckoTokenId(baseTok.id), DISCOVERY_CHAINS[chain]?.family);
    if (!address) continue;
    const tokenAttrs = tokensById.get(baseTok.id);
    out.push({
      address,
      symbol: tokenAttrs?.symbol ?? null,
      name: tokenAttrs?.name ?? null,
      chain,
      family: DISCOVERY_CHAINS[chain]?.family ?? null,
      poolAddress: attrs.address ?? null,
      dexId: rel.dex?.data?.id ?? null,
      // reserve_in_usd ≈ the pool's two-sided liquidity (the same notion as
      // DEX Screener liquidity.usd; not identical — documented in
      // docs/MEME-DISCOVERY.md)
      liquidityUsd: num(attrs.reserve_in_usd),
      volumeUsd: num(attrs.volume_usd?.h24),
      priceUsd: num(attrs.base_token_price_usd),
      geckoTokenId: baseTok.id,
    });
  }
  return out;
}

// ── venue aggregation ───────────────────────────────────────────────────────

/** Is this dex/pool id a pump.fun venue? (pumpfun / pumpswap / pump.fun …) */
export function isPumpVenue(dexId) {
  return Boolean(dexId && PUMP_DEX_PATTERN.test(String(dexId)));
}

/**
 * poolVersionFromDexId — resolve the AMM generation of a pool from its
 * DEX Screener dexId (+ pair row). The engine must route across v2 / v3
 * fee tiers / v4 — the version tells it which router family + quote path
 * a pool needs. Pure + best-effort: unknown patterns → "unknown".
 * @param {string} dexId e.g. "uniswap-v3-base", "uniswap_v2", "uniswap-v4-ethereum", "pons-v2-dex", "ramses-v3-robinhood"
 * @param {object} [obs] optional pair row (for fee hints)
 * @returns {object} { version: "v2"|"v3"|"v4"|"unknown", feeTier: int|null }
 */
export function poolVersionFromDexId(dexId, obs = null) {
  const d = String(dexId || "").toLowerCase();
  const out = { version: "unknown", feeTier: null };
  if (d.includes("v4")) out.version = "v4";
  else if (d.includes("v3")) out.version = "v3";
  else if (d.includes("v2")) out.version = "v2";
  // fee tier hint from the dexId tail (e.g. "0.3%" appears in some ids) or obs
  const feeMatch = d.match(/(\d+(?:\.\d+)?)%/);
  if (feeMatch) out.feeTier = Math.round(parseFloat(feeMatch[1]) * 10000);
  else if (obs?.fee) out.feeTier = obs.fee;
  return out;
}

/**
 * buildVenueMap — aggregate pair/pool observations into per-token, per-dex
 * venue maps. Pure.
 *
 * A "venue" is one AMM's aggregate depth for the token (the capture unit:
 * the gap sweep excludes whole AMMs via Jupiter's excludeDexes, so two
 * pairs on the same AMM are one venue). Pump venues are STRIPPED here —
 * they never contribute liquidity/volume/venue counts.
 *
 * @param {Array<object>} observations parseDexScreener / parseGeckoTerminal rows
 * @returns {Map<string, object>} address → {
 *   address, symbol, chain, priceUsd (best observed), liquidityUsd,
 *   volumeUsd, venueCount (dexes with ≥1 observation), pairCount,
 *   venues: Map<dexId, { dex, liquidityUsd, volumeUsd, pairCount }> }
 */
export function buildVenueMap(observations) {
  const tokens = new Map();
  for (const obs of observations) {
    if (!obs || !obs.address) continue;
    if (isPumpVenue(obs.dexId)) continue; // 🔴 pump.fun skip (rug risk)
    let t = tokens.get(obs.address);
    if (!t) {
      t = { address: obs.address, symbol: obs.symbol, chain: obs.chain, priceUsd: obs.priceUsd, liquidityUsd: 0, volumeUsd: 0, venueCount: 0, pairCount: 0, venues: new Map() };
      tokens.set(obs.address, t);
    }
    // symbol: first non-null wins (display only — identity is the address)
    if (!t.symbol && obs.symbol) t.symbol = obs.symbol;
    if (obs.priceUsd > t.priceUsd) t.priceUsd = obs.priceUsd;
    const dexId = obs.dexId ?? "unknown";
    // 🔴 POOL-VERSION-AWARE VENUE KEY (Mr. Esters' architecture correction —
    // 2026-09-08): EVM chains key venues by POOL INSTANCE (dexId + pairAddress),
    // NOT the coarse dexId — the same token lives in v2 + multiple v3 fee
    // tiers + v4 pools under one dexId; collapsing them throws away the
    // cross-version price gap (the MEV surface). SVM chains (raydium/orca/
    // meteora) stay per-AMM: Jupiter excludes at AMM level and each AMM is
    // one venue there. The family is passed on the observation row.
    const family = obs.family ?? DISCOVERY_CHAINS[obs.chain]?.family ?? "evm"; // svm → per-AMM; evm → per-pool
    const poolKey = family === "evm" && obs.pairAddress ? `${dexId}@${obs.pairAddress}` : dexId;
    let v = t.venues.get(poolKey);
    if (!v) {
      v = {
        dex: dexId,
        pairAddress: obs.pairAddress ?? null,
        version: poolVersionFromDexId(dexId, obs),
        priceUsd: obs.priceUsd ?? null, // per-pool price — the gap signal
        liquidityUsd: 0,
        volumeUsd: 0,
        pairCount: 0,
      };
      t.venues.set(poolKey, v);
      t.venueCount += 1;
    }
    v.liquidityUsd += obs.liquidityUsd;
    v.volumeUsd += obs.volumeUsd;
    v.pairCount += 1;
    if (obs.priceUsd && v.priceUsd === null) v.priceUsd = obs.priceUsd;
    t.pairCount += 1;
  }
  for (const t of tokens.values()) {
    t.liquidityUsd = [...t.venues.values()].reduce((s, v) => s + v.liquidityUsd, 0);
    t.volumeUsd = [...t.venues.values()].reduce((s, v) => s + v.volumeUsd, 0);
  }
  return tokens;
}

/**
 * venuesToArray — the Map<venueKey, venue> → sorted array form (output shape).
 * On SVM the key is the AMM (dexId); on EVM it is the POOL INSTANCE
 * (dexId@pairAddress) so v2 / v3 fee tiers / v4 pools of one token stay
 * separate scoreable venues (cross-version gaps = the MEV surface).
 * @returns {Array<object>} [{ dex, pairAddress, version, feeTier, priceUsd,
 *   liquidityUsd, volumeUsd, pairCount }] descending by liquidityUsd
 */
export function venuesToArray(venueMap) {
  return [...venueMap.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

// ── merge + dedupe ──────────────────────────────────────────────────────────

/**
 * dedupeByMint — merge venue maps from multiple sources (GT trending seeds
 * + DEX Screener venue maps) into ONE map keyed by normalized mint. When
 * two sources report the same token, the DEX Screener data wins per venue
 * (it is the richer per-pair truth); GeckoTerminal-only venues (dexes the
 * venue API did not report) are appended so a GT-only token still shows
 * its pools as venues. Pure.
 *
 * @param {Array<Map<string, object>>} tokenMaps maps from buildVenueMap
 * @param {Array<string>} [priority] address sources already carrying DS
 *   truth — internal use; when a later map holds the same venue dex as an
 *   earlier one, the FIRST (higher-priority) venue wins.
 * @returns {Map<string, object>} merged token map (mutates copies, not
 *   inputs)
 */
export function dedupeByMint(tokenMaps) {
  const merged = new Map();
  for (const map of tokenMaps) {
    if (!map) continue;
    for (const [address, tok] of map) {
      let t = merged.get(address);
      if (!t) {
        t = {
          address,
          symbol: tok.symbol,
          chain: tok.chain,
          priceUsd: tok.priceUsd,
          liquidityUsd: 0,
          volumeUsd: 0,
          venueCount: 0,
          pairCount: 0,
          venues: new Map(),
        };
        merged.set(address, t);
      }
      if (!t.symbol && tok.symbol) t.symbol = tok.symbol;
      if (tok.priceUsd > t.priceUsd) t.priceUsd = tok.priceUsd;
      for (const [dexId, v] of tok.venues) {
        if (!t.venues.has(dexId)) {
          t.venues.set(dexId, { ...v });
          t.venueCount += 1;
        }
        // same dex from two sources: first (higher-priority) wins — DS data
        // is passed first by the pipeline; do not double-count.
      }
      t.pairCount += tok.pairCount;
      t.liquidityUsd = [...t.venues.values()].reduce((s, v) => s + v.liquidityUsd, 0);
      t.volumeUsd = [...t.venues.values()].reduce((s, v) => s + v.volumeUsd, 0);
    }
  }
  return merged;
}

// ── the candidate filter (the capture-precondition gate) ───────────────────

/**
 * filterCandidates — apply the DISPLAY/discovery safety thresholds. Pure.
 *
 * A token PASSES when:
 *   • it has ≥ minVenues venues whose per-venue aggregate liquidity
 *     (liquidityUsd) ≥ minLiquidityUsd, AND
 *   • its token-wide 24h volume (Σ across non-pump venues) ≥ minVolume24Usd.
 * A token FAILS when it has fewer eligible venues than minVenues (the
 * single-venue case — NOT capturable), or its volume is below the floor,
 * or it has no non-pump venues at all.
 *
 * @param {Map<string, object>|object[]} tokens merged token map (or array
 *   of token objects)
 * @param {object} [thresholds]
 * @returns {object[]} candidate objects (the OUTPUT SHAPE):
 *   [{ symbol, mint, chain, priceUsd, liquidityUsd, volume24Usd,
 *      venueCount, venues: [{dex, liquidityUsd, volumeUsd, pairCount}] }]
 *   sorted by liquidityUsd desc
 */
export function filterCandidates(tokens, { minLiquidityUsd = MEME_DISCOVERY_DEFAULTS.minLiquidityUsd, minVolume24Usd = MEME_DISCOVERY_DEFAULTS.minVolume24Usd, minVenues = MEME_DISCOVERY_DEFAULTS.minVenues } = {}) {
  if (minVenues < 1) throw new Error("memeDiscovery.filterCandidates: minVenues must be ≥ 1");
  if (minLiquidityUsd < 0 || minVolume24Usd < 0) throw new Error("memeDiscovery.filterCandidates: thresholds cannot be negative");
  const list = tokens instanceof Map ? [...tokens.values()] : tokens;
  const out = [];
  for (const t of list) {
    const venues = venuesToArray(t.venues);
    const eligible = venues.filter((v) => v.liquidityUsd >= minLiquidityUsd);
    if (eligible.length < minVenues) continue; // ← the capture precondition
    if (t.volumeUsd < minVolume24Usd) continue;
    out.push({
      symbol: t.symbol ?? t.address.slice(0, 6),
      mint: t.address,
      chain: t.chain,
      priceUsd: t.priceUsd || null,
      liquidityUsd: t.liquidityUsd,
      volume24Usd: t.volumeUsd,
      venueCount: eligible.length,
      venues, // all non-pump venues (each row carries its own liquidity)
    });
  }
  return out.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

// ── live API calls (fetch DI) ───────────────────────────────────────────────

async function politeDelay(ms = API_POLITE_DELAY_MS) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Fetch with polite 429/5xx retry + backoff (both public APIs burst-limit;
 *  the discovery feed must not die on a burst — it degrades, retries, and
 *  only then reports the miss). */
async function fetchWithRetry(url, { fetchImpl, attempts = 3, label } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
        const wait = retryAfter > 0 ? retryAfter : 900 * attempt;
        console.error(`memeDiscovery: ${label} HTTP ${res.status} — retry ${attempt}/${attempts - 1} in ${wait}ms`);
        await politeDelay(wait);
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt < attempts && /retry|HTTP 429|HTTP 5/.test(err.message)) {
        await politeDelay(900 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts`);
}

/**
 * fetchGeckoTrending — seed phase: GeckoTerminal trending pools for a
 * network. Returns raw pool observations (parseGeckoTerminal rows).
 * @param {object} opts { chain, gtNetwork, fetchImpl }
 */
export async function fetchGeckoTrending({ chain, gtNetwork, fetchImpl = fetch, pages = GECKO_TRENDING_MAX_PAGES }) {
  const observations = [];
  for (let page = 1; page <= pages; page += 1) {
    const url = `${GT_BASE}/networks/${gtNetwork}/trending_pools?include=base_token&page=${page}`;
    let json = null;
    try {
      const res = await fetchWithRetry(url, { fetchImpl, label: `GeckoTerminal trending (${gtNetwork})` });
      json = await res.json();
    } catch (err) {
      // one page failing is not fatal to the seed — the venue phase + other
      // seeds still run; the caller sees the count it got.
      console.error(`memeDiscovery: GeckoTerminal trending (${gtNetwork} page ${page}) failed: ${err.message}`);
    }
    observations.push(...parseGeckoTerminal(json ?? { data: [] }, { chain, gtNetwork }));
    if (pages > 1) await politeDelay();
  }
  return observations;
}

/**
 * fetchDexScreenerTokens — venue phase: DEX Screener /tokens/{mints}
 * (batched ≤ DEXSCREENER_TOKENS_BATCH per call) → pair observations for
 * the chain. Tokens with no DS listing simply produce no rows (callers
 * fall back to GeckoTerminal pool venues).
 */
export async function fetchDexScreenerTokens({ chain, dsChainId, mints, fetchImpl = fetch }) {
  const observations = [];
  const unique = [...new Set(mints.filter(Boolean))];
  for (let i = 0; i < unique.length; i += DEXSCREENER_TOKENS_BATCH) {
    const batch = unique.slice(i, i + DEXSCREENER_TOKENS_BATCH);
    const url = `${DS_BASE}/tokens/${encodeURIComponent(batch.join(","))}`;
    try {
      const res = await fetchWithRetry(url, { fetchImpl, label: "DEX Screener /tokens" });
      const json = await res.json();
      observations.push(...parseDexScreener(json, { chain, dsChainId }));
    } catch (err) {
      console.error(`memeDiscovery: DEX Screener /tokens batch failed: ${err.message}`);
    }
    if (i + DEXSCREENER_TOKENS_BATCH < unique.length) await politeDelay();
  }
  return observations;
}

/**
 * fetchDexScreenerSearch — optional seed: DEX Screener symbol search. The
 * raw response is parsed + venue-mapped like any other source; pump
 * lookalikes and below-floor junk are removed by the standard filter, so a
 * symbol that is currently drowned (real WIF's fate — docs/MEME-
 * DISCOVERY.md) simply yields nothing capturable.
 */
export async function fetchDexScreenerSearch({ symbols, fetchImpl = fetch, delayMs = 150 }) {
  const pairRows = [];
  for (const symbol of symbols) {
    try {
      const res = await fetchWithRetry(`${DS_BASE}/search?q=${encodeURIComponent(symbol)}`, { fetchImpl, label: `DEX Screener search "${symbol}"` });
      const json = await res.json();
      pairRows.push(...(json.pairs ?? []));
    } catch (err) {
      console.error(`memeDiscovery: DEX Screener search "${symbol}" failed: ${err.message}`);
    }
    await politeDelay(delayMs); // search is per-symbol; pace it
  }
  return pairRows;
}

// ── the orchestrator ────────────────────────────────────────────────────────

/**
 * discoverMemes — the discovery pipeline (live, keyless). Sol first (the
 * proven capture surface); every DISCOVERY_CHAINS key works the same way.
 *
 * @param {object} opts
 * @param {string} [opts.chain="sol"] canonical chain key
 * @param {number} [opts.minLiquidityUsd] per-venue liquidity floor
 * @param {number} [opts.minVolume24Usd] token-wide 24h volume floor
 * @param {number} [opts.minVenues] liquid-venue count required (capture
 *   precondition — default 2)
 * @param {number} [opts.maxCandidates] cap on returned rows
 * @param {string[]} [opts.seedSymbols=[]] optional curated symbol seeds
 *   (DEFAULT_MEME_SEED_SYMBOLS); [] = GeckoTerminal trending only
 * @param {boolean} [opts.verbose=false] log per-stage counts to console
 * @param {Function} [opts.fetchImpl=fetch] DI for tests
 * @returns {Promise<object[]>} candidates (the OUTPUT SHAPE above), each
 *   carrying the module contract fields + sources + discoveredAt
 */
export async function discoverMemes({
  chain = "sol",
  minLiquidityUsd = MEME_DISCOVERY_DEFAULTS.minLiquidityUsd,
  minVolume24Usd = MEME_DISCOVERY_DEFAULTS.minVolume24Usd,
  minVenues = MEME_DISCOVERY_DEFAULTS.minVenues,
  maxCandidates = MEME_DISCOVERY_DEFAULTS.maxCandidates,
  seedSymbols = [],
  verbose = false,
  fetchImpl = fetch,
} = {}) {
  const meta = DISCOVERY_CHAINS[chain];
  if (!meta) throw new Error(`memeDiscovery.discoverMemes: unknown chain "${chain}" (known: ${DISCOVERY_CHAIN_KEYS.join(" | ")})`);

  const log = (msg) => { if (verbose) console.log(`  memeDiscovery[${chain}] ${msg}`); };
  const discoveredAt = new Date().toISOString();

  // 1. SEED — GeckoTerminal trending pools (dynamic, real liquidity)
  const gtRows = await fetchGeckoTrending({ chain, gtNetwork: meta.gtNetwork, fetchImpl });
  log(`GeckoTerminal trending seed: ${gtRows.length} pool observation(s)`);

  // 1b. SEED (optional) — DEX Screener curated-symbol search
  let dsSearchRows = [];
  if (seedSymbols.length) {
    dsSearchRows = await fetchDexScreenerSearch({ symbols: seedSymbols, fetchImpl });
    log(`DEX Screener symbol-search seed: ${dsSearchRows.length} pair observation(s)`);
  }

  // Build the seed token map (pump venues already stripped by buildVenueMap).
  // NOTE: search rows are RAW API pairs — they must go through
  // parseDexScreener (chain-scoped normalization) before buildVenueMap;
  // feeding raw rows would silently drop every one of them.
  const searchObs = parseDexScreener({ pairs: dsSearchRows }, { chain, dsChainId: meta.dsChainId });
  const seedMap = buildVenueMap([...gtRows, ...searchObs]);
  // Honest provenance for the output `sources` field: which stage actually
  // surfaced each mint (GT trending ≠ symbol search — BONK was NOT trending
  // when its fixture was captured; the search seed found it).
  const gtMints = new Set(buildVenueMap(gtRows).keys());
  const searchMints = new Set(buildVenueMap(searchObs).keys());

  // 2. VENUE MAP — expand every seeded mint through DEX Screener /tokens.
  //    The venue API response is the authoritative per-venue truth; the
  //    seed map keeps only the venues /tokens did not report (GT-only
  //    tokens still show their pools). DS map is passed FIRST = wins on
  //    dex conflicts (dedupeByMint priority).
  const mints = [...seedMap.keys()];
  log(`seed mints: ${mints.length} → venue expansion…`);
  const dsVenueRows = await fetchDexScreenerTokens({ chain, dsChainId: meta.dsChainId, mints, fetchImpl });
  log(`DEX Screener /tokens: ${dsVenueRows.length} pair observation(s)`);
  const dsVenueMap = buildVenueMap(dsVenueRows);
  const merged = dedupeByMint([dsVenueMap, seedMap]);
  log(`merged tokens: ${merged.size}`);

  // 3. FILTER — thresholds + the ≥2-venue capture precondition
  const candidates = filterCandidates(merged, { minLiquidityUsd, minVolume24Usd, minVenues });
  log(`capturable candidates (≥${minVenues} venue(s) ≥$${minLiquidityUsd} liq, ≥$${minVolume24Usd} vol): ${candidates.length}`);

  return candidates.slice(0, maxCandidates).map((c) => {
    const sources = [];
    if (gtMints.has(c.mint)) sources.push("geckoterminal-trending");
    if (searchMints.has(c.mint)) sources.push("dexscreener-search");
    if (dsVenueMap.has(c.mint)) sources.push("dexscreener-tokens");
    return { ...c, sources, discoveredAt };
  });
}
