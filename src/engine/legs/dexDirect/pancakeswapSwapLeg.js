/**
 * pancakeswapSwapLeg.js — the PANCAKESWAP V3 DEX-DIRECT swap leg (the
 * dexDirect family's BNB Chain fallback). PancakeSwap v3 is a Uniswap-v3
 * fork deployed by PancakeSwap on BNB (its OWN factory/quoter/router — NOT
 * the canonical Uniswap addresses; the deployments file from
 * pancakeswap/pancake-v3-contracts pins them, and the live eth_getCode +
 * quoter eth_calls 2026-09-05 verified them):
 *
 *   factory 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
 *   QuoterV2 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997   ← the REAL quoter
 *            (a stale 0xB048Bbc1…B5023F2 address is often quoted — NO code)
 *   SwapRouter 0x1b81D678ffb9C0263b24A97847620C99d213eB14
 *
 * VALUE NOTE (direct vs LiFi-wrapped — honest): LiFi routes BNB same-chain
 * swaps through PancakeSwap pools already; this leg is the NO-AGGREGATOR
 * FALLBACK (LiFi down → quote + execute directly), the same argument as the
 * Uniswap leg. PCS fee tiers on BNB: 100/500/2500/10000 (pools for the
 * app's USDC→USDT verified at every tier).
 *
 * QUOTE: PCS QuoterV2.quoteExactInputSingle eth_call (read-only, live-
 * verified: bsc USDC→USDT fee-100 → 9,997,494 per 10 USDC).
 * EXECUTE (SIGNABLE — this phase): the swap tx is built for Mr. Esters'
 * WALLET to sign — evmSignable.planEvmDexExecute returns
 * { needsApproval, approvalTx?, swapTx } (approval = fromToken.approve(
 * PANCAKESWAP_V3_SWAP_ROUTER, exact amount) when the read-only allowance
 * is short; swapTx = the PCS SwapRouter exactInputSingle with a fresh
 * deadline, viem-encoded). NO broadcast: submit() throws
 * DexDirectLiveTestGateError — "the agent CANNOT broadcast — sign in your
 * wallet". The anchor harness (src/lib/dexAnchor/) hands the txs to Rabby.
 *
 * ctx (build): { chain: "bsc", fromToken, toToken, amount, fee?,
 *   slippageBps?, recipient?, deadline?, quoteHex? }
 */
import { createLeg } from "../../legContract.js";
import { TOKENS } from "../../../lib/teleportConstants.js";
import {
  shapeQuoterCall,
  parseQuoterResponse,
  shapeExactInputSingleCall,
  DEFAULT_FEE_TIERS,
} from "./evmV3.js";
import { DexDirectLiveTestGateError, DEX_DIRECT_LIVE_TEST_GATE_MESSAGE } from "./liveTestGate.js";

/** PancakeSwap v3 deployments on BNB (pancake-v3-contracts deployments/
 *  bscMainnet.json — verified live 2026-09-05). */
export const PANCAKESWAP_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
export const PANCAKESWAP_V3_QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
export const PANCAKESWAP_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
export const PANCAKESWAP_CHAIN = "bsc";

/** Resolve symbol pair → addresses via the canonical registry (bsc). */
export function resolvePcsPair(chain, fromSymbol, toSymbol) {
  const from = TOKENS[chain]?.[fromSymbol];
  const to = TOKENS[chain]?.[toSymbol];
  if (!from || !to) {
    throw new Error(`resolvePcsPair: unknown pair ${fromSymbol}/${toSymbol} on ${chain} (TOKENS registry)`);
  }
  return { from: { symbol: fromSymbol, ...from }, to: { symbol: toSymbol, ...to } };
}

/**
 * Shape the canonical PancakeSwap v3 artifact (quoter eth_call REQUEST +
 * swap-call REQUEST — same fork shape as the Uniswap leg, PCS addresses).
 */
export function shapePancakeSwapArtifact({ chain = PANCAKESWAP_CHAIN, fromSymbol, toSymbol, amount, fee = null, slippageBps = 50, recipient = null, deadline = null, quoteHex = null, quoter = PANCAKESWAP_V3_QUOTER_V2, router = PANCAKESWAP_V3_SWAP_ROUTER }) {
  if (chain !== PANCAKESWAP_CHAIN) {
    throw new Error(`shapePancakeSwapArtifact: PancakeSwap v3 is deployed on bsc (got "${chain}")`);
  }
  const pair = resolvePcsPair(chain, fromSymbol, toSymbol);
  const feeTier = fee ?? DEFAULT_FEE_TIERS.pcs?.[chain]?.[`${fromSymbol}:${toSymbol}`];
  if (!feeTier) {
    throw new Error(`shapePancakeSwapArtifact: no default fee tier for ${fromSymbol}→${toSymbol} on ${chain} (supply ctx.fee)`);
  }
  const amountStr = String(amount);
  if (!/^[0-9]+$/.test(amountStr)) throw new Error("shapePancakeSwapArtifact: amount must be raw base units");
  const deadlineVal = deadline ?? 4102444800; // synthetic DI fixture default (2030)

  // 🔴 BURN-RECIPIENT GUARD (wire-level — mirrors the Uniswap leg): a
  // quote-pinned swap-call request must name its recipient. Shaping one to
  // the zero address would send the output to 0x0 on a live anchor.
  if (quoteHex && !recipient) {
    throw new Error(
      "shapePancakeSwapArtifact: refusing to shape a swap-call request to the zero address — " +
        "a quote-pinned request must name its recipient (a real flow passes the session wallet)"
    );
  }

  const quoteRequest = shapeQuoterCall({
    quoter,
    tokenIn: pair.from.address,
    tokenOut: pair.to.address,
    amountIn: amountStr,
    fee: feeTier,
    chain,
  });

  let quote = null;
  if (quoteHex) {
    const parsed = parseQuoterResponse(quoteHex);
    quote = {
      amountIn: amountStr,
      amountOut: parsed.amountOut,
      minOutRaw: ((BigInt(parsed.amountOut) * BigInt(10000 - slippageBps)) / 10000n).toString(),
      sqrtPriceX96After: parsed.sqrtPriceX96After,
      initializedTicksCrossed: parsed.initializedTicksCrossed,
      gasEstimate: parsed.gasEstimate,
      slippageBps,
    };
  }

  return {
    dex: "pancakeswap",
    chain,
    chainId: 56,
    chainName: "BNB Chain",
    fromToken: { symbol: fromSymbol, address: pair.from.address, decimals: pair.from.decimals },
    toToken: { symbol: toSymbol, address: pair.to.address, decimals: pair.to.decimals },
    amountIn: amountStr,
    fee: feeTier,
    quoter,
    router,
    quoteRequest,
    ...(quote ? { quote } : {}),
    ...(recipientAddrOr(recipient, quote)
      ? {
          swapRequest: shapeExactInputSingleCall({
            router,
            tokenIn: pair.from.address,
            tokenOut: pair.to.address,
            fee: feeTier,
            recipient: recipient ?? "0x0000000000000000000000000000000000000000",
            deadline: deadlineVal,
            amountIn: amountStr,
            amountOutMinimum: quote ? quote.minOutRaw : "0",
            chain,
          }),
        }
      : {}),
    liveStatus: quote
      ? "quote-level REAL (live quoter eth_call capture); swap-execution pending Mr. Esters' live anchor"
      : "quote-level construction (no live response frozen) — the stage layer runs the eth_call",
  };
}

