/**
 * journeyReadout.js — the pure itinerary model behind the Teleporter JOURNEY
 * READOUT (the sci-fi "teleport console" panel beside the swap card).
 *
 * WHAT IT IS: you log coordinates (a source chain + token + amount) and the
 * readout shows the EXACT step-by-step travel path the routing engine builds
 * to the destination — each leg drawn as a HOP, the bridge hops (Warp / the
 * LiFi cross-chain hop) and the swap legs (LiFi DEX-swap, DEX-direct) labelled
 * distinctly, the fees/skim pinned to the leg that actually charges them, and
 * any leg the hard liquidity gate (liquidityGate.js) blocks flagged BLOCKED
 * with its honest reason.
 *
 * REUSES THE EXISTING ROUTE/LEG DATA — not a parallel route model:
 *   - the hop order + leg identities come from the ENGINE's route/leg contract
 *     (src/engine/routePlanner.js FORWARD_LEG_IDS / REVERSE_LEG_IDS — the same
 *     ids the LegContract legs carry), so the readout can never drift from the
 *     route the engine actually runs;
 *   - the fee lines come from the quote picture the form already computed
 *     (quote.feeLines — fees.ts / quoteFees; ids warp-skim / warp-flat /
 *     warp-pct), matched by id onto the leg that charges them;
 *   - the blocked legs come from the SAME checkRouteLiquidity() verdict the form
 *     renders (its {legs, failures, message} shape).
 *
 * PURE MODULE: no DOM, no wallet, no fetch, no keys. Reads only the pure chain/
 * token registry (teleportConstants) + the warp-twin relation (tokenResolver)
 * + the engine leg-id contract. Runs under `node --test` and bundles into the
 * browser app alike (same contract as liquidityGate.js / teleportQuote.js).
 */

import { CHAINS } from "./teleportConstants.js";
import { resolveTwin } from "./tokenResolver.js";
import { FORWARD_LEG_IDS, REVERSE_LEG_IDS } from "../engine/routePlanner.js";

/** The engine leg ids this readout maps onto — the SAME contract arrays the
 *  planner uses, so a hop's `legId` is always a real engine leg id. */
export const JOURNEY_FORWARD_LEGS = FORWARD_LEG_IDS;
export const JOURNEY_REVERSE_LEGS = REVERSE_LEG_IDS;

/** Hop kinds. `src` / `dest` are the coordinate stations; `swap` is a
 *  DEX-swap leg (LiFi / DEX-direct); `bridge` is a bridge hop (Warp / the
 *  LiFi cross-chain hop); `release` is the automatic Warp guardians release. */
export const HOP_KINDS = Object.freeze(["swap", "bridge", "release"]);

const norm = (s) => String(s ?? "").trim().toUpperCase();

/** Chain display name (falls back to the raw id). */
function chainName(chain) {
  return CHAINS[chain]?.name || String(chain || "?").toUpperCase();
}

/** Chain glyph (falls back to the upper-cased id). */
function chainGlyph(chain) {
  return CHAINS[chain]?.glyph || String(chain || "?").toUpperCase().slice(0, 2);
}

/**
 * A deterministic sci-fi "grid coordinate" for a (chain, token) station — a
 * 4-hex stamp (FNV-1a). Stable across renders (pure hash, no randomness) so
 * the itinerary reads like logged coordinates, not noise.
 */
