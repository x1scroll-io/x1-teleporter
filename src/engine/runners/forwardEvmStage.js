/**
 * forwardEvmStage.js — runs the EVM stage (stage 1 of 2) of the forward
 * route ETH → X1 through the routing engine's legs.
 *
 * This runner is the engine home of what executeLiFiEvmTx
 * (src/lib/teleportExecute.js) did for the reference path — SAME sequence,
 * SAME guards, SAME error policy, SAME status lines, with each step now a
 * LegContract leg flowing through runLeg:
 *
 *   0. CHAIN-ENSURE (prelude) — LiFi builds the tx for a specific chain
 *      (txReq.chainId); if the wallet is on a different network the approval
 *      + bridge tx would execute on the WRONG chain and revert. Switch first
 *      (non-fatal catch parity with the reference path).
 *   1. evm-approval leg — exact-amount ERC-20 approval (skips itself for
 *      native / no-approval / already-sufficient-allowance steps), wrapped in
 *      the reference error policy: LiFiApprovalValidationError + SimulationError
 *      pass through untouched; anything else is a "Token approval failed: …".
 *   2. lifi-evm-bridge leg — the quote's transactionRequest forwarded
 *      verbatim through the simulation gate; its submit result is the stage-1
 *      tx hash.
 *
 * The runner never signs or broadcasts itself — legs do, through the
 * injected EIP-1193 provider (resolved by the caller via SignerResolver, the
 * same proven resolveEvmProvider underneath).
 *
 * Returns { stage: "evm_sent", txHash } — the reference return shape the
 * form's executeStage1 reads (a bridge tx hash).
 *
 * ctx: { route, lifiData, provider, address, onStatus? }
 */
import { runLeg } from "../legContract.js";
import { legsForStage } from "../routePlanner.js";
import { SimulationError } from "../../lib/simulateTx.js";
import { LiFiApprovalValidationError } from "../../lib/lifiApproval.js";
import { CHAINS } from "../../lib/teleportConstants.js";

/**
 * Ensure the wallet is on the chain the bridge tx targets (the reference
 * prelude, migrated verbatim). Non-fatal when the provider can't answer
 * cleanly; wallet-declined switches surface the actionable message.
 */
export async function ensureEvmChain(provider, txReq, onStatus = () => {}) {
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
    console.warn("[engine] chain check skipped:", e?.message);
  }
}

/**
 * Run the forward route's EVM stage (approval → LiFi bridge).
 *
 * @param {{route: object, lifiData: object, provider: object,
 *          address: string, onStatus?: (msg: string) => void}} args
 * @returns {Promise<{stage: "evm_sent", txHash: string}>}
 * @throws {SimulationError} when a pre-send simulation reverts / can't run
 *   (the bridge tx never reaches eth_sendTransaction)
 * @throws {LiFiApprovalValidationError} when the approval spender fails
 *   validation (aborts before anything is signed)
 * @throws {Error("Token approval failed: …")} for any other approval-leg
 *   failure (the reference wrap — wallet rejections included)
 */
export async function runForwardEvmStage({ route, lifiData, provider, address, onStatus = () => {} }) {
  const txReq = lifiData?.transactionRequest || lifiData?.steps?.[0]?.transactionRequest;
  if (!txReq) throw new Error("No transaction data in quote");

  // 0 — chain ensure (before ANY EVM interaction; the approval's allowance
  //     read + sim run on the wallet's current chain).
  await ensureEvmChain(provider, txReq, onStatus);

  const [approvalLeg, bridgeLeg] = legsForStage(route, "evm");
  if (!approvalLeg || !bridgeLeg) {
    throw new Error("forwardEvmStage: route has no evm-stage legs (planner broken)");
  }
  const ctx = { lifiData, provider, address, onStatus };

  // 1 — the approval leg, under the reference error policy. Fail-closed
  //     validation errors + simulation rejections pass through untouched;
  //     everything else (wallet 4001 included) is an approval failure.
  try {
    await runLeg(approvalLeg, ctx);
  } catch (e) {
    if (e instanceof LiFiApprovalValidationError || e instanceof SimulationError) throw e;
    throw new Error("Token approval failed: " + (e?.message || e));
  }

  // 2 — the LiFi bridge leg: verbatim transactionRequest, sim-gated send.
  //     SimulationError propagates (eth_sendTransaction NEVER called on a
  //     doomed tx); the submit result is the stage-1 hash.
  const bridgeRun = await runLeg(bridgeLeg, ctx);
  const txHash = bridgeRun.results?.submit;
  if (!txHash) {
    throw new Error("Bridge transaction did not return a hash");
  }
  return { stage: "evm_sent", txHash };
}
