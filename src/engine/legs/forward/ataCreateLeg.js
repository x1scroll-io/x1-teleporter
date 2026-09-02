/**
 * ataCreateLeg.js — the X1 recipient ATA-create leg of the forward route
 * (the bridge_in_v2 prerequisite). Reproduces golden step2a
 * (test/fixtures/golden/forward-leg/step2a-x1-ata-prep.json) and is the
 * engine home of the X1-prep flow runStage2 executes (src/warpBridge.js):
 *
 *   Warp's bridge_in_v2 (guardians) requires the recipient's token ATA on X1
 *   (USDC.x / wSOL.X — both Token-2022) to ALREADY exist before the Solana
 *   lock. This leg creates it IDEMPOTENTLY on X1 (payer = the connected
 *   wallet) and is what step2a of the golden oracle pins byte-for-byte.
 *
 * REUSE (wrap, don't rewrite): ensureX1RecipientAta + sendX1AtaCreation from
 * src/warpBridge.js — the PROVEN builders/senders, unchanged. simulateStage2
 * (src/warpBridge.js → simulateTx.simulateSolanaTx) is the fail-closed gate.
 *
 * LIFECYCLE
 *   build    → ensureX1RecipientAta against the X1 connection; when the ATA is
 *              missing (needsCreation) the artifact is the unsigned serialized
 *              create tx (golden step2a shape). When it already exists the leg
 *              reports needed:false — the stage runner skips it (no-op prep,
 *              exactly like runStage2).
 *   simulate → X1 simulation of the create tx (fail-closed: a rejection or an
 *              unreachable X1 RPC blocks the send; returns the normalized
 *              { ok, err/logs/simUnavailable } shape).
 *   submit   → sendX1AtaCreation: guarded broadcast through the SAME X1
 *              connection the tx was built/simulated against (signTransaction
 *              + app-side broadcast preferred — a wallet pointed at Solana
 *              mainnet cannot broadcast an X1 tx itself). allowLive gates this
 *              in the stage runner (WARP_LIVE_SEND).
 *
 * ctx: { connection (X1 RPC), userPubkey, payer, mint, blockhash?,
 *        provider?, allowLive? }
 */
import { createLeg } from "../../legContract.js";
import {
  ensureX1RecipientAta,
  sendX1AtaCreation,
  simulateStage2,
  X1_USDCX_MINT,
} from "../../../warpBridge.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

export function toPubkey(pk) {
  return pk instanceof PublicKey ? pk : new PublicKey(pk);
}

/**
 * Build the golden step2a artifact: the unsigned, serialized
 * createAssociatedTokenAccount (Token-2022) transaction.
 * Deterministic given the same inputs + blockhash.
 */
export function shapeAtaCreateArtifact({ prep, solanaAddress, blockhash, mint }) {
  const tx = prep.transaction;
  if (blockhash) tx.recentBlockhash = blockhash; // pin (belt+braces, like the golden rebuild)
  const bytes = tx.serialize({ requireAllSignatures: false });
  return {
    programId: tx.instructions[0].programId.toBase58(),
    ata: prep.ata.toBase58(),
    owner: solanaAddress,
    payer: solanaAddress,
    mint: (mint instanceof PublicKey ? mint : new PublicKey(mint)).toBase58(),
    tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    serializedBase64: Buffer.from(bytes).toString("base64"),
  };
}

/**
 * Create the X1 ATA-prep leg.
 * ctx per phase:
 *   build:    { connection, userPubkey, payer?, mint?, blockhash? }
 *   simulate: { connection } (+ build result)
 *   submit:   { connection, provider } (+ build result)
 */
export function createAtaCreateLeg() {
  return createLeg({
    id: "x1-ata-create",
    family: "svm",
    chain: "x1",
    description:
      "X1 recipient ATA-create (Token-2022, idempotent) — the bridge_in_v2 prerequisite. " +
      "Golden step2a. Skips itself when the ATA already exists on X1.",
    goldenStep: "step2a-x1-ata-prep",
    phases: {
      async build(ctx) {
        const userPubkey = toPubkey(ctx.userPubkey);
        const payer = ctx.payer ? toPubkey(ctx.payer) : userPubkey;
        const mint = ctx.mint ? toPubkey(ctx.mint) : X1_USDCX_MINT; // ensure's default, explicit here
        const prep = await ensureX1RecipientAta({
          connection: ctx.connection,
          userPubkey,
          payer,
          mint,
        });
        if (!prep.needsCreation) {
          return { needed: false, reason: "ata-exists", prep, artifact: null };
        }
        const artifact = shapeAtaCreateArtifact({
          prep,
          solanaAddress: userPubkey.toBase58(),
          blockhash: ctx.blockhash,
          mint,
        });
        return { needed: true, prep, artifact };
      },

      async simulate(ctx, built) {
        const b = built?.build;
        if (!b || !b.needed) return { ok: true, skipSubmit: true, reason: "ata-exists" };
        return simulateStage2(ctx.connection, b.prep.transaction); // normalized { ok, ... } — fail-closed
      },

      async submit(ctx, built) {
        const b = built?.build;
        if (!b?.needed) throw new Error("ataCreateLeg.submit: no create tx to submit");
        if (!ctx.provider) throw new Error("ataCreateLeg.submit: no Solana/X1 signer");
        return sendX1AtaCreation(ctx.connection, b.prep.transaction, ctx.provider);
      },
    },
    meta: {
      wraps:
        "warpBridge.ensureX1RecipientAta (build) + sendX1AtaCreation (guarded broadcast) + " +
        "simulateStage2 (fail-closed sim) — runStage2's X1-prep step, unchanged",
    },
  });
}
