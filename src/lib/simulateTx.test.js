/**
 * Tests for the Step 1.3A simulation gate: any failed simulation must BLOCK
 * the send and surface the reason to the user. Runs under Node's built-in
 * test runner (node --test) — same pattern as lifiApproval.test.js.
 *
 * Runbook requirements covered:
 *   (a) EVM: eth_call with the same from/to/data/value (+ gas estimate); a
 *       revert blocks the send and the ACTUAL revert reason is surfaced
 *       (Error(string) decoded, Panic(uint256) decoded, RPC message fallback)
 *       — no generic "transaction failed".
 *   (b) Solana: simulateTransaction with the same serialized tx; a failure
 *       blocks the send and the error is surfaced.
 *   (c) Fail-closed: if the simulation cannot run (RPC down / no provider),
 *       the send is ALSO blocked — we never broadcast a tx we couldn't prove
 *       would succeed.
 *   (d) The key guarantee: on a simulated revert, the provider's send method
 *       (eth_sendTransaction / signAndSendTransaction / sendRawTransaction)
 *       is NEVER called.
 *
 * Everything is dependency-injected (mock provider / mock connection / mock
 * send), so no real chain is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimulationError,
  decodeRevertData,
  extractRevertReason,
  simulateEvmTx,
  guardedSendEvmTx,
  simulateSolanaTx,
  guardedSendSolanaTx,
  normalizeSolanaSim,
} from "./simulateTx.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FROM = "0x" + "1".repeat(40);
const TO = "0x" + "2".repeat(40);
const TX = { from: FROM, to: TO, data: "0x1234", value: "0x0" };

/** ABI-encode Error("Not enough balance") revert data (padded to 32-byte words, like real nodes). */
function errorStringData(reason = "Not enough balance") {
  const msg = Buffer.from(reason).toString("hex");
  // offset word (0x20) + length word (padded) + utf8 data (padded to 32 bytes)
  const lenWord = (reason.length * 2).toString(16).padStart(64, "0");
  const dataWord = msg.padEnd(Math.ceil(msg.length / 64) * 64, "0");
  return "0x08c379a0" + "0".repeat(62) + "20" + lenWord + dataWord;
}

const PANIC_OVERFLOW_DATA = "0x4e487b71" + "0".repeat(62) + "11"; // Panic(0x11)

/** A provider mock that records every request and can be told to revert. */
function mockEvmProvider({ call = "0x", estimate = "0x5208", revertErr = null, estimateErr = null } = {}) {
  const calls = [];
  const provider = {
    calls,
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_call") {
        if (revertErr) throw revertErr;
        return call;
      }
      if (method === "eth_estimateGas") {
        if (estimateErr) throw estimateErr;
        return estimate;
      }
      if (method === "eth_sendTransaction") return "0xabcdef";
      throw new Error("unexpected method " + method);
    },
  };
  return provider;
}

/** A connection mock for Solana simulation. */
function mockConnection({ simResult = { value: { err: null, logs: [] } }, simError = null } = {}) {
  const calls = [];
  const connection = {
    calls,
    async simulateTransaction(tx) {
      calls.push({ kind: "simulate", tx });
      if (simError) throw simError;
      return simResult;
    },
    async getLatestBlockhash() {
      calls.push({ kind: "getLatestBlockhash" });
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
    },
  };
  return connection;
}

// ── Revert-data decoding ────────────────────────────────────────────────────

test("Error(string) revert data decodes to the ACTUAL reason string", () => {
  const data = errorStringData("Not enough balance");
  assert.equal(decodeRevertData(data), "Not enough balance");
  assert.equal(decodeRevertData(errorStringData("Transfer failed")), "Transfer failed");
});

test("Panic(uint256) revert data decodes to the panic code meaning", () => {
  assert.equal(decodeRevertData(PANIC_OVERFLOW_DATA), "panic: arithmetic overflow or underflow");
  assert.equal(decodeRevertData("0x4e487b71" + "0".repeat(62) + "01"), "panic: assertion failed");
});

test("unknown custom-error selector is surfaced (selector, not silence)", () => {
  assert.equal(decodeRevertData("0xdeadbeef1234"), "revert with custom error 0xdeadbeef");
});

