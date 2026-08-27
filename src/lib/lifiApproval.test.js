/**
 * Tests for the Step 1.1 audit gate: exact-amount ERC-20 approvals + spender
 * validation for LI.Fi routes. Runs under Node's built-in test runner
 * (node --test). No framework needed — same pattern as flags.test.ts.
 *
 * Covers the three runbook requirements:
 *   (a) exact amount used (never MaxUint256),
 *   (b) unknown spender rejected (abort before signing),
 *   (c) known spender accepted.
 * Plus the Step 1.1 amendment:
 *   (d) the spender must be LI.Fi's pinned Diamond for the chain — the
 *       independent allowlist anchor that catches self-consistent tampered
 *       responses (unknown chain / unknown address → abort).
 *
 * Fixtures mirror the REAL li.quest API shapes (verified 2026-08-27):
 *   /v1/tools → { bridges: [{ key, supportedChains: [{fromChainId,toChainId}] }],
 *                 exchanges: [{ key, supportedChains: [chainId] }] }
 *   /quote     → estimate.approvalAddress === transactionRequest.to (the
 *                contract the bridge tx calls, e.g. the LI.Fi Diamond).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalData,
  amountFromApprovalData,
  spenderFromApprovalData,
  isMaxUint256Amount,
  normalizeEvmAddress,
  toolKeysForChain,
  validateLiFiApproval,
  LiFiApprovalValidationError,
  MAX_UINT256,
} from "./lifiApproval.js";
import { LIFI_DIAMOND_ALLOWLIST, isKnownLiFiDiamond } from "./lifiDiamondAllowlist.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

// Realistic /v1/tools response for chains 1 / 137 / 56 (live shape).
const TOOLS_FIXTURE = {
  bridges: [
    {
      key: "across",
      name: "AcrossV4",
      supportedChains: [
        { fromChainId: 1, toChainId: 137 },
        { fromChainId: 1, toChainId: 42161 },
        { fromChainId: 137, toChainId: 1 },
      ],
    },
    { key: "stargateV2", name: "Stargate V2", supportedChains: [{ fromChainId: 1, toChainId: 10 }] },
  ],
  exchanges: [
    { key: "sushiswap", name: "Sushi", supportedChains: [1, 137, 42161] },
    { key: "1inch", name: "1inch", supportedChains: [56] },
  ],
};

// The LI.Fi Diamond — the real allowance target on EVM chains.
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** Build a realistic single-step quote/route object. */
function makeStep(overrides = {}) {
  return {
    tool: "across",
    toolDetails: { key: "across", name: "AcrossV4" },
    action: {
      fromToken: { address: USDC_ETH, chainId: 1, symbol: "USDC", decimals: 6 },
      fromAmount: "10000000", // 10 USDC raw units
    },
    estimate: { approvalAddress: DIAMOND, fromAmount: "10000000" },
    transactionRequest: { chainId: 1, to: DIAMOND, data: "0x1234", value: "0x0" },
    ...overrides,
  };
}

