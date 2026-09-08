/**
 * fotHandler.js — FOT HANDLE + COMMUNICATE (spec: tax token / fee-on-
 * transfer handling). Consumes the TaxProfile from taxDetector.js.
 *
 * HANDLE:
 *   - Route through the SupportingFeeOnTransfer swap path (the router
 *     variant that measures actual received — Uniswap/PancakeSwap v2
 *     `swapExactTokensForTokensSupportingFeeOnTransferTokens`; the engine's
 *     v2 legs must use it when the profile says taxed).
 *   - AUTO-SLIPPAGE from the MEASURED tax, never a guess:
 *       effectiveSlippageBps = max(swapSlippageBps, taxBps + bufferBps)
 *     A 5% tax (500bps) → slippage covers 500 + 100 buffer = 600bps, not a
 *     blind 1%.
 *
 * COMMUNICATE:
 *   - buildTaxNotice() → the user-facing warning with the REAL post-tax
 *     amount. No silent-fail-and-guess.
 *   - Honeypot / blacklist / cannot-sell-all flags → WARN or BLOCK.
 */

/** The buffer added above the measured tax (so normal pool slippage is also
 *  covered without forcing the user to guess). */
export const TAX_SLIPPAGE_BUFFER_BPS = 100; // 1% over the measured tax

/** FOT router function names per DEX family (the SupportingFeeOnTransfer
 *  variants the engine's legs call when a token is taxed). */
export const FOT_ROUTER_FNS = Object.freeze({
  "uniswap-v2": "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  "pancakeswap-v2": "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  // v3/v4 pools REJECT fee-on-transfer tokens by design (the pool books the
  // exact input) — taxed memes live on v2-style pairs; the handler flags
  // that a v3 quote on a taxed token is unsafe and routes to the v2 FOT leg.
});

/**
 * effectiveSlippageBps — auto-slippage from the measured tax profile.
 * @param {object} profile TaxProfile from taxDetector
 * @param {number} [swapSlippageBps] the normal (untaxed) slippage, default 100
 * @param {boolean} [selling] true when the swap SELLS the taxed token
 * @returns {number} bps slippage that covers tax + buffer + normal slippage
 */
export function effectiveSlippageBps(profile, { swapSlippageBps = 100, selling = false } = {}) {
  const taxBps = selling ? profile.sellTaxBps : profile.buyTaxBps;
  if (!profile.detected || taxBps == null) return swapSlippageBps;
  return Math.max(swapSlippageBps, taxBps + TAX_SLIPPAGE_BUFFER_BPS);
}

/**
 * postTaxAmount — the honest expected-out after the measured tax.
 * @param {number|bigint} grossAmountOut raw output BEFORE tax
 * @param {object} profile TaxProfile
 * @param {boolean} [selling] tax applies on the sell side of the token
 * @returns {{netBps: number, netAmount: string}} netBps = 10000 - taxBps
 */
export function postTaxAmount(grossAmountOut, profile, { selling = false } = {}) {
  const taxBps = selling ? profile.sellTaxBps : profile.buyTaxBps;
  const netBps = taxBps == null ? 10000 : 10000 - taxBps;
  const gross = BigInt(grossAmountOut);
  const net = (gross * BigInt(netBps)) / 10000n;
  return { netBps, netAmount: net.toString() };
}

/**
 * taxRoutingDecision — does this swap need the FOT path?
 * @returns {{ useFotPath: boolean, reason: string|null, slippageBps: number }}
 */
export function taxRoutingDecision(profile, { selling = false, swapSlippageBps = 100 } = {}) {
  const taxBps = selling ? profile.sellTaxBps : profile.buyTaxBps;
  if (profile.honeypot) return { useFotPath: false, reason: "HONEYPOT", slippageBps: 0 };
  if (profile.detected && (taxBps ?? 0) > 0) {
    return {
      useFotPath: true,
      reason: `tax-${taxBps}bps`,
      slippageBps: effectiveSlippageBps(profile, { swapSlippageBps, selling }),
    };
  }
  return { useFotPath: false, reason: null, slippageBps: swapSlippageBps };
}

/** SEVERITY = "block" | "warn" | "ok" — honeypots block; taxed tokens warn. */
export function taxSeverity(profile) {
  if (profile.honeypot || profile.blacklisted || profile.cannotSellAll) return "block";
  if (profile.detected) return "warn";
  return "ok";
}

/**
 * buildTaxNotice — the UX communication (the edge most DEXs lack).
 * @returns {object} { severity, title, body, slippageBps, postTaxNote }
 *   or null when the token is clean.
 */
export function buildTaxNotice(profile, { tokenSymbol = "TOKEN", selling = false, grossAmountOutHuman = null, swapSlippageBps = 100 } = {}) {
  const severity = taxSeverity(profile);
  if (severity === "ok") return null;
  const taxBps = selling ? profile.sellTaxBps : profile.buyTaxBps;
  const slippageBps = effectiveSlippageBps(profile, { swapSlippageBps, selling });

  if (severity === "block") {
    const reasons = [];
    if (profile.honeypot) reasons.push("flagged as a honeypot (cannot sell)");
    if (profile.blacklisted) reasons.push("has blacklist control");
    if (profile.cannotSellAll) reasons.push("cannot sell all holdings at once");
    return {
      severity: "block",
      title: `⛔ ${tokenSymbol} — BLOCKED`,
      body: `Refusing to swap: ${reasons.join("; ")}. Your funds would be at risk.`,
      slippageBps: 0,
      postTaxNote: null,
    };
  }

  // warn — taxed token, the honest notice
  const side = selling ? "sell" : "buy";
  const pct = ((taxBps ?? 0) / 100).toFixed(2);
  const netNote = grossAmountOutHuman != null
    ? `~${(grossAmountOutHuman * (1 - (taxBps ?? 0) / 10000)).toFixed(6)} after tax`
    : `~${(100 - (taxBps ?? 0) / 100).toFixed(2)}% of the quote after tax`;
  return {
    severity: "warn",
    title: `⚠️ Tax token detected`,
    body: `${tokenSymbol} charges ~${pct}% on ${side}. Routing through the fee-safe path with ${(slippageBps / 100).toFixed(1)}% slippage to cover it.`,
    slippageBps,
    postTaxNote: netNote,
  };
}
