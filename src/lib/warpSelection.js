/**
 * warpSelection.js — TOKEN-AWARE Warp selection for the wallet's in-wallet Warp
 * UI (src/popup.ts).
 *
 * WHY THIS EXISTS
 *   The Warp executor (src/teleporter/warpBridge.js) and the quote layer
 *   (reverseQuote.js / tokenResolver.js) already wire ALL 13 Warp tokens
 *   (USDC, wSOL, cbBTC, ETH + the 9 xStocks) with their per-token mints,
 *   decimals, fee shapes and 1.5× floors. But the popup built every in-wallet
 *   Warp leg as USDC.x (reverse) / USDC (forward) — the floors and per-token
 *   fee shapes never reached the UI. This module is the ONE place the popup
 *   asks "which Warp token did the user actually select?" and "what is its
 *   Solana twin / fee shape?" so the resolved token can flow into
 *   planReverseRelease / warpReverse / warpForward + the balance reads + the
 *   fee display.
 *
 * PURE MODULE: imports only the canonical identity registry (tokenResolver.js)
 * and the pure fee-shape lookup (reverseQuote.js). No DOM, no wallet, no
 * @solana, no network, no keys — runnable under `node --test` and bundleable
 * in the popup.
 *
 * CANONICAL, NEVER GUESSED: the token set is DERIVED from tokenResolver's
 * TOKEN_TABLE (rows that carry an X1 warp entry + a Solana warp twin), so a
 * mistyped mint/decimals cannot appear here — it would have failed in the
 * registry first. USDC.x / USDC stay the DEFAULT fallback so the pre-existing
 * USDC-only flow never regresses.
 */
import { TOKEN_TABLE } from "./tokenResolver.js";
import { x1WarpFeeShape } from "./reverseQuote.js";

/** Default reverse (X1-side) Warp token + its Solana twin. */
const DEFAULT_X1_SYMBOL = "USDC.x";

/**
 * The 13 wired Warp tokens, DERIVED from the canonical registry: every row
 * whose X1 entry rides the "warp" rail AND has a declared warpTwin. This is
 * exactly USDC.x/wSOL.X/ETH.X/cbBTC.X + the 9 xStock twins (SPCXx…GOOGLx) —
 * the same set warpBridge.js X1_FORWARD_TOKENS/X1_REVERSE_TOKENS key on.
 * Each entry carries BOTH sides' identity so the popup can move either way.
 */
export const WARP_X1_TOKENS = Object.freeze(
  Object.values(TOKEN_TABLE)
    .filter((row) => {
      const e = row.entries && row.entries.x1;
      return row.warpTwin && e && Array.isArray(e.rails) && e.rails.includes("warp");
    })
    .map((row) => {
      const x1 = row.entries.x1;
      const sol = (TOKEN_TABLE[row.warpTwin] && TOKEN_TABLE[row.warpTwin].entries.sol) || null;
      const fee = x1WarpFeeShape(row.symbol);
      return Object.freeze({
        x1Symbol: row.symbol,          // the key warpBridge/planReverseRelease expect
        name: row.name,
        x1Mint: x1.address,
        decimals: x1.decimals,
        program: x1.program,
        listed: x1.listed === true,    // the registry's v2-picker flag (ETH.X/cbBTC.X are engine-only → false)
        solSymbol: row.warpTwin,       // the Solana twin symbol
        solMint: sol ? sol.address : null,
        solDecimals: sol ? sol.decimals : x1.decimals,
        feeKind: fee.kind,             // "flat" | "pct"
        feeBps: fee.kind === "pct" ? fee.bps : null,
      });
    }),
);

const BY_X1_MINT = new Map(WARP_X1_TOKENS.map((t) => [t.x1Mint, t]));
const BY_X1_SYMBOL = new Map(WARP_X1_TOKENS.map((t) => [t.x1Symbol.toUpperCase(), t]));
const BY_SOL_MINT = new Map(WARP_X1_TOKENS.filter((t) => t.solMint).map((t) => [t.solMint, t]));
const BY_SOL_SYMBOL = new Map(WARP_X1_TOKENS.map((t) => [t.solSymbol.toUpperCase(), t]));
const DEFAULT_X1 = BY_X1_SYMBOL.get(DEFAULT_X1_SYMBOL.toUpperCase());

