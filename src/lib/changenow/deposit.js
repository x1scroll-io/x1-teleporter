/**
 * changenow/deposit.js — the ChangeNOW (instant-swap) rail's DEPOSIT + STATUS
 * half. The long-tail rail's execution shape is DEPOSIT-ADDRESS: the console
 * creates the exchange (src/lib/changenow/index.js createChangeNowExchange),
 * ChangeNOW hands back a payin (deposit) address — plus a payinExtraId / memo
 * for the chains that require one (XMR payment id, ATOM/NEAR memo) — and the
 * user sends the source coin to it from their OWN external wallet. The console
 * never signs.
 *
 * This module mirrors the wallet's src/changenow.ts + src/changenowRail.ts
 * execution logic, but on the SERVER-PROXY boundary the console uses (the
 * browser bundle never holds a key and never calls ChangeNOW directly — the
 * api/changenow/* proxies do).
 *
 * WHAT IT ADDS over index.js (the quote + create half):
 *   - parseChangeNowDeposit — normalize the create response (the payin address
 *     + extra id + the exact amount to send), FAIL-CLOSED on no payin address;
 *   - createChangeNowDeposit — the create wrapper, keyed on the same pinned
 *     source identity (railloop: the network is never omitted);
 *   - the STATUS model — the /v2/exchange/{id} lifecycle (waiting → confirming
 *     → exchanging → sending → finished / failed) mapped to a readable label +
 *     progress, and the terminal predicate that stops the poller;
 *   - fetchChangeNowStatus + parseChangeNowStatus — the status proxy client;
 *   - createStatusPoller — an interval poller that STOPS on a terminal status
 *     (same start()/stop() + injectable `schedule` seam as the THORChain
 *     refreshers, so tests drive it with no timers).
 *
 * FAIL-CLOSED (the whole point): nothing here invents a deposit address, a
 * memo, a rate or a status. A create without a payin address, a status body
 * without a status string, or a coin that NEEDS a memo for which ChangeNOW
 * returned none — all return a not-ok result so the caller withholds the
 * deposit panel instead of misrouting funds.
 *
 * PURE-ish: every network call takes an injectable `fetchImpl` (defaults to the
 * global fetch) so the module runs under `node --test` with no live upstream.
 */
import {
  CHANGENOW_API_BASE,
  createChangeNowExchange,
  changeNowSourceFor,
} from "./index.js";

/** Same-origin proxy base for the deposit STATUS endpoint (api/changenow/status.js). */
export const CHANGENOW_STATUS_BASE = `${CHANGENOW_API_BASE}/status`;

/** Default status poll cadence — ChangeNOW exchanges settle on the order of
 *  minutes; 15s is responsive without hammering the shared 30 req/s key. */
export const DEFAULT_STATUS_POLL_MS = 15_000;

/**
 * The ChangeNOW v2 exchange lifecycle, in order. `finished` terminates the
 * happy path; the FAILED_STATUSES below terminate the sad path. The two ends
 * are what stop the poller.
 */
export const CHANGENOW_STATUS_FLOW = Object.freeze([
  "waiting", "confirming", "exchanging", "sending", "finished",
]);

/** Statuses that mean the exchange will not progress further (terminal).
 *  `refunded`/`expired`/`refund_failed` = the swap did not complete and the
 *  funds were (or could not be) returned — still terminal. */
export const CHANGENOW_FAILED_STATUSES = Object.freeze([
  "failed", "refunded", "expired", "refund_failed",
]);

/** Readable labels for every status the poller can observe (v1 `new` is
 *  treated as `waiting`). Unknown statuses fall through to a neutral label —
 *  never a fabricated milestone. */
const STATUS_LABELS = Object.freeze({
  new: "Waiting for your deposit",
  waiting: "Waiting for your deposit",
  confirming: "Confirming your deposit",
  exchanging: "Exchanging",
  sending: "Sending to X1",
  finished: "Complete",
  failed: "Failed",
  refunded: "Refunded",
  expired: "Expired",
  refund_failed: "Refund failed",
});

// ── the memo/extra-id requirement per long-tail chain ───────────────────────
// ChangeNOW returns `payinExtraId` in the create response for the assets that
// require a destination tag / payment id / memo. These are the long-tail
// chains that ALWAYS need one; a create that omits it for these is refused
// (fail-closed) so a deposit can never be stranded by a missing memo.
export const CHANGENOW_EXTRA_ID_LABEL = Object.freeze({
  xmr: "payment ID",
  atom: "memo",
  near: "memo",
});

