/**
 * mev-discover-sweep.mjs — the SELF-DISCOVERING capture sweep (APE
 * UNIVERSE build #1 integration). Replaces the hardcoded-mint scratch
 * sweep (whose mint table went stale — wrong BONK mint, real WIF not
 * findable by symbol) with the memeDiscovery.js pipeline: DISCOVERY finds
 * what is actually trading on ≥2 liquid venues RIGHT NOW, and the sweep
 * runs the proven venue-gap capture cycle (detect gap → buy the cheaper
 * venue → sell back → record the ledger) on each.
 *
 * THE CAGE (Mr. Esters — absolute, the pattern proven this session):
 *   • SANDBOX-ONLY. The live path requires the gitignored caged test-wallet
 *     keys (.sandbox/keys/sol-hub.json + .sandbox/helius-key.json) and
 *     refuses to run without them. .sandbox/ is gitignored — nothing here
 *     ever commits keys.
 *   • TEST-SCALE ONLY. Tiny hard-capped amounts (default 0.03 SOL ≈ $3 —
 *     "keeps the float alive for many"), --amount-sol hard-capped at 0.1.
 *   • ROUND-TRIP RECYCLE ALWAYS. Every buy is sold back in full — the
 *     sandbox float is recycled, never accumulated.
 *   • LEDGER-RECORDED. Every capture appends a record to the capture
 *     ledger (captureLedger.js canonical format) — source "test",
 *     test-flagged: a TEST-fleet capture, deposit INTENT, never the real
 *     treasury.
 *   • NO AUTONOMY. This tool does nothing unless a human runs it with
 *     --sweep. Discovery alone (--discover) touches no wallet at all.
 *
 * USAGE (through the repo loader — memDiscovery is plain ESM, no jsx
 * needed, but the loader is harmless; run from the repo root):
 *   node tools/mev-discover-sweep.mjs --discover                # live discovery report (no funds)
 *   node tools/mev-discover-sweep.mjs --discover --sweep        # + caged round-trip captures (top 3)
 *   node tools/mev-discover-sweep.mjs --discover --sweep --top 1 --amount-sol 0.05 --min-gap-bps 3
 *   node tools/mev-discover-sweep.mjs --discover --sweep --dry-run   # gap probes only, NO broadcast
 *
 * OPTIONS
 *   --chain <key>       sol (default) | eth | bas | bsc | pol
 *   --top <n>           candidates to sweep (default 3; discovery cap 25)
 *   --amount-sol <n>    test-scale buy per candidate (default 0.03; HARD
 *                       CAP 0.1 SOL — the cage)
 *   --min-gap-bps <n>   capture threshold (default 3)
 *   --min-liq-usd <n>   discovery per-venue liquidity floor (default 50000)
 *   --min-vol-usd <n>   discovery volume floor (default 10000)
 *   --seed-symbols      add the curated DEX Screener symbol-search seed
 *                       (DEFAULT_MEME_SEED_SYMBOLS) to GT trending
 *   --dry-run           run discovery + gap probes; print what WOULD be
 *                       captured; broadcast nothing, write nothing
 *   --ledger <path>     ledger path (default .sandbox/mev-capture-ledger.json)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";

import { discoverMemes, DEFAULT_MEME_SEED_SYMBOLS } from "../src/lib/mev/memeDiscovery.js";
import { emptyLedger, parseLedger, serializeLedger, recordCaptures, summarizeLedger } from "../src/lib/mev/captureLedger.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
const SANDBOX = join(REPO, ".sandbox");
const DEFAULT_LEDGER = join(SANDBOX, "mev-capture-ledger.json");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_QUOTE = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP = "https://api.jup.ag/swap/v1/swap";
const MAX_AMOUNT_SOL = 0.1; // 🔴 the cage's hard cap — test scale only

// ── args ───────────────────────────────────────────────────────────────────
function argValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
const args = process.argv.slice(2);
const chain = argValue(args, "--chain") ?? "sol";
const topN = Number(argValue(args, "--top") ?? 3);
const amountSol = Number(argValue(args, "--amount-sol") ?? 0.03);
const minGapBps = Number(argValue(args, "--min-gap-bps") ?? 3);
const minLiqUsd = Number(argValue(args, "--min-liq-usd") ?? 50_000);
const minVolUsd = Number(argValue(args, "--min-vol-usd") ?? 10_000);
const ledgerPath = argValue(args, "--ledger") ?? DEFAULT_LEDGER;
const sweep = args.includes("--sweep");
const dryRun = args.includes("--dry-run");
const seedSymbols = args.includes("--seed-symbols") ? DEFAULT_MEME_SEED_SYMBOLS : [];
if (!(amountSol > 0) || amountSol > MAX_AMOUNT_SOL) {
  console.error(`🔴 --amount-sol must be > 0 and ≤ ${MAX_AMOUNT_SOL} (the cage's hard cap — test scale only). Got ${amountSol}`);
  process.exit(1);
}
if (!Number.isFinite(topN) || topN < 1) {
  console.error("--top must be ≥ 1");
  process.exit(1);
}

// ── the caged wallet (only for --sweep) ────────────────────────────────────
function loadSandboxWallet() {
  const keyPath = join(SANDBOX, "keys", "sol-hub.json");
  const heliusPath = join(SANDBOX, "helius-key.json");
  for (const p of [keyPath, heliusPath]) {
    if (!existsSync(p)) {
      console.error(`🔴 caged sandbox key missing: ${p}`);
      console.error("   The live sweep needs the gitignored test-wallet keys (.sandbox/keys/sol-hub.json + .sandbox/helius-key.json).");
      console.error("   Discovery-only runs (--discover without --sweep) need no keys.");
      process.exit(1);
    }
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const helius = JSON.parse(readFileSync(heliusPath, "utf8")).endpoint;
  return { kp, conn: new Connection(helius, "confirmed") };
}

// ── ledger (canonical captureLedger format) ────────────────────────────────
function loadLedger() {
  if (!existsSync(ledgerPath)) return emptyLedger();
  try {
    return parseLedger(readFileSync(ledgerPath, "utf8"));
  } catch (err) {
    console.error(`ledger at ${ledgerPath} failed to parse: ${err.message}`);
    console.error("refusing to overwrite a journal — fix/migrate it, or point --ledger at a fresh path");
    process.exit(1);
  }
}
function saveLedger(state) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, serializeLedger(state));
}

// ── Jupiter (the proven quote + execute cycle) ─────────────────────────────
async function jupQuote(inMint, outMint, amountRaw, excludeDex) {
  const url = `${JUP_QUOTE}?inputMint=${inMint}&outputMint=${outMint}&amount=${amountRaw}&slippageBps=100` +
    (excludeDex ? `&excludeDexes=${encodeURIComponent(excludeDex)}` : "");
  // polite retry on 429/5xx — Jupiter rate-limits bursts (the discovery
  // phase + sweep probes run back-to-back)
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) {
      const retryAfter = Number(r.headers.get("retry-after") ?? 0) * 1000;
      const wait = retryAfter > 0 ? retryAfter : 800 * attempt;
      if (attempt < 4) {
        console.log(`   (jupiter quote ${r.status} — retry ${attempt}/3 in ${wait}ms)`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
    }
    throw new Error(`Jupiter quote HTTP ${r.status}`);
  }
  throw new Error("Jupiter quote failed after retries");
}

async function executeSwap(quote, kp, conn) {
  const r = await fetch(JUP_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote, userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto",
    }),
  });
  const d = await r.json();
  if (!d.swapTransaction) return { err: `swap build failed: ${JSON.stringify(d).slice(0, 140)}` };
  const tx = VersionedTransaction.deserialize(Buffer.from(d.swapTransaction, "base64"));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5, skipPreflight: true });
  for (let i = 0; i < 30; i += 1) {
    await new Promise((res) => setTimeout(res, 3000));
    const s = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (s.value && s.value.confirmationStatus) return { sig, status: s.value.confirmationStatus, err: s.value.err };
  }
  return { sig, status: "pending", err: null };
}

const venueLabel = (q) => q.routePlan?.[0]?.swapInfo?.label ?? "?";
const routeVenues = (q) => [...new Set((q.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean))];

/**
 * probeGap — the proven venue-gap detection: best route vs best route
 * EXCLUDING the first venue. Returns null when there is no 2nd venue (the
 * single-venue case — NOT capturable) or the gap is below threshold.
 */
