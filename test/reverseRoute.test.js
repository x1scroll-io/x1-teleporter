/**
 * reverseRoute.test.js — the FULL X1 → EVM reverse off-ramp, end to end:
 *
 *     quote  →  burn (X1 Warp bridge_out)  →  release-wait (Solana)  →
 *     onward LiFi leg (Solana → EVM)       →  completion
 *
 * This is the regression oracle for the UN-GATED reverse route. It proves the
 * off-ramp is both COMPLETE and FAIL-CLOSED:
 *
 *   1. the route builder un-gates X1-source routes by default (REVERSE_ENABLED
 *      ON — a kill switch, not a release gate),
 *   2. the destination-minimum preflight REFUSES BEFORE the burn (nothing is
 *      built, signed, or sent) — the F8 strand-prevention gate,
 *   3. the release-wait distinguishes a PERMANENT failure (a terminal status /
 *      the release's BelowMinimum revert) from a release that is merely
 *      PENDING (funds safe),
 *   4. the onward LiFi leg fires ONLY after the Solana release lands — the
 *      chain runs in EXACT order quote → burn → release → onward.
 *
 * Runs under node --test (pure + mocked chains — no RPC, no network).
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  SOLANA_ADDRESS,
  FEE_WALLET_SVM,
} from "./golden/forwardLegBuilders.mjs";
import {
  mockX1ReverseConnection,
  REVERSE_EVM_ADDRESS,
} from "./golden/reverseLegBuilders.mjs";

import { planReverse, legById } from "../src/engine/routePlanner.js";
import { runReverseX1Stage } from "../src/engine/runners/reverseX1Stage.js";
import { runReleaseWait } from "../src/engine/runners/reverseReleaseStage.js";
import { runReverseLiFiStage } from "../src/engine/runners/reverseLiFiStage.js";
import {
  computeReverseLegs,
  buildReverseLifiQuoteParams,
  deriveReverseQuote,
} from "../src/lib/reverseQuote.js";
import { determineRoute } from "../src/lib/routes.ts";
import { resolveFlags } from "../src/lib/flags.ts";

const FEE_WALLET = new PublicKey(FEE_WALLET_SVM);
const GROSS = 0.4; // 0.4 wSOL.X on X1 — the golden reverse sample

/** A minimal sign-capable Solana/X1 adapter (the SignerResolver output shape). */
function makeAdapter({ signature = "final-leg-sig" } = {}) {
  const signed = [];
  return {
    adapter: {
      name: "Test Wallet",
      publicKey: { toBase58: () => SOLANA_ADDRESS },
      async signAndSendTransaction() { return { signature }; },
      async signTransaction(tx) { return tx; },
    },
    signed,
  };
}

/** A minimal executable LiFi quote (the golden shape) pinned to the EVM dest. */
async function makeLifiData() {
  const { Keypair, MessageV0, VersionedTransaction } = await import("@solana/web3.js");
  const compiled = MessageV0.compile({
    payerKey: Keypair.generate().publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  });
  const b64 = Buffer.from(new VersionedTransaction(compiled).serialize()).toString("base64");
  return {
    action: {
      toAddress: REVERSE_EVM_ADDRESS,
      fromToken: { address: "So11111111111111111111111111111111111111112" },
      toToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    },
    estimate: { toAmount: "39450000" }, // 39.45 USDC (6 dec) delivered on eth
    transactionRequest: { data: b64 },
  };
}

