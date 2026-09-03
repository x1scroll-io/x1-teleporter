/**
 * teleportQuote.js — pure quote-building for the v2 Teleport tab (Phase 3
 * bridge form). Ported from the v1 inline logic in Teleporter.jsx; every fee
 * line still comes from computeFee via quoteFees (src/lib/fees.ts — the
 * single source). No new fee logic, no new fee paths.
 *
 * SCOPE — EVM → X1 only (the hop's route). buildLifiQuoteParams builds the
 * x1-class leg-1 LiFi query exactly like v1's buildLifiQuery x1 branch:
 *   - the fee key is OMITTED entirely (absent means absent, never fee=0) —
 *     the stage-2 on-chain skim is the only Teleporter fee on x1-class
 *     routes (policy, api/lifi/quote.js re-forces this server-side),
 *   - x1Class=1 marks the journey for the server (validated + stripped there),
 *   - allowSwitchChain=false forces the cross-VM hop source→Solana direct
 *     (no fragile multi-chain detours),
 *   - NO PLACEHOLDERS: fromAddress/toAddress are the real connected wallet
 *     addresses; without them the builder returns null and the UI asks the
 *     user to connect — funds can never route to anything but the user's own
 *     connected wallet.
 */

import { CHAINS, TOKENS } from "./teleportConstants.js";
import { quoteFees, LIFI_INTEGRATOR_ACCOUNT } from "./fees.ts";

/**
 * Build the LiFi quote query params for the EVM→X1 hop (routeType "x1").
 *
 * @param {{from: string, token: string, amount: number, fromAddress: ?string,
 *          toAddress: ?string, slippage?: number}} args
 *   fromAddress = the connected EVM session's address (source).
 *   toAddress   = the connected Solana/X1 session's address (the LiFi leg
 *                 lands USDC on Solana — LiFi needs the SVM destination).
 * @returns {{qs: URLSearchParams, decimals: number, feeUsed: null} | null}
 *   null when the chain/token is unknown or a needed wallet address is
 *   missing (no placeholders — the caller surfaces the connect prompt).
 */
export function buildLifiQuoteParams({ from, token, amount, fromAddress, toAddress, slippage = 0.5, destToken = "USDC.x" }) {
  const fromChain = CHAINS[from]?.lifiKey;
  const fromToken = TOKENS[from]?.[token]?.address;
  const decimals = TOKENS[from]?.[token]?.decimals;
  if (!fromChain || !fromToken || !decimals) return null;
  if (!fromAddress || !toAddress) return null; // NO PLACEHOLDERS — real connected wallets only

  // The X1 destination token drives the Solana-side LANDING token for the
  // LiFi leg: USDC.x ← Solana USDC (6 dec); wSOL.X ← Solana WSOL (9 dec —
  // LiFi quotes EVM→SOL WSOL directly, Sep 2026, so no Jupiter swap is
  // needed; the Warp leg then locks WSOL and the guardians mint wSOL.X).
  const solanaLanding = destToken === "wSOL.X" ? "WSOL" : "USDC";
  const rawAmount = BigInt(Math.floor(amount * 10 ** decimals)).toString();
  const qs = new URLSearchParams({
    fromChain,
    toChain: CHAINS.sol.lifiKey,        // EVM → Solana (leg 1 of the X1 hop)
    fromToken,
    toToken: TOKENS.sol[solanaLanding].address,   // lands as USDC or WSOL on Solana
    fromAmount: rawAmount,
    fromAddress,
    toAddress,                           // explicit — required for cross-VM routes
    slippage: String(slippage / 100),
    integrator: LIFI_INTEGRATOR_ACCOUNT,
    order: "CHEAPEST",
    // Cross-VM: prevent a fragile multi-hop that detours through a THIRD
    // chain (the v1 BNB→Ethereum→Solana via Relay reverts). allowSwitchChain
    // only affects switching the DESTINATION — LiFi may still DEX-swap on the
    // source chain first (one chain, fine). We do NOT hard-restrict
    // allowBridges (Allbridge on BSC is USDT-only — over-restricting kills
    // valid DAI/USDC routes that need Mayan/CCTP/Wormhole).
    allowSwitchChain: "false",
    // x1-class marker — the server validates it (the leg must touch Solana)
    // and strips it before forwarding. NO fee param on x1-class (policy).
    x1Class: "1",
  });
  return { qs, decimals, feeUsed: null };
}

/**
 * Derive the full quote-box picture from a live LiFi response (the x1 route).
 * Ported from v1's getQuote LIVE branch — every fee line comes from
 * computeFee via quoteFees, never hardcoded:
 *   - x1-class: LiFi out is pre-skim (integrator 0), so the stage-2 skim is
 *     quoted on what LiFi actually DELIVERS to Solana (leg-1-delivered base)
 *     and "you receive" is honest.
 *
 * @param {{data: object, from: string, token: string, amount: number}} args
 *   data = the /api/lifi/quote response (estimate.toAmount in base units).
 * @returns {{out: number, feeLines: FeeLine[], teleporterFeeUsd: number,
 *            thirdPartyFeeUsd: number, net: number, recvToken: string,
 *            recvChain: string, solanaAmount: number, steps: Array}}
 * @throws {Error} when the response is malformed (no estimate.toAmount).
 */
export function deriveQuoteFromLifi({ data, from, token, amount, destToken = "USDC.x" }) {
  if (!data?.estimate?.toAmount) {
    throw new Error("Malformed quote response — no estimate.toAmount");
  }
  // LiFi delivers the Solana-side landing token — USDC (6 dec) or WSOL
  // (9 dec when the X1 destination is wSOL.X).
  const solanaLanding = destToken === "wSOL.X" ? "WSOL" : "USDC";
  const outDecimals = TOKENS.sol[solanaLanding].decimals;
  const out = parseFloat(data.estimate.toAmount) / 10 ** outDecimals;
  // POLICY quote: x1-class fees are computed on what LiFi DELIVERED (the
  // stage-2 skim base is leg-1-delivered), not the original input. The Warp
  // fee component is token-aware too (wSOL.X charges 25 bps, not the flat $1
  // — live Warp config, verified on-chain 2026-09-02).
  const route = {
    from, to: "x1", routeType: "x1", amount,
    ...(destToken === "wSOL.X" ? { warpFeeBps: 25 } : {}),
  };
  const qf = quoteFees(route, out);
  return {
    out,
    feeLines: qf.feeLines,
    teleporterFeeUsd: qf.teleporterFeeUsd,
    thirdPartyFeeUsd: qf.thirdPartyFeeUsd,
    net: qf.netUsd,
    recvToken: destToken,   // USDC.x or wSOL.X — what the guardians mint on X1
    recvChain: "X1",
    solanaAmount: out, // stage 2 (Warp) bridges THIS, not the original input
    steps: [
      { name: "Solana", tool: "LiFi" },
      { name: "X1", tool: "Warp Bridge" },
    ],
  };
}
