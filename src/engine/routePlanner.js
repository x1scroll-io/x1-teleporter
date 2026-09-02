/**
 * routePlanner.js — the RoutePlanner stub for the routing engine.
 *
 * Phase-1 scope (per docs/ROUTING-ENGINE.md): the planner plans EXACTLY ONE
 * route — the forward leg ETH → X1 — as four legs flowing through the
 * LegContract, in execution order:
 *
 *   1. evm-approval     the exact-amount ERC-20 approval (golden step1)
 *   2. lifi-evm-bridge  the LiFi stage-1 bridge tx (quote forwarded verbatim)
 *   3. x1-ata-create    the X1 recipient ATA-create, Token-2022 (golden step2a)
 *   4. warp-lock        the Warp lock: 1% skim + BridgeOut + the bridge_in_v2
 *                       account pre-image (golden step2b + step3)
 *
 * The two UI stages map onto contiguous leg slices:
 *   evm stage (stage 1 of 2): legs 1-2   — what "Bridge — Step 1 of 2" runs
 *   svm stage (stage 2 of 2): legs 3-4   — what "Step 2 of 2" runs
 *
 * The planner is deliberately a STUB: it owns ROUTE SHAPE (which legs, in
 * which order, grouped into which stages). It does NOT execute anything and
 * does NOT touch wallets/connections — the stage runners (runners/*.js) drive
 * the planned legs with a dependency-injected context. Future phases add new
 * route classes (reverse, THORChain, DEX, multi-hop) as new plan* functions
 * behind the same shape — nothing in Phase 1 guesses at them.
 *
 * Reverse / THORChain / DEX are NOT planned here and stay on their existing
 * code paths untouched.
 */
import { createLeg } from "./legContract.js";
import { createApprovalLeg } from "./legs/forward/approvalLeg.js";
import { createLifiEvmLeg } from "./legs/forward/lifiEvmLeg.js";
import { createAtaCreateLeg } from "./legs/forward/ataCreateLeg.js";
import { createWarpLockLeg } from "./legs/forward/warpLockLeg.js";

/** The forward route's leg ids in execution order (the planner contract). */
export const FORWARD_LEG_IDS = Object.freeze([
  "evm-approval",
  "lifi-evm-bridge",
  "x1-ata-create",
  "warp-lock",
]);

/** Stage grouping of the forward route's legs (UI stage boundaries). */
export const FORWARD_STAGES = Object.freeze({
  evm: Object.freeze({ label: "stage 1 of 2 (EVM)", legIds: Object.freeze(["evm-approval", "lifi-evm-bridge"]) }),
  svm: Object.freeze({ label: "stage 2 of 2 (Solana → X1)", legIds: Object.freeze(["x1-ata-create", "warp-lock"]) }),
});

/** The four Phase-1 forward leg factories, in route order. */
export function buildForwardLegs() {
  return [createApprovalLeg(), createLifiEvmLeg(), createAtaCreateLeg(), createWarpLockLeg()];
}

/**
 * Plan the forward route (ETH → X1). Phase-1 stub: no branching on quote
 * contents — every forward bridge flows the same four legs in the same order;
 * legs decide at build/simulate time whether a phase is needed (e.g. the
 * approval leg skips itself for native sends or when the allowance is already
 * sufficient).
 *
 * @param {{direction?: string}} _opts reserved (quote/token/destToken arrive
 *   at RUN time in the ctx — the planner is shape-only in Phase 1).
 * @returns {object} the planned route { id, direction, sourceChain, destChain,
 *   legs: LegContract[], stages }.
 * @throws when asked to plan a route class Phase 1 does not plan (reverse,
 *   THORChain, DEX) — those stay on their existing paths; the planner must
 *   never pretend it can run them.
 */
export function planForward(_opts = {}) {
  const legs = buildForwardLegs();
  return {
    id: "forward-eth-x1",
    direction: "forward",
    sourceChain: "eth",
    destChain: "x1",
    legs,
    stages: FORWARD_STAGES,
  };
}

/**
 * The RoutePlanner stub entry: plans a route for a direction.
 * Phase 1 plans ONLY "forward"; anything else returns null (not planned) —
 * callers keep using the reference path for unplanned directions.
 */
export function plan({ direction = "forward", ...opts } = {}) {
  if (direction === "forward") return planForward(opts);
  return null;
}

/** Pick a leg out of a route by id (stage runners use this). */
export function legById(route, id) {
  return route?.legs?.find((l) => l.id === id) || null;
}

/** The legs of a route that belong to a stage, in route order. */
export function legsForStage(route, stageKey) {
  const ids = route?.stages?.[stageKey]?.legIds || [];
  const byId = new Map((route?.legs || []).map((l) => [l.id, l]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * The RoutePlanner surface (the stub's public face): plan a route, read its
 * legs/stages. Phase 1 plans ONLY the forward route — everything else stays
 * on its existing path (plan returns null).
 */
export const RoutePlanner = Object.freeze({
  planForward,
  plan,
  legById,
  legsForStage,
  FORWARD_LEG_IDS,
  FORWARD_STAGES,
});
