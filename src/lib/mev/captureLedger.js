/**
 * captureLedger.js — the MEV CAPTURE ACCUMULATION LEDGER (pure).
 *
 * The MEASURE/VERIFY + ACCUMULATE record of the treasury design (Mr.
 * Esters — docs/MEV-PAYOUT.md). Every time the capture engine detects a
 * capturable value (gated OFF — captureGate.js), the drop-as-is INTENT is
 * recorded here: one ledger record per capture =
 *   { chain, token, amountRaw, destinationTreasury, capturedAt, source,
 *     simulated, test, evidence }.
 *
 * ── WHAT THE LEDGER IS FOR ────────────────────────────────────────────────
 *   1. MEASURE/VERIFY (sandbox): during the exotic-route tests the ledger is
 *      the record that answers "does the engine capture the right gap on
 *      real aping flow?" — the recorded amountRaw (what WOULD drop into the
 *      treasury) vs the engine's own detection math. Records are marked
 *      simulated/test in the sandbox; captured value recycles in the test
 *      fleet (the real treasury is production-only).
 *   2. ACCUMULATE: the per-chain pile the batch sweep converts. The sweep
 *      planner (sweepPlanner.js) reads a chain's records over a period and
 *      plans the ONE batched conversion of the pile → the basket.
 *   3. AUDIT: every record carries its destination treasury + the evidence
 *      (the detection that produced it) — the drop-as-is deposit intent is
 *      traceable end to end.
 *
 * 🔴 WHAT THE LEDGER IS NOT: it is not a wallet, not a key, not a signing
 * authority, and NOT an execution order. Recording a capture here moves no
 * funds — the actual deposit + sweep are FUTURE ARMED ACTIONS (signable
 * artifacts only, produced by the existing guarded legs; the live arm is
 * Mr. Esters' alone — the WARP_LIVE_SEND / DexDirectLiveTestGateError
 * discipline). While the capture gate is OFF (the repo default) every
 * record is measurement-only by construction.
 *
 * ── PERSISTENCE (decided + documented) ────────────────────────────────────
 * This module is PURE — it models the ledger state and validates/serializes
 * it, but touches no filesystem (src/ is bundled by Vite; node:fs would
 * break the browser build — same reason no src module imports it).
 * Persistence is the CALLER's choice of a JSON file path:
 *   - Sandbox measurement (tools/mev-capture-measure.mjs + the exotic-route
 *     tests): .sandbox/mev-capture-ledger.json — .sandbox/ is gitignored
 *     (test wallet keys live there; the ledger file NEVER commits).
 *   - Runtime/armed infra (future): a gitignored runtime file, path from
 *     MEV_CAPTURE_LEDGER_PATH (documented in docs/MEV-PAYOUT.md).
 * serializeLedger(state) / parseLedger(json) are the file format; the tools
 * read-modify-write the file with them. Tests use in-memory states only.
 *
 * All amounts are RAW base units (integer strings / BigInt-compatible) —
 * the same convention as the gap detector / route analyzer. Sums are exact
 * BigInt integer arithmetic (no floating point on money paths).
 */

import {
  DEFAULT_MEV_PAYOUT_CONFIG,
  treasuryForChain,
  MEV_PAYOUT_DEPOSIT_ONLY_NOTE,
  MEV_PAYOUT_DROP_AS_IS_NOTE,
} from "./payoutConfig.js";

/** The ledger file format version. */
export const CAPTURE_LEDGER_VERSION = 1;

/** The ledger's kind tag (parse validation). */
export const CAPTURE_LEDGER_KIND = "mev-capture-ledger";

/** Where the sandbox ledger file lives (tools default; gitignored via
 *  .sandbox/). Runtime overrides via MEV_CAPTURE_LEDGER_PATH. */
export const CAPTURE_LEDGER_SANDBOX_PATH = ".sandbox/mev-capture-ledger.json";

