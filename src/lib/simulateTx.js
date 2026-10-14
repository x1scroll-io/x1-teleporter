/**
 * simulateTx.js — pre-send transaction simulation (Teleporter Step 1.3A).
 *
 * WHY THIS EXISTS
 *   A user should never broadcast a transaction that is going to fail: it
 *   wastes gas (EVM), strands the UI in a stuck state, and is bad UX. Every
 *   send path in the app runs a simulation of the EXACT transaction first:
 *
 *     EVM    — eth_call with the same from/to/data/value (+ eth_estimateGas).
 *              If it reverts, the send is BLOCKED and the actual revert reason
 *              is surfaced (Error(string) decoded, Panic(uint256) decoded,
 *              "execution reverted: <reason>" from the RPC message, or the
 *              custom-error selector when nothing else is available).
 *     Solana — connection.simulateTransaction with the same serialized tx.
 *              If the program rejects it, the send is BLOCKED and the error
 *              is surfaced. If the simulation RPC itself fails, the send is
 *              ALSO blocked (fail-closed): we cannot prove the tx would
 *              succeed, so we do not send it.
 *
 *   The runbook is explicit: failed simulation = no send, clear reason shown.
 *   No generic "transaction failed" — show the actual error string when the
 *   provider returns one.
 *
 * DESIGN
 *   Pure module, no DOM, no network. The provider / connection / send function
 *   are passed in (dependency injection), so tests mock them and never touch a
 *   real chain. Runs under node --test like the other lib tests.
 */

// ── ABI signatures ──────────────────────────────────────────────────────────
export const EVM_ERROR_SIGNATURE = "0x08c379a0"; // Error(string)
export const EVM_PANIC_SIGNATURE = "0x4e487b71"; // Panic(uint256)

// Solidity panic codes (Panic(uint256)) → human text.
export const PANIC_CODES = {
  "0x01": "assertion failed",
  "0x11": "arithmetic overflow or underflow",
  "0x12": "division or modulo by zero",
  "0x21": "enum conversion out of bounds",
  "0x22": "incorrectly encoded storage byte array",
  "0x31": "pop() on an empty array",
  "0x32": "array index out of bounds",
  "0x41": "out of memory",
  "0x51": "uninitialized function pointer",
};

/**
 * SimulationError — thrown whenever a pre-send simulation fails.
 * `code` distinguishes the failure class so callers can tailor the message:
 *   "evm-revert"        — the EVM call/estimate reverted (reason surfaced)
 *   "solana-sim-failed" — the Solana program rejected the tx (err surfaced)
 *   "sim-unavailable"   — the simulation could not run (RPC/network) — fail-closed
 *   "no-provider"       — no provider/connection was passed in
 */
