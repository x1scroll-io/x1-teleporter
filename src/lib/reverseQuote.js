/**
 * reverseQuote.js — pure quote-building for the v2 REVERSE leg (X1 → EVM).
 * Mirrors teleportQuote.js (the forward EVM → X1 hop), reversed.
 *
 * THE REVERSE JOURNEY (X1 USDC.x/wSOL.X → Solana → EVM stable):
 *   Stage 1 — X1 → Solana: the Warp `bridge_out` BURN of the X1 token
 *     (Token-2022: USDC.x or wSOL.X). No LiFi. Fees come from quoteFees
 *     (x1_onward class): our 1% warp-skim (collector fee-wallet-x1, computed
 *     on the SOURCE amount) + the Warp program's own fee (third-party,
 *     deducted on-chain inside bridge_out on X1 mainnet). Both are the exact
 *     components the burn tx charges: runReverse prepends the 1% skim
 *     transfer to the fee wallet and bridge_out burns the remainder.
 *     TOKEN-AWARE Warp fee (live Warp config, verified on-chain):
 *       - USDC.x: flat $1 (1.0 USDC.x) carved out of the bridge gross
 *       - wSOL.X: 25 bps (0.25%) of the bridge gross, flat 0
 *   Stage 2 — Solana → EVM: a LiFi leg on the net that actually LANDED on
 *     Solana (X − 1% − Warp fee — deterministic, the burn amount is explicit
 *     in the tx). The LiFi query is SOL → the destination EVM chain for the
 *     USER-SELECTED stable (USDC / USDT / DAI — whatever TOKENS[to] defines;
 *     the destination token symbol flows through buildReverseLifiQuoteParams
 *     and deriveReverseQuote), marked x1Class=1 so the server omits the LiFi
 *     integrator fee entirely (policy: the 1% warp-skim is the ONLY
 *     Teleporter fee on x1-class routes; api/lifi/quote.js validates the
 *     marker against Solana on one end of the leg). The Solana-side FROM
 *     token is token-aware too:
 *       - USDC.x burn → USDC (6 dec) on Solana → LiFi fromToken = USDC
 *       - wSOL.X burn → WSOL (9 dec) on Solana → LiFi fromToken = WSOL
 *     LiFi quotes WSOL (So111…) → EVM stables DIRECTLY (verified live,
 *     Sep 2026 — relaydepository wSOL→USDC routes) — NO Jupiter swap needed.
 *     NO PLACEHOLDERS: fromAddress/toAddress are the real connected wallet
 *     addresses.
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
const WSOL_DECIMALS = 9;

/** Warp's per-token fee on the X1 side (bridge_out burn) — the mirror of
 *  warpBridge.js X1_WARP_FEES (single source of truth for the quote math;
 *  the on-chain constants live there, the USD display math here). */
const X1_WARP_FEES = {
  "USDC.x": { kind: "flat", amountUsd: 1, decimals: 6 },
  "wSOL.X": { kind: "pct", bps: 25, decimals: 9 },
};

/** Resolve the Solana-side FROM token for the stage-2 LiFi leg from the X1
 *  source token: USDC.x releases USDC (6 dec); wSOL.X releases WSOL (9 dec). */
export function reverseSolanaToken(token) {
  return token === "wSOL.X" ? "WSOL" : "USDC";
}

/**
 * The deterministic Stage-1 math for the reverse journey, from fees.ts
 * (single source — if the rate ever changes there, this follows) + the live
 * Warp token registry (per-token fee shape):
 *   skim        = 1% of the source amount (our Teleporter fee, in the SOURCE
 *                 token — USDC.x or wSOL.X, transferred to FEE_WALLETS.X1 as
 *                 a pre-bridge SPL transfer)
 *   burnAmount  = source − skim (what bridge_out burns on X1; alias
 *                 warpGross — the amount the Warp program debits)
 *   warpFee     = the Warp program's OWN fee, carved out of the burn gross
 *                 INSIDE bridge_out on X1 mainnet (third-party pass-through):
 *                 USDC.x → flat 1.0; wSOL.X → 25 bps of the gross
 *   netOnSolana = burnAmount − warpFee (what the guardians release on Solana:
 *                 USDC 6-dec for a USDC.x burn, WSOL 9-dec for a wSOL.X burn)
 * The LiFi leg (stage 2) bridges netOnSolana — the exact token that lands.
 *
 * @param {{amount: number, token?: string}} args source amount in human units
 *   (USDC.x or wSOL.X — token drives the Warp fee shape)
 * @returns {{skim: number, burnAmount: number, warpFee: number,
 *            netOnSolana: number, feeQuote: FeeQuote}}
 */
