/**
 * rangoExecuteLeg.js — the RANGO SWAP-EXECUTION leg (Phase-5 scaffold).
 *
 * 🔴 LIVE-FUNDS BOUNDARY — READ FIRST:
 *   This leg is a GUARDED STUB. Its submit() THROWS RangoLiveTestGateError:
 *   the swap-execution anchor is "READY FOR LIVE TEST" — it requires a REAL
 *   broadcast by Mr. Esters (a live swap needs live funds + a real source
 *   wallet; the autonomous agent NEVER fires it). Nothing in this leg ever
 *   signs, broadcasts, or moves funds. The honest error is the product.
 *
 * What the leg DOES pin (deterministic, offline):
 *   build — the canonical swap-create REQUEST artifact: the request the
 *           lane will send to OUR future /api/rango/swap proxy (Rango's
 *           GET /basic/swap — the create-transaction call that returns the
 *           unsigned tx for the user's wallet). Fields (documented at
 *           docs.rango.exchange …/create-transaction-swap): from, to,
 *           amount, slippage, fromAddress (the user's SOURCE wallet), 
 *           toAddress (the destination wallet — for the SOL-landing lane:
 *           the Solana session pubkey, the same PIN the THORChain lane
 *           uses), disableEstimate (true — the app checks balances
 *           client-side before the call; documented to cut response time),
 *           and the referrer pair ONLY when the config placeholders are
 *           set. The requestId from the accepted quote is carried so the
 *           create-tx continuation is traceable.
 *
 *   The api/rango/swap.js proxy route does NOT exist yet — it lands WITH
 *   the live test (same shape as api/rango/quote.js: CORS allowlist,
 *   whitelist, server-side key). The leg pins the request SHAPE now so the
 *   live anchor is a wiring exercise, not a design exercise.
 *
 * LEG CONTRACT PLACEMENT
 *   build — the deterministic swap-create request artifact (above). Pure.
 *   simulate — undefined (external lane: nothing is simmed in-app; the
 *           swap-create response IS the pre-send artifact the user signs).
 *   requestSignature — undefined (the wallet boundary is the user's own
 *           wallet — the create-tx response is signed there, out-of-band).
 *   submit — 🔴 THROWS RangoLiveTestGateError ALWAYS (the guard).
 *
 * family "external": the swap executes in the user's wallet. The engine's
 * SignerResolver returns null for this lane BY DESIGN — no in-app signer
 * exists for Rango source chains today (the SUI/TRON/XRPL wallet families
 * are a later-phase wiring decision, and it stays Mr. Esters' call).
 *
 * ctx: { source, amount, fromAddress, toAddress?, slippage?, requestId?,
 *        proxyPath? }
 */
import { createLeg } from "../../legContract.js";
import { rangoAssetId } from "../../../lib/rango/quote.js";
import {
  RANGO_SOURCES,
  RANGO_DESTINATION_SOL,
  RANGO_REFERRER_FEE,
  RANGO_REFERRER_ADDRESS,
  RANGO_DEFAULT_SLIPPAGE_PERCENT,
} from "../../../lib/rango/config.js";

/** The honest gate error: this leg is not wired for autonomous broadcast. */
export class RangoLiveTestGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "RangoLiveTestGateError";
  }
}

/** The canonical message every guarded submit carries. */
export const RANGO_LIVE_TEST_GATE_MESSAGE =
  "rango-execute: not wired for autonomous broadcast — the swap-execution anchor is " +
  "READY FOR LIVE TEST and Mr. Esters fires live tests (a real swap needs live funds " +
  "and a real source wallet). Nothing here signs or broadcasts.";

/**
 * Shape the golden swap-create request artifact: the canonical request the
 * lane sends to the (future) /api/rango/swap proxy — Rango's GET
 * /basic/swap create-transaction call. The fromAddress is the user's REAL
 * source wallet (never a placeholder — this builder THROWS on empty), the
 * toAddress defaults to the SOL-landing destination (the Solana session
 * pubkey PIN), disableEstimate is fixed true (the app checks balances
 * before the call — documented behavior), and the referrer pair rides
 * along ONLY when the config placeholders are set.
 *
 * @param {object} args
 * @param {string} args.source a RANGO_SOURCES key
 * @param {string|number} args.amount RAW source amount in base units
 * @param {string} args.fromAddress the user's SOURCE-chain wallet address
 * @param {string} [args.toAddress] destination wallet (default
 *   RANGO_DESTINATION_SOL's chain session pubkey — supplied by the caller)
 * @param {number} [args.slippage] slippage percent (module default 0.5)
 * @param {string} [args.requestId] the accepted quote's requestId
 * @param {string} [args.proxyPath] DI proxy path (default the future
 *   /api/rango/swap)
 * @returns {object} the fixture-shaped artifact
 */
