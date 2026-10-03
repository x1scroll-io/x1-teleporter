/**
 * nearSwapLeg.js — the NEAR / REF FINANCE DEX-DIRECT swap leg (the dexDirect
 * family's NEAR leg).
 *
 * WHAT THIS LEG IS
 *   A DEX-DIRECT leg: when the aggregator path is unavailable the app can
 *   swap DIRECTLY through Ref Finance — the on-chain AMM at
 *   `v2.ref-finance.near` (the v2 exchange contract, verified from the
 *   protocol's own @ref-finance/ref-sdk config; see
 *   docs/NEAR-TON-DEX-RESEARCH.md §2–§3).
 *
 *   The quote + the swap build BOTH come from the OFFICIAL ref-sdk
 *   (`estimateSwap` → `instantSwap`), DI-injected into the build path so the
 *   leg is offline-testable and never fires a network request on its own:
 *     estimateSwap({ tokenIn, tokenOut, amountIn, simplePools })
 *       → EstimateSwapView[]  (pure)
 *     instantSwap({ tokenIn, tokenOut, amountIn, slippageTolerance,
 *       swapTodos, AccountId }) → Transaction[]
 *       where Transaction = { receiverId, functionCalls:[{ methodName, args,
 *       gas, amount }] }  — a SERIALIZABLE NEAR action list.
 *
 * 🔴 FUNDS RULE — the build PRODUCES that action list; it NEVER signs,
 *    broadcasts, or calls signAndSendTransaction/sendTransaction. The
 *    nearSignable layer converts the list to the wallet's sign request and the
 *    anchor harness hands it to Mr. Esters' NEAR wallet. submit() ALWAYS
 *    throws DexDirectLiveTestGateError — the agent CANNOT broadcast.
 *
 * NATIVE NEAR: Ref represents native NEAR as `wrap.near` (the universal base
 * pair). When the input token is native NEAR (id "near"/"NEAR"), the build
 * PREPENDS the wrap deposit transaction (`nearDepositTransaction`) to the
 * action list.
 *
 * ctx (build): { tokenIn, tokenOut, amountInRaw, slippageTolerance?,
 *   accountId, pools, refSdk?, wrapNative? }
 *   refSdk = { estimateSwap, instantSwap, nearDepositTransaction? } (default:
 *   the lazy sdkNear wrappers). pools = the ref-sdk simplePools array.
 */
import { createLeg } from "../../legContract.js";
import { DexDirectLiveTestGateError, DEX_DIRECT_LIVE_TEST_GATE_MESSAGE } from "./liveTestGate.js";
import {
  loadRefSdk,
  REF_FINANCE_CONTRACT_ID,
  WRAP_NEAR_CONTRACT_ID,
} from "../../../lib/sdk/sdkNear.js";

/** The Ref Finance v2 exchange contract — the swap entry point. */
export const REF_FINANCE_ROUTER = REF_FINANCE_CONTRACT_ID;
/** Native NEAR, as Ref names it in pools (the wrap base pair id). */
export const NEAR_NATIVE_TOKEN_ID = "near";
/** Default slippage tolerance (percent), matching the ref-sdk default. */
export const DEFAULT_REF_SLIPPAGE_TOLERANCE = 0.5;

/** True when a token ref is native NEAR (id "near"/"NEAR"/empty). */
export function isNativeNear(token) {
  const id = typeof token === "string" ? token : token?.id;
  return id === NEAR_NATIVE_TOKEN_ID || id === "NEAR" || id == null;
}

/**
 * Normalize a token reference into ref-sdk TokenMetadata shape. Accepts a
 * full TokenMetadata or a bare id string; decimals default to 24 (NEAR) for a
 * bare id — the caller should pass the real decimals.
 * @param {object|string} token
 * @returns {object} TokenMetadata
 */
export function normalizeRefToken(token) {
  if (token && typeof token === "object") {
    return {
      id: String(token.id),
      symbol: token.symbol ?? String(token.id),
      name: token.name ?? token.symbol ?? String(token.id),
      decimals: Number(token.decimals ?? 24),
      icon: token.icon ?? "",
    };
  }
  const id = String(token);
  return { id, symbol: id, name: id, decimals: 24, icon: "" };
}

/**
 * Build the NEAR swap artifact (the leg's deterministic output). Async — it
 * awaits the injected/real ref-sdk estimators. NO broadcast.
 *
 * @param {object} args { tokenIn, tokenOut, amountInRaw, slippageTolerance?,
 *   accountId, pools, refSdk?, wrapNative? }
 * @returns {Promise<object>} { venue, chain, router, tokenIn, tokenOut,
 *   amountInRaw, quote, refTransactions, boundary }
 */