/** The documented persistence note (carried on every serialize). */
export const CAPTURE_LEDGER_PERSISTENCE_NOTE =
  "the ledger is a JSON journal at a caller-chosen gitignored path — sandbox default " +
  ".sandbox/mev-capture-ledger.json, runtime override MEV_CAPTURE_LEDGER_PATH. It records drop-as-is " +
  "deposit INTENT (measurement first). Recording moves NO funds; deposit + sweep are future armed " +
  "actions (signable artifacts only). NEVER commit the file.";

/** Allowed record sources. "detection" = a live gated-off observation;
 *  "simulated"/"test" = sandbox measurement (exotic-route verification). */
export const CAPTURE_RECORD_SOURCES = Object.freeze(["detection", "simulated", "test"]);

/** The drop-as-is note, carried on every record. */
export const CAPTURE_RECORD_DROP_AS_IS_NOTE =
  "drop-as-is intent: the captured token deposits AS-IS into destinationTreasury (no per-trade " +
  "conversion). " + MEV_PAYOUT_DROP_AS_IS_NOTE;

/**
 * An empty ledger state.
 * @returns {{version: number, kind: string, updatedAt: string|null,
 *            records: []}}
 */
export function emptyLedger() {
  return { version: CAPTURE_LEDGER_VERSION, kind: CAPTURE_LEDGER_KIND, updatedAt: null, records: [] };
}

/** A compact record id (journal ids are not money paths — uniqueness +
 *  readability are the only requirements). */
function makeRecordId(chain, token, capturedAt) {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `cap-${chain}-${new Date(capturedAt).getTime().toString(36)}-${rand}`;
}

/** Parse + validate an amountRaw (BigInt-compatible integer string ≥ 0).
 *  @returns {string} the normalized decimal string */
export function normalizeAmountRaw(amountRaw, where) {
  let n;
  try {
    n = BigInt(String(amountRaw));
  } catch {
    throw new Error(`captureLedger: ${where} amountRaw must be BigInt-compatible (got "${amountRaw}")`);
  }
  if (n < 0n) throw new Error(`captureLedger: ${where} amountRaw cannot be negative`);
  return n.toString();
}

/**
 * createCaptureRecord — validate + build ONE drop-as-is capture record.
 * Fail-closed: a record for a chain with NO configured treasury throws
 * unless it is explicitly a sandbox measurement (simulated/test — the test
 * fleet recycles the value; the real treasury is production-only).
 *
 * @param {object} input
 * @param {string} input.chain canonical chain key
 * @param {string} input.token the captured token's symbol (what drops as-is)
 * @param {string|bigint} input.amountRaw raw base units of the capture
 * @param {string} [input.tokenAddress] optional mint/contract (evidence)
 * @param {string} [input.destinationTreasury] explicit destination (defaults
 *   to the config's treasury for the chain; sandbox measurement may pass a
 *   TEST fleet address)
 * @param {string} [input.capturedAt] ISO timestamp (default now)
 * @param {string} [input.source] "detection" | "simulated" | "test"
 *   (default "detection")
 * @param {boolean} [input.simulated] measurement flag (default false)
 * @param {boolean} [input.test] test-fleet flag (default false)
 * @param {object} [input.evidence] the detection/analysis evidence {kind,
 *   routeId?, hop?, pair?, gapBps?, route?, netUsd?, whyNot?}
 * @param {object} [input.config] payout config (default
 *   DEFAULT_MEV_PAYOUT_CONFIG)
 * @returns {object} the frozen record
 */
