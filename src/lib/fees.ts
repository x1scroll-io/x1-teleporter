/**
 * fees.ts — Step 1.3C: THE single source of truth for every Teleporter fee.
 *
 * Every fee across the app hangs off this module:
 *   - the X1-hop 1% pre-bridge skim (the source-side SPL transfer),
 *   - the Warp bridge's own flat $1 (collected by the Warp program, not us),
 *   - the LiFi integrator fee (1%, collected by LiFi to our integrator account),
 *   - the runbook's two spec'd-but-NOT-yet-applied classes:
 *       same-chain 0.5%  (any-swap phase — see PR #7 notes)
 *       Escape Hatch 5%  (no escape-hatch path exists in code yet)
 *   - two future lanes with no rate yet (thorchain-leg, non-x1-bridge) THROW a
 *     descriptive FeeNotImplementedError instead of guessing a number.
 *
 * PURE MODULE: no DOM, no fetch, no wallet, no chain imports. Runnable under
 * `node --test` (type stripping) exactly like routes.ts / flags.ts.
 *
 * ADAPTATION NOTE (runbook `lib/fees.ts` → repo `src/lib/fees.ts`):
 *   This is a Vite project — there is no root-level lib/. The established
 *   pattern is src/lib/ (flags.ts, routes.ts, lifiApproval.js, simulateTx.js),
 *   so computeFee lives at src/lib/fees.ts.
 *
 * GROUND RULE FOR THIS PR: NO FEE AMOUNT CHANGES. `headlineRate` on a class is
 * the runbook's spec rate; the `components` carry the rates ACTUALLY charged
 * today. Where the two differ (same-chain), the class is deliberately NOT wired
 * into the live quote path yet — wiring it would change what users pay.
 */
import { determineRoute, type RouteType } from "./routes.ts";

// ─────────────────────────────────────────────────────────────────────────────
// RATES — runbook Step 1.3C spec + the rates actually charged today.
// ─────────────────────────────────────────────────────────────────────────────
export const FEE_RATES = {
  /** 1% — the X1-hop pre-bridge skim. Applied TODAY, source side, as a
   *  pre-bridge SPL transfer (warpBridge buildStage2 / runReverse prepend). */
  X1_HOP_SKIM: 0.01,
  /** $1 flat — the Warp bridge's OWN fee. Collected by the Warp program's fee
   *  account (not ours); we pass it through in quotes as bridgeFee. */
  WARP_FLAT_USD: 1,
  /** 1% — the LiFi integrator fee charged on every LiFi leg today. Collected by
   *  LiFi to our integrator account; the server forces it on every quote
   *  (api/lifi/quote.js) so the browser can't strip it. */
  LIFI_INTEGRATOR: 0.01,
  /** 0.5% — runbook spec for the same-chain class. NOT YET APPLIED: today's
   *  direct/LiFi routes charge LIFI_INTEGRATOR (1%). The 0.5% goes live in the
   *  any-swap phase; this PR keeps charges identical. */
  SAME_CHAIN: 0.005,
  /** 5% — runbook spec for the Escape Hatch class. NOT YET APPLIED: no
   *  escape-hatch path exists in code. The rate is defined here so the phase
   *  that builds it has one number to read. */
  ESCAPE_HATCH: 0.05,
} as const;

// ── FEE WALLETS — where OUR skims land (same addresses as the runbook) ──
export const FEE_WALLETS = {
  /** Solana-side skim — warpBridge buildStage2 (the Solana→X1 hop). */
  SVM: "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu",
  /** X1-side skim — warpBridge runReverse prepend (the X1→Solana burn). */
  X1: "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu",
} as const;

/** LiFi integrator string — LiFi collects integrator fees to this account. */
export const LIFI_INTEGRATOR_ACCOUNT = "x1-teleporter-labs";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
export type FeeClass =
  | "same-chain"      // 0.5% (runbook spec — NOT yet applied; see PR #7)
  | "x1-hop"          // 1% pre-bridge skim — applied today
  | "escape-hatch"    // 5% (runbook spec — NOT yet applied)
  | "thorchain-leg"   // future lane — no rate yet, throws
  | "non-x1-bridge";  // future lane — no rate yet, throws

