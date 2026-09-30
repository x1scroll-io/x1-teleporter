/**
 * nearSwapLeg.test.js — the NEAR / Ref Finance dexDirect leg + the NEAR
 * signable layer. Offline: the ref-sdk estimator/builders are injected fakes;
 * no network, no broadcast.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLeg, createLeg } from "../../legContract.js";
import {
  createNearSwapLeg,
  buildNearSwapArtifact,
  normalizeRefToken,
  isNativeNear,
  REF_FINANCE_ROUTER,
} from "./nearSwapLeg.js";
import { DexDirectLiveTestGateError } from "./liveTestGate.js";
import {
  refTransactionToDescriptors,
  refTransactionsToRequests,
  toWalletActions,
  planNearExecute,
} from "./nearSignable.js";

const WNEAR = { id: "wrap.near", symbol: "wNEAR", decimals: 24 };
const USDT = { id: "usdt.tether-token.near", symbol: "USDT", decimals: 6 };
const ACCOUNT = "alice.near";
const POOLS = [{ id: 7, tokenIds: [WNEAR.id, USDT.id] }];

/** A fake ref-sdk surface: estimateSwap + instantSwap (+ optional wrap). */
function fakeRefSdk({ estimate = "990", pool = { id: 7, tokenIds: [WNEAR.id, USDT.id] }, withWrap = true } = {}) {
  return {
    estimateSwap: async () => [{ estimate, pool }],
    instantSwap: async ({ tokenIn, amountIn }) => [
      { receiverId: REF_FINANCE_ROUTER, functionCalls: [{ methodName: "ft_transfer_call", args: { receiver_id: REF_FINANCE_ROUTER, amount: amountIn, msg: JSON.stringify({ actions: [] }) }, gas: "100000000000000", amount: "1" }] },
    ],
    ...(withWrap ? { nearDepositTransaction: (amount) => ({ receiverId: "wrap.near", functionCalls: [{ methodName: "near_deposit", args: {}, gas: "50000000000000", amount }] }) } : {}),
  };
}

test("createNearSwapLeg: leg shape (family near, chain near, id near-swap)", () => {
  const leg = createNearSwapLeg();
  assert.equal(leg.id, "near-swap");
  assert.equal(leg.family, "near");
  assert.equal(leg.chain, "near");
  assert.equal(typeof leg.phases.build, "function");
  assert.equal(typeof leg.phases.submit, "function");
});

test("legContract: createLeg now accepts the near + ton families", () => {
  const near = createLeg({ id: "x-near", family: "near", chain: "near", phases: {} });
  const ton = createLeg({ id: "x-ton", family: "ton", chain: "ton", phases: {} });
  assert.equal(near.family, "near");
  assert.equal(ton.family, "ton");
  assert.throws(() => createLeg({ id: "x", family: "cosmos", phases: {} }));
});

test("normalizeRefToken / isNativeNear", () => {
  assert.equal(normalizeRefToken("wrap.near").id, "wrap.near");
  assert.equal(normalizeRefToken({ id: "a.near", decimals: 8 }).decimals, 8);
  assert.equal(isNativeNear("near"), true);
  assert.equal(isNativeNear({ id: "NEAR" }), true);
  assert.equal(isNativeNear(WNEAR), false);
});

test("buildNearSwapArtifact: estimates + builds the action list (injected SDK)", async () => {
  const artifact = await buildNearSwapArtifact({
    tokenIn: WNEAR, tokenOut: USDT, amountInRaw: "1000", accountId: ACCOUNT, pools: POOLS, refSdk: fakeRefSdk(),
  });
  assert.equal(artifact.venue, "ref-finance");
  assert.equal(artifact.router, REF_FINANCE_ROUTER);
  assert.equal(artifact.wrappedNative, false);
  assert.equal(artifact.quote.amountOutRaw, "990");
  assert.equal(artifact.refTransactions.length, 1);
  assert.equal(artifact.refTransactions[0].receiverId, REF_FINANCE_ROUTER);
});

