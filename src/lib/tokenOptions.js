/**
 * tokenOptions.js — PURE view-models for the token pickers (the From/To token
 * dropdowns in the Teleport Console + the classic bridge form).
 *
 * WHY THIS EXISTS
 *   The token <select> elements used to render ONLY the bare symbol
 *   (`<option>{t}</option>`). The route pickers must show, for every token in
 *   the origin→destination route, FOUR things: the token ICON, its SYMBOL, its
 *   live $ VALUE, and the user's TOKEN AMOUNT (balance). This module builds
 *   that per-option view-model so the rendering layer (TeleportConsole /
 *   TeleportForm via <TokenSelect/>) stays a thin map, and so the four fields
 *   are proven by node:test without a browser.
 *
 * HONESTY RULES (binding):
 *   - No balance yet → the amount renders "—" (never a blank option).
 *   - No USD price → the value renders "—" (never a fabricated price).
 *   - Every symbol gets an icon (a deterministic colour badge); the icon is
 *     presentational only — it never invents a price or a balance.
 *
 * No React, no DOM, no window — everything here is a pure function of
 * (symbols, prices, balances), so it runs under `node --test`.
 */

import { formatBalance } from "./balances.js";

/** Build an inline SVG data-URI badge (a filled circle + a short glyph). */
function badge(color, glyph) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="16" r="16" fill="${color}"/>` +
    `<text x="16" y="21" font-family="Arial,Helvetica,sans-serif" font-size="15" ` +
    `font-weight="700" fill="#ffffff" text-anchor="middle">${glyph}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Fallback colour for a symbol with no brand colour registered. */
const DEFAULT_ICON_COLOR = "#3a4a63";

/**
 * symbol → brand-ish colour + a 1-2 char glyph for the badge. These are
 * deterministic, self-contained placeholder marks (a coloured initial), NOT
 * official brand art and NOT a price/balance signal.
 */
const ICON_SPECS = Object.freeze({
  USDC: ["#2775CA", "$"],
  "USDC.e": ["#2775CA", "$"],
  "USDC.x": ["#2775CA", "$"],
  USDT: ["#26A17B", "₮"],
  DAI: ["#F5AC37", "D"],
  USDG: ["#00A9A5", "G"],
  WSOL: ["#9945FF", "S"],
  "wSOL.X": ["#9945FF", "S"],
  ETH: ["#627EEA", "Ξ"],
  BTC: ["#F7931A", "₿"],
  DOGE: ["#C2A633", "Ð"],
  LTC: ["#345D9D", "Ł"],
  XRP: ["#23292F", "X"],
});

/**
 * The icon (data-URI) for a token symbol. Always returns a usable icon — an
 * unknown symbol gets a neutral badge carrying its first letter, so a picker
 * option is never iconless. This is the FALLBACK used whenever a real logo is
 * missing OR fails to load (dead link, hotlink-block, CORS) — a token always
 * renders *something*.
 */
export function tokenIcon(symbol) {
  const s = String(symbol ?? "");
  const spec = ICON_SPECS[s] ?? ICON_SPECS[s.toUpperCase()];
  if (spec) return badge(spec[0], spec[1]);
  const glyph = (s[0] || "?").toUpperCase();
  return badge(DEFAULT_ICON_COLOR, glyph);
}

/**
 * Real brand logo URIs for the well-known tokens the bridge actually offers.
 * Hosted on TrustWallet's public asset CDN (raw.githubusercontent.com) — the
 * same git-hosted source Starport's Jupiter list uses. Best-effort only: any
 * token without a verified URL here falls back to the deterministic badge
 * (tokenIcon), and a URL that dies at runtime is caught by the <img> onError
 * → badge swap in <TokenIcon/>. Never a network call at import time.
 *
 * DELIBERATELY a plain symbol→URL map (no per-chain keying): the app's symbols
 * are globally unique (USDC vs USDC.x vs wSOL.X …), so one row per symbol is
 * sufficient and keeps the resolver trivial + testable.
 */
export const TOKEN_LOGOS = Object.freeze({
  USDC: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  "USDC.e": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  "USDC.x": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  USDT: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
  DAI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png",
  SOL: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
  WSOL: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
  "wSOL.X": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
  ETH: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  "ETH.X": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  BTC: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
  cbBTC: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
  "cbBTC.X": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png",
  LTC: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/litecoin/info/logo.png",
  SUI: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/sui/info/logo.png",
});

/**
 * The real brand logo URI for a symbol, or null when none is registered.
 * Pure + synchronous (no network). Callers render this as the <img> src and
 * keep tokenIcon(symbol) as the onError fallback.
 */
export function tokenLogo(symbol) {
  const s = String(symbol ?? "");
  return TOKEN_LOGOS[s] ?? TOKEN_LOGOS[s.toUpperCase()] ?? null;
}

/** Format a USD amount → "$1.00"; null / non-finite → "—" (never fabricated). */
export function formatUsdText(usd) {
  if (usd == null) return "—";
  const n = Number(usd);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

/** Format a human-unit token amount; null → "—" (never blank, never a fake 0). */
export function formatTokenAmount(amount) {
  if (amount == null) return "—";
  const formatted = formatBalance(amount);
  return formatted == null ? "—" : formatted;
}

/**
 * Build the picker view-models for a list of token symbols.
 *
 * @param {{symbols?: string[], prices?: Object<string, number>,
 *          balances?: Object<string, number>, icon?: (s: string) => string,
 *          logo?: (s: string) => (string|null)}} [opts]
 * @returns {Array<{symbol: string, icon: string, logo: (string|null),
 *   usdText: string, amountText: string, label: string}>} one entry per symbol,
 *   in order. `icon` is ALWAYS a usable data-URI badge; `logo` is the real
 *   brand logo URI when one is registered (null otherwise). The renderer draws
 *   `logo || icon` with an onError swap back to `icon`, so an option is never
 *   iconless. The `label` is the plain-text option caption ("SYMBOL · $X ·
 *   AMOUNT") used by the native <option>; the icon rides alongside the control.
 */
export function buildTokenOptions({ symbols = [], prices = {}, balances = {}, icon = tokenIcon, logo = tokenLogo } = {}) {
  return [...(symbols ?? [])].map((symbol) => {
    const bal = balances?.[symbol];
    const price = prices?.[symbol];
    const hasUsd = bal != null && price != null && Number.isFinite(Number(price));
    const usd = hasUsd ? Number(bal) * Number(price) : null;
    const usdText = formatUsdText(usd);
    const amountText = formatTokenAmount(bal);
    return {
      symbol,
      icon: icon(symbol),
      logo: logo(symbol) || null,
      usdText,
      amountText,
      label: `${symbol} · ${usdText} · ${amountText}`,
    };
  });
}
