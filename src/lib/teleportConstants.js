/**
 * teleportConstants.js — chain/token/route constants for the v2 Teleport tab
 * (Phase 3 bridge form).
 *
 * Verbatim mirror of the CHAINS/TOKENS constants inside Teleporter.jsx (v1),
 * minus the TRON gating (ENABLE_TRON=false today, so v1's runtime object has
 * no tron entry either). Teleporter.jsx is the flag-restorable v1 safety net
 * and is deliberately NOT imported here — this module is the v2 card's copy.
 * KEEP IN SYNC with Teleporter.jsx: a later step can make Teleporter.jsx
 * import from here with zero behavior change.
 *
 * PHASE 3 SCOPE — EVM → X1 (the hop's route): the from-chain picker lists
 * EVM_CHAINS only, the destination is fixed to X1, and the reverse/onward
 * paths stay out (flag-gated; step 1.2 removed the reverse relay). sol + x1
 * stay in CHAINS/TOKENS because the EVM→X1 hop's LiFi leg lands USDC on
 * Solana (toChain=SOL, toToken=Solana USDC) before the Warp hop into X1.
 */

export const CHAINS = {
  x1:    { id: "x1",    name: "X1",          lifiKey: null,  chainId: null,  walletType: "solana", color: "#5B9DFF", glyph: "X1" },
  eth:   { id: "eth",   name: "Ethereum",    lifiKey: "eth", chainId: 1,     walletType: "evm",    color: "#627EEA", glyph: "Ξ" },
  bsc:   { id: "bsc",   name: "BNB Chain",   lifiKey: "bsc", chainId: 56,    walletType: "evm",    color: "#F0B90B", glyph: "B" },
  sol:   { id: "sol",   name: "Solana",      lifiKey: "SOL", chainId: "SOL", walletType: "solana", color: "#9945FF", glyph: "◎" },
  arb:   { id: "arb",   name: "Arbitrum",    lifiKey: "arb", chainId: 42161, walletType: "evm",    color: "#28A0F0", glyph: "A" },
  bas:   { id: "bas",   name: "Base",        lifiKey: "bas", chainId: 8453,  walletType: "evm",    color: "#0052FF", glyph: "□" },
  opt:   { id: "opt",   name: "Optimism",    lifiKey: "opt", chainId: 10,    walletType: "evm",    color: "#FF0420", glyph: "O" },
  pol:   { id: "pol",   name: "Polygon",     lifiKey: "pol", chainId: 137,   walletType: "evm",    color: "#8247E5", glyph: "⬡" },
  avax:  { id: "avax",  name: "Avalanche",   lifiKey: "ava", chainId: 43114, walletType: "evm",    color: "#E84142", glyph: "▲" },
  sonic: { id: "sonic", name: "Sonic",       lifiKey: "son", chainId: 146,   walletType: "evm",    color: "#5BC8F5", glyph: "S" },
};

export const TOKENS = {
  eth:   { USDC: { decimals: 6, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, USDT: { decimals: 6, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }, DAI: { decimals: 18, address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" } },
  bsc:   { USDC: { decimals: 18, address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" }, USDT: { decimals: 18, address: "0x55d398326f99059fF775485246999027B3197955" }, DAI: { decimals: 18, address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" } },
  sol:   { USDC: { decimals: 6, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, USDT: { decimals: 6, address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }, WSOL: { decimals: 9, address: "So11111111111111111111111111111111111111112" } }, // WSOL = native wrapped SOL (So111...), 9 decimals
  arb:   { USDC: { decimals: 6, address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" }, USDT: { decimals: 6, address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" }, DAI: { decimals: 18, address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" } },
  bas:   { USDC: { decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, DAI: { decimals: 18, address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" } },
  opt:   { USDC: { decimals: 6, address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" }, USDT: { decimals: 6, address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" }, DAI: { decimals: 18, address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" } },
  pol:   { USDC: { decimals: 6, address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" }, USDT: { decimals: 6, address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" }, DAI: { decimals: 18, address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" } },
  avax:  { USDC: { decimals: 6, address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" }, USDT: { decimals: 6, address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7" }, DAI: { decimals: 18, address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70" } },
  sonic: { USDC: { decimals: 6, address: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894" }, USDT: { decimals: 6, address: "0xE5DA20F15420aD15DE0fa650600aFc998bbE3955" } },
  x1:    { "USDC.x": { decimals: 6, address: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq" }, "wSOL.X": { decimals: 9, address: "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8" } }, // X1 USDC.x + wSOL.X (both Token-2022 wrapped mints)
};

/**
 * The from-chain picker options (Phase 3 scope: EVM → X1 only — the hop's
 * route). Solana-source (sol_x1) and X1-source (x1_reverse / x1_onward)
 * routes are flag-gated / removed (step 1.2) and stay OUT of this port.
 */
export const EVM_CHAINS = Object.freeze(["eth", "bsc", "arb", "bas", "opt", "pol", "avax", "sonic"]);

// Minimum into X1 (v1 mirror): 25. The post-1%-skim amount must clear Warp's
// $10 floor with buffer for LiFi slippage; the flat $1 bridge fee would be
// ~11% of the journey at $10 and ~5% at $25, so $25 is the floor.
export const X1_MIN = 25;

// Minimum OUT of X1 (v1 mirror: X1_REVERSE_MIN). Same reasoning reversed —
// the 1% skim + Warp's $1 must leave a meaningful net for the Solana→EVM leg.
export const X1_REVERSE_MIN = 25;

// Warp rejects bridges below this (USDC).
export const WARP_MIN = 10;

// Official Warp Bridge — the handoff destination when the hop can't be
// finished in-app (no Solana wallet connected / user chooses to finish there).
export const WARP_BRIDGE_URL = "https://app.bridge.x1.xyz/";

// Solana RPC for the Warp leg (stage 2). Env-overridable like v1; the public
// endpoint rate-limits account reads, so VITE_SOLANA_RPC should point at a
// real node/provider in production.
export const SOLANA_RPC =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_SOLANA_RPC) ||
  "https://berty-633y20-fast-mainnet.helius-rpc.com";

// X1 mainnet RPC — reads/sim for the X1 side. The wallet broadcasts via its
// own RPC; this is for our reads.
export const X1_RPC =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_X1_RPC) ||
  "https://rpc.mainnet.x1.xyz";

/** Token symbols available on a chain (mirrors v1's tokensFor helper). */
export function tokensFor(chain) {
  return Object.keys(TOKENS[chain] || {});
}
