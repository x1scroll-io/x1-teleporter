/**
 * fees.ts — THE single source of truth for every Teleporter fee.
 *
 * FEE POLICY (Mr. Esters, 2026-09-02 — FEE-MODEL v2, SUPERSEDES the
 * 2026-08-28 1%-once policy wherever they disagree):
 *   "Teleporter's fee is 0.5% of the route total, CAPPED at $250 max per
 *    trade, charged once per journey, regardless of hop count."
 *   teleporterFee = min(routeTotal * 0.005, 250)
 *
 * Concretely, per class:
 *   - x1-hop (sol_x1, x1, x1_reverse, x1_onward — every journey that touches
 *     the Warp bridge): the ONLY Teleporter fee is the 0.5% pre-bridge skim
 *     (warp-skim, capped at $250). The LiFi integrator fee is REMOVED from
 *     this class — integrator param is forced to 0 (see api/lifi/quote.js +
 *     the lifiIntegratorFeeFor() helper) so the stage-2 on-chain skim is the
 *     only Teleporter fee. The Warp program's own fee (warp-flat for
 *     USDC.x, warp-pct for wSOL.X) is a THIRD-PARTY pass-through collected
 *     by the Warp program — carried as a separate component labeled "Warp
 *     bridge fee", never as a Teleporter fee.
 *   - same-chain (every non-X1 LiFi route): the 0.5% LiFi integrator fee IS
 *     the once-per-journey Teleporter fee (capped at $250 in the quote).
 *   - escape-hatch: 5% — a NAMED EXCEPTION to the 0.5%-once rule (Mr. Esters,
 *     fee policy). The fee rule is about bridging; the escape hatch is a
 *     rescue service for chains nothing else serves — a different product at
 *     a premium price, deliberately, labeled as such in the quote. Carve-out
 *     (verbatim): "Teleporter fee is 0.5% once per journey, capped at $250;
 *     the PulseChain escape hatch is a separate rescue product at 5%, labeled
 *     as such in the quote." No escape-hatch path exists in code yet.
 *   - thorchain-leg (Workstream A — the BTC/DOGE/LTC/XRP → SOL.SOL lane):
 *     the user sees THREE fee lines before sending — THORChain affiliate
 *     (protocol fee), our 0.5% skim (Teleporter, capped at $250), Warp's own
 *     fee (third-party). The once-per-journey rule is about TELEPORTER's
 *     fee: the THORChain affiliate is a PROTOCOL fee (collected by THORChain
 *     to our THORName) and the Warp fee is a THIRD-PARTY pass-through
 *     (collected by the Warp program) — NEITHER counts toward Teleporter's
 *     0.5%. Teleporter's take on this lane is still min(0.5%, $250): the
 *     warp-skim on the Solana leg. All three are displayed before the user
 *     sends.
 *   - non-x1-bridge (future lane): no rate yet — it THROWS a descriptive
 *     FeeNotImplementedError instead of guessing a number.
 *
 * WARP FEE — VERIFIED ON-CHAIN 2026-09-02 (see the PR's fee-model section;
 * do NOT price on rumor): the live Warp config (api.bridge.mainnet.x1.xyz
 * /config) + fresh bridge_out logs on BOTH chains still show USDC.x/USDC
 * charging a FLAT $1 (flatFeeAmount 1000000, 0 bps — e.g. X1 burn
 * 2Vb6HgsU… gross 367.34 → token fee 1.00, and Solana lock 3cscs4Dx5…
 * "Token fee: 1000000" → collector +1.0 USDC) and wSOL.X/WSOL charging
 * exactly 25 bps (0.25% — e.g. X1 burn 7QH5SAaH3… gross 129.675 → fee
 * 324,187 base = 25bps). The rumored "USDC flat $1 → 0.25%" change did NOT
 * happen. The Solana-side release (bridge_in_v2) charges NO separate fee
 * (the fee is charged once, on the source-side bridge_out). So the Warp
 * pass-through components below are UNCHANGED from the verified structure.
 *
 * INVARIANT (tested): for EVERY route class EXCEPT escape-hatch (the named
 * 5% rescue product), the sum of Teleporter-owned components
 * (teleporterFeeUsd) is exactly min(0.5% of the journey total, $250) — never
 * more. Third-party pass-throughs (warp-flat, warp-pct, thorchain-affiliate)
 * and protocol fees are labeled and summed separately.
 *
 * THE $250 CAP vs EXECUTABLE JOURNEYS: the cap binds only above a $50,000
 * route total. Warp's own per-tx maxAmount (live config: USDC 5,000 /
 * wSOL 50 / cbBTC 0.0625 / ETH 2) and the THORChain lane's max swap
 * (THORCHAIN_MAX_SWAP_BTC_EQUIVALENT 0.05 BTC) keep every executable
 * journey far below that — the on-chain skims (buildStage2 / runReverse,
 * SKIM_BPS = 50) therefore charge the pure 0.5% rate, which the cap never
 * reduces today. The cap is enforced in this USD accounting layer (the
 * quote box) and is the policy ceiling.
 *
 * PURE MODULE: no DOM, no fetch, no wallet, no chain imports. Runnable under
 * `node --test` (type stripping) exactly like routes.ts / flags.ts.
 *
 * ADAPTATION NOTE (runbook `lib/fees.ts` → repo `src/lib/fees.ts`):
 *   This is a Vite project — there is no root-level lib/. The established
 *   pattern is src/lib/ (flags.ts, routes.ts, lifiApproval.js, simulateTx.js),
 *   so computeFee lives at src/lib/fees.ts.
 */
