/**
 * uniswapSwapLeg.js — the UNISWAP V3 DEX-DIRECT swap leg (the dexDirect
 * family's EVM fallback — the no-aggregator path when the LiFi AGGREGATOR
 * path is down, or for fee comparison).
 *
 * VALUE NOTE (direct vs LiFi-wrapped — honest): LiFi already routes EVM
 * same-chain swaps through Uniswap v3 pools with the same on-chain quote
 * quality (the lifi-evm-swap leg pinned that verdict). The DEX-direct leg's
 * value is NOT a better quote — it is the NO-AGGREGATOR FALLBACK: when
 * LiFi is down/rate-limited, the app can quote + (after Mr. Esters' live
 * anchor) execute the DIRECT periphery path itself (quoter eth_call for the
 * quote; SwapRouter.exactInputSingle for the swap). Two independent paths
 * to the same pools.
 *
 * PRESENCE MATRIX (verified live 2026-09-05, eth_getCode on the canonical
 * v3 factory/quoter/router): eth ✓ arb ✓ bas ✓ opt ✓ pol ✓ — avax ✗ (v3 is
 * NOT at the canonical deployment), bsc ✗ (PancakeSwap owns BNB — see the
 * pancakeswap leg), sonic ✗ (no Uniswap). Direct pools between the app's
 * registry stables were verified live per chain (factory getPool + live
 * quoter eth_calls — the frozen dex-direct fixtures).
 *
 * QUOTE: QuoterV2.quoteExactInputSingle eth_call (read-only — the REAL
 * quote; live-verified: eth USDC→USDT fee-100 → 9,997,027 per 10 USDC —
 * the frozen 2026-09-05 capture).
 * EXECUTE: SwapRouter.exactInputSingle request artifact — GUARDED (submit()
 * throws DexDirectLiveTestGateError — "READY FOR LIVE ANCHOR").
 *
 * SKILL CROSS-CHECK (official Uniswap swap-integration skill v1.5.0,
 * reviewed 2026-09-06 against this construction):
 *   • ROUTER — this leg deliberately uses the v3-periphery SwapRouter, NOT
 *     the Universal Router. The skill's approval-target table endorses the
 *     LEGACY DIRECT-APPROVE flow for backend/automated systems (approve
 *     the token to the router once; no Permit2 EIP-712 per-swap signing) —
 *     exactly the SwapRouter path. Universal Router would force Permit2
 *     (approve → Permit2 + per-swap signature/allowance) + command-encoded
 *     calldata + PER-CHAIN router addresses for zero benefit on a
 *     single-hop v3 swap. ⚠️ The old UR v1 address 0x3fC91A3a…7FAD (this
 *     module used to export it) is DEPRECATED/superseded per the skill —
 *     the current UR (2.0) is per-chain (eth 0x66a9893cc07d91d95644aedd0
 *     5d03f95e1dba8af; code presence re-verified 2026-09-06). Nothing here
 *     targets either.
 *   • QUOTE — QuoterV2 eth_call is kept over the skill's Trading API: the
 *     API needs a key and builds txs through Uniswap's gateway — this leg
 *     IS the independent no-aggregator fallback (documented decision).
 *   • PRE-BROADCAST — the skill's validation discipline is encoded as
 *     validateUniswapSwapRequest (router target / calldata shape /
 *     positive min-out / fresh deadline); the live anchor validates there
 *     before signing.
 *   • LIVE-ANCHOR APPROVAL — the ONE approval tx a live swap needs is
 *     fromToken.approve(UNISWAP_V3_SWAP_ROUTER, amount) (exact-amount —
 *     the lifiApproval discipline). Never approve to a Universal Router
 *     for this leg.
 *
 * ctx (build): { chain, fromToken (TOKENS symbol), toToken, amount (raw),
 *   fee? (default from DEFAULT_FEE_TIERS / ctx), slippageBps?,
 *   recipient?, deadline?, quoter?, router? }
 */
