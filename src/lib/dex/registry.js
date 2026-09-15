/**
 * src/lib/dex/registry.js — per-chain DEX venue registry (the MEV surface).
 *
 * The MEV engine's price-gap capture needs MULTIPLE venues per chain: more venues
 * = more spread to capture across pools and pool versions (v2 / v3 / v4). This
 * registry is the single source of truth for which DEXes the engine considers
 * on each chain.
 *
 * VERIFICATION RULE (owner, non-negotiable): never guess an address. Every
 * `router`/`factory` here is either (a) a canonical mainnet address, or (b)
 * copied from the V2 chain-test log (`.sandbox/chain-test-log.md`) where it was
 * verified live. Anything not yet verified is `router: null` + `verified: false`
 * — and the engine FAILS CLOSED on an unverified venue (it is not routed until
 * an address is confirmed).
 */

/** A single DEX venue on a chain. */
export const VENUE = {
  /** stable venue id */
  id: null,
  /** human name */
  name: null,
  /** "evm" | "svm" | "move" | "tvm" | "cardano" */
  family: null,
  /** protocol: "uni-v2" | "uni-v3" | "uni-v4" | "curve" | "balancer" | "joe" | "ve33" | "clmm" | "amm" */
  protocol: null,
  /** canonical swap router / program id (null = unverified — fail closed) */
  router: null,
  /** canonical factory (null = unverified) */
  factory: null,
  /** where the address was verified ("" = unverified) */
  source: "",
  verified: false,
};

/**
 * Per-chain venue lists. Ordered by expected MEV significance. An entry with
 * `verified: false` is a placeholder — the engine skips it until verified.
 */
export const DEX_REGISTRY = Object.freeze({
  eth: Object.freeze([
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", factory: null, source: "canonical", verified: true }),
    Object.freeze({ id: "uni-v2", name: "Uniswap V2", family: "evm", protocol: "uni-v2", router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", source: "canonical", verified: true }),
    Object.freeze({ id: "uni-v4", name: "Uniswap V4", family: "evm", protocol: "uni-v4", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "curve", name: "Curve", family: "evm", protocol: "curve", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "balancer", name: "Balancer V2", family: "evm", protocol: "balancer", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", factory: null, source: "canonical", verified: true }),
    Object.freeze({ id: "sushi", name: "SushiSwap", family: "evm", protocol: "uni-v2", router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", factory: null, source: "canonical", verified: true }),
  ]),
  bsc: Object.freeze([
    Object.freeze({ id: "pcs-v2", name: "PancakeSwap V2", family: "evm", protocol: "uni-v2", router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", source: "canonical", verified: true }),
    Object.freeze({ id: "thena", name: "Thena", family: "evm", protocol: "ve33", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "biswap", name: "Biswap", family: "evm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
  ]),
  bas: Object.freeze([
    Object.freeze({ id: "aerodrome", name: "Aerodrome", family: "evm", protocol: "ve33", router: null, factory: null, source: "chain-test-log (canonical uni not deployed — aerodrome pools live)", verified: false }),
    Object.freeze({ id: "baseswap", name: "BaseSwap", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
  ]),
  arb: Object.freeze([
    Object.freeze({ id: "camelot", name: "Camelot", family: "evm", protocol: "uni-v3", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3-arb", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: null, factory: null, source: "", verified: false }),
  ]),
  opt: Object.freeze([
    Object.freeze({ id: "velodrome", name: "Velodrome", family: "evm", protocol: "ve33", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3-opt", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: null, factory: null, source: "", verified: false }),
  ]),
  avax: Object.freeze([
    Object.freeze({ id: "traderjoe", name: "Trader Joe", family: "evm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "pangolin", name: "Pangolin", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
  ]),
  pol: Object.freeze([
    Object.freeze({ id: "quickswap", name: "QuickSwap", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
  ]),
  sol: Object.freeze([
    Object.freeze({ id: "jupiter", name: "Jupiter (aggregator)", family: "svm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "raydium", name: "Raydium", family: "svm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "orca", name: "Orca", family: "svm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "meteora", name: "Meteora", family: "svm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
  ]),
  sui: Object.freeze([
    Object.freeze({ id: "cetus", name: "Cetus", family: "move", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "turbos", name: "Turbos", family: "move", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "deepbook", name: "DeepBook", family: "move", protocol: "clob", router: null, factory: null, source: "", verified: false }),
  ]),
  tron: Object.freeze([
    Object.freeze({ id: "sunswap", name: "SunSwap", family: "tvm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
  ]),
  cardano: Object.freeze([
    Object.freeze({ id: "minswap", name: "Minswap", family: "cardano", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "sundaeswap", name: "SundaeSwap", family: "cardano", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "wingriders", name: "WingRiders", family: "cardano", protocol: "amm", router: null, factory: null, source: "", verified: false }),
  ]),
  pulsechain: Object.freeze([
    Object.freeze({ id: "pulsex", name: "PulseX", family: "evm", protocol: "uni-v2", router: null, factory: "0x1715a3E4A142d8b698131108995174F37aEBA10D", source: "chain-test-log (factory only — router pending)", verified: false }),
    Object.freeze({ id: "phiat", name: "Phiat", family: "evm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
  ]),
  rbn: Object.freeze([
    Object.freeze({ id: "rh-fork", name: "Robinhood fork-router", family: "evm", protocol: "uni-v3", router: null, factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", source: "chain-test-log (factory only — quoter+router pending)", verified: false }),
  ]),
});

/**
 * The verified venues for a chain (unverified placeholders are dropped — fail
 * closed). Returns [] for an unknown chain.
 */
export function venuesFor(chainKey) {
  const list = DEX_REGISTRY[chainKey];
  if (!list) return [];
  return list.filter((v) => v.verified && v.router !== null);
}

/** True when a chain has at least one verified, routable venue. */
export function hasVenues(chainKey) {
  return venuesFor(chainKey).length > 0;
}
