/**
 * sweepPlanner.js — the BATCH-SWEEP PLANNER (pure).
 *
 * Mr. Esters' treasury design (docs/MEV-PAYOUT.md), sweep layer: captures
 * accumulate per-chain as drop-as-is deposits (captureLedger.js); ONCE per
 * batch (daily/weekly — configurable, NOT per-trade) ONE batched op per
 * chain converts the accumulated pile → the SOL/wBTC/wETH/USDC basket.
 * Gas is paid ONCE per batch (amortized across the pile — this is what
 * makes small captures profitable).
 *
 * THIS MODULE PRODUCES THE PLAN. It is pure: ledger state + config in, a
 * signable-artifact plan out. NO execution — the plan carries
 * executable:false, the capture gate state, and its conversion legs are
 * DESCRIPTORS of the repo's existing engine legs (the dexDirect /
 * aggregator / bridge constructors the routing layer already composes —
 * planCaptureSide / composeRoute in src/engine/routePlanner.js). At arm
 * time the executor builds those legs through the official-SDK leg
 * constructors; every one of those legs' submit() throws
 * DexDirectLiveTestGateError — no autonomous broadcast exists at any flag
 * value. The live arm is Mr. Esters' alone.
 *
 * ── THE TWO CONSOLIDATION SHAPES ─────────────────────────────────────────
 *   1. per-chain (DEFAULT — planChainSweep / planSweeps): each chain's pile
 *      converts IN PLACE to the basket members representable on that chain
 *      (BASKET_TARGETS in payoutConfig.js) and stays in that chain's
 *      treasury. Members with no canonical asset on the chain (e.g. SOL on
 *      an EVM chain today) are reported unavailable.
 *   2. solana-hub (planHubSweep — Mr. Esters' deferred consolidation
 *      choice): each chain's pile bridges to the Solana hub (our own
 *      bridge — the engine's warp-leg family) and converts to the FULL
 *      basket there (sol represents all four members). Built as a plan
 *      shape; the DEFAULT stays per-chain until Mr. Esters decides.
 *
 * All amounts are RAW base units (integer strings); sums are exact BigInt.
 * No USD enters the pure plan (rates are arm-time quote inputs) — the plan
 * is the WHAT/WHERE, the executor's real quotes are the HOW-MUCH-OUT.
 */

import {
  DEFAULT_MEV_PAYOUT_CONFIG,
  treasuryForChain,
  configuredChains,
  BASKET_TARGETS,
  MEV_SWEEP_FREQUENCIES,
  MEV_SWEEP_FREQUENCY_DEFAULT,
  MEV_PAYOUT_DEPOSIT_ONLY_NOTE,
} from "./payoutConfig.js";
import { accumulatePile, summarizeLedger, CAPTURE_LEDGER_PERSISTENCE_NOTE } from "./captureLedger.js";
import { captureGate } from "./captureGate.js";

/** The no-execution note every plan carries. */
export const SWEEP_PLAN_NO_EXECUTION_NOTE =
  "PLAN ONLY — no execution: the plan is a signable-artifact blueprint. Conversion/bridge legs are " +
  "descriptors of the repo's existing engine legs (dexDirect / aggregator / warp-bridge constructors); " +
  "built at arm time via the official-SDK leg constructors, whose submit() throws DexDirectLiveTestGateError " +
  "(no autonomous broadcast at any flag value). The live arm is Mr. Esters' alone.";

/** The gas-once note (the amortization point of the batched sweep). */
export const SWEEP_GAS_ONCE_NOTE =
  "ONE gas payment per batch per chain — amortized across the whole pile (the economic point of the " +
  "batched sweep: per-trade sends would make small captures unprofitable; one batched conversion does not).";

/** The native gas token per chain (report context). */
export const CHAIN_NATIVE_GAS = Object.freeze({
  eth: "ETH", arb: "ETH", opt: "ETH", bas: "ETH", bsc: "BNB", pol: "POL",
  avax: "AVAX", sonic: "S", rbn: "ETH", sol: "SOL", x1: "XNT",
});

/** The swap-leg family hint per chain (which existing engine legs compose
 *  the conversion at arm time — the repo's DEX_DIRECT_FALLBACKS order). */
