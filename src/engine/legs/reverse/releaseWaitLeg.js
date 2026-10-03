/**
 * releaseWaitLeg.js — the Warp release-wait leg of the reverse route
 * (X1 → EVM): after the X1 burn is broadcast, the OFFICIAL Warp submitter +
 * guardians release the token on Solana. The app NEVER constructs or
 * broadcasts that release (submitter-side, since step 1.2 removed the
 * self-relay) — this leg's job is DETECTION: poll the app's OWN serverless
 * proxy (/api/warp/status + /api/warp/signatures — same-origin, the #40
 * fix/proxy-warp-poll path) with from=x1 until the destination release tx
 * appears (or the poll times out / the bridge reports a terminal failure).
 *
 * LEG CONTRACT PLACEMENT
 *   build    — deterministic artifact: the poll parameters (source sig,
 *              direction from=x1, api base) + the expected-release reference.
 *              Pure/offline.
 *   confirm  — finality: pollWarpStatus(sourceSig, …) — the PROVEN poller
 *              (warpBridge.pollWarpStatus, unchanged — the #34 destTxSig
 *              completion detection + the #40 same-origin proxy). Resolves
 *              { ok, destinationTx } when the release is confirmed.
 *
 * WHAT IS APP-CONSTRUCTED vs SUBMITTER-CONSTRUCTED (documented — the golden
 * step2 fixture pins this split): the app constructs the burn + knows the
 * EXPECTED release (bridge gross − Warp's per-token fee — the deterministic
 * stage-1 math) and the bridge_in_v2 account SHAPE (native variant: the
 * vault slots present, mint_authority filled with the program id — verified
 * against the live mainnet release). The submitter constructs + broadcasts
 * the release tx itself (payer = the submitter service, the guardian-signed
 * signature_set, the message-derived incoming_msg account, and the recipient
 * ATA create-if-missing bundled in front — all observed in the live release
 * tx v6etkXX…). The poll leg never guesses those.
 *
 * ctx: { sourceSig, from?, api?, maxMs?, onUpdate? }
 */
import { createLeg } from "../../legContract.js";
import { pollWarpStatus } from "../../../warpBridge.js";

/**
 * Create the Warp release-wait leg.
 * ctx per phase:
 *   build:   { sourceSig, from?, api? }
 *   confirm: { sourceSig, from?, api?, maxMs?, onUpdate? } (+ build result)
 */
export function createReleaseWaitLeg() {
  return createLeg({
    id: "warp-release-wait",
    family: "svm",
    chain: "sol",
    description:
      "The Warp release poll — after the X1 burn, watch the same-origin /api/warp/* proxy " +
      "for the guardians' signature + the destination release tx on Solana (submitter-side " +
      "release; the app only DETECTS it). Wraps pollWarpStatus (the #40 proxy path + #34 " +
      "destTxSig detection) unchanged.",
    goldenStep: "step2-release-shape (detection + expected-release math)",
    phases: {
      async build(ctx) {
        if (!ctx.sourceSig) throw new Error("releaseWaitLeg.build: no source signature to poll");
        return {
          needed: true,
          artifact: {
            sourceSig: String(ctx.sourceSig),
            from: ctx.from || "x1",
            api: ctx.api ?? "",
            // The app never constructs the release tx — it waits for the
            // destination tx the OFFICIAL submitter broadcasts. The expected
            // release amount rides in ctx.expectedReleaseBase (the stage-1
            // net math) when the caller knows it; see golden step2.
            expectedReleaseBase: ctx.expectedReleaseBase ?? null,
          },
        };
      },

      async confirm(ctx, built) {
        const a = built?.build?.artifact;
        if (!a?.sourceSig) throw new Error("releaseWaitLeg.confirm: no poll artifact");
        // The PROVEN poller — unchanged. Completion detection (nested
        // `transaction` shape, destTxSig, executed/complete/success,
        // fail/terminal) + the 404-is-normal pre-detection semantics all
        // live inside pollWarpStatus.
        return pollWarpStatus(a.sourceSig, {
          api: a.api,
          from: a.from,
          onUpdate: ctx.onUpdate || (() => {}),
          maxMs: ctx.maxMs ?? 300_000,
          intervalMs: ctx.intervalMs ?? 4_000,
        });
      },
    },
    meta: {
      wraps:
        "warpBridge.pollWarpStatus (the #40 same-origin /api/warp/* proxy path + the #34 " +
        "destTxSig completion detection) — the reverse release detection, unchanged. The " +
        "release tx itself is submitter-constructed (never built here).",
    },
  });
}
