/**
 * wanchainExecuteLeg.js — the WANCHAIN-FAMILY TRANSFER-EXECUTION leg
 * (XFlows v3 rail).
 *
 * 🔴 LIVE-FUNDS BOUNDARY — READ FIRST:
 *   This leg is a GUARDED STUB. Its submit() THROWS WanchainLiveTestGateError:
 *   the transfer-execution anchor is "READY FOR LIVE TEST" — it requires a
 *   REAL broadcast by Mr. Esters (a live transfer needs live funds + a real
 *   source wallet; the autonomous agent NEVER fires it). Nothing in this leg
 *   ever signs, broadcasts, or moves funds. The honest error is the product.
 *
 * What the leg DOES pin (deterministic, offline):
 *   build — the canonical buildTx REQUEST artifact: the request the lane
 *           will send to OUR future /api/wanchain/buildTx proxy (XFlows's
 *           POST /api/v3/buildTx — the call that returns ready-to-sign
 *           transaction data for the user's wallet). The request carries
 *           the same coordinates as the accepted quote (fromChainId,
 *           toChainId, fromTokenAddress, toTokenAddress, fromAddress,
 *           toAddress, fromAmount, slippage, bridge) plus the quote's
 *           extraData when the upstream needs it for continuity (the exact
 *           buildTx body contract is pinned from the OpenAPI —
 *           https://xflows-open-api.wanscan.org/openapi.json — and is
 *           finalized against the REAL capture on the first live test).
 *
 *   The api/wanchain/buildTx.js proxy route does NOT exist yet — it lands
 *   WITH the live test (same shape as api/wanchain/quote.js: CORS
 *   allowlist, body whitelist). The leg pins the request SHAPE now so the
 *   live anchor is a wiring exercise, not a design exercise.
 *
 * LEG CONTRACT PLACEMENT
 *   build — the deterministic buildTx request artifact (above). Pure.
 *   simulate — undefined (external lane: nothing is simmed in-app; the
 *           buildTx response IS the pre-send artifact the user signs).
 *   requestSignature — undefined (the wallet boundary is the user's own
 *           wallet — the buildTx response is signed there, out-of-band).
 *   submit — 🔴 THROWS WanchainLiveTestGateError ALWAYS (the guard).
 *
 * family "external": the transfer executes in the user's wallet. The
 * engine's SignerResolver returns null for this lane BY DESIGN — no in-app
 * signer exists for the lane's source chains today (a later-phase wiring
 * decision, and it stays Mr. Esters' call).
 *
 * ctx: { source, fromAddress, toAddress, fromAmount, toChainId,
 *        toTokenAddress, fromTokenAddress?, fromChainId?, slippage?,
 *        bridge?, requestId?, proxyPath? }
 */
import { createLeg } from "../../legContract.js";

/** The honest gate error: this leg is not wired for autonomous broadcast. */
export class WanchainLiveTestGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "WanchainLiveTestGateError";
  }
}

/** The canonical message every guarded submit carries. */
export const WANCHAIN_LIVE_TEST_GATE_MESSAGE =
  "wanchain-execute: not wired for autonomous broadcast — the transfer-execution anchor is " +
  "READY FOR LIVE TEST and Mr. Esters fires live tests (a real transfer needs live funds " +
  "and a real source wallet). Nothing here signs or broadcasts.";

/**
 * Shape the golden buildTx request artifact: the canonical request the lane
 * sends to the (future) /api/wanchain/buildTx proxy — XFlows's POST
 * /api/v3/buildTx. The fromAddress/toAddress are the user's REAL wallets
 * (never placeholders — this builder THROWS on empty).
 *
 * @param {object} args
 * @param {string} args.source a WANCHAIN_SOURCES key
 * @param {number|string} args.toChainId destination chain id
 * @param {string} args.toTokenAddress destination token address
 * @param {string} args.fromAddress the user's SOURCE-chain wallet address
 * @param {string} args.toAddress the destination wallet address
 * @param {string|number} args.fromAmount HUMAN-unit source amount
 * @param {number|string} [args.fromChainId] source chain id (default: the
 *   source row's)
 * @param {string} [args.fromTokenAddress] source token address
 * @param {number} [args.slippage] slippage percent
 * @param {string} [args.bridge] optional "wanbridge" | "quix"
 * @param {string} [args.proxyPath] DI proxy path (default the future
 *   /api/wanchain/buildTx)
 * @returns {object} the fixture-shaped artifact
 */