export function swapLegHint(chain) {
  const family =
    chain === "sol" || chain === "x1"
      ? { families: ["jupiter", "xdex", "dexDirect"], dexDirect: chain === "sol" ? ["raydium", "orca"] : ["xdex"], note: "SVM chain — jupiter/xdex/dexDirect (raydium/orca on sol; the xdex rail on x1)" }
      : { families: ["lifi", "dexDirect"], dexDirect: chain === "bsc" ? ["pancakeswap"] : ["uniswap"], note: "EVM chain — lifi aggregator + dexDirect (uniswap v3; pancakeswap v3 on bsc)" };
  return family;
}

/**
 * basketTargetsForChain — the representable basket on a chain.
 * @param {object} config payout config
 * @param {string} chain canonical chain key
 * @returns {{representable: Array<{member, canonicalSymbol}>, unavailable:
 *   Array<{member, reason}>}} in config basket order
 */
export function basketTargetsForChain(config, chain) {
  const table = BASKET_TARGETS[chain] ?? {};
  const representable = [];
  const unavailable = [];
  for (const member of config.sweep.basket) {
    const canonical = table[member];
    if (canonical) {
      representable.push({ member, canonicalSymbol: canonical });
    } else {
      unavailable.push({
        member,
        reason: `no canonical ${member} asset on ${chain} (tokenResolver ground truth) — this slice converts on the Solana hub via the hub-consolidation shape, or waits for rails`,
      });
    }
  }
  return { representable, unavailable };
}

/** True when a pile token is already a basket asset on the chain (it matches
 *  a representable member's canonical symbol OR the member shorthand — e.g.
 *  "USDC" on sol, "SOL"/"WSOL" on sol, "USDC.x" on x1). */
export function isAlreadyBasketToken(config, chain, token) {
  const { representable } = basketTargetsForChain(config, chain);
  return representable.some((r) => r.canonicalSymbol === token || r.member === token);
}

/** The batch conversion anchor: USDC when representable (the deepest-
 *  liquidity stable sink), else the first representable member. Deterministic
 *  pure default — the executor may split across `alternateTargets` at arm
 *  time once real quotes are on the wire. */
export function convertAnchor(config, chain) {
  const { representable } = basketTargetsForChain(config, chain);
  if (representable.length === 0) return null;
  const usdc = representable.find((r) => r.member === "USDC");
  return usdc ?? representable[0];
}

/**
 * defaultSweepPeriod — the pure window for a frequency.
 * @param {string} frequency "daily" | "weekly"
 * @param {string|Date} [now] reference time (default now)
 * @returns {{since: string, until: string, frequency: string}} ISO bounds
 */
export function defaultSweepPeriod(frequency = MEV_SWEEP_FREQUENCY_DEFAULT, now = null) {
  if (!MEV_SWEEP_FREQUENCIES.includes(frequency)) {
    throw new Error(`sweepPlanner: frequency must be one of ${MEV_SWEEP_FREQUENCIES.join(" | ")} (got "${frequency}")`);
  }
  const until = new Date(now ?? Date.now());
  const since = new Date(until.getTime() - (frequency === "weekly" ? 7 : 1) * 24 * 60 * 60 * 1000);
  return { since: since.toISOString(), until: until.toISOString(), frequency };
}

/**
 * planChainSweep — the per-chain batch-sweep plan (the DEFAULT
 * consolidation shape). Given a chain's accumulated ledger pile over a
 * period, produce the batched conversion plan: pile per token, keep vs
 * convert steps (via the existing engine legs — descriptors only), the ONE
 * gas payment, and the per-chain treasury destination. NO execution.
 *
 * @param {object} args
 * @param {object} args.ledgerState a captureLedger state
 * @param {string} args.chain canonical chain key (must be in the config)
 * @param {object} [args.config] payout config
 * @param {object} [args.period] { since, until } ISO (default: the
 *   config-frequency window via defaultSweepPeriod)
 * @returns {object} the frozen per-chain sweep plan
 * @throws when the chain has no configured treasury (a sweep to nowhere is
 *   a config hole — fail closed)
 */
