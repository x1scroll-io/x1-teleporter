/**
 * thorchain-sui-launch-watch.mjs — the THORChain-SUI LAUNCH WATCHER
 * (2026-09-06 SUI COVERAGE CHECK, deliverable #4).
 *
 * Watches THORChain's public inbound-addresses endpoint for SUI to APPEAR
 * as a chain entry — the moment THORChain ships its roadmap Sui support
 * (SOL/TON/Cardano/Sui via EdDSA), a "SUI" vault entry shows up there.
 * That instant is when Sui gains its SECOND rail (THORChain becomes the
 * Sui FALLBACK behind Rango — and the X1TP affiliate earns on it).
 *
 * WHY THIS EXISTS
 *   SUI is a Rango-ONLY source today (teleportRail.js COVERAGE_MATRIX:
 *   sui → [Rango]) — a SINGLE POINT OF FAILURE: when Rango is down/halted,
 *   the Sui lane goes fully dark. THORChain's public roadmap lists Sui
 *   (via EdDSA). The moment it ships, we re-verify a live SUI→SOL quote
 *   and add THORCHAIN to the sui matrix row ([THORChain, Rango]) — Sui
 *   gets its fallback rail and our THORChain affiliate (the deposit-memo
 *   pair) earns on Sui journeys. This tool catches that moment so the
 *   matrix update is a same-day exercise, not a discovery months later.
 *
 * MECHANISM (mirror of tools/thorchain-sol-halt-watch.mjs)
 *   - Polls the same public endpoint every ~60s (default):
 *       GET https://gateway.liquify.com/chain/thorchain_api/thorchain/inbound_addresses
 *     (public THORNode surface — no API key required for inbound addresses)
 *     and looks for a chain entry whose id is "SUI".
 *   - Logs the current state at start (not-yet-live vs live), then logs
 *     ONLY state transitions + a light heartbeat (every 15 polls).
 *   - When SUI APPEARS, it fires a REAL quote probe to prove the lane:
 *       SUI.SUI → SOL.SOL (the console lane's landing chain), fixture-sized
 *     via the same two-mode quote path as the sol-halt watcher:
 *       1. THORCHAIN_API_KEY set → quote the Liquify THORNode endpoint
 *          DIRECTLY with the documented `x-client-id` header;
 *       2. no local key → quote through OUR deployed serverless proxy
 *          (https://x1teleporter-…vercel.app/api/thorchain/quote).
 *     It logs the outcome — and EXACTLY what to do next (re-verify, add
 *     THORCHAIN to the sui row, Wanchain-style evidence pack).
 *
 * USAGE
 *   node tools/thorchain-sui-launch-watch.mjs            # watch forever (60s)
 *   node tools/thorchain-sui-launch-watch.mjs --once     # one check + exit
 *   WATCH_INTERVAL_MS=300000 node tools/thorchain-sui-launch-watch.mjs  # 5min
 *
 *   Background (this box):
 *     nohup node tools/thorchain-sui-launch-watch.mjs \
 *       >> /root/.openclaw/workspace/logs/thorchain-sui-launch-watch.log 2>&1 &
 *
 * LIGHTWEIGHT + HERMETIC-FRIENDLY: no deps beyond node's global fetch, no
 * writes except stdout, no persistent state — a restart simply re-logs the
 * current state. Pure additive tooling; nothing in src/ or the engine is
 * touched. NOTE: this watches for the LAUNCH. Once SUI is live and added
 * to the matrix, retire this tool (or repoint it) — the console's own
 * rail-level UX (src/lib/rango/routeState.js) handles day-to-day halts.
 */

const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 60_000);
const HEARTBEAT_EVERY = 15; // polls (~15 min at 60s) — proves it's alive

const INBOUND_URL =
  process.env.THORCHAIN_INBOUND_URL ||
  "https://gateway.liquify.com/chain/thorchain_api/thorchain/inbound_addresses";

// The probe quote the moment SUI appears: SUI → SOL (the console lane's
// landing chain), fixture-sized 100 SUI (1e11 base units — Sui 9 decimals;
// the same small size the rango-leg golden fixture uses).
const QUOTE_FROM_ASSET = process.env.WATCH_QUOTE_FROM_ASSET || "SUI.SUI";
const QUOTE_TO_ASSET = process.env.WATCH_QUOTE_TO_ASSET || "SOL.SOL";
const QUOTE_AMOUNT_BASE = process.env.WATCH_QUOTE_AMOUNT_BASE || "100000000000";
const QUOTE_DESTINATION =
  process.env.WATCH_QUOTE_DESTINATION || "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";

const THORCHAIN_API_KEY = (process.env.THORCHAIN_API_KEY || "").trim();
const DIRECT_QUOTE_URL =
  process.env.THORCHAIN_DIRECT_QUOTE_URL ||
  "https://gateway.liquify.com/chain/thorchain_api/thorchain/quote/swap";
const PROXY_QUOTE_URL =
  process.env.THORCHAIN_PROXY_QUOTE_URL ||
  "https://x1teleporter-git-v2-x1scroll-ios-projects.vercel.app/api/thorchain/quote";

