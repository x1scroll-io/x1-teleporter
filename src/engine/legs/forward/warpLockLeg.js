/**
 * warpLockLeg.js — the Warp lock leg of the forward route (Solana → X1):
 * the 1% skim SPL transfer + BridgeOut in ONE transaction, plus the
 * bridge_in_v2 account pre-image the guardians will use to mint on X1.
 * Reproduces golden step2b (step2b-warp-lock.json) + step3
 * (step3-bridge-in-v2.json) and is the engine home of runStage2's Solana
 * half (src/warpBridge.js):
 *
 *   preflight  (stage runner)  — assertSolanaFeePayer (actionable error
 *                                instead of the bare AccountNotFound)
 *   build      — buildStage2: ComputeBudget(60k) + 1% skim transfer (user →
 *                fee wallet) + Warp BridgeOut(seq, bridge gross − skim).
 *                ALSO derives the bridge_in_v2 account list (step3): the
 *                recipient_token_account the guardians mint into is EXACTLY
 *                the ATA the ataCreateLeg created (chain of custody).
 *   simulate   — simulateStage2 (fail-closed: program rejection OR an
 *                unreachable RPC blocks the send)
 *   submit     — sendStage2ViaPhantom: signTransaction + app-side broadcast
 *                through the SAME connection the sim ran against
 *                (deterministic chain), guarded. allowLive gates this in the
 *                stage runner (WARP_LIVE_SEND).
 *
 * REUSE (wrap, don't rewrite): buildStage2 / simulateStage2 /
 * sendStage2ViaPhantom / encodeWarpSeq / deriveOutgoingMsgPda /
 * WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC / WARP_ACCOUNTS all come from
 * src/warpBridge.js, unchanged. deriveBridgeInV2AccountList is the engine's
 * port of the golden step3 rebuild (same PDA derivations, same spec filter,
 * same artifact shape) — the oracle pins it byte-for-byte.
 *
 * ctx: { connection (Solana RPC), userPubkey, feeWalletSvm, amountHuman,
 *        seq, seqSlot?, destToken, blockhash? }
 */