/** The wired Warp token whose X1 mint is `mint` (or null). */
export function warpTokenByX1Mint(mint) {
  return (typeof mint === "string" && BY_X1_MINT.get(mint)) || null;
}
/** The wired Warp token whose X1 symbol (case-insensitive) is `symbol` (or null). */
export function warpTokenByX1Symbol(symbol) {
  return (typeof symbol === "string" && BY_X1_SYMBOL.get(symbol.trim().toUpperCase())) || null;
}
/** The wired Warp token whose Solana mint is `mint` (or null). */
export function warpTokenBySolMint(mint) {
  return (typeof mint === "string" && BY_SOL_MINT.get(mint)) || null;
}
/** The wired Warp token whose Solana symbol (case-insensitive) is `symbol` (or null). */
export function warpTokenBySolSymbol(symbol) {
  return (typeof symbol === "string" && BY_SOL_SYMBOL.get(symbol.trim().toUpperCase())) || null;
}

/**
 * Resolve the REVERSE (X1-side) Warp token from what the UI selected. Accepts
 * an X1 mint address, an X1 symbol label ("USDC.x"/"SPCXx"), a Solana-side
 * label, or nothing. Falls back to USDC.x — the pre-existing default — so an
 * unrecognised/native selection never breaks the off-ramp.
 * Never throws.
 */
export function resolveReverseWarpToken({ mint, label } = {}) {
  return (
    warpTokenByX1Mint(mint) ||
    warpTokenByX1Symbol(label) ||
    warpTokenBySolSymbol(label) ||
    DEFAULT_X1
  );
}

/**
 * Resolve the FORWARD (Solana-side) Warp token from what the UI selected.
 * Accepts a Solana mint address, a Solana label ("USDC"/"wSOL"/"SPCX"), an
 * X1-side label, or nothing. Falls back to USDC — the pre-existing default —
 * so a native/native selection still bridges the live Solana USDC balance.
 * Never throws.
 */
export function resolveForwardWarpToken({ mint, label } = {}) {
  return (
    warpTokenBySolMint(mint) ||
    warpTokenBySolSymbol(label) ||
    warpTokenByX1Symbol(label) ||
    BY_SOL_SYMBOL.get("USDC")
  );
}

/** True when a Warp fee is a flat charge (only USDC.x/USDC) vs a pct. */
export function isFlatWarpFee(token) {
  const t = typeof token === "string" ? (warpTokenByX1Symbol(token) || warpTokenBySolSymbol(token)) : token;
  return !!t && t.feeKind === "flat";
}

/**
 * Human fee label for a Warp token — "US$1 flat" (USDC.x/USDC only) or
 * "0.25% (SYM)". Used by the forward/reverse fee rows so the displayed shape
 * matches the per-token fee the executor actually charges.
 */
export function warpFeeText(token) {
  const t = typeof token === "string" ? (warpTokenByX1Symbol(token) || warpTokenBySolSymbol(token)) : token;
  if (!t) return "US$1 flat (USDC.x)";
  return t.feeKind === "flat" ? `US$1 flat (${t.x1Symbol})` : `${(t.feeBps ?? 25) / 100}% (${t.x1Symbol})`;
}

/** The Solana-side twin mint for an X1 Warp symbol (or null). */
export function warpSolMintFor(x1Symbol) {
  const t = warpTokenByX1Symbol(x1Symbol);
  return t ? t.solMint : null;
}
/** The X1-side twin mint for a Solana Warp symbol/mint (or null). */
export function warpX1MintFor(solSymbolOrMint) {
  const t = warpTokenBySolSymbol(solSymbolOrMint) || warpTokenBySolMint(solSymbolOrMint);
  return t ? t.x1Mint : null;
}

/**
 * True when EITHER selected mint is one of the wired Warp tokens. The popup
 * uses this to keep a direct wired-pair warp (wSOL↔wSOL.X, cbBTC↔cbBTC.X, the
 * 9 stocks, …) on the DEDICATED in-wallet Warp lane instead of letting the
 * USDC-spine composer reroute it through DEX legs.
 */
export function isWiredWarpSelection(...mints) {
  return mints.some((m) => !!warpTokenByX1Mint(m) || !!warpTokenBySolMint(m));
}

/**
 * True when the two mints are the two OPPOSITE sides of ONE wired Warp pair
 * (Solana mint ↔ its X1 twin) — e.g. (cbBTC sol mint, cbBTC.X x1 mint). Order
 * does not matter. Used to decide a DIRECT warp is intended (source token and
 * destination token are twins) vs an unrelated compose. Never throws.
 */
export function isWarpTwinPair(mintA, mintB) {
  if (!mintA || !mintB) return false;
  const bySol = warpTokenBySolMint(mintA);
  if (bySol && bySol.x1Mint === mintB) return true;
  const byX1 = warpTokenByX1Mint(mintA);
  if (byX1 && byX1.solMint === mintB) return true;
  return false;
}