export function computeReverseLegs({ amount, token = "USDC.x" }) {
  const skim = amount * FEE_RATES.X1_HOP_SKIM;
  const burnAmount = amount - skim; // the bridge_out gross
  const fee = X1_WARP_FEES[token] || X1_WARP_FEES["USDC.x"];
  const warpFee = fee.kind === "flat"
    ? fee.amountUsd
    : burnAmount * (fee.bps / 10_000);
  const netOnSolana = Math.max(0, burnAmount - warpFee);
  const feeQuote = quoteFees(
    { from: "x1", to: "eth", routeType: "x1_onward", warpFeeBps: fee.kind === "pct" ? fee.bps : undefined },
    amount,
  );
  return { skim, burnAmount, warpFee, netOnSolana, feeQuote };
}

/**
 * Build the LiFi quote query params for the REVERSE Stage-2 leg: Solana
 * (USDC or WSOL) → destination EVM chain stable. Mirrors
 * buildLifiQuoteParams (forward) with the ends reversed — Solana is the
 * SOURCE, the EVM chain is the DESTINATION.
 *
 * @param {{to: string, netOnSolana: number, fromAddress: ?string,
 *          toAddress: ?string, slippage?: number, token?: string,
 *          toTokenSymbol?: string}} args
 *   fromAddress = the connected Solana/X1 session's address (the token that
 *                 lands on Solana from the Warp release is in THIS wallet).
 *   toAddress   = the connected EVM session's address (the destination).
 *   token       = the X1 source token ("USDC.x" default | "wSOL.X") — drives
 *                 the Solana-side fromToken (USDC | WSOL) + fromAmount
 *                 decimals (6 | 9).
 *   toTokenSymbol = the user-selected DESTINATION stable on the EVM chain
 *                 (USDC/USDT/DAI — whatever TOKENS[to] defines; defaults to
 *                 USDC; the #36 dest-choice selector passes USDT/DAI here).
 * @returns {{qs: URLSearchParams, decimals: number, toDecimals: number,
 *            feeUsed: null} | null}
 *   null when the chain is unknown or a needed wallet address is missing
 *   (no placeholders — the caller surfaces the connect prompt).
 */
