/**
 * teleportConstants.js — chain/token/route constants for the v2 Teleport tab
 * (Phase 3 bridge form).
 *
 * TOKEN IDENTITY NOW LIVES IN tokenResolver.js (the canonical registry — see
 * docs/TOKEN-RESOLVER.md). TOKENS below is a DERIVED PROJECTION of that
 * registry: every address/decimals value is read from TOKEN_TABLE, never
 * written by hand here. The projection keeps the exact pre-resolver shape
 * ({ chain: { SYMBOL: { address, decimals } } }) and per-chain key order so
 * every consumer (quote builders, balance lines, pickers) is byte-identical;
 * the tokenResolver.test.js regression pins that equivalence forever.
 *
 * CHAINS stays the UI routing registry (this file); CHAIN_META in
 * tokenResolver.js is the identity-only chain space (includes the non-UI
 * chains: btc/doge/ltc/xrp/rbn/tron).
 *
 * Verbatim-mirror note (v1): Teleporter.jsx still carries its OWN inline
 * TOKENS (the flag-restorable v1 safety net, deliberately NOT imported here
 * — v1's set differs: TRON gating, no WSOL/ETH/cbBTC entries). It stays
 * untouched by this migration; the eventual "make Teleporter.jsx import from
 * here" step can then collapse v1 onto the resolver with zero behavior
 * change.
 *
 * PHASE 3 SCOPE — EVM → X1 (the hop's route): the from-chain picker lists
 * EVM_CHAINS only, the destination is fixed to X1, and the reverse/onward
 * paths stay out (flag-gated; step 1.2 removed the reverse relay). sol + x1
 * stay in CHAINS/TOKENS because the EVM→X1 hop's LiFi leg lands USDC on
 * Solana (toChain=SOL, toToken=Solana USDC) before the Warp hop into X1.
 */

import { TOKEN_TABLE } from "./tokenResolver.js";

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

/**
 * The v2 token registry — DERIVED from tokenResolver.js TOKEN_TABLE.
 * Iterates rows in table order and projects every entry with listed:true,
 * reproducing the historical literal byte-identically (addresses, decimals
 * and per-chain key order — key order drives default-token pickers via
 * Object.keys(TOKENS[chain])[0]). The projection is deliberately NOT frozen
 * (same mutability as the pre-resolver literal). To add a token to the
 * pickers, add/flag an entry in tokenResolver.js — never edit this object.
 */
export const TOKENS = (() => {
  const out = {};
  for (const row of Object.values(TOKEN_TABLE)) {
    for (const entry of Object.values(row.entries)) {
      if (!entry.listed) continue;
      out[entry.chain] ??= {};
      out[entry.chain][row.symbol] = { decimals: entry.decimals, address: entry.address }; // decimals-first — matches the historical literal byte-for-byte
    }
  }
  return out;
})();

/**
 * The from-chain picker options (Phase 3 scope: EVM → X1 only — the hop's
 * route). Solana-source (sol_x1) and X1-source (x1_reverse / x1_onward)
 * routes are flag-gated / removed (step 1.2) and stay OUT of this port.
 */
export const EVM_CHAINS = Object.freeze(["eth", "bsc", "arb", "bas", "opt", "pol", "avax", "sonic"]);

// Minimum into X1 — REMOVED 2026-09-02 (fee-model v2). The old $25 floor's
// reasoning (the flat $1 bridge fee would be ~11% of a $10 journey) is gone:
// the Teleporter fee is now 0.5% capped at $250 and small bridges are viable
// — NO Teleporter floor. Kept as 0 so the constant stays the single gate
// knob (the old checks `amt < X1_MIN` now never block). Warp's OWN on-chain
// floor still applies to what actually bridges (WARP_MIN = 10 USDC below;
// wSOL.X min 0.1) — enforced at the tx layer (buildStage2 minBase), never a
// UI gate.
export const X1_MIN = 0;

// Minimum OUT of X1 — REMOVED 2026-09-02 (fee-model v2), same reasoning as
// X1_MIN: 0.5% capped at $250 makes small reverse bridges viable — NO floor.
// Kept as 0 so checkReverseMin's default can never block (the USD-aware
// reverse gate from PR #38 is disabled: minUsd defaults to 0 = fail-open).
// The burn preflight (balance) still guards an actually-too-small amount.
export const X1_REVERSE_MIN = 0;

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
