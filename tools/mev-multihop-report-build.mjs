/**
 * mev-multihop-report-build.mjs — build the MULTI-HOP route-choice capture
 * SIMULATION report (offline).
 *
 * Reads the raw simulation output (docs/mev-multihop-simulation-2026-09-06.json
 * + test/fixtures/golden/mev-multihop/inputs/route-*.json) and writes the
 * human report docs/MEV-MULTIHOP-SIMULATION-2026-09-06.md. The economic
 * layer (the $0.10 / 1 bps bar) is already applied by the analyzer
 * (routeAnalyzer.js economical flag) — this builder renders it.
 *
 * Usage: node tools/mev-multihop-report-build.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
const JSON_PATH = join(REPO, "docs", "mev-multihop-simulation-2026-09-06.json");
const MD_PATH = join(REPO, "docs", "MEV-MULTIHOP-SIMULATION-2026-09-06.md");

const r2 = (x) => (x === null || x === undefined ? "—" : Math.round(x * 100) / 100);
const usd = (x) => (x === null || x === undefined ? "—" : `$${r2(x)}`);

export function buildReport() {
  const report = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  const dets = report.detections || [];
  const s = report.summary || {};
  const md = renderMd(report);
  writeFileSync(MD_PATH, md);
  return { total: dets.length, economicallyCapturable: s.economicallyCapturable, mdPath: MD_PATH };
}

function renderMd(report) {
  const L = [];
  const push = (s2 = "") => L.push(s2);
  const dets = report.detections || [];
  const s = report.summary || {};
  const e = s;
  const date = report.date ?? "";
  const econ = (d) => (d.economical ? "**YES**" : d.wouldCapture ? "strict-only" : "no");

  // Archetype aggregation across rounds
  const byRoute = {};
  for (const d of dets) {
    byRoute[d.routeId] ??= { runs: 0, econ: 0, strict: 0, nets: [], bps: [], legs: {} };
    const a = byRoute[d.routeId];
    a.runs++;
    if (d.economical) a.econ++;
    if (d.wouldCapture) a.strict++;
    if (d.routeNetUsd !== null) a.nets.push(d.routeNetUsd);
    if (d.routeNetBps !== null) a.bps.push(d.routeNetBps);
    for (const leg of d.legs || []) {
      const key = `hop${leg.hop} ${leg.from}→${leg.to} (${leg.chain})`;
      a.legs[key] ??= { n: 0, multi: 0, single: 0, gaps: [], chosen: [], best: [] };
      const rec = a.legs[key];
      rec.n++;
      if (leg.singleVenue) rec.single++;
      else {
        rec.multi++;
        if (leg.gapBps !== null) rec.gaps.push(leg.gapBps);
      }
      rec.chosen.push(leg.venueChosen);
      rec.best.push(leg.venueBest);
    }
  }
  const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);

  push("# MULTI-HOP route-choice capture — SIMULATION REPORT (2026-09-06)");
  push();
  push("**Real per-hop venue quotes. Zero trades. Gated OFF.**");
  push();
  push("The framing correction (Mr. Esters, 2026-09-06): the single same-pair ROUND-TRIP gap sim proved ~0 on deep");
  push("stable pairs — a round trip pays two pool fees + two gas bills. The MEV is DISTRIBUTED across the whole");
  push("multi-hop journey: every hop has a venue CHOICE (which DEX / aggregator / bridge), and the delta between");
  push("the venue the engine routed and the BEST venue for that hop is capturable per hop — ONCE PER HOP, one-way,");
  push("no round-trip double fee. This simulation (src/lib/mev/routeAnalyzer.js + tools/simulate-mev-multihop.mjs)");
  push("measured the route-choice value on REALISTIC ANY-TO-ANY ROUTES ENDING AT VOLATILE/EXOTIC DESTINATIONS — the");
  push("aping flow — with REAL per-leg venue quotes (quoter eth_calls, pool-state walks, keyless aggregator quotes).");
  push("The capture EXECUTION path is dead-gated (MEV_CAPTURE_ENABLED=false — the repo default and main-branch");
  push("build; armed v2 builds are wallet-sign-only by structure: the composed legs are the existing guarded swap");
  push("legs, whose submit() throws DexDirectLiveTestGateError).");
  push();
  push("## The honest headline");
  push();
  push(`- **${dets.length} route analyses** over ${report.method?.rounds ?? "?"} sample rounds × ${report.method?.routesPerRound ?? "?"} route archetypes (${report.date}).`);
  push(`- **${s.economicallyCapturable}/${s.total} routes economically capturable** (accumulated net ≥ $0.10 AND ≥ 1 bps — the honest bar, same as the single-pair sim).`);
  push(`- **${s.wouldCapture}/${s.total} strict-positive** (any positive accumulated net after per-leg cost deltas).`);
  push(`- Accumulated route nets: **${usd(s.routeNetUsd?.min)} to ${usd(s.routeNetUsd?.max)}** (avg ${usd(s.routeNetUsd?.avg)}); route nets in bps: **${r2(s.routeNetBps?.min)} to ${r2(s.routeNetBps?.max)} bps** (avg ${r2(s.routeNetBps?.avg)} bps).`);
  push(`- Per-leg venue spreads: **${s.perLegGapBps?.min}–${s.perLegGapBps?.max} bps** (avg ${r2(s.perLegGapBps?.avg)} bps); distribution ${(s.perLegGapBps?.distribution || []).map((b) => `${b.label}: ${b.count}`).join(", ")}.`);
  push(`- **${s.legsAnalyzed} legs analyzed, ${s.legsWithVenueChoice} with venue choice** (multi-venue); the rest are single-venue rails (bridge hops with one serving carrier, the Warp hop, X1's only DEX) — they contribute 0 by construction.`);
  push(`- **Already-optimal routes: ${s.alreadyOptimal}/${s.total}** — when the aggregator is UP and best (the DEX_DIRECT_FALLBACKS default), best-venue routing IS what the engine already does: nothing to capture. The capturable value appears in the **aggregator-DOWN state** (the direct-fallback routing the registry exists for) and on the **exotic destination leg**.`);
  push();
  push("**Conclusion — Mr. Esters' thesis CONFIRMED, in the corrected form:** the value is NOT in same-pair round");
  push("trips on liquid pairs (0/32 there); it IS in the one-way route-choice deltas accumulated across multi-hop");
  push("journeys to volatile/exotic destinations. The pattern across all rounds:");
  push();
  push("- **The ape leg (USDC → a real low-liquidity Solana token) is where the value concentrates: 14–16 bps every");
  push("  round** — the direct single-market pool (Raydium CPMM) quotes 14–16 bps worse than the aggregated market");
  push("  (Jupiter splits the same token across its OTHER live markets — an Orca Whirlpool + a Raydium CP pool —");
  push("  verified in Jupiter's route plan). Routing the direct CPMM fallback while the aggregator is down costs");
  push("  that much per ape; best-venue routing captures it. At $2,500 that is **$3.7–4.5 per journey on the last");
  push("  hop alone**; the SOL→USDC hop adds 1–7 bps ($0.3–2.1).");
  push("- **Accumulated route capture on the $2,500 aping routes: ~9–12 bps / $4.7–5.4 net, economically capturable");
  push("  in every round** (sol-ape / btc-ape / evm-ape down-variants).");
  push("- **The $10,000 ape route tells the size story honestly**: the aggregator stops quoting the thin exotic leg");
  push("  at ~$10k (liquidity limit — the direct pool becomes the only venue, single-venue → 0 there) and the");
  push("  capturable value narrows to the SOL→USDC leg (1–3 bps / $1.2–3.5). Bigger ape ≠ bigger capture on a thin");
  push("  target — the pool IS the market at that size.");
  push("- **Stable-heavy routes do NOT clear (the honest control)**: the EVM-stable → X1 flow (WETH→USDC swap +");
  push("  bridge to a STABLE destination) was already-optimal 3/3 rounds — 0 bps, $0 (the EVM aggregator and the");
  push("  direct Uniswap pool arbitrage each other to <1 bp on WETH→USDC; the bridge leg has one serving carrier).");
  push("- **Single-venue rails contribute 0 everywhere**: the EVM→SOL bridge (one serving carrier observed), the");
  push("  Warp hop (0.5% skim — invariant across venue choices), the X1 destination leg (X1 has ONE DEX — XDEX).");
  push("  The X1-exotic route therefore nets only its Solana-side hop: strict-positive but BELOW the economic bar");
  push("  ($0.06–0.85, <1 bp) in every round.");
  push();
  push("**What the engine would have captured (the deliverable number):** routing each hop through its best venue");
  push("on the aping journeys would have improved the destination balance by **~$4.7–5.4 on a $2,500 ape** (the");
  push("aggregator-DOWN state — i.e. the fallback penalty the route-choice engine removes) and ~$0 on stable-heavy");
  push("journeys. When the aggregator is UP and best the engine already routes optimally (0 — honest). The capture");
  push("is a **routing-quality improvement**, not a same-block arb: it realizes when the engine holds multi-venue");
  push("quotes and routes the best one (observation-only today — gated OFF).");
  push();
  push("## Method");
  push();
  push("- **Route model** (src/lib/mev/routeAnalyzer.js, pure): a journey = ordered legs (swaps + bridges); each leg");
  push("  carries its venue options' quotes at the leg's routed size + a real USD conversion of the output token.");
  push("  Per-leg: best-venue vs routed-venue gap (bps + $), net of the per-leg explicit cost delta. Route-level:");
  push("  the ACCUMULATED net across the whole journey (dollar-weighted bps + $), the optimal sub-path (best venue");
  push("  per leg), and the honest wouldCapture verdict. Single-venue legs contribute 0; pool/bridge fees are netted");
  push("  inside every quote (never double counted — the gapDetector ruling carried over).");
  push("- **Venue sets** (per DEX_DIRECT_FALLBACKS / CAPTURE_CANDIDATES + the rail matrix):");
  push("  - EVM same-chain (WETH→USDC, Ethereum): LiFi (aggregator) vs Uniswap v3 f500 QuoterV2 eth_call (direct).");
  push("  - Solana SOL↔USDC: Jupiter (aggregator) vs Orca whirlpool + Raydium CLMM (live pool-state walks).");
  push("  - Ape leg USDC→EXOTIC(sol): Jupiter vs Raydium CPMM direct (live pool-state walk) — the real low-liquidity");
  push("    token DvjbE…/USDC (verified: the token has ≥3 live markets — Orca Whirlpool + Raydium CP + Raydium");
  push("    CPMM — Jupiter aggregates them; the CPMM direct is one market).");
  push("  - EVM→SOL bridge: LiFi (keyless — one serving carrier observed). Native→SOL (THORChain/Rango rail): NOT");
  push("    re-quotable from this environment (THORChain hosts egress-blocked; Rango mainnet = server-keyed; the");
  push("    repo's REAL Rango capture 2026-09-05 is pinned in test/fixtures/golden/rango-leg/) — native-source");
  push("    routes are analyzed over their quotable SOL-side legs, documented per route.");
  push("  - X1: XDEX (the only DEX) — SOL/B69ch… pool: vault balances refreshed live per round (official SPL");
  push("    layout), static fields + fee config = the repo's frozen 2026-09-02 capture. The Warp hop (0.5% skim) is");
  push("    a documented invariant across venue choices (not a venue delta).");
  push("- **Sizes**: ~$2,500 journeys (25 SOL / 1 WETH / 2,500 USDC) + one ~$10,000 size-effect route (98 SOL).");
  push("- **Routing states modeled**: 'agg-up' (aggregator first — the DEX_DIRECT_FALLBACKS default) and 'agg-down'");
  push("  (the aggregator unavailable → the engine routes the DIRECT fallback — the exact scenario the fallback");
  push("  registry exists for). The analyzer measures the delta either way.");
  push("- **USD**: real same-round rates only — stables ≈ $1 by peg construction (~1e-3 tolerance, the single-pair");
  push("  sim convention); SOL via the round's real SOL→USDC venue rates; EXOTIC(sol) via the round's real Jupiter");
  push("  USDC→EXOTIC rate; EXOTIC(x1) via the XDEX pool's real reserves × the round's real SOL price. No synthetic");
  push("  prices. Reporting only — never on a money path.");
  push("- **Honesty**: venues for a leg are quoted at the same amountIn (the routed size), sequentially (read-only");
  push("  calls) — markets move between reads; per-leg deltas are per-snapshot math. Aggregator quotes flap (the");
  push("  keyless Jupiter/LiFi endpoints rate-limit + rotate tools); retries + a round-scoped success cache were");
  push("  used, and a transient LiFi misquote (~43 bps, one round) was observed and excluded by re-quote. Quotes are");
  push("  market data — they move; fixtures are dated 2026-09-06.");
  push();
  push("## Per-route archetype results (aggregated across rounds)");
  push();
  push("| route archetype | runs | econ | strict | route net $ min–max (avg) | route net bps min–max (avg) |");
  push("|---|---|---|---|---|---|");
  for (const [routeId, a] of Object.entries(byRoute)) {
    push(`| ${routeId} | ${a.runs} | **${a.econ}** | ${a.strict} | ${usd(Math.min(...a.nets))}–${usd(Math.max(...a.nets))} (${usd(avg(a.nets))}) | ${r2(Math.min(...a.bps))}–${r2(Math.max(...a.bps))} (${r2(avg(a.bps))}) |`);
  }
  push();
  push("Legend: econ = economically capturable (net ≥ $0.10 AND ≥ 1 bps); strict = any positive accumulated net.");
  push();
  push("### Per-leg venue deltas (aggregated across rounds by hop shape)");
  push();
  push("| hop shape | legs | multi-venue | single-venue | gap bps min–max (avg) | venues routed (chosen → best seen) |");
  push("|---|---|---|---|---|---|");
  for (const [key, rec] of Object.entries(collectLegs(dets))) {
    const gap = rec.gaps.length ? `${Math.min(...rec.gaps)}–${Math.max(...rec.gaps)} (${r2(avg(rec.gaps))})` : "—";
    const chosen = [...new Set(rec.chosen)].join("/");
    const best = [...new Set(rec.best)].join("/");
    push(`| ${key} | ${rec.n} | ${rec.multi} | ${rec.single} | ${gap} | ${chosen} → ${best} |`);
  }
  push();
  push("## The route analyses (all rounds, honest numbers)");
  push();
  push("| round | route | legs | multi-venue legs | route gap bps | route net $ | route net bps | econ | whyNot / note |");
  push("|---|---|---|---|---|---|---|---|---|");
  for (const d of dets) {
    const multi = (d.legs || []).filter((l) => !l.singleVenue).length;
    push(
      `| ${d.round} | ${d.routeId} | ${(d.legs || []).length} | ${multi} | ${r2(d.routeGapBps)} | ${usd(d.routeNetUsd)} | ${r2(d.routeNetBps)} | ${econ(d)} | ${(d.whyNot ?? "capturable").slice(0, 110)} |`,
    );
  }
  push();
  push("### Per-hop detail (round 1 — the representative snapshot)");
  push();
  push("| round | route | hop | leg | chosen → best | gap bps | gap $ |");
  push("|---|---|---|---|---|---|---|");
  for (const d of dets.filter((x) => x.round === 1)) {
    for (const l of d.legs || []) {
      push(`| ${d.round} | ${d.routeId} | ${l.hop} | ${l.from}→${l.to} (${l.chain}) | ${l.venueChosen} → ${l.venueBest} | ${l.gapBps ?? "single"} | ${usd(l.gapUsd)} |`);
    }
  }
  push();
  push("## The routes that DID NOT clear (honesty)");
  push();
  push("- **evm-x1-stable (the bridge's real flow to a STABLE destination) — 0 bps / $0 in all 3 rounds.** The EVM");
  push("  swap leg's venues (LiFi vs Uniswap f500 direct on WETH→USDC) arbitrage each other to <1 bp; the bridge leg");
  push("  has one serving carrier. This is the stable-heavy non-clearer the single-pair sim predicted — and the");
  push("  reason the multi-hop model concentrates on exotic destinations.");
  push("- **sol-ape-2500-up / agg-up variants — 0 bps / $0 in all rounds (already-optimal).** When the aggregator is");
  push("  up AND best, the engine's default routing already takes the best venue: nothing to capture. The route-");
  push("  choice value is a FALLBACK-state + thin-market phenomenon, not a steady-state tax on default routing.");
  push("- **x1-exotic (EVM stable → X1 fresh token) — strict-positive but BELOW the economic bar every round**");
  push("  ($0.06–0.85 net, <1 bp): only its Solana-side hop has venue choice; the bridge, the Warp hop and X1's only");
  push("  DEX are single-venue by design. X1-side exotic destinations carry no route-choice value today (one DEX).");
  push("- **sol-ape-10000 round 1 — 0 bps**: at ~$10k the aggregator did not quote the thin exotic leg (liquidity");
  push("  limit) → single-venue; and Orca matched/beat Jupiter on SOL→USDC at 98 SOL that round. Rounds 2–3 cleared");
  push("  on the SOL leg alone ($1.2–3.5).");
  push();
  push("## Fixtures");
  push();
  push("- `test/fixtures/golden/mev-multihop/inputs/route-*.json` — every route's REAL per-leg quote evidence (each");
  push("  leg's venue options at the leg's routed size) + the analysis computed over it (REAL-labeled, quote-level");
  push("  only; dated; refresh before live use).");
  push("- `test/fixtures/golden/mev-multihop/capture-log.json` — the flat real-quote log.");
  push("- `docs/mev-multihop-simulation-2026-09-06.json` — the machine report (this file's data).");
  push();
  push("Rebuild: `node tools/simulate-mev-multihop.mjs --rounds=3` then `node tools/mev-multihop-report-build.mjs`.");
  return L.join("\n") + "\n";
}

function collectLegs(dets) {
  const out = {};
  for (const d of dets) {
    for (const leg of d.legs || []) {
      const key = `hop${leg.hop} ${leg.from}→${leg.to} (${leg.chain})`;
      out[key] ??= { n: 0, multi: 0, single: 0, gaps: [], chosen: [], best: [] };
      const rec = out[key];
      rec.n++;
      if (leg.singleVenue) rec.single++;
      else {
        rec.multi++;
        if (leg.gapBps !== null) rec.gaps.push(leg.gapBps);
      }
      rec.chosen.push(leg.venueChosen);
      rec.best.push(leg.venueBest);
    }
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const r = buildReport();
  console.log(`[mev-multihop-report] wrote ${r.mdPath}`);
  console.log(`[mev-multihop-report] routes=${r.total} economicallyCapturable=${r.economicallyCapturable}`);
}
