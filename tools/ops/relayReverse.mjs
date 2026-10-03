#!/usr/bin/env node
/**
 * relayReverse.mjs — permissionless self-relay for stuck X1 -> Solana transfers.
 *
 * ⚠️ UNVERIFIED recovery tool. Hardcodes 2-of-N signature threshold. Legacy
 * bridge_in acceptance on Solana is untested. Do NOT run without manual
 * review. — step 1.2: removed from the user-facing path; kept only as an
 * ops-side recovery tool.
 *
 * Context: X1 -> Solana runs on Warp V1 (68-byte message, WARP::BRIDGE::V1 domain).
 * Guardians sign it, but the official submitter isn't completing the Solana-side
 * release. Per Warp, the submitter is PERMISSIONLESS — so we finish it ourselves
 * with a legacy `bridge_in` (native USDC release from the vault to the recipient).
 *
 * This is the same guarded discipline as everything else: it VERIFIES the guardian
 * message reconstruction offline, then SIMULATES on Solana, and only sends with an
 * explicit --send + --keypair. A stuck transfer's funds are safe until released;
 * a bad build reverts atomically and moves nothing.
 *
 * Usage:
 *   node tools/ops/relayReverse.mjs <attestations.json>                 # verify + build + (sim if SOLANA_RPC set)
 *   SOLANA_RPC=<url> node tools/ops/relayReverse.mjs <attestations.json>            # + simulate each
 *   SOLANA_RPC=<url> node tools/ops/relayReverse.mjs <attestations.json> --keypair ~/id.json --send   # LIVE release
 *
 * The recipient is fixed by the guardian message (bridge-to-self); --keypair is only
 * the fee payer and does NOT need to be the recipient.
 */
import { readFileSync } from "node:fs";
import {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction,
  Ed25519Program, SystemProgram, ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { createHash } from "node:crypto";

const PROGRAM = new PublicKey("6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const V1_DOMAIN = Buffer.from("WARP::BRIDGE::V1");
// legacy bridge_in discriminator (first Warp integration spec)
const BRIDGE_IN_DISC = Buffer.from([0x91, 0x89, 0x1e, 0x3a, 0xb4, 0xf9, 0x69, 0xb5]);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64le = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };

const config = pda([enc("config")]);
const tokenRegistry = pda([enc("token_registry"), USDC.toBytes()]);
const vault = pda([enc("vault"), USDC.toBytes()]);
const vaultAta = getAssociatedTokenAddressSync(USDC, vault, true, TOKEN_PROGRAM_ID);

// Rebuild the exact 68-byte V1 message and confirm it hashes to what guardians
// signed. If this fails we refuse to touch the transfer.
function verifyMessage(t) {
  const sender = Buffer.from(t.sender, "base64");                 // 32 bytes
  const token = Buffer.alloc(12); Buffer.from(t.token || "USDC").copy(token);
  const msg = Buffer.concat([u64le(t.seq), sender, token, u64le(t.amount), i64le(t.timestamp)]);
  const hash = createHash("sha256").update(V1_DOMAIN).update(msg).digest("hex");
  return { ok: hash === t.messageHash, hash, sender };
}

function buildRelayTx(t, payer) {
  const { ok, hash, sender } = verifyMessage(t);
  if (!ok) throw new Error(`message hash mismatch for ${t.txSig?.slice(0, 8)} (got ${hash}, want ${t.messageHash})`);

  const recipient = new PublicKey(sender);                        // bridge-to-self
  const recipientAta = getAssociatedTokenAddressSync(USDC, recipient, true, TOKEN_PROGRAM_ID);
  const evtIn = pda([enc("evt_in"), u64le(t.seq)]);
  const msgHash = Buffer.from(t.messageHash, "hex");

  // Pick threshold-many DISTINCT authorized guardians that agree on the hash.
  const need = Number(t.signaturesRequired ?? 2);
  const seen = new Set();
  const chosen = (t.signatures || [])
    .filter((s) => s.messageHash === t.messageHash)
    .filter((s) => (seen.has(s.guardianPubkey) ? false : (seen.add(s.guardianPubkey), true)))
    .slice(0, Math.max(need, 2));
  if (chosen.length < need) throw new Error(`only ${chosen.length}/${need} distinct guardian sigs for ${t.txSig?.slice(0, 8)}`);

  // One Ed25519 verify ix per guardian sig — message is the 32-byte hash.
  const edIxs = chosen.map((s) => Ed25519Program.createInstructionWithPublicKey({
    publicKey: bs58.decode(s.guardianPubkey),
    message: msgHash,
    signature: bs58.decode(s.signature),
  }));

  // legacy bridge_in, NATIVE RELEASE variant:
  //   account 7 (mint authority) = program-id placeholder
  //   accounts 8/9 = vault PDA + vault token account (funds released from here)
  const data = Buffer.concat([BRIDGE_IN_DISC, u64le(t.seq), sender, u64le(t.amount), i64le(t.timestamp)]);
  const keys = [
    { pubkey: config,                     isSigner: false, isWritable: true  }, // 0
    { pubkey: tokenRegistry,              isSigner: false, isWritable: true  }, // 1
    { pubkey: evtIn,                      isSigner: false, isWritable: true  }, // 2 incoming_msg
    { pubkey: payer,                      isSigner: true,  isWritable: true  }, // 3 payer/signer
    { pubkey: recipient,                  isSigner: false, isWritable: true  }, // 4
    { pubkey: recipientAta,               isSigner: false, isWritable: true  }, // 5
    { pubkey: USDC,                       isSigner: false, isWritable: true  }, // 6 token_mint
    { pubkey: PROGRAM,                    isSigner: false, isWritable: false }, // 7 mint_authority placeholder
    { pubkey: vault,                      isSigner: false, isWritable: false }, // 8 vault PDA
    { pubkey: vaultAta,                   isSigner: false, isWritable: true  }, // 9 vault token account
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, // 10
    { pubkey: TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false }, // 11
    { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false }, // 12
  ];
  const bridgeIn = new TransactionInstruction({ programId: PROGRAM, keys, data });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }));
  edIxs.forEach((ix) => tx.add(ix));   // Ed25519 verifies MUST precede bridge_in
  tx.add(bridgeIn);
  return { tx, recipient, recipientAta, evtIn, guardians: chosen.map((c) => c.guardianPubkey) };
}

