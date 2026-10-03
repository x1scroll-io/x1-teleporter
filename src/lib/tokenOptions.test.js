/**
 * tokenOptions.test.js — the token picker view-models (icon + symbol + $ value
 * + amount per option). Pure, no DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTokenOptions,
  formatTokenAmount,
  formatUsdText,
  tokenIcon,
  tokenLogo,
  TOKEN_LOGOS,
} from "./tokenOptions.js";

test("buildTokenOptions: every option carries symbol + icon + $ value + amount", () => {
  const opts = buildTokenOptions({
    symbols: ["USDC", "USDT", "DAI"],
    prices: { USDC: 1, USDT: 1, DAI: 1 },
    balances: { USDC: 25.5, USDT: 0, DAI: 10 },
  });
  assert.deepEqual(opts.map((o) => o.symbol), ["USDC", "USDT", "DAI"], "order preserved");
  for (const o of opts) {
    assert.ok(typeof o.icon === "string" && o.icon.startsWith("data:image/svg+xml"), `${o.symbol}: icon is a data URI`);
    assert.ok(o.label.startsWith(`${o.symbol} · `), `${o.symbol}: label leads with the symbol`);
  }
  const usdc = opts[0];
  assert.equal(usdc.amountText, "25.5");
  assert.equal(usdc.usdText, "$25.50");
  assert.equal(usdc.label, "USDC · $25.50 · 25.5");
  // An honest zero shows "0" — not blank.
  assert.equal(opts[1].amountText, "0");
  assert.equal(opts[1].usdText, "$0.00");
});

test("buildTokenOptions: no balance yet → amount '—' (never blank); no price → value '—' (never fabricated)", () => {
  const opts = buildTokenOptions({
    symbols: ["USDC", "USDT"],
    prices: { USDC: 1 }, // USDT has NO price
    balances: { USDC: 5 }, // USDT has NO balance
  });
  const [usdc, usdt] = opts;
  assert.equal(usdc.amountText, "5");
  assert.equal(usdc.usdText, "$5.00");
  assert.equal(usdt.amountText, "—", "no balance → dash, never blank");
  assert.equal(usdt.usdText, "—", "no price → dash, never a fabricated value");
  assert.equal(usdt.label, "USDT · — · —");
});

test("buildTokenOptions: a balance without a price still shows the amount (no invented USD)", () => {
  const [o] = buildTokenOptions({
    symbols: ["USDC"],
    prices: {}, // no price at all
    balances: { USDC: 42 },
  });
  assert.equal(o.amountText, "42");
  assert.equal(o.usdText, "—");
  assert.equal(o.label, "USDC · — · 42");
});

test("tokenIcon: known tokens get distinct branded badges; unknown gets a neutral letter badge (never iconless)", () => {
  const usdc = tokenIcon("USDC");
  const usdt = tokenIcon("USDT");
  assert.ok(usdc.startsWith("data:image/svg+xml"));
  assert.ok(usdt.startsWith("data:image/svg+xml"));
  assert.notEqual(usdc, usdt, "different tokens → different icons");
  const unknown = tokenIcon("FOO");
  assert.ok(unknown.startsWith("data:image/svg+xml"), "unknown symbol still yields an icon");
  assert.equal(tokenIcon(""), tokenIcon(""), "deterministic");
});

test("buildTokenOptions: every option carries a `logo` field (real URL or null) alongside the badge icon", () => {
  const opts = buildTokenOptions({ symbols: ["USDC", "FOO"] });
  assert.ok(opts[0].logo && /^https:\/\//.test(opts[0].logo), "USDC has a real logo URL");
  assert.equal(opts[1].logo, null, "an unknown symbol has no logo → null (badge is the fallback)");
  for (const o of opts) {
    assert.ok(o.icon.startsWith("data:image/svg+xml"), `${o.symbol}: badge icon is still a data URI (always renderable)`);
  }
});

test("tokenLogo: known brand symbols resolve to real URLs; aliases + case-insensitive; unknown → null", () => {
  assert.ok(/^https:\/\//.test(tokenLogo("USDC")), "USDC logo");
  assert.ok(/^https:\/\//.test(tokenLogo("USDT")), "USDT logo");
  assert.ok(/^https:\/\//.test(tokenLogo("DAI")), "DAI logo");
  // X1 / wrapped aliases reuse the underlying asset's logo
  assert.equal(tokenLogo("USDC.x"), tokenLogo("USDC"), "USDC.x reuses the USDC logo");
  assert.equal(tokenLogo("wSOL.X"), tokenLogo("WSOL"), "wSOL.X reuses the WSOL logo");
  assert.equal(tokenLogo("usdc"), tokenLogo("USDC"), "lookup is case-insensitive");
  assert.equal(tokenLogo("FOO"), null, "unknown symbol → null");
  assert.equal(tokenLogo(""), null, "empty symbol → null");
});

test("TOKEN_LOGOS: every registered logo is an absolute https URL (no relative/data/local paths)", () => {
  for (const [sym, url] of Object.entries(TOKEN_LOGOS)) {
    assert.ok(/^https:\/\//.test(url), `${sym}: absolute https URL`);
  }
});

test("format helpers: null-safe", () => {
  assert.equal(formatUsdText(null), "—");
  assert.equal(formatUsdText(undefined), "—");
  assert.equal(formatUsdText(1.239), "$1.24");
  assert.equal(formatTokenAmount(null), "—");
  assert.equal(formatTokenAmount(0), "0");
  assert.equal(formatTokenAmount(1.5), "1.5");
});
