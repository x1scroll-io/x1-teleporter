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
 *
 * 2026-09-17 verification pass — addresses below were filled only from
 * authoritative sources, each cross-checked on-chain via `eth_getCode`:
 *   - Uniswap deployments feed          https://developers.uniswap.org/deployments.json
 *   - Uniswap universal-router addrs    https://github.com/Uniswap/universal-router/tree/main/deploy-addresses
 *   - SushiSwap SDK constants           https://github.com/sushiswap/sdk (packages/core-sdk/src/constants/addresses.ts)
 *   - PancakeSwap V3 deployments        https://github.com/pancakeswap/pancake-v3-contracts/tree/master/deployments
 *   - Balancer deployments              https://github.com/balancer/balancer-deployments/tree/master/addresses
 *
 * 2026-09-17 round-2 pass — Solana/Sui/Tron/Cardano + non-Uniswap EVM
 * natives, each confirmed from the protocol's own docs / deployment repo /
 * SDK config (no guesses):
 *   - Raydium program addresses          https://docs.raydium.io/reference/program-addresses
 *   - Orca whirlpools program            https://docs.orca.so
 *   - Meteora DLMM program               https://docs.meteora.ag
 *   - Cetus CLMM package                 github.com/CetusProtocol/cetus-clmm-sui-sdk (src/config/mainnet.ts)
 *   - Turbos package                     Turbos SDK contract.json (app.turbos.finance)
 *   - DeepBook v3 package                github.com/MystenLabs/deepbookv3 (packages/deepbook/Published.toml)
 *   - SunSwap V2 router/factory          github.com/sun-protocol/transactionAnalysis (+ tronscan tags)
 *   - Aerodrome router/factory           github.com/aerodrome-finance/contracts (DeployCore-Base.json)
 *   - Velodrome router/factory           github.com/velodrome-finance/contracts (deployment-addresses/optimism.json)
 *   - Camelot V3 router/factory          docs.camelot.exchange/contracts/arbitrum/one-mainnet
 *   - Trader Joe router/factory          github.com/lfj-gg/joe-sdk (src/constants.ts)
 *   - Pangolin router/factory            github.com/pangolindex/sdk (src/chains.ts)
 *   - QuickSwap router/factory           github.com/QuickSwap/QuickSwap-sdk (protocol-core/src/chains/polygon.ts)
 * Venues that could not be verified from an authoritative source stay
 * `router: null, verified: false` (fail-closed) on purpose.
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
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", source: "canonical (Uniswap V3 SwapRouter + V3 factory — verified via Uniswap deployments feed)", verified: true }),
    Object.freeze({ id: "uni-v2", name: "Uniswap V2", family: "evm", protocol: "uni-v2", router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", source: "canonical", verified: true }),
    Object.freeze({ id: "uni-v4", name: "Uniswap V4", family: "evm", protocol: "uni-v4", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "curve", name: "Curve", family: "evm", protocol: "curve", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "balancer", name: "Balancer V2", family: "evm", protocol: "balancer", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", factory: null, source: "canonical", verified: true }),
    Object.freeze({ id: "sushi", name: "SushiSwap", family: "evm", protocol: "uni-v2", router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac", source: "canonical (SushiSwap Router + V2 factory — verified via sushiswap/sdk constants)", verified: true }),
  ]),
  bsc: Object.freeze([
    Object.freeze({ id: "pcs-v2", name: "PancakeSwap V2", family: "evm", protocol: "uni-v2", router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", source: "canonical", verified: true }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2", factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
    Object.freeze({ id: "pcs-v3", name: "PancakeSwap V3", family: "evm", protocol: "uni-v3", router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", source: "canonical (PancakeV3 SwapRouter + factory — verified via pancake-v3-contracts deployments)", verified: true }),
    Object.freeze({ id: "sushi", name: "SushiSwap", family: "evm", protocol: "uni-v2", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", source: "canonical (SushiSwap Router + V2 factory — verified via sushiswap/sdk constants)", verified: true }),
    Object.freeze({ id: "balancer", name: "Balancer V2", family: "evm", protocol: "balancer", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", factory: null, source: "canonical (Balancer V2 Vault — verified via balancer-deployments)", verified: true }),
    Object.freeze({ id: "thena", name: "Thena", family: "evm", protocol: "ve33", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "biswap", name: "Biswap", family: "evm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
  ]),
  bas: Object.freeze([
    Object.freeze({ id: "aerodrome", name: "Aerodrome", family: "evm", protocol: "ve33", router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", source: "canonical (Aerodrome Router + PoolFactory — verified via aerodrome-finance/contracts DeployCore-Base.json)", verified: true }),
    Object.freeze({ id: "baseswap", name: "BaseSwap", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0x2626664c2603336E57B271c5C0b26F421741e481", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
    Object.freeze({ id: "balancer", name: "Balancer V2", family: "evm", protocol: "balancer", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", factory: null, source: "canonical (Balancer V2 Vault — verified via balancer-deployments)", verified: true }),
  ]),
  arb: Object.freeze([
    Object.freeze({ id: "camelot", name: "Camelot", family: "evm", protocol: "uni-v3", router: "0x1F721E2E82F6676FCE4eA07A5958cF098D339e18", factory: "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B", source: "canonical (Camelot V3 SwapRouter + AlgebraFactory — verified via docs.camelot.exchange/contracts/arbitrum/one-mainnet)", verified: true }),
    Object.freeze({ id: "uni-v3-arb", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", source: "canonical (Uniswap V3 SwapRouter + V3 factory — deterministic cross-chain deployment)", verified: true }),
    Object.freeze({ id: "sushi", name: "SushiSwap", family: "evm", protocol: "uni-v2", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", source: "canonical (SushiSwap Router + V2 factory — verified via sushiswap/sdk constants)", verified: true }),
    Object.freeze({ id: "balancer", name: "Balancer V2", family: "evm", protocol: "balancer", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", factory: null, source: "canonical (Balancer V2 Vault — verified via balancer-deployments)", verified: true }),
  ]),
  opt: Object.freeze([
    Object.freeze({ id: "velodrome", name: "Velodrome", family: "evm", protocol: "ve33", router: "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858", factory: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a", source: "canonical (Velodrome Router + PoolFactory — verified via velodrome-finance/contracts deployment-addresses/optimism.json)", verified: true }),
    Object.freeze({ id: "uni-v3-opt", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", source: "canonical (Uniswap V3 SwapRouter + V3 factory — deterministic cross-chain deployment)", verified: true }),
    Object.freeze({ id: "balancer", name: "Balancer V2", family: "evm", protocol: "balancer", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", factory: null, source: "canonical (Balancer V2 Vault — verified via balancer-deployments)", verified: true }),
  ]),
  avax: Object.freeze([
    Object.freeze({ id: "traderjoe", name: "Trader Joe", family: "evm", protocol: "lb", router: "0x60aE616a2155Ee3d9A68541Ba4544862310933d4", factory: "0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10", source: "canonical (Trader Joe V2.1 Router + Factory — verified via lfj-gg/joe-sdk constants)", verified: true }),
    Object.freeze({ id: "pangolin", name: "Pangolin", family: "evm", protocol: "uni-v2", router: "0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106", factory: "0xefa94DE7a4656D787667C749f7E1223D71E9FD88", source: "canonical (Pangolin Router + Factory — verified via pangolindex/sdk src/chains.ts)", verified: true }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE", factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
    Object.freeze({ id: "sushi", name: "SushiSwap", family: "evm", protocol: "uni-v2", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", source: "canonical (SushiSwap Router + V2 factory — verified via sushiswap/sdk constants)", verified: true }),
    Object.freeze({ id: "balancer", name: "Balancer V2", family: "evm", protocol: "balancer", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", factory: null, source: "canonical (Balancer V2 Vault — verified via balancer-deployments)", verified: true }),
  ]),
  pol: Object.freeze([
    Object.freeze({ id: "quickswap", name: "QuickSwap", family: "evm", protocol: "uni-v2", router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", source: "canonical (QuickSwap V2 Router + Factory — verified via QuickSwap-sdk protocol-core/src/chains/polygon.ts)", verified: true }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", source: "canonical (Uniswap V3 SwapRouter + V3 factory — deterministic cross-chain deployment)", verified: true }),
    Object.freeze({ id: "curve", name: "Curve", family: "evm", protocol: "curve", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "balancer", name: "Balancer V2", family: "evm", protocol: "balancer", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", factory: null, source: "canonical (Balancer V2 Vault — verified via balancer-deployments)", verified: true }),
    Object.freeze({ id: "sushi", name: "SushiSwap", family: "evm", protocol: "uni-v2", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", source: "canonical (SushiSwap Router + V2 factory — verified via sushiswap/sdk constants)", verified: true }),
  ]),
  sol: Object.freeze([
    Object.freeze({ id: "jupiter", name: "Jupiter (aggregator)", family: "svm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "raydium", name: "Raydium", family: "svm", protocol: "clmm", router: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", factory: null, source: "canonical (Raydium CLMM program — verified via docs.raydium.io/reference/program-addresses)", verified: true }),
    Object.freeze({ id: "raydium-amm", name: "Raydium AMM", family: "svm", protocol: "cpmm", router: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", factory: null, source: "canonical (Raydium AMM V4 program — verified via docs.raydium.io/reference/program-addresses)", verified: true }),
    Object.freeze({ id: "orca", name: "Orca", family: "svm", protocol: "clmm", router: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", factory: null, source: "canonical (Orca Whirlpools program — verified via docs.orca.so protocol constants)", verified: true }),
    Object.freeze({ id: "meteora", name: "Meteora", family: "svm", protocol: "clmm", router: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", factory: null, source: "canonical (Meteora DLMM program — verified via docs.meteora.ag DLMM library reference)", verified: true }),
  ]),
  sui: Object.freeze([
    Object.freeze({ id: "cetus", name: "Cetus", family: "move", protocol: "clmm", router: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb", factory: null, source: "canonical (Cetus CLMM package — verified via CetusProtocol/cetus-clmm-sui-sdk mainnet config)", verified: true }),
    Object.freeze({ id: "turbos", name: "Turbos", family: "move", protocol: "clmm", router: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1", factory: null, source: "canonical (Turbos package original-id — verified via Turbos SDK contract.json)", verified: true }),
    Object.freeze({ id: "deepbook", name: "DeepBook", family: "move", protocol: "clob", router: "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809", factory: null, source: "canonical (DeepBook v3 package original-id — verified via MystenLabs/deepbookv3 Published.toml)", verified: true }),
  ]),
  tron: Object.freeze([
    Object.freeze({ id: "sunswap", name: "SunSwap", family: "tvm", protocol: "amm", router: "TXF1xDbVGdxFGbovmmmXvBGu8ZiE3Lq4mR", factory: "TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY", source: "canonical (SunSwap V2 Router02 + Factory — verified via sun-protocol/transactionAnalysis contract doc, cross-checked on tronscan)", verified: true }),
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
    Object.freeze({ id: "rh-fork", name: "Robinhood fork-router", family: "evm", protocol: "uni-v3", router: "0xCaf681a66D020601342297493863E78C959E5cb2", factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", source: "canonical (Uniswap V3 SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  // --- expansion (2026-09-17): high-volume L1s/L2s, venues fail-closed until verified ---
  monad: Object.freeze([
    Object.freeze({ id: "curvance", name: "Curvance", family: "evm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "ambient", name: "Ambient", family: "evm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xfE31F71C1b106EAc32F1A19239c9a9a72ddfb900", factory: "0x204FAca1764B154221e35c0d20aBb3c525710498", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  sonic: Object.freeze([
    Object.freeze({ id: "shadow", name: "Shadow Exchange", family: "evm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "wagmi", name: "WAGMI", family: "evm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "spookyswap", name: "SpookySwap", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455", factory: "0xcb2436774C3e191c85056d248EF4260ce5f27A9D", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  sei: Object.freeze([
    Object.freeze({ id: "astroport", name: "Astroport", family: "cosmos", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "dragon", name: "Dragon Swap", family: "cosmos", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3 (Sei EVM)", family: "evm", protocol: "uni-v3", router: "0xdD489C75be1039ec7d843A6aC2Fd658350B067Cf", factory: "0x75FC67473A91335B5b8F8821277262a13B38c9b3", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  abstract: Object.freeze([
    Object.freeze({ id: "pancakeswap", name: "PancakeSwap", family: "evm", protocol: "uni-v3", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uniswap", name: "Uniswap", family: "evm", protocol: "uni-v3", router: null, factory: null, source: "", verified: false }),
  ]),
  unichain: Object.freeze([
    Object.freeze({ id: "uniswap", name: "Uniswap (native)", family: "evm", protocol: "uni-v3", router: "0x73855d06DE49d0fe4A9c42636Ba96c62da12FF9C", factory: "0x1F98400000000000000000000000000000000003", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  scroll: Object.freeze([
    Object.freeze({ id: "ambient", name: "Ambient", family: "evm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "syncswap", name: "SyncSwap", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0xfc30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636", factory: "0x70C62C8b8e801124A4Aa81ce07b637A3e83cb919", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  linea: Object.freeze([
    Object.freeze({ id: "syncswap", name: "SyncSwap", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "lynex", name: "Lynex", family: "evm", protocol: "ve33", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", factory: "0x31FAfd4889FA1269F7a13A66eE0fB458f27D72A9", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  zksync: Object.freeze([
    Object.freeze({ id: "syncswap", name: "SyncSwap", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "maverick", name: "Maverick", family: "evm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "pancakeswap", name: "PancakeSwap", family: "evm", protocol: "uni-v3", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A3", factory: "0x8FdA5a7a8dCA67BBcDd10F02Fa0649A937215422", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  mantle: Object.freeze([
    Object.freeze({ id: "agni", name: "Agni Finance", family: "evm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "merchant-moe", name: "Merchant Moe", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2", factory: "0x0d922Fb1Bc191F64970ac40376643808b4B74Df9", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  blast: Object.freeze([
    Object.freeze({ id: "thruster", name: "Thruster", family: "evm", protocol: "ve33", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "bladeswap", name: "BladeSwap", family: "evm", protocol: "uni-v2", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "uni", name: "Uniswap (Universal Router)", family: "evm", protocol: "uni-v3", router: "0x8B844f885672f333Bc0042cB669255f93a4C1E6b", factory: null, source: "canonical (Uniswap UniversalRouter V2.1.1 — verified via universal-router deploy-addresses)", verified: true }),
  ]),
  worldchain: Object.freeze([
    Object.freeze({ id: "uniswap", name: "Uniswap", family: "evm", protocol: "uni-v3", router: "0x091AD9e2e6e5eD44c1c66dB50e49A601F9f36cF6", factory: "0x7a5028BDa40e7B173C278C5342087826455ea25a", source: "canonical (SwapRouter02 + V3 factory — verified via Uniswap deployments feed)", verified: true }),
  ]),
  berachain: Object.freeze([
    Object.freeze({ id: "beraswap", name: "BeraSwap", family: "evm", protocol: "amm", router: null, factory: null, source: "", verified: false }),
    Object.freeze({ id: "kodiak", name: "Kodiak", family: "evm", protocol: "clmm", router: null, factory: null, source: "", verified: false }),
  ]),
  arc: Object.freeze([
    Object.freeze({ id: "uni-v3", name: "Uniswap V3", family: "evm", protocol: "uni-v3", router: "0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77", factory: "0xf0db7b58379503491d857dB50AC9ece64c653918", source: "canonical (Uniswap deployments.json — Arc mainnet 5042, live-verified)", verified: true }),
    Object.freeze({ id: "uni-v2", name: "Uniswap V2", family: "evm", protocol: "uni-v2", router: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", factory: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba", source: "canonical (Uniswap deployments.json — Arc mainnet 5042, live-verified)", verified: true }),
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
