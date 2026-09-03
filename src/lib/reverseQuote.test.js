/**
 * reverseQuote.test.js — pure tests for the REVERSE leg quote math
 * (src/lib/reverseQuote.js): the deterministic Stage-1 (X1 burn) math from
 * fees.ts, the LiFi SOL→EVM query params (x1-class: fee key OMITTED, no
 * placeholders), and the honest quote-box picture — including the handoff
 * case when the Solana→EVM leg can't be quoted live.
 *
 * Runs under node --test (pure module — no DOM, no chain).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeReverseLegs,
  buildReverseLifiQuoteParams,
  deriveReverseQuote,
  checkReverseMin,
  resolveReversePriceUSD,
  defaultPriceFetch,
} from "./reverseQuote.js";
import { FEE_RATES } from "./fees.ts";
import { CHAINS, TOKENS } from "./teleportConstants.js";

const SOL_ADDR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const EVM_ADDR = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";

// ── Stage-1 math: 0.5% once per journey (max $250) + Warp's own fee ────────

test("computeReverseLegs: 0.5% skim on source, burn = net, Solana net = burn − Warp's $1", () => {
  const legs = computeReverseLegs({ amount: 100 });
  assert.equal(legs.skim, 0.5);                      // 0.5% of 100
  assert.equal(legs.burnAmount, 99.5);               // bridge_out burns the net
  assert.equal(legs.netOnSolana, 98.5);              // 99.5 − Warp's flat $1 (deducted on-chain)
  assert.equal(FEE_RATES.X1_HOP_SKIM, 0.005, "rate sourced from fees.ts (0.5% — fee-model v2)");
  assert.equal(FEE_RATES.WARP_FLAT_USD, 1, "$1 sourced from fees.ts (USDC.x flat — verified on-chain)");
});

test("computeReverseLegs: fee lines are exactly 0.5% Teleporter + $1 Warp (no LiFi integrator on x1-class)", () => {
  const legs = computeReverseLegs({ amount: 100 });
  const ids = legs.feeQuote.feeLines.map((l) => l.id).sort();
  assert.deepEqual(ids, ["warp-flat", "warp-skim"]);
  const skim = legs.feeQuote.feeLines.find((l) => l.id === "warp-skim");
  assert.equal(skim.amountUsd, 0.5);
  assert.equal(skim.party, "teleporter");
  const flat = legs.feeQuote.feeLines.find((l) => l.id === "warp-flat");
  assert.equal(flat.amountUsd, 1);
  assert.equal(flat.party, "third-party");
  assert.equal(legs.feeQuote.teleporterFeeUsd, 0.5, "Teleporter take is exactly 0.5% once");
});

// ── LiFi SOL→EVM leg params (the reverse of the forward EVM→Sol leg) ───────

test("buildReverseLifiQuoteParams: SOL→EVM query — x1Class=1, fee OMITTED, cross-VM direct, real addresses", () => {
  const built = buildReverseLifiQuoteParams({
    to: "eth", netOnSolana: 98, fromAddress: SOL_ADDR, toAddress: EVM_ADDR,
  });
  assert.ok(built, "params built");
  const qs = built.qs;
  assert.equal(qs.get("fromChain"), "SOL");
  assert.equal(qs.get("toChain"), "eth");
  assert.equal(qs.get("fromToken"), TOKENS.sol.USDC.address);
  assert.equal(qs.get("toToken"), TOKENS.eth.USDC.address);
  assert.equal(qs.get("fromAmount"), "98000000", "net on Solana in base units (6 decimals)");
  assert.equal(qs.get("fromAddress"), SOL_ADDR, "real connected Solana address — no placeholders");
  assert.equal(qs.get("toAddress"), EVM_ADDR, "real connected EVM address — no placeholders");
  assert.equal(qs.get("x1Class"), "1", "x1-class marker → server omits the LiFi integrator fee (policy)");
  assert.equal(qs.has("fee"), false, "x1-class quote OMITS the fee key entirely (absent means absent)");
  assert.equal(qs.get("allowSwitchChain"), "false");
  assert.equal(qs.get("integrator"), "x1-teleporter-labs");
});

test("buildReverseLifiQuoteParams: NO PLACEHOLDERS — null without real connected addresses", () => {
  assert.equal(
    buildReverseLifiQuoteParams({ to: "eth", netOnSolana: 98, fromAddress: null, toAddress: EVM_ADDR }),
    null,
  );
  assert.equal(
    buildReverseLifiQuoteParams({ to: "eth", netOnSolana: 98, fromAddress: SOL_ADDR, toAddress: null }),
    null,
  );
});

test("buildReverseLifiQuoteParams: unknown destination chain → null (never a broken URL)", () => {
  assert.equal(
    buildReverseLifiQuoteParams({ to: "x1", netOnSolana: 98, fromAddress: SOL_ADDR, toAddress: EVM_ADDR }),
    null,
    "X1 has no LiFi key — a reverse leg to X1 is meaningless",
  );
});

test("buildReverseLifiQuoteParams: destination stable is the USER'S CHOICE — USDT resolves its address + decimals", () => {
  const built = buildReverseLifiQuoteParams({
    to: "eth", toTokenSymbol: "USDT", netOnSolana: 98, fromAddress: SOL_ADDR, toAddress: EVM_ADDR,
  });
  assert.ok(built, "params built for USDT");
  assert.equal(built.qs.get("toToken"), TOKENS.eth.USDT.address, "the SELECTED destination token (USDT), not hardcoded USDC");
  assert.equal(built.qs.get("fromToken"), TOKENS.sol.USDC.address, "source stays Solana USDC (the Warp release)");
  assert.equal(built.qs.get("fromAmount"), "98000000", "source-side amount stays USDC 6 decimals");
  assert.equal(built.decimals, 6, "the amount math is 6-dec (USDC source)");
  assert.equal(built.toDecimals, 6, "USDT destination decimals = 6");
});

test("buildReverseLifiQuoteParams: DAI destination → DAI address + 18 decimals (source stays USDC 6)", () => {
  const built = buildReverseLifiQuoteParams({
    to: "eth", toTokenSymbol: "DAI", netOnSolana: 98, fromAddress: SOL_ADDR, toAddress: EVM_ADDR,
  });
  assert.ok(built, "params built for DAI");
  assert.equal(built.qs.get("toToken"), TOKENS.eth.DAI.address, "the SELECTED destination token (DAI)");
  assert.equal(built.toDecimals, 18, "DAI destination decimals = 18 (from TOKENS, never hardcoded USDC)");
  assert.equal(built.decimals, 6, "the fromAmount math stays USDC 6-dec (the source side)");
});

test("buildReverseLifiQuoteParams: token NOT on the destination chain → null (base has no USDT)", () => {
  assert.equal(
    buildReverseLifiQuoteParams({
      to: "bas", toTokenSymbol: "USDT", netOnSolana: 98, fromAddress: SOL_ADDR, toAddress: EVM_ADDR,
    }),
    null,
    "TOKENS.bas has USDC + DAI but NO USDT — the selector filters it, and the builder refuses it",
  );
});

test("buildReverseLifiQuoteParams: defaults to USDC when no symbol passed (back-compat)", () => {
  const built = buildReverseLifiQuoteParams({
    to: "eth", netOnSolana: 98, fromAddress: SOL_ADDR, toAddress: EVM_ADDR,
  });
  assert.ok(built);
  assert.equal(built.qs.get("toToken"), TOKENS.eth.USDC.address);
  assert.equal(built.decimals, 6);
});

// ── The quote-box picture ───────────────────────────────────────────────────

test("deriveReverseQuote: quoted LiFi leg → you-receive is the EVM toAmount, solanaAmount is the deterministic net", () => {
  const data = { estimate: { toAmount: "97500000" } }; // 97.5 USDC on Ethereum
  const q = deriveReverseQuote({ data, to: "eth", amount: 100 });
  assert.equal(q.out, 97.5);
  assert.equal(q.net, 97.5);
  assert.equal(q.recvToken, "USDC");
  assert.equal(q.recvChain, "Ethereum");
  assert.equal(q.lifiQuoted, true);
  assert.equal(q.solanaAmount, 98.5, "stage 2 bridges the net that LANDED on Solana, not the input");
  assert.equal(q.teleporterFeeUsd, 0.5);
  assert.equal(q.thirdPartyFeeUsd, 1);
  assert.deepEqual(q.steps.map((s) => s.tool), ["Warp Bridge", "Warp Bridge", "LiFi"]);
  // The fee lines render from quoteFees — 0.5% Teleporter + $1 Warp.
  assert.deepEqual(q.feeLines.map((l) => l.id).sort(), ["warp-flat", "warp-skim"]);
});

test("deriveReverseQuote: LiFi leg NOT quoted → honest handoff numbers (USDC on Solana), never an invented EVM figure", () => {
  const q = deriveReverseQuote({ data: null, to: "eth", amount: 100 });
  assert.equal(q.lifiQuoted, false);
  assert.equal(q.out, 98.5, "you-receive is the USDC that actually lands on Solana");
  assert.equal(q.recvChain, "Solana", "honest: the hop to Ethereum is the NEXT stage");
  assert.equal(q.solanaAmount, 98.5);
  assert.equal(q.teleporterFeeUsd, 0.5);
  assert.equal(q.thirdPartyFeeUsd, 1);
});

test("deriveReverseQuote: destination name reflects the chosen EVM chain", () => {
  const q = deriveReverseQuote({ data: { estimate: { toAmount: "97000000" } }, to: "arb", amount: 100 });
  assert.equal(q.recvChain, "Arbitrum");
  assert.equal(q.out, 97);
});

test("deriveReverseQuote: USDT destination → recvToken USDT, 6-decimal toAmount", () => {
  const q = deriveReverseQuote({ data: { estimate: { toAmount: "97020000" } }, to: "eth", amount: 100, toToken: "USDT" });
  assert.equal(q.recvToken, "USDT", "you-receive names the SELECTED destination stable");
  assert.equal(q.out, 97.02, "USDT is 6 decimals — same scale as USDC");
  assert.equal(q.recvChain, "Ethereum");
});

test("deriveReverseQuote: DAI destination → 18-decimal toAmount converted by TOKENS decimals", () => {
  // 97.02 DAI in base units (18 decimals) — the conversion MUST use DAI's
  // decimals from TOKENS, not the hardcoded USDC 6.
  const q = deriveReverseQuote({ data: { estimate: { toAmount: "97020000000000000000" } }, to: "eth", amount: 100, toToken: "DAI" });
  assert.equal(q.recvToken, "DAI");
  assert.equal(q.out, 97.02, "DAI 18-decimal toAmount lands at the same human number");
});

test("deriveReverseQuote: handoff (no LiFi quote) still reports the Solana landing token regardless of the chosen destination token", () => {
  const q = deriveReverseQuote({ data: null, to: "bas", amount: 100, toToken: "DAI" });
  assert.equal(q.lifiQuoted, false);
  assert.equal(q.recvToken, "USDC", "the honest handoff names the USDC that actually lands on Solana");
  assert.equal(q.recvChain, "Solana");
  assert.equal(q.out, 98.5);
});

// ════════════════════════════════════════════════════════════════════════════
//  WSOL / wSOL.X — the SOL rail (feat/wsol-path). The Warp token registry
//  charges wSOL.X a 25 bps PERCENTAGE fee (flat 0) instead of USDC.x's flat
//  $1 (live config, verified on-chain: gross 0.11 → fee 0.000275 → net
//  0.109725). The stage-2 LiFi leg therefore quotes WSOL (9 dec) → EVM
//  directly — LiFi handles So111… as fromToken (relaydepository wSOL→USDC,
//  verified live Sep 2026) — NO Jupiter swap needed.
// ════════════════════════════════════════════════════════════════════════════

test("computeReverseLegs (wSOL.X): 0.5% skim on source, burn = net, Warp fee = 25 bps of the bridge gross (not the flat $1)", () => {
  const legs = computeReverseLegs({ amount: 100, token: "wSOL.X" });
  assert.equal(legs.skim, 0.5, "0.5% of 100 wSOL.X");
  assert.equal(legs.burnAmount, 99.5, "bridge_out burns the net (post-skim)");
  assert.equal(legs.warpFee, 99.5 * 0.0025, "25 bps of the 99.5 bridge gross — NOT the flat $1");
  assert.equal(legs.netOnSolana, 99.5 - 99.5 * 0.0025, "net released on Solana = gross − 25bps");
  // Fee lines: warp-skim (Teleporter 0.5%) + warp-pct (third-party 0.25%) — no flat $1 line.
  const ids = legs.feeQuote.feeLines.map((l) => l.id).sort();
  assert.deepEqual(ids, ["warp-pct", "warp-skim"]);
  const pct = legs.feeQuote.feeLines.find((l) => l.id === "warp-pct");
  assert.equal(pct.party, "third-party", "Warp's pct fee is a third-party pass-through, never a Teleporter fee");
  assert.equal(pct.amountUsd, 100 * 0.0025, "display line = 0.25% of the source (the deterministic math uses the post-skim gross)");
  assert.equal(legs.feeQuote.teleporterFeeUsd, 0.5, "Teleporter take stays exactly 0.5% once");
});

test("computeReverseLegs: USDC.x keeps the flat $1 (warp-flat) — token-aware fee shape", () => {
  const legs = computeReverseLegs({ amount: 100, token: "USDC.x" });
  assert.equal(legs.warpFee, 1, "flat $1 for USDC.x (verified on-chain 2026-09-02)");
  assert.equal(legs.netOnSolana, 98.5, "100 − 0.5% − $1");
  const ids = legs.feeQuote.feeLines.map((l) => l.id).sort();
  assert.deepEqual(ids, ["warp-flat", "warp-skim"]);
});

test("buildReverseLifiQuoteParams (wSOL.X): fromToken = WSOL (So111…), fromAmount in 9 decimals — LiFi-direct, no Jupiter swap", () => {
  const built = buildReverseLifiQuoteParams({
    to: "eth", netOnSolana: 98.7525, fromAddress: SOL_ADDR, toAddress: EVM_ADDR, token: "wSOL.X",
  });
  assert.ok(built, "params built");
  const qs = built.qs;
  assert.equal(qs.get("fromChain"), "SOL");
  assert.equal(qs.get("fromToken"), "So11111111111111111111111111111111111111112", "LiFi fromToken = WSOL (LiFi quotes wSOL→EVM stables directly)");
  assert.equal(qs.get("toToken"), TOKENS.eth.USDC.address);
  assert.equal(qs.get("fromAmount"), "98752500000", "net on Solana in 9-dec base units (WSOL)");
  assert.equal(built.decimals, 9, "the LiFi amount math is 9-dec end to end");
  assert.equal(qs.get("x1Class"), "1", "x1-class marker intact");
  assert.equal(qs.has("fee"), false, "x1-class quote OMITS the fee key entirely");
});

test("buildReverseLifiQuoteParams (USDC.x): fromToken stays USDC, fromAmount in 6 decimals (back-compat)", () => {
  const built = buildReverseLifiQuoteParams({
    to: "eth", netOnSolana: 98, fromAddress: SOL_ADDR, toAddress: EVM_ADDR, token: "USDC.x",
  });
  assert.ok(built);
  assert.equal(built.qs.get("fromToken"), TOKENS.sol.USDC.address);
  assert.equal(built.qs.get("fromAmount"), "98000000", "6 decimals");
  assert.equal(built.decimals, 6);
});

test("deriveReverseQuote (wSOL.X): quoted leg shows the dest stable; unquoted leg honestly shows WSOL on Solana", () => {
  const lifiData = { estimate: { toAmount: "509843200" } }; // 509.84 USDC at 6 dec
  const quoted = deriveReverseQuote({ data: lifiData, to: "eth", amount: 500, token: "wSOL.X" });
  assert.equal(quoted.recvToken, "USDC", "dest stable");
  assert.equal(quoted.recvChain, "Ethereum");
  assert.ok(Math.abs(quoted.out - 509.8432) < 1e-9, "toAmount decoded at the dest stable's 6 decimals");
  assert.equal(quoted.solanaAmount, quoted.legs.netOnSolana, "stage 2 bridges the deterministic WSOL net");

  const unquoted = deriveReverseQuote({ data: null, to: "eth", amount: 500, token: "wSOL.X" });
  assert.equal(unquoted.recvToken, "WSOL", "honest handoff: WSOL rests on Solana");
  assert.equal(unquoted.recvChain, "Solana");
  assert.equal(unquoted.lifiQuoted, false);
});

// ── REVERSE MINIMUM GATE — DISABLED (fee-model v2 removed the $25 floor) ────
// checkReverseMin stays exported for DI/tests; its DEFAULT minUsd is now
// X1_REVERSE_MIN = 0, so the gate can never block (small reverse bridges are
// viable at 0.5% capped at $250). Passing an explicit minUsd still exercises
// the USD-aware mechanism (price resolution stays covered).

test("checkReverseMin: floor REMOVED — a $10 journey passes by default (minUsd = 0)", async () => {
  const lifiData = { action: { fromToken: { priceUSD: 100 } } };
  const r = await checkReverseMin({ amount: 0.1, token: "wSOL.X", lifiData });
  assert.equal(r.blocked, false, "0.1 wSOL.X ≈ $10 is NOT blocked — the $25 floor is gone");
  assert.equal(r.usdValue, 10, "USD value = gross × live price (0.1 × 100)");
  assert.equal(r.priceUSD, 100, "price comes from the LiFi quote");
});

test("checkReverseMin: floor REMOVED — a $5 USDC.x journey passes by default", async () => {
  const lifiData = { action: { fromToken: { priceUSD: 1 } } };
  const r = await checkReverseMin({ amount: 5, token: "USDC.x", lifiData });
  assert.equal(r.blocked, false, "$5 < old $25 floor — but the floor is gone (minUsd defaults to 0)");
  assert.equal(r.usdValue, 5);
});

test("checkReverseMin: the USD-aware MECHANISM still works when an explicit floor is passed (DI/tests)", async () => {
  const lifiData = { action: { fromToken: { priceUSD: 1 } } };
  const blocked = await checkReverseMin({ amount: 24, token: "USDC.x", lifiData, minUsd: 25 });
  assert.equal(blocked.blocked, true, "24 < 25 with an explicit minUsd → the comparison still works");
  const passes = await checkReverseMin({ amount: 25, token: "USDC.x", lifiData, minUsd: 25 });
  assert.equal(passes.blocked, false, "25 ≥ 25 with an explicit minUsd → passes");
  assert.equal(passes.usdValue, 25);
});

test("checkReverseMin: no LiFi price → Coingecko fallback used (never hardcoded)", async () => {
  const lifiData = { action: { fromToken: {} } }; // quoted leg but NO priceUSD
  const r = await checkReverseMin({
    amount: 0.3, token: "wSOL.X", lifiData,
    fetchPrice: async (id) => { assert.equal(id, "wrapped-solana"); return 100; },
  });
  assert.equal(r.blocked, false, "no floor to block; the fallback price still resolves");
  assert.equal(r.priceUSD, 100, "fallback price used");
});

test("checkReverseMin: LiFi price WINS — the fallback is never called when the quote carries a price", async () => {
  let fallbackCalls = 0;
  const r = await checkReverseMin({
    amount: 24, token: "USDC.x", minUsd: 25,
    lifiData: { action: { fromToken: { priceUSD: 1 } } },
    fetchPrice: async () => { fallbackCalls += 1; return 999; },
  });
  assert.equal(r.blocked, true, "uses the LiFi price ($24 < $25 explicit floor), not the bogus fallback");
  assert.equal(fallbackCalls, 0, "fallback not consulted — LiFi is the primary source");
});

test("checkReverseMin: BOTH price sources fail → FAILS OPEN (blocked=false, quote proceeds)", async () => {
  const r = await checkReverseMin({
    amount: 0.1, token: "wSOL.X",
    lifiData: null, // leg unquoted → no LiFi price
    fetchPrice: async () => { throw new Error("price api down"); },
  });
  assert.equal(r.blocked, false, "a missing price must never block a valid user");
  assert.equal(r.usdValue, null);
  assert.equal(r.priceUSD, null);
});

test("resolveReversePriceUSD: defaultPriceFetch parses the Coingecko simple-price shape", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.coingecko\.com\/api\/v3\/simple\/price/);
    return { ok: true, json: async () => ({ "wrapped-solana": { usd: 102.34 } }) };
  };
  try {
    assert.equal(await defaultPriceFetch("wrapped-solana"), 102.34);
  } finally {
    globalThis.fetch = prev;
  }
});
