/**
 * wanchainQuoteLeg.js — the WANCHAIN-FAMILY QUOTE leg (XFlows v3 rail —
 * Wanchain's only public quote+buildTx HTTP API, verified live 2026-09-05;
 * evidence: test/fixtures/golden/wanchain-leg/). This leg is the engine
 * home of the lane's QUOTE GATE: the deterministic request the lane sends
 * to OUR serverless proxy /api/wanchain/quote (POST, JSON body — the
 * upstream is keyless today; a future key lives server-side only), amounts
 * in HUMAN units (the XFlows API quotes in decimal units — its response
 * carries both amountOut and amountOutRaw), and the canonical parse of the
 * response (parseWanchainQuoteResponse — pure, shared with the fixtures).
 *
 * 🔴 COVERAGE GATE (fail-closed honesty — READ FIRST): the live XFlows
 * quote router serves ONLY EVM-chain pairs today. Every non-EVM probe
 * failed (ADA→SOL, ADA→WAN, BTC→SOL, TRX→SOL — and the EVM control
 * USDC(ETH)→SOL: "no token pair for SOL"). The leg's build() therefore
 * REFUSES any source that is not in WANCHAIN_SOURCES (the quotable
 * registry — today: the EVM class only). Cardano/Sui/Polkadot are NOT
 * quotable through any public Wanchain HTTP API, whatever the docs'
 * product matrix claims. When a route the app needs becomes quotable,
 * re-verify live FIRST, then add the source row + update the coverage
 * matrix (teleportRail.js + docs/ROUTING-ENGINE.md) together.
 *
 * LEG CONTRACT PLACEMENT
 *   build — the deterministic artifact: the canonical serialized quote
 *           request (proxy URL + POST body with the whitelisted fields).
 *           Pure/offline — the golden fixture pins it.
 *
 *   There is NO simulate/submit on this leg: the quote fetch + the parse
 *   happen in the stage/UI layer with the proven parseWanchainQuoteResponse
 *   (DI — the leg never constructs endpoints or fetches), and the transfer
 *   itself is executed in the user's wallet (see the wanchain-execute leg).
 *   family "external" → the SignerResolver returns null BY DESIGN.
 *
 * REUSE (wrap, don't rewrite): shapeQuoteRequest / parseWanchainQuoteResponse
 * come from src/lib/wanchain/quote.js — the SAME functions the future stage
 * layer's quote moment will call. One construction code path for the
 * reference flow and the engine, so the two cannot drift.
 *
 * ctx: { source ("eth" — a WANCHAIN_SOURCES key; the coverage gate refuses
 *        anything else), fromChainId?, toChainId?, fromTokenAddress?,
 *        toTokenAddress?, fromAddress, toAddress, fromAmount (human units),
 *        slippage?, bridge?, proxyPath? }
 */
import { createLeg } from "../../legContract.js";
import { shapeQuoteRequest } from "../../../lib/wanchain/quote.js";
import {
  WANCHAIN_SOURCES,
  isWanchainQuotableSource,
} from "../../../lib/wanchain/config.js";

/**
 * Shape the golden step1 artifact from the same pure function the future
 * stage layer calls — the canonical proxy quote request.
 *
 * @param {object} args
 * @param {string} args.source a WANCHAIN_SOURCES key ("eth" — the only
 *   quotable row today; anything else throws via the coverage gate)
 * @param {string} args.fromAddress the user's REAL source wallet address
 * @param {string} args.toAddress the destination wallet address
 * @param {string|number} args.fromAmount HUMAN-unit source amount
 * @param {number|string} [args.fromChainId] override (default: the source
 *   row's chainId)
 * @param {number|string} [args.toChainId] destination chain id (default:
 *   none — REQUIRED by the live API; the caller supplies the destination
 *   the journey needs)
 * @param {string} [args.fromTokenAddress] default the source's native
 *   address when the source row defines one
 * @param {string} [args.toTokenAddress] REQUIRED destination token address
 * @param {number} [args.slippage] slippage (module default 0.01)
 * @param {string} [args.bridge] optional "wanbridge" | "quix"
 * @param {string} [args.proxyPath] DI proxy path (default the real one)
 * @returns {object} the fixture-shaped artifact
 */
