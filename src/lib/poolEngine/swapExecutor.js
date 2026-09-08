/**
 * swapExecutor.js — Phase 5: the pool-version swap EXECUTOR (the "own the
 * swap layer" completion). Given a priced pool instance + a trade intent,
 * build the swap transaction DIRECTLY through the correct router for the
 * pool's version:
 *
 *   v2  → Router02.swapExactTokensForTokens[SupportingFeeOnTransferTokens]
 *   v3  → SwapRouter.exactInputSingle (the repo's proven shaper)
 *   v4  → Universal Router (probe-first — never assume addresses)
 *
 * 🔴 GATE + SIGN DISCIPLINE (unchanged, non-negotiable):
 *   - This module NEVER broadcasts. It returns SIGNABLE ARTIFACTS (the
 *     exact tx for Mr. Esters' wallet/Rabby to sign + broadcast on his
 *     confirm) — mirroring evmSignable.js.
 *   - MEV gate: `buildPoolSwap` throws PoolSwapGateError unless gateOpen.
 *   - FOT-aware: a taxed token routes through the SupportingFeeOnTransfer
 *     variant with auto-slippage from the measured tax (fotHandler).
 *
 * Instruments-first: the v3 shape reuses the repo's live-proven
 * shapeExactInputSingleCall (arb/bsc this session).
 */
import { Interface } from "ethers";
import { resolveDexFamily } from "./dexMap.js";
import { shapeExactInputSingleCall, shapeApproveCalldata } from "../../engine/legs/dexDirect/evmV3.js";
import { taxRoutingDecision } from "./fotHandler.js";

/** The gate error — fail-closed, mirrors the capture gate. */
export class PoolSwapGateError extends Error {
  constructor() { super("poolEngine.swapExecutor: swap building is gated OFF (MEV_CAPTURE_ENABLED=false) — detection only"); }
}

const V2_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
];

/**
 * v2SwapCalldata — Router02 exact-in swap, FOT-aware.
 * @param {object} p { router, tokenIn, tokenOut, amountIn, minOut, to, deadline, useFot }
 * @returns {string} calldata
 */
export function v2SwapCalldata({ router, tokenIn, tokenOut, amountIn, minOut, to, deadline, useFot = false }) {
  const iface = new Interface(V2_ROUTER_ABI);
  const fn = useFot ? "swapExactTokensForTokensSupportingFeeOnTransferTokens" : "swapExactTokensForTokens";
  return iface.encodeFunctionData(fn, [amountIn, minOut, [tokenIn, tokenOut], to, deadline]);
}

/**
 * buildPoolSwap — the one-call swap builder. Returns the SIGNABLE artifact.
 * @param {object} args {
 *   pool:        { chain, dexId, version, feeTier, pairAddress } (from poolEngine)
 *   router:      the router address for the pool's family (from dexMap —
 *                RH v3 fork router is proprietary → must pass it, else throw)
 *   tokenIn, tokenOut, amountIn (raw), amountOutMin (raw — from a quote or
 *                computed post-tax), recipient, taxProfile, selling,
 *                slippageBps, gateOpen
 * }
 * @returns {object} { kind:"signable-swap", version, to, data, approveTo,
 *   useFot, slippageBps, note } — NEVER broadcast here.
 */
export async function buildPoolSwap({ pool, router, tokenIn, tokenOut, amountIn, amountOutMin, recipient, taxProfile = null, selling = false, slippageBps = 100, gateOpen = false, deadline = null }) {
  if (!gateOpen) throw new PoolSwapGateError();
  if (!pool?.version) throw new Error("buildPoolSwap: pool requires a version");
  if (!router) throw new Error(`buildPoolSwap: no router for ${pool.dexId} on ${pool.chain} (probe/map it first — never guess)`);

  const fam = resolveDexFamily(pool.dexId);
  const d = deadline ?? Math.floor(Date.now() / 1000) + 1200;
  const taxDecision = taxProfile
    ? taxRoutingDecision(taxProfile, { selling, swapSlippageBps: slippageBps })
    : { useFotPath: false, reason: null, slippageBps };
  if (taxDecision.reason === "HONEYPOT") throw new Error("buildPoolSwap: refusing — honeypot (cannot sell)");
  const useFot = taxDecision.useFotPath;
  const finalSlippage = taxDecision.slippageBps;
  const minOut = amountOutMin ?? 0n; // caller quotes; 0 = unsafe — but the gate + sign step is the guard

  if (pool.version === "v3" && (fam.id === "uniswap-v3" || fam.id === "rh-uniswap-v3" || fam.id === "pancakeswap-v3")) {
    const data = shapeExactInputSingleCall({
      router, tokenIn, tokenOut, fee: pool.feeTier ?? 3000,
      recipient, deadline: d, amountIn, amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0, chain: pool.chain,
    });
    return {
      kind: "signable-swap", version: "v3", to: router, data: data.data,
      approveTo: router, useFot: false, slippageBps: finalSlippage,
      note: `v3 ${fam.id} fee-${pool.feeTier} — sign in wallet; wallet broadcasts on confirm`,
    };
  }
  if (pool.version === "v2") {
    const data = v2SwapCalldata({ router, tokenIn, tokenOut, amountIn, minOut: minOut, to: recipient, deadline: d, useFot });
    return {
      kind: "signable-swap", version: "v2", to: router, data,
      approveTo: router, useFot, slippageBps: finalSlippage,
      note: useFot ? `v2 FOT-aware swap (SupportingFeeOnTransfer) — ${taxDecision.reason}` : "v2 swap — sign in wallet",
    };
  }
  throw new Error(`buildPoolSwap: version ${pool.version} executor not implemented (v4 = Universal Router, phase 5b)`);
}

/**
 * buildApprove — the companion approval artifact (exact-amount, never
 * MaxUint — the audit discipline). Same gate.
 */
export async function buildApprove({ token, spender, amount, gateOpen = false }) {
  if (!gateOpen) throw new PoolSwapGateError();
  return { kind: "signable-approve", to: token, data: shapeApproveCalldata(spender, amount), approveTo: spender };
}
