/**
 * poolEngine.js — the GENERALIZED pool-discovery engine entry point.
 *
 * For any (token, chain): enumerate every pool instance (DEX × version ×
 * fee-tier) → price each → score the cross-version/cross-DEX gaps → emit
 * the DETECTION stream (gate OFF — this module never broadcasts; it feeds
 * the capture gate + Mr. Esters' arm).
 *
 * Pipeline: dexMap (the universal registry) → poolEnumerator (live pool
 * instances) → poolPricer (per-pool on-chain price) → gapDetector scoring
 * (rankQuotes / gapBpsBetween on the per-pool price set).
 *
 * 🔴 Gate discipline: this module is DETECTION ONLY. It returns gaps; it
 * does not build or fire swaps. The swap executor (phase 5) is a separate
 * module behind the capture gate.
 */
import { dexFamiliesForChain } from "./dexMap.js";
import { enumeratePoolsForToken } from "./poolEnumerator.js";
import { pricePoolInstance } from "./poolPricer.js";

/**
 * scanTokenPools — the one-call generalized scan.
 * @param {object} deps { prov, chain, token, base? (default: first quote base) }
 * @returns {Promise<object>} {
 *   chain, token, pools: [{chain,dexId,version,feeTier,pairAddress,priceBasePerToken}],
 *   priced: [{…pool, priceBasePerToken}], gaps: [{from, to, gapBps}],
 *   best: {pool, priceBasePerToken} | null, notes: string[]
 * }
 */
export async function scanTokenPools({ prov, chain, token, base = null }) {
  const { pools, notes } = await enumeratePoolsForToken({ prov, chain, token });
  const priced = [];
  for (const p of pools) {
    try {
      // price against the pool's ACTUAL quote base (carried from enumeration)
      const withBase = { ...p, token, base: p.quoteBase ?? base ?? null };
      const price = await pricePoolInstance(prov, withBase);
      priced.push({ ...p, base: withBase.base, priceBasePerToken: price.priceBasePerToken });
    } catch (e) {
      notes.push(`price failed ${p.dexId}@${String(p.pairAddress).slice(0, 10)}: ${String(e.message || e).slice(0, 50)}`);
    }
  }

  // gap scoring across pools that share a quote base (same base = comparable).
  const gaps = [];
  let best = null;
  const byBase = new Map();
  for (const p of priced) {
    if (!p.base) continue; // no quote base resolved → cannot compare (never guess)
    if (!byBase.has(p.base)) byBase.set(p.base, []);
    byBase.get(p.base).push(p);
  }
  for (const [b, group] of byBase) {
    if (group.length < 2) continue; // cross-version gap needs ≥2 pools on the SAME base
    group.sort((a, z) => z.priceBasePerToken - a.priceBasePerToken);
    const top = group[0];
    if (!best || top.priceBasePerToken > best.priceBasePerToken) best = { pool: top, priceBasePerToken: top.priceBasePerToken, base: b };
    for (const other of group.slice(1)) {
      const gapBps = ((top.priceBasePerToken - other.priceBasePerToken) / other.priceBasePerToken) * 10000;
      gaps.push({
        base: b,
        from: `${top.dexId}${top.feeTier ? "-" + top.feeTier : ""}@${String(top.pairAddress).slice(0, 10)}`,
        to: `${other.dexId}${other.feeTier ? "-" + other.feeTier : ""}@${String(other.pairAddress).slice(0, 10)}`,
        gapBps: Number(gapBps.toFixed(2)),
      });
    }
  }
  gaps.sort((a, z) => z.gapBps - a.gapBps);
  return { chain, token, pools, priced, gaps, best, notes };
}
