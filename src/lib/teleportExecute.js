/**
 * teleportExecute.js — stage-1 EVM execution for the v2 Teleport tab (Phase 3
 * bridge form). Ported from v1's inline `executeLiFiTx` in Teleporter.jsx —
 * the SAME guards, in the SAME order, with the wallet injected instead of
 * v1's getOriginWallet:
 *
 *   1. ENSURE CORRECT SOURCE CHAIN — LiFi builds the tx for a specific chain
 *      (txReq.chainId); if the wallet is on a different network the approval
 *      + bridge tx would execute on the WRONG chain and revert. Switch first.
 *   2. ERC-20 APPROVAL — validate the spender against the same step object
 *      that supplies the bridge tx + LiFi's /v1/tools (fetched through our
 *      proxy), then approve EXACTLY the amount being bridged (never
 *      MaxUint256) — simulation-gated via guardedSendEvmTx (Step 1.3A).
 *      Steps LiFi marks as needing no allowance (no approvalAddress) and
 *      native sends skip this entirely.
 *   3. BRIDGE TX — simulation-gated send (guardedSendEvmTx): eth_call (+ gas
 *      estimate) with the EXACT params first; a revert blocks the send and
 *      the surfaced reason propagates as a SimulationError. eth_sendTransaction
 *      is NEVER called on a doomed tx.
 *
 * No fee logic lives here (fees.ts is the single source). No live-send gate
 * lives here either — the WARP_LIVE_SEND gate governs the Warp stage 2
 * (TeleportForm), not this LiFi leg.
 */

import { validateLiFiApproval, buildApprovalData, LiFiApprovalValidationError } from "./lifiApproval.js";
import { guardedSendEvmTx, SimulationError } from "./simulateTx.js";
import { CHAINS } from "./teleportConstants.js";

/**
 * Execute the LiFi EVM transaction from a quote (the EVM→Solana leg of the
 * X1 hop). Chain-switch → validated exact approval → sim-gated bridge send.
 *
 * @param {{lifiData: object, provider: object, address: string,
 *          onStatus?: (msg: string) => void}} args
 *   provider = the resolved EIP-1193 provider (see wallet/sessionProviders.js)
 *   address  = the connected EVM session's address (from)
 *   onStatus = quiet status-line callback for the approval flow (optional)
 * @returns {Promise<string>} the bridge transaction hash
 * @throws {SimulationError} when the pre-send simulation reverts / can't run
 * @throws {LiFiApprovalValidationError} when the approval spender fails
 *   validation (aborts before anything is signed)
 */
