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
 * SAME single SignerResolver the forward leg uses. Phase 3: the THORChain
 * deposit-address lane (BTC/DOGE/LTC/XRP → SOL.SOL) joins as two legs — the
 * quote-request leg + the deposit-build leg, both family "external" (the
 * deposit executes out-of-band in the user's external wallet — the resolver
 * returns null by design). Phase 4: the DEX swap legs join — jupiter-swap
 * (Solana DEX aggregator, family svm), xdex-swap (X1's DEX — DIRECT
 * on-chain into the XDEX CP-Swap program, family svm) and lifi-evm-swap
 * (the Leg-C verdict leg — EVM same-chain swaps are DONE by LiFi, family
 * evm) — construction-migrated + pinned by the Phase-4 oracle
 * (test/goldenDex.test.js + test/fixtures/golden/dex-leg/), with
 * composeRoute as the swap-then-bridge composition primitive.
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
  THORCHAIN_LEG_IDS,
  THORCHAIN_STAGES,
  JUPITER_LEG_IDS,
  JUPITER_STAGES,
  XDEX_LEG_IDS,
  XDEX_STAGES,
  LIFI_EVM_SWAP_LEG_IDS,
  LIFI_EVM_SWAP_STAGES,
  RoutePlanner,
  planForward,
  planReverse,
  planThorchain,
  planJupiterSwap,
  planXdexSwap,
  planLifiEvmSwap,
  composeRoute,
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

// THORChain-leg builders are reachable for oracle/byte-identity checks:
export { shapeQuoteRequestArtifact } from "./legs/thorchain/quoteLeg.js";
export { shapeDepositPayloadArtifact } from "./legs/thorchain/depositBuildLeg.js";

// Phase-4 DEX-leg builders are reachable for oracle/byte-identity checks:
export { shapeJupiterQuoteRequestArtifact, shapeJupiterSwapRequestArtifact } from "./legs/dex/jupiterSwapLeg.js";
export { shapeXdexSwapArtifact, xdexQuote, resolveXdexDirection } from "./legs/dex/xdexSwapLeg.js";
export { shapeLifiSameChainSwapArtifact } from "./legs/dex/lifiEvmSwapLeg.js";