export type FeeComponentId =
  | "lifi-integrator"    // LiFi's integrator fee on a LiFi leg
  | "warp-skim"          // our 1% pre-bridge skim
  | "warp-flat"          // the Warp program's own flat $1 (passthrough)
  | "escape-hatch-skim"; // the 5% escape-hatch skim (future)

export type FeeCollector =
  | "lifi-integrator" // LiFi integrator account (LIFI_INTEGRATOR_ACCOUNT)
  | "fee-wallet-svm"  // FEE_WALLETS.SVM
  | "fee-wallet-x1"   // FEE_WALLETS.X1
  | "warp-program";   // the Warp bridge's own fee account (not ours)

export type FeeLeg = "source" | "pre-bridge" | "bridge" | "lifi-leg";

export type FeeApplicationPoint =
  | "lifi-fee"            // charged by LiFi inside the swap/bridge leg
  | "pre-bridge-transfer" // our SPL transfer instruction BEFORE the bridge call
  | "on-chain"            // deducted by the Warp program inside BridgeOut
  | "quote";              // shown in the quote box (display)

/** What amount a component is computed against.
 *  "source" = the user's input amount. Later-leg components are computed on
 *  what actually arrived on that leg (e.g. the stage-2 skim on x1 routes takes
 *  1% of what LiFi delivered, not of the original input). */
export type FeeBase = "source" | "leg-1-delivered" | "leg-2-delivered";

export interface FeeRoute {
  from: string;
  to: string;
  /** Optional — derived via determineRoute(from, to) when omitted. */
  routeType?: RouteType;
  /** Optional — only needed for amount math; classification works without it. */
  amount?: number;
  /** Opt-in Escape Hatch path (future). When true, the route is escape-hatch. */
  escapeHatch?: boolean;
  /** Opt-in THORChain lane (future). When true, computeFee throws. */
  thorchain?: boolean;
  /** Opt-in non-X1 bridge integration (future). When true, computeFee throws. */
  nonX1Bridge?: boolean;
}

export interface FeeComponent {
  id: FeeComponentId;
  label: string;
  kind: "rate" | "flat";
  /** Decimal rate when kind === "rate" (0.01 = 1%). */
  rate?: number;
  /** Flat USD when kind === "flat". */
  flatUsd?: number;
  /** Which wallet/account collects it. */
  collector: FeeCollector;
  /** Which leg of the journey takes it. */
  leg: FeeLeg;
  /** How/when it is applied. */
  applied: FeeApplicationPoint;
  /** What amount base it is computed against. */
  base: FeeBase;
  /** USD amount on a given base (rate: base * rate; flat: flatUsd). */
  amountUsd: (amount: number) => number;
}

export interface FeeStructure {
  /** Exactly ONE class per route — a route is never charged by two classes. */
  class: FeeClass;
  label: string;
  /** The class's headline rate (runbook spec): x1-hop 1%, same-chain 0.5%,
   *  escape-hatch 5%. This is the CLASS rate — see components for what is
   *  actually charged today. */
  headlineRate: number | null;
  components: FeeComponent[];
  /** Human summary of when/where the fee is applied. */
  applied: string;
  /** Look up a component by id — throws if this class doesn't have it. */
  component: (id: FeeComponentId) => FeeComponent;
  hasComponent: (id: FeeComponentId) => boolean;
  /** Total fee taken off the SOURCE amount: source-based rate components +
   *  all flats. Components taken on a LATER leg's delivered amount (the
   *  stage-2 skim on x1 routes, the leg-2 integrator on x1_onward) are NOT
   *  included — compute those with component(id).amountUsd(deliveredAmount).
   *  For pure-Warp routes this equals what the quote box shows today. */
  feeUsd: (amount: number) => number;
  /** amount - feeUsd(amount). */
  netUsd: (amount: number) => number;
}