export function createCaptureRecord({
  chain,
  token,
  amountRaw,
  tokenAddress = null,
  destinationTreasury = null,
  capturedAt = null,
  source = "detection",
  simulated = false,
  test = false,
  evidence = null,
  config = DEFAULT_MEV_PAYOUT_CONFIG,
} = {}) {
  if (!chain || typeof chain !== "string") throw new Error("captureLedger.createCaptureRecord: chain is required");
  if (!token || typeof token !== "string") throw new Error("captureLedger.createCaptureRecord: token is required");
  if (!CAPTURE_RECORD_SOURCES.includes(source)) {
    throw new Error(`captureLedger.createCaptureRecord: source must be one of ${CAPTURE_RECORD_SOURCES.join(" | ")} (got "${source}")`);
  }

  const amount = normalizeAmountRaw(amountRaw, "createCaptureRecord");
  if (amount === "0") {
    throw new Error("captureLedger.createCaptureRecord: a zero capture is not a record (nothing drops as-is)");
  }
  const tsMs = capturedAt ? Date.parse(capturedAt) : Date.now();
  if (!Number.isFinite(tsMs)) {
    throw new Error(`captureLedger.createCaptureRecord: capturedAt "${capturedAt}" is not a valid date`);
  }
  const ts = new Date(tsMs).toISOString();

  const sandboxMeasurement = simulated || test || source !== "detection";
  const defaultTreasury = treasuryForChain(config, chain);
  const destination = destinationTreasury || defaultTreasury;
  if (!destination) {
    if (sandboxMeasurement) {
      // Sandbox measurement on an unconfigured chain is allowed (test fleet)
      // but MUST be flagged — a real detection on an unconfigured chain is a
      // config hole and fails closed below.
    } else {
      throw new Error(
        `captureLedger.createCaptureRecord: chain "${chain}" has no configured treasury in the payout config ` +
        "(add it to MEV_PAYOUT_GROUPS_DEFAULT or an override before a real capture can drop there)",
      );
    }
  }
  if (!destination && !sandboxMeasurement) {
    throw new Error("captureLedger.createCaptureRecord: unreachable guard");
  }

  return Object.freeze({
    id: makeRecordId(chain, token, ts),
    kind: "capture-record",
    chain,
    token,
    tokenAddress: tokenAddress ? String(tokenAddress) : null,
    amountRaw: amount,
    destinationTreasury: destination, // null ONLY for an explicitly-flagged sandbox measurement on an unconfigured chain
    capturedAt: ts,
    source,
    simulated: Boolean(simulated),
    test: Boolean(test),
    /** measurement-first: while the capture gate is OFF every record is
     *  deposit INTENT — nothing here moves funds. */
    mode: "measurement",
    dropAsIs: true,
    depositOnly: true,
    note: CAPTURE_RECORD_DROP_AS_IS_NOTE,
    evidence: evidence ? Object.freeze({ ...evidence }) : null,
  });
}

/**
 * recordCapture — append a record to a ledger state (immutable push).
 * @param {object} state a ledger state (emptyLedger() to start)
 * @param {object} input createCaptureRecord input (or a record from it)
 * @returns {{state: object, record: object}} the next state + the record
 */
export function recordCapture(state, input) {
  if (!state || !Array.isArray(state.records)) throw new Error("captureLedger.recordCapture: a ledger state with a records array is required");
  const record = input && input.kind === "capture-record" ? input : createCaptureRecord(input);
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    records: [...state.records, record],
  };
  return { state: next, record };
}

/**
 * recordCaptures — append many records (one state transition).
 * @returns {{state: object, records: object[]}}
 */
export function recordCaptures(state, inputs) {
  if (!Array.isArray(inputs)) throw new Error("captureLedger.recordCaptures: inputs must be an array");
  let next = state;
  const records = [];
  for (const input of inputs) {
    const r = recordCapture(next, input);
    next = r.state;
    records.push(r.record);
  }
  return { state: next, records };
}

/**
 * queryLedger — filter records. Pure.
 * @param {object} state ledger state
 * @param {object} [f] { chain?, token?, source?, simulated?, test?,
 *   since? (ISO), until? (ISO) } — token matches the record token exactly
 * @returns {object[]} the matching records (insertion order)
 */
