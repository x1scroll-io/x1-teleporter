/**
 * solanaSignable.js — the SIGNED-IN-YOUR-WALLET execute surface for the
 * Solana dexDirect legs (Raydium CPMM/CLMM + Orca Whirlpool).
 *
 * 🔴 FUNDS RULE — nothing in this module broadcasts. It PRODUCES the
 * correctly-encoded transactions for Mr. Esters' wallet (Backpack) to
 * sign, built with the OFFICIAL SDKs (solanaSdk.js — byte-pinned to the
 * frozen dex-direct layouts by fail-closed drift canaries):
 *
 *   setupTx — the ATA-create transaction when the user's token accounts
 *     do not exist on-chain yet (createAssociatedTokenAccount for every
 *     missing ATA of the pair — checked READ-ONLY via getAccountInfo; the
 *     swap needs the input ATA to debit from and the output ATA to credit
 *     to). One setup tx carries all missing creates.
 *   swapTx  — the FULL swap transaction: compute-budget instructions
 *     (setComputeUnitLimit + optional setComputeUnitPrice priority fee —
 *     the SDK makeTxVersion pattern) + the official-SDK swap instruction,
 *     serialized with a fresh blockhash + fee payer for Backpack.
 *
 * The only on-chain reads are read-only getAccountInfo (ATA existence) +
 * getLatestBlockhash. There is no signAndSendTransaction, no
 * sendRawTransaction and no submit anywhere in this module or the legs.
 * The anchor harness (src/lib/dexAnchor/dexAnchorRunner.js) hands the
 * returned txs to the Wallet-Standard adapter; Mr. Esters approves in
 * Backpack; BACKPACK's own connection broadcasts.
 *
 * The `read` handle (injected — the legs never construct RPC connections):
 *   { getAccountInfo(pubkey) → Promise<{data?: Uint8Array}|null>,
 *     getLatestBlockhash() → Promise<{blockhash: string}> }
 */
import { PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import {
  makeRaydiumCpmmSwapIx,
  makeRaydiumClmmSwapIx,
  makeOrcaSwapV2Ix,
  snapshotQuoteDirectionCpmm,
  snapshotQuoteDirectionClmm,
} from "./solanaSdk.js";
import { SPL_TOKEN_PROGRAM_ID } from "./orcaSwapLeg.js";

/** Default compute-unit limit for a dex-direct swap tx (Raydium/Orca
 *  swaps run well inside this; the anchor can override per leg). */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

function toPubkey(pk) {
  return pk instanceof PublicKey ? pk : new PublicKey(pk);
}

/**
 * Read-only ATA existence check (getAccountInfo through the injected read
 * handle). Fail-closed: an unreadable RPC throws — the anchor never
 * assumes an ATA exists.
 * @returns {Promise<{exists: boolean, ataAddress: string}>}
 */
export async function checkAtaExists({ read, ataAddress }) {
  if (!read || typeof read.getAccountInfo !== "function") {
    throw new Error("checkAtaExists: no read handle (getAccountInfo) — inject the anchor's read connection");
  }
  let acct = null;
  try {
    acct = await read.getAccountInfo(toPubkey(ataAddress));
  } catch (e) {
    throw new Error(`checkAtaExists: the ATA read failed (${e?.message || e}) — the anchor never assumes an ATA exists; retry when the RPC is reachable`);
  }
  return { exists: Boolean(acct), ataAddress };
}

/**
 * Build the ATA-CREATE setup transaction (one tx, every missing ATA of the
 * pair — official @solana/spl-token createAssociatedTokenAccount). The
 * anchor signs this FIRST when the swap's ATAs do not exist yet.
 *
 * @returns {{transaction: Transaction, serializedBase64: string,
 *            creates: string[], blockhash, feePayer}}
 */
export function buildAtaSetupTx({ mints, owner, tokenPrograms, blockhash, feePayer }) {
  const ownerPk = toPubkey(owner);
  const payer = toPubkey(feePayer ?? owner);
  const creates = [];
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  mints.forEach((mint, i) => {
    const program = toPubkey(tokenPrograms[i] ?? SPL_TOKEN_PROGRAM_ID);
    const ata = getAssociatedTokenAddressSync(toPubkey(mint), ownerPk, true, program);
    creates.push(ata.toBase58());
    tx.add(
      createAssociatedTokenAccountInstruction(
        payer,
        ata,
        ownerPk,
        toPubkey(mint),
        program,
      ),
    );
  });
  return {
    transaction: tx,
    serializedBase64: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64"),
    creates,
    blockhash,
    feePayer: payer.toBase58(),
    instructionCount: tx.instructions.length,
  };
}

/**
 * Assemble the FULL signable swap transaction: compute-budget instructions
 * (setComputeUnitLimit always; setComputeUnitPrice only when a priority
 * fee is set) + the swap instruction, serialized with a fresh blockhash.
 * @returns {{transaction: Transaction, serializedBase64: string,
 *            blockhash, feePayer, instructionCount, computeUnitLimit,
 *            computeUnitPriceMicroLamports}}
 */
export function buildSignableSolanaTx({ instructions, blockhash, feePayer, computeUnitLimit = DEFAULT_COMPUTE_UNIT_LIMIT, computeUnitPriceMicroLamports = 0 }) {
  if (!blockhash) throw new Error("buildSignableSolanaTx: a recent blockhash is required (the anchor fetches a fresh one)");
  const payer = toPubkey(feePayer);
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  if (computeUnitLimit > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  }
  if (computeUnitPriceMicroLamports > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicroLamports }));
  }
  for (const ix of instructions) tx.add(ix);
  return {
    transaction: tx,
    serializedBase64: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64"),
    blockhash,
    feePayer: payer.toBase58(),
    instructionCount: tx.instructions.length,
    computeUnitLimit,
    computeUnitPriceMicroLamports,
  };
}