export function shapeWanchainBuildTxRequestArtifact({
  source,
  toChainId,
  toTokenAddress,
  fromAddress,
  toAddress,
  fromAmount,
  fromChainId,
  fromTokenAddress,
  slippage,
  bridge,
  proxyPath = "/api/wanchain/buildTx",
}) {
  if (!source) throw new Error("shapeWanchainBuildTxRequestArtifact: source is required");
  if (toChainId === undefined) throw new Error("shapeWanchainBuildTxRequestArtifact: toChainId is required");
  if (!toTokenAddress) throw new Error("shapeWanchainBuildTxRequestArtifact: toTokenAddress is required");
  if (!fromAddress) throw new Error("shapeWanchainBuildTxRequestArtifact: fromAddress is required (no placeholders)");
  if (!toAddress) throw new Error("shapeWanchainBuildTxRequestArtifact: toAddress is required (the destination wallet)");
  const amountStr = String(fromAmount);
  if (!Number.isFinite(Number(amountStr)) || Number(amountStr) <= 0) {
    throw new Error(`shapeWanchainBuildTxRequestArtifact: a positive fromAmount is required (got "${amountStr}")`);
  }
  const body = {
    fromChainId: Number(fromChainId),
    toChainId: Number(toChainId),
    fromTokenAddress: fromTokenAddress || "0x0000000000000000000000000000000000000000",
    toTokenAddress,
    fromAddress,
    toAddress,
    fromAmount: amountStr,
    ...(slippage !== undefined ? { slippage: Number(slippage) } : {}),
    ...(bridge ? { bridge } : {}),
  };
  return {
    source,
    fromChainId: Number(fromChainId),
    toChainId: Number(toChainId),
    fromTokenAddress: body.fromTokenAddress,
    toTokenAddress,
    fromAddress,
    toAddress,
    fromAmount: amountStr,
    url: proxyPath,
    method: "POST",
    body,
    json: JSON.stringify(body),
  };
}

/**
 * Create the Wanchain-family transfer-execution leg (the GUARDED STUB).
 * ctx per phase:
 *   build: { source, fromAddress, toAddress, fromAmount, toChainId,
 *            toTokenAddress, fromTokenAddress?, fromChainId?, slippage?,
 *            bridge?, proxyPath? }
 *   submit: 🔴 always throws WanchainLiveTestGateError.
 */
export function createWanchainExecuteLeg() {
  return createLeg({
    id: "wanchain-execute",
    family: "external",
    chain: "wanchain",
    description:
      "The Wanchain-family transfer-execution leg — pins the canonical buildTx request " +
      "(POST /api/v3/buildTx via the future /api/wanchain/buildTx proxy). 🔴 GUARDED STUB: " +
      "submit() always throws WanchainLiveTestGateError — not wired for autonomous " +
      "broadcast; the transfer-execution anchor is READY FOR LIVE TEST and Mr. Esters " +
      "fires live tests. family 'external': the user signs in their own wallet.",
    goldenStep: "step2-buildtx-request",
    phases: {
      async build(ctx) {
        if (!ctx.source) throw new Error("wanchainExecuteLeg.build: source is required");
        if (!ctx.fromAddress) {
          throw new Error("wanchainExecuteLeg.build: fromAddress (the real source wallet) is required");
        }
        if (!ctx.toAddress) {
          throw new Error("wanchainExecuteLeg.build: toAddress (the destination wallet) is required");
        }
        if (ctx.toChainId === undefined) throw new Error("wanchainExecuteLeg.build: toChainId is required");
        if (!ctx.toTokenAddress) throw new Error("wanchainExecuteLeg.build: toTokenAddress is required");
        const artifact = shapeWanchainBuildTxRequestArtifact({
          source: ctx.source,
          fromAddress: ctx.fromAddress,
          toAddress: ctx.toAddress,
          fromAmount: String(ctx.fromAmount),
          toChainId: ctx.toChainId,
          toTokenAddress: ctx.toTokenAddress,
          ...(ctx.fromChainId !== undefined ? { fromChainId: ctx.fromChainId } : {}),
          ...(ctx.fromTokenAddress ? { fromTokenAddress: ctx.fromTokenAddress } : {}),
          ...(ctx.slippage !== undefined ? { slippage: ctx.slippage } : {}),
          ...(ctx.bridge ? { bridge: ctx.bridge } : {}),
          ...(ctx.proxyPath ? { proxyPath: ctx.proxyPath } : {}),
        });
        return { needed: true, artifact };
      },
      // 🔴 THE GUARD — the honest live-test boundary. This leg NEVER signs
      // or broadcasts. The sim gate in runLeg is irrelevant here (no
      // simulate defined): submit throws before anything could move.
      async submit() {
        throw new WanchainLiveTestGateError(WANCHAIN_LIVE_TEST_GATE_MESSAGE);
      },
    },
    meta: {
      wraps:
        "GREENFIELD guarded stub — pins the canonical /api/v3/buildTx request " +
        "(OpenAPI: https://xflows-open-api.wanscan.org/openapi.json). The " +
        "api/wanchain/buildTx.js proxy route + the live anchor land together when Mr. " +
        "Esters fires the first live test.",
      liveTestAnchor: "wanchain-buildtx-execution",
    },
  });
}
