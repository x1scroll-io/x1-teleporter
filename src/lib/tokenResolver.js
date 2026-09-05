/**
 * tokenResolver.js — the CANONICAL token identity registry + resolver for the
 * x1-teleporter app.
 *
 * WHY THIS EXISTS
 *   Before this module, token addresses/decimals lived in five places:
 *   teleportConstants.js (TOKENS), warpBridge.js (mint PublicKeys + the
 *   X1/SOL_WARP_FEES + X1_REVERSE_TOKENS/X1_FORWARD_TOKENS registries),
 *   reverseQuote.js (a second copy of the per-token Warp fee shapes + the
 *   reverse twin map + the Coingecko id map), teleportQuote.js (inline
 *   Solana-landing twin lookups) and Teleporter.jsx (v1's own inline TOKENS).
 *   Addresses were scattered and could drift. THIS module is the single
 *   source of truth: every other module reads token identity FROM here.
 *
 * WHAT IT ANSWERS
 *   - resolve("USDC", "sol")        → the canonical USDC entry on Solana
 *   - resolveByAddress(addr, chain) → which canonical token lives at an
 *     address (EVM addresses match case-insensitively — checksummed, upper,
 *     lower — SVM base58 is exact; TRON base58 is exact)
 *   - resolveTwin("USDC.x")         → "USDC"  (and vice versa) — the Warp
 *     pair relation (Solana-side token ↔ X1-side wrapped token):
 *       USDC ↔ USDC.x · WSOL ↔ wSOL.X · ETH ↔ ETH.X · cbBTC ↔ cbBTC.X
 *
 * CONTRACT (hard rules)
 *   - resolve/resolveByAddress/resolveTwin NEVER throw and NEVER guess:
 *     unknown symbol / unknown chain / unknown address → null.
 *   - A non-native entry with address === null is UNRESOLVED (a documented
 *     TODO) and resolve() returns null for it — no half-answers.
 *   - requireToken() is the ONE throwing escape hatch, for money-path
 *     constants modules only (warpBridge.js etc.): a deleted/misnamed entry
 *     fails LOUDLY at import time instead of silently shipping a null mint.
 *
 * PURE MODULE: no DOM, no wallet, no fetch, no env, no @solana imports —
 * addresses are plain strings. Runnable under `node --test` and importable
 * from the browser bundle, api/ functions and tests alike.
 *
 * HOW TO ADD A TOKEN — see docs/TOKEN-RESOLVER.md.
 *
 * Ground-truth note (2026-09-05): every address below is copied from the
 * pre-resolver constants (teleportConstants.js TOKENS + warpBridge.js live-
 * verified Warp config mints + the verified xdex golden fixtures). Nothing
 * was "improved" in passing — a wrong address here is a wrong address in
 * every consumer, so edits must cite a verified source.
 */