export async function executeLiFiEvmTx({ lifiData, provider, address, onStatus = () => {} }) {
  const txReq = lifiData?.transactionRequest || lifiData?.steps?.[0]?.transactionRequest;
  if (!txReq) throw new Error("No transaction data in quote");

  // ── ENSURE CORRECT SOURCE CHAIN ──
  try {
    let targetChainId = txReq.chainId;
    if (typeof targetChainId === "string") {
      targetChainId = parseInt(targetChainId, targetChainId.startsWith("0x") ? 16 : 10);
    }
    if (targetChainId && Number.isFinite(targetChainId)) {
      const targetHex = "0x" + targetChainId.toString(16);
      const currentHex = await provider.request({ method: "eth_chainId" });
      if (String(currentHex).toLowerCase() !== targetHex.toLowerCase()) {
        const chainName = Object.values(CHAINS).find((c) => c.chainId === targetChainId)?.name || `chain ${targetChainId}`;
        onStatus(`Switch your wallet to ${chainName}…`);
        try {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: targetHex }] });
        } catch (switchErr) {
          if (switchErr?.code === 4902) throw new Error(`Add ${chainName} to your wallet, then retry the bridge`);
          throw new Error(`Approve the network switch to ${chainName} in your wallet, then retry`);
        }
      }
    }
  } catch (e) {
    if (e?.message?.includes("network switch") || e?.message?.includes("Add ")) throw e;
    // Non-fatal (some providers don't support eth_chainId cleanly) — continue.
    console.warn("[Teleport v2] chain check skipped:", e?.message);
  }

  // ── ERC-20 APPROVAL (the step whose absence caused the Across V4 revert) ──
  // Validate against the SAME step object that supplies the bridge tx — never
  // mix top-level fields with steps[0] fields from different steps. Any check
  // that fails ABORTS before anything is signed.
  try {
    const step = lifiData?.transactionRequest ? lifiData : (lifiData?.steps?.[0] || lifiData);
    const action = step?.action || {};
    const est = step?.estimate || {};
    const tokenAddr = action?.fromToken?.address;
    const chainId = action?.fromToken?.chainId ?? txReq?.chainId;
    const isNative = !tokenAddr || /^0x0+$/.test(tokenAddr) ||
                     tokenAddr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    if (!isNative && est?.approvalAddress) {
      // Fetch LiFi's tool list for the source chain. Fail-closed: if the list
      // can't be fetched, validation aborts rather than approving blind.
      let toolsData = null;
      try {
        const cidNum = Number(chainId);
        const cidParam = Number.isFinite(cidNum) ? String(cidNum) : String(chainId);
        const toolsRes = await fetch(`/api/lifi/tools?chains=${encodeURIComponent(cidParam)}`);
        if (toolsRes.ok) toolsData = await toolsRes.json();
      } catch (e) {
        console.error("[Teleport v2] tools fetch failed:", e);
      }
      const { spender, amount } = validateLiFiApproval({ step, toolsData });
      const need = amount; // EXACT raw source amount from the quote
      // allowance(owner,spender) => 0xdd62ed3e
      const allowData = "0xdd62ed3e" +
        address.slice(2).padStart(64, "0") +
        spender.slice(2).padStart(64, "0");
      const allowanceHex = await provider.request({
        method: "eth_call",
        params: [{ to: tokenAddr, data: allowData }, "latest"],
      });
      const current = BigInt(allowanceHex && allowanceHex !== "0x" ? allowanceHex : "0x0");
      if (current < need) {
        onStatus("Approve token spend first (1 of 2)…");
        // approve(spender, amount) — EXACT amount, never MaxUint256.
        // Simulation-gated (Step 1.3A): a revert blocks the send and surfaces
        // the actual reason.
        const approveData = buildApprovalData({ spender, amount: need });
        const approveHash = await guardedSendEvmTx(provider, {
          from: address, to: tokenAddr, data: approveData, value: "0x0",
        });
        onStatus("Approval sent — waiting for confirmation…");
        await waitForReceipt(provider, approveHash);
        onStatus("Approved ✓ — now confirm the bridge (2 of 2)");
      }
    }
  } catch (e) {
    // Spender-validation aborts carry a user-facing message; pass them
    // through untouched. Simulation rejections (Step 1.3A) also carry the
    // surfaced revert reason — pass those through too. Everything else is
    // an approval failure.
    if (e instanceof LiFiApprovalValidationError || e instanceof SimulationError) throw e;
    throw new Error("Token approval failed: " + (e?.message || e));
  }

  // ── BRIDGE TX ──
  const params = [{
    from: address,
    to: txReq.to,
    data: txReq.data,
    value: txReq.value || "0x0",
    ...(txReq.gasLimit ? { gas: typeof txReq.gasLimit === "string" ? txReq.gasLimit : "0x" + BigInt(txReq.gasLimit).toString(16) } : {}),
  }];
  // Simulation-gated send (Step 1.3A): eth_call (+ gas estimate) with the
  // EXACT params first. If the bridge would revert, eth_sendTransaction is
  // NEVER called — the SimulationError (with the surfaced revert reason)
  // propagates to the caller and is surfaced to the user.
  return guardedSendEvmTx(provider, params[0]);
}

/** Poll for a tx receipt (used to wait for an ERC-20 approval before bridging). */
export async function waitForReceipt(provider, hash, tries = 40) {
  for (let i = 0; i < tries; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (r && r.blockNumber) {
      if (r.status && BigInt(r.status) === 0n) throw new Error("Approval tx reverted");
      return r;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw new Error("Approval not confirmed in time");
}
