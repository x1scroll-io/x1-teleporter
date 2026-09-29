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
 * option is never iconless.
 */
export function tokenIcon(symbol) {
  const s = String(symbol ?? "");
  const spec = ICON_SPECS[s] ?? ICON_SPECS[s.toUpperCase()];
  if (spec) return badge(spec[0], spec[1]);
  const glyph = (s[0] || "?").toUpperCase();
  return badge(DEFAULT_ICON_COLOR, glyph);
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
 *          balances?: Object<string, number>, icon?: (s: string) => string}} [opts]
 * @returns {Array<{symbol: string, icon: string, usdText: string,
 *   amountText: string, label: string}>} one entry per symbol, in order. The
 *   `label` is the plain-text option caption ("SYMBOL · $X · AMOUNT") used by
 *   the native <option>; the icon rides alongside the control.
 */
export function buildTokenOptions({ symbols = [], prices = {}, balances = {}, icon = tokenIcon } = {}) {
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
      usdText,
      amountText,
      label: `${symbol} · ${usdText} · ${amountText}`,
    };
  });
}