import { createLeg } from "../../legContract.js";
import { CHAINS, TOKENS } from "../../../lib/teleportConstants.js";
import {
  shapeQuoterCall,
  parseQuoterResponse,
  shapeExactInputSingleCall,
  validateExactInputSingleSwapRequest,
  DEFAULT_FEE_TIERS,
} from "./evmV3.js";
import { DexDirectLiveTestGateError, DEX_DIRECT_LIVE_TEST_GATE_MESSAGE } from "./liveTestGate.js";

/** Canonical Uniswap v3 deployments (same addresses on every chain the
 *  canonical deployment covers — verified eth_getCode 2026-09-05 and
 *  re-verified 2026-09-06 on eth/arb/opt/pol/bas). See the module header
 *  for the SwapRouter-vs-Universal-Router decision and the live-anchor
 *  approval target (spender = UNISWAP_V3_SWAP_ROUTER). */
export const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
export const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
export const UNISWAP_V3_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

/** The skill-aligned pre-broadcast validator bound to the canonical v3
 *  SwapRouter (see evmV3.validateExactInputSingleSwapRequest). A live
 *  anchor validates its swap-call request HERE before Mr. Esters signs:
 *  router target, calldata shape (selector + 8 words), positive min-out
 *  (a quote must have landed), fresh deadline, non-payable value. */
export function validateUniswapSwapRequest(request, options = {}) {
  return validateExactInputSingleSwapRequest(request, { router: UNISWAP_V3_SWAP_ROUTER, ...options });
}

/** Chains with the canonical v3 deployment (verified eth_getCode 2026-09-05;
 *  the leg builds any of them; the app's served set is eth/arb/bas/opt/pol). */
export const UNISWAP_V3_CHAINS = Object.freeze(["eth", "arb", "bas", "opt", "pol"]);
/** The app's CHAINS keys Uniswap v3 can serve (presence-verified). */
export const UNISWAP_SERVED_CHAINS = Object.freeze(UNISWAP_V3_CHAINS);

/** Resolve symbol pair → addresses + decimals via the canonical registry. */
export function resolveUniPair(chain, fromSymbol, toSymbol) {
  const from = TOKENS[chain]?.[fromSymbol];
  const to = TOKENS[chain]?.[toSymbol];
  if (!from || !to) {
    throw new Error(`resolveUniPair: unknown pair ${fromSymbol}/${toSymbol} on ${chain} (TOKENS registry)`);
  }
  return { from: { symbol: fromSymbol, ...from }, to: { symbol: toSymbol, ...to } };
}

/**
 * Shape the canonical dex-direct artifact: the quoter eth_call REQUEST (the
 * real read-only quote) + the swap-call REQUEST the guarded execute would
 * sign (exactInputSingle, min-out at slippage). When `quoteHex` is
 * supplied, the live quoter response is parsed into the artifact (the
 * fixture pattern: quote inputs frozen from live captures).
 */