export function queryLedger(state, f = {}) {
  if (!state || !Array.isArray(state.records)) throw new Error("captureLedger.queryLedger: a ledger state is required");
  const since = f.since ? Date.parse(f.since) : null;
  const until = f.until ? Date.parse(f.until) : null;
  return state.records.filter((r) => {
    if (f.chain && r.chain !== f.chain) return false;
    if (f.token && r.token !== f.token) return false;
    if (f.source && r.source !== f.source) return false;
    if (f.simulated !== undefined && r.simulated !== Boolean(f.simulated)) return false;
    if (f.test !== undefined && r.test !== Boolean(f.test)) return false;
    const t = Date.parse(r.capturedAt);
    if (since !== null && t < since) return false;
    if (until !== null && t > until) return false;
    return true;
  });
}

/** Exact BigInt sum of a record list's amountRaw. @returns {string} */
export function sumAmounts(records) {
  return records.reduce((s, r) => s + BigInt(r.amountRaw), 0n).toString();
}

/**
 * accumulatePile — the ACCUMULATE step: group a chain's records (over an
 * optional period) by captured token. The pile is what the batch sweep
 * converts (sweepPlanner.js). Pure.
 *
 * @param {object} state ledger state
 * @param {object} [f] { chain (required), token?, since?, until?,
 *   includeSimulated? (default true — sandbox measurement piles are the
 *   sandbox's pile; the report separates them) }
 * @returns {Array<object>} per-token pile rows { token, amountRaw (string
 *   sum), recordCount, firstCapturedAt, lastCapturedAt, simulatedCount,
 *   testCount, detectionCount } — descending by amountRaw
 */
export function accumulatePile(state, { chain, token = null, since = null, until = null, includeSimulated = true } = {}) {
  if (!chain) throw new Error("captureLedger.accumulatePile: chain is required");
  const base = queryLedger(state, { chain, token, since, until });
  const rows = includeSimulated ? base : base.filter((r) => !r.simulated && !r.test);
  const byToken = new Map();
  for (const r of rows) {
    if (!byToken.has(r.token)) {
      byToken.set(r.token, { token: r.token, amountRaw: "0", recordCount: 0, firstCapturedAt: r.capturedAt, lastCapturedAt: r.capturedAt, simulatedCount: 0, testCount: 0, detectionCount: 0 });
    }
    const row = byToken.get(r.token);
    row.amountRaw = (BigInt(row.amountRaw) + BigInt(r.amountRaw)).toString();
    row.recordCount += 1;
    if (r.capturedAt < row.firstCapturedAt) row.firstCapturedAt = r.capturedAt;
    if (r.capturedAt > row.lastCapturedAt) row.lastCapturedAt = r.capturedAt;
    if (r.simulated) row.simulatedCount += 1;
    if (r.test) row.testCount += 1;
    if (r.source === "detection") row.detectionCount += 1;
  }
  return [...byToken.values()].sort((a, b) => (BigInt(b.amountRaw) > BigInt(a.amountRaw) ? 1 : BigInt(b.amountRaw) < BigInt(a.amountRaw) ? -1 : 0));
}

/**
 * summarizeLedger — the honest numbers for reports: totals, per-chain
 * piles, measurement vs detection split, unconfigured-chain records.
 * @param {object} state ledger state
 * @returns {object} summary
 */
export function summarizeLedger(state) {
  if (!state || !Array.isArray(state.records)) throw new Error("captureLedger.summarizeLedger: a ledger state is required");
  const records = state.records;
  const chains = [...new Set(records.map((r) => r.chain))].sort();
  const byChain = {};
  for (const chain of chains) {
    const chainRecords = records.filter((r) => r.chain === chain);
    byChain[chain] = {
      recordCount: chainRecords.length,
      amountRaw: sumAmounts(chainRecords),
      pile: accumulatePile(state, { chain }),
    };
  }
  return {
    recordCount: records.length,
    detectionCount: records.filter((r) => r.source === "detection").length,
    simulatedCount: records.filter((r) => r.simulated).length,
    testCount: records.filter((r) => r.test).length,
    chains,
    byChain,
    unconfiguredChainRecords: records.filter((r) => !r.destinationTreasury).length,
    depositOnlyNote: MEV_PAYOUT_DEPOSIT_ONLY_NOTE,
  };
}