// ────────────────────────────────────────────────────────────────────────────
// CHAIN METADATA — the resolver's chain-id space. Extends the teleport CHAINS
// ids (x1/eth/bsc/sol/arb/bas/opt/pol/avax/sonic) with the chains the other
// rails touch (btc/doge/ltc/xrp for THORChain natives, rbn = Robinhood Chain
// 4663, tron for the v1-gated TRON lane). CHAINS in teleportConstants.js is
// the UI routing registry and stays separate (this table is identity-only).
// ────────────────────────────────────────────────────────────────────────────
export const CHAIN_META = Object.freeze({
  x1:    Object.freeze({ id: "x1",    name: "X1",           chainId: null,   family: "svm" }),
  sol:   Object.freeze({ id: "sol",   name: "Solana",       chainId: "SOL",  family: "svm" }),
  eth:   Object.freeze({ id: "eth",   name: "Ethereum",     chainId: 1,      family: "evm" }),
  bsc:   Object.freeze({ id: "bsc",   name: "BNB Chain",    chainId: 56,     family: "evm" }),
  arb:   Object.freeze({ id: "arb",   name: "Arbitrum",     chainId: 42161,  family: "evm" }),
  bas:   Object.freeze({ id: "bas",   name: "Base",         chainId: 8453,   family: "evm" }),
  opt:   Object.freeze({ id: "opt",   name: "Optimism",     chainId: 10,     family: "evm" }),
  pol:   Object.freeze({ id: "pol",   name: "Polygon",      chainId: 137,    family: "evm" }),
  avax:  Object.freeze({ id: "avax",  name: "Avalanche",    chainId: 43114,  family: "evm" }),
  sonic: Object.freeze({ id: "sonic", name: "Sonic",        chainId: 146,    family: "evm" }),
  rbn:   Object.freeze({ id: "rbn",   name: "Robinhood Chain", chainId: 4663, family: "evm" }), // TODO(robinhood-task): the sibling Robinhood Chain leg. USDC entry below is UNRESOLVED until it lands.
  tron:  Object.freeze({ id: "tron",  name: "Tron",         chainId: "TRON", family: "evm" }), // TVM — v1-gated lane (ENABLE_TRON=false in v2); entries kept for identity only
  btc:   Object.freeze({ id: "btc",   name: "Bitcoin",      chainId: null,   family: "utxo" }),
  doge:  Object.freeze({ id: "doge",  name: "Dogecoin",     chainId: null,   family: "utxo" }),
  ltc:   Object.freeze({ id: "ltc",   name: "Litecoin",     chainId: null,   family: "utxo" }),
  xrp:   Object.freeze({ id: "xrp",   name: "XRP Ledger",   chainId: null,   family: "utxo" }),
});

/**
 * The canonical token table. Row key = the CANONICAL symbol (what the rest of
 * the app displays and keys on). Per-chain entry fields:
 *   chain     — CHAIN_META id the entry lives on
 *   address   — mint/contract string, or null for native assets AND for
 *               UNRESOLVED todo entries (an entry with a null address and
 *               program !== "native" does NOT resolve — see the contract)
 *   decimals  — per-chain decimals (EVM native ETH is 18; Solana Wormhole ETH
 *               is 8; X1 ETH.X is 8 — per-chain is the whole point)
 *   program   — "erc20" | "trc20" | "spl" | "token-2022" | "native"
 *               (the SVM "program" question: spl = Token program v1,
 *               token-2022 = Token-2022 program)
 *   rails     — which transport rails move this token: "lifi", "warp",
 *               "xdex", "thorchain", "native"
 *   listed    — true ⇔ the entry appears in the v2 picker registry
 *               (teleportConstants TOKENS is DERIVED from listed entries).
 *               Identity-known-but-unlisted entries (native ETH on EVM, XNT,
 *               ETH.X/cbBTC.X engine rails, v1 TRON lane) stay canonical
 *               without changing today's pickers.
 *   status    — optional; "unverified" marks a TODO entry (no ground truth
 *               yet → address null → does not resolve)
 * Row fields: name, kind ("token" | "native"), warpTwin (the other side of
 * the Warp pair — symmetric), coingeckoId (only where the app uses it),
 * thorchainAsset (only for the THORChain lane).
 *
 * ROW ORDER IS MEANINGFUL: teleportConstants TOKENS is projected by iterating
 * rows in order, so per-chain key order (which drives default-token pickers
 * via Object.keys(TOKENS[chain])[0]) is preserved byte-identically vs the
 * pre-resolver literal: EVM chains USDC→USDT→DAI, sol USDC→USDT→WSOL→ETH→
 * cbBTC, x1 USDC.x→wSOL.X. Keep new rows at the END unless you also update
 * the pinned projection regression test.
 */