export function planChainSweep({ ledgerState, chain, config = DEFAULT_MEV_PAYOUT_CONFIG, period = null } = {}) {
  if (!chain) throw new Error("sweepPlanner.planChainSweep: chain is required");
  const treasury = treasuryForChain(config, chain);
  if (!treasury) {
    throw new Error(
      `sweepPlanner.planChainSweep: chain "${chain}" has no configured treasury in the payout config — add it ` +
      "(MEV_PAYOUT_GROUPS_DEFAULT or an override) before a sweep can be planned there",
    );
  }
  const window = period ?? defaultSweepPeriod(config.sweep.frequency);
  const { since, until } = window;
  const pile = accumulatePile(ledgerState, { chain, since, until });
  const { representable, unavailable } = basketTargetsForChain(config, chain);
  const gate = captureGate();

  if (pile.length === 0) {
    return Object.freeze({
      id: `sweep-plan-${chain}-${since.slice(0, 10)}-${until.slice(0, 10)}`,
      kind: "batch-sweep-plan",
      consolidation: "per-chain",
      chain,
      frequency: config.sweep.frequency,
      period: Object.freeze({ since, until }),
      wouldSweep: false,
      whyNot: "no-accumulated-captures: the ledger has no capture records for this chain in the period — nothing to batch-convert",
      treasury,
      gate: Object.freeze({ ...gate }),
      executable: false,
      signableArtifacts: Object.freeze([]),
      note: SWEEP_PLAN_NO_EXECUTION_NOTE,
    });
  }

  const steps = [];
  const keep = [];
  const convert = [];
  const anchor = convertAnchor(config, chain);
  let stepNo = 0;
  for (const row of pile) {
    if (isAlreadyBasketToken(config, chain, row.token)) {
      stepNo += 1;
      keep.push(
        Object.freeze({
          step: stepNo,
          action: "keep",
          from: Object.freeze({ token: row.token, amountRaw: row.amountRaw, recordCount: row.recordCount }),
          to: Object.freeze({ member: row.token, canonicalSymbol: row.token, note: "already a basket asset on this chain — stays in the treasury pile as-is" }),
          via: null,
          note: "no conversion needed (already-basket capture)",
        }),
      );
    } else {
      stepNo += 1;
      const hint = swapLegHint(chain);
      convert.push(
        Object.freeze({
          step: stepNo,
          action: "convert",
          from: Object.freeze({ token: row.token, amountRaw: row.amountRaw, recordCount: row.recordCount }),
          to: Object.freeze({
            member: anchor ? anchor.member : null,
            canonicalSymbol: anchor ? anchor.canonicalSymbol : null,
            note: anchor
              ? `the batch anchor (${anchor.member} → ${anchor.canonicalSymbol}); the executor may split across the alternate targets ${representable.filter((r) => r !== anchor).map((r) => `${r.member} (${r.canonicalSymbol})`).join(", ") || "(none)"} once real quotes are on the wire`
              : "no representable basket member on this chain — this token rides the hub-consolidation shape",
          }),
          via: Object.freeze({
            legFamily: "existing-engine-swap-legs",
            constructors: hint.families,
            dexDirect: hint.dexDirect,
            note: `descriptor only — built at arm time via the repo's leg constructors (${hint.families.join(" / ")}) with the official SDKs; submit() throws DexDirectLiveTestGateError`,
          }),
          note: `batch-convert ${row.amountRaw} raw ${row.token} → the basket (${anchor ? `${anchor.member} (${anchor.canonicalSymbol})` : "hub"})`,
        }),
      );
    }
  }
  steps.push(...keep, ...convert);

  const destination = Object.freeze({
    shape: "per-chain-treasury",
    consolidation: "per-chain",
    chain,
    address: treasury,
    depositOnly: true,
    note: MEV_PAYOUT_DEPOSIT_ONLY_NOTE,
  });

  return Object.freeze({
    id: `sweep-plan-${chain}-${since.slice(0, 10)}-${until.slice(0, 10)}`,
    kind: "batch-sweep-plan",
    consolidation: "per-chain",
    chain,
    frequency: config.sweep.frequency,
    period: Object.freeze({ since, until }),
    wouldSweep: true,
    treasury,
    basket: Object.freeze({
      members: Object.freeze([...config.sweep.basket]),
      representable: Object.freeze(representable),
      unavailable: Object.freeze(unavailable),
      note: "members with no canonical asset on this chain convert on the Solana hub (hub-consolidation shape) or wait for rails",
    }),
    pile: Object.freeze(pile),
    steps: Object.freeze(steps),
    gas: Object.freeze({
      paidOnce: true,
      perBatch: "one gas payment per chain per batch — amortized across the pile",
      chain,
      token: CHAIN_NATIVE_GAS[chain] ?? "chain native",
      note: SWEEP_GAS_ONCE_NOTE,
    }),
    destination,
    gate: Object.freeze({ ...gate }),
    executable: false,
    signableArtifacts: Object.freeze([]),
    broadcast: "never (signable artifacts only — Mr. Esters' arm)",
    note: SWEEP_PLAN_NO_EXECUTION_NOTE,
  });
}