import { determineRoute, type RouteType } from "./routes.ts";
import { THORCHAIN_AFFILIATE_BPS } from "./thorchain/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// RATES — the fee policy rates (all classes 0.5% once, capped at $250 — with
// ONE named exception: escape-hatch at 5%, the separate rescue product).
// ─────────────────────────────────────────────────────────────────────────────
export const FEE_RATES = {
  /** 0.5% — the X1-hop pre-bridge skim. Applied TODAY, source side, as a
   *  pre-bridge SPL transfer (warpBridge buildStage2 / runReverse prepend).
   *  For x1-class routes this is THE Teleporter fee — the only one. Capped
   *  at $250 (TELEPORTER_FEE_CAP_USD) — fee-model v2 (2026-09-02). */
  X1_HOP_SKIM: 0.005,
  /** $1 flat — the Warp bridge's OWN fee for USDC.x/USDC (VERIFIED on-chain
   *  2026-09-02: live config flatFeeAmount 1000000 + bridge_out logs
   *  "Token fee: 1000000" on both chains — the rumored flat→0.25% change
   *  did NOT happen). Collected by the Warp program's fee account (not
   *  ours); we pass it through in quotes as a third-party component labeled
   *  "Warp bridge fee". NOT a Teleporter fee. wSOL.X/WSOL charge 25 bps
   *  instead (warp-pct, 25 bps — also verified). */
  WARP_FLAT_USD: 1,
  /** 0.5% — the LiFi integrator fee. For same-chain (non-X1) routes this IS
   *  the once-per-journey Teleporter fee (collected by LiFi to our integrator
   *  account; the server forces it on every non-X1 quote — api/lifi/quote.js
   *  + api/_lifi.js INTEGRATOR_FEE — so the browser can't strip it). For
   *  x1-class routes it is ABSENT (policy — the fee key is omitted from the
   *  query entirely, never fee=0). OPS: the LiFi portal config for
   *  x1-teleporter-labs must charge 0.5% to match (verify before any
   *  same-chain go-live). */
  LIFI_INTEGRATOR: 0.005,
  /** 0.5% — same-chain class rate (policy, fee-model v2 2026-09-02 — was 1%
   *  under the 2026-08-28 policy; the fee is now 0.5% capped at $250, once). */
  SAME_CHAIN: 0.005,
  /** 5% — escape-hatch class rate — NAMED EXCEPTION to the 0.5%-once rule
   *  (Mr. Esters, fee policy): the fee rule is about bridging; the escape
   *  hatch is a rescue service for chains nothing else serves — a separate
   *  rescue product at a premium price, deliberately, labeled as such in the
   *  quote. Carve-out (verbatim): "Teleporter fee is 0.5% once per journey,
   *  capped at $250; the PulseChain escape hatch is a separate rescue product
   *  at 5%, labeled as such in the quote." NOT YET APPLIED — no escape-hatch
   *  path exists. */
  ESCAPE_HATCH: 0.05,
} as const;

