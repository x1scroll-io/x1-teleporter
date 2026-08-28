/**
 * Integration tests for the Step 1.3A simulation gate on the Warp Bridge
 * Stage-2 send path (src/warpBridge.js). Runs under node --test.
 *
 * The runbook guarantee, applied to the REAL send path:
 *   - simulateStage2 is FAIL-CLOSED: a program rejection OR an RPC-level
 *     simulation failure blocks the send (previously an RPC failure was
 *     advisory and skipped the gate).
 *   - sendStage2ViaPhantom simulates the EXACT transaction (with the fresh
 *     blockhash it is about to broadcast) BEFORE calling the wallet's
 *     signAndSendTransaction — on a failed simulation the wallet is never
 *     prompted and nothing is broadcast.
 *
 * Mocks only — no real chain, no real wallet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction, PublicKey, SystemProgram } from "@solana/web3.js";
import { simulateStage2, sendStage2ViaPhantom, SKIM_BPS } from "./warpBridge.js";
import { SimulationError } from "./lib/simulateTx.js";
import { FEE_RATES } from "./lib/fees.ts";

function makeLegacyTx() {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: PublicKey.unique(),
      toPubkey: PublicKey.unique(),
      lamports: 1,
    }),
  );
  tx.recentBlockhash = "11111111111111111111111111111111";
  return tx;
}

function mockConnection({ simResult, simError } = {}) {
  const calls = [];
  const connection = {
    calls,
    async getLatestBlockhash() {
      calls.push("getLatestBlockhash");
      return { blockhash: "22222222222222222222222222222222", lastValidBlockHeight: 99 };
    },
    async simulateTransaction(tx) {
      calls.push("simulateTransaction");
      if (simError) throw simError;
      return simResult;
    },
    async sendRawTransaction() {
      calls.push("sendRawTransaction");
      return "raw-sig";
    },
    async confirmTransaction() {
      calls.push("confirmTransaction");
      return { value: { err: null } };
    },
  };
  return connection;
}

function mockWallet({ signAndSend = true } = {}) {
  const calls = [];
  const wallet = {
    calls,
    async signAndSendTransaction(tx) {
      calls.push({ method: "signAndSendTransaction", tx });
      return { signature: "wallet-sig" };
    },
    async signTransaction(tx) {
      calls.push({ method: "signTransaction", tx });
      return tx;
    },
  };
  return wallet;
}

test("simulateStage2 is FAIL-CLOSED: a program rejection blocks", async () => {
  const conn = mockConnection({ simResult: { value: { err: { InstructionError: [0, "Custom"] }, logs: [] } } });
  const res = await simulateStage2(conn, makeLegacyTx());
  assert.equal(res.ok, false);
  assert.deepEqual(res.err, { InstructionError: [0, "Custom"] });
});

test("simulateStage2 is FAIL-CLOSED: an RPC-level simulation failure blocks (was advisory before 1.3A)", async () => {
  const conn = mockConnection({ simError: new Error("fetch failed: ECONNREFUSED") });
  const res = await simulateStage2(conn, makeLegacyTx());
  assert.equal(res.ok, false);
  assert.equal(res.simUnavailable, true);
  assert.match(res.rpcError, /ECONNREFUSED/);
});

test("simulateStage2 passes when the program accepts the tx", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: ["ok"], unitsConsumed: 12345 } } });
  const res = await simulateStage2(conn, makeLegacyTx());
  assert.equal(res.ok, true);
  assert.equal(res.unitsConsumed, 12345);
});

test("KEY: sendStage2ViaPhantom NEVER calls signAndSendTransaction when simulation fails — reason surfaced", async () => {
  const conn = mockConnection({
    simResult: {
      value: {
        err: { InstructionError: [0, "Custom"] },
        logs: ["Program log: Error: insufficient funds"],
      },
    },
  });
  const wallet = mockWallet();
  const tx = makeLegacyTx();

  await assert.rejects(
    () => sendStage2ViaPhantom(conn, tx, wallet),
    (err) => {
      assert.ok(err instanceof SimulationError, `expected SimulationError, got ${err?.name}: ${err?.message}`);
      assert.equal(err.code, "solana-sim-failed");
      assert.match(err.message, /insufficient funds/);
      assert.match(err.message, /Simulation failed/);
      return true;
    },
  );
  assert.ok(
    !wallet.calls.some((c) => c.method === "signAndSendTransaction"),
    "wallet must not be asked to sign a tx whose simulation failed",
  );
  assert.ok(!conn.calls.includes("sendRawTransaction"), "must not broadcast a tx whose simulation failed");
});

test("KEY: sendStage2ViaPhantom NEVER signs when the simulation RPC is down (fail-closed)", async () => {
  const conn = mockConnection({ simError: new Error("fetch failed") });
  const wallet = mockWallet();
  await assert.rejects(
    () => sendStage2ViaPhantom(conn, makeLegacyTx(), wallet),
    (err) => err instanceof SimulationError && err.code === "sim-unavailable",
  );
  assert.ok(!wallet.calls.some((c) => c.method === "signAndSendTransaction"));
});

test("sendStage2ViaPhantom simulates the EXACT tx (fresh blockhash applied) before signing", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: [] } } });
  const wallet = mockWallet();
  const tx = makeLegacyTx();

  const sig = await sendStage2ViaPhantom(conn, tx, wallet);
  assert.equal(sig, "wallet-sig");

  // Order matters: fresh blockhash → simulation of that exact tx → sign+send.
  assert.deepEqual(conn.calls, ["getLatestBlockhash", "simulateTransaction"]);
  assert.deepEqual(wallet.calls.map((c) => c.method), ["signAndSendTransaction"]);
  // The simulated tx is the same object that gets signed, with the fresh blockhash.
  assert.equal(tx.recentBlockhash, "22222222222222222222222222222222");
  assert.equal(wallet.calls[0].tx, tx);
});

test("sendStage2ViaPhantom fallback path (signTransaction + sendRawTransaction) is also simulation-gated", async () => {
  const conn = mockConnection({ simResult: { value: { err: { InstructionError: [0, "Custom"] }, logs: [] } } });
  const wallet = mockWallet({ signAndSend: false });
  // Force the fallback branch by removing signAndSendTransaction.
  delete wallet.signAndSendTransaction;
  await assert.rejects(
    () => sendStage2ViaPhantom(conn, makeLegacyTx(), wallet),
    (err) => err instanceof SimulationError && err.code === "solana-sim-failed",
  );
  assert.ok(!wallet.calls.some((c) => c.method === "signTransaction"));
  assert.ok(!conn.calls.includes("sendRawTransaction"));
});

// ── Step 1.3C fee-unification guard ──
// The on-chain skim must stay sourced from the unified fee module. If someone
// hardcodes SKIM_BPS again (or drifts the rate in fees.ts), this fails.
test("SKIM_BPS is sourced from the unified X1-hop skim rate (Step 1.3C)", () => {
  assert.equal(SKIM_BPS, BigInt(Math.round(FEE_RATES.X1_HOP_SKIM * 10_000)));
  assert.equal(SKIM_BPS, 100n); // 1.00% — the rate actually charged today
});
