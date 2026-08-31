/**
 * inboundAddresses.js — THORChain `/thorchain/inbound_addresses` fetch +
 * refresh for the deposit-address stage of the THORChain lane (Step 3.2).
 *
 * LIFTED LOGIC (per docs/BRIEF.md — swap.thorchain is a LOGIC SOURCE ONLY):
 * the fork fetches inbound addresses from THORNode on mount and periodically
 * (swap.thorchain `src/lib/api.ts` — `getInboundAddresses()` → THORNode
 * `/thorchain/inbound_addresses` via the Liquify gateway). We lift that as a
 * small module: fetch on start + refresh every 60s, expose per-chain
 * `halted` flags so the deposit stage can grey out paused chains with
 * "paused by THORChain".
 *
 * ENDPOINT (same base-URL pattern as the Step 3.1 status module; NO API key
 * for inbound addresses — the THORCHAIN_API_KEY env var belongs to the
 * Step 3.3 aggregator QUOTE endpoint):
 *   GET {baseUrl}/thorchain/inbound_addresses
 *   - Public hosts: `https://liquify.thorchain.org` (Liquify gateway, per the
 *     brief) and `https://thornode.thorchain.info` (public THORNode). The
 *     default base URL is the 3.1 status module's — VITE_THORCHAIN_STATUS_URL
 *     overrides both.
 *
 * RESPONSE SHAPE (THORNode): a bare JSON array of vault entries, e.g.
 *   [{ "chain": "BTC", "pub_key": "...", "address": "bc1q...",
 *      "halted": false, "router": "...", "gas_rate": "...",
 *      "dust_threshold": "...", ... }, ...]
 * Some gateways wrap it as `{ "addresses": [...] }` — both are accepted.
 * The sandbox DNS cannot reach the live hosts (see the Step 3.1 PR note),
 * so the wire shape is parsed defensively.
 *
 * NEVER-CACHE RULE (brief: "Never cache vault addresses across sessions"):
 * the refresher keeps its latest snapshot ONLY in module/instance memory —
 * it never touches localStorage, sessionStorage, or any storage backend, and
 * a fresh mount always fetches from the network. The test asserts this.
 *
 * PURE + DI: `fetchImpl` is injected (tests mock it; the component wires
 * fetch). `schedule` is the timer seam, same pattern as pollStatus.js.
 */

import { THORCHAIN_STATUS_BASE_URL } from "./statusEndpoint.js";

/** Refresh cadence per the brief: on mount and every 60s. */
export const DEFAULT_INBOUND_REFRESH_MS = 60_000;

/** Build the inbound-addresses URL for a base URL. */
export function inboundAddressesUrl(baseUrl) {
  const base = String(baseUrl || THORCHAIN_STATUS_BASE_URL).replace(/\/+$/, "");
  return `${base}/thorchain/inbound_addresses`;
}

/** Default timer seam (mirrors pollStatus.js). */
function defaultSchedule(fn, ms) {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** Default fetch seam — the browser fetch, bound (tests inject a mock). */
function defaultFetch(url) {
  return fetch(url);
}

/**
 * Parse a raw `/thorchain/inbound_addresses` body into normalized entries.
 * Defensive: unknown shapes yield `{ ok:false, reason }` instead of throwing.
 *
 * @param {unknown} json parsed JSON body
 * @returns {{ok:true, entries:Array<object>}
 *          |{ok:false, reason:"malformed"|"not-array", message?:string}}
 *   entry shape: { chain, address, halted, router, gasRate, dustThreshold, raw }
 */
export function parseInboundAddresses(json) {
  if (!json || typeof json !== "object") {
    return { ok: false, reason: "malformed", message: "empty or non-object response" };
  }
  // Some gateways wrap the array; THORNode returns it bare.
  const list = Array.isArray(json) ? json : Array.isArray(json.addresses) ? json.addresses : null;
  if (!list) {
    return { ok: false, reason: "not-array", message: "inbound_addresses body has no address array" };
  }
  const entries = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const chain = typeof raw.chain === "string" ? raw.chain.toUpperCase() : "";
    if (!chain) continue;
    entries.push({
      chain,
      address: typeof raw.address === "string" ? raw.address : "",
      halted: raw.halted === true || raw.paused === true,
      router: typeof raw.router === "string" ? raw.router : null,
      gasRate: typeof raw.gas_rate === "string" ? raw.gas_rate : null,
      dustThreshold: typeof raw.dust_threshold === "string" ? raw.dust_threshold : null,
      raw,
    });
  }
  if (entries.length === 0 && list.length > 0) {
    return { ok: false, reason: "malformed", message: "no recognisable chain entries" };
  }
  return { ok: true, entries };
}

/**
 * Create the inbound-address refresher.
 *
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl] async (url) => Response-like
 *   ({ ok, status, json() }) — default: browser fetch
 * @param {string} [deps.baseUrl] THORChain API base URL (default: the 3.1
 *   status module's default)
 * @param {number} [deps.intervalMs] refresh cadence (default 60s)
 * @param {(fn:()=>void, ms:number) => () => void} [deps.schedule] timer seam
 * @returns {{start:Function, stop:Function, refreshNow:() => Promise<object>,
 *            getLatest:() => Array<object>|null}}
 */
export function createInboundAddressRefresher(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const baseUrl = deps.baseUrl ?? THORCHAIN_STATUS_BASE_URL;
  const intervalMs = deps.intervalMs ?? DEFAULT_INBOUND_REFRESH_MS;
  const schedule = deps.schedule ?? defaultSchedule;

  let running = false;
  let cancelScheduled = null;
  let inFlight = false;
  let latest = null; // in-memory only — NEVER persisted (never-cache rule)

  async function refreshNow() {
    if (inFlight) return { ok: true, entries: latest ?? [], fromCache: true };
    inFlight = true;
    let res;
    try {
      res = await fetchImpl(inboundAddressesUrl(baseUrl));
      const body = res && typeof res.json === "function" ? await res.json() : res;
      const parsed = parseInboundAddresses(body);
      if (parsed.ok) {
        latest = parsed.entries;
        opts.onUpdate?.(parsed.entries);
        return { ok: true, entries: parsed.entries, fromCache: false };
      }
      opts.onError?.(parsed.message || "unparseable inbound_addresses response");
      return parsed;
    } catch (e) {
      const msg = `inbound_addresses fetch failed: ${e?.message || String(e)}`;
      opts.onError?.(msg);
      return { ok: false, reason: "error", message: msg };
    } finally {
      inFlight = false;
    }
  }

  function scheduleNext() {
    if (!running) return;
    cancelScheduled = schedule(() => {
      cancelScheduled = null;
      refreshNow();
      scheduleNext();
    }, intervalMs);
  }

  let opts = {};

  function start(options) {
    if (running) return;
    opts = options || {};
    running = true;
    // Fetch immediately on mount, then every intervalMs (brief: "on mount
    // and every 60s").
    refreshNow();
    scheduleNext();
  }

  function stop() {
    running = false;
    if (cancelScheduled) {
      cancelScheduled();
      cancelScheduled = null;
    }
  }

  return { start, stop, refreshNow, getLatest: () => latest };
}