/** The human label of the extra id a long-tail chain requires, or null. */
export function changeNowExtraIdLabel(chain) {
  return CHANGENOW_EXTRA_ID_LABEL[String(chain || "").toLowerCase()] ?? null;
}

/** True when this long-tail chain requires a payinExtraId (memo/tag). */
export function changeNowNeedsExtraId(chain) {
  return changeNowExtraIdLabel(chain) !== null;
}

// ── normalize the create response (the deposit address + how much to send) ──

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse a ChangeNOW create (/v2/exchange) response into the deposit panel's
 * model. FAIL-CLOSED: a real `payinAddress` is REQUIRED (no address → null);
 * `payinExtraId` is normalized to a trimmed string or null (never invented).
 * `amountTo` is the estimated payout, `amountFrom` the amount ChangeNOW wants
 * (falls back to the request amount at the call site).
 */
export function parseChangeNowDeposit(data) {
  if (!data || typeof data !== "object") return null;
  const payinAddress = typeof data.payinAddress === "string" ? data.payinAddress.trim() : "";
  if (!payinAddress) return null;
  const extraRaw = data.payinExtraId ?? data.extraId ?? null;
  const payinExtraId = extraRaw != null && String(extraRaw).trim() !== "" ? String(extraRaw).trim() : null;
  return Object.freeze({
    id: data.id != null ? String(data.id) : null,
    payinAddress,
    payinExtraId,
    payoutAddress: data.payoutAddress != null ? String(data.payoutAddress) : (data.address ?? null),
    amountFrom: numOrNull(data.amountFrom ?? data.fromAmount),
    amountTo: numOrNull(data.amountTo ?? data.toAmount),
    status: data.status != null ? String(data.status) : null,
    raw: data,
  });
}

/**
 * Create the ChangeNOW exchange and return the normalized deposit model.
 * Thin wrapper over index.js createChangeNowExchange (which pins the network +
 * requires the payout address). FAIL-CLOSED: an extra-id-requiring source whose
 * create omitted the extra id is refused here — the panel must never render a
 * memo-less deposit address for a memo-required asset.
 *
 * @returns {{ok:true, deposit:object, request:object}|{ok:false, reason:string}}
 */
export async function createChangeNowDeposit(opts = {}, { fetchImpl = fetch } = {}) {
  const res = await createChangeNowExchange(opts, { fetchImpl });
  if (!res.ok) return { ok: false, reason: res.reason };
  const deposit = parseChangeNowDeposit(res.exchange);
  if (!deposit) return { ok: false, reason: "no_payin_address" };
  // Memo-required source: the create must carry the extra id, or we refuse.
  // Resolve the source ticker from the pinned identity (fromChain), falling
  // back to an explicit fromCurrency for direct callers.
  const src = String(changeNowSourceFor(opts.fromChain)?.fromCurrency || opts.fromCurrency || "").toLowerCase();
  if (changeNowNeedsExtraId(src) && !deposit.payinExtraId) {
    return { ok: false, reason: "missing_extra_id", deposit };
  }
  return { ok: true, deposit, request: res.request };
}

// ── the status model ────────────────────────────────────────────────────────

/** The lowercased status, or null when absent. */
export function normalizeChangeNowStatus(status) {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "" ? null : s;
}

/** True when the exchange will not progress further (finished or failed). */
export function isChangeNowTerminalStatus(status) {
  const s = normalizeChangeNowStatus(status);
  if (!s) return false;
  return s === "finished" || CHANGENOW_FAILED_STATUSES.includes(s);
}

/** True only for the successful terminal state. */
export function isChangeNowFinishedStatus(status) {
  return normalizeChangeNowStatus(status) === "finished";
}

/** Readable label for a status — never a fabricated milestone. */
export function changeNowStatusLabel(status) {
  const s = normalizeChangeNowStatus(status);
  if (!s) return "In progress";
  return STATUS_LABELS[s] ?? "In progress";
}

/**
 * Progress through the lifecycle as `{ step, total, fraction }`:
 * step 1..total over the happy-path FLOW; a terminal failure reports the step
 * it reached (or the last one) without claiming progress. Unknown statuses
 * report step 0.
 */
