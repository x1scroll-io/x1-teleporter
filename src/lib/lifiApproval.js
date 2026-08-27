/**
 * lifiApproval.js — exact-amount ERC-20 approvals + spender validation for
 * LI.Fi routes (Teleporter Step 1.1 audit gate).
 *
 * WHY THIS EXISTS
 *   The old approval flow signed approve(spender, MaxUint256) to whatever
 *   address the quote said, with no verification at all. This module:
 *     1. builds approve() calldata for EXACTLY the amount being bridged —
 *        never an unlimited allowance,
 *     2. validates the spender before anything is signed:
 *          a. the approval target must be the SAME contract the bridge
 *             transaction calls (transactionRequest.to), and
 *          b. the tool executing the step must be a tool LI.Fi lists for the
 *             source chain in /v1/tools, and
 *          c. the approval target must be LI.Fi's Diamond contract for the
 *             chain, per the pinned allowlist in lifiDiamondAllowlist.js.
 *             (a) and (b) only compare fields from the SAME response — a
 *             self-consistent but tampered response could pass both. (c) is
 *             the independent anchor: it compares against LI.Fi's published
 *             deployment records, so an unknown chain or an address that is
 *             not the pinned Diamond ABORTS.
 *   Any check that cannot be satisfied ABORTS the approval (fail-closed).
 *
 * ADAPTED TO THE REAL LI.Fi API SHAPE (verified against li.quest 2026-08-27)
 *   The runbook assumed /v1/tools returns per-tool `allowanceTarget` fields.
 *   The live API does NOT: /v1/tools returns
 *     { bridges:   [ { key, name, logoURI, supportedChains: [{ fromChainId,
 *                      toChainId }] } ],
 *       exchanges: [ { key, name, logoURI, supportedChains: [chainId] } ] }
 *   with no address fields at all. The authoritative spender today is
 *   `estimate.approvalAddress` on the quote/step, and for every route type
 *   tested (bridge, cross-VM, swap) it equals `transactionRequest.to` — the
 *   contract the bridge transaction actually calls. So the spender validation
 *   is: approvalAddress must equal transactionRequest.to AND the step's tool
 *   key must be present in /v1/tools for the source chain.
 *
 * This module is pure (no DOM, no fetch) so it runs under node --test.
 */

import {
  isKnownLiFiDiamond,
  isKnownLiFiDiamondChain,
} from "./lifiDiamondAllowlist.js";

export const ERC20_APPROVE_SELECTOR = "0x095ea7b3"; // approve(address,uint256)
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Normalize an EVM address to lowercase 0x-hex, or null if not a valid address.
 * Accepts any valid 40-hex-char address regardless of checksum casing.
 */
export function normalizeEvmAddress(addr) {
  if (typeof addr !== "string") return null;
  const a = addr.trim();
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(a)) return null;
  return a.toLowerCase();
}

/**
 * Build approve(spender, amount) calldata with EXACTLY `amount` — never
 * MaxUint256. `amount` may be a decimal string ("1000000"), bigint, or number
 * of RAW token units (what LI.Fi returns as action.fromAmount).
 * Throws on invalid spender, non-positive amount, or amount > uint256.
 */
export function buildApprovalData({ spender, amount }) {
  const s = normalizeEvmAddress(spender);
  if (!s) throw new Error("buildApprovalData: invalid spender address");
  let amt;
  try {
    amt = BigInt(amount);
  } catch {
    throw new Error("buildApprovalData: invalid amount");
  }
  if (amt <= 0n) throw new Error("buildApprovalData: amount must be positive");
  if (amt > MAX_UINT256) throw new Error("buildApprovalData: amount exceeds uint256");
  return (
    ERC20_APPROVE_SELECTOR +
    s.slice(2).padStart(64, "0") +
    amt.toString(16).padStart(64, "0")
  );
}

/** Parse the amount back out of approve() calldata (for tests/debugging). */
export function amountFromApprovalData(data) {
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const body = data.slice(2);
  if (body.length !== 8 + 64 + 64) return null; // selector + spender + amount
  try {
    return BigInt("0x" + body.slice(8 + 64, 8 + 64 + 64));
  } catch {
    return null;
  }
}

/** Parse the spender back out of approve() calldata (for tests/debugging). */
export function spenderFromApprovalData(data) {
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const body = data.slice(2);
  if (body.length !== 8 + 64 + 64) return null;
  return "0x" + body.slice(8, 8 + 64).slice(24).toLowerCase();
}

/** True if the calldata approves an unlimited (MaxUint256) allowance. */
export function isMaxUint256Amount(data) {
  const amt = amountFromApprovalData(data);
  return amt !== null && amt === MAX_UINT256;
}

/**
 * Extract the set of tool keys LI.Fi lists for a chain from a /v1/tools
 * response. Handles BOTH shapes found in the live API:
 *   - bridges:   supportedChains = [{ fromChainId, toChainId }]
 *   - exchanges: supportedChains = [chainId, ...]
 * `chainId` may be a number, decimal string, or 0x hex string.
 */
export function toolKeysForChain(toolsData, chainId) {
  const keys = new Set();
  if (!toolsData || typeof toolsData !== "object") return keys;
  const cid = Number(chainId);
  if (!Number.isFinite(cid)) return keys;
  for (const group of ["bridges", "exchanges"]) {
    const list = Array.isArray(toolsData[group]) ? toolsData[group] : [];
    for (const tool of list) {
      if (!tool || typeof tool.key !== "string" || !tool.key) continue;
      const sc = tool.supportedChains;
      if (!Array.isArray(sc)) continue;
      const onChain = sc.some((entry) => {
        if (typeof entry === "number" || typeof entry === "string") {
          return Number(entry) === cid; // exchange shape
        }
        if (entry && typeof entry === "object") {
          return Number(entry.fromChainId) === cid; // bridge shape
        }
        return false;
      });
      if (onChain) keys.add(tool.key);
    }
  }
  return keys;
}