export class FeeNotImplementedError extends Error {
  feeClass: FeeClass;
  constructor(feeClass: FeeClass, message: string) {
    super(`[${feeClass}] ${message}`);
    this.name = "FeeNotImplementedError";
    this.feeClass = feeClass;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION — a route falls into EXACTLY ONE fee class, never two.
// Precedence for the opt-in flags: escapeHatch > thorchain > nonX1Bridge.
// Conflicting opt-ins throw (silently picking one would hide a double-charge).
// ─────────────────────────────────────────────────────────────────────────────
export function classifyRoute(route: FeeRoute): FeeClass {
  const opted: FeeClass[] = [];
  if (route.escapeHatch) opted.push("escape-hatch");
  if (route.thorchain) opted.push("thorchain-leg");
  if (route.nonX1Bridge) opted.push("non-x1-bridge");
  if (opted.length > 1) {
    throw new Error(`Conflicting fee-class opt-ins: ${opted.join(", ")} — a route can only be one class.`);
  }
  if (opted.length === 1) return opted[0];

  const rt = route.routeType ?? determineRoute(route.from, route.to);
  // Every route whose journey includes the Warp bridge (into or out of X1) is
  // an x1-hop. Checked FIRST so a LiFi leg can never re-classify it as
  // same-chain — that is the double-charge trap this ordering kills.
  if (rt === "x1" || rt === "sol_x1" || rt === "x1_reverse" || rt === "x1_onward") {
    return "x1-hop";
  }
  // Everything else (EVM↔EVM, EVM↔Sol, Sol↔Sol via LiFi) is the same-chain /
  // non-X1 lane. (X1-source routes with REVERSE_ENABLED=false also land here
  // via determineRoute → "direct" — they can never execute, so no skim.)
  return "same-chain";
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT FACTORIES + STRUCTURE BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function rateComponent(
  id: FeeComponentId,
  label: string,
  rate: number,
  collector: FeeCollector,
  leg: FeeLeg,
  applied: FeeApplicationPoint,
  base: FeeBase,
): FeeComponent {
  return {
    id, label, kind: "rate", rate, collector, leg, applied, base,
    amountUsd: (amount: number) => amount * rate,
  };
}

function flatComponent(
  id: FeeComponentId,
  label: string,
  flatUsd: number,
  collector: FeeCollector,
  leg: FeeLeg,
  applied: FeeApplicationPoint,
): FeeComponent {
  return {
    id, label, kind: "flat", flatUsd, collector, leg, applied, base: "source",
    amountUsd: () => flatUsd,
  };
}

function makeStructure(
  cls: FeeClass,
  label: string,
  headlineRate: number | null,
  components: FeeComponent[],
  applied: string,
): FeeStructure {
  const byId = new Map(components.map((c) => [c.id, c]));
  const feeUsd = (amount: number) =>
    components.reduce((sum, c) => {
      if (c.kind === "flat") return sum + (c.flatUsd ?? 0);
      return c.base === "source" ? sum + c.amountUsd(amount) : sum;
    }, 0);
  return {
    class: cls,
    label,
    headlineRate,
    components,
    applied,
    component(id) {
      const c = byId.get(id);
      if (!c) {
        throw new Error(`[${cls}] has no fee component "${id}" — a route is charged by exactly one fee class.`);
      }
      return c;
    },
    hasComponent: (id) => byId.has(id),
    feeUsd,
    netUsd: (amount: number) => Math.max(0, amount - feeUsd(amount)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-CLASS BUILDERS
// ─────────────────────────────────────────────────────────────────────────────
function x1HopFee(route: FeeRoute): FeeStructure {
  const rt = route.routeType ?? determineRoute(route.from, route.to);
  const components: FeeComponent[] = [];

  // LiFi legs carry the integrator fee (collected by LiFi, not us):
  //   x1 (EVM→X1)        → leg 1 is LiFi, fee on the source input.
  //   x1_onward (X1→EVM) → leg 2 is LiFi, fee on the leg-1 net that arrives.
  if (rt === "x1" || rt === "x1_onward") {
    components.push(rateComponent(
      "lifi-integrator",
      "LiFi integrator fee",
      FEE_RATES.LIFI_INTEGRATOR,
      "lifi-integrator",
      "lifi-leg",
      "lifi-fee",
      rt === "x1" ? "source" : "leg-2-delivered",
    ));
  }

  // Our 1% pre-bridge skim — source side, SPL transfer to OUR fee wallet.
  // Reverse routes (X1→…) collect on the X1 wallet; forward routes on SVM.
  const skimWallet: FeeCollector =
    rt === "x1_reverse" || rt === "x1_onward" ? "fee-wallet-x1" : "fee-wallet-svm";
  components.push(rateComponent(
    "warp-skim",
    "Teleporter 1% pre-bridge skim",
    FEE_RATES.X1_HOP_SKIM,
    skimWallet,
    "pre-bridge",
    "pre-bridge-transfer",
    // x1 (EVM→X1): stage 2 skims what LiFi DELIVERED, not the original input.
    rt === "x1" ? "leg-1-delivered" : "source",
  ));

  // The Warp bridge's own flat $1 — collected by the Warp program (not us),
  // deducted inside BridgeOut on-chain. Passthrough in every quote.
  components.push(flatComponent(
    "warp-flat",
    "Warp bridge flat fee",
    FEE_RATES.WARP_FLAT_USD,
    "warp-program",
    "bridge",
    "on-chain",
  ));

  return makeStructure(
    "x1-hop",
    "X1 hop — 1% pre-bridge skim + Warp's $1",
    FEE_RATES.X1_HOP_SKIM,
    components,
    "1% skim is taken on the source side as a pre-bridge SPL transfer to our fee wallet; "
      + "the Warp program then takes its own flat $1 inside BridgeOut. LiFi legs also carry "
      + "the integrator fee (1%, collected by LiFi).",
  );
}

function sameChainFee(_route: FeeRoute): FeeStructure {
  return makeStructure(
    "same-chain",
    "Same-chain / non-X1 LiFi lane — 0.5% (runbook spec, NOT yet applied)",
    FEE_RATES.SAME_CHAIN,
    [
      rateComponent(
        "lifi-integrator",
        "LiFi integrator fee",
        FEE_RATES.LIFI_INTEGRATOR,
        "lifi-integrator",
        "lifi-leg",
        "lifi-fee",
        "source",
      ),
    ],
    "Collected by LiFi on the quote (fee param, server-forced at api/lifi/quote.js). "
      + "The 0.5% same-chain rate is the runbook spec for the any-swap phase — it is NOT "
      + "wired yet; direct routes still charge the 1% integrator fee today (see PR #7).",
  );
}

function escapeHatchFee(_route: FeeRoute): FeeStructure {
  return makeStructure(
    "escape-hatch",
    "Escape Hatch — 5% (runbook spec, NOT yet applied)",
    FEE_RATES.ESCAPE_HATCH,
    [
      rateComponent(
        "escape-hatch-skim",
        "Escape Hatch skim",
        FEE_RATES.ESCAPE_HATCH,
        "fee-wallet-x1",
        "source",
        "pre-bridge-transfer",
        "source",
      ),
    ],
    "Emergency escape path (future) — NOT yet applied. No escape-hatch path exists in code yet; "
      + "this rate is defined so the phase that builds it has one number to read. Collector wallet is "
      + "a placeholder (FEE_WALLETS.X1) pending that phase's design.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// computeFee — the ONE function every caller reads.
// ─────────────────────────────────────────────────────────────────────────────
export function computeFee(route: FeeRoute): FeeStructure {
  switch (classifyRoute(route)) {
    case "x1-hop":
      return x1HopFee(route);
    case "same-chain":
      return sameChainFee(route);
    case "escape-hatch":
      return escapeHatchFee(route);
    case "thorchain-leg":
      throw new FeeNotImplementedError(
        "thorchain-leg",
        "The THORChain lane lands in its own phase (Step 2.x) — no fee rate is defined yet. "
          + "Do not charge a guessed rate on this lane.",
      );
    case "non-x1-bridge":
      throw new FeeNotImplementedError(
        "non-x1-bridge",
        "Non-X1 bridge integrations land in the any-swap phase — no fee rate is defined yet. "
          + "Do not charge a guessed rate on this lane.",
      );
  }
}
