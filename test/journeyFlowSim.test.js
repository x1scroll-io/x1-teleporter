/**
 * journeyFlowSim.test.js — the SWAP/BRIDGE HANG SIMULATION (dry / simulated).
 *
 * WHAT THIS PROVES (the "does the flow ever hang?" question):
 *   The forward (EVM → X1) and reverse (X1 → EVM) route flows are walked end
 *   to end in a SIMULATED way — route build → quote → liquidity gate → journey
 *   readout → submit path — with every external dependency MOCKED/FIXTURED
 *   (LiFi/quote APIs, RPC, wallet surfaces; no live keys, no network). Each
 *   stage must RESOLVE — either it completes the sim, or it FAILS CLOSED with a
 *   clear error. It must NEVER leave an unresolved promise / infinite spinner.
 *
 * HOW "NEVER HANGS" IS ENFORCED:
 *   Every awaited step is wrapped in `withTimeout()`. If a step fails to settle
 *   within the budget the test FAILS with a clear "HUNG" message instead of
 *   silently blocking the runner — so a regression that introduces a hang is
 *   caught, not hidden.
 *
 * EDGE CASES THAT COULD HANG (each must resolve):
 *   - a route with no venue (`router: null` — an unverified DEX) → the gate
 *     refuses, the readout flags BLOCKED
 *   - a blocked/thin liquidity leg → refused, readout BLOCKED
 *   - a missing quote → a clean "No transaction data in quote" error
 *   - a wallet not connected → the SignerResolver returns null (honest gate)
 *   - the reverse release waiting on guardian signatures → bounded poll that
 *     TIMES OUT (funds safe) or returns terminal — never an infinite wait
 *   - a network failure mid-poll (fetch rejects) → still resolves
 *
 * Runs under `node --test` with node:test's mock fetch; pure + mocked.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { EVM_ADDRESS, SOLANA_ADDRESS, FEE_WALLET_SVM } from "./golden/forwardLegBuilders.mjs";
import { mockX1ReverseConnection, REVERSE_EVM_ADDRESS } from "./golden/reverseLegBuilders.mjs";

import { planForward, planReverse, plan, planOrExplain } from "../src/engine/routePlanner.js";
import { runForwardEvmStage } from "../src/engine/runners/forwardEvmStage.js";
import { runReverseX1Stage } from "../src/engine/runners/reverseX1Stage.js";
import { runReleaseWait } from "../src/engine/runners/reverseReleaseStage.js";
import { resolveSigner } from "../src/engine/signerResolver.js";
import { buildLifiQuoteParams, deriveQuoteFromLifi } from "../src/lib/teleportQuote.js";
import {
  computeReverseLegs,
  buildReverseLifiQuoteParams,
  deriveReverseQuote,
} from "../src/lib/reverseQuote.js";
import { checkRouteLiquidity } from "../src/lib/liquidityGate.js";
import { hasVenues } from "../src/lib/dex/registry.js";
import { buildJourney, hopsMatchEngineLegs } from "../src/lib/journeyReadout.js";
import { SimulationError } from "../src/lib/simulateTx.js";

// ─────────────────────────────────────────────────────────────────────────────
// Hang guard — wrap every awaited step so a hung promise FAILS the test.
// ─────────────────────────────────────────────────────────────────────────────
const HANG_BUDGET_MS = 4000;

/**
 * Await `p`, but reject with a clear message if it does not settle within
 * `ms`. This is the whole point of the file: a hang must surface as a test
 * failure, never as a stuck runner.
 */