export function shapeWanchainQuoteRequestArtifact({
  source,
  fromAddress,
  toAddress,
  fromAmount,
  fromChainId,
  toChainId,
  fromTokenAddress,
  toTokenAddress,
  slippage,
  bridge,
  proxyPath,
}) {
  const src = WANCHAIN_SOURCES[source];
  if (!src) {
    throw new Error(
      `shapeWanchainQuoteRequestArtifact: source "${source}" is NOT in the quotable registry ` +
        `(WANCHAIN_SOURCES keys: ${Object.keys(WANCHAIN_SOURCES).join(", ")}). ` +
        `Live-verified 2026-09-05: the Wanchain-family quote API serves only these. ` +
        `Cardano/Sui/Polkadot/native-UTXO routes all FAILED live probes — do not add a source ` +
        `without a successful live probe of that exact route (evidence: ` +
        `test/fixtures/golden/wanchain-leg/VERIFICATION-2026-09-05.json).`
    );
  }
  const request = shapeQuoteRequest({
    fromChainId: fromChainId ?? src.chainId,
    toChainId,
    fromTokenAddress: fromTokenAddress ?? (src.tokenAddress || "0x0000000000000000000000000000000000000000"),
    toTokenAddress,
    fromAddress,
    toAddress,
    fromAmount,
    ...(slippage !== undefined ? { slippage } : {}),
    ...(bridge ? { bridge } : {}),
    ...(proxyPath ? { proxyPath } : {}),
  });
  return {
    source,
    fromChainId: Number(fromChainId ?? src.chainId),
    toChainId: Number(toChainId),
    fromTokenAddress: fromTokenAddress ?? "0x0000000000000000000000000000000000000000",
    toTokenAddress,
    fromAmount: String(fromAmount),
    ...request,
  };
}

/**
 * Create the Wanchain-family quote leg.
 * ctx per phase:
 *   build: { source, fromAddress, toAddress, fromAmount, toChainId,
 *            toTokenAddress, fromTokenAddress?, fromChainId?, slippage?,
 *            bridge?, proxyPath? }
 */
export function createWanchainQuoteLeg() {
  return createLeg({
    id: "wanchain-quote",
    family: "external",
    chain: "wanchain",
    description:
      "The Wanchain-family quote leg (XFlows v3) — the deterministic POST to OUR proxy " +
      "/api/wanchain/quote (whitelisted body fields only). 🔴 COVERAGE GATE: build() refuses " +
      "any source outside the live-quotable registry (today: the EVM class) — the live API " +
      "serves no non-EVM route (verified 2026-09-05; fixtures in test/fixtures/golden/" +
      "wanchain-leg/*.failed.json). family 'external': the transfer is signed in the user's " +
      "wallet (golden step1).",
    goldenStep: "step1-quote-request",
    phases: {
      async build(ctx) {
        if (!isWanchainQuotableSource(ctx.source)) {
          throw new Error(
            `wanchainQuoteLeg.build: source "${ctx.source}" is not quotable through the ` +
              `Wanchain-family API (coverage gate — WANCHAIN_SOURCES: ${Object.keys(WANCHAIN_SOURCES).join(", ")}).`
          );
        }
        if (!ctx.toChainId) throw new Error("wanchainQuoteLeg.build: toChainId is required");
        if (!ctx.toTokenAddress) throw new Error("wanchainQuoteLeg.build: toTokenAddress is required");
        if (!ctx.fromAddress) throw new Error("wanchainQuoteLeg.build: fromAddress (the real source wallet) is required");
        if (!ctx.toAddress) throw new Error("wanchainQuoteLeg.build: toAddress (the destination wallet) is required");
        if (!Number.isFinite(Number(ctx.fromAmount)) || Number(ctx.fromAmount) <= 0) {
          throw new Error("wanchainQuoteLeg.build: a positive fromAmount (human units) is required");
        }
        const artifact = shapeWanchainQuoteRequestArtifact({
          source: ctx.source,
          fromAddress: ctx.fromAddress,
          toAddress: ctx.toAddress,
          fromAmount: String(ctx.fromAmount),
          toChainId: ctx.toChainId,
          toTokenAddress: ctx.toTokenAddress,
          ...(ctx.fromChainId ? { fromChainId: ctx.fromChainId } : {}),
          ...(ctx.fromTokenAddress ? { fromTokenAddress: ctx.fromTokenAddress } : {}),
          ...(ctx.slippage !== undefined ? { slippage: ctx.slippage } : {}),
          ...(ctx.bridge ? { bridge: ctx.bridge } : {}),
          ...(ctx.proxyPath ? { proxyPath: ctx.proxyPath } : {}),
        });
        return { needed: true, artifact };
      },
    },
    meta: {
      wraps:
        "src/lib/wanchain/quote.js shapeQuoteRequest + parseWanchainQuoteResponse " +
        "(the quote fetch + parse stay in the stage/UI layer with the proven pure parse — " +
        "this leg pins the deterministic request + the canonical parse contract)",
      verified:
        "2026-09-05 live probes — XFlows v3 quotes EVM pairs only; every non-EVM route " +
        "failed (evidence: test/fixtures/golden/wanchain-leg/)",
    },
  });
}
