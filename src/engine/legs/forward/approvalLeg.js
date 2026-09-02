/**
 * approvalLeg.js — the ERC-20 EXACT-amount approval leg of the forward route
 * (ETH → X1). Reproduces golden step1 (test/fixtures/golden/forward-leg/
 * step1-approval.json) and is the engine home of the approval flow the
 * reference implementation runs inside executeLiFiEvmTx (src/lib/
 * teleportExecute.js) — SAME validation, SAME allowance read, SAME exact
 * approve() calldata, SAME simulation gate, SAME error policy. Wrap, don't
 * rewrite: buildApprovalData + validateLiFiApproval come from
 * src/lib/lifiApproval.js, simulateEvmTx from src/lib/simulateTx.js,
 * waitForReceipt from src/lib/teleportExecute.js (the proven code).
 *
 * BYTE-IDENTITY CONTRACT (the oracle)
 *   build(ctx).artifact must canonical-JSON-equal the golden step1 fixture
 *   artifact and sha256 to its recorded hash: the calldata is
 *   approve(spender, EXACT amount) — never MaxUint256 — where spender is the
 *   quote's approvalAddress (the allowlisted LiFi Diamond) and amount is the
 *   quote's raw fromAmount. The wallet builds the envelope; the app-controlled
 *   bytes end at the calldata + tx params.
 *
 * LIFECYCLE
 *   build     → pure artifact + the needed/not-needed decision (native sends
 *               and steps without an approvalAddress skip the leg).
 *   simulate  → live gate: fail-closed spender validation against /v1/tools
 *               + the Diamond allowlist (validateLiFiApproval), the allowance
 *               read, and — when an approval is actually needed — the eth_call
 *               simulation of the EXACT approval tx (throws SimulationError on
 *               a revert → the leg stops before the wallet is ever asked).
 *               Returns { ok:true, skipSubmit:true } when the allowance is
 *               already sufficient (the reference path skips the approval).
 *   submit    → eth_sendTransaction with the exact params (the wallet's sign
 *               prompt). The 4001/"User rejected" path throws the raw wallet
 *               error — the stage runner wraps it in the reference "Token
 *               approval failed: …" policy (see runners/forwardEvmStage.js).
 *   confirm   → waitForReceipt (poll eth_getTransactionReceipt), then the
 *               "Approved ✓" status line — the reference sequence.
 */
import { createLeg } from "../../legContract.js";
import { buildApprovalData, validateLiFiApproval, normalizeEvmAddress } from "../../../lib/lifiApproval.js";
import { simulateEvmTx } from "../../../lib/simulateTx.js";
import { waitForReceipt } from "../../../lib/teleportExecute.js";

/** True for native-token steps (no ERC-20 approval exists to sign). */
function isNativeStep(action) {
  const tokenAddr = action?.fromToken?.address;
  return (
    !tokenAddr ||
    /^0x0+$/.test(tokenAddr) ||
    tokenAddr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  );
}

/**
 * Resolve the quote object a single-step LiFi route reads (top-level
 * transactionRequest wins; multi-step routes read steps[0]) — the exact
 * selection the reference path + the golden rebuild share.
 */
export function resolveQuoteStep(lifiData) {
  if (!lifiData || typeof lifiData !== "object") return null;
  if (lifiData.transactionRequest) return lifiData;
  return lifiData.steps?.[0] || lifiData;
}

/**
 * Build the approval artifact EXACTLY as the golden step1 fixture defines it.
 * Deterministic + offline. Throws a plain Error when the quote cannot yield a
 * usable spender/amount (a garbage quote is caught downstream by the
 * fail-closed validateLiFiApproval in simulate — this builder mirrors the
 * golden rebuild, which assumes a well-formed quote).
 */
export function buildApprovalArtifact({ lifiData, address }) {
  const step = resolveQuoteStep(lifiData);
  if (!step) throw new Error("approvalLeg.build: no quote data");
  const action = step.action || {};
  const est = step.estimate || {};
  const txReq = lifiData.transactionRequest || step.transactionRequest || {};

  const native = isNativeStep(action);
  const spender = normalizeEvmAddress(est?.approvalAddress || txReq?.to || "");
  const amountRaw = action?.fromAmount ?? est?.fromAmount;
  let amount = 0n;
  try {
    amount = amountRaw === undefined || amountRaw === null || amountRaw === "" ? 0n : BigInt(amountRaw);
  } catch {
    amount = 0n;
  }

  // Needed = an ERC-20 allowance is part of this step (not native, and LiFi
  // named an approvalAddress). Everything below mirrors the golden builder;
  // the artifact exists only when an approval could be needed. Unusable
  // spender/amount do NOT throw here — the fail-closed validateLiFiApproval
  // in simulate() is the gate that rejects garbage quotes with the reference
  // LiFiApprovalValidationError (parity with executeLiFiEvmTx).
  const needed = !native && Boolean(est?.approvalAddress);
  if (!needed) {
    return {
      step,
      needed: false,
      reason: native ? "native" : "no-approval-required",
      artifact: null,
    };
  }
  if (!spender || amount <= 0n) {
    return { step, needed: true, unusable: true, artifact: null };
  }

  const calldata = buildApprovalData({ spender, amount });
  const tokenAddress = normalizeEvmAddress(action?.fromToken?.address);
  const from = normalizeEvmAddress(address);
  if (!from) throw new Error("approvalLeg.build: no usable from address");
  const params = { from, to: tokenAddress, data: calldata, value: "0x0" };

  const artifact = {
    selector: calldata.slice(0, 10),
    spender,
    amountRaw: amount.toString(),
    amountHuman: Number(amount) / 10 ** (action?.fromToken?.decimals ?? 6),
    tokenAddress,
    evmAddress: from,
    calldata,
    txParams: params,
  };
  return { step, needed: true, artifact };
}

