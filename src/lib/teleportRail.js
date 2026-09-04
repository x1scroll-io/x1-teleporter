/**
 * teleportRail.js — the RAIL-SELECTION LAYER for the unified Teleport Console
 * (2026-09-04 UX pass — Mr. Esters: ONE flow, no rail tabs, no Buy tab).
 *
 * The user never chooses a rail. They pick a SOURCE ASSET (what they have)
 * and a DESTINATION (where it's going); this layer decides which engine path
 * carries the journey — invisibly, after the pick, before execution:
 *
 *   - BTC / DOGE / LTC / XRP  (native chains)  → the THORChain rail
 *       (deposit-address execution: vault address + memo + txid-paste —
 *        the send happens OUT-OF-BAND in the user's own external wallet).
 *   - EVM-chain stables (USDC/USDT/DAI on Ethereum/Arbitrum/Base/…) and X1
 *     tokens (USDC.x / wSOL.X)                  → the LiFi/Warp rail
 *       (wallet-connect execution: connect the source wallet and sign —
 *        LiFi legs + the Warp hop into/out of X1).
 *
 * The rail list is PRIORITY-ORDERED per source with silent failover: when
 * the top-priority rail cannot serve the route (today: a native source has
 * exactly one rail, and an EVM/X1 source exactly one — the fallback chain
 * exists for the phase that adds competing lanes), pickRail falls through
 * the candidates instead of erroring. The user only ever sees the OUTCOME
 * (a deposit-address step or a wallet-connect step) — never a rail name.
 *
 * "THORChain" is an ENGINE PATH ONLY here. Nothing in this module's data is
 * rendered to the user; RAIL_LABELS exists solely for diagnostics/logging.
 *
 * PURE MODULE: no DOM, no fetch, no wallet. Runnable under `node --test`.
 * This is console-layer routing (UI consolidation) — the engine's
 * RoutePlanner (planForward/planReverse/planThorchain/… + composeRoute)
 * is untouched; this layer only PICKS which planner path the console drives.
 */
import { CHAINS, EVM_CHAINS, TOKENS, tokensFor } from "./teleportConstants.js";

/** The engine rails the console can drive. Internal names — never rendered. */
export const RAIL = Object.freeze({
  /** LiFi legs + the Warp hop (EVM stables → X1; X1 → EVM reverse). */
  LIFI_WARP: "lifi-warp",
  /** Native BTC/DOGE/LTC/XRP → SOL → X1 — the deposit-address lane. */
  THORCHAIN: "thorchain",
});

/** Diagnostics only — never rendered to the user (rail names are invisible). */
export const RAIL_LABELS = Object.freeze({
  [RAIL.LIFI_WARP]: "LiFi/Warp",
  [RAIL.THORCHAIN]: "THORChain",
});

/** The two FINAL-EXECUTION shapes the console routes into. The user sees the
 *  shape, never the rail: a deposit-address step (copy the vault address +
 *  memo, send from their own wallet, paste the txid) or a wallet-connect
 *  step (connect + sign in-app). */
export const EXECUTION = Object.freeze({
  DEPOSIT_ADDRESS: "deposit-address",
  WALLET_CONNECT: "wallet-connect",
});

/** Native-source chains carried by the THORChain rail (their only rail).
 *  `asset` is the single token each chain carries; `family` maps to the
 *  WalletContext session family (refund-address prefill); `symbol` is the
 *  deposit-stage source id (BTC/DOGE/LTC/XRP — THORChain's own ids). */
export const NATIVE_CHAINS = Object.freeze({
  btc: { id: "btc", name: "Bitcoin", glyph: "₿", asset: "BTC", decimals: 8, family: "bitcoin" },
  doge: { id: "doge", name: "Dogecoin", glyph: "Ð", asset: "DOGE", decimals: 8, family: "dogecoin" },
  ltc: { id: "ltc", name: "Litecoin", glyph: "Ł", asset: "LTC", decimals: 8, family: "litecoin" },
  xrp: { id: "xrp", name: "XRP", glyph: "✕", asset: "XRP", decimals: 6, family: "xrp" },
});

