/**
 * changenow/deposit.test.js — the ChangeNOW long-tail DEPOSIT + STATUS half.
 *
 * Proves the deposit panel's contracts without a live upstream (every network
 * call goes through an injected fetchImpl):
 *   - the create response is normalized FAIL-CLOSED (a real payin address is
 *     required; a memo-required asset without its extra id is refused);
 *   - the status lifecycle maps to readable labels + progress and the terminal
 *     predicate is exact (finished / failed / refunded / expired);
 *   - the status fetch is fail-closed (missing id / network / non-ok /
 *     malformed body → not ok, never fabricated);
 *   - the poller polls on the injected schedule seam and STOPS on a terminal
 *     status, while a transient error keeps it polling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHANGENOW_STATUS_BASE,
  DEFAULT_STATUS_POLL_MS,
  CHANGENOW_STATUS_FLOW,
  changeNowExtraIdLabel,
  changeNowNeedsExtraId,
  parseChangeNowDeposit,
  createChangeNowDeposit,
  normalizeChangeNowStatus,
  isChangeNowTerminalStatus,
  isChangeNowFinishedStatus,
  changeNowStatusLabel,
  changeNowStatusProgress,
  parseChangeNowStatus,
  buildChangeNowStatusUrl,
  fetchChangeNowStatus,
  createStatusPoller,
} from "./deposit.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Route-aware fake fetch for the create + status proxy calls. */
function fakeFetch({ create, status } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const u = String(url);
    if (u.includes("/create")) {
      const code = create?.__status ?? 200;
      return { ok: code < 400, status: code, json: async () => create ?? {} };
    }
    const code = status?.__status ?? 200;
    return { ok: code < 400, status: code, json: async () => status ?? {} };
  };
  fn.calls = calls;
  return fn;
}

// ── deposit normalization (fail-closed) ─────────────────────────────────────

test("changenow/deposit: parseChangeNowDeposit requires a payin address and normalizes the extra id", () => {
  assert.equal(parseChangeNowDeposit(null), null);
  assert.equal(parseChangeNowDeposit({}), null, "no payin address → not a deposit");
  assert.equal(parseChangeNowDeposit({ payinAddress: "   " }), null, "blank payin → not a deposit");
  const d = parseChangeNowDeposit({
    id: 42, payinAddress: "  4AdDress  ", payinExtraId: "  memo123 ", payoutAddress: "So1", amountFrom: 1.5, amountTo: "61.2",
  });
  assert.ok(d);
  assert.equal(d.id, "42");
  assert.equal(d.payinAddress, "4AdDress", "trimmed");
  assert.equal(d.payinExtraId, "memo123", "trimmed");
  assert.equal(d.payoutAddress, "So1");
  assert.equal(d.amountFrom, 1.5);
  assert.equal(d.amountTo, 61.2);
  // A null/blank extra id normalizes to null (never invented).
  assert.equal(parseChangeNowDeposit({ payinAddress: "a", payinExtraId: null }).payinExtraId, null);
  assert.equal(parseChangeNowDeposit({ payinAddress: "a", payinExtraId: "  " }).payinExtraId, null);
  // `extraId` is accepted as an alias.
  assert.equal(parseChangeNowDeposit({ payinAddress: "a", extraId: "tag" }).payinExtraId, "tag");
});

test("changenow/deposit: the memo-required chains declare their required extra-id label", () => {
  assert.equal(changeNowExtraIdLabel("xmr"), "payment ID");
  assert.equal(changeNowExtraIdLabel("ATOM"), "memo");
  assert.equal(changeNowExtraIdLabel("near"), "memo");
  assert.equal(changeNowNeedsExtraId("xmr"), true);
  assert.equal(changeNowNeedsExtraId("ada"), false);
  assert.equal(changeNowExtraIdLabel("ada"), null);
});

// ── create wrapper ──────────────────────────────────────────────────────────