const CHAIN = "SUI";
const ONCE = process.argv.includes("--once");

function ts() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

/** Fetch inbound_addresses → true when THORChain lists a SUI chain entry
 *  (the launch signal). Missing SUI entry = not launched yet. */
async function fetchSuiPresent() {
  const res = await fetch(INBOUND_URL, {
    headers: THORCHAIN_API_KEY ? { "x-client-id": THORCHAIN_API_KEY } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`inbound_addresses HTTP ${res.status}`);
  const json = await res.json();
  const entries = Array.isArray(json) ? json : Array.isArray(json.addresses) ? json.addresses : [];
  const sui = entries.find((e) => e && String(e.chain).toUpperCase() === CHAIN);
  if (!sui) return false;
  log(`SUI entry found: chain=${sui.chain} router=${sui.router ?? "(none)"} halted=${sui.halted ?? false} paused=${sui.paused ?? false}`);
  return true;
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

/** Fire ONE real SUI→SOL quote. Returns { ok, expectedOut (decimal SOL),
 *  raw, httpStatus } — never throws. */
async function fireQuote() {
  const mode = THORCHAIN_API_KEY ? "direct gateway (x-client-id header)" : "deployed proxy (server-side key)";
  const url = THORCHAIN_API_KEY
    ? `${DIRECT_QUOTE_URL}?${quoteQs()}`
    : `${PROXY_QUOTE_URL}?${quoteQs()}`;
  log(`firing real quote via ${mode}: ${QUOTE_FROM_ASSET} → ${QUOTE_TO_ASSET} amount=${QUOTE_AMOUNT_BASE} base units (100 SUI)`);
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

/** THE MOMENT: SUI appeared in THORChain's inbound list → prove the lane
 *  with a real quote, then print the exact next steps. Up to 3 tries (a
 *  quote right at launch can race the pool coming fully up). */
async function reportLaunch() {
  log(`🎉 THORChain now lists SUI — Sui's SECOND rail is live. Firing the real quote…`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const q = await fireQuote();
    if (q.ok) {
      log(`SUI launch — quote returned: ${q.expectedOut} SOL`);
      log(`quote raw response (HTTP ${q.httpStatus}): ${JSON.stringify(q.raw)}`);
      break;
    }
    log(`quote attempt ${attempt}/3 did not return expected_amount_out (HTTP ${q.httpStatus ?? "err"}): ${JSON.stringify(q.raw).slice(0, 500)}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
  }
  log(`── NEXT STEPS (the matrix update — do it the same day) ──`);
  log(`1. Re-verify a live SUI→SOL quote (above) + capture the evidence fixture`);
  log(`   (Wanchain-style: test/fixtures/golden/thorchain-leg/ or the rango-leg pack).`);
  log(`2. teleportRail.js COVERAGE_MATRIX: sui → [THORChain, Rango]`);
  log(`   (THORChain first: deposit-address execution; Rango the fallback).`);
  log(`3. Check the THORChain deposit lane's source registry accepts SUI`);
  log(`   (src/lib/thorchain/config.js THORCHAIN_SOURCE_ASSETS + memo handling)`);
  log(`   and the console's source picker lists Sui with deposit-address execution.`);
  log(`4. The X1TP affiliate pair rides the deposit memo (same as BTC/DOGE/LTC/XRP)`);
  log(`   — Sui journeys start earning the moment the row flips.`);
  log(`5. Retire this watcher (or repoint it at the next roadmap chain: TON/Cardano).`);
}

let lastPresent = null;
let polls = 0;

async function tick() {
  polls += 1;
  let present;
  try {
    present = await fetchSuiPresent();
  } catch (e) {
    log(`inbound fetch failed: ${e?.message || e} — retrying next poll`);
    return;
  }

  if (lastPresent === null) {
    // First observation — log it so we know the watcher is reading correctly.
    log(
      present
        ? `watch started — SUI IS LIVE in THORChain inbound_addresses (launch already happened — run the NEXT STEPS above)`
        : `watch started — SUI not in THORChain inbound_addresses yet (roadmap: SOL/TON/Cardano/Sui via EdDSA) — polling ${INBOUND_URL} every ${INTERVAL_MS / 1000}s`
    );
    if (present) await reportLaunch();
  } else if (present !== lastPresent) {
    if (present) {
      await reportLaunch();
    } else {
      log(`SUI entry disappeared from inbound_addresses (unlikely — re-checking)…`);
    }
  }

  if (polls % HEARTBEAT_EVERY === 0) {
    log(`still watching — SUI present=${present} (${polls} polls so far)`);
  }

  lastPresent = present;
}

async function main() {
  log(`thorchain-sui-launch-watch starting — watching for THORChain to list SUI (its roadmap Sui enablement)`);
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
    log(`watch stopped (signal) — last known SUI present=${lastPresent}`);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  log(`fatal: ${e?.message || e}`);
  process.exit(1);
});