function recipientAddrOr(recipient, quote) {
  return Boolean(recipient || quote);
}

/**
 * Create the PancakeSwap v3 DEX-direct swap leg.
 * ctx per phase:
 *   build: { chain: "bsc", fromToken, toToken, amount, fee?, slippageBps?,
 *            recipient?, deadline?, quoteHex? }
 *   submit: 🔴 always throws DexDirectLiveTestGateError.
 */
export function createPancakeSwapSwapLeg() {
  return createLeg({
    id: "pancakeswap-swap",
    family: "evm",
    chain: "bsc",
    description:
      "The PancakeSwap v3 DEX-direct swap leg (BNB Chain fallback — the no-aggregator path " +
      "when LiFi is down, or for fee comparison): the REAL quote via PancakeSwap's own " +
      "QuoterV2 quoteExactInputSingle eth_call (0xB048Bbc1…e25997 — the deployment-record " +
      "address, verified live) + the SIGNABLE execute — planEvmDexExecute returns " +
      "{ needsApproval, approvalTx?, swapTx } for Mr. Esters' wallet (Rabby) to sign. " +
      "🔴 NO-BROADCAST GATE: submit() always throws DexDirectLiveTestGateError — the agent " +
      "CANNOT broadcast; sign in your wallet. Swap-execution pending Mr. Esters' live anchor.",
    goldenStep: "pancakeswap",
    phases: {
      async build(ctx) {
        const chain = ctx.chain ?? PANCAKESWAP_CHAIN;
        if (chain !== PANCAKESWAP_CHAIN) {
          throw new Error(`pancakeswapSwapLeg.build: PancakeSwap v3 is deployed on bsc (got "${chain}")`);
        }
        if (!ctx.fromToken || !ctx.toToken) throw new Error("pancakeswapSwapLeg.build: fromToken and toToken are required");
        if (!Number.isFinite(Number(ctx.amount)) || Number(ctx.amount) <= 0) {
          throw new Error("pancakeswapSwapLeg.build: a positive raw amount is required");
        }
        const artifact = shapePancakeSwapArtifact({
          chain,
          fromSymbol: ctx.fromToken,
          toSymbol: ctx.toToken,
          amount: String(ctx.amount),
          ...(ctx.fee !== undefined ? { fee: ctx.fee } : {}),
          ...(ctx.slippageBps !== undefined ? { slippageBps: ctx.slippageBps } : {}),
          ...(ctx.recipient ? { recipient: ctx.recipient } : {}),
          ...(ctx.deadline !== undefined ? { deadline: ctx.deadline } : {}),
          ...(ctx.quoteHex ? { quoteHex: ctx.quoteHex } : {}),
        });
        return { needed: true, artifact };
      },
      // 🔴 THE GUARD — the honest live-anchor boundary (never signs/broadcasts).
      async submit() {
        throw new DexDirectLiveTestGateError(DEX_DIRECT_LIVE_TEST_GATE_MESSAGE);
      },
    },
    meta: {
      wraps:
        "GREENFIELD DIRECT integration: PancakeSwap's own v3 fork deployments on BNB " +
        "(pancake-v3-contracts bscMainnet.json — the quoter 0xB048Bbc1…e25997 is the REAL " +
        "one; a stale …B5023F2 address circulates with NO code). Same fork ABI as Uniswap " +
        "(quoteExactInputSingle 0xc6a5026a / exactInputSingle 0x414bf389). Direct-vs-" +
        "aggregator note: LiFi routes through these same pools — this leg is the independent " +
        "no-aggregator path, not a better price.",
      liveTestAnchor: "pancakeswap-swap-execution",
    },
  });
}

/**
 * The PancakeSwap leg's SIGNABLE execute planner (bound to the PCS v3
 * SwapRouter via the artifact). Returns { needsApproval, approvalTx?,
 * swapTx } for Rabby — see evmSignable.planEvmDexExecute. Read-only
 * allowance eth_call only; no broadcast anywhere.
 */
export { planEvmDexExecute as planPancakeSwapSwapExecute } from "./evmSignable.js";