/** Typed error for approval validation failures (message is user-facing). */
export class LiFiApprovalValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LiFiApprovalValidationError";
    this.code = code;
  }
}

/**
 * Validate a LI.Fi step before signing an ERC-20 approval. Fail-closed.
 *
 * `step` must be the SAME object that supplies the bridge transaction
 * (top-level quote for single-step routes, steps[0] for multi-step routes).
 * `toolsData` is the /v1/tools response for the source chain; null/undefined
 * (fetch failure) ABORTS — we never approve blind.
 *
 * Returns:
 *   { approved: false, reason: "native" }                 — no approval needed
 *   { approved: false, reason: "no-approval-required" }   — LI.Fi gave no
 *     approvalAddress, so no allowance is needed for this step
 *   { approved: true, spender, amount, chainId, toolKey } — safe to sign;
 *     `amount` is the EXACT raw source amount from the quote
 *
 * Throws LiFiApprovalValidationError when the spender cannot be verified.
 */
export function validateLiFiApproval({ step, toolsData }) {
  if (!step || typeof step !== "object") {
    throw new LiFiApprovalValidationError(
      "No LI.Fi step data to validate — transaction aborted.",
      "missing-step",
    );
  }
  const action = step.action || {};
  const estimate = step.estimate || {};
  const txReq = step.transactionRequest || {};

  const tokenAddr = action?.fromToken?.address;
  const isNative =
    !tokenAddr ||
    /^0x0+$/.test(tokenAddr) ||
    tokenAddr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  if (isNative) return { approved: false, reason: "native" };

  const fromAmount = action?.fromAmount ?? estimate?.fromAmount;
  if (fromAmount === undefined || fromAmount === null || fromAmount === "") {
    throw new LiFiApprovalValidationError(
      "LI.Fi returned no source amount — cannot build a safe approval — transaction aborted.",
      "missing-amount",
    );
  }

  // No approvalAddress => LI.Fi does not require an allowance for this step.
  const approvalAddress = estimate?.approvalAddress;
  if (!approvalAddress) return { approved: false, reason: "no-approval-required" };

  const spender = normalizeEvmAddress(approvalAddress);
  if (!spender) {
    throw new LiFiApprovalValidationError(
      "LI.Fi returned an invalid approval address — transaction aborted.",
      "invalid-approval-address",
    );
  }

  // INDEPENDENT ANCHOR (Step 1.1 amendment): the approval target must be
  // LI.Fi's Diamond contract for this chain, pinned from LI.Fi's own
  // deployment records (lifiDiamondAllowlist.js). The checks below only
  // compare fields from the SAME response — a self-consistent but tampered
  // response could pass them. The allowlist is independent of the response,
  // so an unknown chain or an address that is not the pinned Diamond ABORTS.
  const chainId = action?.fromToken?.chainId ?? txReq?.chainId;
  if (!isKnownLiFiDiamondChain(chainId)) {
    throw new LiFiApprovalValidationError(
      `Cannot verify LI.Fi's Diamond contract on chain ${String(chainId)} — approval aborted.`,
      "unknown-chain",
    );
  }
  if (!isKnownLiFiDiamond(chainId, spender)) {
    throw new LiFiApprovalValidationError(
      "Approval target is not LI.Fi's known Diamond contract for this chain — transaction aborted.",
      "address-not-allowlisted",
    );
  }

  // The contract we approve must be the contract the bridge tx calls.
  const txTo = normalizeEvmAddress(txReq?.to);
  if (!txTo) {
    throw new LiFiApprovalValidationError(
      "LI.Fi returned no transaction target — cannot verify the approval spender — transaction aborted.",
      "missing-tx-target",
    );
  }
  if (spender !== txTo) {
    throw new LiFiApprovalValidationError(
      "Approval target does not match the bridge transaction target — transaction aborted.",
      "spender-mismatch",
    );
  }

  // The tool running this step must be a tool LI.Fi lists for the source chain.
  if (!toolsData || typeof toolsData !== "object") {
    throw new LiFiApprovalValidationError(
      "Could not verify LI.Fi's tool list for this chain — approval aborted. Try again.",
      "tools-unavailable",
    );
  }
  const toolKey = step?.tool || step?.toolDetails?.key || null;
  if (!toolKey) {
    throw new LiFiApprovalValidationError(
      "LI.Fi did not identify the tool for this step — approval aborted.",
      "unknown-tool",
    );
  }
  const knownTools = toolKeysForChain(toolsData, chainId);
  if (!knownTools.has(toolKey)) {
    throw new LiFiApprovalValidationError(
      `Refusing to approve: "${toolKey}" is not a LI.Fi tool on chain ${String(chainId)} — transaction aborted.`,
      "unknown-tool",
    );
  }

  let amount;
  try {
    amount = BigInt(fromAmount);
  } catch {
    throw new LiFiApprovalValidationError(
      "LI.Fi returned a non-numeric source amount — approval aborted.",
      "invalid-amount",
    );
  }
  if (amount <= 0n) {
    throw new LiFiApprovalValidationError(
      "LI.Fi returned a non-positive source amount — approval aborted.",
      "invalid-amount",
    );
  }

  return {
    approved: true,
    spender,
    amount,
    chainId: Number(chainId),
    toolKey,
  };
}
