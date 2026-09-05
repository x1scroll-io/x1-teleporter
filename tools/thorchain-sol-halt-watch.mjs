/**
 * thorchain-sol-halt-watch.mjs — the SOL HALT WATCHER (2026-09-05).
 *
 * Watches THORChain's SOL pool halt state and ALERTS THE MOMENT it flips
 * back to trading — that is the instant the native deposit lane
 * (BTC/DOGE/LTC/XRP → SOL → X1) is provably live again.
 *
 * WHY THIS EXISTS
 *   A halted SOL pool on THORChain is THEIR network state (verified live
 *   2026-09-05: gateway inbound_addresses shows SOL halted=true, and every
 *   quote into SOL returns HTTP 400 "trading is halted, can't process
 *   swap"). It is not our bug — it resumes on its own. This tool watches for
 *   the resume and, the moment it happens, fires a REAL quote request
 *   (BTC → SOL, the fixture-sized 0.01 BTC) so the log captures proof the
 *   lane is live: the expected_amount_out from a real THORNode quote.
 *
 * MECHANISM
 *   - Polls the inbound-addresses endpoint every ~60s (default):
 *       GET https://gateway.liquify.com/chain/thorchain_api/thorchain/inbound_addresses
 *     (public THORNode surface — no API key required for inbound addresses)
 *     and reads the SOL entry's `halted` flag.
 *   - Logs the current halted state at start (so we know it's watching
 *     correctly), then logs ONLY state transitions + a light heartbeat
 *     (every 15 polls) — no spam.
 *   - When SOL halted flips true → false, it fires the real quote request:
 *       BTC.BTC → SOL.SOL, amount 1,000,000 base units (0.01 BTC — the same
 *       small amount the console harness fixtures use), destination
 *       wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV (the golden fixture
 *       Solana session). It then logs:
 *         "SOL un-halted — quote returned: <expected_amount_out> SOL"
 *     with the raw response body alongside.
 *
 *   QUOTE PATH (two modes, in priority order):
 *     1. THORCHAIN_API_KEY set → quote the Liquify THORNode endpoint
 *        DIRECTLY with the documented `x-client-id` header:
 *          https://gateway.liquify.com/chain/thorchain_api/thorchain/quote/swap
 *     2. No local key → quote through OUR deployed serverless proxy
 *        (the exact production path the console uses — the aggregator key
 *        lives in the server env, never on this box):
 *          https://x1teleporter-git-v2-x1scroll-ios-projects.vercel.app/api/thorchain/quote
 *
 * USAGE
 *   node tools/thorchain-sol-halt-watch.mjs            # watch forever (60s)
 *   node tools/thorchain-sol-halt-watch.mjs --once     # one check + exit
 *   WATCH_INTERVAL_MS=300000 node tools/thorchain-sol-halt-watch.mjs  # 5min
 *
 *   Background (this box, 2026-09-05):
 *     nohup node tools/thorchain-sol-halt-watch.mjs \
 *       >> /root/.openclaw/workspace/logs/thorchain-sol-halt-watch.log 2>&1 &
 *
 * LIGHTWEIGHT + HERMETIC-FRIENDLY: no deps beyond node's global fetch,
 * no writes except stdout (the runner redirects to the log file), no
 * persistent state — a restart simply re-logs the current state. Pure
 * additive tooling; nothing in src/ or the engine is touched.
 */

const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 60_000);
const HEARTBEAT_EVERY = 15; // polls (~15 min at 60s) — proves it's alive

const INBOUND_URL =
  process.env.THORCHAIN_INBOUND_URL ||
  "https://gateway.liquify.com/chain/thorchain_api/thorchain/inbound_addresses";

// The real quote the moment SOL un-halts: BTC → SOL, 0.01 BTC (1e8 base
// units — THORChain's convention), the golden fixture destination.
const QUOTE_FROM_ASSET = process.env.WATCH_QUOTE_FROM_ASSET || "BTC.BTC";
const QUOTE_TO_ASSET = process.env.WATCH_QUOTE_TO_ASSET || "SOL.SOL";
const QUOTE_AMOUNT_BASE = process.env.WATCH_QUOTE_AMOUNT_BASE || "1000000";
const QUOTE_DESTINATION =
  process.env.WATCH_QUOTE_DESTINATION || "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";

const THORCHAIN_API_KEY = (process.env.THORCHAIN_API_KEY || "").trim();
const DIRECT_QUOTE_URL =
  process.env.THORCHAIN_DIRECT_QUOTE_URL ||
  "https://gateway.liquify.com/chain/thorchain_api/thorchain/quote/swap";
const PROXY_QUOTE_URL =
  process.env.THORCHAIN_PROXY_QUOTE_URL ||
  "https://x1teleporter-git-v2-x1scroll-ios-projects.vercel.app/api/thorchain/quote";

const CHAIN = "SOL";
const ONCE = process.argv.includes("--once");

function ts() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

