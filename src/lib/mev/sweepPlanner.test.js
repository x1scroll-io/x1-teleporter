/**
 * sweepPlanner.test.js — the MEV BATCH-SWEEP PLANNER tests (pure plans;
 * NO execution — the deposit-only treasury design's sweep layer).
 *
 * Spec coverage:
 *   • basketTargetsForChain: representable vs unavailable per chain (the
 *     full basket on sol/x1, the representable slice on EVM, none on rbn),
 *     order follows the config basket,
 *   • isAlreadyBasketToken / convertAnchor (USDC sink default),
 *   • defaultSweepPeriod: daily/weekly windows + validation,
 *   • planChainSweep (per-chain shape — DEFAULT consolidation): empty pile
 *     → honest no-op; pile → keep steps (already-basket) + convert steps
 *     (descriptors of the EXISTING engine legs), ONE gas payment,
 *     destination = the chain treasury, gate carried, executable FALSE,
 *     signable artifacts empty, broadcast never; unconfigured chain throws,
 *   • planSweeps: the batch bundle across every chain with a pile,
 *   • planHubSweep (solana-hub shape — the DEFERRED consolidation choice):
 *     per-chain bridge steps (sol skipped — it IS the hub) + hub-side
 *     conversion to the full basket; destination = the sol treasury,
 *   • every plan: deposit-only boundary + no-execution discipline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  basketTargetsForChain,
  isAlreadyBasketToken,
  convertAnchor,
  defaultSweepPeriod,
  planChainSweep,
  planSweeps,
  planHubSweep,
  swapLegHint,
  SWEEP_PLAN_NO_EXECUTION_NOTE,
  SWEEP_GAS_ONCE_NOTE,
} from "./sweepPlanner.js";
import { DEFAULT_MEV_PAYOUT_CONFIG, treasuryForChain, resolvePayoutConfig } from "./payoutConfig.js";
import { emptyLedger, recordCaptures } from "./captureLedger.js";

const SVM_TREASURY = treasuryForChain(DEFAULT_MEV_PAYOUT_CONFIG, "sol");
const EVM_TREASURY = treasuryForChain(DEFAULT_MEV_PAYOUT_CONFIG, "eth");

function solLedger() {
  let st = emptyLedger();
  // timestamps RELATIVE to now — the default sweep window (daily, ending now)
  // must always cover the fixture captures (hardcoded dates go stale as
  // wall-clock advances and silently empty the pile: the 2026-09-08 break).
  const now = Date.now();
  const ago = (mins) => new Date(now - mins * 60 * 1000).toISOString();
  ({ state: st } = recordCaptures(st, [
    { chain: "sol", token: "USDC", amountRaw: "5000000000", capturedAt: ago(120) },
    { chain: "sol", token: "EXOTIC", amountRaw: "1234567890", capturedAt: ago(90), source: "simulated", simulated: true, test: true },
    { chain: "eth", token: "MEME", amountRaw: "999", capturedAt: ago(60), source: "simulated", simulated: true },
  ]));
  return st;
}

test("sweep planner: basketTargetsForChain — full basket on sol/x1, representable slice on EVM, none on rbn", () => {
  const sol = basketTargetsForChain(DEFAULT_MEV_PAYOUT_CONFIG, "sol");
  assert.deepEqual(sol.representable.map((r) => `${r.member}→${r.canonicalSymbol}`), ["SOL→WSOL", "wBTC→cbBTC", "wETH→ETH", "USDC→USDC"]);
  assert.deepEqual(sol.unavailable, []);

  const x1 = basketTargetsForChain(DEFAULT_MEV_PAYOUT_CONFIG, "x1");
  assert.deepEqual(x1.representable.map((r) => `${r.member}→${r.canonicalSymbol}`), ["SOL→wSOL.X", "wBTC→cbBTC.X", "wETH→ETH.X", "USDC→USDC.x"]);

  const eth = basketTargetsForChain(DEFAULT_MEV_PAYOUT_CONFIG, "eth");
  assert.deepEqual(eth.representable.map((r) => r.member), ["wETH", "USDC"]);
  assert.deepEqual(eth.unavailable.map((u) => u.member), ["SOL", "wBTC"], "SOL/wBTC have no canonical EVM entry today — honestly unavailable");
  assert.match(eth.unavailable[0].reason, /Solana hub/);

  const rbn = basketTargetsForChain(DEFAULT_MEV_PAYOUT_CONFIG, "rbn");
  assert.deepEqual(rbn.representable, []);
  assert.deepEqual(rbn.unavailable.map((u) => u.member), ["SOL", "wBTC", "wETH", "USDC"]);
});

test("sweep planner: isAlreadyBasketToken + convertAnchor are deterministic", () => {
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "sol", "USDC"), true, "canonical symbol");
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "sol", "WSOL"), true, "SOL's canonical wrap");
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "sol", "SOL"), true, "member shorthand (native)");
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "sol", "cbBTC"), true);
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "sol", "EXOTIC"), false);
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "x1", "USDC.x"), true);
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "x1", "USDC"), true, "member shorthand matches too — a capture labeled with the basket concept keeps (its canonical X1 form is USDC.x)");
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "x1", "cbBTC.X"), true);
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "eth", "ETH"), true, "native ETH is the wETH basket representation on EVM");
  assert.equal(isAlreadyBasketToken(DEFAULT_MEV_PAYOUT_CONFIG, "eth", "cbBTC"), false, "cbBTC has no canonical EVM entry today");
  // the anchor prefers USDC (the deepest-liquidity stable sink)
  assert.equal(convertAnchor(DEFAULT_MEV_PAYOUT_CONFIG, "sol").member, "USDC");
  assert.equal(convertAnchor(DEFAULT_MEV_PAYOUT_CONFIG, "eth").member, "USDC");
  assert.equal(convertAnchor(DEFAULT_MEV_PAYOUT_CONFIG, "rbn"), null, "no representable member → no anchor");
});

test("sweep planner: defaultSweepPeriod — daily/weekly windows + validation", () => {
  const now = "2026-09-07T12:00:00.000Z";
  const daily = defaultSweepPeriod("daily", now);
  assert.equal(daily.since, "2026-09-06T12:00:00.000Z");
  assert.equal(daily.until, "2026-09-07T12:00:00.000Z");
  const weekly = defaultSweepPeriod("weekly", now);
  assert.equal(weekly.since, "2026-08-31T12:00:00.000Z");
  assert.equal(weekly.until, "2026-09-07T12:00:00.000Z");
  assert.throws(() => defaultSweepPeriod("monthly"), /daily \| weekly/);
});

test("sweep planner: planChainSweep — empty pile → honest no-op plan (no fake sweep)", () => {
  const plan = planChainSweep({ ledgerState: emptyLedger(), chain: "sol" });
  assert.equal(plan.kind, "batch-sweep-plan");
  assert.equal(plan.consolidation, "per-chain");
  assert.equal(plan.chain, "sol");
  assert.equal(plan.wouldSweep, false);
  assert.match(plan.whyNot, /no-accumulated-captures/);
  assert.equal(plan.executable, false);
  assert.equal(plan.signableArtifacts.length, 0);
  assert.equal(plan.gate.enabled, false, "the plan carries the gate state — gated OFF by default");
  assert.equal(plan.gate.executable, false);
  assert.equal(plan.treasury, SVM_TREASURY);
});

test("sweep planner: planChainSweep — keep steps for already-basket captures, convert steps (existing-leg descriptors) for the rest", () => {
  const plan = planChainSweep({ ledgerState: solLedger(), chain: "sol" });
  assert.equal(plan.wouldSweep, true);
  assert.equal(plan.chain, "sol");
  assert.equal(plan.frequency, "daily");
  assert.deepEqual(plan.pile.map((p) => p.token), ["USDC", "EXOTIC"], "pile rows in amount order (USDC 5e9 > EXOTIC 1234567890)");
  assert.equal(plan.steps.length, 2);
  const keep = plan.steps.find((s) => s.action === "keep");
  const convert = plan.steps.find((s) => s.action === "convert");
  assert.equal(keep.from.token, "USDC");
  assert.equal(keep.to.canonicalSymbol, "USDC");
  assert.equal(keep.via, null, "already-basket needs no conversion leg");
  assert.equal(convert.from.token, "EXOTIC");
  assert.equal(convert.from.amountRaw, "1234567890");
  assert.equal(convert.to.member, "USDC", "the batch anchor");
  assert.equal(convert.to.canonicalSymbol, "USDC");
  assert.match(convert.via.legFamily, /existing-engine-swap-legs/);
  assert.ok(convert.via.constructors.includes("jupiter"), "the leg hint names the engine's existing constructors");
  assert.match(convert.via.note, /DexDirectLiveTestGateError/);
  // the ONE gas payment (amortized — the point of the batch)
  assert.equal(plan.gas.paidOnce, true);
  assert.equal(plan.gas.chain, "sol");
  assert.match(plan.gas.note, /ONE gas payment/);
  assert.match(SWEEP_GAS_ONCE_NOTE, /amortized/);
  // destination = the per-chain treasury, deposit-only
  assert.equal(plan.destination.shape, "per-chain-treasury");
  assert.equal(plan.destination.address, SVM_TREASURY);
  assert.equal(plan.destination.depositOnly, true);
  // no-execution discipline
  assert.equal(plan.executable, false);
  assert.equal(plan.signableArtifacts.length, 0);
  assert.equal(plan.broadcast, "never (signable artifacts only — Mr. Esters' arm)");
  assert.match(plan.note, /PLAN ONLY/);
  assert.match(SWEEP_PLAN_NO_EXECUTION_NOTE, /no autonomous broadcast/);
});

test("sweep planner: planChainSweep — the EVM shape reports the unavailable basket slice honestly", () => {
  const plan = planChainSweep({ ledgerState: solLedger(), chain: "eth" });
  assert.equal(plan.wouldSweep, true);
  assert.deepEqual(plan.pile.map((p) => p.token), ["MEME"]);
  assert.deepEqual(plan.basket.unavailable.map((u) => u.member), ["SOL", "wBTC"]);
  assert.equal(plan.steps[0].to.member, "USDC");
  assert.equal(plan.destination.address, EVM_TREASURY);
  assert.equal(plan.gas.token, "ETH");
});

test("sweep planner: planChainSweep fails closed on an unconfigured chain (a sweep to nowhere is a config hole)", () => {
  assert.throws(() => planChainSweep({ ledgerState: solLedger(), chain: "avax" }), /no configured treasury/);
});

test("sweep planner: planSweeps — the batch bundle covers every configured chain with a pile", () => {
  const bundle = planSweeps({ ledgerState: solLedger() });
  assert.equal(bundle.kind, "batch-sweep-bundle");
  assert.equal(bundle.consolidation, "per-chain", "per-chain is the DEFAULT consolidation");
  assert.equal(bundle.frequency, "daily");
  assert.deepEqual(bundle.chains, ["eth", "sol"], "only chains with a pile get a plan");
  assert.equal(bundle.plans.length, 2);
  for (const p of bundle.plans) {
    assert.equal(p.executable, false);
    assert.equal(p.gate.enabled, false);
  }
  assert.equal(bundle.executable, false);
});

test("sweep planner: planHubSweep — the DEFERRED solana-hub consolidation shape (bridge + hub-side basket conversion)", () => {
  const hub = planHubSweep({ ledgerState: solLedger() });
  assert.equal(hub.kind, "batch-sweep-plan");
  assert.equal(hub.consolidation, "solana-hub");
  assert.equal(hub.wouldSweep, true);
  assert.equal(hub.hub.chain, "sol");
  assert.equal(hub.hub.treasury, SVM_TREASURY);
  assert.deepEqual(hub.hub.basket.map((r) => `${r.member}→${r.canonicalSymbol}`), ["SOL→WSOL", "wBTC→cbBTC", "wETH→ETH", "USDC→USDC"]);
  // eth's pile bridges to the hub; sol's pile stays (it IS the hub)
  assert.deepEqual(hub.perChain.map((c) => c.chain), ["eth"]);
  assert.equal(hub.perChain[0].step.action, "bridge");
  assert.equal(hub.perChain[0].step.via.lane, "eth → sol");
  assert.match(hub.perChain[0].step.via.note, /DEFERRED/);
  assert.equal(hub.perChain[0].gas.paidOnce, true);
  // hub-side conversion of the non-basket pile (MEME from eth + EXOTIC from sol)
  assert.deepEqual(hub.hubSteps.map((s) => s.from.token).sort(), ["EXOTIC", "MEME"]);
  for (const s of hub.hubSteps) {
    assert.equal(s.action, "convert");
    assert.equal(s.where, "solana-hub");
    assert.equal(s.to.member, "USDC");
  }
  assert.equal(hub.destination.shape, "solana-hub");
  assert.equal(hub.destination.address, SVM_TREASURY);
  assert.equal(hub.destination.depositOnly, true);
  assert.equal(hub.executable, false);
  assert.equal(hub.signableArtifacts.length, 0);
  assert.match(hub.note, /DEFAULT consolidation is per-chain/);
  // an empty ledger → no-op hub plan
  const empty = planHubSweep({ ledgerState: emptyLedger() });
  assert.equal(empty.wouldSweep, false);
});

test("sweep planner: swapLegHint names the existing engine leg families per chain family", () => {
  const sol = swapLegHint("sol");
  assert.ok(sol.families.includes("jupiter"));
  assert.deepEqual(sol.dexDirect, ["raydium", "orca"]);
  const bsc = swapLegHint("bsc");
  assert.ok(bsc.families.includes("lifi"));
  assert.deepEqual(bsc.dexDirect, ["pancakeswap"]);
  const eth = swapLegHint("eth");
  assert.deepEqual(eth.dexDirect, ["uniswap"]);
});

test("sweep planner: the config frequency drives the sweep window (weekly override honored)", () => {
  const cfg = resolvePayoutConfig({ sweepFrequency: "weekly" });
  const plan = planChainSweep({ ledgerState: solLedger(), chain: "sol", config: cfg });
  assert.equal(plan.frequency, "weekly");
  const windowMs = Date.parse(plan.period.until) - Date.parse(plan.period.since);
  assert.equal(windowMs, 7 * 24 * 60 * 60 * 1000, "a weekly plan covers a 7-day window");
});