/** Mock fetch that serves BOTH the Warp release poll AND the LiFi quote. */
function mockFetch({ warpStatus, lifiData, onCall }) {
  return mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    onCall?.(u);
    if (u.includes("/api/warp/signatures")) {
      return { ok: true, status: 200, async json() { return { signatures: [{ guardian: "g1" }] }; } };
    }
    if (u.includes("/api/warp/status")) {
      return { ok: true, status: 200, async json() { return warpStatus; } };
    }
    if (u.includes("/api/lifi/quote")) {
      return { ok: true, status: 200, async json() { return lifiData ?? { error: "no_route" }; } };
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

// ── 1. The route builder is UN-GATED by default ──────────────────────────

test("reverse route: the builder un-gates X1-source routes BY DEFAULT (REVERSE_ENABLED ON), kill-switchable", () => {
  assert.equal(resolveFlags({}).REVERSE_ENABLED, true, "off-ramp ships enabled");
  assert.equal(determineRoute("x1", "sol"), "x1_reverse");
  assert.equal(determineRoute("x1", "eth"), "x1_onward");
  // The kill switch restores the fail-closed fall-through.
  assert.equal(determineRoute("x1", "eth", false), "direct");
  assert.equal(resolveFlags({ VITE_FLAG_REVERSE_ENABLED: "false" }).REVERSE_ENABLED, false);
});

// ── 2. Quote stage — the deterministic picture the off-ramp shows ─────────

test("reverse route quote: stage-1 math + the LiFi SOL→EVM query carry the destination pin", () => {
  const legs = computeReverseLegs({ amount: GROSS, token: "wSOL.X" });
  // 0.5% skim once; Warp's 25 bps carved from the bridge gross.
  assert.equal(legs.skim, GROSS * 0.005);
  const built = buildReverseLifiQuoteParams({
    to: "eth", toTokenSymbol: "USDC", netOnSolana: legs.netOnSolana,
    fromAddress: SOLANA_ADDRESS, toAddress: REVERSE_EVM_ADDRESS, token: "wSOL.X",
  });
  assert.ok(built, "query built with the real connected wallets");
  assert.equal(built.qs.get("fromChain"), "SOL");
  assert.equal(built.qs.get("toAddress"), REVERSE_EVM_ADDRESS, "destination pinned");
  assert.equal(built.qs.get("x1Class"), "1", "x1-class → server omits the LiFi integrator fee");

  const derived = deriveReverseQuote({
    data: { estimate: { toAmount: "39450000" } }, to: "eth", amount: GROSS, token: "wSOL.X", toToken: "USDC",
  });
  assert.equal(derived.lifiQuoted, true);
  assert.equal(derived.recvToken, "USDC");
  assert.equal(derived.recvChain, "Ethereum");
  assert.equal(derived.solanaAmount, legs.netOnSolana, "stage 2 bridges the LANDED net");
});

// ── 3. The FULL chain runs in EXACT order: burn → release → onward ────────

test("reverse route CHAIN: quote → burn (sim) → release → onward LiFi, one continuous ordered flow", async () => {
  const route = planReverse({ to: "eth" });
  const order = [];

  // ── burn stage (sim mode — WARP_LIVE_SEND held) ──
  const connection = mockX1ReverseConnection();
  order.push("quote");
  const burnRes = await runReverseX1Stage({
    route,
    solAdapter: makeAdapter().adapter,
    amountHuman: GROSS,
    allowLive: false,
    token: "wSOL.X",
    feeWallet: FEE_WALLET,
    connection,
  });
  assert.equal(burnRes.stage, "simulated_ok");
  assert.equal(burnRes.success, true);
  assert.equal(burnRes.sent, null, "sim mode never broadcasts");
  order.push("burn");

  // ── release-wait: the submitter release lands on Solana ──
  const lifiData = await makeLifiData();
  const calls = [];
  mockFetch({
    warpStatus: { transaction: { status: "executed", destTxSig: "solana-release-sig" } },
    lifiData,
    onCall: (u) => calls.push(u),
  });
  try {
    const rel = await runReleaseWait({ route, sig: "x1-burn-sig", maxMs: 5000 });
    assert.equal(rel.ok, true);
    assert.equal(rel.destinationTx, "solana-release-sig");
    order.push("release");

    // ── onward LiFi leg — fires ONLY after the release lands ──
    const { adapter } = makeAdapter({ signature: "final-leg-sig" });
    const sig = await runReverseLiFiStage({
      route,
      solAdapter: adapter,
      evmAddress: REVERSE_EVM_ADDRESS,
      to: "eth",
      toTokenSymbol: "USDC",
      netOnSolana: computeReverseLegs({ amount: GROSS, token: "wSOL.X" }).netOnSolana,
      token: "wSOL.X",
      simulate: async () => ({ ok: true, logs: [], unitsConsumed: 0 }),
    });
    assert.equal(sig, "final-leg-sig", "the final-leg signature = completion");
    order.push("onward");
  } finally {
    mock.restoreAll();
  }

  assert.deepEqual(order, ["quote", "burn", "release", "onward"], "the chain ran in EXACT order");
  assert.ok(calls.some((u) => u.includes("/api/warp/status?sig=x1-burn-sig&from=x1")), "release polled same-origin from=x1");
});

// ── 4. FAIL-CLOSED: destination minimum refuses BEFORE the burn ───────────

test("reverse route: a reverse that can't clear the destination minimum REFUSES before burning — nothing sent, onward never fires", async () => {
  const route = planReverse({ to: "eth" });
  let onwardFired = false;
  const { adapter } = makeAdapter();

  // 10 USDC.x gross → 8.95 net < the 15 USDC.x destination floor.
  const res = await runReverseX1Stage({
    route,
    solAdapter: adapter,
    amountHuman: 10,
    allowLive: true, // even armed, the minimum gate refuses
    token: "USDC.x",
    feeWallet: FEE_WALLET,
    connection: mockX1ReverseConnection({ mint: new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq"), decimals: 6 }),
  });
  assert.equal(res.stage, "destination-minimum");
  assert.equal(res.success, false);
  assert.equal(res.built, null);
  assert.equal(res.signature, undefined);
  assert.match(res.reason, /below destination minimum after fee/);
  // The outward leg is gated behind a landed release — it can never run here.
  assert.equal(onwardFired, false);
});

// ── 5. FAIL-CLOSED: a PERMANENT release failure never waits, onward skipped ─

test("reverse route: a PERMANENT release failure (BelowMinimum) is terminal — the onward leg is never attempted", async () => {
  const route = planReverse({ to: "eth" });
  const calls = [];
  mockFetch({
    warpStatus: { transaction: { status: "failed", error: "BridgeInV2: BelowMinimum", errorCode: 6000 } },
    onCall: (u) => calls.push(u),
  });
  try {
    const rel = await runReleaseWait({ route, sig: "x1-burn-sig", maxMs: 5000 });
    assert.equal(rel.ok, false);
    assert.equal(rel.terminal, true);
    assert.equal(rel.permanent, true);
    assert.match(rel.reason, /BelowMinimum/i);
    assert.notEqual(rel.timedOut, true, "a permanent failure is NOT a pending timeout");
    // The success path (onward LiFi) is gated on rel.ok — a terminal failure
    // routes to the handoff state, so no LiFi leg can fire.
    assert.equal(rel.ok, false);
    assert.ok(!calls.some((u) => u.includes("/api/lifi/quote")), "no onward LiFi quote attempted");
  } finally {
    mock.restoreAll();
  }
});

// ── 6. FAIL-CLOSED: a PENDING release is NOT terminal (funds safe) ────────

test("reverse route: a still-pending release TIMES OUT (not terminal) — funds safe, retryable", async () => {
  const route = planReverse({ to: "eth" });
  mockFetch({ warpStatus: { transaction: { status: "pending", signaturesCollected: 2, signaturesRequired: 5 } } });
  try {
    const rel = await runReleaseWait({ route, sig: "x1-burn-sig", maxMs: 60 });
    assert.equal(rel.ok, false);
    assert.equal(rel.timedOut, true);
    assert.notEqual(rel.terminal, true, "pending ≠ permanent failure");
  } finally {
    mock.restoreAll();
  }
});

// ── 7. The planned reverse route is the three engine legs, in order ───────

test("reverse route: the planner groups the three legs into burn → release → lifi stages", () => {
  const route = planReverse({ to: "eth" });
  assert.deepEqual(route.legs.map((l) => l.id), ["x1-reverse-burn", "warp-release-wait", "lifi-solana-out"]);
  assert.equal(legById(route, "x1-reverse-burn")?.family, "svm");
  assert.equal(route.sourceChain, "x1");
  assert.equal(route.destChain, "eth");
});