/**
 * Selector options for the SOLANA picker — the Solana-side members of every
 * wired pair. `value` is the Solana mint (what the picker stores), `label` the
 * Solana symbol, `dec` its decimals.
 */
export function warpSolSelectorOptions() {
  return WARP_X1_TOKENS
    .filter((t) => t.solMint)
    .map((t) => ({ label: t.solSymbol, value: t.solMint, dec: t.solDecimals }));
}

/**
 * Selector options for the X1 picker — the X1-side members of every wired
 * pair. `value` is the X1 mint, `label` the X1 symbol ("USDC.x"/"SPCXx"…),
 * `dec` its decimals. Respects the registry's `listed` flag so engine-only
 * rails (ETH.X / cbBTC.X — `listed:false`, "not in the v2 picker") never leak
 * into the dropdown: the X1 picker lists exactly the canonical v2 tokens
 * (USDC.x/wSOL.X/SPCXx…GOOGLx).
 */
export function warpX1SelectorOptions() {
  return WARP_X1_TOKENS
    .filter((t) => t.listed)
    .map((t) => ({ label: t.x1Symbol, value: t.x1Mint, dec: t.decimals }));
}

/**
 * ── ONWARD leg (X1 reverse off-ramp → Solana source → non-Solana dest) ───────
 *
 * After an X1 → (Warp) → Solana reverse lands a token, the wallet retargets at
 * the Solana SOURCE and the user finishes the hop in-wallet through ChangeNow
 * (ADA/TRX/SUI/APT) or THORChain. The source the user actually holds is the
 * RELEASED Solana twin (wSOL / cbBTC / ETH / an xStock), NOT always USDC — so
 * the onward rail must key on THAT token.
 *
 * ChangeNow source tickers for the wired twins, VERIFIED against the live
 * currency list (GET api.changenow.io/v2/exchange/currencies, 2026-09-20) by
 * matching each twin's Solana MINT to a `network:"sol"` row's tokenContract.
 * ChangeNow lists Solana sources for USDC and 7 of the 9 xStocks; it does NOT
 * list wSOL, cbBTC, Solana-ETH, PLTR or AMD — those have NO onward ChangeNow
 * rail and MUST degrade (the popup never preselects the wrong coin). Keyed by
 * the twin's Solana SYMBOL (uppercased).
 */
export const ONWARD_CHANGENOW_SOL_TICKERS = Object.freeze({
  USDC: "usdc",
  SPCX: "spcxx", META: "metax", TSLA: "tslax", COIN: "coinx",
  NVDA: "nvdax", SPY: "spyx", GOOGL: "googlx",
});

/** The ChangeNow Solana-source ticker for a wired twin's symbol/mint (or null). */
export function onwardChangeNowTicker(solSymbolOrMint) {
  const t = warpTokenBySolSymbol(solSymbolOrMint) || warpTokenBySolMint(solSymbolOrMint);
  const sym = String(t ? t.solSymbol : (solSymbolOrMint ?? "")).trim().toUpperCase();
  return ONWARD_CHANGENOW_SOL_TICKERS[sym] || null;
}

/**
 * Resolve the ONWARD Solana source for a reverse off-ramp from the RELEASED
 * Solana twin (`released` = `{ solMint, solSymbol, solDecimals }`; omitted ⇒
 * USDC, preserving the pre-existing USDC.x flow byte-for-byte). Returns the
 * canonical twin identity + whether ChangeNow has an onward rail for it, so the
 * popup can preselect the token that ACTUALLY landed (or degrade cleanly when
 * there is no rail) instead of hardcoding USDC. Never throws.
 */
export function resolveOnwardSolanaSource(released) {
  const provided = !!(released && (released.solMint || released.solSymbol));
  const t = released && (warpTokenBySolMint(released.solMint) || warpTokenBySolSymbol(released.solSymbol));
  if (!t && provided) {
    // An unrecognised released token: do NOT silently preselect USDC.
    return Object.freeze({
      solMint: released.solMint ?? null, solSymbol: released.solSymbol ?? null,
      solDecimals: released.solDecimals ?? null,
      changeNowTicker: null, changeNowSupported: false,
    });
  }
  const tok = t || BY_SOL_SYMBOL.get("USDC");
  const ticker = ONWARD_CHANGENOW_SOL_TICKERS[String(tok.solSymbol).toUpperCase()] ?? null;
  return Object.freeze({
    solMint: tok.solMint, solSymbol: tok.solSymbol, solDecimals: tok.solDecimals,
    changeNowTicker: ticker, changeNowSupported: !!ticker,
  });
}