export function shapeRangoSwapRequestArtifact({
  source,
  amount,
  fromAddress,
  toAddress,
  slippage = RANGO_DEFAULT_SLIPPAGE_PERCENT,
  requestId = null,
  proxyPath = "/api/rango/swap",
}) {
  const src = RANGO_SOURCES[source];
  if (!src) {
    throw new Error(`shapeRangoSwapRequestArtifact: unknown source "${source}"`);
  }
  if (!fromAddress) {
    throw new Error("shapeRangoSwapRequestArtifact: fromAddress is required (no placeholders)");
  }
  if (!toAddress) {
    throw new Error("shapeRangoSwapRequestArtifact: toAddress is required (the destination wallet)");
  }
  const amountStr = String(amount);
  if (!/^[0-9]+$/.test(amountStr)) {
    throw new Error(`shapeRangoSwapRequestArtifact: amount must be raw base units (got "${amountStr}")`);
  }
  const params = {
    from: src.asset,
    to: RANGO_DESTINATION_SOL.asset,
    amount: amountStr,
    slippage: String(slippage),
    fromAddress,
    toAddress,
    disableEstimate: "true",
    ...(requestId ? { requestId } : {}),
    ...(RANGO_REFERRER_FEE !== "" ? { referrerFee: String(RANGO_REFERRER_FEE) } : {}),
    ...(RANGO_REFERRER_ADDRESS !== "" ? { referrerAddress: RANGO_REFERRER_ADDRESS } : {}),
  };
  const qs = new URLSearchParams(params);
  return {
    source,
    from: src.asset,
    to: RANGO_DESTINATION_SOL.asset,
    amount: amountStr,
    fromAddress,
    toAddress,
    url: `${proxyPath}?${qs.toString()}`,
    params,
    // The destination asset record (Rango id + decimals) — the run ctx
    // needs it to interpret the create-tx response's toAmount.
    destination: RANGO_DESTINATION_SOL,
  };
}

/**
 * Create the Rango swap-execution leg (the GUARDED STUB).
 * ctx per phase:
 *   build: { source, amount, fromAddress, toAddress?, slippage?,
 *            requestId?, proxyPath? }
 *   submit: 🔴 always throws RangoLiveTestGateError.
 */
export function createRangoExecuteLeg() {
  return createLeg({
    id: "rango-execute",
    family: "external",
    chain: "rango",
    description:
      "The Rango swap-execution leg — pins the canonical swap-create request (GET " +
      "/basic/swap via the future /api/rango/swap proxy: from/to/amount/slippage/" +
      "fromAddress/toAddress/disableEstimate + referrer pair only when configured). " +
      "🔴 GUARDED STUB: submit() always throws RangoLiveTestGateError — not wired for " +
      "autonomous broadcast; the swap-execution anchor is READY FOR LIVE TEST and Mr. " +
      "Esters fires live tests. family 'external': the user signs in their own wallet.",
    goldenStep: "step2-swap-request",
    phases: {
      async build(ctx) {
        if (!ctx.source) throw new Error("rangoExecuteLeg.build: source is required");
        if (!Number.isFinite(Number(ctx.amount)) || Number(ctx.amount) <= 0) {
          throw new Error("rangoExecuteLeg.build: a positive raw amount is required");
        }
        if (!ctx.fromAddress) {
          throw new Error("rangoExecuteLeg.build: fromAddress (the real source wallet) is required");
        }
        if (!ctx.toAddress) {
          throw new Error("rangoExecuteLeg.build: toAddress (the destination wallet — the SOL session pubkey PIN) is required");
        }
        const artifact = shapeRangoSwapRequestArtifact({
          source: ctx.source,
          amount: String(ctx.amount),
          fromAddress: ctx.fromAddress,
          toAddress: ctx.toAddress,
          ...(ctx.slippage !== undefined ? { slippage: ctx.slippage } : {}),
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          ...(ctx.proxyPath ? { proxyPath: ctx.proxyPath } : {}),
        });
        return { needed: true, artifact };
      },
      // 🔴 THE GUARD — the honest live-test boundary. This leg NEVER signs
      // or broadcasts. The sim gate in runLeg is irrelevant here (no
      // simulate defined): submit throws before anything could move.
      async submit() {
        throw new RangoLiveTestGateError(RANGO_LIVE_TEST_GATE_MESSAGE);
      },
    },
    meta: {
      wraps:
        "GREENFIELD guarded stub — pins the canonical /basic/swap create-transaction " +
        "request (docs.rango.exchange …/create-transaction-swap). The api/rango/swap.js " +
        "proxy route + the live anchor land together when Mr. Esters fires the first " +
        "live test.",
      liveTestAnchor: "rango-swap-execution",
    },
  });
}

// Re-exported for callers that build request artifacts without a leg
// (tests, capture scripts) — same pure function the leg's build uses.
export { rangoAssetId };