export class SimulationError extends Error {
  constructor(message, { code = "simulation-failed", reason = null, raw = null } = {}) {
    super(message);
    this.name = "SimulationError";
    this.code = code;
    this.reason = reason;
    this.raw = raw;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Hex string → UTF-8 text without Buffer (browser-safe: TextDecoder). */
function hexToUtf8(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Decode EVM revert data into a human-readable reason.
 *   Error(string)   → the revert string (e.g. "execution reverted: Not enough balance")
 *   Panic(uint256)  → the panic code + meaning
 *   anything else   → the custom-error selector (best effort)
 * Returns null when the data is not decodable revert data.
 */
export function decodeRevertData(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return null;
  const sig = data.slice(0, 10).toLowerCase();

  if (sig === EVM_ERROR_SIGNATURE) {
    // Error(string): abi.encode(offset=0x20, length, utf8) — 32-byte words,
    // data padded to 32 bytes. body = offset(64 hex) + length(64 hex) + data.
    try {
      const body = data.slice(10);
      const len = parseInt(body.slice(64, 128), 16);
      if (!Number.isFinite(len) || len <= 0 || len > 1024) {
        return "execution reverted";
      }
      // Data starts after the two words; slice clamps to what's actually
      // there (padded region is longer than len*2 — padding is ignored).
      const strHex = body.slice(128, 128 + len * 2);
      const reason = hexToUtf8(strHex).replace(/[^\x20-\x7E]/g, "");
      return reason || "execution reverted";
    } catch {
      return "execution reverted";
    }
  }

  if (sig === EVM_PANIC_SIGNATURE) {
    // Panic(uint256): one 32-byte word; the code is the LAST byte.
    try {
      const body = data.slice(10);
      const codeHex = "0x" + body.slice(62, 64);
      const meaning = PANIC_CODES[codeHex];
      return `panic: ${meaning || `code ${codeHex}`}`;
    } catch {
      return "panic (unknown code)";
    }
  }

  // Custom error — surface the selector so the user can look it up.
  return `revert with custom error ${sig}`;
}

/**
 * Extract the best available revert reason from a provider error object.
 * Looks (in order) at: embedded revert data (err.data / err.error.data),
 * the "execution reverted: <reason>" RPC message, then the raw message.
 */
export function extractRevertReason(err) {
  if (!err) return "transaction would revert";
  // Some providers nest the data (err.error.data) or give an object (err.data.data).
  let data = null;
  if (typeof err.data === "string") data = err.data;
  else if (err?.error && typeof err.error.data === "string") data = err.error.data;
  else if (err?.error?.data && typeof err.error.data.data === "string") data = err.error.data.data;
  else if (err?.data?.data && typeof err.data.data === "string") data = err.data.data;

  if (data) {
    const decoded = decodeRevertData(data);
    if (decoded && decoded !== "execution reverted") return decoded;
    // Fall through to the message — it may carry the reason even when the
    // revert data is only the bare selector.
  }

  const msg = err?.message || err?.error?.message || "";
  const m = String(msg).match(/execution reverted(?::\s*(.*))?/i);
  if (m) {
    const inline = m[1]?.trim();
    return inline ? inline : "execution reverted";
  }
  return String(msg || "transaction would revert");
}

// ── EVM ─────────────────────────────────────────────────────────────────────

/**
 * Simulate an EVM transaction with eth_call (exact from/to/data/value) and,
 * by default, eth_estimateGas. Any revert BLOCKS: throws SimulationError with
 * the surfaced reason. Resolves { ok: true, gasEstimate } when it would succeed.
 */
export async function simulateEvmTx(provider, txParams, { withGasEstimate = true } = {}) {
  if (!provider || typeof provider.request !== "function") {
    throw new SimulationError("Cannot simulate: no provider with request() available", { code: "no-provider" });
  }
  const params = { ...txParams };

  // 1) eth_call — the authoritative revert check. Resolves (usually "0x") on
  //    success; any throw means the exact tx would revert → BLOCK.
  try {
    await provider.request({ method: "eth_call", params: [params, "latest"] });
  } catch (err) {
    const reason = extractRevertReason(err);
    throw new SimulationError(`Simulation failed: ${reason}`, { code: "evm-revert", reason, raw: err });
  }

  // 2) eth_estimateGas — catches failures eth_call misses (e.g. gas limit
  //    blowups) and gives us the estimate to attach to the tx.
  let gasEstimate = null;
  if (withGasEstimate) {
    try {
      gasEstimate = await provider.request({ method: "eth_estimateGas", params: [params] });
    } catch (err) {
      const reason = extractRevertReason(err);
      throw new SimulationError(`Simulation failed (gas estimate): ${reason}`, {
        code: "evm-revert",
        reason,
        raw: err,
      });
    }
  }

  return { ok: true, gasEstimate };
}

/**
 * The EVM send path: simulate first, send only if the simulation passes.
 * If the simulation reverts, eth_sendTransaction is NEVER called and the
 * SimulationError (with the surfaced reason) propagates to the caller.
 */
export async function guardedSendEvmTx(provider, txParams, opts = {}) {
  await simulateEvmTx(provider, txParams, opts); // throws → send blocked
  return provider.request({ method: "eth_sendTransaction", params: [txParams] });
}

// ── Solana ──────────────────────────────────────────────────────────────────

/** Normalize a simulateTransaction response into { ok, err, logs, unitsConsumed }. */
export function normalizeSolanaSim(sim) {
  if (!sim || !sim.value) {
    return { ok: false, simUnavailable: true, rpcError: "empty simulation response" };
  }
  const err = sim.value.err;
  if (err === null || err === undefined) {
    return { ok: true, logs: sim.value.logs || [], unitsConsumed: sim.value.unitsConsumed };
  }
  return { ok: false, err, logs: sim.value.logs || [], unitsConsumed: sim.value.unitsConsumed };
}

/** Format a Solana sim err (string | object) for display. */
export function formatSolanaErr(err) {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isBlockhashProblem(err) {
  return String(formatSolanaErr(err)).toLowerCase().includes("blockhash");
}

function isLegacyTransaction(tx) {
  // VersionedTransaction exposes `.version`; legacy Transaction does not.
  return tx && tx.version === undefined;
}

/**
 * Simulate a Solana transaction with connection.simulateTransaction.
 * FAIL-CLOSED (runbook 1.3A): a program rejection blocks, and an RPC-level
 * failure ALSO blocks ({ ok:false, simUnavailable:true }) — if we cannot prove
 * the tx would succeed, we do not send it. A stale-blockhash rejection is
 * retried once with a fresh blockhash (legacy txs only — versioned messages
 * can't be rewritten cheaply) before being treated as a failure.
 */
export async function simulateSolanaTx(connection, transaction, { retryWithFreshBlockhash = true } = {}) {
  if (!connection || typeof connection.simulateTransaction !== "function") {
    return { ok: false, simUnavailable: true, rpcError: "no connection with simulateTransaction() available" };
  }
  let sim;
  try {
    sim = await connection.simulateTransaction(transaction);
  } catch (e) {
    return { ok: false, simUnavailable: true, rpcError: e?.message || String(e) };
  }

  const res = normalizeSolanaSim(sim);
  if (!res.ok && retryWithFreshBlockhash && isBlockhashProblem(res.err) && isLegacyTransaction(transaction)) {
    try {
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      const sim2 = await connection.simulateTransaction(transaction);
      return normalizeSolanaSim(sim2);
    } catch (e) {
      return { ok: false, simUnavailable: true, rpcError: e?.message || String(e) };
    }
  }
  return res;
}

/**
 * The Solana send path: simulate first, send only if the simulation passes.
 * `send` is the caller's actual broadcast function (wallet signAndSendTransaction,
 * or signTransaction + sendRawTransaction). If the simulation fails — program
 * rejection OR unavailable simulation RPC — `send` is NEVER called and a
 * SimulationError with the surfaced reason is thrown.
 */
export async function guardedSendSolanaTx(connection, transaction, send) {
  const sim = await simulateSolanaTx(connection, transaction);
  if (!sim.ok) {
    if (sim.simUnavailable) {
      throw new SimulationError(
        `Simulation couldn't run (RPC: ${sim.rpcError || "unknown"}) — send blocked. Retry when the RPC is reachable.`,
        { code: "sim-unavailable", reason: sim.rpcError || "simulation RPC unavailable", raw: sim },
      );
    }
    const errText = formatSolanaErr(sim.err);
    const keyLogs = (sim.logs || [])
      .filter((l) => /error|failed|assert|seq|insufficient|invalid|constraint/i.test(l))
      .slice(-2)
      .join(" | ");
    throw new SimulationError(
      `Simulation failed: ${errText}${keyLogs ? ` — ${keyLogs}` : ""}`,
      { code: "solana-sim-failed", reason: errText, raw: sim },
    );
  }
  if (typeof send !== "function") {
    throw new Error("guardedSendSolanaTx: no send function provided");
  }
  return send(transaction);
}