test("changenow/deposit: createChangeNowDeposit returns the normalized deposit on success", async () => {
  const fetchImpl = fakeFetch({ create: { id: "ex1", payinAddress: "4Deposit", payinExtraId: "pid7", payoutAddress: "So1", amountFrom: 1, amountTo: 60 } });
  const r = await createChangeNowDeposit({ fromChain: "xmr", toCurrency: "usdc", toNetwork: "sol", amount: 1, address: "So1ana" }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.deposit.payinAddress, "4Deposit");
  assert.equal(r.deposit.payinExtraId, "pid7", "the memo is carried through");
  assert.equal(r.request.fromNetwork, "xmr", "the source network is pinned on the create");
});

test("changenow/deposit: createChangeNowDeposit FAILS CLOSED (missing params / no payin / missing memo)", async () => {
  const missing = await createChangeNowDeposit({ fromChain: "xmr", toCurrency: "usdc", amount: 1 }, { fetchImpl: fakeFetch({}) });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing_params", "no payout address");

  const noPayin = await createChangeNowDeposit({ fromChain: "ada", toCurrency: "usdc", amount: 1, address: "So1ana" }, { fetchImpl: fakeFetch({ create: { id: "ex1" } }) });
  assert.equal(noPayin.ok, false);
  assert.equal(noPayin.reason, "no_payin_address");

  // XMR needs a payment id; a create that omits it is refused (never a
  // memo-less deposit address for a memo-required asset).
  const noMemo = await createChangeNowDeposit({ fromChain: "xmr", toCurrency: "usdc", amount: 1, address: "So1ana" }, { fetchImpl: fakeFetch({ create: { id: "ex1", payinAddress: "4AdDress" } }) });
  assert.equal(noMemo.ok, false);
  assert.equal(noMemo.reason, "missing_extra_id");

  // ADA does not need one — a memo-less create is fine there.
  const adaOk = await createChangeNowDeposit({ fromChain: "ada", toCurrency: "usdc", amount: 1, address: "So1ana" }, { fetchImpl: fakeFetch({ create: { payinAddress: "addrAda" } }) });
  assert.equal(adaOk.ok, true);
});

// ── status model ────────────────────────────────────────────────────────────

test("changenow/deposit: the status lifecycle maps to labels + progress, terminally", () => {
  assert.equal(normalizeChangeNowStatus("  Finished "), "finished");
  assert.equal(normalizeChangeNowStatus(null), null);
  assert.equal(changeNowStatusLabel("waiting"), "Waiting for your deposit");
  assert.equal(changeNowStatusLabel("confirming"), "Confirming your deposit");
  assert.equal(changeNowStatusLabel("exchanging"), "Exchanging");
  assert.equal(changeNowStatusLabel("sending"), "Sending to X1");
  assert.equal(changeNowStatusLabel("finished"), "Complete");
  assert.equal(changeNowStatusLabel("new"), "Waiting for your deposit", "v1 new ≡ waiting");
  assert.equal(changeNowStatusLabel("wat"), "In progress", "unknown → neutral, never invented");
  // Terminal predicate.
  assert.equal(isChangeNowTerminalStatus("waiting"), false);
  assert.equal(isChangeNowTerminalStatus("sending"), false);
  assert.equal(isChangeNowTerminalStatus("finished"), true);
  assert.equal(isChangeNowTerminalStatus("failed"), true);
  assert.equal(isChangeNowTerminalStatus("refunded"), true);
  assert.equal(isChangeNowTerminalStatus("expired"), true);
  assert.equal(isChangeNowFinishedStatus("finished"), true);
  assert.equal(isChangeNowFinishedStatus("failed"), false);
  // Progress tracks the happy path in order.
  assert.equal(CHANGENOW_STATUS_FLOW.length, 5);
  assert.deepEqual(changeNowStatusProgress("waiting"), { step: 1, total: 5, fraction: 0 });
  assert.deepEqual(changeNowStatusProgress("finished"), { step: 5, total: 5, fraction: 1 });
  assert.equal(changeNowStatusProgress("failed").fraction, 0);
  assert.equal(changeNowStatusProgress("wat").step, 0);
});

