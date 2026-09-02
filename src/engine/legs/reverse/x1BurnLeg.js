/**
 * x1BurnLeg.js — the X1 reverse burn leg of the reverse route (X1 → EVM):
 * the Warp `bridge_out` BURN of the X1 token (USDC.x / wSOL.X — Token-2022)
 * with the prepended 1% Teleporter skim transfer (and the bundled idempotent
 * fee-wallet ATA create when that ATA is missing). This leg is the engine
 * home of runReverse's construction half (src/warpBridge.js) — the proven
 * reverse stage-1 path (X1 → Solana release):
 *
 *   preflight (stage runner) — assertX1FeePayer + assertX1TokenBalance
 *                               (actionable errors instead of the bare
 *                               AccountNotFound / Custom(1))
 *   build    — buildReverseBurnWithSkim: THE shared construction helper
 *              (fee-wallet ATA prep + buildReverseBurn + the prepended skim
 *              transfer — create → transfer → burn in ONE tx when the fee
 *              ATA is missing). The golden step1 fixture (step1-x1-burn.json)
 *              pins the resulting bytes byte-for-byte.
 *   simulate — simulateStage2 (fail-closed: program rejection OR an
 *              unreachable RPC blocks the send)
 *   submit   — sendStage2ViaPhantom: signTransaction + app-side broadcast
 *              through the SAME connection the sim ran against, guarded.
 *              allowLive gates this in the stage runner (WARP_LIVE_SEND).
 *
 * REUSE (wrap, don't rewrite): buildReverseBurnWithSkim / buildReverseBurn /
 * ensureX1FeeWalletAta / simulateStage2 / sendStage2ViaPhantom all come from
 * src/warpBridge.js, unchanged. runReverse itself now calls the SAME shared
 * construction helper — one construction code path for the reference path
 * and the engine, so the two cannot drift.
 *
 * ctx: { connection (X1 RPC), userPubkey, amountHuman (the BURN amount =
 *        gross − skim), feeAmount (the 1% skim, token units), feeWallet,
 *        token ("USDC.x" | "wSOL.X"), seq?, blockhash?, seqSlot? }
 */
import { createLeg } from "../../legContract.js";
import {
  buildReverseBurnWithSkim,
  simulateStage2,
  sendStage2ViaPhantom,
  X1_REVERSE_TOKENS,
  toBaseUnits,
  WARP_PROGRAM_ID,
} from "../../../warpBridge.js";
import { PublicKey } from "@solana/web3.js";

export function toPubkey(pk) {
  return pk instanceof PublicKey ? pk : new PublicKey(pk);
}

/**
 * Shape the golden step1 artifact from a buildReverseBurnWithSkim result:
 * seq math, the skim/bridge base amounts, the bridge_out account list (spec
 * order), per-instruction program/data, and the unsigned serialized bytes —
 * the EXACT shape the fixture records (mirror of shapeWarpLockArtifact).
 */