/** The native chain ids, in display order. */
export const NATIVE_CHAIN_IDS = Object.freeze(Object.keys(NATIVE_CHAINS));

/** True when the chain is a native (THORChain-rail) source. */
export function isNativeChain(chain) {
  return Object.prototype.hasOwnProperty.call(NATIVE_CHAINS, chain);
}

/** The source-chain picker's full option list: EVM chains (LiFi/Warp stables
 *  + the native gas tokens when the engine grows them), the native chains
 *  (THORChain rail), then X1 (the reverse off-ramp source). */
export const SOURCE_CHAINS = Object.freeze([...EVM_CHAINS, ...NATIVE_CHAIN_IDS, "x1"]);

/** Human chain name for any source/destination option. */
export function chainName(chain) {
  return CHAINS[chain]?.name || NATIVE_CHAINS[chain]?.name || String(chain);
}

/** Chain glyph for any source/destination option. */
export function chainGlyph(chain) {
  return CHAINS[chain]?.glyph || NATIVE_CHAINS[chain]?.glyph || "";
}

/** The token options a source chain's picker offers. Native chains carry
 *  exactly their one asset; EVM/X1 chains their registered tokens. */
export function tokensOn(chain) {
  if (isNativeChain(chain)) return [NATIVE_CHAINS[chain].asset];
  return tokensFor(chain);
}

/**
 * The rail candidates for a route, in priority order (the failover chain).
 * Today every source has exactly one serving rail; the ordered list is the
 * seam where competing lanes (a second native carrier, an EVM-native LiFi
 * bridge, a DEX-swap pre-leg) slot in later without touching the console.
 *
 * @param {{fromChain: string}} route
 * @returns {Array<{rail: string, execution: string}>}
 */
export function railCandidates({ fromChain }) {
  if (isNativeChain(fromChain)) {
    return [{ rail: RAIL.THORCHAIN, execution: EXECUTION.DEPOSIT_ADDRESS }];
  }
  return [{ rail: RAIL.LIFI_WARP, execution: EXECUTION.WALLET_CONNECT }];
}

/**
 * pickRail — THE decision point. Given the route coordinates (what the user
 * picked), return the serving rail + its final-execution shape. Called AFTER
 * the asset pick, BEFORE execution; the console routes the user into the
 * matching final step and never shows this module's names.
 *
 * Silent failover: when the first candidate's rail is unavailable (the
 * `unavailableRails` set — e.g. a halted carrier), the next candidate
 * serves. With no candidate left, { rail: null } returns and the caller
 * surfaces an honest "no route for this source right now".
 *
 * @param {{fromChain: string, unavailableRails?: Set<string>}} opts
 * @returns {{rail: string|null, execution: string|null}}
 */
export function pickRail({ fromChain, unavailableRails } = {}) {
  const candidates = railCandidates({ fromChain });
  for (const c of candidates) {
    if (unavailableRails?.has?.(c.rail)) continue; // silent failover
    return c;
  }
  return { rail: null, execution: null };
}

/** The final-execution shape for a rail (the two step types the console
 *  renders). Mirrors pickRail's execution — kept as the single mapping. */
export function executionFor(rail) {
  if (rail === RAIL.THORCHAIN) return EXECUTION.DEPOSIT_ADDRESS;
  if (rail === RAIL.LIFI_WARP) return EXECUTION.WALLET_CONNECT;
  return null;
}

/** Whether a route is a reverse off-ramp (source X1 → EVM destination). */
export function isReverse({ fromChain }) {
  return fromChain === "x1";
}

/** Whether a route lands on X1 (forward: EVM stables or native assets). */
export function isToX1({ fromChain }) {
  return fromChain !== "x1";
}
