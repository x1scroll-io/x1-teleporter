/**
 * routePlanner.js — the RoutePlanner for the routing engine.
 *
 * Phase-1 scope (per docs/ROUTING-ENGINE.md): the planner plans the forward
 * route ETH → X1 as four legs through the LegContract, in execution order:
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
 * Phase-2 scope (this file): the REVERSE route X1 → EVM joins the planner as
 * its own plan* function — three legs, grouped into the reverse UI stages:
 *
 *   burn stage (Step 1 of 2):  x1-reverse-burn    the X1 Warp burn: bundled
 *                                fee-ATA create (when missing) + 1% skim
 *                                transfer + BridgeOut (golden step1)
 *   release (auto, relaying):   warp-release-wait  the poll for the official
 *                                submitter's Solana release (golden step2)
 *   lifi stage (Step 2 of 2):   lifi-solana-out    the LiFi WSOL/USDC → EVM
 *                                leg to the PINNED EVM destination (golden
 *                                step3)
 *
 * Phase-3 scope (this file): the THORChain route (deposit-address lane) joins
 * the planner as planThorchain — the BUY/THORChain tab's flow
 * BTC/DOGE/LTC/XRP → SOL.SOL. Two legs (the app-constructed deposit-lane
 * artifacts — the quote request + the deposit payload):
 *
 *   quote stage:   thorchain-quote         the proxy quote REQUEST (1e8 base
 *                                           units, destination pin, size cap
 *                                           before fetch — golden step1)
 *   deposit stage: thorchain-deposit-build  the vault deposit address + the
 *                                           deposit MEMO (golden step2)
 *
 *   Both legs are family "external": the deposit is executed OUT-OF-BAND in
 *   the user's external wallet (copy address + memo, send, paste txid) —
 *   the engine's SignerResolver returns null for them by design (no in-app
 *   session signer exists for the deposit-address lane). The SOL-landing
 *   watcher + the post-landing auto-advance (SOL→USDC swap, 1% skim, Warp
 *   hop) reuse the SAME proven executors the forward/reverse engine legs
 *   already wrap (executeLiFiSolanaTx / buildStage2 / runStage2 — pinned by
 *   the Phase-1/2 oracles) and stay on their existing gated paths; the
 *   planner plans the deposit route here.
 *
 * The planner owns ROUTE SHAPE only — it does NOT execute anything and does
 * NOT touch wallets/connections — the stage runners (runners/*.js) drive the
 * planned legs with a dependency-injected context. DEX routes are NOT
 * planned here and stay on their existing code paths untouched.
 */
import { createLeg } from "./legContract.js";
import { createApprovalLeg } from "./legs/forward/approvalLeg.js";
import { createLifiEvmLeg } from "./legs/forward/lifiEvmLeg.js";
import { createAtaCreateLeg } from "./legs/forward/ataCreateLeg.js";
import { createWarpLockLeg } from "./legs/forward/warpLockLeg.js";
import { createX1BurnLeg } from "./legs/reverse/x1BurnLeg.js";
import { createReleaseWaitLeg } from "./legs/reverse/releaseWaitLeg.js";
import { createLifiSolanaOutLeg } from "./legs/reverse/lifiSolanaOutLeg.js";
import { createThorchainQuoteLeg } from "./legs/thorchain/quoteLeg.js";
import { createThorchainDepositBuildLeg } from "./legs/thorchain/depositBuildLeg.js";

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

/** The reverse route's leg ids in execution order (the planner contract). */
export const REVERSE_LEG_IDS = Object.freeze([
  "x1-reverse-burn",
  "warp-release-wait",
  "lifi-solana-out",
]);

/** Stage grouping of the reverse route's legs (UI stage boundaries). The
 *  release-wait leg is the bridge between the two user stages — it runs
 *  automatically in the relaying state after the burn is sent. */
export const REVERSE_STAGES = Object.freeze({
  burn: Object.freeze({ label: "stage 1 of 2 (X1 burn)", legIds: Object.freeze(["x1-reverse-burn"]) }),
  release: Object.freeze({ label: "release wait (auto)", legIds: Object.freeze(["warp-release-wait"]) }),
  lifi: Object.freeze({ label: "stage 2 of 2 (LiFi Solana → EVM)", legIds: Object.freeze(["lifi-solana-out"]) }),
});

