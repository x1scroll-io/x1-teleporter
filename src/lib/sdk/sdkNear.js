/**
 * sdkNear.js — READINESS SCAFFOLDING for the official Ref Finance SDK
 * (`@ref-finance/ref-sdk`, pinned ^1.5.0 — the current line, verified on npm
 * 2026-09-30).
 *
 * ROADMAP LEG: the NEAR source chain's native-DEX lane. NEAR joins the
 * wallet families (src/lib/wallet/nearRegistry.js) and the DEX registry
 * (`src/lib/registry.js` — Ref Finance `v2.ref-finance.near`, the v2
 * exchange contract). This module exists so the official ref-sdk is
 * GRABBED, version-pinned and import-verified for the nearSwapLeg
 * (quote → pool resolution → build swap → the connected wallet signs).
 *
 * ⛔ NOT WIRED INTO A LIVE FLOW BY THIS MODULE. The deps are dynamic-imported
 * (makeSdkLoader) so the SDK lands in a lazily-loaded chunk, never in the
 * Vite main bundle. Constructing nothing here fires a network request; the
 * wrappers below only run when the nearSwapLeg's build path calls them.
 *
 * SHAPE VERIFIED at 1.5.0 (probe, 2026-09-30):
 *   - estimateSwap({ tokenIn, tokenOut, amountIn, simplePools, options? })
 *       → Promise<EstimateSwapView[]>   (pure — needs the pools supplied)
 *   - getPoolByIds(ids: number[]) → Promise<Pool[]>            (indexer read)
 *   - getPool(id: number) → Promise<Pool>                      (indexer read)
 *   - instantSwap({ tokenIn, tokenOut, amountIn, slippageTolerance,
 *       swapTodos, AccountId, referralId? }) → Promise<Transaction[]>
 *       where Transaction = { receiverId, functionCalls: [{ methodName,
 *       args, gas?, amount? }] }  — a SERIALIZABLE NEAR action list (this is
 *       the leg's build output: no broadcast).
 *   - transformTransactions(transactions, AccountId) → [{ signerId,
 *       receiverId, actions: [{ type:"FunctionCall", params:{ methodName,
 *       args, gas, deposit } }] }]  — the Wallet Selector internal action
 *       descriptor form (src/engine/legs/dexDirect/nearSignable.js consumes
 *       this shape).
 *   - REF_FI_CONTRACT_ID === "v2.ref-finance.near"; WRAP_NEAR_CONTRACT_ID
 *       === "wrap.near" (cross-checked by sdkNear.test.js).
 */

import { makeSdkLoader } from "./sdkLoader.js";

/**
 * The canonical Ref Finance v2 exchange contract (the swap entry point).
 * Cross-checked at test time against the SDK's own `REF_FI_CONTRACT_ID`
 * export — the registry (`src/lib/dex/registry.js`) holds the same value.
 */
export const REF_FINANCE_CONTRACT_ID = "v2.ref-finance.near";

/**
 * The wrapped-NEAR (NEP-141) contract. Native NEAR is represented by
 * `wrap.near` in Ref pools (the universal base pair), so a native-NEAR swap
 * must WRAP first (nearDepositTransaction).
 */
export const WRAP_NEAR_CONTRACT_ID = "wrap.near";

/** Cached lazy loader — the checked `@ref-finance/ref-sdk` namespace. */
export const loadRefSdk = makeSdkLoader("@ref-finance/ref-sdk", {
  exports: [
    "estimateSwap",
    "getPoolByIds",
    "getPool",
    "instantSwap",
    "parsePool",
    "transformTransactions",
    "nearDepositTransaction",
    "REF_FI_CONTRACT_ID",
    "WRAP_NEAR_CONTRACT_ID",
  ],
});

/**
 * Estimate a swap route (pure — the caller supplies the candidate pools, e.g.
 * from getRefPoolsByIds against the Ref indexer).
 * @param {{tokenIn: object, tokenOut: object, amountIn: string,
 *   simplePools: Array, options?: object}} args
 * @returns {Promise<Array>} EstimateSwapView[]
 */
export async function estimateRefSwap({ tokenIn, tokenOut, amountIn, simplePools, options }) {
  const { estimateSwap } = await loadRefSdk();
  return estimateSwap({ tokenIn, tokenOut, amountIn, simplePools, ...(options ? { options } : {}) });
}

/**
 * Resolve Ref pools by id through the SDK (indexer read — read-only).
 * @param {Array<number|string>} ids
 * @returns {Promise<Array>} Pool[]
 */
export async function getRefPoolsByIds(ids) {
  const { getPoolByIds } = await loadRefSdk();
  return getPoolByIds((ids || []).map((x) => Number(x)));
}

/**
 * Build the swap action list (the leg's build output). Returns the SDK's
 * `Transaction[]` — a serializable NEAR action list; NOTHING is signed or
 * broadcast here.
 * @param {{tokenIn: object, tokenOut: object, amountIn: string,
 *   slippageTolerance: number|string, swapTodos: Array, accountId: string,
 *   referralId?: string}} args
 * @returns {Promise<Array>} Transaction[]
 */
export async function buildRefSwapTransactions({ tokenIn, tokenOut, amountIn, slippageTolerance, swapTodos, accountId, referralId }) {
  const { instantSwap } = await loadRefSdk();
  return instantSwap({
    tokenIn,
    tokenOut,
    amountIn,
    slippageTolerance,
    swapTodos,
    AccountId: accountId,
    ...(referralId ? { referralId } : {}),
  });
}

/**
 * Convert the SDK `Transaction[]` into the Wallet Selector internal action
 * descriptor form via the SDK's own transform (used by the signable layer).
 * @param {Array} transactions SDK Transaction[]
 * @param {string} accountId
 * @returns {Promise<Array>}
 */
export async function transformRefTransactions(transactions, accountId) {
  const { transformTransactions } = await loadRefSdk();
  return transformTransactions(transactions, accountId);
}

/**
 * Build the native-NEAR wrap deposit transaction (native NEAR → wNEAR). Pure
 * (SDK-synchronous) — used by the leg when the input token is native NEAR.
 * @param {string} amount yoctoNEAR as a decimal string
 * @returns {Promise<object>} the Ref `Transaction` for the wrap
 */
export async function nearWrapTransaction(amount) {
  const { nearDepositTransaction } = await loadRefSdk();
  return nearDepositTransaction(amount);
}
