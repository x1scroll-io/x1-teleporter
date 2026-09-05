/**
 * config.js — Rango lane CONFIG VALUES (Phase-5 scaffold: the multi-chain
 * aggregator leg that wraps THORChain/Mayan/Wanchain/… for source chains
 * THORChain alone can't serve — SUI / TRON / XRPL / TON / STELLAR and the
 * UTXO natives as a fallback rail).
 *
 * EVERYTHING here is a config value, never a hardcoded string buried in a
 * component. The quote module (quote.js) reads the proxy path + the asset
 * ids; the rail layer (teleportRail.js) reads nothing from here (its Rango
 * registries are its own); the legs read the constants through the pure
 * builders.
 *
 * VERIFIED LIVE 2026-09-05 (this scaffold's research pass — NOT guessed):
 *   - Quote endpoint: GET {base}/basic/quote?from=…&to=…&amount=…&slippage=…
 *     &apiKey=…  — the apiKey is a QUERY PARAM, and api.rango.exchange now
 *     401s every keyless call (the old free /basic/swap probe era is over).
 *   - Key process (docs.rango.exchange/api-integration/api-key-and-rate-limits):
 *     request a key on Rango's Discord (users-support) describing the dApp +
 *     domains (CORS). The docs publish a PUBLIC TEST key
 *     (c6381a79-2817-4602-83bf-6a641a409e32) that ONLY works against
 *     https://public-api.rango.exchange (fixed low rate limit — never
 *     production). Private keys use https://api.rango.exchange.
 *   - Source-chain coverage (live /basic/meta): SUI ✅ TRON ✅ XRPL ✅
 *     BTC/DOGE/LTC/BCH/DASH/ZCASH ✅ TON ✅ STELLAR ✅ — and CARDANO ❌ and
 *     POLKADOT ❌ are NOT in Rango's current chain list at all ("We don't
 *     support blockchain CARDANO currently"). The docs/ENGINE-UPDATE.md
 *     "unlocks ADA/Polkadot" framing is WRONG for today's Rango — those two
 *     land only when Rango adds the chains (re-verify via /basic/meta then).
 *   - SOL destination: SOLANA.SOL ✅ (native, address null, 9 decimals).
 *   - Referrer fee (docs …/basic-api-single-step/monetization): quote carries
 *     referrerFee (percent of INPUT; default 0.1%; max 3%); the swap-create
 *     call carries referrerFee + referrerAddress. Payout addresses are EVM /
 *     Starknet / Osmosis today — Solana fee payout is "not ready for public
 *     use" (so a SOL-landing lane can't be paid on Solana yet).
 *
 * PARKED-ITEM BOUNDARY (Mr. Esters owns these — same discipline as the
 * THORChain config placeholders):
 *   - RANGO_REFERRER_FEE / RANGO_REFERRER_ADDRESS are EMPTY placeholders:
 *     while empty, quotes/swap-requests carry NO referrer params — nothing
 *     invented is ever sent. FEE-CLASS RULING NEEDED before live: our
 *     fee-model v2 charges Teleporter 0.5% once per journey (capped $250),
 *     and on the SOL-landing continuation that fee is the Warp-leg skim —
 *     adding a Rango referrerFee would DOUBLE-charge the journey unless Mr.
 *     Esters rules the Rango lane as its own fee class (e.g. referrerFee
 *     "0.5" as the source-side Teleporter fee for routes that END on Solana
 *     without the Warp continuation). Set the real values here (and only
 *     here) when ruled.
 *   - The REAL Rango API key is parked (never in this file, never a
 *     VITE_/NEXT_PUBLIC_ var): it lives ONLY in the server env
 *     (api/rango/quote.js reads RANGO_API_KEY at call time and FAILS CLOSED
 *     without it — the client never holds a key).
 *
 * PURE MODULE: constants only — no DOM, no fetch, no wallet, no env reads.
 * Runnable under `node --test`.
 */

