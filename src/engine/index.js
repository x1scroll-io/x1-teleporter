/**
 * engine/index.js — the routing engine facade (Phase 1).
 *
 * The routing engine owns HOW a route executes: a RoutePlanner plans the
 * route as ordered LegContract legs grouped into UI stages, a SignerResolver
 * maps chain families to sign-capable surfaces, and the stage runners drive
 * the legs through the lifecycle (build → simulate → requestSignature →
 * submit → confirm) with dependency-injected connections/wallets.
 *
 * Phase 1 scope (docs/ROUTING-ENGINE.md): ONE route — the forward leg
 * ETH → X1 — byte-identical to the reference path (proven by the golden
 * fixtures + the browser harness). Reverse, THORChain and DEX lanes stay on
 * their existing code paths untouched.
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
  RoutePlanner,
  planForward,
  plan,
  legById,
  legsForStage,
} from "./routePlanner.js";
export { runForwardEvmStage, ensureEvmChain } from "./runners/forwardEvmStage.js";
export { runForwardSvmStage } from "./runners/forwardSvmStage.js";

// Forward-leg builders are reachable for oracle/byte-identity checks:
export { buildApprovalArtifact, resolveQuoteStep } from "./legs/forward/approvalLeg.js";
export { buildBridgeTxArtifact } from "./legs/forward/lifiEvmLeg.js";
export { shapeAtaCreateArtifact } from "./legs/forward/ataCreateLeg.js";
export {
  shapeWarpLockArtifact,
  deriveBridgeInV2AccountList,
  u64le,
} from "./legs/forward/warpLockLeg.js";
