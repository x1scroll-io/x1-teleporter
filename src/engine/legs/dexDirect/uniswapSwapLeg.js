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
 * quote; live-verified: eth USDC→USDT fee-100 → 9,997,036 per 10 USDC).
 * EXECUTE: SwapRouter.exactInputSingle request artifact — GUARDED (submit()
 * throws DexDirectLiveTestGateError — "READY FOR LIVE ANCHOR").
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
  DEFAULT_FEE_TIERS,
} from "./evmV3.js";
import { DexDirectLiveTestGateError, DEX_DIRECT_LIVE_TEST_GATE_MESSAGE } from "./liveTestGate.js";

/** Canonical Uniswap v3 deployments (same addresses on every deployed
 *  chain). */
export const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
export const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
export const UNISWAP_V3_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
export const UNISWAP_UNIVERSAL_ROUTER = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

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