export const TOKEN_TABLE = Object.freeze({
  // ── USD Coin ─────────────────────────────────────────────────────────────
  USDC: Object.freeze({
    symbol: "USDC",
    name: "USD Coin",
    kind: "token",
    warpTwin: "USDC.x", // Solana-side USDC is the Warp source of X1 USDC.x
    coingeckoId: "usd-coin",
    entries: Object.freeze({
      eth:   Object.freeze({ chain: "eth",   address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      bsc:   Object.freeze({ chain: "bsc",   address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true, note: "Binance-Peg USDC (18 dec — NOT Circle's canonical contract; BSC has no native Circle USDC)" }),
      sol:   Object.freeze({ chain: "sol",   address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6,  program: "spl", rails: Object.freeze(["lifi", "warp"]), listed: true }),
      arb:   Object.freeze({ chain: "arb",   address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      bas:   Object.freeze({ chain: "bas",   address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      opt:   Object.freeze({ chain: "opt",   address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      pol:   Object.freeze({ chain: "pol",   address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true, note: "Bridged (legacy) Circle USDC — the address this app has always quoted on Polygon" }),
      avax:  Object.freeze({ chain: "avax",  address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      sonic: Object.freeze({ chain: "sonic", address: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      tron:  Object.freeze({ chain: "tron",  address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", decimals: 6,  program: "trc20", rails: Object.freeze(["lifi"]), listed: false, note: "v1 TRON lane (ENABLE_TRON=false in v2) — identity kept, not listed" }),
      // TODO(robinhood-task): Robinhood Chain (4663) USDC is UNRESOLVED —
      // the sibling robinhood leg has not confirmed the deployment. Per the
      // coordination rule: if it is Circle's canonical contract it maps to
      // THIS entry; if it is a different deployment it becomes its own row.
      // Until confirmed, address stays null → resolve("USDC","rbn") is null.
      rbn:   Object.freeze({ chain: "rbn",   address: null, decimals: null, program: "erc20", rails: Object.freeze(["lifi"]), listed: false, status: "unverified", note: "TODO(robinhood-task): confirm Robinhood Chain USDC deployment (canonical Circle contract vs other) before filling address/decimals" }),
    }),
  }),

  // ── Tether ───────────────────────────────────────────────────────────────
  USDT: Object.freeze({
    symbol: "USDT",
    name: "Tether USD",
    kind: "token",
    coingeckoId: "tether",
    entries: Object.freeze({
      eth:   Object.freeze({ chain: "eth",   address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      bsc:   Object.freeze({ chain: "bsc",   address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true, note: "Binance-Peg USDT (18 dec)" }),
      sol:   Object.freeze({ chain: "sol",   address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6,  program: "spl", rails: Object.freeze(["lifi"]), listed: true }),
      arb:   Object.freeze({ chain: "arb",   address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      opt:   Object.freeze({ chain: "opt",   address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      pol:   Object.freeze({ chain: "pol",   address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      avax:  Object.freeze({ chain: "avax",  address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      sonic: Object.freeze({ chain: "sonic", address: "0xE5DA20F15420aD15DE0fa650600aFc998bbE3955", decimals: 6,  program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      tron:  Object.freeze({ chain: "tron",  address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6,  program: "trc20", rails: Object.freeze(["lifi"]), listed: false, note: "v1 TRON lane (ENABLE_TRON=false in v2) — identity kept, not listed" }),
    }),
  }),

  // ── DAI ──────────────────────────────────────────────────────────────────
  DAI: Object.freeze({
    symbol: "DAI",
    name: "Dai Stablecoin",
    kind: "token",
    coingeckoId: "dai",
    entries: Object.freeze({
      eth:   Object.freeze({ chain: "eth",   address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      bsc:   Object.freeze({ chain: "bsc",   address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true, note: "Binance-Peg DAI (18 dec)" }),
      arb:   Object.freeze({ chain: "arb",   address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      bas:   Object.freeze({ chain: "bas",   address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      opt:   Object.freeze({ chain: "opt",   address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true, note: "Same canonical Optimism DAI address as Arbitrum's — coincidental-but-real (both are the standard bridged DAI deployment)" }),
      pol:   Object.freeze({ chain: "pol",   address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
      avax:  Object.freeze({ chain: "avax",  address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", decimals: 18, program: "erc20", rails: Object.freeze(["lifi"]), listed: true }),
    }),
  }),

  // ── WSOL (Solana wrapped native) ─────────────────────────────────────────
  WSOL: Object.freeze({
    symbol: "WSOL",
    name: "Wrapped SOL (native wrap)",
    kind: "token",
    warpTwin: "wSOL.X", // the Warp source of X1 wSOL.X
    coingeckoId: "wrapped-solana",
    entries: Object.freeze({
      sol: Object.freeze({ chain: "sol", address: "So11111111111111111111111111111111111111112", decimals: 9, program: "spl", rails: Object.freeze(["lifi", "warp"]), listed: true, note: "The SPL native-wrap mint — spl-token's canonical all-0x01 pubkey; LiFi quotes EVM→SOL WSOL directly and Warp locks it to mint wSOL.X" }),
    }),
  }),

  // ── USDC.x (X1 Warp-wrapped USDC) ────────────────────────────────────────
  "USDC.x": Object.freeze({
    symbol: "USDC.x",
    name: "USDC.x (X1 Warp-wrapped USDC)",
    kind: "token",
    warpTwin: "USDC", // burning USDC.x on X1 releases USDC on Solana
    entries: Object.freeze({
      x1: Object.freeze({ chain: "x1", address: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq", decimals: 6, program: "token-2022", rails: Object.freeze(["warp", "xdex"]), listed: true, note: "Guardian-minted Token-2022 wrap (verified on-chain); also the xdex wXNT/USDC.x pool's quote token" }),
    }),
  }),

  // ── wSOL.X (X1 Warp-wrapped WSOL) ────────────────────────────────────────
  "wSOL.X": Object.freeze({
    symbol: "wSOL.X",
    name: "wSOL.X (X1 Warp-wrapped WSOL)",
    kind: "token",
    warpTwin: "WSOL",
    entries: Object.freeze({
      x1: Object.freeze({ chain: "x1", address: "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8", decimals: 9, program: "token-2022", rails: Object.freeze(["warp"]), listed: true, note: "Guardian-minted Token-2022 wrap (live Warp config + verified on-chain burns)" }),
    }),
  }),

  // ── ETH ──────────────────────────────────────────────────────────────────
  ETH: Object.freeze({
    symbol: "ETH",
    name: "Ether",
    kind: "token", // token row: carries BOTH native EVM gas entries and the Solana Wormhole representation
    warpTwin: "ETH.X", // the Solana-side Wormhole ETH is the Warp source of X1 ETH.X
    coingeckoId: "ethereum",
    entries: Object.freeze({
      eth:  Object.freeze({ chain: "eth",  address: null, decimals: 18, program: "native", rails: Object.freeze(["native"]), listed: false, note: "Ethereum native gas — no contract; identity kept, not in the stable-only pickers" }),
      arb:  Object.freeze({ chain: "arb",  address: null, decimals: 18, program: "native", rails: Object.freeze(["native"]), listed: false }),
      opt:  Object.freeze({ chain: "opt",  address: null, decimals: 18, program: "native", rails: Object.freeze(["native"]), listed: false }),
      bas:  Object.freeze({ chain: "bas",  address: null, decimals: 18, program: "native", rails: Object.freeze(["native"]), listed: false }),
      sol:  Object.freeze({ chain: "sol",  address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", decimals: 8, program: "spl", rails: Object.freeze(["warp", "lifi"]), listed: true, note: "Wormhole-wrapped ETH on Solana (native vault token in Warp's registry) — 8 dec, 25 bps (live config 2026-09-03)" }),
    }),
  }),

  // ── ETH.X (X1 Warp-wrapped ETH) ──────────────────────────────────────────
  "ETH.X": Object.freeze({
    symbol: "ETH.X",
    name: "ETH.X (X1 Warp-wrapped ETH)",
    kind: "token",
    warpTwin: "ETH",
    entries: Object.freeze({
      x1: Object.freeze({ chain: "x1", address: "4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw", decimals: 8, program: "token-2022", rails: Object.freeze(["warp"]), listed: false, note: "Engine/reverse rail only today (not in the v2 picker) — live Warp config 2026-09-03, no live burns yet" }),
    }),
  }),

  // ── cbBTC ────────────────────────────────────────────────────────────────
  cbBTC: Object.freeze({
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    kind: "token",
    warpTwin: "cbBTC.X", // the Solana-side cbBTC is the Warp source of X1 cbBTC.X
    coingeckoId: "coinbase-wrapped-btc",
    entries: Object.freeze({
      sol: Object.freeze({ chain: "sol", address: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", decimals: 8, program: "spl", rails: Object.freeze(["warp", "lifi"]), listed: true, note: "cbBTC on Solana (native vault token in Warp's registry) — 8 dec, 25 bps (live config 2026-09-03)" }),
      // NOTE: cbBTC's canonical Base contract (0xcbB7...) is not referenced by
      // any rail yet — deliberately NOT added (no repo ground truth). Add it
      // here when a rail needs it (docs/TOKEN-RESOLVER.md).
    }),
  }),

  // ── cbBTC.X (X1 Warp-wrapped cbBTC) ──────────────────────────────────────
  "cbBTC.X": Object.freeze({
    symbol: "cbBTC.X",
    name: "cbBTC.X (X1 Warp-wrapped cbBTC)",
    kind: "token",
    warpTwin: "cbBTC",
    entries: Object.freeze({
      x1: Object.freeze({ chain: "x1", address: "s47zmcZNFkZkdJqgZxZSBvXb8wRx89HgVGXt5Pf791K", decimals: 8, program: "token-2022", rails: Object.freeze(["warp"]), listed: false, note: "Engine/reverse rail only today (not in the v2 picker) — live Warp config 2026-09-03, no live burns yet" }),
    }),
  }),

  // ── wXNT (X1 wrapped native) ─────────────────────────────────────────────
  wXNT: Object.freeze({
    symbol: "wXNT",
    name: "Wrapped XNT (X1 native wrap)",
    kind: "token",
    entries: Object.freeze({
      x1: Object.freeze({ chain: "x1", address: "So11111111111111111111111111111111111111112", decimals: 9, program: "spl", rails: Object.freeze(["xdex"]), listed: false, note: "X1's native-wrap mint is the SAME canonical spl-token all-0x01 pubkey as Solana's WSOL — per-chain semantics differ (wraps XNT on X1). Ground truth: verified live xdex wXNT/USDC.x swap golden fixture (2026-09-03), pool CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR" }),
    }),
  }),

  // ── XNT (X1 native gas) ──────────────────────────────────────────────────
  XNT: Object.freeze({
    symbol: "XNT",
    name: "XNT (X1 native token)",
    kind: "native",
    entries: Object.freeze({
      x1: Object.freeze({ chain: "x1", address: null, decimals: 9, program: "native", rails: Object.freeze(["native"]), listed: false, note: "X1 chain gas — no mint (0.001 XNT = 1_000_000 lamports per the X1 fee-payer preflight). The brief's 'land as XNT' toggle is parked; wXNT is its wrapped xdex form" }),
    }),
  }),

  // ── THORChain lane natives (source-side assets of the THORChain hop) ─────
  BTC: Object.freeze({
    symbol: "BTC",
    name: "Bitcoin",
    kind: "native",
    thorchainAsset: "BTC.BTC",
    entries: Object.freeze({
      btc: Object.freeze({ chain: "btc", address: null, decimals: 8, program: "native", rails: Object.freeze(["thorchain"]), listed: false }),
    }),
  }),
  DOGE: Object.freeze({
    symbol: "DOGE",
    name: "Dogecoin",
    kind: "native",
    thorchainAsset: "DOGE.DOGE",
    entries: Object.freeze({
      doge: Object.freeze({ chain: "doge", address: null, decimals: 8, program: "native", rails: Object.freeze(["thorchain"]), listed: false }),
    }),
  }),
  LTC: Object.freeze({
    symbol: "LTC",
    name: "Litecoin",
    kind: "native",
    thorchainAsset: "LTC.LTC",
    entries: Object.freeze({
      ltc: Object.freeze({ chain: "ltc", address: null, decimals: 8, program: "native", rails: Object.freeze(["thorchain"]), listed: false }),
    }),
  }),
  XRP: Object.freeze({
    symbol: "XRP",
    name: "XRP",
    kind: "native",
    thorchainAsset: "XRP.XRP",
    entries: Object.freeze({
      xrp: Object.freeze({ chain: "xrp", address: null, decimals: 6, program: "native", rails: Object.freeze(["thorchain"]), listed: false }),
    }),
  }),

  // ── RESERVED SYMBOLS — no ground truth yet (2026-09-05) ──────────────────
  // These rows exist so the canonical list documents intent, but with no
  // chain entries they RESOLVE TO NULL everywhere (never a guess). Fill in a
  // per-chain entry only when a rail actually references the token and the
  // mint/contract is verified — see docs/TOKEN-RESOLVER.md.
  DGN: Object.freeze({
    symbol: "DGN",
    name: "DGN",
    kind: "token",
    status: "unverified",
    entries: Object.freeze({}),
  }),
  xencat: Object.freeze({
    symbol: "xencat",
    name: "xencat",
    kind: "token",
    status: "unverified",
    entries: Object.freeze({}),
  }),
});

// ────────────────────────────────────────────────────────────────────────────
// RESOLVER — the public API
// ────────────────────────────────────────────────────────────────────────────

/** Normalize an address for index matching: erc20 hex is case-insensitive
 *  (checksummed/upper/lower all match); spl/token-2022/trc20 addresses are
 *  base58 and case-SENSITIVE (never lowercase them); native entries have no
 *  address. */
function normalizeAddress(address, program) {
  if (typeof address !== "string") return null;
  if (program === "erc20") return address.toLowerCase();
  return address; // base58 (spl, token-2022, trc20) — exact match only
}

/** The {chain|address} → {symbol, entry} lookup index, built once at load. */
const BY_ADDRESS_INDEX = (() => {
  const index = new Map();
  for (const row of Object.values(TOKEN_TABLE)) {
    for (const entry of Object.values(row.entries)) {
      const norm = normalizeAddress(entry.address, entry.program);
      if (!norm) continue; // native assets + unresolved TODO entries
      index.set(`${entry.chain}|${norm}`, { symbol: row.symbol, entry });
    }
  }
  return index;
})();

/** EVM contract addresses are 0x + 40 hex chars. Shape-testing is not
 *  guessing: erc20 is the ONLY standard stored as 0x-hex (spl/token-2022 are
 *  base58 and can never start with "0x"; tron is stored base58 in this app).
 *  Everything that looks like 0x-hex matches case-insensitively; everything
 *  else matches exactly (base58 is case-sensitive). */
const EVM_HEX40 = /^0[xX][0-9a-fA-F]{40}$/;

/** True when the row/entry pair is actually resolvable: an entry whose
 *  non-native address is still null (unverified TODO) must NOT resolve. */
function resolvableEntry(entry) {
  if (!entry) return false;
  if (entry.program !== "native" && entry.address == null) return false;
  return true;
}

/** Enrich a raw entry with its canonical row context — the shape every
 *  consumer reads. */
function enrich(row, entry) {
  return {
    symbol: row.symbol,
    name: row.name,
    kind: row.kind,
    chain: entry.chain,
    address: entry.address,
    decimals: entry.decimals,
    program: entry.program,
    rails: entry.rails,
    listed: entry.listed,
    warpTwin: row.warpTwin ?? null,
    coingeckoId: row.coingeckoId ?? null,
    thorchainAsset: row.thorchainAsset ?? null,
    note: entry.note ?? null,
  };
}

/**
 * resolve(symbol, chain) → the canonical per-chain entry (enriched) or null.
 *   resolve("USDC", "sol")   → Solana USDC entry
 *   resolve("USDC.x", "x1")  → X1 USDC.x entry
 * Never throws. Unknown symbol, unknown chain, or an unresolved TODO entry →
 * null. Symbols are exact-match (case-sensitive): "WSOL" ≠ "wsol",
 * "USDC.x" ≠ "USDC.X".
 */
export function resolve(symbol, chain) {
  const row = TOKEN_TABLE[symbol];
  if (!row) return null;
  const entry = row.entries[chain];
  if (!resolvableEntry(entry)) return null;
  return enrich(row, entry);
}

/**
 * resolveByAddress(address, chain) → { symbol, entry } or null.
 *   - erc20 (EVM): case-insensitive — checksummed, UPPER or lower all match
 *   - spl / token-2022 / trc20: base58 — exact match (case-sensitive)
 *   - unknown address / unknown chain → null (never throws)
 */
export function resolveByAddress(address, chain) {
  if (typeof address !== "string" || !address || typeof chain !== "string" || !chain) return null;
  const isEvmHex = EVM_HEX40.test(address);
  const norm = isEvmHex ? address.toLowerCase() : address;
  const hit = BY_ADDRESS_INDEX.get(`${chain}|${norm}`);
  if (!hit) return null;
  return { symbol: hit.symbol, entry: enrich(TOKEN_TABLE[hit.symbol], hit.entry) };
}

/**
 * resolveTwin(symbol, chain?) → the other side of the Warp pair, or null.
 *   resolveTwin("USDC")   → "USDC.x"      resolveTwin("USDC.x") → "USDC"
 *   resolveTwin("WSOL")   → "wSOL.X"      resolveTwin("wSOL.X") → "WSOL"
 *   resolveTwin("ETH")    → "ETH.X"       resolveTwin("ETH.X")  → "ETH"
 *   resolveTwin("cbBTC")  → "cbBTC.X"     resolveTwin("cbBTC.X") → "cbBTC"
 * When a chain is supplied the twin relation is only answered on the SVM
 * sides (sol/x1) — an EVM USDC has no Warp twin:
 *   resolveTwin("USDC", "eth") → null;  resolveTwin("USDC", "sol") → "USDC.x"
 * Non-pair symbols (USDT, DAI, BTC, XNT, …) → null. Never throws.
 */
export function resolveTwin(symbol, chain) {
  const row = TOKEN_TABLE[symbol];
  if (!row || !row.warpTwin) return null;
  if (chain && chain !== "sol" && chain !== "x1") return null;
  return row.warpTwin;
}

/**
 * requireToken(symbol, chain) — the ONE throwing resolver, for money-path
 * CONSTANTS modules (warpBridge.js fee/registry tables, teleportConstants'
 * projection source). resolve() returns null for unknowns; these tables
 * cannot ship a null mint silently, so requireToken throws a descriptive
 * Error at import time when a pinned entry is missing/misnamed. Not for
 * user-facing flows — those call resolve().
 */
export function requireToken(symbol, chain) {
  const entry = resolve(symbol, chain);
  if (!entry) {
    throw new Error(
      `tokenResolver.requireToken: no resolvable entry for ${JSON.stringify(symbol)} on ${JSON.stringify(chain)} — ` +
      `check TOKEN_TABLE (a non-native entry needs a verified address).`,
    );
  }
  return entry;
}

/** All canonical symbols, in table order (documentation/index helper). */
export function canonicalSymbols() {
  return Object.keys(TOKEN_TABLE);
}

/** Is `chain` one of the resolver's known chain ids? */
export function isKnownChain(chain) {
  return Object.prototype.hasOwnProperty.call(CHAIN_META, chain);
}