/**
 * planSweeps — the batch orchestration: one per-chain plan for every
 * configured chain with a non-empty period pile (default per-chain
 * consolidation — Mr. Esters' DEFAULT; the consolidation decision stays
 * deferred).
 * @returns {{plans: object[], chains: string[], frequency: string,
 *   period: object, executable: false}}
 */
export function planSweeps({ ledgerState, config = DEFAULT_MEV_PAYOUT_CONFIG, period = null, chains = null } = {}) {
  const window = period ?? defaultSweepPeriod(config.sweep.frequency);
  const wanted = chains ?? configuredChains(config);
  const plans = [];
  const summary = summarizeLedger(ledgerState);
  for (const chain of wanted) {
    const hasPile = (summary.byChain[chain]?.recordCount ?? 0) > 0;
    if (!hasPile) continue;
    plans.push(planChainSweep({ ledgerState, chain, config, period: window }));
  }
  return Object.freeze({
    kind: "batch-sweep-bundle",
    consolidation: "per-chain",
    frequency: config.sweep.frequency,
    period: Object.freeze(window),
    chains: Object.freeze(plans.map((p) => p.chain)),
    plans: Object.freeze(plans),
    executable: false,
    note: SWEEP_PLAN_NO_EXECUTION_NOTE + " " + CAPTURE_LEDGER_PERSISTENCE_NOTE,
  });
}

/**
 * planHubSweep — the SOLANA-HUB consolidation plan shape (Mr. Esters'
 * DEFERRED choice — built now so the decision is a config flip later, not a
 * build). Each chain's pile bridges to the Solana hub (our own bridge — the
 * engine's warp-leg family, descriptor only) and converts to the FULL
 * basket at the hub (sol represents all four members). Gas: one payment per
 * chain per batch (the bridge) + one hub conversion batch. NO execution.
 *
 * @param {object} args { ledgerState, config?, period?, chains? } — chains
 *   default to every configured chain with a pile
 * @returns {object} the frozen hub-consolidation plan
 */
