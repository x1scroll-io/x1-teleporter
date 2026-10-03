/**
 * quoteLeg.js — the THORChain QUOTE leg of the THORChain route (Phase 3:
 * the deposit-address lane BTC/DOGE/LTC/XRP → SOL.SOL — the Buy/THORChain
 * tab). This leg is the engine home of the deposit stage's QUOTE GATE
 * (src/lib/thorchain/quote.js — Step 3.3, PR #20 security-fixed): the
 * deterministic request the stage sends to OUR serverless proxy
 * /api/thorchain/quote (the aggregator key lives SERVER-side only — the
 * client never holds it), with the per-swap SIZE CAP enforced BEFORE any
 * fetch.
 *
 * LEG CONTRACT PLACEMENT
 *   build — the deterministic artifact: the canonical serialized quote
 *           request (proxy URL + params, amounts in THORChain 1e8 base
 *           units, destination = the connected Solana session pubkey) +
 *           the cap decision. Pure/offline — the golden step1 fixture
 *           (step1-quote-request.json) pins it byte-for-byte.
 *
 *   There is NO simulate/submit on this leg: the quote fetch + parse happen
 *   in the stage/UI layer with the PROVEN fetchQuote/parseQuoteResponse
 *   (DI — the leg never constructs endpoints), and the deposit itself is
 *   executed OUT-OF-BAND in the user's external wallet (see the
 *   deposit-build leg). family "external" → the SignerResolver returns null
 *   BY DESIGN: no in-app session signer exists for the deposit-address
 *   lane — the UI surfaces the honest "send from your wallet" step.
 *
 * REUSE (wrap, don't rewrite): assertWithinSwapCap / toThorchainBaseUnits /
 * quoteUrl all come from src/lib/thorchain/quote.js, unchanged — the SAME
 * functions the deposit stage's quote moment calls (THORChainDeposit.getQuote
 * → createQuoteFetcher). One construction code path for the reference flow
 * and the engine, so the two cannot drift.
 *
 * ctx: { sourceChain ("BTC"|"DOGE"|"LTC"|"XRP"), amount (decimal source
 *        units), destination (the Solana session pubkey — the PIN),
 *        refundAddress?, rates?, maxBtcEquivalent?, proxyPath? }
 */
import { createLeg } from "../../legContract.js";
import {
  quoteUrl,
  toThorchainBaseUnits,
  assertWithinSwapCap,
  THORCHAIN_QUOTE_PROXY_PATH,
} from "../../../lib/thorchain/quote.js";
import {
  THORCHAIN_SOURCE_ASSETS,
  THORCHAIN_DESTINATION_ASSET,
} from "../../../lib/thorchain/memo.js";
import {
  THORCHAIN_AFFILIATE_NAME,
  THORCHAIN_AFFILIATE_BPS,
} from "../../../lib/thorchain/config.js";

/**
 * Shape the golden step1 artifact from the same pure functions the deposit
 * stage calls (assertWithinSwapCap → toThorchainBaseUnits → quoteUrl) — the
 * EXACT shape test/fixtures/golden/thorchain-leg/step1-quote-request.json
 * records. The affiliate pair rides along ONLY when THORCHAIN_AFFILIATE_NAME
 * is configured (currently EMPTY → the URL carries no affiliate params —
 * nothing invented is ever sent to the quote API).
 *
 * @param {object} args
 * @param {string} args.sourceChain "BTC" | "DOGE" | "LTC" | "XRP"
 * @param {number} args.amount decimal amount in source units
 * @param {string} args.destination the Solana session pubkey (the PIN)
 * @param {string|null} [args.refundAddress] source-chain refund address
 *   (null/empty → omitted — refunds default to the sender)
 * @param {object} [args.rates] DI per-asset BTC-equivalent rates
 * @param {number} [args.maxBtcEquivalent] DI size cap (config default)
 * @param {string} [args.proxyPath] DI proxy path (default the real one)
 * @returns {object} the fixture-shaped artifact
 */
