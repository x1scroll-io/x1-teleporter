/**
 * autoAdvance.test.js — the THORChain hop auto-advance (Step 3.1).
 *
 * Two layers:
 *   1. createAutoAdvancer — the pure sequencer: swap → skim → warp fire in
 *      STRICT order; a failure stops the chain at the failed step.
 *   2. createThorchainAdvanceActions — the REAL wiring: binds the three steps
 *      to the existing execution paths (executeLiFiSolanaTx from
 *      src/lib/lifiSolanaTx.js + warpBridge buildStage2/simulateStage2/
 *      runStage2), asserted with mocked modules.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoAdvancer, createThorchainAdvanceActions, ADVANCE_STEPS } from "./autoAdvance.js";

test("the advance sequence is swap → skim → warp (canonical order)", () => {
  assert.deepEqual([...ADVANCE_STEPS], ["swap", "skim", "warp"]);
});

test("advance runs swap → skim → warp in order with the same ctx", async () => {
  const calls = [];
  const advancer = createAutoAdvancer({
    actions: {
      swap: async (ctx) => { calls.push(["swap", ctx.id]); return "swap-sig"; },
      skim: async (ctx) => { calls.push(["skim", ctx.id]); return { skimBase: 1 }; },
      warp: async (ctx) => { calls.push(["warp", ctx.id]); return { signature: "warp-sig" }; },
    },
  });

  const result = await advancer.advance({ id: "hop-1" });

  assert.deepEqual(calls.map((c) => c[0]), ["swap", "skim", "warp"], "strict order");
  assert.ok(calls.every((c) => c[1] === "hop-1"), "same ctx passed to every step");
  assert.equal(result.ok, true);
  assert.equal(result.failedStep, null);
  assert.deepEqual(result.steps.map((s) => s.id), ["swap", "skim", "warp"]);
  assert.equal(result.steps[0].detail, "swap-sig");
  assert.equal(result.steps[2].detail.signature, "warp-sig");
  assert.ok(result.steps.every((s) => s.finishedAt >= s.startedAt));
});

test("a failed step stops the chain — later steps never fire", async () => {
  const calls = [];
  const advancer = createAutoAdvancer({
    actions: {
      swap: async () => { calls.push("swap"); return "ok"; },
      skim: async () => { calls.push("skim"); throw new Error("skim revert"); },
      warp: async () => { calls.push("warp"); return "ok"; },
    },
  });

  const result = await advancer.advance({ id: "hop-2" });

  assert.deepEqual(calls, ["swap", "skim"], "warp never fires after the skim failure");
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "skim");
  assert.equal(result.error, "skim revert");
});

test("a failure in the first step reports swap as the failed step", async () => {
  const advancer = createAutoAdvancer({
    actions: {
      swap: async () => { throw new Error("no quote"); },
      skim: async () => "never",
      warp: async () => "never",
    },
  });
  const result = await advancer.advance({});
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "swap");
  assert.match(result.error, /no quote/);
});

test("createAutoAdvancer requires all three actions", () => {
  assert.throws(() => createAutoAdvancer({ actions: { swap: async () => {} } }), /actions\.swap \/ actions\.skim \/ actions\.warp are required/);
  assert.throws(() => createAutoAdvancer({}), /actions/);
});

/* ————— the real wiring (mocked modules) ————— */

function mockWarpBridge() {
  const calls = [];
  return {
    calls,
    buildStage2: async (args) => { calls.push(["buildStage2", args]); return { transaction: { isStage2: true }, skimBase: 100n }; },
    simulateStage2: async (conn, tx) => { calls.push(["simulateStage2", { conn, tx }]); return { ok: true }; },
    runStage2: async (args) => { calls.push(["runStage2", args]); return { stage: "simulated_ok", success: true }; },
  };
}

function mockLiFi() {
  const calls = [];
  return {
    calls,
    executeLiFiSolanaTx: async (args) => { calls.push(["executeLiFiSolanaTx", args]); return "sol-swap-sig"; },
  };
}

const CONN = { isFake: true };
const SOL_ADDR = "FakeSolanaAddress11111111111111111111111111111111";

