/**
 * nearSignable.js — the SIGNED-IN-YOUR-WALLET execute surface for the NEAR
 * dexDirect leg (Ref Finance).
 *
 * 🔴 FUNDS RULE — nothing in this module broadcasts. It turns the leg's
 * build artifact (the ref-sdk `Transaction[]` action list) into exactly the
 * shape the connected NEAR wallet signs:
 *
 *   NEAR Wallet Selector —
 *     `selector.wallet(id).signAndSendTransaction({ receiverId, actions })`
 *     where the actions are near-api-js `Action` objects (the selector's
 *     internal descriptor form → `internalActionToNaj`). THE WALLET signs and
 *     submits; the agent never calls sign/send itself.
 *
 * The two-step split mirrors solanaSignable.js:
 *   refTransactionsToRequests — PURE: SDK `Transaction[]` (each
 *     `{ receiverId, functionCalls:[{ methodName, args, gas, amount }] }`)
 *     → the Wallet-Selector internal action descriptors
 *     `{ signerId, receiverId, actions:[{ type:"FunctionCall", params:{...} }] }`.
 *     No SDK, no network — unit-tested directly.
 *   toWalletActions — maps the descriptors through the injected
 *     `internalActionToNaj` (default: the lazy @near-wallet-selector/core
 *     export) → the near-api-js Action list the wallet signs.
 *
 * There is NO signAndSendTransaction / sendTransaction / broadcast anywhere
 * here. The anchor harness hands the returned request to the wallet adapter;
 * Mr. Esters approves in his NEAR wallet; the WALLET's own connection
 * broadcasts.
 */

/** Lazy default converter — the Wallet Selector's internalActionToNaj. */
let _najPromise = null;
function defaultInternalActionToNaj() {
  if (!_najPromise) {
    _najPromise = import("@near-wallet-selector/core").then((m) => m.internalActionToNaj);
  }
  return _najPromise;
}

/**
 * Convert ONE ref-sdk `Transaction` into Wallet-Selector internal action
 * descriptors. PURE.
 * @param {{receiverId: string, functionCalls: Array<{methodName: string,
 *   args?: object, gas?: string, amount?: string}>}} tx
 * @returns {Array<{type: string, params: object}>}
 */
export function refTransactionToDescriptors(tx) {
  const calls = Array.isArray(tx?.functionCalls) ? tx.functionCalls : [];
  return calls.map((fc) => ({
    type: "FunctionCall",
    params: {
      methodName: fc.methodName,
      args: fc.args ?? {},
      gas: fc.gas != null ? String(fc.gas) : null,
      deposit: fc.amount != null ? String(fc.amount) : "0",
    },
  }));
}

/**
 * Convert the SDK `Transaction[]` into per-receiver sign requests. PURE.
 * @param {Array} transactions ref-sdk Transaction[]
 * @param {string} accountId the connected NEAR account (the signerId)
 * @returns {Array<{signerId: string, receiverId: string, actions: Array}>}
 */
export function refTransactionsToRequests(transactions, accountId) {
  if (!Array.isArray(transactions)) return [];
  return transactions.map((tx) => ({
    signerId: accountId ?? null,
    receiverId: tx?.receiverId ?? null,
    actions: refTransactionToDescriptors(tx),
  }));
}

/**
 * Map the internal descriptors to near-api-js Wallet Selector actions via the
 * injected converter (default: the lazy @near-wallet-selector/core export).
 * @param {Array} descriptors internal action descriptors
 * @param {{internalActionToNaj?: Function}} [deps]
 * @returns {Promise<Array>} near-api-js Action list
 */
export async function toWalletActions(descriptors, { internalActionToNaj = null } = {}) {
  const convert = internalActionToNaj ?? (await defaultInternalActionToNaj());
  if (typeof convert !== "function") {
    throw new Error("nearSignable.toWalletActions: no internalActionToNaj converter (inject one)");
  }
  return descriptors.map((d) => convert(d));
}

/**
 * The NEAR per-leg execute PLAN: turn the built artifact into the
 * wallet-ready sign request(s). Read-only; NO broadcast.
 *
 * @param {object} args
 * @param {object} args.artifact the nearSwapLeg build artifact
 *   (`{ refTransactions, quote, … }`)
 * @param {string} args.accountId the connected NEAR account
 * @param {Function} [args.internalActionToNaj] injected converter (tests)
 * @returns {Promise<{chain: string, requests: Array, walletRequest: object,
 *   quote: object, boundary: string}>}
 */
export async function planNearExecute({ artifact, accountId, internalActionToNaj = null }) {
  if (!artifact || !Array.isArray(artifact.refTransactions)) {
    throw new Error("planNearExecute: artifact.refTransactions is required");
  }
  if (!accountId) throw new Error("planNearExecute: accountId is required");
  const requests = refTransactionsToRequests(artifact.refTransactions, accountId);
  const first = requests[0] ?? null;
  const walletRequest = first
    ? { receiverId: first.receiverId, actions: await toWalletActions(first.actions, { internalActionToNaj }) }
    : null;
  return {
    chain: "near",
    router: artifact.router ?? null,
    requests,
    walletRequest,
    quote: artifact.quote ?? null,
    boundary:
      "sign-in-wallet: the NEAR Wallet Selector signs + submits (its sign-and-send request). " +
      "The agent never broadcasts — sign in your wallet; the wallet's own connection sends on Mr. Esters' confirm.",
  };
}
