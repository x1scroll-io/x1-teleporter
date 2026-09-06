/**
 * routePlanner.js — the RoutePlanner for the routing engine.
 *
 * Phase-1 scope (per docs/ROUTING-ENGINE.md): the planner plans the forward
 * route ETH → X1 as four legs through the LegContract, in execution order:
 *
 *   1. evm-approval     the exact-amount ERC-20 approval (golden step1)
 *   2. lifi-evm-bridge  the LiFi stage-1 bridge tx (quote forwarded verbatim)
 *   3. x1-ata-create    the X1 recipient ATA-create, Token-2022 (golden step2a)
 *   4. warp-lock        the Warp lock: 0.5% skim + BridgeOut + the bridge_in_v2
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
 *                                fee-ATA create (when missing) + 0.5% skim
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
 *   watcher + the post-landing auto-advance (SOL→USDC swap, 0.5% skim, Warp
 *   hop) reuse the SAME proven executors the forward/reverse engine legs
 *   already wrap (executeLiFiSolanaTx / buildStage2 / runStage2 — pinned by
 *   the Phase-1/2 oracles) and stay on their existing gated paths; the
 *   planner plans the deposit route here.
 *
 * Phase-5 scope (this file): the RANGO route (the multi-chain aggregator
 * lane) joins the planner as planRango — the fallback/expansion rail for
 * source chains THORChain can't serve (SUI / TRON / XRPL — and the UTXO
 * natives as the fallback when THORChain halts, the live SOL-halt lesson).
 * Two legs (the Rango lane's app-constructed artifacts):
 *
 *   quote stage:   rango-quote    the proxy quote REQUEST (raw base units,
 *                                  canonical asset strings — golden step1)
 *   execute stage: rango-execute   the swap-create REQUEST (the guarded
 *                                  stub — submit() throws
 *                                  RangoLiveTestGateError: the broadcast
 *                                  anchor is READY FOR LIVE TEST, Mr.
 *                                  Esters fires live tests)
 *
 *   family "external" for both (no in-app signer exists for the Rango
 *   source chains yet). Real quote RESPONSES (read-only, live-captured
 *   2026-09-05) are pinned in test/fixtures/golden/rango-leg/; the
 *   swap-execution anchor is deliberately NOT live-anchored in this phase.
 *   The api/rango/swap.js proxy route lands with the live test.
 *
 * The planner owns ROUTE SHAPE only — it does NOT execute anything and does
 * NOT touch wallets/connections — the stage runners (runners/*.js) drive the
 * planned legs with a dependency-injected context.
 *
 * Phase-4 scope (this file): the DEX swap legs join the planner as plan*
 * functions — planJupiterSwap (Solana DEX aggregator), planXdexSwap (X1's
 * DEX — DIRECT on-chain), planLifiEvmSwap (EVM same-chain swaps — DONE by
 * LiFi, verified live). Each plans a single-leg swap route (direction
 * "swap", family svm/svm/evm), and the planner gains the COMPOSITION
 * primitive the engine uses to express "swap then bridge": composeRoute
 * splices a swap route's legs in front of a bridge route's legs (e.g. the
 * THORChain post-landing auto-advance SOL→USDC then Warp-hop becomes
 * composeRoute(planJupiterSwap(), planForward()) with the swap stage first)
 * — the legs stay the SAME LegContract objects; only the ordered leg list +
 * stage grouping are composed. The dex swap legs are construction-migrated
 * (their deterministic artifacts are pinned by the Phase-4 oracle,
 * test/fixtures/golden/dex-leg/); live lanes keep their existing gated
 * paths until a later phase wires runners.
 *
 * Phase-6 scope (this file): the DEX-DIRECT FALLBACK routes join the
 * planner as planDexDirect — the per-DEX direct legs (Uniswap v3 on EVM,
 * PancakeSwap v3 on BNB, Raydium CPMM/CLMM + Orca Whirlpool on Solana) for
 * when an AGGREGATOR path (LiFi / Jupiter) is down or for fee comparison.
 * Each plans a single-leg route (direction "swap", via "dexDirect"). The
 * planner also exposes the FALLBACK registry (DEX_DIRECT_FALLBACKS) — the
 * ordered aggregator→direct candidate lists per chain the rail layer can
 * consult — but the DEFAULT routing stays UNCHANGED (aggregators first;
 * direct legs are candidates, guarded on execute — DexDirectLiveTestGateError
 * until Mr. Esters' live anchor).
 */