import { createLeg } from "../../legContract.js";
import {
  buildStage2,
  simulateStage2,
  sendStage2ViaPhantom,
  deriveX1UsdcxAta,
  toBaseUnits,
  WARP_PROGRAM_ID,
  WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC,
  X1_USDCX_MINT,
  USDC_MINT,
} from "../../../warpBridge.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export function toPubkey(pk) {
  return pk instanceof PublicKey ? pk : new PublicKey(pk);
}

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN STEP2b — the Warp lock tx artifact (byte-identical to the fixture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape the golden step2b artifact from a buildStage2 result: seq math, the
 * bridge_out account list (spec order), per-instruction program/data, and the
 * unsigned serialized bytes — the EXACT shape the fixture records.
 */
export function shapeWarpLockArtifact({ built, amountHuman, destToken, blockhash, seqSlot }) {
  const tx = built.transaction;
  if (blockhash) tx.recentBlockhash = blockhash; // pin (belt+braces, like the golden rebuild)
  const bytes = tx.serialize({ requireAllSignatures: false });

  const warpIx = tx.instructions.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  const accountList = warpIx.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));

  return {
    seq: built.seq.toString(),
    seqSlot: seqSlot ?? null,
    grossBase: toBaseUnits(amountHuman, 6).toString(),
    skimBase: built.skimBase.toString(),
    bridgeBase: built.bridgeBase.toString(),
    amountHuman,
    outgoingMsgPda: built.outgoing_msg.toBase58(),
    feeAtaCreated: built.feeAtaCreated,
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

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN STEP3 — the bridge_in_v2 account construction (the guardians' mint)
// ─────────────────────────────────────────────────────────────────────────────

/** u64 little-endian bytes (browser-safe; mirrors warpBridge.js). */
export function u64le(value) {
  const b = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

/**
 * Derive the concrete bridge_in_v2 account list for the wrapped USDC.x case
 * (bridge-to-self: recipient == the Solana sender) — the engine port of the
 * golden step3 rebuild (forwardLegBuilders.buildBridgeInV2AccountList).
 *
 * Derivable offline (the app's side of the contract): config, guardian_set,
 * token_registry, incoming_msg, payer, recipient, recipient_token_account (the
 * ATA step2a creates — the v2 IDL has NO associated_token_program, so it must
 * pre-exist), token_mint, mint_authority (wrapped), token_program (Token-2022),
 * system_program. Native-only vault slots are omitted for wrapped tokens.
 * signature_set is guardian-signed (source_timestamp lives in the signed
 * source message) — recorded as its seed template, never guessed.
 *
 * `amountBase` = the bridge gross the bridge_out locked (post-skim).
 */
export function deriveBridgeInV2AccountList({
  solanaAddress,
  seq,
  amountBase,
  sourceTokenMint = USDC_MINT,
  localMint = X1_USDCX_MINT,
  sourceChainId = 0,
  destChainId = 1,
}) {
  const enc = (s) => new TextEncoder().encode(s);
  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, WARP_PROGRAM_ID)[0].toBase58();
  const user = new PublicKey(solanaAddress);
  const localPk = localMint instanceof PublicKey ? localMint : new PublicKey(localMint);

  const derived = {
    config: pda([enc("config")]),
    guardian_set: pda([enc("guardian_set")]),
    token_registry: pda([enc("token_registry"), localPk.toBytes()]),
    incoming_msg: pda([enc("evt_in"), u64le(seq)]),
    payer: user.toBase58(),
    recipient: user.toBase58(),
    recipient_token_account: deriveX1UsdcxAta(user).toBase58(),
    token_mint: localPk.toBase58(),
    mint_authority: pda([enc("mint_authority"), localPk.toBytes()]),
    token_program: TOKEN_2022_PROGRAM_ID.toBase58(),
    system_program: SystemProgram.programId.toBase58(),
  };

  // Spec order, wrapped-token variant: every non-optional slot in spec order,
  // mint_authority included (wrapped), the vault pair omitted (native-only),
  // signature_set guardian-derived (recorded as its seed template).
  const accountList = [];
  for (const row of WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC) {
    if (row.name === "vault" || row.name === "vault_token_account") continue;
    if (row.name === "signature_set") continue;
    accountList.push({
      name: row.name,
      pubkey: derived[row.name],
      isSigner: row.signer,
      isWritable: row.writable,
    });
  }

  const specCanonical = WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC.map((row) => ({
    name: row.name,
    writable: row.writable,
    signer: row.signer,
    ...(row.optional ? { optional: true } : {}),
    ...(row.pdaSeeds ? { pdaSeeds: row.pdaSeeds } : {}),
  }));

  const artifact = {
    chainPair: `source=${sourceChainId} dest=${destChainId}`,
    seq: BigInt(seq).toString(),
    amountBase: BigInt(amountBase).toString(),
    sourceTokenMint: (sourceTokenMint instanceof PublicKey ? sourceTokenMint : new PublicKey(sourceTokenMint)).toBase58(),
    localMint: localPk.toBase58(),
    wrappedVariant: true,
    signatureSetSeedTemplate: [
      "sig_set", "<guardian_set_index>", "<source_seq>", "<sender>",
      "<source_token_mint>", "<local_mint>", "<amount>", "<source_timestamp>",
    ],
    accountCount: accountList.length,
    accountList,
  };

  return { artifact, spec: { rows: specCanonical, rowCount: specCanonical.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LEG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the Warp lock leg.
 * ctx per phase:
 *   build:    { connection, userPubkey, feeWalletSvm, amountHuman, seq,
 *               seqSlot?, destToken?, blockhash? }
 *   simulate: { connection } (+ build result)
 *   submit:   { connection, provider } (+ build result)
 */
export function createWarpLockLeg() {
  return createLeg({
    id: "warp-lock",
    family: "svm",
    chain: "sol",
    description:
      "The Warp lock tx — ComputeBudget + 1% skim transfer + BridgeOut(seq, net) in ONE " +
      "transaction (golden step2b), plus the bridge_in_v2 account pre-image for the " +
      "guardians' mint (golden step3).",
    goldenStep: "step2b-warp-lock + step3-bridge-in-v2",
    phases: {
      async build(ctx) {
        const userPubkey = toPubkey(ctx.userPubkey);
        const feeWalletSvm = toPubkey(ctx.feeWalletSvm);
        const destToken = ctx.destToken || "USDC.x";
        const built = await buildStage2({
          connection: ctx.connection,
          userPubkey,
          feeWalletSvm,
          amountHuman: ctx.amountHuman,
          seq: ctx.seq, // undefined → buildStage2 fetches the live seq (reference behavior); tests pin it
          destToken,
        });
        const artifact = shapeWarpLockArtifact({
          built,
          amountHuman: ctx.amountHuman,
          destToken,
          blockhash: ctx.blockhash,
          seqSlot: ctx.seqSlot ?? null,
        });
        // The bridge_in_v2 pre-image (step3) — chain of custody: the recipient
        // ATA the guardians mint into is the ATA the ataCreateLeg created.
        const bridgeInV2 = deriveBridgeInV2AccountList({
          solanaAddress: userPubkey.toBase58(),
          seq: built.seq,
          amountBase: built.bridgeBase,
        });
        return {
          needed: true,
          built,
          artifact,
          bridgeInV2: bridgeInV2.artifact,
          bridgeInV2Spec: bridgeInV2.spec,
        };
      },

      async simulate(ctx, built) {
        const b = built?.build;
        if (!b?.built) return { ok: false, err: "warpLockLeg: no built tx" };
        return simulateStage2(ctx.connection, b.built.transaction); // normalized { ok, ... } — fail-closed
      },

      async submit(ctx, built) {
        const b = built?.build;
        if (!b?.built) throw new Error("warpLockLeg.submit: no built tx");
        if (!ctx.provider) throw new Error("warpLockLeg.submit: no Solana/X1 signer");
        return sendStage2ViaPhantom(ctx.connection, b.built.transaction, ctx.provider);
      },
    },
    meta: {
      wraps:
        "warpBridge.buildStage2 (lock tx) + simulateStage2 + sendStage2ViaPhantom — runStage2's " +
        "Solana leg, unchanged; step3 derivation ported from the golden rebuild (oracle-pinned)",
    },
  });
}