async function probeGap(mint, amountLamports) {
  const best = await jupQuote(SOL_MINT, mint, amountLamports);
  if (!best.outAmount) return { whyNot: "not tradable via Jupiter right now" };
  const venues = routeVenues(best);
  if (venues.length < 1) return { whyNot: "no venue in the best route" };
  const alt = await jupQuote(SOL_MINT, mint, amountLamports, venues[0]);
  if (!alt.outAmount) return { whyNot: `single-venue [${venues.join(", ")}] — no 2nd venue, not capturable` };
  const bestOut = BigInt(best.outAmount);
  const altOut = BigInt(alt.outAmount);
  const cheaper = altOut > bestOut ? alt : best;
  const pricier = altOut > bestOut ? best : alt;
  const gapBps = Number(((bestOut > altOut ? bestOut - altOut : altOut - bestOut) * 10000n) / (bestOut < altOut ? bestOut : altOut));
  return { best, alt, cheaper, pricier, venues, gapBps, cheaperVenue: venueLabel(cheaper), pricierVenue: venueLabel(pricier) };
}

// ── the per-candidate sweep (round-trip recycle, ledger-recorded) ──────────
async function sweepCandidate(c, { kp, conn, amountLamports, minGapBps, dryRun }) {
  const tag = `${c.symbol} (${c.mint.slice(0, 8)}…)`;
  let probe;
  try {
    probe = await probeGap(c.mint, amountLamports);
  } catch (err) {
    return { tag, ok: false, whyNot: `probe error: ${err.message.slice(0, 80)}` };
  }
  if (!probe.best) return { tag, ok: false, whyNot: probe.whyNot };
  if (probe.gapBps < minGapBps) {
    return { tag, ok: false, whyNot: `gap ${probe.gapBps.toFixed(1)} bps < ${minGapBps} bps threshold [${probe.venues.join(", ")}]` };
  }
  console.log(`🎯 ${tag}: ${probe.gapBps.toFixed(1)} bps gap — ${probe.cheaperVenue} cheaper than ${probe.pricierVenue} [venues: ${probe.venues.join(", ")}]`);
  if (dryRun) {
    return { tag, ok: true, dryRun: true, gapBps: probe.gapBps, venueChosen: probe.cheaperVenue, venueAlternative: probe.pricierVenue, note: "gap capturable — --dry-run: nothing broadcast, nothing recorded" };
  }
  const buy = await executeSwap(probe.cheaper, kp, conn);
  if (!buy?.sig || buy.err) return { tag, ok: false, whyNot: `buy failed: ${buy?.err ? JSON.stringify(buy.err).slice(0, 100) : "no tx"}` };
  console.log(`   ✅ bought via ${probe.cheaperVenue}: ${buy.sig.slice(0, 24)}…`);
  // confirm the token balance, then sell the FULL balance back (recycle)
  await new Promise((r) => setTimeout(r, 4000));
  const bal = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(c.mint) });
  const held = bal.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  const decimals = bal.value[0]?.account.data.parsed.info.tokenAmount.decimals ?? 6;
  if (held <= 0n) return { tag, ok: false, whyNot: "no token balance after buy — checking float" };
  const sellQuote = await jupQuote(c.mint, SOL_MINT, held.toString());
  if (!sellQuote.outAmount) return { tag, ok: false, whyNot: "sell quote failed — balance NOT recycled, check hub", heldRaw: held.toString() };
  const sell = await executeSwap(sellQuote, kp, conn);
  if (!sell?.sig || sell.err) return { tag, ok: false, whyNot: `sell failed: ${sell?.err ? JSON.stringify(sell.err).slice(0, 100) : "no tx"} — balance NOT recycled`, heldRaw: held.toString() };
  console.log(`   ✅ round-trip: sold ${(Number(held) / 10 ** decimals).toFixed(4)} back via ${venueLabel(sellQuote)}: ${sell.sig.slice(0, 24)}…`);
  // ledger record (canonical captureLedger — source "test": a TEST-fleet
  // capture in the caged sandbox; deposit INTENT, funds recycled)
  return {
    tag, ok: true, captured: true, gapBps: probe.gapBps, venueChosen: probe.cheaperVenue,
    amountRaw: held.toString(), tx: buy.sig,
    record: {
      chain: "sol",
      token: c.symbol,
      tokenAddress: c.mint,
      amountRaw: held.toString(),
      source: "test",
      simulated: false,
      test: true,
      evidence: {
        kind: "venue-gap-capture",
        venueChosen: probe.cheaperVenue,
        venueAlternative: probe.pricierVenue,
        gapBps: probe.gapBps,
        solIn: String(amountLamports),
        tokenOut: held.toString(),
        decimals,
        buyTx: buy.sig,
        sellTx: sell.sig,
        discoveredBy: "memeDiscovery",
        venues: probe.venues,
        note: "REAL sandbox capture (caged test wallet, round-trip recycled, ledger-recorded — deposit INTENT only).",
      },
    },
  };
}