/** FEE-MODEL v2 CAP (Mr. Esters, 2026-09-02): the Teleporter fee is 0.5% of
 *  the route total, CAPPED at $250 max per trade. Every Teleporter-owned
 *  component (party === "teleporter") computes
 *  amountUsd = min(amount * rate, TELEPORTER_FEE_CAP_USD). */
export const TELEPORTER_FEE_CAP_USD = 250;

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
  | "same-chain"      // 0.5% LiFi integrator = the once-per-journey Teleporter fee (capped $250)
  | "x1-hop"          // 0.5% pre-bridge skim = the once-per-journey Teleporter fee (capped $250)
  | "escape-hatch"    // 5% — NAMED EXCEPTION to the 0.5%-once rule (separate rescue product); NOT yet applied
  | "thorchain-leg"   // Workstream A — 0.5% Teleporter skim + THORChain affiliate (protocol) + Warp's own fee (third-party), all shown before send
  | "non-x1-bridge";  // future lane — no rate yet, throws

export type FeeComponentId =
  | "lifi-integrator"    // LiFi's integrator fee on a LiFi leg — the Teleporter fee on same-chain routes; 0 on x1-class routes
  | "warp-skim"          // our 0.5% pre-bridge skim (capped $250) — the Teleporter fee on x1-class routes
  | "warp-flat"          // the Warp program's own flat $1 for USDC.x/USDC (third-party pass-through — VERIFIED on-chain 2026-09-02, labeled "Warp bridge fee")
  | "warp-pct"           // the Warp program's percentage fee (third-party pass-through — used when the token charges bps instead of a flat fee, e.g. wSOL.X 25bps)
  | "thorchain-affiliate" // the THORChain PROTOCOL affiliate fee paid to our THORName (third-party — NEVER a Teleporter fee)
  | "escape-hatch-skim"; // the escape-hatch skim (future, 5% — named exception, rescue product)

/** Who owns the money: "teleporter" = collected to OUR wallets/integrator
 *  account (counts toward the 0.5%-capped once-per-journey take);
 *  "third-party" = pass-through collected by someone else (Warp's $1/25bps
 *  today, THORChain / provider costs later) — shown separately, never
 *  labeled a Teleporter fee. */
export type FeeParty = "teleporter" | "third-party";

export type FeeCollector =
  | "lifi-integrator" // LiFi integrator account (LIFI_INTEGRATOR_ACCOUNT)
  | "fee-wallet-svm"  // FEE_WALLETS.SVM
  | "fee-wallet-x1"   // FEE_WALLETS.X1
  | "warp-program"    // the Warp bridge's own fee account (not ours)
  | "thorchain-affiliate"; // our THORName on THORChain — the PROTOCOL affiliate collector (not ours to keep; THORChain pays it to the THORName)

export type FeeLeg = "source" | "pre-bridge" | "bridge" | "lifi-leg";

export type FeeApplicationPoint =
  | "lifi-fee"            // charged by LiFi inside the swap/bridge leg
  | "pre-bridge-transfer" // our SPL transfer instruction BEFORE the bridge call
  | "on-chain"            // deducted by the Warp program inside BridgeOut
  | "quote";              // shown in the quote box (display)

