/**
 * teleportQuote.test.js — pure quote-building for the v2 Teleport tab (Phase
 * 3 bridge form).
 *
 * Pins the money-touching core of the ported EVM→X1 quote flow:
 *   - the LiFi query is x1-class: fee key OMITTED entirely (absent means
 *     absent — never fee=0; the stage-2 skim is the only Teleporter fee on
 *     x1-class routes), x1Class=1 marker, cross-VM direct (allowSwitchChain
 *     false), and the real connected wallet addresses (NO PLACEHOLDERS — a
 *     missing address returns null so the UI prompts to connect),
 *   - the quote-box fee picture comes from computeFee via quoteFees (the
 *     single source): the 0.5% Teleporter skim (leg-1-delivered base — on what
 *     LiFi actually delivers) + Warp's $1 third-party line, and "you receive"
 *     nets both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLifiQuoteParams, deriveQuoteFromLifi } from "./teleportQuote.js";

const EVM_ADDR = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";
const SOL_ADDR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

test("buildLifiQuoteParams: x1-class EVM→X1 query — fee OMITTED, x1Class=1, cross-VM direct", () => {
  const { qs, decimals, feeUsed } = buildLifiQuoteParams({
    from: "eth", token: "USDC", amount: 100, fromAddress: EVM_ADDR, toAddress: SOL_ADDR,
  });
  assert.equal(qs.get("fromChain"), "eth");
  assert.equal(qs.get("toChain"), "SOL", "the LiFi leg lands USDC on Solana");
  assert.equal(qs.get("fromToken"), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(qs.get("toToken"), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(qs.get("fromAmount"), "100000000", "100 USDC at 6 decimals");
  assert.equal(qs.get("fromAddress"), EVM_ADDR, "real connected EVM address (no placeholders)");
  assert.equal(qs.get("toAddress"), SOL_ADDR, "real connected Solana address (no placeholders)");
  assert.equal(qs.get("allowSwitchChain"), "false", "cross-VM hop goes source→Solana direct");
  assert.equal(qs.get("x1Class"), "1", "x1-class marker — the server validates + strips it");
  assert.equal(qs.has("fee"), false, "x1-class OMITS the fee key entirely — absent means absent");
  assert.equal(qs.get("integrator"), "x1-teleporter-labs");
  assert.equal(decimals, 6);
  assert.equal(feeUsed, null);
});

test("buildLifiQuoteParams: NO PLACEHOLDERS — null without real connected addresses", () => {
  assert.equal(
    buildLifiQuoteParams({ from: "eth", token: "USDC", amount: 100, fromAddress: null, toAddress: SOL_ADDR }),
    null,
  );
  assert.equal(
    buildLifiQuoteParams({ from: "eth", token: "USDC", amount: 100, fromAddress: EVM_ADDR, toAddress: "" }),
    null,
  );
});

test("buildLifiQuoteParams: unknown chain/token → null (never a broken URL)", () => {
  assert.equal(
    buildLifiQuoteParams({ from: "nope", token: "USDC", amount: 100, fromAddress: EVM_ADDR, toAddress: SOL_ADDR }),
    null,
  );
  assert.equal(
    buildLifiQuoteParams({ from: "eth", token: "NOPE", amount: 100, fromAddress: EVM_ADDR, toAddress: SOL_ADDR }),
    null,
  );
});

test("buildLifiQuoteParams: raw amount floors at base units (no fractional dust)", () => {
  const { qs } = buildLifiQuoteParams({
    from: "eth", token: "USDC", amount: 100.9999, fromAddress: EVM_ADDR, toAddress: SOL_ADDR,
  });
  assert.equal(qs.get("fromAmount"), "100999900");
});

test("deriveQuoteFromLifi: fee lines from quoteFees — 0.5% skim (max $250) + Warp's fee, net honest", () => {
  // LiFi delivers $99 on Solana for a $100 input (slippage/gas already netted).
  const q = deriveQuoteFromLifi({ data: { estimate: { toAmount: "99000000" } }, from: "eth", token: "USDC", amount: 100 });
  assert.equal(q.out, 99);
  assert.equal(q.solanaAmount, 99, "stage 2 bridges what LiFi DELIVERED, not the original input");

  const skim = q.feeLines.find((l) => l.id === "warp-skim");
  assert.ok(skim, "warp-skim line present");
  assert.equal(skim.label, "Teleporter fee (0.5%, max $250)");
  assert.equal(skim.party, "teleporter");
  assert.ok(Math.abs(skim.amountUsd - 0.495) < 1e-9, "0.5% skim on the DELIVERED amount (leg-1-delivered base)");

  const flat = q.feeLines.find((l) => l.id === "warp-flat");
  assert.ok(flat, "warp-flat line present");
  assert.equal(flat.label, "Warp bridge fee ($1 flat)");
  assert.equal(flat.party, "third-party", "Warp's $1 is a pass-through, never a Teleporter fee");
  assert.equal(flat.amountUsd, 1);

  assert.ok(Math.abs(q.net - 97.505) < 1e-9, "net = delivered − 0.5% skim − $1");
  assert.equal(q.recvToken, "USDC.x");
  assert.equal(q.recvChain, "X1");
  assert.deepEqual(
    q.steps.map((s) => s.tool),
    ["LiFi", "Warp Bridge"],
  );
});

test("deriveQuoteFromLifi: malformed response throws (no silent NaN quote)", () => {
  assert.throws(() => deriveQuoteFromLifi({ data: {}, from: "eth", token: "USDC", amount: 100 }), /Malformed/);
  assert.throws(() => deriveQuoteFromLifi({ data: { estimate: {} }, from: "eth", token: "USDC", amount: 100 }), /Malformed/);
});

// ── FORWARD LEG PER-ASSET WARP FEE — pct default for every non-USDC.x dest ──
// deriveQuoteFromLifi keys the warp-flat/warp-pct selection off destToken:
// flat $1 ONLY for USDC.x; every other destination (wSOL.X today; ETH.X /
// cbBTC.X / any future X1 token) is 25 bps pct — warpFeeBps is passed for
// anything that is not USDC.x, so an unknown destination can never default
// to the flat $1 (Mr. Esters' verified structure, 2026-09-02).

test("deriveQuoteFromLifi (wSOL.X): warp-pct 0.25% line replaces the flat $1 (unchanged)", () => {
  const q = deriveQuoteFromLifi({ data: { estimate: { toAmount: "99000000000" } }, from: "eth", token: "USDC", amount: 100, destToken: "wSOL.X" });
  assert.equal(q.out, 99, "WSOL landing decoded at 9 decimals");
  const pct = q.feeLines.find((l) => l.id === "warp-pct");
  assert.ok(pct, "warp-pct line present for wSOL.X");
  assert.equal(pct.label, "Warp bridge fee (0.25%)");
  assert.equal(q.feeLines.find((l) => l.id === "warp-flat"), undefined, "no flat $1 line");
  assert.equal(q.recvToken, "wSOL.X");
});

test("deriveQuoteFromLifi (unknown/non-USDC dest, e.g. ETH.X): warp-pct 0.25% — the pct default, never flat $1", () => {
  const q = deriveQuoteFromLifi({ data: { estimate: { toAmount: "99000000" } }, from: "eth", token: "USDC", amount: 100, destToken: "ETH.X" });
  const pct = q.feeLines.find((l) => l.id === "warp-pct");
  assert.ok(pct, "a non-USDC.x destination shows warp-pct");
  assert.equal(pct.label, "Warp bridge fee (0.25%)");
  assert.ok(Math.abs(pct.amountUsd - 99 * 0.0025) < 1e-9, "0.25% of the delivered amount — not the $1 flat");
  assert.equal(q.feeLines.find((l) => l.id === "warp-flat"), undefined, "flat $1 is USDC.x-ONLY");
  assert.equal(q.recvToken, "ETH.X", "destToken flows through to recvToken");
});

test("deriveQuoteFromLifi (USDC.x): flat $1 unchanged — the ONLY flat destination", () => {
  const q = deriveQuoteFromLifi({ data: { estimate: { toAmount: "99000000" } }, from: "eth", token: "USDC", amount: 100 });
  assert.ok(q.feeLines.find((l) => l.id === "warp-flat"), "USDC.x keeps warp-flat");
  assert.equal(q.feeLines.find((l) => l.id === "warp-pct"), undefined);
});