// ── main ───────────────────────────────────────────────────────────────────
console.log("═ MEV DISCOVER SWEEP (APE UNIVERSE build #1 — self-discovering capture sweep)");
console.log(`  discovery: chain=${chain}  minVenueLiq=$${minLiqUsd}  minVol24=$${minVolUsd}  minVenues=2  ${seedSymbols.length ? `symbol-seed (${seedSymbols.length})` : "GT-trending seed only"}`);
if (sweep) {
  console.log(`  sweep: top=${topN}  amount=${amountSol} SOL (cap ${MAX_AMOUNT_SOL})  minGap=${minGapBps} bps  ${dryRun ? "DRY-RUN (no broadcast, no record)" : "LIVE (caged sandbox)"}`);
  console.log("  🔒 CAGE: sandbox-only test scale · round-trip recycle always · ledger-recorded deposit INTENT · never autonomous");
}

const candidates = await discoverMemes({
  chain,
  minLiquidityUsd: minLiqUsd,
  minVolume24Usd: minVolUsd,
  minVenues: 2,
  seedSymbols,
  verbose: true,
});
console.log("");
if (candidates.length === 0) {
  console.log("no capturable candidates right now (nothing with ≥2 venues above the floors) — nothing to sweep");
  process.exit(0);
}
console.log(`═ LIVE DISCOVERY — ${candidates.length} capturable candidate(s) (≥2 liquid venues — the capture precondition)`);
for (const c of candidates) {
  const v = c.venues.map((x) => `${x.dex} $${Math.round(x.liquidityUsd).toLocaleString()}`).join(" · ");
  console.log(`  ${c.symbol.padEnd(14)} ${c.mint.slice(0, 12)}…  liq $${Math.round(c.liquidityUsd).toLocaleString().padStart(10)}  vol24 $${Math.round(c.volume24Usd).toLocaleString().padStart(10)}  ${c.venueCount} venue(s): ${v}`);
  console.log(`                sources: ${c.sources.join(", ")}`);
}