/** Fetch inbound_addresses → the SOL entry's halted flag.
 *  Missing SOL entry is treated as halted (conservative — we can only prove
 *  the lane live when SOL is present AND trading). */
async function fetchSolHalted() {
  const res = await fetch(INBOUND_URL, {
    headers: THORCHAIN_API_KEY ? { "x-client-id": THORCHAIN_API_KEY } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`inbound_addresses HTTP ${res.status}`);
  const json = await res.json();
  const entries = Array.isArray(json) ? json : Array.isArray(json.addresses) ? json.addresses : [];
  const sol = entries.find((e) => e && String(e.chain).toUpperCase() === CHAIN);
  if (!sol) {
    log(`WARNING: no ${CHAIN} entry in inbound_addresses (${entries.length} entries) — treating as halted`);
    return true;
  }
  return sol.halted === true || sol.paused === true;
}

function quoteQs() {
  const p = new URLSearchParams({
    from_asset: QUOTE_FROM_ASSET,
    to_asset: QUOTE_TO_ASSET,
    amount: QUOTE_AMOUNT_BASE,
    destination: QUOTE_DESTINATION,
  });
  return p.toString();
}

/** Fire ONE real quote (BTC→SOL). Returns { ok, expectedOut (decimal SOL),
 *  raw, httpStatus } — never throws. */
async function fireQuote() {
  const mode = THORCHAIN_API_KEY ? "direct gateway (x-client-id header)" : "deployed proxy (server-side key)";
  const url = THORCHAIN_API_KEY
    ? `${DIRECT_QUOTE_URL}?${quoteQs()}`
    : `${PROXY_QUOTE_URL}?${quoteQs()}`;
  log(`firing real quote via ${mode}: ${QUOTE_FROM_ASSET} → ${QUOTE_TO_ASSET} amount=${QUOTE_AMOUNT_BASE} base units (${Number(QUOTE_AMOUNT_BASE) / 1e8} ${QUOTE_FROM_ASSET.split(".")[0]})`);
  try {
    const res = await fetch(url, {
      headers: THORCHAIN_API_KEY ? { "x-client-id": THORCHAIN_API_KEY } : {},
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    const expectedRaw = json?.expected_amount_out;
    const expectedOut =
      expectedRaw !== undefined && expectedRaw !== null && expectedRaw !== ""
        ? Number(expectedRaw) / 1e8
        : null;
    return {
      ok: res.ok && expectedOut !== null && Number.isFinite(expectedOut),
      expectedOut,
      httpStatus: res.status,
      raw: json,
    };
  } catch (e) {
    return { ok: false, expectedOut: null, httpStatus: null, raw: { error: String(e?.message || e) } };
  }
}

/** The moment of proof: SOL un-halted → real quote → report. Up to 3 tries
 *  (a quote right at the un-halt edge can race the pool coming fully up). */
async function reportUnhalt() {
  log(`🎉 SOL un-halted — the native deposit lane should be live. Firing the real quote…`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const q = await fireQuote();
    if (q.ok) {
      log(`SOL un-halted — quote returned: ${q.expectedOut} SOL`);
      log(`quote raw response (HTTP ${q.httpStatus}): ${JSON.stringify(q.raw)}`);
      return;
    }
    log(`quote attempt ${attempt}/3 did not return expected_amount_out (HTTP ${q.httpStatus ?? "err"}): ${JSON.stringify(q.raw).slice(0, 500)}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
  }
  log(`SOL un-halted — but the quote did not return expected_amount_out after 3 tries. Raw responses above — re-check shortly.`);
}

let lastHalted = null;
let polls = 0;

async function tick() {
  polls += 1;
  let halted;
  try {
    halted = await fetchSolHalted();
  } catch (e) {
    log(`inbound fetch failed: ${e?.message || e} — retrying next poll`);
    return;
  }

  if (lastHalted === null) {
    // First observation — log it so we know the watcher is reading correctly.
    log(`watch started — SOL halted=${halted} — polling ${INBOUND_URL} every ${INTERVAL_MS / 1000}s`);
  } else if (halted !== lastHalted) {
    if (halted === false) {
      await reportUnhalt();
    } else {
      log(`SOL halted again (halted=true) — watching for the next un-halt…`);
    }
  }

  if (polls % HEARTBEAT_EVERY === 0) {
    log(`still watching — SOL halted=${halted} (${polls} polls so far)`);
  }

  lastHalted = halted;
}

async function main() {
  log(`thorchain-sol-halt-watch starting — watching THORChain's SOL pool halt state`);
  await tick();
  if (ONCE) {
    log(`--once: single check done — exiting`);
    process.exit(0);
  }
  const timer = setInterval(tick, INTERVAL_MS);
  // NOTE: the interval deliberately stays REFERENCED — an unref'd timer lets
  // node exit the moment a tick finishes (the event loop empties), which
  // kills a nohup'd background watcher after its first poll.
  const shutdown = () => {
    log(`watch stopped (signal) — last known SOL halted=${lastHalted}`);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  log(`fatal: ${e?.message || e}`);
  process.exit(1);
});