export function changeNowStatusProgress(status) {
  const s = normalizeChangeNowStatus(status);
  const total = CHANGENOW_STATUS_FLOW.length;
  const idx = CHANGENOW_STATUS_FLOW.indexOf(s);
  if (idx >= 0) return { step: idx + 1, total, fraction: total > 1 ? idx / (total - 1) : 1 };
  if (CHANGENOW_FAILED_STATUSES.includes(s)) return { step: 0, total, fraction: 0 };
  return { step: 0, total, fraction: 0 };
}

/**
 * Parse a /v2/exchange/{id} status response into a normalized object.
 * FAIL-CLOSED: a body without a status string yields null.
 */
export function parseChangeNowStatus(data) {
  if (!data || typeof data !== "object") return null;
  const status = normalizeChangeNowStatus(data.status);
  if (!status) return null;
  return Object.freeze({
    id: data.id != null ? String(data.id) : null,
    status,
    payinAddress: typeof data.payinAddress === "string" ? data.payinAddress : null,
    payinExtraId: data.payinExtraId != null ? String(data.payinExtraId) : null,
    payoutAddress: data.payoutAddress != null ? String(data.payoutAddress) : null,
    amountFrom: numOrNull(data.amountFrom),
    amountTo: numOrNull(data.amountTo),
    terminal: isChangeNowTerminalStatus(status),
    raw: data,
  });
}

/** Build the same-origin status-proxy URL for an exchange id. */
export function buildChangeNowStatusUrl(id, base = CHANGENOW_STATUS_BASE) {
  const params = new URLSearchParams();
  const v = String(id ?? "").trim();
  if (v !== "") params.set("id", v);
  return `${base}?${params.toString()}`;
}

/**
 * Fetch the live status of an exchange through the status proxy.
 * FAIL-CLOSED: missing id / network error / non-ok / malformed body →
 * `{ ok:false, reason }`. Never throws.
 */
export async function fetchChangeNowStatus(id, { fetchImpl = fetch, baseUrl = CHANGENOW_STATUS_BASE } = {}) {
  const cleanId = String(id ?? "").trim();
  if (cleanId === "") return { ok: false, reason: "missing_id" };
  let resp;
  try {
    resp = await fetchImpl(buildChangeNowStatusUrl(cleanId, baseUrl));
  } catch {
    return { ok: false, reason: "network_error" };
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok || data?.error || data?.message) {
    return { ok: false, reason: String(data?.error || data?.message || resp.status || "status_failed") };
  }
  const status = parseChangeNowStatus(data);
  if (!status) return { ok: false, reason: "unusable_status" };
  return { ok: true, status };
}

// ── the poller (stops on a terminal status) ────────────────────────────────

/** Default timer seam (mirrors the THORChain refreshers' schedule seam). */
function defaultSchedule(fn, ms) {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/**
 * Create an interval poller for an exchange's status. On `start()` it fetches
 * immediately, then every `intervalMs`; it calls `onUpdate(status)` on each
 * successful read and STOPS itself the moment a terminal status arrives
 * (finished/failed). Transient errors call `onError(reason)` and keep polling
 * (a blip must not abandon an in-flight exchange). `schedule` is the timer
 * seam (tests pass a synchronous/manual driver). Returns `{ start, stop }`.
 */
export function createStatusPoller({
  id,
  fetchImpl = fetch,
  baseUrl = CHANGENOW_STATUS_BASE,
  intervalMs = DEFAULT_STATUS_POLL_MS,
  schedule = defaultSchedule,
  onUpdate,
  onError,
} = {}) {
  let cancelTimer = null;
  let stopped = false;
  let last = null;

  async function tick() {
    if (stopped) return;
    const res = await fetchChangeNowStatus(id, { fetchImpl, baseUrl });
    if (stopped) return;
    if (res.ok) {
      last = res.status;
      onUpdate?.(res.status);
      if (isChangeNowTerminalStatus(res.status.status)) {
        stop();
        return;
      }
    } else {
      onError?.(res.reason, res);
    }
    cancelTimer = schedule(tick, intervalMs);
  }

  function start() {
    if (stopped) return;
    tick();
  }

  function stop() {
    stopped = true;
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
  }

  return {
    start,
    stop,
    get last() { return last; },
  };
}