if (!sweep) {
  console.log("");
  console.log("🔒 discovery-only run — no wallet touched. Re-run with --sweep for the caged round-trip captures.");
  process.exit(0);
}

const { kp, conn } = loadSandboxWallet();
const hub = kp.publicKey.toBase58();
const solBal = await conn.getBalance(kp.publicKey);
const amountLamports = BigInt(Math.floor(amountSol * 1e9));
console.log("");
console.log(`═ CAGED SWEEP — hub ${hub}  SOL ${(solBal / 1e9).toFixed(4)}  buy ${amountSol} SOL/candidate  ${dryRun ? "DRY-RUN" : "LIVE"}`);
let ledgerState = loadLedger();
const results = [];
for (const c of candidates.slice(0, topN)) {
  const r = await sweepCandidate(c, { kp, conn, amountLamports, minGapBps, dryRun });
  results.push(r);
  // one state transition per capture (immutable ledger — never save from a
  // stale state)
  if (r.record) {
    const { state } = recordCaptures(ledgerState, [r.record]);
    ledgerState = state;
    saveLedger(ledgerState);
  }
  console.log(`  ${r.ok ? (r.captured ? "✅ CAPTURED + RECYCLED" : r.dryRun ? "🔎 capturable (dry-run)" : "—") : "⏭  skipped"} ${r.tag}: ${r.whyNot ?? `${r.gapBps.toFixed(1)} bps via ${r.venueChosen}`}`);
}
console.log("");
const captured = results.filter((r) => r.captured);
if (captured.length) {
  console.log(`ledger: ${captured.length} capture(s) recorded → ${ledgerPath} (${summarizeLedger(loadLedger()).recordCount} total records)`);
} else if (dryRun) {
  console.log("dry-run complete — nothing broadcast, nothing recorded");
} else {
  console.log("no captures this pass (gaps below threshold or single-venue) — the float is untouched");
}
console.log("🔒 NO AUTONOMOUS FUNDS MOVEMENT: every capture was a caged test-scale round trip, recycled in full, ledger-recorded as deposit INTENT.");
