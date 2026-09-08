/**
 * dexMap.js — the GENERALIZED DEX map (the "own the swap layer" registry).
 *
 * Spec (Mr. Esters, 2026-09-08): GENERAL, not per-chain. For any (token,
 * chain): enumerate all pools (DEX × version × fee-tier) → price each →
 * route the best AND detect the gaps between them. Adding a chain = add to
 * this map, not a custom build.
 *
 * Pool identity is UNIVERSAL and by INSTANCE:
 *   { chain, dexId, version: "v2"|"v3"|"v4"|"clmm", feeTier: int|null,
 *     factory, pairAddress, token0, token1 }
 *
 * 🔴 ADDRESS DISCIPLINE (the RH impostor-stub lesson): NEVER assume the
 * canonical address is live on a chain. Every deployment row carries a
 * `verified` flag; `verifyDeployments()` re-checks code presence on-chain
 * (a real factory/router is >10KB; the RH "canonical" addresses were
 * identical 4220B stubs). A row with verified:false is probed before use.
 *
 * The map rows below carry the addresses this repo has LIVE-VERIFIED
 * (uniswapSwapLeg / pancakeswapSwapLeg fixtures + the RH Chain probe of
 * 2026-09-08). Unknown-per-chain entries stay address-less until probed —
 * the engine NEVER guesses an address.
 */
export const DEX_FAMILIES = Object.freeze({
  /** Uniswap v2 — universal factory (same CREATE2 address on every EVM
   *  chain it is deployed on). Router is the canonical Router02. */
  "uniswap-v2": Object.freeze({
    id: "uniswap-v2",
    name: "Uniswap v2",
    version: "v2",
    sdk: "uniswap-v2",
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    initCodeHash: "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
    feeTiers: null, // v2 has a single 0.3% fee baked in
    verifiedChains: Object.freeze(["eth"]), // canonical deployment confirmed live here
  }),

  /** Uniswap v3 — canonical factory/quoter/router. NOTE the RH lesson:
   *  these addresses are NOT live on every chain (RH had 4220B stubs). */
  "uniswap-v3": Object.freeze({
    id: "uniswap-v3",
    name: "Uniswap v3",
    version: "v3",
    sdk: "uniswap-v3",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    feeTiers: Object.freeze([100, 500, 3000, 10000]), // 0.01/0.05/0.3/1%
    verifiedChains: Object.freeze(["eth", "arb", "bas", "opt", "pol"]), // repo live-verified
  }),

  /** Uniswap v4 — singleton pool manager (one address per chain), pools are
   *  transient; the Universal Router executes. */
  "uniswap-v4": Object.freeze({
    id: "uniswap-v4",
    name: "Uniswap v4",
    version: "v4",
    sdk: "uniswap-v4",
    poolManager: null, // chain-specific — probe on first use (never assume)
    universalRouter: null, // chain-specific
    feeTiers: Object.freeze([100, 500, 3000, 10000]),
    verifiedChains: Object.freeze([]), // none verified in-repo yet — probe first
  }),

  /** PancakeSwap v3 (BNB Chain + Arbitrum) — its own fork deployment. */
  "pancakeswap-v3": Object.freeze({
    id: "pancakeswap-v3",
    name: "PancakeSwap v3",
    version: "v3",
    sdk: "pancakeswap-v3",
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    feeTiers: Object.freeze([100, 500, 2500, 10000]),
    verifiedChains: Object.freeze(["bsc"]), // repo live-verified (fixtures)
  }),

  /** Robinhood Chain's Uniswap-fork (Arbitrum-Orbit L2, chain 4663) — the
   *  instance that taught the stub lesson. Pools are STANDARD v3 mechanics
   *  behind RH's OWN factory (NOT the canonical addresses — those are
   *  stubs there). */
  "rh-uniswap-v3": Object.freeze({
    id: "rh-uniswap-v3",
    name: "Robinhood Chain Uniswap",
    version: "v3",
    sdk: "uniswap-v3",
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    quoter: null, // RH's fork quoter — NOT the canonical one (probe pools directly)
    router: null, // proprietary router 0xB19e4456… (custom entrypoint — aggregator rail for execution today)
    feeTiers: Object.freeze([100, 500, 3000, 10000]),
    verifiedChains: Object.freeze(["rh"]), // verified 2026-09-08 (pool probes)
  }),
});

/** Chain → which DEX families serve it. The "add a chain = add here" knob.
 *  Values are DEX_FAMILIES ids. Chains with no verified entry yet are NOT
 *  listed — the engine reports them honestly as unserved rather than guess.
 */
export const CHAIN_DEXES = Object.freeze({
  eth: Object.freeze(["uniswap-v2", "uniswap-v3"]),
  arb: Object.freeze(["uniswap-v3"]), // + camelot/ramses — probed, not yet mapped
  bas: Object.freeze(["uniswap-v3"]), // + aerodrome — probed, not yet mapped
  opt: Object.freeze(["uniswap-v3"]), // + velodrome — probed, not yet mapped
  pol: Object.freeze(["uniswap-v3"]),
  bsc: Object.freeze(["pancakeswap-v3"]), // + pancakeswap-v2 — to add
  rh: Object.freeze(["rh-uniswap-v3"]),
  sol: Object.freeze([]), // SVM: raydium/orca/meteora — clmm family (phase 2)
});

export const DEX_FAMILY_IDS = Object.freeze(Object.keys(DEX_FAMILIES));
export const CHAIN_DEX_KEYS = Object.freeze(Object.keys(CHAIN_DEXES));

/** resolveDexFamily — the map lookup (throws on unknown family). */
export function resolveDexFamily(dexId) {
  const f = DEX_FAMILIES[dexId];
  if (!f) throw new Error(`dexMap: unknown DEX family "${dexId}" (known: ${DEX_FAMILY_IDS.join(" | ")})`);
  return f;
}

/** dexFamiliesForChain — the families a chain serves (empty = unserved). */
export function dexFamiliesForChain(chain) {
  const ids = CHAIN_DEXES[chain] ?? [];
  return ids.map((id) => DEX_FAMILIES[id]);
}

/** MIN_CONTRACT_CODE_LEN — the floor for "this is a real contract, not a
 *  stub". RH's impostor "canonical" contracts were 4220B each; real
 *  v3 factories are 20KB+. 10KB is a conservative floor. */
export const MIN_CONTRACT_CODE_LEN = 10_000;

/**
 * verifyDeploymentOnChain — probe a deployment row's code presence on a
 * chain (the RH stub lesson, automated). A factory/router shorter than
 * MIN_CONTRACT_CODE_LEN is a stub/impostor → verified:false.
 * @param {object} prov ethers JsonRpcProvider for the chain
 * @param {object} row a DEX_FAMILIES entry
 * @returns {Promise<object>} { verified, codeLens: {factory?, quoter?, router?} }
 */
export async function verifyDeploymentOnChain(prov, row) {
  const codeLens = {};
  for (const key of ["factory", "quoter", "router", "poolManager", "universalRouter"]) {
    const addr = row[key];
    if (!addr) { codeLens[key] = null; continue; }
    try {
      const code = await prov.getCode(addr);
      codeLens[key] = code.length;
    } catch { codeLens[key] = 0; }
  }
  const checks = ["factory", "quoter", "router"].filter((k) => row[k]);
  const verified = checks.length > 0 && checks.every((k) => (codeLens[k] ?? 0) > MIN_CONTRACT_CODE_LEN);
  return { verified, codeLens };
}
