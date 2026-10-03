/**
 * statusEndpoint.js — THORChain tx-status endpoint shape + defensive parsing
 * (Step 3.1 — the hop stage of the THORChain lane).
 *
 * docs/BRIEF.md (Workstream A — Panel 2): poll `/thorchain/tx/status/{inboundTxid}`
 * (Liquify gateway) every 15s, max 90 min, stages
 * `observed → swapping → outbound_signed → done`.
 *
 * ENDPOINT (verified against the public THORChain API contract; the sandbox
 * DNS cannot reach the live hosts, so the exact wire shape is defensive —
 * see the "could not test" note in the PR):
 *   GET {baseUrl}/thorchain/tx/status/{inboundTxid}
 *   - No API key required for STATUS (the aggregator key belongs to the
 *     Step 3.3 QUOTE endpoint and lives server-side only — see
 *     api/thorchain/quote.js).
 *   - LIVE gateway (LIVE-VERIFIED 2026-09-02): the Liquify gateway at
 *     `https://gateway.liquify.com` mirrors THORNode's /thorchain/* surface
 *     under the `/chain/thorchain_api` prefix — the default base below is
 *     https://gateway.liquify.com/chain/thorchain_api and the resolved status
 *     URL is {base}/thorchain/tx/status/{inboundTxid} (the gateway answered a
 *     status probe with a real THORNode body — host + path confirmed). The
 *     previously documented hosts are RETIRED/DNS-dead: liquify.thorchain.org
 *     (HTTP 000), thornode.thorchain.info (HTTP 000) and the *.ninerealms.com
 *     mirrors (retired 2026-04-20). Override via VITE_THORCHAIN_STATUS_URL.
 *
 * RESPONSE SHAPES ACCEPTED (THORNode versions differ; we accept all):
 *   1. Top-level `status` string in the stage vocabulary:
 *        { "status": "swapping", "stages": {...}, ... }
 *   2. Stage objects with completion flags (the classic TxStatusResponse):
 *        { "observed": {...}, "swapping": {...}, "outbound_signed": {...},
 *          "done": {...}, "stages": {...} }
 *      where a stage counts as reached when its object has
 *      `finalised: true` (or `success: true` on older nodes).
 *   3. The `stages` map variant (per-stage `finalised` flags).
 *
 * NOT-FOUND / ERROR handling:
 *   - HTTP 404 or `{ error: "... not found ..." }` → `{ ok:false, reason:"not-found" }`
 *     (the tx hasn't been observed yet — the poller retries).
 *   - `halted: true` on the response → `{ ok:true, stage, halted:true }`
 *     (chain paused — the UI surfaces "paused by THORChain").
 *   - Any other error body → `{ ok:false, reason:"error", message }`.
 *
 * PURE MODULE: no fetch, no DOM, no wallet. Runnable under `node --test`.
 */

export const THORCHAIN_STAGES = Object.freeze([
  "observed",
  "swapping",
  "outbound_signed",
  "done",
]);

/** Stage priority for the "which stage object is finalised" scan — done wins
 *  over outbound_signed, which wins over swapping, which wins over observed.
 *  `observed_tx` is the newer THORNode name for the first stage. */
const STAGE_KEY_PRIORITY = Object.freeze([
  "done",
  "outbound_signed",
  "swapping",
  "observed",
  "observed_tx",
]);

/** Default base URL — the Liquify gateway named in the brief. Override with
 *  VITE_THORCHAIN_STATUS_URL (read once at module load, guarded like flags.ts
 *  so this module also loads under node --test). */
function readEnv() {
  const meta = import.meta;
  if (typeof meta === "undefined") return {};
  const env = meta.env;
  return env && typeof env === "object" ? env : {};
}

const env = readEnv();
export const THORCHAIN_STATUS_BASE_URL =
  env.VITE_THORCHAIN_STATUS_URL || "https://gateway.liquify.com/chain/thorchain_api";

/** Build the status URL for an inbound txid. */
export function statusUrl(baseUrl, inboundTxid) {
  const base = String(baseUrl || THORCHAIN_STATUS_BASE_URL).replace(/\/+$/, "");
  return `${base}/thorchain/tx/status/${encodeURIComponent(inboundTxid)}`;
}

/** Normalise a raw THORChain stage string into the canonical vocabulary.
 *  Accepts the known stage names plus the `inbound_confirmed` intermediate
 *  (which we map to `observed` — the tx is confirmed on the inbound chain and
 *  the swap has not started). Returns null for unknown strings. */
export function normaliseStage(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "observed" || s === "inbound_confirmed" || s === "inbound_observed") {
    return "observed";
  }
  if (THORCHAIN_STAGES.includes(s)) return s;
  return null;
}

/** Does a stage object count as reached? THORNode marks completion with
 *  `finalised: true` (newer) or `success: true` (older). */
function stageReached(obj) {
  if (!obj || typeof obj !== "object") return false;
  return obj.finalised === true || obj.success === true;
}

/**
 * Parse a THORChain tx-status response body into a canonical result.
 *
 * @param {unknown} json parsed JSON body
 * @param {{status?: number}} [meta] optional HTTP metadata (status code)
 * @returns {{ok:true, stage:string, halted:boolean, raw:object}
 *          |{ok:false, reason:"not-found"|"error"|"malformed", message?:string}}
 */
export function parseTxStatusResponse(json, meta = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "malformed", message: "empty or non-object response" };
  }

  // HTTP-level not-found.
  if (meta.status === 404) {
    return { ok: false, reason: "not-found", message: "tx not found (not observed yet)" };
  }

  // Body-level error handling.
  const errText = typeof json.error === "string" ? json.error : "";
  if (errText) {
    if (/not found|does not exist|unknown tx/i.test(errText)) {
      return { ok: false, reason: "not-found", message: errText };
    }
    return { ok: false, reason: "error", message: errText };
  }

  // Chain paused/halted flags (THORNode surfaces these on some responses).
  const halted = json.halted === true || json.paused === true || json.chain_halted === true;

  // 1) Top-level `status` string (newer THORNode).
  const rawStatus = normaliseStage(json.status);
  if (rawStatus) {
    return { ok: true, stage: rawStatus, halted, raw: json };
  }

  // 2) Stage-object scan (classic TxStatusResponse) — highest finalised stage wins.
  for (const key of STAGE_KEY_PRIORITY) {
    if (stageReached(json[key])) {
      const stage = key === "observed_tx" ? "observed" : key;
      return { ok: true, stage, halted, raw: json };
    }
  }

  // 3) `stages` map variant.
  const stages = json.stages;
  if (stages && typeof stages === "object") {
    const ORDER = [
      ["done", "outbound_done"],
      ["outbound_signed", "outbound_signed"],
      ["swapping", "swapping"],
      ["observed", "inbound_observed"],
      ["observed", "inbound_confirmation_counted"],
      ["observed", "inbound_finalised"],
    ];
    for (const [stage, key] of ORDER) {
      if (stageReached(stages[key])) {
        return { ok: true, stage, halted, raw: json };
      }
    }
  }

  // 4) Observed but nothing finalised yet → the earliest stage.
  if (json.observed || json.observed_tx || json.inbound_confirmed || json.tx_id) {
    return { ok: true, stage: "observed", halted, raw: json };
  }

  // 5) Truly unrecognisable body — surface it, keep polling (the poller owns
  //    the retry policy).
  return { ok: false, reason: "malformed", message: "unrecognisable tx-status body" };
}
