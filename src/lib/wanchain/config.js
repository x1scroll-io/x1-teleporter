/**
 * config.js — Wanchain-family lane CONFIG VALUES (the XFlows v3 rail —
 * Wanchain's only public quote+buildTx HTTP API).
 *
 * VERIFIED LIVE 2026-09-05 (this scaffold's research pass — NOT guessed; the
 * full evidence chain is test/fixtures/golden/wanchain-leg/VERIFICATION-
 * 2026-09-05.json + the captured fixture bodies):
 *   - Quote endpoint: POST https://xflows.wanchain.org/api/v3/quote — JSON
 *     body {fromChainId, toChainId, fromTokenAddress, toTokenAddress,
 *     fromAddress, toAddress, fromAmount, slippage?, bridge?}; keyless today
 *     (no API key required; a server-side WANCHAIN_API_URL override is
 *     supported in the proxy in case that ever changes).
 *   - supported/chains (live): 25 chains incl. Cardano(ADA), Sui, Bitcoin,
 *     Solana, TRON rows — but the quote ROUTER serves NONE of the non-EVM
 *     rows today (every live probe failed: ADA→SOL, ADA→WAN, BTC→SOL,
 *     TRX→SOL, and even the EVM control USDC(ETH)→SOL — "no token pair for
 *     SOL"). Quotable coverage today = EVM-chain pairs only.
 *   - The Wanchain docs' supported-chains MATRIX (Cardano/Sui/Polkadot/
 *     Solana/Tron/UTXOs under "WanBridge") describes the bridge.wanchain.org
 *     PORTAL product (storeman bridge-node group) — its pair registry + fees
 *     are on-chain iWan JSON-RPC calls, NOT a public REST quote API. Polkadot
 *     has no row in any Wanchain-family API at all.
 *   - Execution shape: POST /api/v3/buildTx returns ready-to-sign tx data
 *     (the user's wallet signs — family "external", same as the Rango lane).
 *     Status: POST /api/v3/status.
 *
 * COVERAGE GATE (fail-closed honesty): WANCHAIN_SOURCES only contains the
 * source chains the live API ACTUALLY quotes (the EVM class, keyed by
 * chainId). Cardano/Sui/BTC/SOL/TRON-native rows are NOT here — they are
 * registry-only today (see VERIFICATION-2026-09-05.json). If Wanchain ships
 * a public API for the storeman routes (or the XFlows router starts serving
 * them), RE-VERIFY with a live probe FIRST, then add the row here + update
 * the coverage matrix in teleportRail.js + docs/ROUTING-ENGINE.md together.
 *
 * FEE-CLASS BOUNDARY (Mr. Esters owns this — same discipline as the Rango +
 * THORChain config placeholders): XFlows charges its own network/token fees
 * (returned per quote). Teleporter fee-model v2 = 0.5% capped $250 once per
 * journey. On a SOL-landing continuation the fee is the Warp-leg skim —
 * there is NO referrer/affiliate mechanism on the XFlows API, so nothing to
 * leave empty here; if XFlows ever adds one, the same ruling applies (leave
 * EMPTY until Mr. Esters rules the fee class — never invent a fee).
 *
 * PURE MODULE: constants only — no DOM, no fetch, no wallet, no env reads.
 * Runnable under `node --test`.
 */

/**
 * The XFlows v3 API paths (the Wanchain-family quote + build + status
 * family). The quote + buildTx calls are POSTs with JSON bodies; our
 * serverless proxy (api/wanchain/quote.js) forwards the whitelisted body
 * fields only.
 */
export const WANCHAIN_QUOTE_PATH = "/api/v3/quote";
export const WANCHAIN_BUILDTX_PATH = "/api/v3/buildTx";
export const WANCHAIN_STATUS_PATH = "/api/v3/status";

/**
 * OUR serverless proxy paths (the client only ever talks to our own
 * same-origin /api/* functions). api/wanchain/quote.js exists in this
 * scaffold; api/wanchain/buildTx.js is a documented future lane (the
 * execute leg pins the request SHAPE against this path; the proxy route
 * itself lands with the live test).
 */
export const WANCHAIN_QUOTE_PROXY_PATH = "/api/wanchain/quote";
export const WANCHAIN_BUILDTX_PROXY_PATH = "/api/wanchain/buildTx";

/** Default slippage for the Wanchain-family quote/buildTx when the caller
 *  doesn't supply one (the docs' example uses 0.01 = 1%; mirrored here so
 *  the canonical request is explicit). */
export const WANCHAIN_DEFAULT_SLIPPAGE = 0.01;

/**
 * The native-token sentinel address every XFlows chain registry uses for
 * its native coin (verified live: ADA native, BTC native, TRX native, SOL
 * native all list 0x0000…0000). */
export const WANCHAIN_NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The Wanchain-family SOURCE chains this scaffold may quote (the fail-closed
 * coverage gate). Each row: canonical chainId (XFlows registry id), name,
 * the source asset the app cares about, decimals. TODAY this is the EVM
 * class only — the ONLY routes the live quote router actually serves (every
 * non-EVM probe failed; see the module header + VERIFICATION-2026-09-05).
 *
 * The app's console sources do NOT include a chain that needs this rail yet
 * (EVM stables ride the LiFi/Warp rail and land X1; XFlows EVM routes land
 * EVM/Wanchain-L1). The registry + legs exist so the lane is a wiring
 * exercise the moment a route the app needs becomes quotable — nothing is
 * invented, nothing is claimed.
 *
 * RE-ADDING A NON-EVM SOURCE (Cardano ADA etc.) IS FORBIDDEN until a live
 * probe of that exact route returns success — the fixture bodies in
 * test/fixtures/golden/wanchain-leg/*.failed.json are the current truth.
 */
export const WANCHAIN_SOURCES = Object.freeze({
  // eth: the canonical EVM-source representative (chainId 1). The EVM class
  // is chain-id-keyed; more EVM rows (arb/base/…) can be added from the
  // supported/chains capture when a consumer needs them.
  eth: Object.freeze({
    chain: "eth",
    chainId: 1,
    name: "Ethereum",
    asset: "ETH",
    decimals: 18,
    apiQuotable: true,
  }),
});

/** The Wanchain-family source keys, in registry order. */
export const WANCHAIN_SOURCE_KEYS = Object.freeze(Object.keys(WANCHAIN_SOURCES));

/** True when a source key is quotable through the Wanchain-family API. */
export function isWanchainQuotableSource(source) {
  return Object.prototype.hasOwnProperty.call(WANCHAIN_SOURCES, source);
}

/**
 * The destination the Wanchain lane would land (used by the leg builders to
 * shape the request). NOTE: the app's journeys land on SOL (then Warp into
 * X1) — and the live API has NO SOL pairs today (verified). This record
 * exists for the future moment a SOL route becomes quotable (or Mr. Esters
 * rules a Wanchain-L1 intermediate) — keep it in sync with the coverage
 * matrix when that happens.
 */
export const WANCHAIN_DESTINATION = Object.freeze({
  chain: "sol",
  chainId: 501,
  name: "Solana",
  asset: "SOL",
  tokenAddress: WANCHAIN_NATIVE_ADDRESS,
  decimals: 9,
  apiQuotable: false, // VERIFIED 2026-09-05: no quotable pairs to SOL
});
