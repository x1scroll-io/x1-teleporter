/**
 * tonSwapLeg.test.js — the TON / STON.fi dexDirect leg + the TON signable
 * layer. Offline: the router is a fake (or the real SDK's offline body
 * builder); no network, no broadcast.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLeg } from "../../legContract.js";
import {
  createTonSwapLeg,
  buildTonSwapArtifact,
  buildStonfiSwapBody,
  STONFI_SWAP_OPS,
  STONFI_ROUTER_V1_ADDRESS,
  STONFI_SWAP_OP,
} from "./tonSwapLeg.js";
import { DexDirectLiveTestGateError } from "./liveTestGate.js";
import {
  senderArgumentsToMessage,
  buildTonSwapMessages,
  bodyToBase64,
  planTonExecute,
} from "./tonSignable.js";
import { loadStonfiSdk } from "../../../lib/sdk/sdkTon.js";

const fakeCell = (b64 = "BASE64BOC") => ({ toBoc: () => ({ toString: () => b64 }) });
const fakeAddr = (s = "EQfake") => ({ toString: () => s });

function fakeRouter(method = "getSwapTonToJettonTxParams") {
  return {
    [method]: async () => ({ to: fakeAddr("EQpto"), value: 100000000n, body: fakeCell() }),
  };
}

test("createTonSwapLeg: leg shape (family ton, chain ton, id ton-swap)", () => {
  const leg = createTonSwapLeg();
  assert.equal(leg.id, "ton-swap");
  assert.equal(leg.family, "ton");
  assert.equal(leg.chain, "ton");
});

test("STONFI ops map + constants (drift canary)", () => {
  assert.deepEqual(STONFI_SWAP_OPS, {
    "jetton-to-jetton": "getSwapJettonToJettonTxParams",
    "jetton-to-ton": "getSwapJettonToTonTxParams",
    "ton-to-jetton": "getSwapTonToJettonTxParams",
  });
  assert.equal(STONFI_SWAP_OP, 0x25938561);
  assert.equal(STONFI_ROUTER_V1_ADDRESS, "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt");
});

test("buildTonSwapArtifact: dispatches to the op's router method → messages", async () => {
  const artifact = await buildTonSwapArtifact({
    op: "ton-to-jetton",
    router: fakeRouter("getSwapTonToJettonTxParams"),
    provider: {},
    params: { userWalletAddress: "EQuser", askJettonAddress: "EQask", offerAmount: 100000000n, minAskAmount: 1n },
  });
  assert.equal(artifact.venue, "stonfi");
  assert.equal(artifact.method, "getSwapTonToJettonTxParams");
  assert.equal(artifact.messages.length, 1);
  assert.equal(artifact.messages[0].address, "EQpto");
  assert.equal(artifact.messages[0].amount, "100000000");
  assert.equal(artifact.messages[0].payload, "BASE64BOC");
});

test("buildTonSwapArtifact: rejects unknown op + missing router method", async () => {
  await assert.rejects(() => buildTonSwapArtifact({ op: "nope", router: fakeRouter(), provider: {} }), /op must be/);
  await assert.rejects(() => buildTonSwapArtifact({ op: "ton-to-jetton", router: {}, provider: {} }), /no getSwapTonToJettonTxParams/);
});

test("runLeg(tonSwapLeg): build produces the artifact, submit throws the gate", async () => {
  const leg = createTonSwapLeg();
  const ctx = {
    op: "ton-to-jetton",
    router: fakeRouter("getSwapTonToJettonTxParams"),
    provider: {},
    params: { userWalletAddress: "EQuser", askJettonAddress: "EQask", offerAmount: 100000000n, minAskAmount: 1n },
  };
  const built = await leg.phases.build(ctx);
  assert.equal(built.needed, true);
  assert.equal(built.artifact.venue, "stonfi");
  // runLeg drives build → submit; the guarded submit ALWAYS throws the gate.
  await assert.rejects(() => runLeg(leg, ctx), DexDirectLiveTestGateError);
});

test("tonSignable: senderArgumentsToMessage + multi-message + BOC string passthrough", () => {
  const msg = senderArgumentsToMessage({ to: fakeAddr("EQx"), value: 5n, body: fakeCell("AAA") });
  assert.deepEqual(msg, { address: "EQx", amount: "5", payload: "AAA" });
  assert.deepEqual(bodyToBase64("already-a-boc"), "already-a-boc");
  assert.equal(bodyToBase64(null), null);
  const list = buildTonSwapMessages([{ to: fakeAddr("EQa"), value: 1n, body: fakeCell() }, { to: fakeAddr("EQb"), value: 2n, body: fakeCell() }]);
  assert.equal(list.length, 2);
  assert.throws(() => senderArgumentsToMessage({ to: null, value: 1n, body: null }), /required/);
});

test("tonSignable: planTonExecute assembles { validUntil, messages } (no send)", () => {
  const artifact = { router: STONFI_ROUTER_V1_ADDRESS, messages: [{ address: "EQx", amount: "5", payload: "AAA" }] };
  const plan = planTonExecute({ artifact, validUntil: 1234 });
  assert.equal(plan.chain, "ton");
  assert.equal(plan.validUntil, 1234);
  assert.deepEqual(plan.messages, artifact.messages);
  assert.match(plan.boundary, /agent never broadcasts/);
  const auto = planTonExecute({ artifact });
  assert.ok(auto.validUntil > Math.floor(Date.now() / 1000) - 1);
  assert.throws(() => planTonExecute({ artifact: {} }), /messages/);
});

test("buildStonfiSwapBody: the REAL SDK builds the offline swap body (op 0x25938561)", async () => {
  const { DEX } = await loadStonfiSdk();
  const router = new DEX.v1.Router();
  const body = await buildStonfiSwapBody(router, {
    userWalletAddress: router.address,
    minAskAmount: 123n,
    askJettonWalletAddress: router.address,
  });
  assert.equal(body.beginParse().loadUintBig(32), 0x25938561n);
});