test("wiring: swap → executeLiFiSolanaTx with the quote + connected wallet", async () => {
  const lifi = mockLiFi();
  const warp = mockWarpBridge();
  const solWallet = { provider: { name: "Phantom" } };
  const listProviders = () => [{ provider: { name: "Backup" } }];

  const actions = createThorchainAdvanceActions({
    liFiSolanaTx: lifi,
    warpBridge: warp,
    solWallet,
    listSolProviders: listProviders,
    connection: CONN,
    feeWalletSvm: "FeeWalletSvm1111111111111111111111111111111",
    apiBase: "/api",
  });

  const detail = await actions.swap({ lifiData: { quote: 1 } });

  assert.equal(detail, "sol-swap-sig");
  assert.equal(lifi.calls.length, 1);
  const [name, args] = lifi.calls[0];
  assert.equal(name, "executeLiFiSolanaTx");
  assert.equal(args.lifiData.quote, 1);
  assert.equal(args.solWallet.provider.name, "Phantom");
  assert.equal(args.apiBase, "/api");
  assert.deepEqual(args.listSolProviders(), listProviders(), "fallback lister passed through");
});

test("wiring: swap without a quote fails clearly (Step 3.2 supplies lifiData)", async () => {
  const actions = createThorchainAdvanceActions({ liFiSolanaTx: mockLiFi(), warpBridge: mockWarpBridge() });
  await assert.rejects(() => actions.swap({}), /lifiData.*required/);
});

test("wiring: skim builds AND simulates the stage-2 tx (the 1% pre-bridge transfer) — never broadcasts", async () => {
  const warp = mockWarpBridge();
  const actions = createThorchainAdvanceActions({
    warpBridge: warp,
    connection: CONN,
    feeWalletSvm: "FeeWalletSvm1111111111111111111111111111111",
  });

  const result = await actions.skim({ userPubkey: SOL_ADDR, amountHuman: 50 });

  assert.equal(result.sim.ok, true);
  assert.deepEqual(
    warp.calls.map((c) => c[0]),
    ["buildStage2", "simulateStage2"],
    "build then simulate, in order",
  );
  const [, buildArgs] = warp.calls[0];
  assert.equal(buildArgs.connection, CONN);
  assert.equal(buildArgs.userPubkey, SOL_ADDR);
  assert.equal(buildArgs.amountHuman, 50);
  assert.equal(buildArgs.feeWalletSvm, "FeeWalletSvm1111111111111111111111111111111");
});

test("wiring: warp → runStage2 with the skimmed amount, allowLive default false (simulate-only)", async () => {
  const warp = mockWarpBridge();
  const solWallet = { provider: { name: "Phantom" } };
  const actions = createThorchainAdvanceActions({
    warpBridge: warp,
    connection: CONN,
    solWallet,
    feeWalletSvm: "FeeWalletSvm1111111111111111111111111111111",
  });

  const result = await actions.warp({ userPubkey: SOL_ADDR, amountHuman: 49.5 });

  assert.equal(result.success, true);
  const [name, args] = warp.calls[0];
  assert.equal(name, "runStage2");
  assert.equal(args.connection, CONN);
  assert.equal(args.userPubkey, SOL_ADDR);
  assert.equal(args.amountHuman, 49.5);
  assert.equal(args.allowLive, false, "no live funds by default");
  assert.equal(args.provider.name, "Phantom");
});

test("wiring: allowLive passes through when the send gate is on (operator decision only)", async () => {
  const warp = mockWarpBridge();
  const actions = createThorchainAdvanceActions({
    warpBridge: warp,
    connection: CONN,
    allowLive: true,
  });
  await actions.warp({ userPubkey: SOL_ADDR, amountHuman: 10 });
  assert.equal(warp.calls[0][1].allowLive, true);
});

test("wiring: the full sequence through the advancer fires swap → skim → warp", async () => {
  const lifi = mockLiFi();
  const warp = mockWarpBridge();
  const actions = createThorchainAdvanceActions({
    liFiSolanaTx: lifi,
    warpBridge: warp,
    connection: CONN,
    solWallet: { provider: { name: "Phantom" } },
  });
  const advancer = createAutoAdvancer({ actions });

  const result = await advancer.advance({
    lifiData: { quote: 1 },
    userPubkey: SOL_ADDR,
    amountHuman: 50,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    [...lifi.calls.map((c) => c[0]), ...warp.calls.map((c) => c[0])],
    ["executeLiFiSolanaTx", "buildStage2", "simulateStage2", "runStage2"],
    "swap → skim (build+simulate) → warp, in order",
  );
});