export function planHubSweep({ ledgerState, config = DEFAULT_MEV_PAYOUT_CONFIG, period = null, chains = null } = {}) {
  const window = period ?? defaultSweepPeriod(config.sweep.frequency);
  const hubChain = "sol";
  const hubTreasury = treasuryForChain(config, hubChain);
  if (!hubTreasury) throw new Error("sweepPlanner.planHubSweep: the Solana hub needs a configured sol treasury");
  const summary = summarizeLedger(ledgerState);
  const wanted = chains ?? configuredChains(config);
  const gate = captureGate();

  const perChain = [];
  let stepNo = 0;
  for (const chain of wanted) {
    if (chain === hubChain) continue; // sol's pile converts at the hub directly (below)
    const hasPile = (summary.byChain[chain]?.recordCount ?? 0) > 0;
    if (!hasPile) continue;
    const treasury = treasuryForChain(config, chain);
    const pile = accumulatePile(ledgerState, { chain, since: window.since, until: window.until });
    stepNo += 1;
    perChain.push(
      Object.freeze({
        chain,
        treasury,
        pile: Object.freeze(pile),
        step: Object.freeze({
          step: stepNo,
          action: "bridge",
          from: Object.freeze({ chain, pile: Object.freeze(pile) }),
          to: Object.freeze({ chain: hubChain, treasury: hubTreasury }),
          via: Object.freeze({
            legFamily: "own-bridge (the engine's warp-leg family)",
            lane: `${chain} → ${hubChain}`,
            note: "descriptor only — Mr. Esters' consolidation choice is DEFERRED; built at arm time via the repo's bridge/warp leg constructors (signable artifact, submit() throws the live-test gate)",
          }),
          note: `bridge the ${chain} pile to the Solana hub (one batched op per chain — one gas payment)`,
        }),
        gas: Object.freeze({
          paidOnce: true,
          chain,
          token: CHAIN_NATIVE_GAS[chain] ?? "chain native",
          note: SWEEP_GAS_ONCE_NOTE,
        }),
      }),
    );
  }

  // the hub-side conversion: the summed hub pile (sol-native pile + bridged piles) → the FULL basket
  const hubPile = accumulatePile(ledgerState, { chain: hubChain, since: window.since, until: window.until });
  for (const c of perChain) {
    for (const row of c.pile) {
      const existing = hubPile.find((r) => r.token === row.token);
      if (existing) existing.amountRaw = (BigInt(existing.amountRaw) + BigInt(row.amountRaw)).toString();
      else hubPile.push({ ...row });
    }
  }
  hubPile.sort((a, b) => (BigInt(b.amountRaw) > BigInt(a.amountRaw) ? 1 : BigInt(b.amountRaw) < BigInt(a.amountRaw) ? -1 : 0));
  const { representable } = basketTargetsForChain(config, hubChain);
  const hubConvert = [];
  for (const row of hubPile) {
    if (isAlreadyBasketToken(config, hubChain, row.token)) continue;
    stepNo += 1;
    const anchor = convertAnchor(config, hubChain);
    const hint = swapLegHint(hubChain);
    hubConvert.push(
      Object.freeze({
        step: stepNo,
        action: "convert",
        where: "solana-hub",
        from: Object.freeze({ token: row.token, amountRaw: row.amountRaw, recordCount: row.recordCount }),
        to: Object.freeze({
          member: anchor ? anchor.member : null,
          canonicalSymbol: anchor ? anchor.canonicalSymbol : null,
          note: "the FULL basket is representable at the hub (sol: SOL/wBTC→cbBTC/wETH→ETH/USDC)",
        }),
        via: Object.freeze({
          legFamily: "existing-engine-swap-legs",
          constructors: hint.families,
          note: "descriptor only — built at arm time via the repo's leg constructors with the official SDKs; submit() throws DexDirectLiveTestGateError",
        }),
        note: `hub batch-convert ${row.amountRaw} raw ${row.token} → the basket (${anchor ? `${anchor.member} (${anchor.canonicalSymbol})` : "—"})`,
      }),
    );
  }

  const destination = Object.freeze({
    shape: "solana-hub",
    consolidation: "solana-hub",
    chain: hubChain,
    address: hubTreasury,
    depositOnly: true,
    note: MEV_PAYOUT_DEPOSIT_ONLY_NOTE + " (hub shape — Mr. Esters' deferred consolidation choice; per-chain is the DEFAULT)",
  });

  return Object.freeze({
    id: `sweep-hub-plan-${window.since.slice(0, 10)}-${window.until.slice(0, 10)}`,
    kind: "batch-sweep-plan",
    consolidation: "solana-hub",
    hub: Object.freeze({ chain: hubChain, treasury: hubTreasury, basket: Object.freeze(representable) }),
    frequency: config.sweep.frequency,
    period: Object.freeze(window),
    wouldSweep: perChain.length > 0 || hubConvert.length > 0,
    perChain: Object.freeze(perChain),
    hubSteps: Object.freeze(hubConvert),
    destination,
    gate: Object.freeze({ ...gate }),
    executable: false,
    signableArtifacts: Object.freeze([]),
    broadcast: "never (signable artifacts only — Mr. Esters' arm)",
    note:
      SWEEP_PLAN_NO_EXECUTION_NOTE +
      " DEFAULT consolidation is per-chain (planSweeps); this shape is the deferred Solana-hub consolidation, " +
      "planned now so the choice is a config flip later, not a build.",
  });
}