/** What amount a component is computed against.
 *  "source" = the user's input amount. Later-leg components are computed on
 *  what actually arrived on that leg (e.g. the stage-2 skim on x1 routes takes
 *  0.5% of what LiFi delivered, not of the original input). */
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
  /** Opt-in THORChain lane (Workstream A). The thorchain-leg class shows
   *  three fee lines before sending (affiliate + skim + Warp's $1). */
  thorchain?: boolean;
  /** Opt-in THORChain affiliate bps override — defaults to the config value
   *  (THORCHAIN_AFFILIATE_BPS, start 100). The affiliate is a THORChain
   *  PROTOCOL fee paid to our THORName — it never counts toward Teleporter's
   *  1% (see the class docs). Tests vary this; production reads config. */
  affiliateBps?: number;
  /** Opt-in Warp percentage-fee override (bps) — when set, the Warp bridge
   *  fee component becomes a RATE (third-party pass-through) instead of the
   *  flat $1: the Warp token registry charges some tokens a percentage fee
   *  (e.g. wSOL.X = 25 bps, flat 0) instead of the USDC.x flat $1. NEVER a
   *  Teleporter fee — same third-party pass-through semantics as warp-flat,
   *  labeled "Warp bridge fee (x.x%)". Computed on the post-skim bridge
   *  gross (what Warp actually charges against, on-chain). */
  warpFeeBps?: number;
  /** Opt-in non-X1 bridge integration (future). When true, computeFee throws. */
  nonX1Bridge?: boolean;
}

export interface FeeComponent {
  id: FeeComponentId;
  label: string;
  kind: "rate" | "flat";
  /** Decimal rate when kind === "rate" (0.005 = 0.5%). */
  rate?: number;
  /** Flat USD when kind === "flat". */
  flatUsd?: number;
  /** Fee-model v2 cap (USD) on a rate component: amountUsd = min(amount *
   *  rate, capUsd). Every Teleporter-owned rate component carries
   *  TELEPORTER_FEE_CAP_USD (250). */
  capUsd?: number;
  /** Who owns the money — teleporter (counts toward the 0.5%-capped take) or
   *  third-party (pass-through, shown separately, never labeled Teleporter). */
  party: FeeParty;
  /** Which wallet/account collects it. */
  collector: FeeCollector;
  /** Which leg of the journey takes it. */
  leg: FeeLeg;
  /** How/when it is applied. */
  applied: FeeApplicationPoint;
  /** What amount base it is computed against. */
  base: FeeBase;
  /** USD amount on a given base (rate: min(base * rate, capUsd); flat:
   *  flatUsd). */
  amountUsd: (amount: number) => number;
}

export interface FeeStructure {
  /** Exactly ONE class per route — a route is never charged by two classes. */
  class: FeeClass;
  label: string;
  /** The class's headline rate (policy): every class is 0.5%, once, capped
   *  at $250 — with ONE named exception: escape-hatch 5% (the rescue
   *  product). x1-hop 0.5% (skim), same-chain 0.5% (integrator),
   *  escape-hatch 5% (exception). */
  headlineRate: number | null;
  components: FeeComponent[];
  /** Human summary of when/where the fee is applied. */
  applied: string;
  /** Look up a component by id — throws if this class doesn't have it. */
  component: (id: FeeComponentId) => FeeComponent;
  hasComponent: (id: FeeComponentId) => boolean;
  /** POLICY NUMBER: the total Teleporter take for a journey total of `amount`
   *  — the sum of ONLY the Teleporter-owned components (party === "teleporter"),
   *  each computed against the passed amount. For every class this must be
   *  exactly min(0.5% of `amount`, $250) (never more) — tested — EXCEPT
   *  escape-hatch, which is the named 5% rescue product (Mr. Esters, fee
   *  policy). */
  teleporterFeeUsd: (amount: number) => number;
  /** The third-party pass-through components (warp-flat today; THORChain /
   *  provider costs later) — clearly labeled, never counted as Teleporter. */
  thirdPartyComponents: FeeComponent[];
  /** Sum of the third-party pass-through components on `amount`. */
  thirdPartyFeeUsd: (amount: number) => number;
  /** Total fee off the SOURCE amount: every component computed on the passed
   *  amount (the quote-box view — what "you receive" is net of). For live-leg
   *  math (e.g. the stage-2 skim on what LiFi actually delivered) use
   *  component(id).amountUsd(deliveredAmount) instead. */
  feeUsd: (amount: number) => number;
  /** amount - feeUsd(amount). */
  netUsd: (amount: number) => number;
}