export function shapeUniswapSwapArtifact({ chain, fromSymbol, toSymbol, amount, fee = null, slippageBps = 50, recipient = null, deadline = null, quoteHex = null, quoter = UNISWAP_V3_QUOTER_V2, router = UNISWAP_V3_SWAP_ROUTER }) {
  const chainId = CHAINS[chain]?.chainId;
  if (!chainId) throw new Error(`shapeUniswapSwapArtifact: unknown chain "${chain}"`);
  const pair = resolveUniPair(chain, fromSymbol, toSymbol);
  const feeTier = fee ?? DEFAULT_FEE_TIERS.uni?.[chain]?.[`${fromSymbol}:${toSymbol}`];
  if (!feeTier) {
    throw new Error(`shapeUniswapSwapArtifact: no default fee tier for ${chain} ${fromSymbol}→${toSymbol} (supply ctx.fee)`);
  }
  const amountStr = String(amount);
  if (!/^[0-9]+$/.test(amountStr)) throw new Error("shapeUniswapSwapArtifact: amount must be raw base units");
  const chainRecord = CHAINS[chain];
  const recipientAddr = recipient ?? null; // a real flow passes the session wallet
  const deadlineVal = deadline ?? 4102444800; // synthetic DI fixture default (2030) — a real flow passes now+30min

  // 🔴 BURN-RECIPIENT GUARD (wire-level): a quote-pinned swap-call request
  // must name its recipient. Shaping one to the zero address would send the
  // output to 0x0 on a live anchor — refuse instead of shaping the footgun.
  if (quoteHex && !recipientAddr) {
    throw new Error(
      "shapeUniswapSwapArtifact: refusing to shape a swap-call request to the zero address — " +
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
    dex: "uniswap",
    chain,
    chainId,
    chainName: chainRecord.name,
    fromToken: { symbol: fromSymbol, address: pair.from.address, decimals: pair.from.decimals },
    toToken: { symbol: toSymbol, address: pair.to.address, decimals: pair.to.decimals },
    amountIn: amountStr,
    fee: feeTier,
    quoter,
    router,
    quoteRequest,
    ...(quote ? { quote } : {}),
    ...(recipientAddr || quote
      ? {
          swapRequest: shapeExactInputSingleCall({
            router,
            tokenIn: pair.from.address,
            tokenOut: pair.to.address,
            fee: feeTier,
            recipient: recipientAddr ?? "0x0000000000000000000000000000000000000000",
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

/**
 * Create the Uniswap v3 DEX-direct swap leg.
 * ctx per phase:
 *   build: { chain, fromToken, toToken, amount, fee?, slippageBps?,
 *            recipient?, deadline?, quoteHex? }
 *   submit: 🔴 always throws DexDirectLiveTestGateError.
 */
export function createUniswapSwapLeg() {
  return createLeg({
    id: "uniswap-swap",
    family: "evm",
    chain: "eth",
    description:
      "The Uniswap v3 DEX-direct swap leg (EVM fallback — the no-aggregator path when LiFi " +
      "is down, or for fee comparison): the REAL quote via the QuoterV2 quoteExactInputSingle " +
      "eth_call (read-only, live-verified on eth/arb/opt/pol) + the SwapRouter " +
      "exactInputSingle swap-call request pinned for the guarded execute. 🔴 GUARDED STUB: " +
      "submit() always throws DexDirectLiveTestGateError — swap-execution pending Mr. " +
      "Esters' live anchor.",
    goldenStep: "uniswap",
    phases: {
      async build(ctx) {
        if (!ctx.chain) throw new Error("uniswapSwapLeg.build: chain is required");
        if (!UNISWAP_V3_CHAINS.includes(ctx.chain)) {
          throw new Error(`uniswapSwapLeg.build: no canonical Uniswap v3 deployment verified on "${ctx.chain}" (served: ${UNISWAP_V3_CHAINS.join(", ")})`);
        }
        if (!ctx.fromToken || !ctx.toToken) throw new Error("uniswapSwapLeg.build: fromToken and toToken are required");
        if (!Number.isFinite(Number(ctx.amount)) || Number(ctx.amount) <= 0) {
          throw new Error("uniswapSwapLeg.build: a positive raw amount is required");
        }
        const artifact = shapeUniswapSwapArtifact({
          chain: ctx.chain,
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
        "GREENFIELD DIRECT integration: QuoterV2.quoteExactInputSingle (0xc6a5026a — static " +
        "5-word calldata; response 4 words) + SwapRouter.exactInputSingle (0x414bf389 — static " +
        "8-word struct). Presence VERIFIED live (eth_getCode): eth/arb/bas/opt/pol canonical " +
        "deployment; NOT avax/bsc/sonic. Direct-vs-aggregator note: LiFi routes through these " +
        "same pools — this leg is the independent no-aggregator path, not a better price.",
      liveTestAnchor: "uniswap-swap-execution",
    },
  });
}