/** The three Phase-2 reverse leg factories, in route order. */
export function buildReverseLegs() {
  return [createX1BurnLeg(), createReleaseWaitLeg(), createLifiSolanaOutLeg()];
}
/**
 * Plan the reverse route (X1 → EVM): the X1 Warp burn, the release-wait
 * poll, then the LiFi Solana→EVM leg to the pinned EVM destination — mapped
 * to the reverse UI stages (burn → relaying/release → step 2 LiFi).
 *
 * @param {{to?: string}} opts the destination EVM chain id ("eth" default) —
 *   the route SHAPE is chain-agnostic (the legs read the destination from
 *   the run ctx); recorded for the route descriptor.
 * @returns {object} the planned route { id, direction, sourceChain, destChain,
 *   legs: LegContract[], stages }.
 */
export function planReverse({ to = "eth" } = {}) {
  const legs = buildReverseLegs();
  return {
    id: "reverse-x1-" + to,
    direction: "reverse",
    sourceChain: "x1",
    destChain: to,
    legs,
    stages: REVERSE_STAGES,
  };
}

/** The THORChain route's leg ids in execution order (the planner contract). */
export const THORCHAIN_LEG_IDS = Object.freeze([
  "thorchain-quote",
  "thorchain-deposit-build",
]);

/** Stage grouping of the THORChain route's legs (the deposit stage's two
 *  moments: the quote gate first — the deposit address is shown ONLY after a
 *  fresh quote lands — then the deposit payload). */
export const THORCHAIN_STAGES = Object.freeze({
  quote: Object.freeze({ label: "quote gate (fresh quote before the address)", legIds: Object.freeze(["thorchain-quote"]) }),
  deposit: Object.freeze({ label: "deposit address + memo (external send)", legIds: Object.freeze(["thorchain-deposit-build"]) }),
});

/** The two Phase-3 THORChain leg factories, in route order. */
export function buildThorchainLegs() {
  return [createThorchainQuoteLeg(), createThorchainDepositBuildLeg()];
}

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
 *   at RUN time in the ctx — the planner is shape-only).
 * @returns {object} the planned route { id, direction, sourceChain, destChain,
 *   legs: LegContract[], stages }.
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
 * Plan the THORChain route (source chain → SOL.SOL — the deposit-address
 * lane, Phase 3): the quote-request leg + the deposit-payload leg, mapped to
 * the deposit stage's two moments (quote gate → deposit address + memo).
 *
 * @param {{source?: string}} opts the SOURCE chain ("BTC" default — the
 *   tab's default selection; "DOGE"|"LTC"|"XRP" plan the same two-leg
 *   shape — the legs read the chain + amounts from the run ctx).
 * @returns {object} the planned route { id, direction, sourceChain, destChain,
 *   legs: LegContract[], stages }.
 */
export function planThorchain({ source = "BTC" } = {}) {
  const legs = buildThorchainLegs();
  return {
    id: "thorchain-" + String(source).toLowerCase() + "-sol",
    direction: "thorchain",
    sourceChain: String(source).toLowerCase(),
    destChain: "sol",
    legs,
    stages: THORCHAIN_STAGES,
  };
}

/**
 * The RoutePlanner entry: plans a route for a direction.
 * Plans "forward" (ETH → X1, four legs), "reverse" (X1 → EVM, three legs —
 * Phase 2) and "thorchain" (source → SOL.SOL deposit route, two legs —
 * Phase 3); DEX stays unplanned (null) — those lanes keep their existing
 * paths until a later phase adds their plan*.
 */
export function plan({ direction = "forward", ...opts } = {}) {
  if (direction === "forward") return planForward(opts);
  if (direction === "reverse") return planReverse(opts);
  if (direction === "thorchain") return planThorchain(opts);
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
 * The RoutePlanner surface: plan a route, read its legs/stages. Plans the
 * forward route (Phase 1), the reverse route (Phase 2) and the THORChain
 * deposit route (Phase 3); DEX stays unplanned (plan returns null) — those
 * lanes keep their existing paths.
 */
export const RoutePlanner = Object.freeze({
  planForward,
  planReverse,
  planThorchain,
  plan,
  legById,
  legsForStage,
  FORWARD_LEG_IDS,
  FORWARD_STAGES,
  REVERSE_LEG_IDS,
  REVERSE_STAGES,
  THORCHAIN_LEG_IDS,
  THORCHAIN_STAGES,
});