export function shapeReverseBurnArtifact({
  built,
  prep,
  amountHuman, // the burn amount (gross − skim) in human units
  feeAmount = 0, // the 1% skim in human units (token units)
  grossHuman = null, // the user-entered gross (defaults to burn + skim)
  token = "USDC.x",
  blockhash,
  seqSlot = null,
}) {
  const tx = built.transaction;
  if (blockhash) tx.recentBlockhash = blockhash; // pin (belt+braces, like the golden rebuild)
  const bytes = tx.serialize({ requireAllSignatures: false });

  const tok = X1_REVERSE_TOKENS[token] || X1_REVERSE_TOKENS["USDC.x"];
  const decimals = tok.decimals;
  const grossBase = toBaseUnits(
    grossHuman ?? Number(amountHuman) + Number(feeAmount),
    decimals,
  ).toString();
  const skimBase = toBaseUnits(feeAmount, decimals).toString();
  const bridgeBase = toBaseUnits(amountHuman, decimals).toString();

  const burnIx = tx.instructions.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  const accountList = burnIx.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));

  return {
    seq: built.seq.toString(),
    seqSlot,
    token,
    decimals,
    grossBase,
    skimBase,
    bridgeBase,
    grossHuman: Number(grossBase) / 10 ** decimals,
    amountHuman: Number(bridgeBase) / 10 ** decimals,
    skimHuman: Number(skimBase) / 10 ** decimals,
    outgoingMsgPda: built.outgoing_msg.toBase58(),
    feeAtaCreated: prep?.needsCreation === true,
    feeAta: prep?.ata ? prep.ata.toBase58() : null,
    blockhash: tx.recentBlockhash,
    instructionCount: tx.instructions.length,
    instructions: tx.instructions.map((ix) => ({
      programId: ix.programId.toBase58(),
      dataBase64: Buffer.from(ix.data).toString("base64"),
    })),
    accountList,
    serializedBase64: Buffer.from(bytes).toString("base64"),
  };
}

/**
 * Create the X1 reverse burn leg.
 * ctx per phase:
 *   build:    { connection, userPubkey, amountHuman, feeAmount, feeWallet,
 *               token, seq?, blockhash?, seqSlot? }
 *   simulate: { connection } (+ build result)
 *   submit:   { connection, provider } (+ build result)
 */
export function createX1BurnLeg() {
  return createLeg({
    id: "x1-reverse-burn",
    family: "svm",
    chain: "x1",
    description:
      "The X1 reverse burn tx — bundled fee-wallet ATA create (when missing) + 1% skim " +
      "transfer + Warp BridgeOut(seq, burn amount) in ONE transaction (golden step1). " +
      "Token-aware: wSOL.X 9-dec / 25bps fee account; USDC.x 6-dec / flat-$1 fee account.",
    goldenStep: "step1-x1-burn",
    phases: {
      async build(ctx) {
        const userPubkey = toPubkey(ctx.userPubkey);
        const feeWallet = ctx.feeWallet ? toPubkey(ctx.feeWallet) : null;
        const { built, prep } = await buildReverseBurnWithSkim({
          connection: ctx.connection,
          userPubkey,
          amountHuman: ctx.amountHuman, // the burn amount (gross − skim)
          feeAmount: ctx.feeAmount || 0,
          feeWallet,
          token: ctx.token || "USDC.x",
          seq: ctx.seq, // undefined → buildReverseBurn derives from the live slot; tests pin it
        });
        const artifact = shapeReverseBurnArtifact({
          built,
          prep,
          amountHuman: ctx.amountHuman,
          feeAmount: ctx.feeAmount || 0,
          token: ctx.token || "USDC.x",
          blockhash: ctx.blockhash,
          seqSlot: ctx.seqSlot ?? null,
        });
        return { needed: true, built, prep, artifact };
      },

      async simulate(ctx, built) {
        const b = built?.build;
        if (!b?.built) return { ok: false, err: "x1BurnLeg: no built tx" };
        return simulateStage2(ctx.connection, b.built.transaction); // normalized { ok, ... } — fail-closed
      },

      async submit(ctx, built) {
        const b = built?.build;
        if (!b?.built) throw new Error("x1BurnLeg.submit: no built tx");
        if (!ctx.provider) throw new Error("x1BurnLeg.submit: no Solana/X1 signer");
        return sendStage2ViaPhantom(ctx.connection, b.built.transaction, ctx.provider);
      },
    },
    meta: {
      wraps:
        "warpBridge.buildReverseBurnWithSkim (the construction half of runReverse — fee-ATA " +
        "prep + buildReverseBurn + prepended 1% skim) + simulateStage2 + sendStage2ViaPhantom; " +
        "the preflights (assertX1FeePayer + assertX1TokenBalance) run in the stage runner, " +
        "mirroring runReverse's order",
    },
  });
}
