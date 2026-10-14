/**
 * poolEnumerator.js — enumerate EVERY live pool instance for a (token,
 * chain): DEX × version × fee-tier. The generalized discovery core.
 *
 * For a token on an EVM chain this walks each serving DEX family's factory:
 *   - v2:   factory.getPair(token, counterparties…) — v2 pools are
 *           token-pair contracts; we probe the common quote bases
 *           (WETH/native, the chain stable) plus the token's known pairs.
 *   - v3:   factory.getPool(token, quoteBase, feeTier) for every fee tier ×
 *           every quote base → one pool INSTANCE per (base, tier).
 *   - v4:   poolManager (singleton) — v4 pools are transient; enumeration
 *           uses the pools' on-chain records (phase 2b — probe-first).
 *
 * Output: pool instances keyed by UNIVERSAL pool identity:
 *   { chain, dexId, version, feeTier, pairAddress, token0, token1,
 *     quoteBase } — the identity gapDetector/routeAnalyzer score.
 *
 * 🔴 NEVER guess an address: a family whose factory is unverified on the
 * chain (RH-stub lesson) is skipped with an honest note, not probed blind.
 */
import { dexFamiliesForChain } from "./dexMap.js";

/** The quote bases to probe per chain (native/WETH + the chain stable).
 *  These are the counterparties memes pair against — the pools that matter
 *  for gap detection. Chain keys = repo canonical ids. */
export const QUOTE_BASES = Object.freeze({
  eth: Object.freeze(["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"]), // WETH, USDC
  arb: Object.freeze(["0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"]), // WETH, USDC
  bas: Object.freeze(["0x4200000000000000000000000000000000000006", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]), // WETH, USDC
  opt: Object.freeze(["0x4200000000000000000000000000000000000006", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"]), // WETH, USDC
  pol: Object.freeze(["0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"]), // WMATIC, USDC
  bsc: Object.freeze(["0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "0x55d398326f99059fF775485246999027B3197955"]), // WBNB, USDT
  rh: Object.freeze(["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"]), // WETH, USDG
});

/** quoteBasesForChain — the counterparty tokens to probe for pools. */
export function quoteBasesForChain(chain) {
  return QUOTE_BASES[chain] ?? [];
}

const V2_ABI = ["function getPair(address,address) view returns (address)"];
const V3_ABI = ["function getPool(address,address,uint24) view returns (address)"];

/**
 * enumerateV2Pools — probe a v2 factory for token×quoteBase pairs.
 * @param {object} prov ethers provider
 * @param {string} factory v2 factory address
 * @param {string} token the meme/token address
 * @param {string[]} bases quote base addresses
 * @param {object} iface prepared ethers Interface for getPair
 * @returns {Promise<Array>} pool instances [{pairAddress, token0, token1}]
 */
export async function enumerateV2Pools(prov, factory, token, bases, iface) {
  const out = [];
  for (const base of bases) {
    try {
      const r = await prov.call({ to: factory, data: iface.encodeFunctionData("getPair", [token, base]) });
      const pair = iface.decodeFunctionResult("getPair", r)[0];
      if (pair && pair !== "0x0000000000000000000000000000000000000000") {
        out.push({ pairAddress: pair, token0: token < base ? token : base, token1: token < base ? base : token, quoteBase: base });
      }
    } catch { /* node flake — skip this base */ }
  }
  return out;
}

/**
 * enumerateV3Pools — probe a v3 factory for token×base×everyFeeTier.
 * @returns {Promise<Array>} [{pairAddress, feeTier}]
 */
export async function enumerateV3Pools(prov, factory, token, bases, feeTiers, iface) {
  const out = [];
  for (const base of bases) {
    for (const fee of feeTiers) {
      try {
        const r = await prov.call({ to: factory, data: iface.encodeFunctionData("getPool", [token, base, fee]) });
        const pool = iface.decodeFunctionResult("getPool", r)[0];
        if (pool && pool !== "0x0000000000000000000000000000000000000000") {
          out.push({ pairAddress: pool, feeTier: fee, quoteBase: base });
        }
      } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * enumeratePoolsForToken — THE generalized enumerator. For (token, chain)
 * returns every live pool instance across the chain's serving DEX families.
 * @param {object} deps { prov, chain, token, families? (override) }
 * @returns {Promise<{ pools: Array, notes: string[] }>}
 *   pool: { chain, dexId, version, feeTier, pairAddress, quoteBase }
 */
export async function enumeratePoolsForToken({ prov, chain, token, families = null }) {
  const serving = families ?? dexFamiliesForChain(chain);
  const pools = [];
  const notes = [];
  const bases = quoteBasesForChain(chain);

  for (const fam of serving) {
    // RH-stub discipline: only probe families with a factory address.
    if (!fam.factory) {
      notes.push(`${fam.id}: no factory address mapped for ${chain} — skipped (never guess)`);
      continue;
    }
    try {
      if (fam.version === "v2") {
        const iface = new (await import("ethers")).Interface(V2_ABI);
        const found = await enumerateV2Pools(prov, fam.factory, token, bases, iface);
        for (const p of found) {
          pools.push({ chain, dexId: fam.id, version: "v2", feeTier: null, pairAddress: p.pairAddress, quoteBase: p.quoteBase ?? null });
        }
        notes.push(`${fam.id}: ${found.length} v2 pool(s)`);
      } else if (fam.version === "v3") {
        const iface = new (await import("ethers")).Interface(V3_ABI);
        const found = await enumerateV3Pools(prov, fam.factory, token, bases, fam.feeTiers ?? [], iface);
        for (const p of found) {
          pools.push({ chain, dexId: fam.id, version: "v3", feeTier: p.feeTier, pairAddress: p.pairAddress, quoteBase: p.quoteBase ?? null });
        }
        notes.push(`${fam.id}: ${found.length} v3 pool(s) across ${(fam.feeTiers ?? []).length} fee tiers`);
      } else {
        notes.push(`${fam.id}: version ${fam.version} enumeration not yet implemented — phase 2b`);
      }
    } catch (e) {
      notes.push(`${fam.id}: probe failed — ${String(e.message || e).slice(0, 60)}`);
    }
  }
  return { pools, notes };
}