test("buildNearSwapArtifact: native NEAR input prepends the wrap tx", async () => {
  const artifact = await buildNearSwapArtifact({
    tokenIn: { id: "near", symbol: "NEAR", decimals: 24 }, tokenOut: USDT, amountInRaw: "1000", accountId: ACCOUNT, pools: POOLS, refSdk: fakeRefSdk(),
  });
  assert.equal(artifact.wrappedNative, true);
  assert.equal(artifact.tokenIn, "wrap.near");
  assert.equal(artifact.refTransactions.length, 2);
  assert.equal(artifact.refTransactions[0].receiverId, "wrap.near");
  assert.equal(artifact.refTransactions[0].functionCalls[0].methodName, "near_deposit");
});

test("buildNearSwapArtifact: throws on missing inputs (fail-closed build)", async () => {
  await assert.rejects(() => buildNearSwapArtifact({ tokenIn: WNEAR, tokenOut: USDT, amountInRaw: "1", accountId: ACCOUNT, pools: [], refSdk: fakeRefSdk() }), /simplePools/);
  await assert.rejects(() => buildNearSwapArtifact({ tokenIn: WNEAR, tokenOut: USDT, amountInRaw: "1", pools: POOLS, refSdk: fakeRefSdk() }), /accountId/);
  await assert.rejects(() => buildNearSwapArtifact({ tokenIn: WNEAR, tokenOut: USDT, amountInRaw: "0", accountId: ACCOUNT, pools: POOLS, refSdk: fakeRefSdk() }), /positive raw amountInRaw/);
  await assert.rejects(
    () => buildNearSwapArtifact({ tokenIn: WNEAR, tokenOut: USDT, amountInRaw: "1", accountId: ACCOUNT, pools: POOLS, refSdk: { estimateSwap: async () => [], instantSwap: async () => [] } }),
    /no route/,
  );
});

test("runLeg(nearSwapLeg): build produces the artifact, submit throws the gate", async () => {
  const leg = createNearSwapLeg();
  const ctx = { tokenIn: WNEAR, tokenOut: USDT, amountInRaw: "1000", accountId: ACCOUNT, pools: POOLS, refSdk: fakeRefSdk() };
  const built = await leg.phases.build(ctx);
  assert.equal(built.needed, true);
  assert.equal(built.artifact.venue, "ref-finance");
  // runLeg drives build → submit; the guarded submit ALWAYS throws the gate.
  await assert.rejects(() => runLeg(leg, ctx), DexDirectLiveTestGateError);
});

test("nearSignable: refTransactionToDescriptors maps function calls", () => {
  const tx = { receiverId: "v2.ref-finance.near", functionCalls: [{ methodName: "ft_transfer_call", args: { a: 1 }, gas: "100", amount: "1" }] };
  const d = refTransactionToDescriptors(tx);
  assert.equal(d.length, 1);
  assert.equal(d[0].type, "FunctionCall");
  assert.equal(d[0].params.methodName, "ft_transfer_call");
  assert.equal(d[0].params.deposit, "1");
  assert.equal(d[0].params.gas, "100");
});

test("nearSignable: refTransactionsToRequests + planNearExecute (injected converter)", async () => {
  const artifact = await buildNearSwapArtifact({ tokenIn: WNEAR, tokenOut: USDT, amountInRaw: "1000", accountId: ACCOUNT, pools: POOLS, refSdk: fakeRefSdk() });
  const requests = refTransactionsToRequests(artifact.refTransactions, ACCOUNT);
  assert.equal(requests[0].signerId, ACCOUNT);
  assert.equal(requests[0].receiverId, REF_FINANCE_ROUTER);

  const fakeConverter = (d) => ({ enum: "functionCall", functionCall: { methodName: d.params.methodName } });
  const actions = await toWalletActions(requests[0].actions, { internalActionToNaj: fakeConverter });
  assert.equal(actions[0].functionCall.methodName, "ft_transfer_call");

  const plan = await planNearExecute({ artifact, accountId: ACCOUNT, internalActionToNaj: fakeConverter });
  assert.equal(plan.chain, "near");
  assert.equal(plan.walletRequest.receiverId, REF_FINANCE_ROUTER);
  assert.match(plan.boundary, /agent never broadcasts/);
});

test("nearSignable: planNearExecute requires artifact + accountId", async () => {
  await assert.rejects(() => planNearExecute({ artifact: {}, accountId: ACCOUNT }), /refTransactions/);
  await assert.rejects(() => planNearExecute({ artifact: { refTransactions: [] }, accountId: null }), /accountId/);
});