function assertValidationError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof LiFiApprovalValidationError, `expected LiFiApprovalValidationError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

// ── (a) Exact amount used, never MaxUint256 ────────────────────────────────

test("approval calldata encodes EXACTLY the bridged amount (10 USDC raw)", () => {
  const data = buildApprovalData({ spender: DIAMOND, amount: "10000000" });
  assert.equal(amountFromApprovalData(data), 10000000n);
  assert.equal(spenderFromApprovalData(data), DIAMOND.toLowerCase());
  // 10000000 = 0x989680 — the calldata must end with that, zero-padded.
  assert.ok(data.endsWith("0".repeat(64 - 6) + "989680"), `amount not exact: ${data}`);
  assert.equal(isMaxUint256Amount(data), false);
});

test("approval calldata is NEVER MaxUint256, even for large amounts", () => {
  const data = buildApprovalData({ spender: DIAMOND, amount: "999999999999999999999999" });
  assert.equal(isMaxUint256Amount(data), false);
  assert.notEqual(amountFromApprovalData(data), MAX_UINT256);
  assert.equal(amountFromApprovalData(data), 999999999999999999999999n);
});

test("the old unlimited-approval pattern is detectable and never produced", () => {
  // The exact calldata the old code signed (approve(spender, MaxUint256)).
  const legacyMaxData = "0x095ea7b3" + DIAMOND.slice(2).padStart(64, "0") + "f".repeat(64);
  assert.equal(isMaxUint256Amount(legacyMaxData), true);
  // buildApprovalData with a real amount must differ from it.
  const data = buildApprovalData({ spender: DIAMOND, amount: "10000000" });
  assert.notEqual(data, legacyMaxData);
  assert.equal(isMaxUint256Amount(data), false);
});

test("validateLiFiApproval returns the EXACT quote amount for the approval", () => {
  const res = validateLiFiApproval({ step: makeStep(), toolsData: TOOLS_FIXTURE });
  assert.equal(res.approved, true);
  assert.equal(res.amount, 10000000n); // exact — not rounded, not inflated
  assert.equal(res.spender, DIAMOND.toLowerCase());
  assert.equal(res.chainId, 1);
  assert.equal(res.toolKey, "across");
});

test("approval data builder rejects invalid inputs", () => {
  assert.throws(() => buildApprovalData({ spender: "0x1234", amount: "5" }), /invalid spender/);
  assert.throws(() => buildApprovalData({ spender: DIAMOND, amount: "0" }), /positive/);
  assert.throws(() => buildApprovalData({ spender: DIAMOND, amount: "-5" }), /positive/);
  assert.throws(() => buildApprovalData({ spender: DIAMOND, amount: "abc" }), /invalid amount/);
  assert.throws(
    () => buildApprovalData({ spender: DIAMOND, amount: (1n << 256n).toString() }),
    /exceeds uint256/,
  );
});

// ── (b) Unknown spender rejected (abort before signing) ────────────────────

test("approval target that differs from the bridge tx target is REJECTED", () => {
  // Approval target IS the real Diamond, but the bridge tx would call a
  // different contract — the response is internally inconsistent.
  const evil = "0x1111111111111111111111111111111111111111";
  const step = makeStep({
    transactionRequest: { chainId: 1, to: evil, data: "0x1234", value: "0x0" },
  });
  assertValidationError(
    () => validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE }),
    "spender-mismatch",
  );
});

test("tool NOT listed by /v1/tools for the chain is REJECTED", () => {
  // Self-consistent quote (approvalAddress == tx.to == real Diamond) but a
  // bogus tool key.
  const step = makeStep({
    tool: "evilbridge",
    toolDetails: { key: "evilbridge", name: "Evil Bridge" },
  });
  assertValidationError(
    () => validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE }),
    "unknown-tool",
  );
});

test("a REAL tool used on a chain it does NOT support is REJECTED", () => {
  // 1inch exists in /v1/tools but only on chain 56 — not on chain 1.
  const step = makeStep({
    tool: "1inch",
    toolDetails: { key: "1inch", name: "1inch" },
    transactionRequest: { chainId: 1, to: DIAMOND, data: "0x1234", value: "0x0" },
  });
  assertValidationError(
    () => validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE }),
    "unknown-tool",
  );
});

// ── (d) Diamond allowlist — the independent anchor (Step 1.1 amendment) ────

test("SELF-CONSISTENT quote pointing at a NON-Diamond contract is REJECTED", () => {
  // The attack this amendment exists for: approvalAddress == tx.to and the
  // tool is real, so the consistency checks pass — but the target is not
  // LI.Fi's pinned Diamond. The allowlist must catch it.
  const evil = "0x2222222222222222222222222222222222222222";
  const step = makeStep({
    estimate: { approvalAddress: evil, fromAmount: "10000000" },
    transactionRequest: { chainId: 1, to: evil, data: "0x1234", value: "0x0" },
  });
  assertValidationError(
    () => validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE }),
    "address-not-allowlisted",
  );
});

test("approval on a chain with NO pinned Diamond is REJECTED (fail-closed)", () => {
  // chain 999999 is not in the allowlist — even with the real Diamond
  // address, we must not approve on a chain we cannot independently verify.
  const step = makeStep({
    action: {
      fromToken: { address: USDC_ETH, chainId: 999999, symbol: "USDC", decimals: 6 },
      fromAmount: "10000000",
    },
    transactionRequest: { chainId: 999999, to: DIAMOND, data: "0x1234", value: "0x0" },
  });
  assertValidationError(
    () => validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE }),
    "unknown-chain",
  );
});

test("every allowlisted chain accepts its pinned Diamond", () => {
  // Iterate the whole allowlist: for each chain, a self-consistent quote
  // (approvalAddress == tx.to == pinned Diamond, real tool) must pass.
  const diamond = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
  const chains = Object.keys(LIFI_DIAMOND_ALLOWLIST).map(Number);
  assert.ok(chains.length >= 8, "allowlist should cover all app EVM chains");
  for (const cid of chains) {
    const step = {
      tool: "across",
      toolDetails: { key: "across", name: "AcrossV4" },
      action: {
        fromToken: { address: USDC_ETH, chainId: cid, symbol: "USDC", decimals: 6 },
        fromAmount: "10000000",
      },
      estimate: { approvalAddress: diamond, fromAmount: "10000000" },
      transactionRequest: { chainId: cid, to: diamond, data: "0x1234", value: "0x0" },
    };
    const toolsData = {
      bridges: [{ key: "across", supportedChains: [{ fromChainId: cid, toChainId: cid }] }],
      exchanges: [],
    };
    const res = validateLiFiApproval({ step, toolsData });
    assert.equal(res.approved, true, `chain ${cid} should accept its Diamond`);
    assert.equal(res.spender, diamond.toLowerCase());
    assert.equal(res.chainId, cid);
  }
});

test("allowlist rejects wrong address for a KNOWN chain", () => {
  // A valid EVM address that is NOT the Diamond on chain 1.
  const wrongButValid = "0x1111111111111111111111111111111111111111";
  assert.equal(
    isKnownLiFiDiamond(1, wrongButValid),
    false,
    "non-Diamond address must not be on the allowlist",
  );
});

test("missing /v1/tools data (fetch failed) ABORTS — fail closed, never approve blind", () => {
  assertValidationError(
    () => validateLiFiApproval({ step: makeStep(), toolsData: null }),
    "tools-unavailable",
  );
  assertValidationError(
    () => validateLiFiApproval({ step: makeStep(), toolsData: undefined }),
    "tools-unavailable",
  );
});

test("no tool key on the step is REJECTED", () => {
  const step = makeStep({ tool: undefined, toolDetails: undefined });
  assertValidationError(
    () => validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE }),
    "unknown-tool",
  );
});

test("invalid or missing approval address is REJECTED", () => {
  const step = makeStep({
    estimate: { approvalAddress: "not-an-address", fromAmount: "10000000" },
  });
  assertValidationError(
    () => validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE }),
    "invalid-approval-address",
  );
  const stepNoTx = makeStep({ transactionRequest: { chainId: 1 } });
  assertValidationError(
    () => validateLiFiApproval({ step: stepNoTx, toolsData: TOOLS_FIXTURE }),
    "missing-tx-target",
  );
});

test("missing or invalid source amount is REJECTED", () => {
  const step = makeStep({ action: { ...makeStep().action, fromAmount: undefined }, estimate: { approvalAddress: DIAMOND } });
  assertValidationError(
    () => validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE }),
    "missing-amount",
  );
  const stepBad = makeStep({ action: { ...makeStep().action, fromAmount: "abc" }, estimate: { approvalAddress: DIAMOND, fromAmount: "abc" } });
  assertValidationError(
    () => validateLiFiApproval({ step: stepBad, toolsData: TOOLS_FIXTURE }),
    "invalid-amount",
  );
});

// ── (c) Known spender accepted ─────────────────────────────────────────────

test("known spender (LI.Fi tool on the chain, matches tx target) is ACCEPTED", () => {
  const res = validateLiFiApproval({ step: makeStep(), toolsData: TOOLS_FIXTURE });
  assert.equal(res.approved, true);
  assert.equal(res.spender, DIAMOND.toLowerCase());
  assert.equal(res.toolKey, "across");
});

test("exchange-tool step (swap) with known spender is ACCEPTED", () => {
  const step = makeStep({
    tool: "sushiswap",
    toolDetails: { key: "sushiswap", name: "Sushi" },
  });
  const res = validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE });
  assert.equal(res.approved, true);
  assert.equal(res.toolKey, "sushiswap");
  assert.equal(res.spender, DIAMOND.toLowerCase());
});

test("bridge supportedChains shape ({fromChainId}) and exchange shape ([chainId]) both parse", () => {
  const keys1 = toolKeysForChain(TOOLS_FIXTURE, 1);
  assert.ok(keys1.has("across")); // bridge, fromChainId 1
  assert.ok(keys1.has("stargateV2")); // bridge, fromChainId 1
  assert.ok(keys1.has("sushiswap")); // exchange, [1, ...]
  assert.ok(!keys1.has("1inch")); // exchange, [56] only

  const keys137 = toolKeysForChain(TOOLS_FIXTURE, 137);
  assert.ok(keys137.has("across")); // bridge, fromChainId 137
  assert.ok(keys137.has("sushiswap")); // exchange, [..., 137]
  assert.ok(!keys137.has("stargateV2"));

  const keys56 = toolKeysForChain(TOOLS_FIXTURE, 56);
  assert.ok(keys56.has("1inch"));
  assert.ok(!keys56.has("across"));

  // Hex + decimal chain ids resolve identically.
  assert.deepEqual([...toolKeysForChain(TOOLS_FIXTURE, "0x1")], [...toolKeysForChain(TOOLS_FIXTURE, 1)]);
});

// ── Native / no-approval-required steps ────────────────────────────────────

test("native token steps need no approval", () => {
  const native = makeStep({
    action: {
      fromToken: { address: "0x0000000000000000000000000000000000000000", chainId: 1, symbol: "ETH", decimals: 18 },
      fromAmount: "1000000000000000000",
    },
    estimate: { approvalAddress: DIAMOND, fromAmount: "1000000000000000000" },
  });
  const res = validateLiFiApproval({ step: native, toolsData: TOOLS_FIXTURE });
  assert.equal(res.approved, false);
  assert.equal(res.reason, "native");
});

test("steps with no approvalAddress need no approval (LI.Fi semantics)", () => {
  const step = makeStep({ estimate: { fromAmount: "10000000" } });
  const res = validateLiFiApproval({ step, toolsData: TOOLS_FIXTURE });
  assert.equal(res.approved, false);
  assert.equal(res.reason, "no-approval-required");
});

// ── Address normalization ──────────────────────────────────────────────────

test("normalizeEvmAddress handles casing and rejects garbage", () => {
  assert.equal(normalizeEvmAddress(DIAMOND), DIAMOND.toLowerCase());
  assert.equal(normalizeEvmAddress(DIAMOND.toLowerCase()), DIAMOND.toLowerCase());
  assert.equal(normalizeEvmAddress(DIAMOND.toUpperCase()), DIAMOND.toLowerCase());
  assert.equal(normalizeEvmAddress(" " + DIAMOND + " "), DIAMOND.toLowerCase());
  assert.equal(normalizeEvmAddress("0x1234"), null);
  assert.equal(normalizeEvmAddress("0x" + "1".repeat(41)), null);
  assert.equal(normalizeEvmAddress(null), null);
  assert.equal(normalizeEvmAddress(undefined), null);
});