import { createLeg } from "./legContract.js";
import { createJupiterSwapLeg } from "./legs/dex/jupiterSwapLeg.js";
import { createXdexSwapLeg } from "./legs/dex/xdexSwapLeg.js";
import { createLifiEvmSwapLeg } from "./legs/dex/lifiEvmSwapLeg.js";
import { createApprovalLeg } from "./legs/forward/approvalLeg.js";
import { createLifiEvmLeg } from "./legs/forward/lifiEvmLeg.js";
import { createAtaCreateLeg } from "./legs/forward/ataCreateLeg.js";
import { createWarpLockLeg } from "./legs/forward/warpLockLeg.js";
import { createX1BurnLeg } from "./legs/reverse/x1BurnLeg.js";
import { createReleaseWaitLeg } from "./legs/reverse/releaseWaitLeg.js";
import { createLifiSolanaOutLeg } from "./legs/reverse/lifiSolanaOutLeg.js";
import { createThorchainQuoteLeg } from "./legs/thorchain/quoteLeg.js";
import { createThorchainDepositBuildLeg } from "./legs/thorchain/depositBuildLeg.js";
import { createRangoQuoteLeg } from "./legs/rango/rangoQuoteLeg.js";
import { createRangoExecuteLeg } from "./legs/rango/rangoExecuteLeg.js";
import { createWanchainQuoteLeg } from "./legs/wanchain/wanchainQuoteLeg.js";
import { createWanchainExecuteLeg } from "./legs/wanchain/wanchainExecuteLeg.js";
import { createUniswapSwapLeg } from "./legs/dexDirect/uniswapSwapLeg.js";
import { createPancakeSwapSwapLeg } from "./legs/dexDirect/pancakeswapSwapLeg.js";
import { createRaydiumSwapLeg } from "./legs/dexDirect/raydiumSwapLeg.js";
import { createOrcaSwapLeg } from "./legs/dexDirect/orcaSwapLeg.js";
import { runCaptureScan, runRouteCaptureScan, captureGate } from "../lib/mev/captureGate.js";

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

// ── Phase 5 — the Rango route (the multi-chain aggregator lane) ───────────

/** The Rango route's leg ids in execution order (the planner contract). */
export const RANGO_LEG_IDS = Object.freeze([
  "rango-quote",
  "rango-execute",
]);

/** Stage grouping of the Rango route's legs (the quote gate first — the
 *  swap-create request is only meaningful after an accepted quote — then
 *  the guarded execute stage). */
export const RANGO_STAGES = Object.freeze({
  quote: Object.freeze({ label: "quote gate (fresh quote before the swap request)", legIds: Object.freeze(["rango-quote"]) }),
  execute: Object.freeze({ label: "swap request + wallet sign (guarded — live test by Mr. Esters)", legIds: Object.freeze(["rango-execute"]) }),
});

/** The two Phase-5 Rango leg factories, in route order. */
export function buildRangoLegs() {
  return [createRangoQuoteLeg(), createRangoExecuteLeg()];
}

/**
 * Plan the Rango route (source chain → SOL — the multi-chain aggregator
 * lane, Phase 5): the quote-request leg + the guarded swap-execution leg,
 * mapped to the lane's two moments (quote gate → swap request). The
 * execution leg's submit() throws RangoLiveTestGateError — the broadcast
 * anchor is READY FOR LIVE TEST and stays Mr. Esters' job.
 *
 * @param {{source?: string}} opts the SOURCE chain ("sui" default — a
 *   RANGO_SOURCES key: "sui" | "xrpl" | "btc" | "tron"; the legs read the
 *   chain + amounts from the run ctx).
 * @returns {object} the planned route { id, direction, sourceChain,
 *   destChain, legs, stages }.
 */
export function planRango({ source = "sui" } = {}) {
  const legs = buildRangoLegs();
  return {
    id: "rango-" + String(source).toLowerCase() + "-sol",
    direction: "rango",
    sourceChain: String(source).toLowerCase(),
    destChain: "sol",
    legs,
    stages: RANGO_STAGES,
  };
}

// ── Wanchain-family route (the XFlows v3 lane — VERIFIED 2026-09-05) ──────

/** The Wanchain-family route's leg ids in execution order (the planner
 *  contract). */
export const WANCHAIN_LEG_IDS = Object.freeze([
  "wanchain-quote",
  "wanchain-execute",
]);

/** Stage grouping of the Wanchain-family route's legs (the quote gate first
 *  — the buildTx request is only meaningful after an accepted quote — then
 *  the guarded execute stage). */
export const WANCHAIN_STAGES = Object.freeze({
  quote: Object.freeze({ label: "quote gate (fresh quote before the transfer request)", legIds: Object.freeze(["wanchain-quote"]) }),
  execute: Object.freeze({ label: "transfer request + wallet sign (guarded — live test by Mr. Esters)", legIds: Object.freeze(["wanchain-execute"]) }),
});

/** The two Wanchain-family leg factories, in route order. */
export function buildWanchainLegs() {
  return [createWanchainQuoteLeg(), createWanchainExecuteLeg()];
}