/**
 * serializeLedger — the JSON file form. Pure.
 * @returns {string} pretty JSON (version + kind + updatedAt + records)
 */
export function serializeLedger(state) {
  if (!state || !Array.isArray(state.records)) throw new Error("captureLedger.serializeLedger: a ledger state is required");
  return JSON.stringify(
    {
      version: CAPTURE_LEDGER_VERSION,
      kind: CAPTURE_LEDGER_KIND,
      updatedAt: state.updatedAt ?? new Date().toISOString(),
      persistenceNote: CAPTURE_LEDGER_PERSISTENCE_NOTE,
      records: state.records,
    },
    null,
    2,
  );
}

/**
 * parseLedger — load + validate a serialized ledger. Fail-closed: a
 * malformed/foreign file throws (a corrupt journal must never be silently
 * overwritten by a fresh one — the measurement history is evidence).
 * @param {string} json serialized ledger JSON
 * @returns {object} the validated ledger state
 */
export function parseLedger(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("captureLedger.parseLedger: the ledger file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("captureLedger.parseLedger: the ledger file must be a JSON object");
  if (parsed.kind !== CAPTURE_LEDGER_KIND) {
    throw new Error(`captureLedger.parseLedger: not a ${CAPTURE_LEDGER_KIND} file (kind "${parsed.kind ?? "?"}")`);
  }
  if (parsed.version !== CAPTURE_LEDGER_VERSION) {
    throw new Error(`captureLedger.parseLedger: unsupported ledger version ${parsed.version} (this build reads ${CAPTURE_LEDGER_VERSION})`);
  }
  if (!Array.isArray(parsed.records)) throw new Error("captureLedger.parseLedger: the ledger file needs a records array");
  const state = { version: parsed.version, kind: parsed.kind, updatedAt: parsed.updatedAt ?? null, records: [] };
  for (const raw of parsed.records) {
    // re-validate through the record constructor's field checks (id/kind are
    // journal metadata — the money-relevant fields are what matter)
    if (!raw || typeof raw !== "object") throw new Error("captureLedger.parseLedger: a record must be an object");
    const required = ["id", "chain", "token", "amountRaw", "destinationTreasury", "capturedAt", "source"];
    for (const k of required) {
      if (raw[k] === undefined || raw[k] === null) throw new Error(`captureLedger.parseLedger: a record is missing "${k}"`);
    }
    if (!CAPTURE_RECORD_SOURCES.includes(raw.source)) {
      throw new Error(`captureLedger.parseLedger: record ${raw.id} has unknown source "${raw.source}"`);
    }
    state.records.push(
      Object.freeze({
        ...raw,
        amountRaw: normalizeAmountRaw(raw.amountRaw, `record ${raw.id}`),
        simulated: Boolean(raw.simulated),
        test: Boolean(raw.test),
        dropAsIs: true,
        depositOnly: true,
        mode: "measurement",
      }),
    );
  }
  return state;
}

/** Read-modify-write is the caller's job (fs lives outside src/) — this is
 *  the documented file helper contract the tools implement:
 *    load:  parseLedger(readFileSync(path, "utf8"))   (emptyLedger() when
 *           the file does not exist yet — first run)
 *    save:  writeFileSync(path, serializeLedger(state))
 *  The sandbox path default: CAPTURE_LEDGER_SANDBOX_PATH (.sandbox/…,
 *  gitignored). */
export const CAPTURE_LEDGER_FILE_CONTRACT =
  "load: parseLedger(readFileSync(path)) — or emptyLedger() on first run; save: writeFileSync(path, serializeLedger(state)). " +
  "File path: sandbox default .sandbox/mev-capture-ledger.json (gitignored); runtime override MEV_CAPTURE_LEDGER_PATH.";
