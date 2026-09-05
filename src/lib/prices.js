/**
 * prices.js — LIVE USD price lookups for the v2 bridge form's balance line.
 *
 * Mr. Esters' directive: "bridge should have values of what is in the users
 * wallets". The balance line shows each connected wallet's token balances
 * WITH their USD worth — and the USD side is ALWAYS live, never hardcoded
 * (the codebase's price rule: ALWAYS pull live).
 *
 * Design:
 *   - One Coingecko simple-price batch call covers every token the balance
 *     line can show (usd-coin, tether, dai, wrapped-solana). USDC.x is the
 *     Warp-wrapped twin of Solana USDC (1:1) and wSOL.X of Solana WSOL, so
 *     they share the underlying id — no separate fetch, no drift.
 *   - DI-able: `getPricesUSD({ fetchPrice })` accepts an injected fetcher so
 *     tests mock the network and the app can swap the source (e.g. LiFi's
 *     priceUSD pattern) without touching callers.
 *   - Cached briefly (60s) so keystrokes/re-renders never hammer the API.
 *   - Fail-soft: any fetch/parse error → null → the UI shows the balance
 *     without a USD value instead of blocking the form or throwing.
 */

/** symbol → Coingecko simple-price id (the id the /simple/price API returns). */
export const COINGECKO_IDS = Object.freeze({
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  USDG: "global-dollar", // Paxos Global Dollar — Robinhood Chain's canonical stable (added 2026-09-05; id verified live)
  WSOL: "wrapped-solana",
  "USDC.x": "usd-coin", // Warp-wrapped twin of Solana USDC — same asset
  "wSOL.X": "wrapped-solana", // Warp-wrapped twin of Solana WSOL — same asset
});

/** How long a price snapshot stays fresh (ms). */
export const PRICE_CACHE_MS = 60_000;

/** Module-level cache: { at, prices } — prices is null until the first hit. */
let cache = { at: 0, prices: null };

/**
 * Reset the module cache (test seam — lets tests control TTL/refetch).
 */
export function resetPriceCache() {
  cache = { at: 0, prices: null };
}

/**
 * The default live-price fetch: Coingecko simple price for a batch of ids.
 * DI-able via getPricesUSD({ fetchPrice }) — tests inject a fake.
 *
 * @param {string[]} ids coingecko ids, e.g. ["usd-coin","wrapped-solana"]
 * @returns {Promise<Object<string, number>|null>} { id: usdPrice } — a
 *   missing/zero id maps to null; any transport/parse failure → null (the
 *   caller turns that into "no USD value", never a throw).
 */
export async function defaultPriceFetch(ids) {
  let resp;
  try {
    resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`,
    );
  } catch {
    return null; // network failure — fail-soft
  }
  if (!resp.ok) return null;
  let d;
  try {
    d = await resp.json();
  } catch {
    return null; // unparseable body — fail-soft
  }
  const out = {};
  for (const id of ids) {
    const p = d?.[id]?.usd;
    out[id] = p != null && Number(p) > 0 ? Number(p) : null;
  }
  return out;
}

/**
 * Get the live USD price for every symbol the balance line shows, cached for
 * PRICE_CACHE_MS. DI-able: pass `fetchPrice` (mock in tests) and `now`
 * (inject a clock for TTL tests).
 *
 * @param {{fetchPrice?: (ids: string[]) => Promise<Object<string, number>|null>,
 *          now?: number, force?: boolean}} [opts]
 * @returns {Promise<Object<string, number>|null>} { USDC: 1.0, USDT: 1.0,
 *   DAI: 1.0, WSOL: 150.5, "USDC.x": 1.0, "wSOL.X": 150.5 } — null when the
 *   fetch fails entirely (callers then show balances without USD).
 */
export async function getPricesUSD({ fetchPrice = defaultPriceFetch, now = Date.now(), force = false } = {}) {
  if (!force && cache.prices && now - cache.at < PRICE_CACHE_MS) {
    return cache.prices; // fresh snapshot — no API call
  }
  const ids = [...new Set(Object.values(COINGECKO_IDS))];
  let raw;
  try {
    raw = await fetchPrice(ids);
  } catch {
    return null; // a throwing fetcher is a failed fetch — fail-soft
  }
  if (!raw) return null; // fail-soft: no price at all
  const prices = {};
  for (const sym of Object.keys(COINGECKO_IDS)) {
    const id = COINGECKO_IDS[sym];
    prices[sym] = raw[id] ?? null;
  }
  cache = { at: now, prices };
  return prices;
}

/**
 * USD value of a balance at a price — pure math, decimals are handled before
 * this (balances arrive in human units). Null-in/null-out: a missing balance
 * or price yields null (the UI omits the USD parenthetical).
 */
export function usdValue(balance, price) {
  if (balance == null || price == null) return null;
  return balance * price;
}
