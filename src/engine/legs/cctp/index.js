/**
 * legs/cctp/index.js — the CCTP legs: burn → attestation → mint.
 *
 * The CCTP route is three legs (plus optional source/dest swaps composed by the
 * planner):
 *   1. cctp-burn  — approve + TokenMessengerV2.depositForBurn on the SOURCE chain
 *                  (family evm/svm by source chain; the signer is the user's wallet).
 *   2. cctp-attest — poll Circle's PUBLIC Iris API for the signed attestation
 *                  (family "external": no signer, it just waits on the network).
 *   3. cctp-mint  — MessageTransmitter.receiveMessage(message, attestation) on the
 *                  DESTINATION chain (family evm/svm by destination).
 *
 * Durable + resume-safe: the burn artifact carries the nonce + tx hash, so an
 * interrupted mint NEVER repeats a confirmed burn (the runner reconciles the
 * message hash from the persisted burn before minting). See sdkCctp.js for the
 * pure builders this wraps.
 */
import { createLeg } from "../../legContract.js";
import { buildBurn, buildMint, fetchAttestation, encodeMintRecipient } from "../../../lib/sdk/sdkCctp.js";
import { cctpConfigFor, DOMAIN_IDS } from "../../../lib/cctp/config.js";

/** Family for a CCTP chain: solana -> "svm", everything else -> "evm". */
function cctpFamily(chainKey) {
  return chainKey === "sol" ? "svm" : "evm";
}

/** Source-chain burn leg. */
export function createCctpBurnLeg() {
  return createLeg({
    id: "cctp-burn",
    family: "evm", // resolved per ctx at run time (source chain)
    chain: "cctp",
    description:
      "Circle CCTP burn — approve native USDC to TokenMessengerV2, then depositForBurn " +
      "(amount, destinationDomain, mintRecipient, burnToken). The caller approves; this leg " +
      "builds the burn calldata. Family resolves to evm/svm by the source chain.",
    phases: {
      async build(ctx) {
        const cfg = cctpConfigFor(ctx.sourceChainKey);
        if (!cfg) throw new Error(`cctpBurn.build: ${ctx.sourceChainKey} is not a configured CCTP source`);
        const destDomain = DOMAIN_IDS[ctx.destChainKey];
        if (destDomain === undefined) throw new Error(`cctpBurn.build: no CCTP domain for ${ctx.destChainKey}`);
        const mintRecipient = encodeMintRecipient(ctx.destAddress, ctx.destChainKey);
        const burn = buildBurn({
          sourceChainKey: ctx.sourceChainKey,
          amountWei: ctx.amountWei,
          destinationDomain: destDomain,
          mintRecipient,
          burnToken: cfg.usdcMint,
          destinationCaller: ctx.destinationCaller,
        });
        return {
          needed: true,
          artifact: {
            ...burn,
            sourceChainKey: ctx.sourceChainKey,
            destinationDomain: destDomain,
            mintRecipient,
            usdcMint: cfg.usdcMint,
          },
        };
      },
    },
    meta: { wraps: "src/lib/sdk/sdkCctp.js buildBurn + src/lib/cctp/config.js (addresses/domains)" },
  });
}

/** Attestation leg — polls the public Iris API (no signer, no key). */
export function createCctpAttestLeg() {
  return createLeg({
    id: "cctp-attest",
    family: "external",
    chain: "cctp",
    description:
      "Circle CCTP attestation — poll the public Iris API (no Circle API key) for the " +
      "signed attestation of a burned message, until status 'complete' or timeout.",
    phases: {
      async build(ctx) {
        if (!ctx.sourceDomain || !ctx.burnTxHash) {
          throw new Error("cctpAttest.build: sourceDomain + burnTxHash are required");
        }
        const attest = await fetchAttestation({
          sourceDomain: ctx.sourceDomain,
          txHash: ctx.burnTxHash,
          pollMs: ctx.pollMs,
          timeoutMs: ctx.timeoutMs,
          fetchImpl: ctx.fetchImpl,
        });
        return { needed: true, artifact: { message: attest.message, attestation: attest.attestation, status: attest.status } };
      },
    },
    meta: { wraps: "src/lib/sdk/sdkCctp.js fetchAttestation (Iris API, keyless)" },
  });
}

/** Destination-chain mint leg. */
export function createCctpMintLeg() {
  return createLeg({
    id: "cctp-mint",
    family: "evm", // resolved per ctx (destination chain)
    chain: "cctp",
    description:
      "Circle CCTP mint — MessageTransmitter.receiveMessage(message, attestation) on the " +
      "destination chain. Fails closed when the destination transmitter is not configured.",
    phases: {
      async build(ctx) {
        const mint = buildMint({
          destChainKey: ctx.destChainKey,
          message: ctx.message,
          attestation: ctx.attestation,
        });
        return { needed: true, artifact: { ...mint, destChainKey: ctx.destChainKey } };
      },
    },
    meta: { wraps: "src/lib/sdk/sdkCctp.js buildMint (fail-closed on unconfigured transmitter)" },
  });
}

/** The three CCTP legs in route order. */
export function buildCctpLegs() {
  return [createCctpBurnLeg(), createCctpAttestLeg(), createCctpMintLeg()];
}