/** One display line for the quote box — every line renders from computeFee,
 *  never a hardcoded fee string. Future THORChain/provider costs appear here
 *  automatically once their components land in their class's structure. */
export interface FeeLine {
  id: FeeComponentId;
  label: string;
  amountUsd: number;
  party: FeeParty;
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

/** POLICY: is this routeType an x1-class route (touches the Warp bridge)?
 *  sol_x1, x1, x1_reverse, x1_onward — the classes where the stage-2 skim is
 *  the ONLY Teleporter fee and the LiFi fee param is OMITTED entirely. */
export function isX1ClassRoute(routeType: RouteType): boolean {
  return routeType === "sol_x1" || routeType === "x1" || routeType === "x1_reverse" || routeType === "x1_onward";
}

/** POLICY: the LiFi integrator fee param for a routeType — ABSENT (null) on
 *  x1-class routes (the stage-2 skim is the only Teleporter fee; the fee key
 *  is OMITTED from the LI.Fi query entirely — absent means absent, never
 *  fee=0), 1% on non-X1 routes (the integrator IS the once-per-journey
 *  Teleporter fee). */
export function lifiIntegratorFeeFor(routeType: RouteType): number | null {
  return isX1ClassRoute(routeType) ? null : FEE_RATES.LIFI_INTEGRATOR;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT FACTORIES + STRUCTURE BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function rateComponent(
  id: FeeComponentId,
  label: string,
  rate: number,
  party: FeeParty,
  collector: FeeCollector,
  leg: FeeLeg,
  applied: FeeApplicationPoint,
  base: FeeBase,
  capUsd?: number,
): FeeComponent {
  return {
    id, label, kind: "rate", rate, party, collector, leg, applied, base, capUsd,
    amountUsd: (amount: number) =>
      capUsd != null ? Math.min(amount * rate, capUsd) : amount * rate,
  };
}

function flatComponent(
  id: FeeComponentId,
  label: string,
  flatUsd: number,
  party: FeeParty,
  collector: FeeCollector,
  leg: FeeLeg,
  applied: FeeApplicationPoint,
): FeeComponent {
  return {
    id, label, kind: "flat", flatUsd, party, collector, leg, applied, base: "source",
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
  const sum = (list: FeeComponent[], amount: number) =>
    list.reduce((s, c) => s + c.amountUsd(amount), 0);
  const teleporter = components.filter((c) => c.party === "teleporter");
  const thirdParty = components.filter((c) => c.party === "third-party");
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
    teleporterFeeUsd: (amount: number) => sum(teleporter, amount),
    thirdPartyComponents: thirdParty,
    thirdPartyFeeUsd: (amount: number) => sum(thirdParty, amount),
    feeUsd: (amount: number) => sum(components, amount),
    netUsd: (amount: number) => Math.max(0, amount - sum(components, amount)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-CLASS BUILDERS
// ─────────────────────────────────────────────────────────────────────────────
function x1HopFee(route: FeeRoute): FeeStructure {
  const rt = route.routeType ?? determineRoute(route.from, route.to);
  const components: FeeComponent[] = [];

  // POLICY: x1-class routes carry NO LiFi integrator fee — the fee param is
  // OMITTED from the LI.Fi query entirely (absent means absent — never fee=0;
  // api/lifi/quote.js + lifiIntegratorFeeFor()) so the stage-2 skim below is
  // the ONLY Teleporter fee on the journey.

  // Our 0.5% pre-bridge skim (capped at $250) — source side, SPL transfer
  // to OUR fee wallet. Reverse routes (X1→…) collect on the X1 wallet;
  // forward routes on SVM.
  const skimWallet: FeeCollector =
    rt === "x1_reverse" || rt === "x1_onward" ? "fee-wallet-x1" : "fee-wallet-svm";
  components.push(rateComponent(
    "warp-skim",
    "Teleporter fee (0.5%, max $250)",
    FEE_RATES.X1_HOP_SKIM,
    "teleporter",
    skimWallet,
    "pre-bridge",
    "pre-bridge-transfer",
    // x1 (EVM→X1): stage 2 skims what LiFi DELIVERED, not the original input.
    rt === "x1" ? "leg-1-delivered" : "source",
    TELEPORTER_FEE_CAP_USD,
  ));

  // The Warp bridge's own fee — collected by the Warp program (not us),
  // deducted inside BridgeOut on-chain. THIRD-PARTY pass-through, labeled
  // "Warp bridge fee" (never "Teleporter fee"). Two shapes, token-driven
  // (live Warp config, VERIFIED on-chain 2026-09-02 — the rumored USDC
  // flat→0.25% change did NOT happen): USDC.x charges a flat $1 (warp-flat);
  // wSOL.X charges a 25 bps percentage (warp-pct) — the bps override
  // switches the component.
  if (route.warpFeeBps && route.warpFeeBps > 0) {
    components.push(rateComponent(
      "warp-pct",
      `Warp bridge fee (${(route.warpFeeBps / 100).toFixed(2)}%)`,
      route.warpFeeBps / 10_000,
      "third-party",
      "warp-program",
      "bridge",
      "on-chain",
      "source",
    ));
  } else {
    components.push(flatComponent(
      "warp-flat",
      "Warp bridge fee ($1 flat)",
      FEE_RATES.WARP_FLAT_USD,
      "third-party",
      "warp-program",
      "bridge",
      "on-chain",
    ));
  }

  return makeStructure(
    "x1-hop",
    "X1 hop — 0.5% Teleporter skim (once, max $250) + Warp's own fee (third-party)",
    FEE_RATES.X1_HOP_SKIM,
    components,
    "Teleporter's fee is the 0.5% pre-bridge skim (capped at $250), taken on "
      + "the source side as an SPL transfer to our fee wallet — charged once per "
      + "journey (LiFi integrator fee is omitted on x1-class routes by policy). "
      + "The Warp program then takes its own fee inside BridgeOut — USDC.x: flat "
      + "$1, wSOL.X: 25 bps (verified on-chain 2026-09-02) — a third-party "
      + "pass-through, not a Teleporter fee.",
  );
}

function sameChainFee(_route: FeeRoute): FeeStructure {
  return makeStructure(
    "same-chain",
    "Same-chain / non-X1 LiFi lane — 0.5% Teleporter fee (max $250), once per journey",
    FEE_RATES.SAME_CHAIN,
    [
      rateComponent(
        "lifi-integrator",
        "Teleporter fee (0.5%, max $250)",
        FEE_RATES.LIFI_INTEGRATOR,
        "teleporter",
        "lifi-integrator",
        "lifi-leg",
        "lifi-fee",
        "source",
        TELEPORTER_FEE_CAP_USD,
      ),
    ],
    "The 0.5% LiFi integrator fee IS the once-per-journey Teleporter fee on "
      + "non-X1 routes (fee-model v2, 2026-09-02 — was 1% under the 2026-08-28 "
      + "policy; now 0.5% capped at $250). Collected by LiFi to our integrator "
      + "account; the server forces it on every non-X1 quote (api/lifi/quote.js) "
      + "so the browser can't strip it.",
  );
}

function escapeHatchFee(_route: FeeRoute): FeeStructure {
  return makeStructure(
    "escape-hatch",
    "Escape hatch (rescue) — 5% (named exception to the 0.5%-once rule; NOT yet applied)",
    FEE_RATES.ESCAPE_HATCH,
    [
      rateComponent(
        "escape-hatch-skim",
        "Escape hatch (rescue) 5%",
        FEE_RATES.ESCAPE_HATCH,
        "teleporter",
        "fee-wallet-x1",
        "source",
        "pre-bridge-transfer",
        "source",
      ),
    ],
    "Emergency escape path (future) — NOT yet applied. NAMED EXCEPTION to the "
      + "0.5%-once rule (Mr. Esters, fee policy): the fee rule is about bridging; "
      + "the escape hatch is a rescue service for chains nothing else serves — a "
      + "separate rescue product at a premium price, deliberately, labeled as such "
      + "in the quote. Carve-out (verbatim): \"Teleporter fee is 0.5% once per "
      + "journey, capped at $250; the PulseChain escape hatch is a separate rescue "
      + "product at 5%, labeled as such in the quote.\" Collector wallet is a "
      + "placeholder (FEE_WALLETS.X1) pending that phase's design.",
  );
}

/** The THORChain affiliate bps for a route — the route override wins, the
 *  config value (THORCHAIN_AFFILIATE_BPS, start 100) is the default. The
 *  affiliate is a THORChain PROTOCOL fee, not Teleporter's 1% (policy note
 *  in the thorchain-leg builder). */
function thorchainAffiliateBps(route: FeeRoute): number {
  return route.affiliateBps ?? THORCHAIN_AFFILIATE_BPS;
}

/**
 * thorchain-leg — the THORChain lane (Workstream A: native BTC/DOGE/LTC/XRP
 * → SOL.SOL, then the existing Solana→X1 hop).
 *
 * THREE fee lines, ALL displayed before the user sends (the brief's Panel 1
 * fee display, docs/BRIEF.md Workstream A):
 *   1. thorchain-affiliate — the THORChain PROTOCOL affiliate fee, rate from
 *      config (affiliateBps, start 100), collected by THORChain to our
 *      THORName. POLICY: the once-per-journey rule is about TELEPORTER's
 *      fee; the THORChain affiliate is a PROTOCOL fee — it does NOT count
 *      toward Teleporter's 0.5%. Rendered as a third-party/protocol line.
 *   2. warp-skim — our 0.5% pre-bridge skim on the Solana leg (capped at
 *      $250): THE Teleporter fee on this lane. 0.5%, once.
 *   3. warp-flat — the Warp program's own flat $1 for USDC.x: a THIRD-PARTY
 *      pass-through (collected by the Warp program, not us), labeled "Warp
 *      bridge fee ($1 flat)" — VERIFIED on-chain 2026-09-02 (USDC.x still
 *      charges flat $1, not 0.25%). POLICY: it does NOT count toward
 *      Teleporter's 0.5% either.
 *
 * The capped-once invariant holds: teleporterFeeUsd(amount) is exactly
 * min(0.5% of amount, $250) — the affiliate + Warp fee are third-party/
 * protocol lines summed separately. NO lifi-integrator component here (the
 * lane has no LiFi leg), and never a second Teleporter charge — no double
 * charge by construction (tested).
 */
function thorchainLegFee(route: FeeRoute): FeeStructure {
  const affiliateBps = thorchainAffiliateBps(route);
  return makeStructure(
    "thorchain-leg",
    "THORChain lane — 0.5% Teleporter skim (max $250) + THORChain affiliate (protocol) + Warp's own fee (third-party)",
    FEE_RATES.X1_HOP_SKIM,
    [
      // 1) THORChain PROTOCOL affiliate fee → our THORName, deducted by
      //    THORChain inside the swap. NOT a Teleporter fee (policy): the
      //    once-per-journey rule is about Teleporter's fee; the affiliate is
      //    the THORChain protocol's affiliate mechanism. Shown before send.
      rateComponent(
        "thorchain-affiliate",
        "THORChain affiliate (protocol fee)",
        affiliateBps / 10_000,
        "third-party",
        "thorchain-affiliate",
        "bridge",
        "on-chain",
        "source",
      ),
      // 2) OUR 0.5% pre-bridge skim on the Solana leg (capped at $250) — THE
      //    Teleporter fee on this lane (0.5%, once per journey; policy).
      rateComponent(
        "warp-skim",
        "Teleporter fee (0.5%, max $250)",
        FEE_RATES.X1_HOP_SKIM,
        "teleporter",
        "fee-wallet-svm",
        "pre-bridge",
        "pre-bridge-transfer",
        "source",
        TELEPORTER_FEE_CAP_USD,
      ),
      // 3) Warp's own flat $1 for USDC.x — THIRD-PARTY pass-through
      //    (collected by the Warp program, not us), labeled "Warp bridge fee
      //    ($1 flat)" — verified on-chain 2026-09-02. Not a Teleporter fee.
      flatComponent(
        "warp-flat",
        "Warp bridge fee ($1 flat)",
        FEE_RATES.WARP_FLAT_USD,
        "third-party",
        "warp-program",
        "bridge",
        "on-chain",
      ),
    ],
    "Three fees, all shown before the user sends: the THORChain affiliate "
      + "(protocol fee to our THORName, rate from config affiliateBps), our 0.5% "
      + "pre-bridge skim on the Solana leg (capped at $250 — THE once-per-journey "
      + "Teleporter fee; the policy covers Teleporter's fee only), and the Warp "
      + "program's own fee (USDC.x flat $1 — verified on-chain 2026-09-02; "
      + "third-party pass-through). Neither the affiliate nor Warp's fee counts "
      + "toward Teleporter's 0.5%.",
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
      return thorchainLegFee(route);
    case "non-x1-bridge":
      throw new FeeNotImplementedError(
        "non-x1-bridge",
        "Non-X1 bridge integrations land in the any-swap phase — no fee rate is defined yet. "
          + "Do not charge a guessed rate on this lane.",
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE-BOX HELPERS — the render feeds on these, never on hardcoded strings.
// ─────────────────────────────────────────────────────────────────────────────

export interface FeeQuote {
  /** One line per fee component — the quote box renders exactly these. */
  feeLines: FeeLine[];
  /** Sum of the Teleporter-owned lines (the 0.5%-capped once-per-journey take). */
  teleporterFeeUsd: number;
  /** Sum of the third-party pass-through lines (Warp's $1, later providers). */
  thirdPartyFeeUsd: number;
  /** teleporterFeeUsd + thirdPartyFeeUsd. */
  totalFeeUsd: number;
  /** amount minus ALL components — what "you receive" reflects. */
  netUsd: number;
}

/** Build the full quote-box fee picture for a journey of `amount`: every
 *  component as a display line, the Teleporter-only total, the third-party
 *  total, and the net after ALL of them. `exclude` drops components (e.g.
 *  warp-flat in Warp-handoff mode, where Warp charges their $1 on their side).
 *  Pure + exported so the quote rendering is unit-testable without React. */
export function quoteFees(route: FeeRoute, amount: number, exclude: FeeComponentId[] = []): FeeQuote {
  const fee = computeFee(route);
  const feeLines: FeeLine[] = fee.components
    .filter((c) => !exclude.includes(c.id))
    .map((c) => ({ id: c.id, label: c.label, amountUsd: c.amountUsd(amount), party: c.party }));
  const sum = (party: FeeParty) =>
    feeLines.filter((l) => l.party === party).reduce((s, l) => s + l.amountUsd, 0);
  const teleporterFeeUsd = sum("teleporter");
  const thirdPartyFeeUsd = sum("third-party");
  return {
    feeLines,
    teleporterFeeUsd,
    thirdPartyFeeUsd,
    totalFeeUsd: teleporterFeeUsd + thirdPartyFeeUsd,
    netUsd: Math.max(0, amount - teleporterFeeUsd - thirdPartyFeeUsd),
  };
}
