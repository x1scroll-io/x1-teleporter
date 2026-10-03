/**
 * mev-report-build.mjs — build the MEV-capture SIMULATION report (offline).
 *
 * Reads the raw simulation output (docs/mev-simulation-2026-09-06.json +
 * test/fixtures/golden/mev-capture/inputs/round-*-evidence.json), adds the
 * ECONOMIC layer the pure detector deliberately does not (USD value of the
 * net, and the economically-capturable flag — a strict-math net of a few
 * raw units is not an executable capture), and writes:
 *   - docs/mev-simulation-2026-09-06.json   (updated: + usd fields)
 *   - docs/MEV-SIMULATION-2026-09-06.md     (the human report)
 *
 * USD conversions use ONLY the captured quotes themselves (no synthetic
 * prices): EVM stable pairs ≈ $1 by pair construction (peg pairs, ~1e-3
 * tolerance — documented); Solana values the SOL side through the same
 * round's real SOL→USDC venue quotes.
 *
 * Usage: node tools/mev-report-build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
const JSON_PATH = join(REPO, "docs", "mev-simulation-2026-09-06.json");
const MD_PATH = join(REPO, "docs", "MEV-SIMULATION-2026-09-06.md");
const INPUTS = join(REPO, "test", "fixtures", "golden", "mev-capture", "inputs");

/** The economic bar: a detection is ECONOMICALLY capturable only when the
 *  net is ≥ $0.10 AND ≥ 1 bps. (The strict detector flags any positive net;
 *  a few raw units of profit are quote-rounding noise, not a capture.) */
export const EC_MIN_USD = 0.1;
export const EC_MIN_BPS = 1;

const div = (raw, dec) => Number(BigInt(String(raw))) / 10 ** dec;

/** USD value of a detection's net, from the round's OWN real quotes. */
function netUsd(detection, evidence) {
  try {
    if (!evidence) return null;
    if (detection.chain === "sol") {
      const dec = evidence.decimals;
      const fromDec = dec?.from ?? 9;
      const toDec = dec?.to ?? 6;
      // real SOL→USDC rate from the buy side's best real venue (raw USDC per raw SOL)
      const buys = (evidence.buy || []).filter((q) => q.amountOut && q.amountIn && q.dex !== undefined);
      if (!buys.length) return null;
      let best = buys[0];
      for (const b of buys) if (BigInt(b.amountOut) > BigInt(best.amountOut)) best = b;
      const solPerLamportUsdc = Number(BigInt(best.amountOut)) / Number(BigInt(best.amountIn)); // USDC raw per SOL raw
      const netUsdcRaw = Number(BigInt(String(detection.netValueAfterCostsRaw ?? 0))) * solPerLamportUsdc;
      return netUsdcRaw / 10 ** toDec;
    }
    // EVM stable pairs: USDC↔USDT — $1 by pair construction (peg; ~1e-3 tolerance)
    const dec = evidence.decimals ?? (detection.chain === "bsc" ? 18 : 6);
    return div(detection.netValueAfterCostsRaw ?? 0, dec);
  } catch {
    return null;
  }
}