export function buildReverseLifiQuoteParams({ to, toTokenSymbol = "USDC", netOnSolana, fromAddress, toAddress, slippage = 0.5, token = "USDC.x" }) {
  const toChain = CHAINS[to]?.lifiKey;
  // The DESTINATION stable is the user's choice (USDC / USDT / DAI — whatever
  // TOKENS[to] defines). The SOURCE side is the token the Warp burn released
  // on Solana: USDC (6 dec) for a USDC.x burn, WSOL (9 dec) for a wSOL.X burn.
  const toTokenInfo = TOKENS[to]?.[toTokenSymbol];
  const toToken = toTokenInfo?.address;
  if (!toChain || !toToken) return null;
  if (!fromAddress || !toAddress) return null; // NO PLACEHOLDERS — real connected wallets only

  const fromSymbol = reverseSolanaToken(token); // "USDC" | "WSOL"
  const fromTokenAddr = TOKENS.sol[fromSymbol]?.address;
  const fromDecimals = TOKENS.sol[fromSymbol]?.decimals ?? USDC_DECIMALS;
  if (!fromTokenAddr) return null;

  const rawAmount = BigInt(Math.floor(netOnSolana * 10 ** fromDecimals)).toString();
  const qs = new URLSearchParams({
    fromChain: CHAINS.sol.lifiKey,        // Solana → EVM (leg 2 of the reverse hop)
    toChain,
    fromToken: fromTokenAddr,             // the USDC (6-dec) or WSOL (9-dec) released by the Warp burn
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
  // decimals = the SOURCE-side amount scale (what fromAmount is denominated
  // in — the mirror of the forward builder: 6 for USDC, 9 for WSOL).
  // toDecimals = the DESTINATION stable's decimals (what the LiFi leg
  // delivers — USDT is 6, DAI is 18). Both from TOKENS, never hardcoded.
  return { qs, decimals: fromDecimals, toDecimals: toTokenInfo?.decimals ?? USDC_DECIMALS, feeUsed: null };
}

/**
 * Derive the full reverse quote-box picture.
 *
 * @param {{data: ?object, to: string, amount: number, token?: string,
 *          toToken?: string}} args
 *   data = the /api/lifi/quote response for the SOL→EVM leg (may be null/absent
 *   when no route could be quoted — the honest-handoff case: stage 1 (the X1
 *   burn) is still fully quoted and buildable; funds would rest on Solana and
 *   the Solana→EVM hop is surfaced as the next stage instead).
 *   token = the X1 SOURCE token ("USDC.x" default | "wSOL.X") — drives the
 *   stage-1 Warp fee shape + the Solana-side landing token (USDC | WSOL).
 *   toToken = the user-selected DESTINATION stable symbol (USDC/USDT/DAI —
 *   the LiFi leg's toToken; defaults to USDC). Its decimals (6 or 18) convert
 *   the LiFi toAmount into human units.
 * @returns {{out: number, feeLines: FeeLine[], teleporterFeeUsd: number,
 *            thirdPartyFeeUsd: number, net: number, recvToken: string,
 *            recvChain: string, solanaAmount: number, lifiQuoted: boolean,
 *            steps: Array}}
 */
export function deriveReverseQuote({ data, to, amount, token = "USDC.x", toToken = "USDC" }) {
  const legs = computeReverseLegs({ amount, token });
  const destName = CHAINS[to]?.name || to;
  const lifiQuoted = Boolean(data?.estimate?.toAmount);
  const recvDecimals = TOKENS[to]?.[toToken]?.decimals ?? USDC_DECIMALS;
  let out;
  if (lifiQuoted) {
    // LiFi delivers the SELECTED stable on the destination EVM chain — its
    // decimals come from TOKENS (USDC/USDT are 6, DAI is 18), never hardcoded.
    out = parseFloat(data.estimate.toAmount) / 10 ** recvDecimals;
  } else {
    // Honest handoff: the LiFi leg could not be quoted (or wasn't requested).
    // The quote still shows the full Stage-1 picture; "you receive" is the
    // token that actually lands on Solana, with the hop to {dest} as the next
    // stage. Never invent a number for the unquoted leg.
    out = legs.netOnSolana;
  }
  const solanaSymbol = reverseSolanaToken(token); // USDC or WSOL
  return {
    out,
    feeLines: legs.feeQuote.feeLines,
    teleporterFeeUsd: legs.feeQuote.teleporterFeeUsd,
    thirdPartyFeeUsd: legs.feeQuote.thirdPartyFeeUsd,
    net: out,
    recvToken: lifiQuoted ? toToken : solanaSymbol, // the SELECTED destination stable when quoted; the Solana landing token in the handoff
    recvChain: lifiQuoted ? destName : "Solana",
    solanaAmount: legs.netOnSolana, // stage 2 (LiFi) bridges THIS, not the original input
    lifiQuoted,
    legs, // the stage-1 math (skim/burnAmount/warpFee/netOnSolana) for the send path
    steps: [
      { name: "X1", tool: "Warp Bridge" },
      { name: "Solana", tool: "Warp Bridge" },
      { name: destName, tool: "LiFi" },
    ],
  };
}