/**
 * The Raydium per-leg execute PLAN (task-shaped): check the user's ATAs
 * (read-only) and return exactly which txs Mr. Esters signs first — the
 * ATA setup tx (when the pair's accounts are missing) then the swap tx
 * (official-SDK instruction + compute budget). NO send of any kind.
 *
 * @param {object} args { dex: "cpmm"|"clmm", artifact (the leg build —
 *   quote-pinned), snapshot, userPubkey, read, blockhash?, feePayer?,
 *   computeUnitLimit?, computeUnitPriceMicroLamports? }
 * @returns {Promise<{dex: "raydium", kind, needsSetup, setupTx?: object,
 *            swapTx: object, boundary: string}>}
 */
export async function planRaydiumExecute({ dex, artifact, snapshot, userPubkey, read, blockhash = null, feePayer = null, computeUnitLimit = DEFAULT_COMPUTE_UNIT_LIMIT, computeUnitPriceMicroLamports = 0 }) {
  if (!artifact || !snapshot) throw new Error("planRaydiumExecute: artifact + snapshot are required");
  if (!userPubkey) throw new Error("planRaydiumExecute: userPubkey is required");
  const inputMint = artifact.inputMint;
  const amountInRaw = String(artifact.quote.amountInRaw ?? artifact.amountInRaw);
  const amountOutMinRaw = String(artifact.quote.amountOutMinRaw);
  const payer = feePayer ?? userPubkey;
  const bh = blockhash ?? (await read.getLatestBlockhash()).blockhash;

  const { ix } = dex === "cpmm"
    ? await makeRaydiumCpmmSwapIx({ snapshot, userPubkey, inputMint, amountInRaw, amountOutMinRaw })
    : await makeRaydiumClmmSwapIx({ snapshot, userPubkey, inputMint, amountInRaw, amountOutMinRaw });

  // the pair's ATAs (input side first) — direction from the snapshot
  const dir = dex === "cpmm"
    ? snapshotQuoteDirectionCpmm(snapshot, String(inputMint))
    : snapshotQuoteDirectionClmm(snapshot, String(inputMint));
  const inputProgram = dex === "cpmm"
    ? (dir.inputIsA ? snapshot.pool.mintProgramA : snapshot.pool.mintProgramB)
    : dir.inputProgram;
  const outputProgram = dex === "cpmm"
    ? (dir.inputIsA ? snapshot.pool.mintProgramB : snapshot.pool.mintProgramA)
    : dir.outputProgram;
  const ataIn = getAssociatedTokenAddressSync(toPubkey(dir.inputMint), toPubkey(userPubkey), true, toPubkey(inputProgram)).toBase58();
  const ataOut = getAssociatedTokenAddressSync(toPubkey(dir.outputMint), toPubkey(userPubkey), true, toPubkey(outputProgram)).toBase58();
  const [inCheck, outCheck] = await Promise.all([
    checkAtaExists({ read, ataAddress: ataIn }),
    checkAtaExists({ read, ataAddress: ataOut }),
  ]);
  const needsSetup = !inCheck.exists || !outCheck.exists;

  const plan = {
    dex: "raydium",
    kind: dex,
    pool: artifact.pool,
    userPubkey: String(userPubkey),
    inputMint: String(dir.inputMint),
    outputMint: String(dir.outputMint),
    atas: { input: ataIn, output: ataOut, inputExists: inCheck.exists, outputExists: outCheck.exists },
    needsSetup,
    boundary:
      "sign-in-wallet: Backpack approves each tx (ATA setup first when needed, then the swap). " +
      "The agent never broadcasts — sign in your wallet; the wallet's own connection sends " +
      "on Mr. Esters' confirm.",
  };
  if (needsSetup) {
    const missingMints = [];
    const missingPrograms = [];
    if (!inCheck.exists) { missingMints.push(dir.inputMint); missingPrograms.push(inputProgram); }
    if (!outCheck.exists) { missingMints.push(dir.outputMint); missingPrograms.push(outputProgram); }
    plan.setupTx = buildAtaSetupTx({ mints: missingMints, owner: userPubkey, tokenPrograms: missingPrograms, blockhash: bh, feePayer: payer });
  }
  plan.swapTx = buildSignableSolanaTx({
    instructions: [ix],
    blockhash: bh,
    feePayer: payer,
    computeUnitLimit,
    computeUnitPriceMicroLamports,
  });
  return plan;
}

