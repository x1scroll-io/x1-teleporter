/**
 * reverseQuote.js — pure quote-building for the v2 REVERSE leg (X1 → EVM).
 * Mirrors teleportQuote.js (the forward EVM → X1 hop), reversed.
 *
 * THE REVERSE JOURNEY (X1 USDC.x → Solana USDC → EVM stable):
 *   Stage 1 — X1 → Solana: the Warp `bridge_out` BURN of USDC.x on X1
 *     (Token-2022). No LiFi. Fees come from quoteFees (x1_onward class):
 *     our 1% warp-skim (collector fee-wallet-x1, computed on the SOURCE
 *     amount) + Warp's flat $1 (third-party, deducted on-chain inside
 *     bridge_out on X1 mainnet). Both are the exact components the burn tx
 *     charges: runReverse prepends the 1% USDC.x transfer to the fee wallet
 *     and bridge_out burns the remainder (net of Warp's $1).
 *   Stage 2 — Solana → EVM: a LiFi leg on the net that actually LANDED on
 *     Solana (X − 1% − $1 — deterministic, the burn amount is explicit in
 *     the tx). The LiFi query is SOL → the destination EVM chain for the
 *     USER-SELECTED stable (USDC / USDT / DAI — whatever TOKENS[to] defines;
 *     the destination token symbol flows through buildReverseLifiQuoteParams
 *     and deriveReverseQuote), marked x1Class=1 so the server omits the LiFi
 *     integrator fee entirely
 *     (policy: the 1% warp-skim is the ONLY Teleporter fee on x1-class
 *     routes; api/lifi/quote.js validates the marker against Solana on one
 *     end of the leg). NO PLACEHOLDERS: fromAddress/toAddress are the real
 *     connected wallet addresses.
 *
 * Fee math is computed from fees.ts (FEE_RATES + quoteFees — the single
 * source of truth), never hardcoded. The routeType is passed EXPLICITLY
 * (x1_onward) so the fee class is correct regardless of the REVERSE_ENABLED
 * route-builder flag — this module is the v2 reverse path, which does not go
 * through determineRoute (see TeleportForm.jsx).
 */

import { CHAINS, TOKENS } from "./teleportConstants.js";
import { quoteFees, FEE_RATES, LIFI_INTEGRATOR_ACCOUNT } from "./fees.ts";

const USDC_DECIMALS = 6;

/**
 * The deterministic Stage-1 math for the reverse journey, from fees.ts
 * (single source — if the rate ever changes there, this follows):
 *   skim        = 1% of the source amount (our Teleporter fee, USDC.x,
 *                 transferred to FEE_WALLETS.X1 as a pre-bridge SPL transfer)
 *   burnAmount  = source − skim (what bridge_out burns on X1)
 *   netOnSolana = burnAmount − Warp's flat $1 (deducted by the Warp program
 *                 INSIDE bridge_out on X1 mainnet — third-party pass-through)
 * The LiFi leg (stage 2) bridges netOnSolana — the exact USDC that lands.
 *
 * @param {{amount: number}} args source amount in human units
 * @returns {{skim: number, burnAmount: number, netOnSolana: number,
 *            feeQuote: FeeQuote}}
 */
export function computeReverseLegs({ amount }) {
  const skim = amount * FEE_RATES.X1_HOP_SKIM;
  const burnAmount = amount - skim;
  const netOnSolana = Math.max(0, burnAmount - FEE_RATES.WARP_FLAT_USD);
  const feeQuote = quoteFees({ from: "x1", to: "eth", routeType: "x1_onward" }, amount);
  return { skim, burnAmount, netOnSolana, feeQuote };
}

/**
 * Build the LiFi quote query params for the REVERSE Stage-2 leg: Solana USDC
 * → destination EVM chain USDC. Mirrors buildLifiQuoteParams (forward) with
 * the ends reversed — Solana is the SOURCE, the EVM chain is the DESTINATION.
 *
 * @param {{to: string, netOnSolana: number, fromAddress: ?string,
 *          toAddress: ?string, slippage?: number}} args
 *   fromAddress = the connected Solana/X1 session's address (the USDC that
 *                 lands on Solana from the Warp release is in THIS wallet).
 *   toAddress   = the connected EVM session's address (the destination).
 * @returns {{qs: URLSearchParams, decimals: number, feeUsed: null} | null}
 *   null when the chain is unknown or a needed wallet address is missing
 *   (no placeholders — the caller surfaces the connect prompt).
 */