export function coordCode(chain, token) {
  const s = `${String(chain || "")}:${String(token || "")}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).toUpperCase().padStart(8, "0").slice(0, 4);
}

/** Build a coordinate station descriptor for a (chain, token) pair. */
export function makeStation(chain, token) {
  const code = coordCode(chain, token);
  return {
    chain,
    name: chainName(chain),
    glyph: chainGlyph(chain),
    token: norm(token) || null,
    code,
    coord: `${chainGlyph(chain)}·${code}`,
  };
}

/** The Solana-side token a given X1 destination lands as (the Warp twin) —
 *  USDC.x → USDC, wSOL.X → WSOL; defaults to USDC (back-compat). */
function solanaLandingToken(destToken) {
  return resolveTwin(destToken) || "USDC";
}

/** The engine leg id a hop maps to; used to build the order + to guard. */
function legKey(direction) {
  return direction === "reverse" ? JOURNEY_REVERSE_LEGS : JOURNEY_FORWARD_LEGS;
}

/** Index fee lines from the quote picture by their id (fees.ts component). */
function feeIndex(quote) {
  const out = {};
  for (const l of quote?.feeLines || []) {
    if (l && l.id) out[l.id] = { id: l.id, label: l.label, amountUsd: l.amountUsd };
  }
  return out;
}

/** Collect the fee components that belong to a bridge/Warp leg (the 0.5%
 *  Teleporter skim + the Warp program's own flat/pct pass-through). */
function warpFees(fees) {
  return ["warp-skim", "warp-flat", "warp-pct"].map((id) => fees[id]).filter(Boolean);
}

/** The LiFi leg's own fee components (x1-class LiFi carries none — policy),
 *  read from the quote so a future fee would surface where it applies. */
function lifiFees(fees) {
  return ["lifi", "lifi-fee", "lifi-integration"].map((id) => fees[id]).filter(Boolean);
}

/**
 * Build the forward itinerary (EVM → X1). The engine's travel legs are the
 * LiFi cross-chain leg then the Warp lock — mapped onto the engine's
 * FORWARD_LEG_IDS (evm-approval + x1-ata-create are pre-flight, not travel,
 * and are intentionally not drawn as hops).
 */
function buildForwardHops({ from, token, destToken, fees }) {
  const landing = solanaLandingToken(destToken);
  const srcSwaps = norm(token) !== norm(landing); // LiFi DEX-swaps the source into the bridgeable asset
  const hops = [
    {
      seq: 1,
      legId: "lifi-evm-bridge",
      kind: srcSwaps ? "swap" : "bridge",
      tool: "LiFi",
      action: srcSwaps ? "LiFi swap + bridge" : "LiFi bridge",
      from: makeStation(from, token),
      to: makeStation("sol", landing),
      fees: lifiFees(fees),
      note: "LiFi routes the source asset across the EVM → Solana hop (DEX-swap first when the source isn't the bridge hub).",
    },
    {
      seq: 2,
      legId: "warp-lock",
      kind: "bridge",
      tool: "Warp Bridge",
      action: "Warp Bridge",
      from: makeStation("sol", landing),
      to: makeStation("x1", destToken),
      fees: warpFees(fees),
      note: "Warp locks on Solana and mints the wrapped twin on X1 (the 0.5% Teleporter skim is taken here).",
    },
  ];
  return hops;
}

/**
 * Build the reverse itinerary (X1 → EVM). The engine's travel legs are the X1
 * Warp burn, the automatic guardians release, then the LiFi Solana→EVM leg —
 * mapped onto the engine's REVERSE_LEG_IDS.
 */
function buildReverseHops({ to, token, reverseToken, fees }) {
  const solanaSymbol = solanaLandingToken(reverseToken); // USDC | WSOL
  const destSwaps = norm(solanaSymbol) !== norm(token); // LiFi DEX-swaps the released asset into the dest stable
  const hops = [
    {
      seq: 1,
      legId: "x1-reverse-burn",
      kind: "bridge",
      tool: "Warp Bridge",
      action: "Warp burn",
      from: makeStation("x1", reverseToken),
      to: makeStation("sol", solanaSymbol),
      fees: warpFees(fees),
      note: "Warp burns the wrapped token on X1 (the 0.5% Teleporter skim is taken here) and signals the guardians.",
    },
    {
      seq: 2,
      legId: "warp-release-wait",
      kind: "release",
      tool: "Warp Guardians",
      action: "release (auto)",
      from: makeStation("sol", solanaSymbol),
      to: makeStation("sol", solanaSymbol),
      fees: [],
      note: "The official submitter releases the unwrapped token on Solana — automatic, no signature.",
    },
    {
      seq: 3,
      legId: "lifi-solana-out",
      kind: destSwaps ? "swap" : "bridge",
      tool: "LiFi",
      action: destSwaps ? "LiFi swap + bridge" : "LiFi bridge",
      from: makeStation("sol", solanaSymbol),
      to: makeStation(to, token),
      fees: lifiFees(fees),
      note: "LiFi carries the released token from Solana to the destination EVM chain (DEX-swap first when the destination stable differs).",
    },
  ];
  return hops;
}

/**
 * Mark any hop whose station matches a FAILING liquidity leg as BLOCKED (with
 * the gate's honest reason). Returns the number of legs blocked.
 */
function applyLiquidityGate(hops, liquidity) {
  const failures = liquidity?.failures || [];
  let blocked = 0;
  for (const leg of failures) {
    const c = String(leg.chain || "").toLowerCase();
    const t = norm(leg.token);
    for (const hop of hops) {
      const hitsFrom = hop.from.chain === c && norm(hop.from.token) === t;
      const hitsTo = hop.to.chain === c && norm(hop.to.token) === t;
      if (hitsFrom || hitsTo) {
        hop.blocked = true;
        hop.blockedReason = leg.message || leg.reason || "insufficient liquidity";
        blocked += 1;
      }
    }
  }
  return blocked;
}

/**
 * Build the full journey readout model for the CURRENT selection.
 *
 * @param {object} p
 * @param {"forward"|"reverse"} [p.direction]
 * @param {string} p.from          forward source chain ("eth" …)
 * @param {string} p.to            forward is X1; reverse = destination EVM chain
 * @param {string} p.token         forward: source token; reverse: DESTINATION stable
 * @param {string} [p.reverseToken] reverse: the X1 token burned
 * @param {string} [p.destToken]   forward: the X1 token landed
 * @param {number|string} [p.amount]
 * @param {object} [p.quote]       the form's derived quote picture (feeLines …)
 * @param {object} [p.liquidity]   the checkRouteLiquidity() verdict
 * @returns {{direction:string, source:object, dest:object, hops:Array,
 *            blocked:boolean, blockedReason:(string|null), amount:(number|null),
 *            legIds:Array<string>}}
 */
export function buildJourney({
  direction = "forward",
  from,
  to,
  token,
  reverseToken = "USDC.x",
  destToken = "USDC.x",
  amount = null,
  quote = null,
  liquidity = null,
} = {}) {
  const fees = feeIndex(quote);
  const isReverse = direction === "reverse";
  const hops = isReverse
    ? buildReverseHops({ to, token, reverseToken, fees })
    : buildForwardHops({ from, token, destToken, fees });

  const blockedLegs = applyLiquidityGate(hops, liquidity);

  const source = isReverse ? makeStation("x1", reverseToken) : makeStation(from, token);
  const dest = isReverse ? makeStation(to, token) : makeStation("x1", destToken);

  // Fold the gate verdict onto the coordinate stations too (the source of a
  // forward refusal; the destination of a reverse refusal).
  if (liquidity?.failures?.length) {
    const f = liquidity.failures[0];
    const fc = String(f.chain || "").toLowerCase();
    const ft = norm(f.token);
    if (source.chain === fc && norm(source.token) === ft) { source.blocked = true; source.blockedReason = f.message || f.reason; }
    if (dest.chain === fc && norm(dest.token) === ft) { dest.blocked = true; dest.blockedReason = f.message || f.reason; }
  }

  const amt = amount === null || amount === undefined || amount === "" ? null : Number(amount);
  return {
    direction: isReverse ? "reverse" : "forward",
    source,
    dest,
    hops,
    blocked: blockedLegs > 0,
    blockedReason: blockedLegs > 0 ? (liquidity?.message || hops.find((h) => h.blocked)?.blockedReason || null) : null,
    amount: Number.isFinite(amt) ? amt : null,
    legIds: hops.map((h) => h.legId),
  };
}

/** True when every hop's engine leg id is a real leg of the direction's
 *  contract (used by tests to pin the readout to the engine). */
export function hopsMatchEngineLegs(journey) {
  const contract = legKey(journey?.direction);
  return (journey?.hops || []).every((h) => contract.includes(h.legId));
}