/**
 * Create the approval leg. ctx (per phase):
 *   build:    { lifiData, address }                  — quote + connected EVM address
 *   simulate: { provider, address, onStatus? } (+ the build result) — tools
 *             fetch goes to /api/lifi/tools through the global fetch (the
 *             same same-origin proxy the reference path uses); DI-able later.
 *   submit:   { provider }
 *   confirm:  { provider, onStatus? }
 */
export function createApprovalLeg() {
  return createLeg({
    id: "evm-approval",
    family: "evm",
    chain: "eth",
    description:
      "Exact-amount ERC-20 approval for the LiFi Diamond spender (golden step1) — " +
      "skips itself for native sends, no-approval steps, and sufficient allowances.",
    goldenStep: "step1-approval",
    phases: {
      async build(ctx) {
        return buildApprovalArtifact({ lifiData: ctx.lifiData, address: ctx.address });
      },

      async simulate(ctx, built) {
        const b = built?.build;
        if (!b || !b.needed) return { ok: true, skipSubmit: true, reason: "approval-not-needed" };
        if (!ctx.provider || typeof ctx.provider.request !== "function") {
          throw new Error("approvalLeg.simulate: no EIP-1193 provider (connect an EVM wallet)");
        }
        const step = b.step;
        const chainId = step?.action?.fromToken?.chainId ?? step?.transactionRequest?.chainId;

        // ── FAIL-CLOSED spender validation (the reference gate, verbatim):
        //    fetch LiFi's tool list for the source chain; validate against the
        //    SAME step object that supplies the bridge tx + the Diamond
        //    allowlist. A fetch failure ABORTS (validateLiFiApproval throws)
        //    — we never approve blind. ──
        let toolsData = null;
        try {
          const cidNum = Number(chainId);
          const cidParam = Number.isFinite(cidNum) ? String(cidNum) : String(chainId);
          const toolsRes = await fetch(`/api/lifi/tools?chains=${encodeURIComponent(cidParam)}`);
          if (toolsRes.ok) toolsData = await toolsRes.json();
        } catch (e) {
          console.error("[engine] tools fetch failed:", e);
        }
        const { spender, amount } = validateLiFiApproval({ step, toolsData }); // throws fail-closed
        if (!b.artifact) {
          throw new Error("approvalLeg.simulate: validated but no artifact (unreachable)");
        }

        // ── Allowance read — allowance(owner,spender) => 0xdd62ed3e ──
        const allowData =
          "0xdd62ed3e" +
          b.artifact.evmAddress.slice(2).padStart(64, "0") +
          spender.slice(2).padStart(64, "0");
        const allowanceHex = await ctx.provider.request({
          method: "eth_call",
          params: [{ to: b.artifact.tokenAddress, data: allowData }, "latest"],
        });
        const current = BigInt(allowanceHex && allowanceHex !== "0x" ? allowanceHex : "0x0");
        if (current >= amount) {
          return { ok: true, skipSubmit: true, reason: "allowance-sufficient" };
        }

        // ── Simulation gate on the EXACT approval tx (Step 1.3A): a revert
        //    throws SimulationError and the wallet is never asked to sign. ──
        ctx.onStatus?.("Approve token spend first (1 of 2)…");
        await simulateEvmTx(ctx.provider, b.artifact.txParams);
        return { ok: true, needsSignature: true };
      },

      async submit(ctx, built) {
        const b = built?.build;
        if (!b?.artifact) throw new Error("approvalLeg.submit: nothing to submit");
        const hash = await ctx.provider.request({
          method: "eth_sendTransaction",
          params: [b.artifact.txParams],
        });
        ctx.onStatus?.("Approval sent — waiting for confirmation…");
        return hash;
      },

      async confirm(ctx, built) {
        const b = built?.build;
        const hash = built?.submit;
        if (!b?.artifact || !hash) throw new Error("approvalLeg.confirm: no approval hash");
        const receipt = await waitForReceipt(ctx.provider, hash);
        ctx.onStatus?.("Approved ✓ — now confirm the bridge (2 of 2)");
        return receipt;
      },
    },
    meta: {
      wraps:
        "lifiApproval.buildApprovalData + validateLiFiApproval, simulateTx.simulateEvmTx, " +
        "teleportExecute.waitForReceipt — the approval block of executeLiFiEvmTx",
      liveGate: "LiFiApprovalValidationError (fail-closed) + SimulationError (Step 1.3A)",
    },
  });
}