test("garbage / short / non-hex data returns null", () => {
  assert.equal(decodeRevertData(null), null);
  assert.equal(decodeRevertData(undefined), null);
  assert.equal(decodeRevertData("0x1234"), null);
  assert.equal(decodeRevertData("not-hex"), null);
  assert.equal(decodeRevertData("0xzzzzzzzz1234"), null);
});

test("extractRevertReason prefers revert data, falls back to RPC message", () => {
  const data = errorStringData("Not enough balance");
  // 1) embedded data
  assert.equal(extractRevertReason({ data, message: "execution reverted" }), "Not enough balance");
  // 2) nested err.error.data (some providers)
  assert.equal(extractRevertReason({ error: { data } }), "Not enough balance");
  // 3) "execution reverted: <reason>" in the message
  assert.equal(extractRevertReason({ message: "execution reverted: Not enough balance" }), "Not enough balance");
  assert.equal(extractRevertReason({ message: "execution reverted" }), "execution reverted");
  // 4) raw message last resort — never a generic lie
  assert.equal(extractRevertReason({ message: "Internal JSON-RPC error" }), "Internal JSON-RPC error");
  assert.equal(extractRevertReason(null), "transaction would revert");
});

// ── EVM simulation ──────────────────────────────────────────────────────────

test("simulateEvmTx passes when eth_call + eth_estimateGas succeed", async () => {
  const provider = mockEvmProvider();
  const res = await simulateEvmTx(provider, TX);
  assert.deepEqual(res, { ok: true, gasEstimate: "0x5208" });
  const methods = provider.calls.map((c) => c.method);
  assert.deepEqual(methods, ["eth_call", "eth_estimateGas"]);
  // eth_call received the EXACT tx params + "latest"
  assert.deepEqual(provider.calls[0].params, [TX, "latest"]);
});

test("simulateEvmTx BLOCKS on revert and surfaces the decoded reason", async () => {
  const provider = mockEvmProvider({ revertErr: { message: "execution reverted", data: errorStringData("Not enough balance") } });
  await assert.rejects(
    () => simulateEvmTx(provider, TX),
    (err) => {
      assert.ok(err instanceof SimulationError);
      assert.equal(err.code, "evm-revert");
      assert.equal(err.message, "Simulation failed: Not enough balance");
      assert.equal(err.reason, "Not enough balance");
      return true;
    },
  );
  // Blocked BEFORE any gas estimate or send — the failing call is the last one.
  assert.deepEqual(provider.calls.map((c) => c.method), ["eth_call"]);
});

test("simulateEvmTx BLOCKS on Panic revert with the panic meaning", async () => {
  const provider = mockEvmProvider({ revertErr: { data: PANIC_OVERFLOW_DATA } });
  await assert.rejects(
    () => simulateEvmTx(provider, TX),
    /panic: arithmetic overflow or underflow/,
  );
});

test("simulateEvmTx BLOCKS when eth_estimateGas fails, reason surfaced", async () => {
  const provider = mockEvmProvider({ estimateErr: { message: "execution reverted: gas required exceeds allowance" } });
  await assert.rejects(
    () => simulateEvmTx(provider, TX),
    (err) => {
      assert.ok(err instanceof SimulationError);
      assert.equal(err.code, "evm-revert");
      assert.equal(err.message, "Simulation failed (gas estimate): gas required exceeds allowance");
      return true;
    },
  );
});

test("simulateEvmTx without a provider throws no-provider (fail-closed)", async () => {
  await assert.rejects(() => simulateEvmTx(null, TX), (err) => err instanceof SimulationError && err.code === "no-provider");
  await assert.rejects(() => simulateEvmTx({}, TX), (err) => err instanceof SimulationError && err.code === "no-provider");
});

// ── EVM guarded send — the runbook guarantee ────────────────────────────────

test("KEY: on a simulated revert, eth_sendTransaction is NEVER called and the reason is surfaced", async () => {
  const provider = mockEvmProvider({ revertErr: { message: "execution reverted: Not enough balance", data: errorStringData("Not enough balance") } });
  await assert.rejects(
    () => guardedSendEvmTx(provider, TX),
    (err) => {
      assert.ok(err instanceof SimulationError);
      assert.equal(err.reason, "Not enough balance");
      return true;
    },
  );
  assert.ok(
    !provider.calls.some((c) => c.method === "eth_sendTransaction"),
    "eth_sendTransaction must not be called when the simulation reverts",
  );
});

