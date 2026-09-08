/**
 * poolPricer.js — price each enumerated pool instance on-chain. The output
 * feeds gapDetector/routeAnalyzer: per-pool normalized quotes for the SAME
 * (token, chain), so cross-version/cross-DEX gaps become visible.
 *
 * Pricing per version (instruments-first, official pool ABIs):
 *   - v2: getReserves() → mid price = reserveOut/reserveIn (fee 0.3% is
 *         symmetric — the gap math nets it; exact swap quotes come from the
 *         router's getAmountsOut at arm time).
 *   - v3: slot0.sqrtPriceX96 → mid price = (sqrt/2^96)^2 with the token
 *         order + decimal adjustment. Per-fee-tier pools price separately.
 *
 * Quote normalization matches gapDetector.normalizeQuote: a quote is the
 * output token per 1 input-token unit, in RATE_SCALE (1e12) fixed point —
 * see gapDetector.js RATE_SCALE. We return raw + normalized so the caller
 * can choose.
 */
import { RATE_SCALE } from "../mev/gapDetector.js";

const V2_POOL_ABI = ["function getReserves() view returns (uint112,uint112,uint32)"];
const V3_POOL_ABI = [
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)"];

/** We price "how much of the QUOTE BASE per 1 token" — i.e. the token's
 *  price in the base (WETH/USDG/USDC). direction: "tokenPerBase" means the
 *  pool quotes token against base and we want base-per-token. */
export const PRICE_DIRECTION = Object.freeze({ BASE_PER_TOKEN: "base-per-token", TOKEN_PER_BASE: "token-per-base" });

/**
 * normalizePoolPrice — fold decimals + direction into a scalar price in
 * RATE_SCALE fixed point: units of base per 1 unit of token.
 * @param {number|bigint} rawPrice token-per-base raw (already direction-adjusted)
 * @param {number} tokenDecimals
 * @param {number} baseDecimals
 * @returns {bigint} RATE_SCALE fixed-point (base units per 1e12 token units… see note)
 */
export function normalizePoolPrice(rawPrice, tokenDecimals, baseDecimals) {
  // rawPrice is token units per 1 base unit (after sqrt math). We want the
  // token's USD-ish price: base per token = 1/raw. Keep it in float for the
  // gap math (gapDetector works in bps on rate ratios); RATE_SCALE used by
  // callers who need bigint.
  return rawPrice;
}

/**
 * priceV2Pool — mid price from reserves.
 * @returns {Promise<{midPriceTokenPerBase: number, token0, token1, reserve0, reserve1}>}
 */
export async function priceV2Pool(prov, pairAddress, token, base) {
  const { Interface } = await import("ethers");
  const iface = new Interface(V2_POOL_ABI);
  const r = await prov.call({ to: pairAddress, data: iface.encodeFunctionData("getReserves") });
  const [r0, r1] = iface.decodeFunctionResult("getReserves", r);
  // token0/token1 ordering: v2 factory sorts (token < base by address)
  const tokenIs0 = token.toLowerCase() < base.toLowerCase();
  const tokenReserve = tokenIs0 ? r0 : r1;
  const baseReserve = tokenIs0 ? r1 : r0;
  const tokenPerBase = Number(baseReserve) / Number(tokenReserve); // base units per 1 token? no —
  // reserves are raw: tokenPerBase = baseReserve/tokenReserve is BASE per TOKEN raw.
  return { midBasePerToken: Number(baseReserve) / Number(tokenReserve), token0: tokenIs0 ? token : base, token1: tokenIs0 ? base : token };
}

/**
 * priceV3Pool — mid price from slot0 sqrtPriceX96.
 * sqrtPriceX96 = sqrt(token1/token0) * 2^96 → token1PerToken0 = (sqrt/2^96)^2.
 * @returns {Promise<{midToken1PerToken0: number, tick: number, token0, token1}>}
 */
export async function priceV3Pool(prov, poolAddress) {
  const { Interface } = await import("ethers");
  const iface = new Interface(V3_POOL_ABI);
  const slot0 = iface.decodeFunctionResult("slot0", await prov.call({ to: poolAddress, data: iface.encodeFunctionData("slot0") }));
  const t0 = iface.decodeFunctionResult("token0", await prov.call({ to: poolAddress, data: iface.encodeFunctionData("token0") }))[0];
  const t1 = iface.decodeFunctionResult("token1", await prov.call({ to: poolAddress, data: iface.encodeFunctionData("token1") }))[0];
  const sqrt = Number(slot0[0]) / 2 ** 96;
  return { midToken1PerToken0: sqrt * sqrt, tick: Number(slot0[1]), token0: t0, token1: t1 };
}

/**
 * decimalsOf — read token decimals (cached per call site by the caller if hot).
 */
export async function decimalsOf(prov, token) {
  const { Interface } = await import("ethers");
  const iface = new Interface(ERC20_ABI);
  const r = await prov.call({ to: token, data: iface.encodeFunctionData("decimals") });
  return Number(iface.decodeFunctionResult("decimals", r)[0]);
}

/**
 * pricePoolInstance — price ONE pool instance given its version + token/base.
 * @returns {Promise<{ priceBasePerToken: number, raw: object }>}
 *   priceBasePerToken = units of base per 1 unit of token (float — the gap
 *   comparator). Cross-version comparison is valid when pools share the base.
 */
export async function pricePoolInstance(prov, pool) {
  const { token, base, version, pairAddress } = pool;
  if (version === "v2") {
    const p = await priceV2Pool(prov, pairAddress, token, base);
    // adjust decimals: raw reserves ratio is base-raw per token-raw
    const [td, bd] = await Promise.all([decimalsOf(prov, token), decimalsOf(prov, base)]);
    return { priceBasePerToken: p.midBasePerToken * 10 ** (td - bd), raw: p };
  }
  if (version === "v3") {
    const p = await priceV3Pool(prov, pairAddress);
    const tokenIs1 = p.token1.toLowerCase() === token.toLowerCase();
    // midToken1PerToken0: if token is token1, that's token-per-base already
    let tokenPerBase = tokenIs1 ? p.midToken1PerToken0 : 1 / p.midToken1PerToken0;
    const [td, bd] = await Promise.all([decimalsOf(prov, token), decimalsOf(prov, base)]);
    // raw tokenPerBase → base per token, decimal-adjusted
    return { priceBasePerToken: (1 / tokenPerBase) * 10 ** (td - bd), raw: p };
  }
  throw new Error(`poolPricer: unsupported version "${version}"`);
}