/**
 * Plan the Wanchain-family route (XFlows v3 — Wanchain's public quote +
 * buildTx HTTP API): the quote-request leg + the guarded transfer-execution
 * leg. 🔴 COVERAGE TRUTH (verified live 2026-09-05): the quote router
 * serves EVM-chain pairs only — the source registry (WANCHAIN_SOURCES in
 * src/lib/wanchain/config.js) gates every build, and NO current console
 * source resolves to this route (teleportRail's coverage matrix). The plan
 * exists so the lane is a wiring exercise the moment a route the app needs
 * becomes quotable — re-verify live FIRST, then update the registry + the
 * coverage matrix together.
 *
 * @param {{source?: string}} opts the SOURCE chain ("eth" default — a
 *   WANCHAIN_SOURCES key).
 * @returns {object} the planned route { id, direction, sourceChain,
 *   destChain, legs, stages }.
 */
export function planWanchain({ source = "eth" } = {}) {
  const legs = buildWanchainLegs();
  return {
    id: "wanchain-" + String(source).toLowerCase(),
    direction: "wanchain",
    sourceChain: String(source).toLowerCase(),
    destChain: "sol",
    legs,
    stages: WANCHAIN_STAGES,
  };
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

// ── Phase 4 — the DEX swap routes (Jupiter / XDEX / LiFi same-chain) ──────

/** The Jupiter swap route's leg ids (the planner contract). */
export const JUPITER_LEG_IDS = Object.freeze(["jupiter-swap"]);

/** Stage grouping of the Jupiter swap route (one stage — the swap). */
export const JUPITER_STAGES = Object.freeze({
  swap: Object.freeze({ label: "Jupiter swap (Solana DEX aggregator)", legIds: JUPITER_LEG_IDS }),
});

/** The XDEX swap route's leg ids (the planner contract). */
export const XDEX_LEG_IDS = Object.freeze(["xdex-swap"]);

/** Stage grouping of the XDEX swap route (one stage — the swap). */
export const XDEX_STAGES = Object.freeze({
  swap: Object.freeze({ label: "XDEX swap (X1 direct, on-chain)", legIds: XDEX_LEG_IDS }),
});

/** The LiFi same-chain EVM swap route's leg ids (the planner contract). */
export const LIFI_EVM_SWAP_LEG_IDS = Object.freeze(["lifi-evm-swap"]);

/** Stage grouping of the LiFi same-chain swap route (one stage — the swap). */
export const LIFI_EVM_SWAP_STAGES = Object.freeze({
  swap: Object.freeze({ label: "LiFi EVM swap (same chain)", legIds: LIFI_EVM_SWAP_LEG_IDS }),
});

/** The Phase-4 DEX leg factories (the swap routes are single-leg). */
export function buildJupiterLegs() {
  return [createJupiterSwapLeg()];
}
export function buildXdexLegs() {
  return [createXdexSwapLeg()];
}
export function buildLifiEvmSwapLegs() {
  return [createLifiEvmSwapLeg()];
}

/**
 * Plan the Jupiter swap route (Solana same-chain swap through the Jupiter
 * DEX aggregator — the engine's Solana swap lane). Single leg: jupiter-swap
 * (build = the canonical quote request + swap-instructions request).
 *
 * @returns {object} the planned route { id, direction, sourceChain,
 *   destChain, legs, stages }.
 */
export function planJupiterSwap() {
  const legs = buildJupiterLegs();
  return {
    id: "swap-sol-sol-jupiter",
    direction: "swap",
    sourceChain: "sol",
    destChain: "sol",
    legs,
    stages: JUPITER_STAGES,
  };
}

/**
 * Plan the XDEX swap route (X1 same-chain swap — DIRECT on-chain into the
 * XDEX CP-Swap program; "land as any token" on X1). Single leg: xdex-swap.
 *
 * @returns {object} the planned route { id, direction, sourceChain,
 *   destChain, legs, stages }.
 */
export function planXdexSwap() {
  const legs = buildXdexLegs();
  return {
    id: "swap-x1-x1-xdex",
    direction: "swap",
    sourceChain: "x1",
    destChain: "x1",
    legs,
    stages: XDEX_STAGES,
  };
}

/**
 * Plan the LiFi EVM same-chain swap route (the Leg-C verdict leg: EVM swaps
 * are DONE by LiFi — verified live, swap routes return when both ends share
 * the chain). Single leg: lifi-evm-swap.
 *
 * @param {{chain?: string}} opts the CHAINS key ("eth" default).
 * @returns {object} the planned route { id, direction, sourceChain,
 *   destChain, legs, stages }.
 */
export function planLifiEvmSwap({ chain = "eth" } = {}) {
  const legs = buildLifiEvmSwapLegs();
  return {
    id: `swap-${String(chain).toLowerCase()}-${String(chain).toLowerCase()}-lifi`,
    direction: "swap",
    sourceChain: String(chain).toLowerCase(),
    destChain: String(chain).toLowerCase(),
    legs,
    stages: LIFI_EVM_SWAP_STAGES,
  };
}

/**
 * The COMPOSITION primitive — how the engine expresses "swap then bridge":
 * composeRoute splices a swap route's legs IN FRONT of a bridge route's
 * legs and re-groups the stages (the swap stage first, then the bridge
 * route's own stages, re-keyed under a prefixed namespace so both stage
 * sets survive). The legs are the SAME LegContract objects (no copies, no
 * new construction); only the ordered leg list + stage grouping change.
 *
 * Canonical use (the THORChain post-landing auto-advance, documented in
 * docs/ROUTING-ENGINE.md §Phase 4): SOL lands → swap SOL→USDC on Jupiter →
 * 0.5% skim + Warp hop into X1. That route is
 *   composeRoute(planJupiterSwap(), planForward(), { id: "forward-sol-x1-via-jupiter" })
 * with the run ctx supplying the swap amount (the landed SOL) to the swap
 * leg and the Warp legs reading the post-swap USDC balance — the planner
 * owns the SHAPE (which legs, in which order); the runners own execution.
 *
 * @param {object} firstRoute the route whose legs run FIRST (the swap)
 * @param {object} secondRoute the route whose legs follow (the bridge)
 * @param {{id?: string, direction?: string, sourceChain?: string,
 *          destChain?: string, stagePrefix?: string}} [opts]
 * @returns {object} the composed route
 */
export function composeRoute(firstRoute, secondRoute, opts = {}) {
  if (!firstRoute?.legs?.length || !secondRoute?.legs?.length) {
    throw new Error("composeRoute: both routes must have legs");
  }
  const prefix = opts.stagePrefix || "composed";
  const stages = {};
  const addStages = (routeStages, keyPrefix) => {
    for (const [key, stage] of Object.entries(routeStages || {})) {
      const legIds = Object.freeze([...(stage.legIds || [])]);
      stages[`${keyPrefix}${key}`] = Object.freeze({
        label: stage.label || key,
        legIds,
      });
    }
  };
  addStages(firstRoute.stages, `${prefix}-a-`);
  addStages(secondRoute.stages, `${prefix}-b-`);
  return {
    id: opts.id || `${firstRoute.id}+${secondRoute.id}`,
    direction: opts.direction || firstRoute.direction,
    sourceChain: opts.sourceChain || firstRoute.sourceChain,
    destChain: opts.destChain || secondRoute.destChain,
    composedOf: Object.freeze([firstRoute.id, secondRoute.id]),
    legs: Object.freeze([...firstRoute.legs, ...secondRoute.legs]),
    stages: Object.freeze(stages),
  };
}

/**
 * The RoutePlanner entry: plans a route for a direction.
 * Plans "forward" (ETH → X1, four legs), "reverse" (X1 → EVM, three legs —
 * Phase 2), "thorchain" (source → SOL.SOL deposit route, two legs — Phase 3),
 * the Phase-4 DEX swap routes (plan({direction: "swap", via:
 * "jupiter"|"xdex"|"lifi"}) — single-leg swap routes), the "rango"
 * (source → SOL aggregator route, two legs — Phase 5), "wanchain"
 * (the XFlows v3 lane, two legs — coverage-gated; see planWanchain), and
 * the Phase-6 DEX-direct fallbacks (plan({direction: "swap", via:
 * "dexDirect", dex: "uniswap"|"pancakeswap"|"raydium"|"orca"})).
 * Unknown directions /
 * vias return null — those lanes keep their existing paths.
 */
export function plan({ direction = "forward", ...opts } = {}) {
  if (direction === "forward") return planForward(opts);
  if (direction === "reverse") return planReverse(opts);
  if (direction === "thorchain") return planThorchain(opts);
  if (direction === "rango") return planRango(opts);
  if (direction === "wanchain") return planWanchain(opts);
  if (direction === "swap") {
    if (opts.via === "jupiter") return planJupiterSwap();
    if (opts.via === "xdex") return planXdexSwap();
    if (opts.via === "lifi") return planLifiEvmSwap(opts);
    if (opts.via === "dexDirect") return planDexDirect(opts);
    return null;
  }
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

// ── Phase 6 — the DEX-DIRECT fallback routes ────────────────────────────────

/** The dexDirect leg factories. */
export function buildDexDirectLegs() {
  return {
    uniswap: createUniswapSwapLeg(),
    pancakeswap: createPancakeSwapSwapLeg(),
    raydium: createRaydiumSwapLeg(),
    orca: createOrcaSwapLeg(),
  };
}

/** The dexDirect swap route's leg ids (all single-leg). */
export const DEX_DIRECT_LEG_IDS = Object.freeze({
  uniswap: Object.freeze(["uniswap-swap"]),
  pancakeswap: Object.freeze(["pancakeswap-swap"]),
  raydium: Object.freeze(["raydium-swap"]),
  orca: Object.freeze(["orca-swap"]),
});

/** Stage grouping of each dexDirect route (one stage — the swap). */
export const DEX_DIRECT_STAGES = Object.freeze({
  uniswap: Object.freeze({ swap: Object.freeze({ label: "Uniswap v3 swap (DEX-direct, EVM)", legIds: DEX_DIRECT_LEG_IDS.uniswap }) }),
  pancakeswap: Object.freeze({ swap: Object.freeze({ label: "PancakeSwap v3 swap (DEX-direct, BNB)", legIds: DEX_DIRECT_LEG_IDS.pancakeswap }) }),
  raydium: Object.freeze({ swap: Object.freeze({ label: "Raydium swap (DEX-direct, Solana)", legIds: DEX_DIRECT_LEG_IDS.raydium }) }),
  orca: Object.freeze({ swap: Object.freeze({ label: "Orca swap (DEX-direct, Solana)", legIds: DEX_DIRECT_LEG_IDS.orca }) }),
});

/** The default dexDirect dex per chain family. */
export const DEX_DIRECT_DEFAULT_DEX = Object.freeze({
  eth: "uniswap",
  arb: "uniswap",
  bas: "uniswap",
  opt: "uniswap",
  pol: "uniswap",
  bsc: "pancakeswap",
  sol: "orca", // Solana direct default: Orca (the deepest live-verified fixture); raydium via ctx.dex
});

/**
 * The FALLBACK registry — the ordered candidate lists per chain the rail
 * layer can prefer when an aggregator path is down. DEFAULT ROUTING IS
 * UNCHANGED: the aggregators (LiFi / Jupiter) stay first; the dexDirect
 * legs are FALLBACK CANDIDATES (and their executes are guarded stubs —
 * DexDirectLiveTestGateError — until Mr. Esters fires each live anchor).
 */
export const DEX_DIRECT_FALLBACKS = Object.freeze({
  evm: Object.freeze({
    // LiFi (aggregator) first — the dexDirect leg is the no-aggregator fallback.
    eth: Object.freeze(["lifi", "uniswap"]),
    arb: Object.freeze(["lifi", "uniswap"]),
    bas: Object.freeze(["lifi", "uniswap"]),
    opt: Object.freeze(["lifi", "uniswap"]),
    pol: Object.freeze(["lifi", "uniswap"]),
    bsc: Object.freeze(["lifi", "pancakeswap"]),
    // avax/sonic: LiFi-only (no verified direct DEX deployment in this scaffold).
    avax: Object.freeze(["lifi"]),
    sonic: Object.freeze(["lifi"]),
  }),
  svm: Object.freeze({
    // Jupiter (aggregator) first — the direct legs are the no-aggregator fallbacks.
    sol: Object.freeze(["jupiter", "orca", "raydium"]),
    x1: Object.freeze(["xdex"]),
  }),
});

/**
 * Plan a DEX-direct swap route (the Phase-6 fallback family).
 *
 * @param {{dex?: string, chain?: string}} opts dex: "uniswap" |
 *   "pancakeswap" | "raydium" | "orca"; chain: the CHAINS key (defaults per
 *   DEX_DIRECT_DEFAULT_DEX). The raydium leg serves both cpmm and clmm —
 *   the run ctx selects via ctx.dex: "cpmm"|"clmm" at build time.
 * @returns {object} the planned route { id, direction, sourceChain,
 *   destChain, legs, stages }.
 */
export function planDexDirect({ dex, chain = null } = {}) {
  const legs = buildDexDirectLegs();
  const leg = legs[dex];
  if (!leg) {
    throw new Error(`planDexDirect: unknown dex "${dex}" (uniswap | pancakeswap | raydium | orca)`);
  }
  const effChain = chain ?? (dex === "pancakeswap" ? "bsc" : dex === "orca" || dex === "raydium" ? "sol" : "eth");
  return {
    id: `swap-${effChain}-${effChain}-dexdirect-${dex}`,
    direction: "swap",
    via: "dexDirect",
    dex,
    sourceChain: effChain,
    destChain: effChain,
    legs: [leg],
    stages: DEX_DIRECT_STAGES[dex],
  };
}

// ── MEV capture — the same-chain cross-DEX price-gap hook (Phase 7) ────────
//
// The capture engine (src/lib/mev/) detects capturable price gaps when the
// routing layer sees the SAME token pair quoted on MULTIPLE venues on the
// SAME chain (the DEX_DIRECT_FALLBACKS candidates above + the aggregators).
// The planner owns the two seams the engine needs:
//
//   1. captureCandidatesForChain(chain) — the same-chain VENUE LIST a
//      quote-fetching layer consults when a swap route is planned (which
//      venues to fetch for the capture scan, in fallback priority order).
//      Pure read of the existing DEX_DIRECT_FALLBACKS registry — DEFAULT
//      ROUTING UNCHANGED.
//   2. planCaptureSwapPair(...) — the atomic capture-route CONSTRUCTOR: it
//      COMPOSES two existing swap legs (buy on the cheap venue, sell on the
//      expensive venue) via composeRoute. No hand-rolled calldata — the
//      legs are the repo's actual dexDirect / aggregator swap legs (their
//      submit() throws DexDirectLiveTestGateError: wallet-sign-only at any
//      gate value). DEAD-GATED: the route carries the capture gate state;
//      execution is Mr. Esters' arm alone (captureGate.js).
//   3. observeRouteCapture + planCaptureRouteJourney — the MULTI-HOP
//      route-choice seams (the framing correction, 2026-09-06 — see
//      src/lib/mev/routeAnalyzer.js): observeRouteCapture runs the route
//      analyzer over a planned multi-hop route's per-leg venue quotes
//      ("route capture opportunity: X bps across N hops (gated OFF)");
//      planCaptureRouteJourney folds composeRoute over the optimal
//      sub-path's leg routes (best venue per leg) — the same existing
//      engine legs, dead-gated, atomic:false (a journey, not a same-block
//      pair).
//
// The observation itself (detector over fetched quotes → the "capture
// opportunity: X bps (gated OFF)" report line) is runCaptureScan /
// runRouteCaptureScan — re-exported below so the routing layer records what
// WOULD be capturable the moment it holds multi-venue quotes for a planned
// route (pure observation at every gate state; the detector NEVER returns an
// executable trade).

/**
 * The same-chain capture venue lists per chain — DERIVED from the
 * DEX_DIRECT_FALLBACKS registry (the engine's own candidate ordering,
 * aggregators first). Chains with FEWER than two venues cannot host a
 * cross-venue capture (the detector reports single-route and moves on).
 */
export const CAPTURE_CANDIDATES = Object.freeze({
  evm: Object.freeze({
    eth: Object.freeze([...DEX_DIRECT_FALLBACKS.evm.eth]),
    arb: Object.freeze([...DEX_DIRECT_FALLBACKS.evm.arb]),
    bas: Object.freeze([...DEX_DIRECT_FALLBACKS.evm.bas]),
    opt: Object.freeze([...DEX_DIRECT_FALLBACKS.evm.opt]),
    pol: Object.freeze([...DEX_DIRECT_FALLBACKS.evm.pol]),
    bsc: Object.freeze([...DEX_DIRECT_FALLBACKS.evm.bsc]),
    avax: Object.freeze([...DEX_DIRECT_FALLBACKS.evm.avax]),
    sonic: Object.freeze([...DEX_DIRECT_FALLBACKS.evm.sonic]),
  }),
  svm: Object.freeze({
    sol: Object.freeze([...DEX_DIRECT_FALLBACKS.svm.sol]),
    x1: Object.freeze([...DEX_DIRECT_FALLBACKS.svm.x1]),
  }),
});

/** The chains the capture scan can consult (served same-chain swap chains). */
export const CAPTURE_SCAN_CHAINS = Object.freeze(["eth", "arb", "bas", "opt", "pol", "bsc", "sol"]);

/**
 * captureCandidatesForChain — the same-chain venue list for a chain (the
 * routing hook's candidate query). Returns [] for unknown chains.
 *
 * @param {string} chain a CHAINS key ("eth" | "arb" | "bsc" | "sol" | …)
 * @returns {string[]} venue vias in fallback priority order (lifi/uniswap,
 *   lifi/pancakeswap, jupiter/orca/raydium, …)
 */
export function captureCandidatesForChain(chain) {
  const family = CAPTURE_CANDIDATES.evm[chain] ? CAPTURE_CANDIDATES.evm : CAPTURE_CANDIDATES.svm;
  const list = family?.[chain];
  return list ? [...list] : [];
}

/** Plan one side of a capture pair from its via/dex spec. */
export function planCaptureSide({ via, dex = null, chain = null } = {}) {
  if (via === "dexDirect") {
    if (!dex) throw new Error("planCaptureSide: a dexDirect side needs dex (uniswap | pancakeswap | raydium | orca)");
    return planDexDirect({ dex, chain: chain ?? undefined });
  }
  if (via === "lifi") return planLifiEvmSwap({ chain: chain ?? "eth" });
  if (via === "jupiter") return planJupiterSwap();
  if (via === "xdex") return planXdexSwap();
  throw new Error(`planCaptureSide: unknown swap via "${via}" (dexDirect | lifi | jupiter | xdex)`);
}

/**
 * planCaptureSwapPair — the atomic capture-route CONSTRUCTOR (dead-gated).
 *
 * Composes TWO existing swap legs into one capture route via composeRoute:
 * the BUY leg (X→Y on the venue where Y is cheapest) then the SELL leg
 * (Y→X on the venue where Y is most expensive). The legs are the SAME
 * LegContract objects the repo already builds (dexDirect / lifi / jupiter)
 * — no hand-rolled calldata; the runner supplies each leg's ctx (pair,
 * amounts) at run time exactly like any other composed swap route.
 *
 * 🔴 GATE: the returned route is DEAD-GATED regardless of flag state — its
 * legs' submit() throws DexDirectLiveTestGateError (no autonomous broadcast
 * exists in the repo), and the route carries the capture gate state
 * (captureGate() — MEV_CAPTURE_ENABLED, default false) so callers and
 * tests can assert the gate. assertCaptureGateOpen() (captureGate.js) is
 * the separate execution guard for any future runner: it throws while the
 * gate is closed. Execution is Mr. Esters' arm alone.
 *
 * @param {object} opts { chain, pair: {from, to}, buy: {via, dex?},
 *   sell: {via, dex?} } — chain defaults "eth"; pair is annotation only
 *   (the legs read the pair from ctx at run time, like every planner route).
 * @returns {object} the composed capture route
 */
export function planCaptureSwapPair({ chain = "eth", pair = null, buy, sell } = {}) {
  if (!buy || !sell) throw new Error("planCaptureSwapPair: buy and sell sides are required ({via, dex?})");
  const buyRoute = planCaptureSide({ ...buy, chain });
  const sellRoute = planCaptureSide({ ...sell, chain });
  const from = pair?.from ?? "?";
  const to = pair?.to ?? "?";
  const buyName = buy.via === "dexDirect" ? buy.dex : buy.via;
  const sellName = sell.via === "dexDirect" ? sell.dex : sell.via;
  const route = composeRoute(buyRoute, sellRoute, {
    id: `capture-${chain}-${from}-${to}-${buyName}-${sellName}`,
    direction: "capture",
    sourceChain: chain,
    destChain: chain,
    stagePrefix: "capture",
  });
  return {
    ...route,
    capture: Object.freeze({
      kind: "same-chain-cross-venue-price-gap",
      chain,
      pair: pair ? Object.freeze({ from, to }) : null,
      buy: Object.freeze({ via: buy.via, dex: buy.dex ?? null }),
      sell: Object.freeze({ via: sell.via, dex: sell.dex ?? null }),
      atomic: true,
      gate: captureGate(),
    }),
  };
}

/**
 * observeCaptureForSwap — the routing hook's observation call: given the
 * same-chain multi-venue quotes the engine already fetched for a swap
 * (the DEX_DIRECT_FALLBACKS / CAPTURE_CANDIDATES path), run the capture
 * scan and return { detection, gate, report }. PURE OBSERVATION at every
 * gate state — the engine records what WOULD be capturable and moves on.
 *
 * @param {object} args { chain, pair: {from, to}, buyQuotes, sellQuotes,
 *   gasCostQuoteUnits? } — see runCaptureScan in captureGate.js
 * @returns {{detection: object, gate: object, report: string}}
 */
export function observeCaptureForSwap(args) {
  return runCaptureScan(args);
}

// ── MULTI-HOP route-choice capture (the framing correction — 2026-09-06) ──
//
// The single-pair round trip proved ~0 on deep stables; the multi-hop model
// (routeAnalyzer.js) measures the ONE-WAY route-choice value across a whole
// journey — per-leg venue deltas (best venue vs routed venue) accumulated to
// volatile/exotic destinations. Two seams:
//
//   1. observeRouteCapture(route) — the OBSERVATION hook: given a planned
//      multi-hop route whose legs already carry per-venue quotes, run the
//      route analyzer and record "route capture opportunity: X bps across N
//      hops (gated OFF)". Pure observation at every gate state.
//   2. planCaptureRouteJourney({ legRoutes }) — the CONSTRUCTOR: folds
//      composeRoute over the caller-chosen per-leg routes (the optimal
//      sub-path's legs — one existing engine route per hop). No hand-rolled
//      calldata: the legs are the repo's actual swap/bridge legs (submit()
//      throws DexDirectLiveTestGateError / RangoLiveTestGateError etc. —
//      wallet-sign-only at any gate value). DEAD-GATED: carries the capture
//      gate state; atomic:false with an honest note (a multi-hop journey is
//      NOT a same-block round trip — the value is route-choice improvement
//      realized leg by leg, not an atomic arb).

/**
 * observeRouteCapture — the multi-hop routing hook's observation call:
 * given a planned route's per-leg venue quotes, run the route analyzer and
 * return { analysis, gate, report }. PURE OBSERVATION at every gate state.
 *
 * @param {object} route the analyzed route { id, legs: [{hop, from, to,
 *   chain?, kind?, venueChosen, quotes, usdPerOutUnit?}] } — see
 *   routeAnalyzer.analyzeRoute (the caller maps its planned legs + fetched
 *   venue quotes into that shape)
 * @returns {{analysis: object, gate: object, report: string}}
 */
export function observeRouteCapture(route) {
  return runRouteCaptureScan(route);
}

/**
 * planCaptureRouteJourney — the multi-hop capture-route CONSTRUCTOR
 * (dead-gated). Folds composeRoute over an ordered list of per-leg ROUTES
 * (one existing planner route per hop — e.g. the optimal sub-path the
 * analyzer selected: planCaptureSide(venue) for DEX hops, planForward /
 * planThorchain / … for bridge hops). The legs are the SAME LegContract
 * objects the repo already builds — no hand-rolled calldata.
 *
 * 🔴 GATE: the returned route is DEAD-GATED regardless of flag state — its
 * legs' submit() throws the existing live-test gates (no autonomous
 * broadcast exists in the repo), and the route carries the capture gate
 * state (captureGate() — MEV_CAPTURE_ENABLED, default false).
 * atomic:false — an honest note: this is a JOURNEY (route-choice
 * improvement realized leg by leg), NOT an atomic same-block round trip.
 *
 * @param {object} opts { legRoutes: [route, …] (ordered, ≥2), id?,
 *   optimal? (annotation: the legRoutes are the analyzer's optimal
 *   sub-path) }
 * @returns {object} the composed capture journey route
 */
export function planCaptureRouteJourney({ legRoutes, id = null, optimal = false } = {}) {
  if (!Array.isArray(legRoutes) || legRoutes.length < 2) {
    throw new Error("planCaptureRouteJourney: legRoutes are required (an ordered array of ≥2 planned routes)");
  }
  for (const r of legRoutes) {
    if (!r?.legs?.length) throw new Error("planCaptureRouteJourney: every legRoute must be a planned route with legs");
  }
  const [first, ...rest] = legRoutes;
  const composed = rest.reduce(
    (acc, legRoute, i) => composeRoute(acc, legRoute, { stagePrefix: `hop${i + 2}` }),
    first,
  );
  return {
    ...composed,
    id: id || `capture-journey-${legRoutes.map((r) => r.id).join("+")}`,
    composedOf: Object.freeze(legRoutes.map((r) => r.id)), // all N source routes (composeRoute's own composedOf is binary)
    capture: Object.freeze({
      kind: "multi-hop-route-choice",
      atomic: false,
      atomicNote:
        "a multi-hop journey is NOT a same-block round trip — the capturable value is route-choice improvement " +
        "(best venue per hop vs the routed venue), realized leg by leg across the journey, not an atomic arb",
      legCount: legRoutes.length,
      optimal: Boolean(optimal),
      gate: captureGate(),
    }),
  };
}

/**
 * The RoutePlanner surface: plan a route, read its legs/stages. Plans the
 * forward route (Phase 1), the reverse route (Phase 2), the THORChain
 * deposit route (Phase 3), the Phase-4 DEX swap routes
 * (planJupiterSwap / planXdexSwap / planLifiEvmSwap — direction "swap")
 * and the Phase-5 Rango aggregator route (planRango — direction "rango");
 * composeRoute is the swap-then-bridge composition primitive.
 */
export const RoutePlanner = Object.freeze({
  planForward,
  planReverse,
  planThorchain,
  planJupiterSwap,
  planXdexSwap,
  planLifiEvmSwap,
  planRango,
  planWanchain,
  composeRoute,
  plan,
  legById,
  legsForStage,
  FORWARD_LEG_IDS,
  FORWARD_STAGES,
  REVERSE_LEG_IDS,
  REVERSE_STAGES,
  THORCHAIN_LEG_IDS,
  THORCHAIN_STAGES,
  JUPITER_LEG_IDS,
  JUPITER_STAGES,
  XDEX_LEG_IDS,
  XDEX_STAGES,
  LIFI_EVM_SWAP_LEG_IDS,
  LIFI_EVM_SWAP_STAGES,
  RANGO_LEG_IDS,
  RANGO_STAGES,
  WANCHAIN_LEG_IDS,
  WANCHAIN_STAGES,
  planDexDirect,
  DEX_DIRECT_LEG_IDS,
  DEX_DIRECT_STAGES,
  DEX_DIRECT_FALLBACKS,
  DEX_DIRECT_DEFAULT_DEX,
  buildDexDirectLegs,
  CAPTURE_CANDIDATES,
  CAPTURE_SCAN_CHAINS,
  captureCandidatesForChain,
  planCaptureSide,
  planCaptureSwapPair,
  observeCaptureForSwap,
  observeRouteCapture,
  planCaptureRouteJourney,
});