export function shapeQuoteRequestArtifact({
  sourceChain,
  amount,
  destination,
  refundAddress = null,
  rates,
  maxBtcEquivalent,
  proxyPath = THORCHAIN_QUOTE_PROXY_PATH,
}) {
  const fromAsset = THORCHAIN_SOURCE_ASSETS[sourceChain];
  if (!fromAsset) throw new Error(`shapeQuoteRequestArtifact: unknown sourceChain "${sourceChain}"`);

  // The cap gate runs FIRST in the reference flow (a blocked request never
  // reaches the fetch). Unknown-rate assets (DOGE/LTC/XRP until the live
  // wiring) are allowed with capKnown:false — the UI shows a note, never a
  // guessed price.
  const cap = assertWithinSwapCap({
    asset: sourceChain,
    amount,
    ...(rates ? { rates } : {}),
    ...(maxBtcEquivalent !== undefined ? { maxBtcEquivalent } : {}),
  });
  const capDecision = {
    ok: cap.ok,
    capKnown: cap.capKnown,
    ...(cap.capKnown && cap.capAmount !== undefined ? { capAmount: cap.capAmount } : {}),
  };

  const amountInBaseUnits = toThorchainBaseUnits(amount);
  const url = quoteUrl(proxyPath, {
    fromAsset,
    toAsset: THORCHAIN_DESTINATION_ASSET,
    amountInBaseUnits,
    destination,
    refundAddress: refundAddress || undefined, // qs drops empty
    ...(THORCHAIN_AFFILIATE_NAME !== ""
      ? { affiliate: THORCHAIN_AFFILIATE_NAME, affiliateBps: THORCHAIN_AFFILIATE_BPS }
      : {}),
  });

  return {
    sourceChain,
    fromAsset,
    toAsset: THORCHAIN_DESTINATION_ASSET,
    amount,
    amountInBaseUnits,
    destination,
    refundAddress: refundAddress || null,
    capDecision,
    url,
  };
}

/**
 * Create the THORChain quote leg.
 * ctx per phase:
 *   build: { sourceChain, amount, destination, refundAddress?, rates?,
 *            maxBtcEquivalent?, proxyPath? }
 */
export function createThorchainQuoteLeg() {
  return createLeg({
    id: "thorchain-quote",
    family: "external",
    chain: "thorchain",
    description:
      "The THORChain quote leg — the deterministic request to OUR proxy /api/thorchain/quote " +
      "(1e8 base units, destination pinned to the Solana session pubkey, size cap enforced " +
      "before the fetch, no affiliate params while the THORName placeholder is empty). " +
      "family 'external': the deposit is executed out-of-band in the user's external wallet — " +
      "no in-app signer (golden step1).",
    goldenStep: "step1-quote-request",
    phases: {
      async build(ctx) {
        if (!ctx.sourceChain) throw new Error("thorchainQuoteLeg.build: sourceChain is required");
        if (!Number.isFinite(Number(ctx.amount)) || Number(ctx.amount) <= 0) {
          throw new Error("thorchainQuoteLeg.build: a positive amount is required");
        }
        if (!ctx.destination) {
          throw new Error("thorchainQuoteLeg.build: destination (the Solana session pubkey) is required");
        }
        const artifact = shapeQuoteRequestArtifact({
          sourceChain: ctx.sourceChain,
          amount: Number(ctx.amount),
          destination: ctx.destination,
          refundAddress: ctx.refundAddress ?? null,
          ...(ctx.rates ? { rates: ctx.rates } : {}),
          ...(ctx.maxBtcEquivalent !== undefined ? { maxBtcEquivalent: ctx.maxBtcEquivalent } : {}),
          ...(ctx.proxyPath ? { proxyPath: ctx.proxyPath } : {}),
        });
        return { needed: true, artifact };
      },
    },
    meta: {
      wraps:
        "src/lib/thorchain/quote.js assertWithinSwapCap + toThorchainBaseUnits + quoteUrl " +
        "(the quote moment of THORChainDeposit.getQuote — the fetch + parse stay in the " +
        "stage/UI layer with the proven fetchQuote/parseQuoteResponse)",
    },
  });
}
