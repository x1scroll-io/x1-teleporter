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
} from "./reverseQuote.js";
import { FEE_RATES } from "./fees.ts";
import { CHAINS, TOKENS } from "./teleportConstants.js";

const SOL_ADDR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const EVM_ADDR = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";

// ── Stage-1 math: 1% once per journey + Warp's $1 (third-party) ─────────────

test("computeReverseLegs: 1% skim on source, burn = net, Solana net = burn − Warp's $1", () => {
  const legs = computeReverseLegs({ amount: 100 });
  assert.equal(legs.skim, 1);                        // 1% of 100
  assert.equal(legs.burnAmount, 99);                 // bridge_out burns the net
  assert.equal(legs.netOnSolana, 98);                // 99 − Warp's flat $1 (deducted on-chain)
  assert.equal(FEE_RATES.X1_HOP_SKIM, 0.01, "rate sourced from fees.ts");
  assert.equal(FEE_RATES.WARP_FLAT_USD, 1, "$1 sourced from fees.ts");
});

test("computeReverseLegs: fee lines are exactly 1% Teleporter + $1 Warp (no LiFi integrator on x1-class)", () => {
  const legs = computeReverseLegs({ amount: 100 });
  const ids = legs.feeQuote.feeLines.map((l) => l.id).sort();
  assert.deepEqual(ids, ["warp-flat", "warp-skim"]);
  const skim = legs.feeQuote.feeLines.find((l) => l.id === "warp-skim");
  assert.equal(skim.amountUsd, 1);
  assert.equal(skim.party, "teleporter");
  const flat = legs.feeQuote.feeLines.find((l) => l.id === "warp-flat");
  assert.equal(flat.amountUsd, 1);
  assert.equal(flat.party, "third-party");
  assert.equal(legs.feeQuote.teleporterFeeUsd, 1, "Teleporter take is exactly 1% once");
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

// ── The quote-box picture ───────────────────────────────────────────────────

test("deriveReverseQuote: quoted LiFi leg → you-receive is the EVM toAmount, solanaAmount is the deterministic net", () => {
  const data = { estimate: { toAmount: "97500000" } }; // 97.5 USDC on Ethereum
  const q = deriveReverseQuote({ data, to: "eth", amount: 100 });
  assert.equal(q.out, 97.5);
  assert.equal(q.net, 97.5);
  assert.equal(q.recvToken, "USDC");
  assert.equal(q.recvChain, "Ethereum");
  assert.equal(q.lifiQuoted, true);
  assert.equal(q.solanaAmount, 98, "stage 2 bridges the net that LANDED on Solana, not the input");
  assert.equal(q.teleporterFeeUsd, 1);
  assert.equal(q.thirdPartyFeeUsd, 1);
  assert.deepEqual(q.steps.map((s) => s.tool), ["Warp Bridge", "Warp Bridge", "LiFi"]);
  // The fee lines render from quoteFees — 1% Teleporter + $1 Warp.
  assert.deepEqual(q.feeLines.map((l) => l.id).sort(), ["warp-flat", "warp-skim"]);
});

test("deriveReverseQuote: LiFi leg NOT quoted → honest handoff numbers (USDC on Solana), never an invented EVM figure", () => {
  const q = deriveReverseQuote({ data: null, to: "eth", amount: 100 });
  assert.equal(q.lifiQuoted, false);
  assert.equal(q.out, 98, "you-receive is the USDC that actually lands on Solana");
  assert.equal(q.recvChain, "Solana", "honest: the hop to Ethereum is the NEXT stage");
  assert.equal(q.solanaAmount, 98);
  assert.equal(q.teleporterFeeUsd, 1);
  assert.equal(q.thirdPartyFeeUsd, 1);
});

test("deriveReverseQuote: destination name reflects the chosen EVM chain", () => {
  const q = deriveReverseQuote({ data: { estimate: { toAmount: "97000000" } }, to: "arb", amount: 100 });
  assert.equal(q.recvChain, "Arbitrum");
  assert.equal(q.out, 97);
});