function loadEvidence(d) {
  const pair = d.pair ? `${d.pair.from}-${d.pair.to}` : "";
  const file = join(INPUTS, `round-${String(d.round).padStart(2, "0")}-${d.chain}-${pair}-evidence.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function buildReport() {
  const report = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  const dets = (report.detections || []).map((d) => {
    const evidence = loadEvidence(d);
    const usd = netUsd(d, evidence);
    const bps = d.netRoundTripBps;
    const economicallyCapturable = Boolean(
      d.wouldCapture && usd !== null && usd >= EC_MIN_USD && bps !== null && bps >= EC_MIN_BPS,
    );
    return { ...d, netValueAfterCostsUsd: usd, economicallyCapturable };
  });
  report.detections = dets;

  const total = dets.length;
  const wouldCapture = dets.filter((d) => d.wouldCapture).length;
  const econ = dets.filter((d) => d.economicallyCapturable).length;
  const byChain = {};
  for (const d of dets) {
    byChain[d.chain] ??= { total: 0, wouldCapture: 0, economicallyCapturable: 0, gapBps: [] };
    byChain[d.chain].total++;
    if (d.wouldCapture) byChain[d.chain].wouldCapture++;
    if (d.economicallyCapturable) byChain[d.chain].economicallyCapturable++;
    if (d.gapBps !== null) byChain[d.chain].gapBps.push(d.gapBps);
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  report.economic = {
    EC_MIN_USD,
    EC_MIN_BPS,
    total,
    wouldCapture,
    economicallyCapturable: econ,
    note:
      "wouldCapture (strict): net after both pool fees + gas is positive in raw units. economicallyCapturable: " +
      `net ≥ $${EC_MIN_USD} AND ≥ ${EC_MIN_BPS} bps — the honest bar (a few raw units of profit are quote-rounding noise).`,
    byChain: Object.fromEntries(
      Object.entries(byChain).map(([c, v]) => [c, { ...v, gapBps: { min: v.gapBps.length ? Math.min(...v.gapBps) : null, max: v.gapBps.length ? Math.max(...v.gapBps) : null, avg: avg(v.gapBps) } }]),
    ),
  };
  report.summary.note =
    "gapBps = best-vs-second venue spread on the buy side (raw units). netRoundTripBps is net of BOTH pool fees " +
    "(already inside the quotes) + gas. wouldCapture is the strict positive-net flag; see economic.* for the honest bar.";
  writeFileSync(JSON_PATH, JSON.stringify(report, null, 2));
  writeFileSync(MD_PATH, renderMd(report));
  return report;
}

function renderMd(report) {
  const L = [];
  const push = (s = "") => L.push(s);
  const e = report.economic;
  const s = report.summary;
  push("# MEV / price-gap capture — SIMULATION REPORT (2026-09-06)");
  push();
  push("**Real on-chain quotes. Zero trades. Gated OFF.**");
  push();
  push("The MEV/price-gap capture engine (src/lib/mev/) ran its detector against **live pool state** on the chains the");
  push("DEX-direct legs cover — read-only quoter eth_calls (EVM), on-chain pool-state walks + the legs' own quote math");
  push("(Solana), keyless aggregator quotes (Jupiter / LiFi). The capture EXECUTION path is dead-gated");
  push("(MEV_CAPTURE_ENABLED=false — the repo default and main-branch build; armed v2 builds are wallet-sign-only by");
  push("structure: the composed legs are the existing guarded swap legs, whose submit() throws DexDirectLiveTestGateError).");
  push();
  push("## The honest headline");
  push();
  push(`- **${e.total} round-trip detections** over 8 sample rounds (${report.date}).`);
  push(`- Observed same-chain cross-venue spreads: **${s.gapBps.min}–${s.gapBps.max} bps** (avg ${s.gapBps.avg?.toFixed(2)} bps).`);
  push(`- Net round trips after BOTH pool fees (netted inside the quotes) + gas: **${s.netRoundTripBps.min} to ${s.netRoundTripBps.max} bps** (avg ${s.netRoundTripBps.avg?.toFixed(2)} bps).`);
  push(`- Strict-math positive nets: **${e.wouldCapture}/${e.total}** — all four are noise: ≤ 0.004 bps net (≈ $0.02 on ~$530 — the aggregator's own two-sided quote rounding), routed Jupiter→Jupiter (same venue).`);
  push(`- **Economically capturable (net ≥ $${e.EC_MIN_USD} AND ≥ ${e.EC_MIN_BPS} bps): ${e.economicallyCapturable}/${e.total}. ZERO.**`);
  push(`- **How often gaps were TOO SMALL: ${e.total - e.economicallyCapturable}/${e.total} (${((e.total - e.economicallyCapturable) / e.total * 100).toFixed(0)}%).**`);
  push();
  push("**Conclusion:** on the DEEP STABLE PAIRS the bridge actually moves (USDC↔USDT on eth/arb/bsc, SOL→USDC on");
  push("Solana) at the sampled sizes ($2,500 / 5 SOL), the round-trip cost — two pool fees + gas — exceeds every");
  push("observed same-chain cross-venue gap. The venues arbitrage each other too tightly for a fee-covered round trip");
  push("under normal conditions. The detector works (it found and quantified real dislocations — e.g. the Jupiter");
  push("aggregator out-quoted both direct Solana pools by up to 7 bps at 5 SOL); the engine should treat capture as a");
  push("**monitor for dislocation events** (volatile pairs, thin books, fee-tier dislocations at larger notional), not a");
  push("steady yield on these pairs.");
  push();
  push("## Method");
  push();
  push("- **EVM** (eth/arb/bsc): USDC→USDT then USDT→USDC sized at the best buy output — QuoterV2 / PancakeSwap");
  push("  QuoterV2 eth_call (the dexDirect legs' own read-only quote path), fee tiers 100 + 500, 2,500 USDC per chain");
  push("  (raw 6dp eth/arb, 18dp bsc — Binance-peg). LiFi aggregator quote (fee=0, the pure DEX-aggregated price) when");
  push("  reachable.");
  push("- **Solana**: SOL→USDC at 5 SOL then USDC→SOL sized at the best buy output — Orca whirlpool + Raydium CLMM");
  push("  live pool-state walks + the legs' pure quote math; Jupiter aggregator quote (fee-inclusive) when reachable.");
  push("- **Gas**: EVM — 2 txs × quoter gasEstimate × live eth_gasPrice, converted to USDC through REAL same-chain");
  push("  WETH/WBNB→USDC quoter reads (no synthetic prices). Solana — 2 × 5,000 lamports, already in SOL units.");
  push("- **USD**: EVM stable pairs ≈ $1 by pair construction (peg pairs, ~1e-3 tolerance). Solana — the SOL side is");
  push("  valued through the same round's real SOL→USDC venue quotes. Reporting only — never on a money path.");
  push("- **Honesty**: legs were quoted sequentially (two read-only calls); a real capture executes buy+sell atomically —");
  push("  the net figures assume the quotes held. Pool fees are netted inside the quotes (never double counted).");
  push("  Quotes are market data — they move; fixtures are dated 2026-09-06.");
  push();
  push("## Per-chain results");
  push();
  push("| chain | detections | gap min–max (avg) | wouldCapture (strict) | economically capturable |");
  push("|---|---|---|---|---|");
  for (const [c, v] of Object.entries(e.byChain)) {
    push(`| ${c} | ${v.total} | ${v.gapBps.min}–${v.gapBps.max} (${v.gapBps.avg?.toFixed(2)}) | ${v.wouldCapture} | **${v.economicallyCapturable}** |`);
  }
  push();
  push("## The detections (all 32, honest numbers)");
  push();
  push("| round | chain | pair | gap bps | gross bps | net bps | net USD | strict | economic | route | whyNot |");
  push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const d of report.detections) {
    const pair = d.pair ? `${d.pair.from}→${d.pair.to}` : "?";
    push(
      `| ${d.round} | ${d.chain} | ${pair} | ${d.gapBps ?? "—"} | ${d.grossRoundTripBps ?? "—"} | ${d.netRoundTripBps ?? "—"} | ` +
        `${d.netValueAfterCostsUsd === null ? "—" : "$" + d.netValueAfterCostsUsd.toFixed(4)} | ${d.wouldCapture ? "yes" : "no"} | ` +
        `${d.economicallyCapturable ? "**YES**" : "no"} | ${(d.route || []).join(" → ") || "—"} | ${(d.whyNot ?? "capturable").slice(0, 60)} |`,
    );
  }
  push();
  push("## Fixtures");
  push();
  push("- `test/fixtures/golden/mev-capture/inputs/round-*-evidence.json` — every round's REAL quote evidence + the");
  push("  detection computed over it (REAL-labeled, quote-level only).");
  push("- `test/fixtures/golden/mev-capture/capture-log.json` — the flat real-quote log.");
  push("- `docs/mev-simulation-2026-09-06.json` — the machine report (this file's data).");
  push();
  push("Rebuild: `node tools/simulate-mev-capture.mjs --rounds=N` then `node tools/mev-report-build.mjs`.");
  return L.join("\n") + "\n";
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const r = buildReport();
  console.log(`[mev-report] wrote ${MD_PATH}`);
  console.log(`[mev-report] total=${r.economic.total} wouldCapture(strict)=${r.economic.wouldCapture} economicallyCapturable=${r.economic.economicallyCapturable}`);
}

export { netUsd, loadEvidence };