test("KEY: on a simulation RPC failure, eth_sendTransaction is NEVER called (fail-closed)", async () => {
  const provider = mockEvmProvider({ revertErr: { message: "Internal JSON-RPC error" } });
  await assert.rejects(() => guardedSendEvmTx(provider, TX), SimulationError);
  assert.ok(!provider.calls.some((c) => c.method === "eth_sendTransaction"));
});

test("guardedSendEvmTx sends with the EXACT params when the simulation passes", async () => {
  const provider = mockEvmProvider();
  const hash = await guardedSendEvmTx(provider, TX);
  assert.equal(hash, "0xabcdef");
  const sendCall = provider.calls.find((c) => c.method === "eth_sendTransaction");
  assert.ok(sendCall, "eth_sendTransaction should be called");
  assert.deepEqual(sendCall.params, [TX]);
});

// ── Solana simulation ───────────────────────────────────────────────────────

test("simulateSolanaTx passes when the program accepts the tx", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: ["Program success"], unitsConsumed: 20000 } } });
  const res = await simulateSolanaTx(conn, {});
  assert.equal(res.ok, true);
  assert.equal(res.unitsConsumed, 20000);
  assert.deepEqual(conn.calls.map((c) => c.kind), ["simulate"]);
});

test("simulateSolanaTx BLOCKS when the program rejects the tx, err surfaced", async () => {
  const conn = mockConnection({ simResult: { value: { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: Error: insufficient funds"] } } });
  const res = await simulateSolanaTx(conn, {});
  assert.equal(res.ok, false);
  assert.deepEqual(res.err, { InstructionError: [0, "Custom"] });
  assert.ok(res.logs.some((l) => l.includes("insufficient funds")));
});

test("FAIL-CLOSED: RPC-level simulation failure blocks (simUnavailable)", async () => {
  const conn = mockConnection({ simError: new Error("fetch failed: ECONNREFUSED") });
  const res = await simulateSolanaTx(conn, {});
  assert.equal(res.ok, false);
  assert.equal(res.simUnavailable, true);
  assert.match(res.rpcError, /ECONNREFUSED/);
});

test("normalizeSolanaSim treats an empty/garbage response as simUnavailable", () => {
  assert.equal(normalizeSolanaSim(null).ok, false);
  assert.equal(normalizeSolanaSim(null).simUnavailable, true);
  assert.equal(normalizeSolanaSim({ value: null }).ok, false);
  assert.equal(normalizeSolanaSim({}).ok, false);
});

// ── Solana guarded send — the runbook guarantee ─────────────────────────────

test("KEY: on a failed Solana simulation, the send function is NEVER called and the error is surfaced", async () => {
  const conn = mockConnection({ simResult: { value: { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: Error: insufficient funds"] } } });
  let sendCalled = false;
  await assert.rejects(
    () => guardedSendSolanaTx(conn, {}, async () => { sendCalled = true; return "sig"; }),
    (err) => {
      assert.ok(err instanceof SimulationError);
      assert.equal(err.code, "solana-sim-failed");
      assert.match(err.message, /insufficient funds/);
      assert.match(err.message, /Simulation failed/);
      return true;
    },
  );
  assert.equal(sendCalled, false, "send must not run when the simulation fails");
});

test("KEY: on an unavailable Solana simulation, the send function is NEVER called (fail-closed)", async () => {
  const conn = mockConnection({ simError: new Error("fetch failed") });
  let sendCalled = false;
  await assert.rejects(
    () => guardedSendSolanaTx(conn, {}, async () => { sendCalled = true; return "sig"; }),
    (err) => err instanceof SimulationError && err.code === "sim-unavailable",
  );
  assert.equal(sendCalled, false, "send must not run when the simulation could not be executed");
});

test("guardedSendSolanaTx calls send with the tx when the simulation passes", async () => {
  const conn = mockConnection();
  let sentTx = null;
  const sig = await guardedSendSolanaTx(conn, { id: 42 }, async (tx) => { sentTx = tx; return "real-sig"; });
  assert.equal(sig, "real-sig");
  assert.deepEqual(sentTx, { id: 42 });
});