/**
 * The Orca per-leg execute PLAN (task-shaped): the same ATA-check → setup
 * → swap shape as planRaydiumExecute, with the official whirlpools-sdk
 * swap_v2 instruction.
 */
export async function planOrcaExecute({ artifact, snapshot, userPubkey, read, blockhash = null, feePayer = null, computeUnitLimit = DEFAULT_COMPUTE_UNIT_LIMIT, computeUnitPriceMicroLamports = 0 }) {
  if (!artifact || !snapshot?.whirlpool) throw new Error("planOrcaExecute: artifact + snapshot.whirlpool are required");
  if (!userPubkey) throw new Error("planOrcaExecute: userPubkey is required");
  const wp = snapshot.whirlpool;
  const inputMint = String(artifact.inputMint);
  const amountInRaw = String(artifact.quote.amountInRaw);
  const amountOutMinRaw = String(artifact.quote.amountOutMinRaw);
  const payer = feePayer ?? userPubkey;
  const bh = blockhash ?? (await read.getLatestBlockhash()).blockhash;

  const { ix } = await makeOrcaSwapV2Ix({
    snapshot,
    userPubkey,
    inputMint,
    amountInRaw,
    amountOutMinRaw,
    readHandle: read,
  });

  const tokenProgramA = snapshot.tokenProgramA || SPL_TOKEN_PROGRAM_ID;
  const tokenProgramB = snapshot.tokenProgramB || SPL_TOKEN_PROGRAM_ID;
  const aToB = inputMint === wp.mintA;
  const ataIn = getAssociatedTokenAddressSync(toPubkey(aToB ? wp.mintA : wp.mintB), toPubkey(userPubkey), true, toPubkey(aToB ? tokenProgramA : tokenProgramB)).toBase58();
  const ataOut = getAssociatedTokenAddressSync(toPubkey(aToB ? wp.mintB : wp.mintA), toPubkey(userPubkey), true, toPubkey(aToB ? tokenProgramB : tokenProgramA)).toBase58();
  const [inCheck, outCheck] = await Promise.all([
    checkAtaExists({ read, ataAddress: ataIn }),
    checkAtaExists({ read, ataAddress: ataOut }),
  ]);
  const needsSetup = !inCheck.exists || !outCheck.exists;

  const plan = {
    dex: "orca",
    pool: artifact.pool,
    userPubkey: String(userPubkey),
    inputMint: aToB ? wp.mintA : wp.mintB,
    outputMint: aToB ? wp.mintB : wp.mintA,
    atas: { input: ataIn, output: ataOut, inputExists: inCheck.exists, outputExists: outCheck.exists },
    needsSetup,
    boundary:
      "sign-in-wallet: Backpack approves each tx (ATA setup first when needed, then the swap). " +
      "The agent never broadcasts — sign in your wallet; the wallet's own connection sends " +
      "on Mr. Esters' confirm.",
  };
  if (needsSetup) {
    const missingMints = [];
    const missingPrograms = [];
    if (!inCheck.exists) { missingMints.push(aToB ? wp.mintA : wp.mintB); missingPrograms.push(aToB ? tokenProgramA : tokenProgramB); }
    if (!outCheck.exists) { missingMints.push(aToB ? wp.mintB : wp.mintA); missingPrograms.push(aToB ? tokenProgramB : tokenProgramA); }
    plan.setupTx = buildAtaSetupTx({ mints: missingMints, owner: userPubkey, tokenPrograms: missingPrograms, blockhash: bh, feePayer: payer });
  }
  plan.swapTx = buildSignableSolanaTx({
    instructions: [ix],
    blockhash: bh,
    feePayer: payer,
    computeUnitLimit,
    computeUnitPriceMicroLamports,
  });
  return plan;
}