function withTimeout(p, ms = HANG_BUDGET_MS, label = "step") {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HUNG: ${label} did not settle within ${ms}ms`)), ms);
    // Don't keep the event loop alive on the guard itself.
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(p), guard]).finally(() => clearTimeout(timer));
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic test doubles (the shapes the reference tests use).
// ─────────────────────────────────────────────────────────────────────────────

/** Recording EIP-1193 provider. sendMode: "hash" | "reject". */
function makeEvmProvider({ sendMode = "hash" } = {}) {
  const sends = [];
  const request = async ({ method, params = [] }) => {
    switch (method) {
      case "eth_chainId":
        return "0x1";
      case "eth_call":
        return "0x"; // allowance 0 handled by leg; plain sims pass
      case "eth_estimateGas":
        return "0x5208";
      case "eth_sendTransaction":
        sends.push(params[0]);
        if (sendMode === "reject") {
          const err = new Error("User rejected the request.");
          err.code = 4001;
          throw err;
        }
        return "0xbridgehash";
      default:
        return null;
    }
  };
  return { provider: { request }, sends };
}

/** A minimal executable LiFi quote with NO approvalAddress (the simple shape). */
function noApprovalQuote() {
  return {
    id: "0xmock",
    estimate: { toAmount: "99000000", fromAmount: "100000000" },
    transactionRequest: { chainId: 1, to: "0x1234", data: "0xabcdef", value: "0x0", gasLimit: "0x5208" },
    action: {
      fromToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1 },
      toToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chainId: "SOL" },
    },
  };
}

/** A sign-capable Solana adapter. */
function makeSolAdapter() {
  return {
    publicKey: { toBase58: () => SOLANA_ADDRESS },
    async signAndSendTransaction() { return { signature: "final-leg-sig" }; },
    async signTransaction(tx) { return tx; },
  };
}

/** Stub fetch with a router by URL substring. */
function stubFetch(handler) {
  const fetcher = mock.fn(async (url) => handler(String(url)));
  mock.method(globalThis, "fetch", fetcher);
  return fetcher;
}

function okJson(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. ROUTE BUILD — both directions plan cleanly (the first thing that could
//    hang if a planner looped).
// ═════════════════════════════════════════════════════════════════════════════

test("sim: the FORWARD route plans cleanly (4 legs) — build resolves immediately", async () => {
  const route = await withTimeout((async () => planForward())(), HANG_BUDGET_MS, "planForward");
  assert.equal(route.direction, "forward");
  assert.deepEqual(route.legs.map((l) => l.id), ["evm-approval", "lifi-evm-bridge", "x1-ata-create", "warp-lock"]);
  assert.deepEqual(route.legs.map((l) => l.family), ["evm", "evm", "svm", "svm"]);
});

test("sim: the REVERSE route plans cleanly (3 legs) — build resolves immediately", async () => {
  const route = await withTimeout((async () => planReverse({ to: "eth" }))(), HANG_BUDGET_MS, "planReverse");
  assert.equal(route.direction, "reverse");
  assert.deepEqual(route.legs.map((l) => l.id), ["x1-reverse-burn", "warp-release-wait", "lifi-solana-out"]);
});

test("sim edge (unsupported route): an unplannable route resolves to a REASON, never a silent hang", async () => {
  // The 'router: null' style dead-end at the planner level: no planner for the
  // lane. plan() returns null; planOrExplain() converts it to a reason-bearing
  // descriptor so the UI can state WHY instead of spinning.
  assert.equal(plan({ direction: "swap", via: "no-venue" }), null);
  const explained = await withTimeout(
    (async () => planOrExplain({ direction: "swap", via: "no-venue" }))(),
    HANG_BUDGET_MS,
    "planOrExplain",
  );
  assert.equal(explained.routeKind, "unsupported");
  assert.equal(explained.route, null);
  assert.match(explained.reason, /via="no-venue"/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. FORWARD FULL DRY FLOW — quote → gate → readout → submit (sim).
// ═════════════════════════════════════════════════════════════════════════════

test("sim FORWARD: quote builds + resolves (mocked LiFi) → liquidity gate passes → readout matches the engine legs", async () => {
  // 2a — quote request builds (real connected wallets required).
  const built = buildLifiQuoteParams({
    from: "eth", token: "USDC", amount: 25.65,
    fromAddress: EVM_ADDRESS, toAddress: SOLANA_ADDRESS, destToken: "USDC.x",
  });
  assert.ok(built && built.qs, "the forward quote query built");
  assert.equal(built.qs.get("x1Class"), "1");

  // 2b — the quote resolves against a mocked proxy.
  const lifiBody = { estimate: { toAmount: "25554929", toAmountMin: "25427000" } };
  const fetcher = stubFetch((u) =>
    u.includes("/api/lifi/quote") ? okJson(lifiBody) : okJson({ error: "unexpected" }),
  );
  try {
    const resp = await withTimeout(fetch(`/api/lifi/quote?${built.qs}`), HANG_BUDGET_MS, "quote fetch");
    const data = await withTimeout(resp.json(), HANG_BUDGET_MS, "quote parse");
    assert.equal(fetcher.mock.callCount(), 1);

    const derived = deriveQuoteFromLifi({ data, from: "eth", token: "USDC", amount: 25.65, destToken: "USDC.x" });
    assert.ok(derived, "quote derived");
    assert.ok(Array.isArray(derived.feeLines));
  } finally {
    mock.restoreAll();
  }

  // 2c — the liquidity gate passes for the hub asset.
  const gate = checkRouteLiquidity({ from: "eth", to: "x1", srcToken: "USDC", dstToken: "USDC.x" });
  assert.equal(gate.ok, true);
  assert.equal(gate.failures.length, 0);

  // 2d — the journey readout builds and its hops are REAL engine leg ids.
  const journey = buildJourney({
    direction: "forward", from: "eth", to: "x1", token: "USDC", destToken: "USDC.x",
    amount: 25.65, liquidity: gate,
  });
  assert.equal(journey.blocked, false);
  assert.equal(hopsMatchEngineLegs(journey), true, "readout hops match the engine contract");
});

test("sim FORWARD submit: the EVM stage completes the dry sim → { stage: evm_sent } (never hangs)", async () => {
  const route = planForward();
  const { provider, sends } = makeEvmProvider();
  const res = await withTimeout(
    runForwardEvmStage({ route, lifiData: noApprovalQuote(), provider, address: EVM_ADDRESS }),
    HANG_BUDGET_MS,
    "runForwardEvmStage",
  );
  assert.deepEqual(res, { stage: "evm_sent", txHash: "0xbridgehash" });
  assert.equal(sends.length, 1); // ONE broadcast — the bridge tx
});

test("sim FORWARD fail-closed: a reverting preflight sim BLOCKS the send (SimulationError — resolves, no hang)", async () => {
  const route = planForward();
  // A provider whose sim eth_call reverts.
  const provider = {
    async request({ method, params = [] }) {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_call") {
        const data = String(params?.[0]?.data || "0x");
        if (data.startsWith("0xdd62ed3e")) return "0x" + "0".repeat(64); // allowance 0
        const err = new Error("execution reverted: Not enough balance");
        err.data = "0x08c379a0" + "0".repeat(62) + "20" + "0".repeat(62) + "12" + Buffer.from("Not enough balance").toString("hex").padEnd(64, "0");
        throw err;
      }
      if (method === "eth_estimateGas") return "0x5208";
      throw new Error("unexpected " + method);
    },
  };
  await withTimeout(
    assert.rejects(
      () => runForwardEvmStage({ route, lifiData: noApprovalQuote(), provider, address: EVM_ADDRESS }),
      (e) => e instanceof SimulationError,
    ),
    HANG_BUDGET_MS,
    "forward fail-closed",
  );
});

test("sim FORWARD fail-closed: a MISSING quote resolves to a clean error (never an unresolved promise)", async () => {
  const route = planForward();
  const { provider } = makeEvmProvider();
  await withTimeout(
    assert.rejects(
      () => runForwardEvmStage({ route, lifiData: null, provider, address: EVM_ADDRESS }),
      /No transaction data in quote/,
    ),
    HANG_BUDGET_MS,
    "missing quote",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. REVERSE FULL DRY FLOW — quote → burn sim → release poll → fail-closed.
// ═════════════════════════════════════════════════════════════════════════════

test("sim REVERSE: quote builds (destination pinned) + resolves; burn sim completes { stage: simulated_ok }", async () => {
  const route = planReverse({ to: "eth" });
  const GROSS = 0.4;

  const legs = computeReverseLegs({ amount: GROSS, token: "wSOL.X" });
  const built = buildReverseLifiQuoteParams({
    to: "eth", toTokenSymbol: "USDC", netOnSolana: legs.netOnSolana,
    fromAddress: SOLANA_ADDRESS, toAddress: REVERSE_EVM_ADDRESS, token: "wSOL.X",
  });
  assert.ok(built && built.qs);
  assert.equal(built.qs.get("toAddress"), REVERSE_EVM_ADDRESS, "EVM destination pinned");

  const derived = deriveReverseQuote({
    data: { estimate: { toAmount: "39450000" } }, to: "eth", amount: GROSS, token: "wSOL.X", toToken: "USDC",
  });
  assert.equal(derived.lifiQuoted, true);

  // The burn stage in SIM mode (WARP_LIVE_SEND held) — completes, broadcasts nothing.
  const burn = await withTimeout(
    runReverseX1Stage({
      route,
      solAdapter: makeSolAdapter(),
      amountHuman: GROSS,
      allowLive: false,
      token: "wSOL.X",
      feeWallet: new (await import("@solana/web3.js")).PublicKey(FEE_WALLET_SVM),
      connection: mockX1ReverseConnection(),
    }),
    HANG_BUDGET_MS,
    "runReverseX1Stage",
  );
  assert.equal(burn.stage, "simulated_ok");
  assert.equal(burn.sent, null);
});

test("sim REVERSE fail-closed: a route below the destination minimum REFUSES before the burn (nothing built/signed)", async () => {
  const route = planReverse({ to: "eth" });
  const res = await withTimeout(
    runReverseX1Stage({
      route,
      solAdapter: makeSolAdapter(),
      amountHuman: 10, // 10 USDC.x gross → net < the 15 destination floor
      allowLive: true, // even armed, the minimum gate refuses
      token: "USDC.x",
      feeWallet: new (await import("@solana/web3.js")).PublicKey(FEE_WALLET_SVM),
      connection: mockX1ReverseConnection({
        mint: new (await import("@solana/web3.js")).PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq"),
        decimals: 6,
      }),
    }),
    HANG_BUDGET_MS,
    "destination-minimum",
  );
  assert.equal(res.stage, "destination-minimum");
  assert.equal(res.success, false);
  assert.equal(res.built, null);
});

test("sim REVERSE release-wait: WAITING ON GUARDIAN SIGNATURES times out (funds safe) — resolves, never an infinite poll", async () => {
  const route = planReverse({ to: "eth" });
  stubFetch((u) => {
    if (u.includes("/api/warp/signatures")) return { ok: false, status: 404, async json() { return {}; } };
    if (u.includes("/api/warp/status")) return { ok: true, status: 200, async json() { return { transaction: { status: "pending", signaturesCollected: 2, signaturesRequired: 5 } }; } };
    return okJson({});
  });
  try {
    // The poll is BOUNDED (the while-loop exhausts on maxMs) — but the loop
    // sleeps a full intervalMs between iterations and rechecks AFTER the
    // sleep, so the wall-clock floor is >= one intervalMs (default 4s). Prove
    // it RESOLVES (timedOut) rather than hangs, with a budget above that floor.
    const rel = await withTimeout(
      runReleaseWait({ route, sig: "x1-burn-sig", maxMs: 60 }),
      8000,
      "release-wait pending",
    );
    assert.equal(rel.ok, false);
    assert.equal(rel.timedOut, true, "a pending release TIMES OUT — the poll is bounded");
    assert.notEqual(rel.terminal, true);
  } finally {
    mock.restoreAll();
  }
});

test("sim REVERSE release-wait: the poll loop honours its iteration bound (small intervalMs resolves fast — no infinite loop)", async () => {
  const route = planReverse({ to: "eth" });
  const { legById } = await import("../src/engine/routePlanner.js");
  const leg = legById(route, "warp-release-wait");
  stubFetch((u) =>
    u.includes("/api/warp/status") ? okJson({ transaction: { status: "pending" } }) : { ok: false, status: 404, async json() { return {}; } },
  );
  try {
    const built = await leg.phases.build({ sourceSig: "x1-burn-sig", from: "x1", api: "" });
    const t0 = Date.now();
    const rel = await withTimeout(
      leg.phases.confirm({ onUpdate() {}, maxMs: 40, intervalMs: 5 }, { build: built }),
      HANG_BUDGET_MS,
      "release-wait tight-bound",
    );
    assert.equal(rel.timedOut, true);
    assert.ok(Date.now() - t0 < HANG_BUDGET_MS, "the bounded loop returned well inside the budget — it is NOT an infinite loop");
  } finally {
    mock.restoreAll();
  }
});

test("sim REVERSE release-wait: a PERMANENT (terminal) release failure resolves immediately — never waits", async () => {
  const route = planReverse({ to: "eth" });
  stubFetch((u) => {
    if (u.includes("/api/warp/signatures")) return { ok: false, status: 404, async json() { return {}; } };
    if (u.includes("/api/warp/status")) return okJson({ transaction: { status: "failed", error: "BridgeInV2: BelowMinimum", errorCode: 6000 } });
    return okJson({});
  });
  try {
    const rel = await withTimeout(
      runReleaseWait({ route, sig: "x1-burn-sig", maxMs: 5000 }),
      HANG_BUDGET_MS,
      "release-wait terminal",
    );
    assert.equal(rel.ok, false);
    assert.equal(rel.terminal, true);
    assert.match(rel.reason, /BelowMinimum/i);
  } finally {
    mock.restoreAll();
  }
});

test("sim REVERSE release-wait: a network failure mid-poll (fetch rejects) still RESOLVES (bounded, no hang)", async () => {
  const route = planReverse({ to: "eth" });
  const { legById } = await import("../src/engine/routePlanner.js");
  const leg = legById(route, "warp-release-wait");
  stubFetch(() => { throw new Error("ECONNRESET"); });
  try {
    const built = await leg.phases.build({ sourceSig: "x1-burn-sig", from: "x1", api: "" });
    const rel = await withTimeout(
      leg.phases.confirm({ onUpdate() {}, maxMs: 40, intervalMs: 5 }, { build: built }),
      HANG_BUDGET_MS,
      "release-wait fetch-reject",
    );
    assert.equal(rel.ok, false);
    assert.equal(rel.timedOut, true, "a dead endpoint is a bounded timeout, not a hang");
  } finally {
    mock.restoreAll();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. EDGE CASES THAT COULD HANG — each must RESOLVE (refuse, or clean error).
// ═════════════════════════════════════════════════════════════════════════════

test("sim edge (router:null / no venue): a chain with NO verified DEX venue is REFUSED + the readout flags BLOCKED", async () => {
  // berachain's registry entries are all `router: null, verified: false` —
  // i.e. no routable venue. hasVenues() must be false (fail-closed).
  assert.equal(hasVenues("berachain"), false);

  const gate = checkRouteLiquidity({ from: "berachain", to: "x1", srcToken: "USDT", dstToken: "USDC.x" });
  assert.equal(gate.ok, false);
  assert.equal(gate.failures[0].reason, "no-venue");
  assert.match(gate.message, /insufficient liquidity/i);
  assert.ok(gate.suggestion, "a USDC suggestion is attached (never auto-applied)");

  const journey = buildJourney({ direction: "forward", from: "berachain", to: "x1", token: "USDT", destToken: "USDC.x", amount: 100, liquidity: gate });
  assert.equal(journey.blocked, true);
  assert.ok(journey.blockedReason, "the readout carries the honest reason");
  assert.equal(journey.source.blocked, true);
});

test("sim edge (blocked/thin liquidity leg): a thin-chain leg is REFUSED — the route resolves as blocked", async () => {
  // sonic is on the THIN list — a non-hub swap there cannot be proven deep.
  const gate = checkRouteLiquidity({ from: "sonic", to: "x1", srcToken: "USDT", dstToken: "USDC.x" });
  assert.equal(gate.ok, false);
  assert.ok(["thin-chain", "no-venue"].includes(gate.failures[0].reason));
  const journey = buildJourney({ direction: "forward", from: "sonic", to: "x1", token: "USDT", destToken: "USDC.x", amount: 100, liquidity: gate });
  assert.equal(journey.blocked, true);
});

test("sim edge (wallet not connected): the SignerResolver returns null for every family — the honest gate (no hang, no invented signer)", async () => {
  for (const family of ["evm", "svm", "near", "ton"]) {
    const s = await withTimeout(resolveSigner(family, null), HANG_BUDGET_MS, `resolveSigner ${family}`);
    assert.equal(s, null, `${family} with no session → null`);
    // A session that exists but has no signing surface (a mock/session-only
    // provider) must ALSO resolve null — never a phantom signer.
    const s2 = await withTimeout(resolveSigner(family, { provider: { connect: async () => {} } }), HANG_BUDGET_MS, `resolveSigner ${family} surface`);
    assert.equal(s2, null, `${family} with no signing surface → null`);
  }
});

test("sim edge (reverse burn, wallet not connected): a null adapter is rejected by the runner — no hang", async () => {
  const route = planReverse({ to: "eth" });
  // The console guards on SignerResolver FIRST; here we prove the runner
  // itself doesn't silently loop when handed nothing signable — it either
  // returns a fail-closed result or throws, but ALWAYS settles.
  const settled = withTimeout(
    runReverseX1Stage({
      route,
      solAdapter: { publicKey: { toBase58: () => SOLANA_ADDRESS } }, // no sign fns
      amountHuman: 0.4,
      allowLive: false,
      token: "wSOL.X",
      feeWallet: new (await import("@solana/web3.js")).PublicKey(FEE_WALLET_SVM),
      connection: mockX1ReverseConnection(),
    }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })),
    HANG_BUDGET_MS,
    "reverse no-signer",
  );
  const out = await settled;
  assert.ok(out.ok === true || out.e instanceof Error, "the runner settled (result or error), never hung");
});
