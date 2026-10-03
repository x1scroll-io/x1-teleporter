/**
 * mev-capture-measure.mjs — the SANDBOX CAPTURE MEASUREMENT tool (the
 * MEASURE/VERIFY record of the treasury design — docs/MEV-PAYOUT.md).
 *
 * Given a test route's REAL quotes (the frozen exotic-route evidence files,
 * REAL-labeled — test/fixtures/golden/mev-multihop/inputs/route-*.json and
 * test/fixtures/golden/mev-capture/inputs/round-*-evidence.json), run the
 * capture engine's observation pipelines and RECORD what the engine WOULD
 * capture into the capture ledger — marked simulated/test. This is the
 * exotic-route verification record: does the engine capture the right gap
 * on real aping flow? The ledger answers it, per leg, in raw units + USD.
 *
 * 🔴 HARD LIMITS (Mr. Esters — absolute): NO funds move. NO signing. NO
 * network. This tool is PURE measurement over frozen quotes: the scan
 * pipelines are the gated observation paths (captureGate.js — gated OFF by
 * default; every line carries "(gated OFF)"), the records are drop-as-is
 * deposit INTENT (captureLedger.js — recording moves nothing), and the
 * deposits + sweeps are future ARMED actions (signable artifacts only).
 * The real treasury is production-only — sandbox measurement records ride
 * the test fleet (source simulated/test).
 *
 * USAGE (run through the repo's loader — captureGate imports flags.ts):
 *   node --import ./tools/jsx-loader.mjs tools/mev-capture-measure.mjs \
 *       --route test/fixtures/golden/mev-multihop/inputs/route-01-sol-ape-2500-down.json
 *   node --import ./tools/jsx-loader.mjs tools/mev-capture-measure.mjs \
 *       --pair  test/fixtures/golden/mev-capture/inputs/round-01-sol-SOL-USDC-evidence.json [--gas 123]
 *   node --import ./tools/jsx-loader.mjs tools/mev-capture-measure.mjs            # config + ledger report
 *
 * OPTIONS
 *   --route <file>   measure a multi-hop route evidence file (route-*.json)
 *   --pair <file>    measure a same-pair round evidence file (round-*.json)
 *   --gas <raw>      gas in quote-token raw units (same-pair only; default 0)
 *   --ledger <path>  ledger JSON path (default .sandbox/mev-capture-ledger.json)
 *   --dry-run        print the measurement WITHOUT writing the ledger
 *   --source <s>     record source: simulated | test (default simulated)
 *
 * CONFIG OVERRIDES (the payout-config load pattern): env vars (see
 * readPayoutEnv in payoutConfig.js) and, when present, the gitignored
 * .sandbox/mev-payout-config.json — { "groups": { "evm": { "address": … },
 * "solana_x1": { "address": … } }, "sweepFrequency": …, "sweepBasket": […] }.
 * Sandbox measurement runs may point the destinations at the TEST fleet
 * (the .sandbox mev-treasury-hd.json addresses) via that file. Nothing is
 * ever committed (.sandbox/ is gitignored).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolvePayoutConfig,
  readPayoutEnv,
  DEFAULT_MEV_PAYOUT_CONFIG,
  MEV_PAYOUT_GROUPS_DEFAULT,
  MEV_SWEEP_FREQUENCIES,
  MEV_SWEEP_BASKET,
  BASKET_TARGETS,
  MEV_PAYOUT_DEPOSIT_ONLY_NOTE,
} from "../src/lib/mev/payoutConfig.js";
import {
  emptyLedger,
  parseLedger,
  serializeLedger,
  recordCaptures,
  summarizeLedger,
  CAPTURE_LEDGER_SANDBOX_PATH,
} from "../src/lib/mev/captureLedger.js";
import { planSweeps, basketTargetsForChain } from "../src/lib/mev/sweepPlanner.js";
import { captureGate, runCaptureScan, runRouteCaptureScan, dropAsIsRecords, formatCaptureReport, formatRouteCaptureReport } from "../src/lib/mev/captureGate.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
const DEFAULT_LEDGER = join(REPO, CAPTURE_LEDGER_SANDBOX_PATH);
const SANDBOX_CONFIG = join(REPO, ".sandbox", "mev-payout-config.json");

// ── args ───────────────────────────────────────────────────────────────────
function argValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
const args = process.argv.slice(2);
const routeFile = argValue(args, "--route");
const pairFile = argValue(args, "--pair");
const ledgerPath = argValue(args, "--ledger") ?? DEFAULT_LEDGER;
const dryRun = args.includes("--dry-run");
const source = argValue(args, "--source") ?? "simulated";
const gasRaw = argValue(args, "--gas") ?? "0";
if (!["simulated", "test"].includes(source)) {
  console.error(`source must be simulated | test (got "${source}")`);
  process.exit(1);
}

// ── config (defaults + env + gitignored sandbox file) ──────────────────────
function loadConfig() {
  const overrides = readPayoutEnv(process.env);
  if (existsSync(SANDBOX_CONFIG)) {
    const file = JSON.parse(readFileSync(SANDBOX_CONFIG, "utf8"));
    if (file.groups) {
      overrides.groups = { ...(overrides.groups ?? {}), ...file.groups };
    }
    if (file.sweepFrequency) overrides.sweepFrequency = file.sweepFrequency;
    if (file.sweepBasket) overrides.sweepBasket = file.sweepBasket;
  }
  return resolvePayoutConfig(overrides);
}
const config = loadConfig();

// ── ledger load ─────────────────────────────────────────────────────────────
function loadLedger() {
  if (!existsSync(ledgerPath)) return emptyLedger();
  try {
    return parseLedger(readFileSync(ledgerPath, "utf8"));
  } catch (err) {
    console.error(`ledger at ${ledgerPath} failed to parse: ${err.message}`);
    console.error("refusing to overwrite a corrupt journal — fix or move it, then re-run");
    process.exit(1);
  }
}
function saveLedger(state) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, serializeLedger(state));
}

// ── report helpers ──────────────────────────────────────────────────────────
function printConfig() {
  const gate = captureGate();
  console.log("═ MEV CAPTURE PAYOUT + MEASUREMENT (gated OFF — measurement only)");
  console.log(`  gate: ${gate.label} (MEV_CAPTURE_ENABLED=${gate.enabled}) — executable: ${gate.executable} — ${gate.note}`);
  console.log(`  ${MEV_PAYOUT_DEPOSIT_ONLY_NOTE}`);
  console.log("  treasury map (drop-as-is destinations — deposit-only):");
  for (const [groupId, g] of Object.entries(config.groups)) {
    const interim = MEV_PAYOUT_GROUPS_DEFAULT[groupId].address !== g.address ? " (OVERRIDDEN — sandbox/test fleet or arm override)" : "";
    console.log(`    ${groupId.padEnd(10)} ${g.address}  — ${g.chains.join(", ")}${interim}`);
  }
  console.log(`  sweep: frequency=${config.sweep.frequency} (${MEV_SWEEP_FREQUENCIES.join("|")})  basket=${config.sweep.basket.join(",")}`);
  for (const chain of Object.keys(config.payouts)) {
    const { representable, unavailable } = basketTargetsForChain(config, chain);
    const rep = representable.length ? representable.map((r) => `${r.member}→${r.canonicalSymbol}`).join(", ") : "—";
    const unav = unavailable.length ? `  unavailable: ${unavailable.map((u) => u.member).join(", ")}` : "";
    console.log(`    basket@${chain.padEnd(3)} ${rep}${unav}`);
  }
  console.log("  config overrides: env VITE_MEV_PAYOUT_EVM / VITE_MEV_PAYOUT_SOLANA_X1 / MEV_SWEEP_FREQUENCY + gitignored .sandbox/mev-payout-config.json");
}

function printLedgerReport(state) {
  const s = summarizeLedger(state);
  console.log("═ CAPTURE LEDGER (drop-as-is deposit INTENT — recording moves no funds)");
  console.log(`  file: ${ledgerPath}${dryRun ? "  (--dry-run: NOT written)" : ""}`);
  console.log(`  records: ${s.recordCount}  (detection ${s.detectionCount} / simulated ${s.simulatedCount} / test ${s.testCount})  chains: ${s.chains.join(", ") || "—"}`);
  for (const chain of s.chains) {
    const c = s.byChain[chain];
    console.log(`  pile@${chain}: ${c.recordCount} records, ${c.amountRaw} raw total`);
    for (const row of c.pile) {
      console.log(`    ${row.token.padEnd(20)} ${row.amountRaw} raw  (${row.recordCount} rec, sim ${row.simulatedCount}, test ${row.testCount})`);
    }
  }
  if (s.unconfiguredChainRecords > 0) {
    console.log(`  ⚠ ${s.unconfiguredChainRecords} records have NO destination treasury (unconfigured chain sandbox measurement)`);
  }
}

function printMeasurement(heading, scan, records, skipped) {
  console.log(`═ ${heading}`);
  console.log(`  ${scan.report}`);
  if (scan.payout) console.log(`  drop-as-is destination: ${scan.payout.group} ${scan.payout.address}`);
  if (scan.payouts && Object.keys(scan.payouts).length) {
    for (const [chain, p] of Object.entries(scan.payouts)) {
      console.log(`  leg-chain destination ${chain}: ${p.group} ${p.address}`);
    }
  }
  const recs = records.filter(Boolean);
  if (recs.length === 0) {
    console.log("  records: none (no economically positive capture to record)");
  } else {
    let total = 0n;
    console.log("  MEASURE/VERIFY — what the engine WOULD capture (recorded to the ledger):");
    for (const r of recs) {
      total += BigInt(r.amountRaw);
      const ev = r.evidence ?? {};
      const where = ev.kind === "multi-hop-route-choice" ? `hop ${ev.hop} ${ev.from}→${ev.to} ${ev.venueChosen}→${ev.venueBest} (${ev.gapBps ?? "?"} bps)` : `pair ${ev.pair ?? "?"} route ${(ev.route ?? []).join(" → ")} (${ev.netRoundTripBps ?? "?"} bps net)`;
      console.log(`    ${r.chain.padEnd(4)} ${r.token.padEnd(16)} ${r.amountRaw.padStart(20)} raw  → ${r.destinationTreasury ?? "(no configured treasury — sandbox)"}  [${where}]`);
    }
    console.log(`    TOTAL recorded: ${total.toString()} raw (${recs.length} records, source=${source}, simulated, test-flagged)`);
  }
  for (const sk of skipped) {
    console.log(`  skipped: ${sk.reason ?? "?"}${sk.hop ? ` (hop ${sk.hop})` : ""}`);
  }
  console.log(`  gate: ${scan.gate.label} — records are measurement only; deposits + sweeps are future armed actions (never autonomous)`);
}

// ── measure modes ───────────────────────────────────────────────────────────
function measureRoute(file) {
  const evidence = JSON.parse(readFileSync(join(REPO, file), "utf8"));
  if (!Array.isArray(evidence.legs) || !evidence.routeId) {
    console.error(`--route ${file}: not a multi-hop route evidence file (needs routeId + legs)`);
    process.exit(1);
  }
  const scan = runRouteCaptureScan({ id: evidence.routeId, legs: evidence.legs });
  const { records, skipped } = dropAsIsRecords(scan, { source, simulated: true, test: true, config });
  printMeasurement(`ROUTE MEASUREMENT — ${evidence.routeId} (${file})`, scan, records, skipped);
  console.log(`  analysis: ${formatRouteCaptureReport(scan.analysis)}`);
  return records;
}

function measurePair(file) {
  const evidence = JSON.parse(readFileSync(join(REPO, file), "utf8"));
  if (!Array.isArray(evidence.buy) || !Array.isArray(evidence.sell)) {
    console.error(`--pair ${file}: not a same-pair round evidence file (needs buy[] + sell[])`);
    process.exit(1);
  }
  const ok = (list) => (list || []).filter((q) => q.ok !== false && q.amountOut !== undefined && q.amountOut !== null);
  const buyQuotes = ok(evidence.buy).map((q) => ({ dex: q.dex, pool: q.pool ?? null, amountIn: q.amountIn, amountOut: q.amountOut }));
  const sellQuotes = ok(evidence.sell).map((q) => ({ dex: q.dex, pool: q.pool ?? null, amountIn: q.amountIn, amountOut: q.amountOut }));
  const scan = runCaptureScan({
    chain: evidence.chain,
    pair: { from: evidence.pair?.from ?? null, to: evidence.pair?.to ?? null },
    buyQuotes,
    sellQuotes,
    gasCostQuoteUnits: gasRaw,
  });
  const { records, skipped } = dropAsIsRecords(scan, { source, simulated: true, test: true, config });
  printMeasurement(`SAME-PAIR MEASUREMENT — ${evidence.chain} ${evidence.pair?.from ?? "?"}→${evidence.pair?.to ?? "?"} (${file})`, scan, records, skipped);
  console.log(`  detection: ${formatCaptureReport(scan.detection)}`);
  return records;
}

// ── main ────────────────────────────────────────────────────────────────────
printConfig();
console.log("");
if (!routeFile && !pairFile) {
  printLedgerReport(loadLedger());
  console.log("");
  const gate = captureGate();
  console.log(`  batch sweep plans for the current ledger (per-chain, default consolidation): ${gate.label}`);
  const bundle = planSweeps({ ledgerState: loadLedger(), config });
  for (const p of bundle.plans) {
    console.log(`    ${p.chain}: ${p.wouldSweep ? `${p.pile.length} pile rows, ${p.steps.length} steps → ${p.destination.address}` : p.whyNot}`);
  }
  process.exit(0);
}

const ledger = loadLedger();
const records = [];
if (routeFile) records.push(...measureRoute(routeFile));
if (pairFile) records.push(...measurePair(pairFile));
const real = records.filter(Boolean);
console.log("");
if (real.length === 0) {
  console.log("no records to write (nothing capturable recorded) — ledger unchanged");
  process.exit(0);
}
if (dryRun) {
  console.log(`--dry-run: ${real.length} record(s) would append to ${ledgerPath} — NOT written`);
} else {
  const { state } = recordCaptures(ledger, real);
  saveLedger(state);
  console.log(`ledger updated: ${ledgerPath} (now ${state.records.length} records, ${summarizeLedger(state).simulatedCount + summarizeLedger(state).testCount} simulated/test)`);
}
console.log("");
console.log("🔒 NO FUNDS MOVED: measurement-only run. Recording deposit INTENT; deposits + batch sweeps are future armed actions (signable artifacts, Mr. Esters' arm).");