// ---- main ----
const [, , jsonPath, ...rest] = process.argv;
if (!jsonPath) { console.error("usage: node tools/ops/relayReverse.mjs <attestations.json> [--keypair path --send]"); process.exit(2); }
const doSend = rest.includes("--send");
const kpIdx = rest.indexOf("--keypair");
const rpc = process.env.SOLANA_RPC;
const transfers = JSON.parse(readFileSync(jsonPath, "utf8"));

let payer = null;
if (kpIdx >= 0) {
  const secret = JSON.parse(readFileSync(rest[kpIdx + 1], "utf8"));
  payer = Keypair.fromSecretKey(Uint8Array.from(secret));
} else {
  payer = Keypair.generate(); // sim-only placeholder (sigVerify:false)
}
const conn = rpc ? new Connection(rpc, "confirmed") : null;

console.log(`\nWarp V1 reverse relay — ${transfers.length} transfer(s). payer: ${payer.publicKey.toBase58()}${doSend ? "  [LIVE]" : "  [dry-run]"}\n`);
console.log(`static: config ${config.toBase58().slice(0,6)}… registry ${tokenRegistry.toBase58().slice(0,6)}… vault ${vault.toBase58().slice(0,6)}… vaultAta ${vaultAta.toBase58().slice(0,6)}…\n`);

for (const t of transfers) {
  const tag = `${t.txSig?.slice(0, 8)}  ${(t.amount/1e6).toFixed(2)} USDC`;
  try {
    const { tx, recipient, guardians } = buildRelayTx(t, payer.publicKey);
    console.log(`• ${tag}  hash ✓  -> release to ${recipient.toBase58().slice(0,6)}…  guardians ${guardians.length}`);
    if (!conn) { console.log("    (set SOLANA_RPC to simulate)\n"); continue; }

    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      console.log(`    SIM FAILED: ${JSON.stringify(sim.value.err)}`);
      (sim.value.logs || []).forEach((l) => console.log("      " + l));
      console.log("");
      continue;
    }
    console.log(`    SIM OK — release would succeed (${sim.value.unitsConsumed} CU)`);

    if (doSend && kpIdx >= 0) {
      tx.sign(payer);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`    RELEASED ✓ dest tx: ${sig}`);
    } else if (doSend) {
      console.log("    --send given but no --keypair; skipping live send");
    }
    console.log("");
  } catch (e) {
    console.log(`• ${tag}  SKIP: ${e.message}\n`);
  }
}
console.log("Done. If a sim reverts with a 'disabled'/'paused' style error, legacy bridge_in is off for this");
console.log("direction on the Solana side — that's a guardian/bridge-side (V2 cutover) item, not fixable here.\n");