/**
 * The Rango API paths (basic single-step API — the current API family; the
 * older multi-step /basic/swap-only era is gone). Quote + swap-create are
 * both GETs with the apiKey query param appended SERVER-side by our proxy.
 */
export const RANGO_QUOTE_PATH = "/basic/quote";
export const RANGO_SWAP_PATH = "/basic/swap";

/**
 * OUR serverless proxy paths (the client only ever talks to our own
 * same-origin /api/* functions — the Rango key never reaches the browser).
 * api/rango/quote.js exists in this scaffold; api/rango/swap.js is a
 * documented future lane (the execute leg pins the request SHAPE against
 * this path; the proxy route itself lands with the live test).
 */
export const RANGO_QUOTE_PROXY_PATH = "/api/rango/quote";
export const RANGO_SWAP_PROXY_PATH = "/api/rango/swap";

/**
 * Default slippage percent for Rango quote/swap requests when the caller
 * doesn't supply one (the API's own default is 0.5% — mirrored here so the
 * canonical request is explicit).
 */
export const RANGO_DEFAULT_SLIPPAGE_PERCENT = 0.5;

/**
 * Referrer (affiliate) fee placeholder — EMPTY until Mr. Esters rules the
 * Rango lane's fee class (see the module header). When set, it is a percent
 * of the INPUT amount (docs: max 3%; default 0.1% when unset). "0.5" would
 * be the fee-model-v2 rate IF the Rango leg is ruled to carry Teleporter's
 * fee source-side.
 */
export const RANGO_REFERRER_FEE = "";

/**
 * Referrer payout address placeholder — EMPTY until the fee ruling lands.
 * Rango pays referrer fees to EVM / Starknet / Osmosis addresses (Solana
 * payout is not public-ready) — when ruled, this is an EVM wallet we
 * control (FEE_WALLET_EVM class), never a user wallet.
 */
export const RANGO_REFERRER_ADDRESS = "";

/**
 * The destination asset of the Rango lane: SOL on Solana (native, address
 * null — verified live 2026-09-05: SOLANA.SOL quotes return OK routes).
 * From SOL the journey continues into X1 through the proven Warp bridge
 * (composeRoute — the same continuation the THORChain lane uses).
 */
export const RANGO_DESTINATION_SOL = Object.freeze({
  asset: "SOLANA.SOL",
  blockchain: "SOLANA",
  symbol: "SOL",
  address: null,
  decimals: 9,
});

/**
 * The Rango SOURCE assets this scaffold knows (the native-token forms whose
 * quotes we captured live). `asset` is the canonical Rango asset string the
 * API accepted in the REAL 2026-09-05 probes; native tokens normalize to
 * address null (the CHAIN.SYMBOL form — what the API + SDK use for natives;
 * tokens with addresses use the CHAIN--address form, e.g. TRON USDT:
 * "TRON--TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t").
 *
 * CARDANO (ADA) and POLKADOT (DOT) are deliberately ABSENT — Rango does not
 * serve them today (verified live). Re-add ONLY when /basic/meta lists them.
 */
export const RANGO_SOURCES = Object.freeze({
  sui: Object.freeze({
    chain: "sui",
    asset: "SUI.SUI",
    blockchain: "SUI",
    symbol: "SUI",
    address: null,
    decimals: 9,
  }),
  xrpl: Object.freeze({
    chain: "xrpl",
    asset: "XRPL.XRP",
    blockchain: "XRPL",
    symbol: "XRP",
    address: null,
    decimals: 6,
  }),
  btc: Object.freeze({
    chain: "btc",
    asset: "BTC.BTC",
    blockchain: "BTC",
    symbol: "BTC",
    address: null,
    decimals: 8,
  }),
  tron: Object.freeze({
    chain: "tron",
    asset: "TRON.TRX",
    blockchain: "TRON",
    symbol: "TRX",
    address: null,
    decimals: 6,
  }),
});