export function buildReverseLifiQuoteParams({ to, toTokenSymbol = "USDC", netOnSolana, fromAddress, toAddress, slippage = 0.5 }) {
  const toChain = CHAINS[to]?.lifiKey;
  // The DESTINATION stable is the user's choice (USDC / USDT / DAI — whatever
  // TOKENS[to] defines). The source side stays Solana USDC (6 decimals).
  const toTokenInfo = TOKENS[to]?.[toTokenSymbol];
  const toToken = toTokenInfo?.address;
  if (!toChain || !toToken) return null;
  if (!fromAddress || !toAddress) return null; // NO PLACEHOLDERS — real connected wallets only

  const rawAmount = BigInt(Math.floor(netOnSolana * 10 ** USDC_DECIMALS)).toString();
  const qs = new URLSearchParams({
    fromChain: CHAINS.sol.lifiKey,        // Solana → EVM (leg 2 of the reverse hop)
    toChain,
    fromToken: TOKENS.sol.USDC.address,   // the USDC released on Solana by the Warp burn
    toToken,                              // lands as the SELECTED stable on the destination EVM chain
    fromAmount: rawAmount,
    fromAddress,
    toAddress,                            // explicit — required for cross-VM routes
    slippage: String(slippage / 100),
    integrator: LIFI_INTEGRATOR_ACCOUNT,
    order: "CHEAPEST",
    // Cross-VM: prevent a fragile multi-hop that detours through a THIRD
    // chain (mirrors the forward leg's allowSwitchChain=false).
    allowSwitchChain: "false",
    // x1-class marker — the server validates it (the leg must touch Solana)
    // and strips it before forwarding. NO fee param on x1-class (policy —
    // the 1% warp-skim is the only Teleporter fee on the journey).
    x1Class: "1",
  });
  // decimals = the DESTINATION token's decimals (what the LiFi leg delivers —
  // USDT is 6, DAI is 18); the source-side amount stays USDC 6 (Solana).
  return { qs, decimals: toTokenInfo?.decimals ?? USDC_DECIMALS, feeUsed: null };
}

/**
 * Derive the full reverse quote-box picture.
 *
 * @param {{data: ?object, to: string, token?: string, amount: number}} args
 *   data = the /api/lifi/quote response for the SOL→EVM leg (may be null/absent
 *   when no route could be quoted — the honest-handoff case: stage 1 (the X1
 *   burn) is still fully quoted and buildable; funds would rest on Solana and
 *   the Solana→EVM hop is surfaced as the next stage instead).
 *   token = the user-selected DESTINATION stable symbol (USDC/USDT/DAI — the
 *   LiFi leg's toToken; defaults to USDC). Its decimals (6 or 18) convert the
 *   LiFi toAmount into human units.
 * @returns {{out: number, feeLines: FeeLine[], teleporterFeeUsd: number,
 *            thirdPartyFeeUsd: number, net: number, recvToken: string,
 *            recvChain: string, solanaAmount: number, lifiQuoted: boolean,
 *            steps: Array}}
 */
export function deriveReverseQuote({ data, to, token = "USDC", amount }) {
  const legs = computeReverseLegs({ amount });
  const destName = CHAINS[to]?.name || to;
  const lifiQuoted = Boolean(data?.estimate?.toAmount);
  let out;
  if (lifiQuoted) {
    // LiFi delivers the SELECTED stable on the destination EVM chain — its
    // decimals come from TOKENS (USDC/USDT are 6, DAI is 18), never hardcoded.
    const toDecimals = TOKENS[to]?.[token]?.decimals ?? USDC_DECIMALS;
    out = parseFloat(data.estimate.toAmount) / 10 ** toDecimals;
  } else {
    // Honest handoff: the LiFi leg could not be quoted (or wasn't requested).
    // The quote still shows the full Stage-1 picture; "you receive" is the
    // USDC that actually lands on Solana, with the hop to {dest} as the next
    // stage. Never invent a number for the unquoted leg.
    out = legs.netOnSolana;
  }
  return {
    out,
    feeLines: legs.feeQuote.feeLines,
    teleporterFeeUsd: legs.feeQuote.teleporterFeeUsd,
    thirdPartyFeeUsd: legs.feeQuote.thirdPartyFeeUsd,
    net: out,
    recvToken: lifiQuoted ? token : "USDC", // the SELECTED destination stable when quoted; Solana USDC in the handoff
    recvChain: lifiQuoted ? destName : "Solana",
    solanaAmount: legs.netOnSolana, // stage 2 (LiFi) bridges THIS, not the original input
    lifiQuoted,
    legs, // the stage-1 math (skim/burn/netOnSolana) for the send path
    steps: [
      { name: "X1", tool: "Warp Bridge" },
      { name: "Solana", tool: "Warp Bridge" },
      { name: destName, tool: "LiFi" },
    ],
  };
}
