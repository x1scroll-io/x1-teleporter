/**
 * tokenResolver.test.js — the canonical token registry's own tests + the
 * regression pins for every consumer that was migrated onto it.
 *
 * Covers (docs/TOKEN-RESOLVER.md):
 *   1. Every listed canonical token resolves on its chain with the correct
 *      address + decimals (pinned, per-chain).
 *   2. Address resolution is case-insensitive for EVM (0x hex) and exact for
 *      SVM/TRON base58; the same address on different chains resolves to the
 *      per-chain token.
 *   3. Warp twins map BOTH directions (USDC↔USDC.x, WSOL↔wSOL.X, ETH↔ETH.X,
 *      cbBTC↔cbBTC.X) and the relation is SVM-side-only when a chain is given.
 *   4. Unknown symbol / unknown chain / unknown address → null (never throws,
 *      never guesses); unresolved TODO entries (Robinhood USDC, DGN, xencat)
 *      resolve to null too.
 *   5. MIGRATION REGRESSION — teleportConstants TOKENS is still byte-identical
 *      to the pre-resolver literal (values AND per-chain key order AND
 *      decimals-first entry key order).
 *   6. MIGRATION REGRESSION — warpBridge mint PublicKeys, X1/SOL_WARP_FEES and
 *      X1_REVERSE_TOKENS/X1_FORWARD_TOKENS are byte-identical to the
 *      pre-resolver constants.
 *   7. requireToken (the throwing escape hatch) fails loudly on unknowns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  resolve,
  resolveByAddress,
  resolveTwin,
  requireToken,
  canonicalSymbols,
  isKnownChain,
  TOKEN_TABLE,
  CHAIN_META,
} from "./tokenResolver.js";
import { TOKENS } from "./teleportConstants.js";
import {
  USDC_MINT,
  X1_USDCX_MINT,
  WSOL_MINT,
  X1_WSOLX_MINT,
  ETH_MINT,
  X1_ETHX_MINT,
  CBBTC_MINT,
  X1_CBBTCX_MINT,
  X1_WARP_FEES,
  SOL_WARP_FEES,
  X1_REVERSE_TOKENS,
  X1_FORWARD_TOKENS,
  X1_USDC_DECIMALS,
  X1_WSOLX_FEE_ACCOUNT,
  X1_ETHX_FEE_ACCOUNT,
  X1_CBBTCX_FEE_ACCOUNT,
  WARP_ACCOUNTS,
} from "../warpBridge.js";

// ────────────────────────────────────────────────────────────────────────────
// 1. Every listed token resolves on its chain — pinned addresses + decimals
// ────────────────────────────────────────────────────────────────────────────
test("resolver: every listed token resolves on its chain with pinned address + decimals", () => {
  const expect = {
    // [symbol, chain] → { address, decimals, program }
    "USDC|eth":   { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6,  program: "erc20" },
    "USDC|bsc":   { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, program: "erc20" },
    "USDC|sol":   { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6,  program: "spl" },
    "USDC|arb":   { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6,  program: "erc20" },
    "USDC|bas":   { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6,  program: "erc20" },
    "USDC|opt":   { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6,  program: "erc20" },
    "USDC|pol":   { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6,  program: "erc20" },
    "USDC|avax":  { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6,  program: "erc20" },
    "USDC|sonic": { address: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", decimals: 6,  program: "erc20" },
    "USDT|eth":   { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6,  program: "erc20" },
    "USDT|bsc":   { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, program: "erc20" },
    "USDT|sol":   { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6,  program: "spl" },
    "USDT|arb":   { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6,  program: "erc20" },
    "USDT|opt":   { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6,  program: "erc20" },
    "USDT|pol":   { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6,  program: "erc20" },
    "USDT|avax":  { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6,  program: "erc20" },
    "USDT|sonic": { address: "0xE5DA20F15420aD15DE0fa650600aFc998bbE3955", decimals: 6,  program: "erc20" },
    "DAI|eth":    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, program: "erc20" },
    "DAI|bsc":    { address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", decimals: 18, program: "erc20" },
    "DAI|arb":    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, program: "erc20" },
    "DAI|bas":    { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, program: "erc20" },
    "DAI|opt":    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, program: "erc20" },
    "DAI|pol":    { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, program: "erc20" },
    "DAI|avax":   { address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", decimals: 18, program: "erc20" },
    "WSOL|sol":   { address: "So11111111111111111111111111111111111111112", decimals: 9,  program: "spl" },
    "ETH|sol":    { address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", decimals: 8,  program: "spl" },
    "cbBTC|sol":  { address: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", decimals: 8,  program: "spl" },
    "USDC.x|x1":  { address: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq", decimals: 6,  program: "token-2022" },
    "wSOL.X|x1":  { address: "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8", decimals: 9,  program: "token-2022" },
    "ETH.X|x1":   { address: "4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw", decimals: 8,  program: "token-2022", listed: false },
    "cbBTC.X|x1": { address: "s47zmcZNFkZkdJqgZxZSBvXb8wRx89HgVGXt5Pf791K", decimals: 8,  program: "token-2022", listed: false },
  };
  for (const [key, want] of Object.entries(expect)) {
    const [symbol, chain] = key.split("|");
    const got = resolve(symbol, chain);
    assert.ok(got, `resolve(${symbol}, ${chain}) should resolve`);
    assert.equal(got.symbol, symbol, "canonical symbol");
    assert.equal(got.chain, chain, "chain");
    assert.equal(got.address, want.address, `${symbol} address on ${chain}`);
    assert.equal(got.decimals, want.decimals, `${symbol} decimals on ${chain}`);
    assert.equal(got.program, want.program, `${symbol} program on ${chain}`);
    assert.ok(Array.isArray(got.rails) && got.rails.length > 0, "rails is a non-empty array");
    assert.equal(got.listed, want.listed ?? true, `${symbol} on ${chain} listed flag`);
  }
});

test("resolver: canonical-but-unlisted entries resolve with their own identity (native EVM ETH, XNT, BTC/DOGE/LTC/XRP, wXNT, v1 TRON)", () => {
  const ethNative = resolve("ETH", "eth");
  assert.equal(ethNative.decimals, 18);
  assert.equal(ethNative.address, null);
  assert.equal(ethNative.program, "native");
  assert.equal(ethNative.listed, false, "native ETH is not in the stable-only picker registry");

  const xnt = resolve("XNT", "x1");
  assert.equal(xnt.decimals, 9);
  assert.equal(xnt.address, null);
  assert.equal(xnt.program, "native");
  assert.equal(xnt.kind, "native");

  const natives = {
    "BTC|btc": 8, "DOGE|doge": 8, "LTC|ltc": 8, "XRP|xrp": 6,
  };
  for (const [key, dec] of Object.entries(natives)) {
    const [symbol, chain] = key.split("|");
    const got = resolve(symbol, chain);
    assert.ok(got, `${symbol} resolves`);
    assert.equal(got.decimals, dec, `${symbol} decimals`);
    assert.equal(got.address, null, `${symbol} is native (no address)`);
    assert.equal(got.program, "native");
    assert.deepEqual([...got.rails], ["thorchain"], `${symbol} rail is thorchain`);
  }

  const wXnt = resolve("wXNT", "x1");
  assert.equal(wXnt.address, "So11111111111111111111111111111111111111112", "X1 native wrap is the canonical spl-token all-0x01 mint");
  assert.equal(wXnt.decimals, 9);

  const tronUsdc = resolve("USDC", "tron");
  assert.equal(tronUsdc.address, "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8");
  assert.equal(tronUsdc.listed, false, "v1 TRON lane is identity-only in v2");
});

// ────────────────────────────────────────────────────────────────────────────
// 2. resolveByAddress — EVM case-insensitive, SVM/TRON exact, per-chain
// ────────────────────────────────────────────────────────────────────────────
test("resolveByAddress: EVM 0x addresses match case-insensitively (lower / checksummed / UPPER / 0X)", () => {
  const ethUsdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  for (const form of [
    ethUsdc,                                          // checksummed (stored form)
    ethUsdc.toLowerCase(),                            // all lower
    ethUsdc.toUpperCase(),                            // all upper
    "0X" + ethUsdc.slice(2).toUpperCase(),            // uppercase 0X prefix
    "0x" + ethUsdc.slice(2).toLowerCase(),            // lower 0x prefix
  ]) {
    const hit = resolveByAddress(form, "eth");
    assert.ok(hit, `address form ${form} resolves`);
    assert.equal(hit.symbol, "USDC");
    assert.equal(hit.entry.address, ethUsdc, "entry keeps the canonical stored casing");
    assert.equal(hit.entry.decimals, 6);
  }
});

test("resolveByAddress: SVM base58 is exact-match and case-sensitive; same address on different chains resolves per-chain", () => {
  const nativeWrap = "So11111111111111111111111111111111111111112";
  assert.equal(resolveByAddress(nativeWrap, "sol").symbol, "WSOL", "Solana side = WSOL");
  assert.equal(resolveByAddress(nativeWrap, "x1").symbol, "wXNT", "X1 side = wXNT (wrapped XNT) — same address, per-chain semantics");
  assert.equal(resolveByAddress(nativeWrap.toLowerCase(), "sol"), null, "lowercased base58 is not a valid address — never fuzzy-match");

  const usdcX = resolveByAddress("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq", "x1");
  assert.equal(usdcX.symbol, "USDC.x");
  assert.equal(usdcX.entry.program, "token-2022");

  // TRON addresses are stored base58 — exact match
  assert.equal(resolveByAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "tron").symbol, "USDT");
  assert.equal(resolveByAddress("tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t", "tron"), null, "tron base58 is case-sensitive");
});

test("resolveByAddress: wrong-chain, unknown and malformed inputs → null, never throws", () => {
  assert.equal(resolveByAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "x1"), null, "Solana USDC mint is not on X1");
  assert.equal(resolveByAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "sol"), null, "Ethereum USDC contract is not on Solana");
  assert.equal(resolveByAddress("0x0000000000000000000000000000000000000000", "eth"), null, "zero address unknown");
  assert.equal(resolveByAddress("not-an-address", "eth"), null);
  assert.equal(resolveByAddress("", "eth"), null);
  assert.equal(resolveByAddress(null, "eth"), null);
  assert.equal(resolveByAddress(undefined, "eth"), null);
  assert.equal(resolveByAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", null), null);
  assert.equal(resolveByAddress("0x1234", "eth"), null, "too-short hex is not a token address");
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Warp twins — both directions, all four pairs, SVM-side-only w/ chain
// ────────────────────────────────────────────────────────────────────────────
test("resolveTwin: all four Warp pairs map in BOTH directions", () => {
  const pairs = [
    ["USDC", "USDC.x"],
    ["WSOL", "wSOL.X"],
    ["ETH", "ETH.X"],
    ["cbBTC", "cbBTC.X"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(resolveTwin(a), b, `${a} → ${b}`);
    assert.equal(resolveTwin(b), a, `${b} → ${a}`);
  }
});

test("resolveTwin: chain-aware — the relation only exists on the SVM sides (sol/x1)", () => {
  assert.equal(resolveTwin("USDC", "sol"), "USDC.x");
  assert.equal(resolveTwin("USDC", "x1"), "USDC.x");
  assert.equal(resolveTwin("USDC", "eth"), null, "an Ethereum USDC has no Warp twin");
  assert.equal(resolveTwin("USDC", "arb"), null);
  assert.equal(resolveTwin("ETH", "sol"), "ETH.X");
  assert.equal(resolveTwin("ETH", "eth"), null, "native Ethereum ETH has no Warp twin");
});

test("resolveTwin: non-pair symbols and unknowns → null", () => {
  for (const sym of ["USDT", "DAI", "XNT", "wXNT", "BTC", "DOGE", "LTC", "XRP", "DGN", "xencat", "FOO", ""]) {
    assert.equal(resolveTwin(sym), null, `${sym} is not a warp-pair member`);
  }
});

test("resolve: enriched entry carries the canonical row context (twin, coingecko id, name, kind)", () => {
  const usdcSol = resolve("USDC", "sol");
  assert.equal(usdcSol.warpTwin, "USDC.x");
  assert.equal(usdcSol.coingeckoId, "usd-coin");
  assert.equal(usdcSol.name, "USD Coin");
  assert.equal(usdcSol.kind, "token");

  const ethX = resolve("ETH.X", "x1");
  assert.equal(ethX.warpTwin, "ETH");
  assert.equal(ethX.coingeckoId, null);
  assert.deepEqual([...ethX.rails], ["warp"]);

  const btc = resolve("BTC", "btc");
  assert.equal(btc.thorchainAsset, "BTC.BTC");
  assert.equal(btc.warpTwin, null);

  const wsol = resolve("WSOL", "sol");
  assert.equal(wsol.coingeckoId, "wrapped-solana");
  const cbbtc = resolve("cbBTC", "sol");
  assert.equal(cbbtc.coingeckoId, "coinbase-wrapped-btc");
  const eth = resolve("ETH", "sol");
  assert.equal(eth.coingeckoId, "ethereum");
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Unknowns → null; unresolved TODO entries → null (never guesses)
// ────────────────────────────────────────────────────────────────────────────
test("resolve: unknown symbol / unknown chain → null, never throws", () => {
  assert.equal(resolve("FOO", "sol"), null);
  assert.equal(resolve("USDC", "moon"), null);
  assert.equal(resolve(null, "sol"), null);
  assert.equal(resolve(undefined, "sol"), null);
  assert.equal(resolve("USDC", null), null);
  assert.equal(resolve("", "sol"), null);
  assert.equal(resolve("usdc", "sol"), null, "symbols are case-sensitive by contract");
  assert.equal(resolve("WSOL", "sol")?.symbol, "WSOL", "and that is deliberate: WSOL ≠ wsol");
});

test("resolve: reserved/unverified rows never resolve (Robinhood USDC TODO, DGN, xencat)", () => {
  // Robinhood Chain (4663) USDC — the sibling robinhood task has not landed;
  // the entry is a documented TODO with address null → resolve returns null.
  assert.equal(resolve("USDC", "rbn"), null, "no Robinhood USDC identity until the deployment is confirmed");
  assert.equal(resolveByAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "rbn"), null, "canonical Circle contract not assumed on Robinhood Chain");
  // Reserved rows with zero chain entries.
  assert.equal(resolve("DGN", "x1"), null);
  assert.equal(resolve("DGN", "sol"), null);
  assert.equal(resolve("xencat", "x1"), null);
  assert.equal(resolveByAddress("whatever", "x1"), null);
  // They ARE documented in the table (intent) — but not resolvable.
  assert.ok(TOKEN_TABLE.DGN && TOKEN_TABLE.DGN.status === "unverified");
  assert.ok(TOKEN_TABLE.xencat && TOKEN_TABLE.xencat.status === "unverified");
  const rbnEntry = TOKEN_TABLE.USDC.entries.rbn;
  assert.ok(rbnEntry && rbnEntry.status === "unverified" && rbnEntry.address === null, "Robinhood USDC entry is the marked TODO");
});

// ────────────────────────────────────────────────────────────────────────────
// 5. MIGRATION REGRESSION — teleportConstants TOKENS byte-identical
// ────────────────────────────────────────────────────────────────────────────
/** The exact pre-resolver TOKENS literal (v2 @ 204e808) — pinned forever. */
const HISTORICAL_TOKENS = {
  eth:   { USDC: { decimals: 6, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, USDT: { decimals: 6, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }, DAI: { decimals: 18, address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" } },
  bsc:   { USDC: { decimals: 18, address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" }, USDT: { decimals: 18, address: "0x55d398326f99059fF775485246999027B3197955" }, DAI: { decimals: 18, address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" } },
  sol:   { USDC: { decimals: 6, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, USDT: { decimals: 6, address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }, WSOL: { decimals: 9, address: "So11111111111111111111111111111111111111112" }, ETH: { decimals: 8, address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" }, cbBTC: { decimals: 8, address: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij" } },
  arb:   { USDC: { decimals: 6, address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" }, USDT: { decimals: 6, address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" }, DAI: { decimals: 18, address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" } },
  bas:   { USDC: { decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, DAI: { decimals: 18, address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" } },
  opt:   { USDC: { decimals: 6, address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" }, USDT: { decimals: 6, address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" }, DAI: { decimals: 18, address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" } },
  pol:   { USDC: { decimals: 6, address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" }, USDT: { decimals: 6, address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" }, DAI: { decimals: 18, address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" } },
  avax:  { USDC: { decimals: 6, address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" }, USDT: { decimals: 6, address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7" }, DAI: { decimals: 18, address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70" } },
  sonic: { USDC: { decimals: 6, address: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894" }, USDT: { decimals: 6, address: "0xE5DA20F15420aD15DE0fa650600aFc998bbE3955" } },
  x1:    { "USDC.x": { decimals: 6, address: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq" }, "wSOL.X": { decimals: 9, address: "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8" } },
};

test("MIGRATION REGRESSION: TOKENS projection is byte-identical to the historical literal", () => {
  // Values + nesting (deep equal).
  assert.deepEqual(TOKENS, HISTORICAL_TOKENS, "TOKENS must equal the pre-resolver literal exactly");
  // Chain key order + per-chain symbol order + decimals-first entry key order
  // (JSON.stringify is order-sensitive — this pins the exact serialization).
  assert.equal(JSON.stringify(TOKENS), JSON.stringify(HISTORICAL_TOKENS), "TOKENS key order must be byte-identical too");
  // The default-token pickers read Object.keys(TOKENS[chain])[0] — pin firsts.
  assert.equal(Object.keys(TOKENS.eth)[0], "USDC");
  assert.equal(Object.keys(TOKENS.bas)[0], "USDC");
  assert.equal(Object.keys(TOKENS.sonic)[0], "USDC");
  assert.equal(Object.keys(TOKENS.sol)[0], "USDC");
  assert.equal(Object.keys(TOKENS.x1)[0], "USDC.x");
  assert.equal(Object.keys(TOKENS.sol)[1], "USDT");
  assert.equal(Object.keys(TOKENS.sol)[2], "WSOL");
  assert.equal(Object.keys(TOKENS.sol)[3], "ETH");
  assert.equal(Object.keys(TOKENS.sol)[4], "cbBTC");
});

test("MIGRATION REGRESSION: every TOKENS entry equals the resolver's canonical entry (single source)", () => {
  for (const [chain, tokens] of Object.entries(TOKENS)) {
    for (const [symbol, tok] of Object.entries(tokens)) {
      const resolved = resolve(symbol, chain);
      assert.ok(resolved, `resolver must know ${symbol} on ${chain} (TOKENS is a projection of it)`);
      assert.equal(resolved.address, tok.address);
      assert.equal(resolved.decimals, tok.decimals);
      assert.equal(resolved.listed, true, `${symbol} on ${chain} must stay listed`);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 6. MIGRATION REGRESSION — warpBridge constants byte-identical
// ────────────────────────────────────────────────────────────────────────────
test("MIGRATION REGRESSION: warpBridge mint PublicKeys are byte-identical to the pre-resolver values", () => {
  const mints = {
    USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    X1_USDCX_MINT: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq",
    WSOL_MINT: "So11111111111111111111111111111111111111112",
    X1_WSOLX_MINT: "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8",
    ETH_MINT: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    X1_ETHX_MINT: "4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw",
    CBBTC_MINT: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    X1_CBBTCX_MINT: "s47zmcZNFkZkdJqgZxZSBvXb8wRx89HgVGXt5Pf791K",
  };
  for (const [name, addr] of Object.entries(mints)) {
    const pk = { USDC_MINT, X1_USDCX_MINT, WSOL_MINT, X1_WSOLX_MINT, ETH_MINT, X1_ETHX_MINT, CBBTC_MINT, X1_CBBTCX_MINT }[name];
    assert.equal(pk.toBase58(), addr, `${name} address unchanged`);
    assert.ok(pk.equals(new PublicKey(addr)), `${name} is a real PublicKey for that address`);
  }
});

test("MIGRATION REGRESSION: X1_WARP_FEES / SOL_WARP_FEES are byte-identical (shape, BigInt amounts, decimals)", () => {
  assert.deepEqual(X1_WARP_FEES, {
    "USDC.x": { kind: "flat", amountBase: 1_000_000n, decimals: 6 },
    "wSOL.X": { kind: "pct", bps: 25, decimals: 9 },
    "ETH.X": { kind: "pct", bps: 25, decimals: 8 },
    "cbBTC.X": { kind: "pct", bps: 25, decimals: 8 },
  });
  assert.deepEqual(SOL_WARP_FEES, {
    USDC: { kind: "flat", amountBase: 1_000_000n, decimals: 6 },
    WSOL: { kind: "pct", bps: 25, decimals: 9 },
    ETH: { kind: "pct", bps: 25, decimals: 8 },
    cbBTC: { kind: "pct", bps: 25, decimals: 8 },
  });
  assert.equal(X1_USDC_DECIMALS, 6);
});

test("MIGRATION REGRESSION: X1_REVERSE_TOKENS / X1_FORWARD_TOKENS keep mints, decimals, fee accounts and floors", () => {
  const b58 = (pk) => (typeof pk.toBase58 === "function" ? pk.toBase58() : pk.toString());
  assert.deepEqual(
    Object.fromEntries(Object.entries(X1_REVERSE_TOKENS).map(([k, v]) => [k, { mint: b58(v.mint), decimals: v.decimals, feeAccount: b58(v.feeAccount) }])),
    {
      "USDC.x": { mint: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq", decimals: 6, feeAccount: "4uRFjqVU5ZKkp7hQLx3Lm3YeWFts17ER8a5HLUE18ayG" },
      "wSOL.X": { mint: "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8", decimals: 9, feeAccount: b58(X1_WSOLX_FEE_ACCOUNT) },
      "ETH.X": { mint: "4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw", decimals: 8, feeAccount: b58(X1_ETHX_FEE_ACCOUNT) },
      "cbBTC.X": { mint: "s47zmcZNFkZkdJqgZxZSBvXb8wRx89HgVGXt5Pf791K", decimals: 8, feeAccount: b58(X1_CBBTCX_FEE_ACCOUNT) },
    },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(X1_FORWARD_TOKENS).map(([k, v]) => [k, { sourceMint: b58(v.sourceMint), destMint: b58(v.destMint), decimals: v.decimals, feeAccount: b58(v.feeAccount), minBase: v.minBase }])),
    {
      "USDC.x": { sourceMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", destMint: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq", decimals: 6, feeAccount: b58(WARP_ACCOUNTS.feeCollectorAta), minBase: 10_000_000n },
      "wSOL.X": { sourceMint: "So11111111111111111111111111111111111111112", destMint: "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8", decimals: 9, feeAccount: "GxfLqeziL8wrUF31H1thWVAHkqzPodoqbwZeoDTRAkyU", minBase: 100_000_000n },
    },
  );
});

test("MIGRATION REGRESSION: reverseQuote warp-fee decimals + twin-driven Solana landing stay identical", async () => {
  const rq = await import("./reverseQuote.js");
  // reverseSolanaToken = the canonical twin lookup with the legacy USDC fallback.
  assert.equal(rq.reverseSolanaToken("USDC.x"), "USDC");
  assert.equal(rq.reverseSolanaToken("wSOL.X"), "WSOL");
  assert.equal(rq.reverseSolanaToken("ETH.X"), "ETH");
  assert.equal(rq.reverseSolanaToken("cbBTC.X"), "cbBTC");
  assert.equal(rq.reverseSolanaToken("SOMEDAY.X"), "USDC", "unknown → legacy USDC fallback preserved");
  assert.equal(rq.X1_WARP_FEE_PCT_DEFAULT.kind, "pct", "the unknown-token default stays pct, never flat");

  const tq = await import("./teleportQuote.js");
  // The quote builders keep the same landing-token logic via the twin relation —
  // pinned through the existing teleportQuote.test.js suite; here we pin the
  // observable mapping the two builders rely on.
  const { resolveTwin: twin } = await import("./tokenResolver.js");
  assert.equal(twin("wSOL.X"), "WSOL");
  assert.equal(twin("USDC.x"), "USDC");
});

// ────────────────────────────────────────────────────────────────────────────
// 7. requireToken — the loud escape hatch for money-path constants
// ────────────────────────────────────────────────────────────────────────────
test("requireToken: resolves pinned entries and throws descriptively on unknowns", () => {
  assert.equal(requireToken("USDC", "sol").decimals, 6);
  assert.equal(requireToken("USDC.x", "x1").program, "token-2022");
  assert.throws(() => requireToken("NOPE", "sol"), /requireToken/);
  assert.throws(() => requireToken("USDC", "moon"), /requireToken/);
  assert.throws(() => requireToken("DGN", "x1"), /requireToken/, "reserved rows are not resolvable — requireToken must refuse");
});

// ────────────────────────────────────────────────────────────────────────────
// Table hygiene
// ────────────────────────────────────────────────────────────────────────────
test("table hygiene: every entry's chain is known; listed entries have addresses; twins are symmetric and real", () => {
  for (const row of Object.values(TOKEN_TABLE)) {
    assert.ok(row.symbol && typeof row.name === "string");
    for (const entry of Object.values(row.entries)) {
      assert.ok(isKnownChain(entry.chain), `${row.symbol} entry chain ${entry.chain} must be in CHAIN_META`);
      assert.equal(entry.chain, CHAIN_META[entry.chain].id);
      assert.ok(Array.isArray(entry.rails) && entry.rails.length > 0, `${row.symbol}@${entry.chain} has rails`);
      if (entry.listed) {
        assert.ok(entry.address, `${row.symbol}@${entry.chain} is listed → must have a verified address`);
        assert.equal(typeof entry.decimals, "number", `${row.symbol}@${entry.chain} is listed → must have decimals`);
      }
    }
    if (row.warpTwin) {
      const other = TOKEN_TABLE[row.warpTwin];
      assert.ok(other, `${row.symbol} twin ${row.warpTwin} must be a real row`);
      assert.equal(other.warpTwin, row.symbol, "twin relation must be symmetric");
    }
  }
  // The canonical symbol list, in table order (docs/TOKEN-RESOLVER.md).
  assert.deepEqual(
    canonicalSymbols(),
    ["USDC", "USDT", "DAI", "WSOL", "USDC.x", "wSOL.X", "ETH", "ETH.X", "cbBTC", "cbBTC.X", "wXNT", "XNT", "BTC", "DOGE", "LTC", "XRP", "DGN", "xencat"],
    "canonical symbol list (docs/TOKEN-RESOLVER.md table order)",
  );
});
