/**
 * rangoQuoteLeg.js — the RANGO QUOTE leg (Phase-5 scaffold: the multi-chain
 * aggregator leg — source chains THORChain can't serve: SUI / TRON / XRPL
 * natives, plus the UTXO natives as the fallback rail when THORChain
 * halts). This leg is the engine home of the Rango lane's QUOTE GATE: the
 * deterministic request the lane sends to OUR serverless proxy
 * /api/rango/quote (the Rango API key lives SERVER-side only — the client
 * never holds it), amounts in RAW base units (10^decimals — never human
 * units), and the canonical parse of the response (parseRangoQuoteResponse
 * — pure, shared with the fixtures).
 *
 * LEG CONTRACT PLACEMENT
 *   build — the deterministic artifact: the canonical serialized quote
 *           request (proxy URL + params: from, to, amount, slippage — the
 *           referrer pair rides along ONLY when the config placeholder is
 *           set; currently EMPTY → no referrer params ever sent). Pure/
 *           offline — the golden step1 fixture pins it.
 *
 *   There is NO simulate/submit on this leg: the quote fetch + the parse
 *   happen in the stage/UI layer with the proven parseRangoQuoteResponse
 *   (DI — the leg never constructs endpoints or fetches), and the swap
 *   itself is executed in the user's wallet (see the rango-execute leg).
 *   family "external" → the SignerResolver returns null BY DESIGN: no
 *   in-app session signer exists for the Rango lane yet — the UI surfaces
 *   the honest wallet step (a live lane may later map SUI/TRON families
 *   onto wallet-connect execution; that is a runner-phase decision, not a
 *   leg decision).
 *
 * REUSE (wrap, don't rewrite): shapeQuoteRequestArtifact /
 * parseRangoQuoteResponse / rangoAssetId all come from
 * src/lib/rango/quote.js — the SAME functions the future stage layer's
 * quote moment will call. One construction code path for the reference
 * flow and the engine, so the two cannot drift.
 *
 * ctx: { source ("sui"|"xrpl"|"btc"|"tron" — a RANGO_SOURCES key),
 *        amount (RAW base units), destinationAsset? (default
 *        RANGO_DESTINATION_SOL), slippage?, proxyPath? }
 */
import { createLeg } from "../../legContract.js";
import { shapeQuoteRequestArtifact } from "../../../lib/rango/quote.js";
import { RANGO_SOURCES, RANGO_DESTINATION_SOL } from "../../../lib/rango/config.js";

/**
 * Shape the golden step1 artifact from the same pure function the future
 * stage layer calls — the canonical proxy quote request. The destination
 * asset defaults to SOL on Solana (the Rango lane's landing chain — the
 * Warp hop into X1 continues from there, exactly like the THORChain lane).
 *
 * @param {object} args
 * @param {string} args.source a RANGO_SOURCES key ("sui" | "xrpl" | "btc" |
 *   "tron")
 * @param {string|number} args.amount RAW source amount in base units
 * @param {object} [args.to] destination asset (default RANGO_DESTINATION_SOL)
 * @param {number} [args.slippage] slippage percent (module default 0.5)
 * @param {string} [args.proxyPath] DI proxy path (default the real one)
 * @returns {object} the fixture-shaped artifact
 */
export function shapeRangoQuoteRequestArtifact({
  source,
  amount,
  to = RANGO_DESTINATION_SOL,
  slippage,
  proxyPath,
}) {
  const src = RANGO_SOURCES[source];
  if (!src) {
    throw new Error(`shapeRangoQuoteRequestArtifact: unknown source "${source}" (RANGO_SOURCES keys: ${Object.keys(RANGO_SOURCES).join(", ")})`);
  }
  const request = shapeQuoteRequestArtifact({
    from: src.asset,
    to: to.asset,
    amount,
    ...(slippage !== undefined ? { slippage } : {}),
    ...(proxyPath ? { proxyPath } : {}),
  });
  return {
    source,
    from: src.asset,
    to: to.asset,
    amount: String(amount),
    slippage: request.params.slippage,
    ...request,
  };
}

/**
 * Create the Rango quote leg.
 * ctx per phase:
 *   build: { source, amount, to?, slippage?, proxyPath? }
 */
export function createRangoQuoteLeg() {
  return createLeg({
    id: "rango-quote",
    family: "external",
    chain: "rango",
    description:
      "The Rango quote leg — the deterministic request to OUR proxy /api/rango/quote " +
      "(raw base-unit amount, canonical asset strings, slippage explicit, no referrer " +
      "params while the fee-class placeholder is empty). family 'external': the swap is " +
      "executed in the user's wallet — no in-app signer exists for the Rango lane yet " +
      "(golden step1).",
    goldenStep: "step1-quote-request",
    phases: {
      async build(ctx) {
        if (!ctx.source) throw new Error("rangoQuoteLeg.build: source is required");
        if (!Number.isFinite(Number(ctx.amount)) || Number(ctx.amount) <= 0) {
          throw new Error("rangoQuoteLeg.build: a positive raw amount is required");
        }
        const artifact = shapeRangoQuoteRequestArtifact({
          source: ctx.source,
          amount: String(ctx.amount),
          ...(ctx.to ? { to: ctx.to } : {}),
          ...(ctx.slippage !== undefined ? { slippage: ctx.slippage } : {}),
          ...(ctx.proxyPath ? { proxyPath: ctx.proxyPath } : {}),
        });
        return { needed: true, artifact };
      },
    },
    meta: {
      wraps:
        "src/lib/rango/quote.js shapeQuoteRequestArtifact + parseRangoQuoteResponse " +
        "(the quote fetch + parse stay in the stage/UI layer with the proven pure parse — " +
        "this leg pins the deterministic request + the canonical parse contract)",
    },
  });
}
