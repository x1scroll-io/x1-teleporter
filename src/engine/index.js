/**
 * engine/index.js — the routing engine facade.
 *
 * The routing engine owns HOW a route executes: a RoutePlanner plans the
 * route as ordered LegContract legs grouped into UI stages, a SignerResolver
 * maps chain families to sign-capable surfaces, and the stage runners drive
 * the legs through the lifecycle (build → simulate → requestSignature →
 * submit → confirm) with dependency-injected connections/wallets.
 *
 * Phase 1 (docs/ROUTING-ENGINE.md): the forward leg ETH → X1 — byte-identical
 * to the reference path (proven by the golden fixtures + the browser
 * harness). Phase 2: the REVERSE leg X1 → EVM joins the engine — the X1 Warp
 * burn, the release-wait poll, and the LiFi Solana→EVM out leg to the PINNED
 * EVM destination, with the reverse LiFi-out signer resolved through the
 * SAME single SignerResolver the forward leg uses. THORChain and DEX lanes
 * stay on their existing code paths untouched.
 */
export { LEG_PHASES, createLeg, runLeg, legSkip, isLegSkip } from "./legContract.js";
export {
  SIGNER_FAMILIES,
  SignerResolver,
  resolveSigner,
  familyCanSign,
  familyLabel,
} from "./signerResolver.js";
export {
  FORWARD_LEG_IDS,
  FORWARD_STAGES,
  REVERSE_LEG_IDS,
  REVERSE_STAGES,
  RoutePlanner,
  planForward,
  planReverse,
  plan,
  legById,
  legsForStage,
} from "./routePlanner.js";
export { runForwardEvmStage, ensureEvmChain } from "./runners/forwardEvmStage.js";
export { runForwardSvmStage } from "./runners/forwardSvmStage.js";
export { runReverseX1Stage } from "./runners/reverseX1Stage.js";
export { runReleaseWait } from "./runners/reverseReleaseStage.js";
export { runReverseLiFiStage } from "./runners/reverseLiFiStage.js";

// Forward-leg builders are reachable for oracle/byte-identity checks:
export { buildApprovalArtifact, resolveQuoteStep } from "./legs/forward/approvalLeg.js";
export { buildBridgeTxArtifact } from "./legs/forward/lifiEvmLeg.js";
export { shapeAtaCreateArtifact } from "./legs/forward/ataCreateLeg.js";
export {
  shapeWarpLockArtifact,
  deriveBridgeInV2AccountList,
  u64le,
} from "./legs/forward/warpLockLeg.js";

// Reverse-leg builders are reachable for oracle/byte-identity checks:
export {
  shapeReverseBurnArtifact,
  toPubkey as reverseToPubkey,
} from "./legs/reverse/x1BurnLeg.js";
export { buildLifiOutArtifact } from "./legs/reverse/lifiSolanaOutLeg.js";
