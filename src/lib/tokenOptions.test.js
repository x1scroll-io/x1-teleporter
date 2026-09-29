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

test("format helpers: null-safe", () => {
  assert.equal(formatUsdText(null), "—");
  assert.equal(formatUsdText(undefined), "—");
  assert.equal(formatUsdText(1.239), "$1.24");
  assert.equal(formatTokenAmount(null), "—");
  assert.equal(formatTokenAmount(0), "0");
  assert.equal(formatTokenAmount(1.5), "1.5");
});