test("changenow/deposit: parseChangeNowStatus is fail-closed and flags terminal", () => {
  assert.equal(parseChangeNowStatus(null), null);
  assert.equal(parseChangeNowStatus({}), null, "no status string → null");
  assert.equal(parseChangeNowStatus({ status: "   " }), null);
  const s = parseChangeNowStatus({ id: 9, status: "Finished", amountFrom: 1, amountTo: 58.4 });
  assert.ok(s);
  assert.equal(s.status, "finished");
  assert.equal(s.id, "9");
  assert.equal(s.amountTo, 58.4);
  assert.equal(s.terminal, true);
});

// ── status fetch ────────────────────────────────────────────────────────────

test("changenow/deposit: buildChangeNowStatusUrl forwards only the id (encoded)", () => {
  assert.equal(buildChangeNowStatusUrl("ex1"), `${CHANGENOW_STATUS_BASE}?id=ex1`);
  assert.equal(buildChangeNowStatusUrl("a/b"), `${CHANGENOW_STATUS_BASE}?id=a%2Fb`);
  assert.equal(buildChangeNowStatusUrl(""), `${CHANGENOW_STATUS_BASE}?`);
});

test("changenow/deposit: fetchChangeNowStatus is fail-closed on every failure shape", async () => {
  const ok = await fetchChangeNowStatus("ex1", { fetchImpl: fakeFetch({ status: { status: "sending" } }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.status.status, "sending");

  assert.equal((await fetchChangeNowStatus("", { fetchImpl: fakeFetch({}) })).reason, "missing_id");

  const netErr = await fetchChangeNowStatus("ex1", { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(netErr.ok, false);
  assert.equal(netErr.reason, "network_error");

  const bad = await fetchChangeNowStatus("ex1", { fetchImpl: fakeFetch({ status: { __status: 502, error: "boom" } }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "boom");

  const malformed = await fetchChangeNowStatus("ex1", { fetchImpl: fakeFetch({ status: {} }) });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "unusable_status");
});

// ── poller ──────────────────────────────────────────────────────────────────

test("changenow/deposit: the status poller polls and STOPS on a terminal status", async () => {
  const bodies = [{ status: "waiting" }, { status: "confirming" }, { status: "finished" }];
  let i = 0;
  const fetchImpl = async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => body };
  };
  const scheduled = [];
  const schedule = (fn) => { scheduled.push(fn); return () => {}; };
  const updates = [];
  const poller = createStatusPoller({ id: "ex1", fetchImpl, schedule, intervalMs: DEFAULT_STATUS_POLL_MS, onUpdate: (s) => updates.push(s.status) });
  poller.start();
  await flush();
  assert.deepEqual(updates, ["waiting"], "first read on start");
  assert.equal(scheduled.length, 1, "rescheduled after a non-terminal status");
  scheduled.shift()(); await flush();
  assert.deepEqual(updates, ["waiting", "confirming"]);
  scheduled.shift()(); await flush();
  assert.deepEqual(updates, ["waiting", "confirming", "finished"]);
  // Terminal → no further tick is scheduled.
  assert.equal(scheduled.length, 0, "the poller stopped on finished");
  assert.equal(i, 3, "exactly three reads");
  assert.equal(poller.last.status, "finished");

  // After stop() a pending scheduled tick is inert.
  poller.stop();
  await flush();
  assert.equal(i, 3, "no reads after stop");
});

test("changenow/deposit: a transient status error keeps the poller polling (never abandons the exchange)", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 502, json: async () => ({ error: "blip" }) };
    return { ok: true, status: 200, json: async () => ({ status: "exchanging" }) };
  };
  const scheduled = [];
  const schedule = (fn) => { scheduled.push(fn); return () => {}; };
  const errors = [];
  const updates = [];
  const poller = createStatusPoller({ id: "ex1", fetchImpl, schedule, onUpdate: (s) => updates.push(s.status), onError: (r) => errors.push(r) });
  poller.start();
  await flush();
  assert.deepEqual(errors, ["blip"]);
  assert.equal(scheduled.length, 1, "still scheduled after the error");
  scheduled.shift()(); await flush();
  assert.deepEqual(updates, ["exchanging"], "recovered on the next tick");
  poller.stop();
});