export async function buildNearSwapArtifact({
  tokenIn,
  tokenOut,
  amountInRaw,
  slippageTolerance = DEFAULT_REF_SLIPPAGE_TOLERANCE,
  accountId,
  pools,
  refSdk = null,
  wrapNative = false,
} = {}) {
  if (!tokenIn || !tokenOut) throw new Error("nearSwapLeg.build: tokenIn and tokenOut are required");
  if (!accountId) throw new Error("nearSwapLeg.build: accountId is required");
  const amountIn = String(amountInRaw ?? "");
  if (!/^[0-9]+$/.test(amountIn) || amountIn === "0") {
    throw new Error("nearSwapLeg.build: a positive raw amountInRaw is required");
  }

  const sdk = refSdk ?? {
    estimateSwap: (await loadRefSdk()).estimateSwap,
    instantSwap: (await loadRefSdk()).instantSwap,
    nearDepositTransaction: (await loadRefSdk()).nearDepositTransaction,
  };
  const inMeta = normalizeRefToken(tokenIn);
  const outMeta = normalizeRefToken(tokenOut);
  const nativeIn = wrapNative || isNativeNear(tokenIn);

  // native NEAR → route the swap from wNEAR (wrap.near), prefixed by a wrap tx.
  const swapIn = nativeIn && inMeta.id !== WRAP_NEAR_CONTRACT_ID
    ? { ...inMeta, id: WRAP_NEAR_CONTRACT_ID, symbol: "wNEAR", name: "Wrapped NEAR" }
    : inMeta;

  const simplePools = Array.isArray(pools) ? pools : [];
  if (simplePools.length === 0) {
    throw new Error("nearSwapLeg.build: ctx.pools (ref-sdk simplePools) are required — fetch them via getRefPoolsByIds");
  }

  const swapTodos = await sdk.estimateSwap({
    tokenIn: swapIn,
    tokenOut: outMeta,
    amountIn,
    simplePools,
  });
  if (!Array.isArray(swapTodos) || swapTodos.length === 0) {
    throw new Error("nearSwapLeg.build: estimateSwap returned no route for the pair");
  }

  const refTransactions = await sdk.instantSwap({
    tokenIn: swapIn,
    tokenOut: outMeta,
    amountIn,
    slippageTolerance,
    swapTodos,
    AccountId: accountId,
  });

  const txs = [];
  if (nativeIn && typeof sdk.nearDepositTransaction === "function") {
    txs.push(sdk.nearDepositTransaction(amountIn)); // wrap native NEAR first
  }
  txs.push(...(Array.isArray(refTransactions) ? refTransactions : []));

  const best = swapTodos.find((v) => v && v.estimate != null) ?? swapTodos[0];
  const amountOutRaw = best?.estimate != null ? String(best.estimate) : null;
  const quote = amountOutRaw
    ? {
        venue: "ref-finance",
        chain: "near",
        tokenIn: swapIn.id,
        tokenOut: outMeta.id,
        amountInRaw: amountIn,
        amountOutRaw,
        pool: best?.pool?.id != null ? String(best.pool.id) : null,
      }
    : null;

  return {
    venue: "ref-finance",
    chain: "near",
    router: REF_FINANCE_ROUTER,
    wrappedNative: nativeIn,
    tokenIn: swapIn.id,
    tokenOut: outMeta.id,
    amountInRaw: amountIn,
    quote,
    refTransactions: txs,
    boundary:
      "produce-only: this is a SERIALIZABLE NEAR action list (ref-sdk Transaction[]) for the connected " +
      "NEAR wallet to sign (the Wallet Selector's sign-and-send request). The agent never broadcasts.",
  };
}

/**
 * Create the NEAR DEX-direct swap leg (Ref Finance).
 * ctx per phase:
 *   build:  { tokenIn, tokenOut, amountInRaw, accountId, pools, refSdk?, … }
 *   submit: 🔴 always throws DexDirectLiveTestGateError.
 */
export function createNearSwapLeg() {
  return createLeg({
    id: "near-swap",
    family: "near",
    chain: "near",
    description:
      "The NEAR DEX-direct swap leg (Ref Finance — v2.ref-finance.near, the AMM the " +
      "@ref-finance/ref-sdk config names). Uses the OFFICIAL ref-sdk to estimate the route " +
      "(estimateSwap over the injected simplePools) and to build the swap action list " +
      "(instantSwap → reserializable NEAR Transaction[]; native NEAR is wrapped to wrap.near " +
      "first). nearSignable converts the list to the connected wallet's sign request " +
      "(the Wallet Selector's sign-and-send). 🔴 NO-BROADCAST GATE: submit() always " +
      "throws DexDirectLiveTestGateError — the agent CANNOT broadcast; sign in your wallet. " +
      "Swap-execution pending Mr. Esters' live anchor.",
    phases: {
      async build(ctx) {
        const artifact = await buildNearSwapArtifact({
          tokenIn: ctx.tokenIn,
          tokenOut: ctx.tokenOut,
          amountInRaw: ctx.amountInRaw,
          ...(ctx.slippageTolerance !== undefined ? { slippageTolerance: ctx.slippageTolerance } : {}),
          accountId: ctx.accountId,
          pools: ctx.pools,
          ...(ctx.refSdk ? { refSdk: ctx.refSdk } : {}),
          ...(ctx.wrapNative !== undefined ? { wrapNative: ctx.wrapNative } : {}),
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
        "GREENFIELD DIRECT integration (Ref Finance mainnet): contract v2.ref-finance.near. " +
        "Quotes + build via the official @ref-finance/ref-sdk (estimateSwap / instantSwap); " +
        "native NEAR wrapped to wrap.near. Output = a NEAR action list; the connected NEAR " +
        "wallet signs + submits. No autonomous broadcast at any flag value.",
      liveTestAnchor: "near-swap-execution",
    },
  });
}

/** The NEAR leg's SIGNABLE execute planner (see nearSignable.planNearExecute). */
export { planNearExecute } from "./nearSignable.js";
