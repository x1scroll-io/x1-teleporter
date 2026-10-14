/**
 * src/teleporter/lib/sdk/sdkCctpSolana.js — Circle CCTP V2 on SOLANA (pure builders).
 *
 * The wallet's EVM CCTP leg lives in sdkCctp.js (EVM calldata). This module adds
 * the two Solana-side operations needed for native-USDC burn-and-mint between
 * Solana and the EVM chains:
 *
 *   1. Solana → EVM  : TokenMessengerMinterV2 `deposit_for_burn`
 *   2. EVM → Solana  : MessageTransmitterV2 `receive_message`
 *
 * Everything here is PURE and signer-free — it returns Anchor instruction
 * { programId, keys[], data } so the wallet's own ed25519 signer (see
 * src/cctpSwap.ts) can compile + sign + broadcast. That keeps the byte layout
 * unit-testable against Circle's published IDL without any network.
 *
 * ── SOURCE OF TRUTH (fetched 2026-09-18; never guessed) ─────────────────────
 *   • Docs : https://developers.circle.com/cctp/references/solana-programs
 *   • IDLs : github.com/circlefin/solana-cctp-contracts, examples/target/idl/
 *              token_messenger_minter_v2.json + message_transmitter_v2.json
 *   • Source (account order / PDA seeds):
 *              .../token_messenger_v2/instructions/deposit_for_burn.rs
 *              .../token_messenger_v2/instructions/handle_receive_finalized_message.rs
 *              .../message-transmitter-v2/src/instructions/receive_message.rs
 *
 * Instruction discriminators are the first 8 bytes of sha256("global:<name>").
 * The test suite (test/sdkCctpSolana.test.mjs) pins every discriminator, the
 * exact account ORDER, the data encoding, and every PDA against @solana/web3.js
 * — so a drift from the IDL fails loudly.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";

// ─────────────────────────────────────────────────────────────── constants

/** Solana CCTP V2 program ids — identical on mainnet + devnet (Circle docs). */
export const SOLANA_CCTP = Object.freeze({
  tokenMessengerMinterProgram: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  messageTransmitterProgram: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
});

/** Native USDC (SPL) mint on Solana — 6 decimals. */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Solana core program ids used by CCTP. */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** Anchor instruction discriminators (sha256("global:<name>")[:8]) — pinned by tests. */
export const DEPOSIT_FOR_BURN_DISCRIMINATOR = Object.freeze([215, 60, 61, 46, 114, 55, 128, 176]);
export const RECEIVE_MESSAGE_DISCRIMINATOR = Object.freeze([38, 144, 127, 225, 31, 225, 238, 25]);
export const HANDLE_RECEIVE_FINALIZED_DISCRIMINATOR = Object.freeze([186, 252, 239, 70, 86, 180, 110, 95]);
export const HANDLE_RECEIVE_UNFINALIZED_DISCRIMINATOR = Object.freeze([200, 169, 175, 20, 200, 58, 182, 61]);

/** CCTP message (receipt) body offsets — see message.rs. */
export const MESSAGE_NONCE_INDEX = 12;
export const MESSAGE_SENDER_INDEX = 44;
export const MESSAGE_MESSAGE_BODY_INDEX = 148;
/** BurnMessage body offsets (relative to the message body) — see burn_message.rs. */
export const BURN_TOKEN_BODY_INDEX = 4;

/** Anchor PDA marker appended after the program id (Solana convention). */
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

// ─────────────────────────────────────────────────────────────── primitives

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

export function base58Decode(str) {
  let n = 0n;
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error("sdkCctpSolana: invalid base58"); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of str) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

function concatBytes(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** Coerce a 32-byte Uint8Array / base58 string / number[] / {toBytes()} into 32 raw bytes. */
export function toPubkeyBytes(v) {
  if (typeof v === "string") return base58Decode(v);
  let b;
  if (v && typeof v.toBytes === "function") b = Uint8Array.from(v.toBytes());
  else b = v instanceof Uint8Array ? v : Uint8Array.from(v);
  if (b.length !== 32) throw new Error(`sdkCctpSolana: pubkey must be 32 bytes (got ${b.length})`);
  return b;
}

const utf8 = (s) => new TextEncoder().encode(s);
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n) >>> 0, true); return b; };
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };

/** ed25519 on-curve test (off-curve is required for a PDA). */
function isOnCurve(bytes) { try { ed25519.ExtendedPoint.fromHex(bytes); return true; } catch { return false; } }

/** Solana createProgramAddress: sha256(seeds || programId || "ProgramDerivedAddress"). */
export function createProgramAddress(seeds, programId) {
  const pid = toPubkeyBytes(programId);
  for (const s of seeds) if (s.length > 32) throw new TypeError("sdkCctpSolana: Max seed length exceeded");
  const hash = sha256(concatBytes(...seeds, pid, PDA_MARKER));
  if (isOnCurve(hash)) throw new Error("sdkCctpSolana: Invalid seeds, address must fall off the curve");
  return hash;
}

/** Solana findProgramAddress — first nonce in [255..1] whose hash is off-curve. */
export function findProgramAddress(seeds, programId) {
  const pid = toPubkeyBytes(programId);
  for (let nonce = 255; nonce !== 0; nonce--) {
    try {
      return { address: createProgramAddress([...seeds, Uint8Array.of(nonce)], pid), bump: nonce };
    } catch (e) {
      if (e instanceof TypeError) throw e;
      continue;
    }
  }
  throw new Error("sdkCctpSolana: Unable to find a viable program address nonce");
}

/** Associated Token Account address (owner, TokenProgram, mint) under the ATA program. */
export function getAssociatedTokenAddressSync(mint, owner, tokenProgramId = SPL_TOKEN_PROGRAM_ID) {
  return findProgramAddress(
    [toPubkeyBytes(owner), toPubkeyBytes(tokenProgramId), toPubkeyBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).address;
}

// ─────────────────────────────────────────────────────────── instruction data

/**
 * Borsh-encode `DepositForBurnParams` (repr(C) field order — never reorder):
 *   amount:u64 · destination_domain:u32 · mint_recipient:[u8;32] ·
 *   destination_caller:[u8;32] · max_fee:u64 · min_finality_threshold:u32
 * prefixed by the 8-byte instruction discriminator → 96 bytes total.
 */
export function encodeDepositForBurnData({
  amount, destinationDomain, mintRecipient, destinationCaller, maxFee = 0, minFinalityThreshold = 2000,
}) {
  const recipient = toPubkeyBytes(mintRecipient);
  const caller = destinationCaller === undefined || destinationCaller === null
    ? new Uint8Array(32) : toPubkeyBytes(destinationCaller);
  return concatBytes(
    Uint8Array.from(DEPOSIT_FOR_BURN_DISCRIMINATOR),
    u64le(amount),
    u32le(destinationDomain),
    recipient,
    caller,
    u64le(maxFee),
    u32le(minFinalityThreshold),
  );
}

/**
 * Borsh-encode `ReceiveMessageParams`:
 *   message:Vec<u8> · attestation:Vec<u8>
 * prefixed by the 8-byte instruction discriminator. Each Vec is u32-LE length + bytes.
 */
export function encodeReceiveMessageData({ message, attestation }) {
  const msg = Uint8Array.from(message);
  const att = Uint8Array.from(attestation);
  return concatBytes(
    Uint8Array.from(RECEIVE_MESSAGE_DISCRIMINATOR),
    u32le(msg.length), msg,
    u32le(att.length), att,
  );
}

// ─────────────────────────────────────────────────────────── account builders

const meta = (pubkey, isSigner, isWritable) => ({ pubkey: toPubkeyBytes(pubkey), isSigner, isWritable });

/**
 * Build the TokenMessengerMinterV2 `deposit_for_burn` instruction (Solana → EVM).
 *
 * Account ORDER is exactly the on-chain IDL (deposit_for_burn, 18 accounts):
 *   0 owner                      (signer)
 *   1 event_rent_payer           (signer, writable)   [defaults to owner]
 *   2 sender_authority_pda       PDA ["sender_authority"]
 *   3 burn_token_account         (writable)           [defaults to ATA(mint, owner)]
 *   4 denylist_account           PDA ["denylist_account", owner]
 *   5 message_transmitter        (writable) PDA MT ["message_transmitter"]
 *   6 token_messenger            PDA TMM ["token_messenger"]
 *   7 remote_token_messenger     PDA TMM ["remote_token_messenger", destDomain]
 *   8 token_minter               PDA TMM ["token_minter"]
 *   9 local_token                (writable) PDA TMM ["local_token", mint]
 *  10 burn_token_mint            (writable)
 *  11 message_sent_event_data    (signer, writable)   [fresh keypair — caller supplies]
 *  12 message_transmitter_program  = MT program
 *  13 token_messenger_minter_program = TMM program
 *  14 token_program                = SPL Token
 *  15 system_program
 *  16 event_authority              PDA TMM ["__event_authority"]
 *  17 program                      = TMM program
 *
 * @returns {{programId: Uint8Array, keys: Array<{pubkey:Uint8Array,isSigner:boolean,isWritable:boolean}>, data: Uint8Array}}
 */
export function buildSolanaDepositForBurn({
  owner,
  amount,
  destinationDomain,
  mintRecipient,
  destinationCaller,
  burnTokenMint = SOLANA_USDC_MINT,
  burnTokenAccount,
  messageSentEventData,
  eventRentPayer,
  maxFee = 0,
  minFinalityThreshold = 2000,
  programs = SOLANA_CCTP,
}) {
  const ownerKey = toPubkeyBytes(owner);
  if (!messageSentEventData) throw new Error("buildSolanaDepositForBurn: messageSentEventData (a fresh signer keypair) is required");
  const mint = toPubkeyBytes(burnTokenMint);
  const TMM = toPubkeyBytes(programs.tokenMessengerMinterProgram);
  const MT = toPubkeyBytes(programs.messageTransmitterProgram);
  const tokenProgram = toPubkeyBytes(SPL_TOKEN_PROGRAM_ID);
  const systemProgram = toPubkeyBytes(SYSTEM_PROGRAM_ID);

  const senderAuthority = findProgramAddress([utf8("sender_authority")], TMM).address;
  const denylist = findProgramAddress([utf8("denylist_account"), ownerKey], TMM).address;
  const messageTransmitter = findProgramAddress([utf8("message_transmitter")], MT).address;
  const tokenMessenger = findProgramAddress([utf8("token_messenger")], TMM).address;
  const remoteTokenMessenger = findProgramAddress(
    [utf8("remote_token_messenger"), utf8(String(destinationDomain))], TMM).address;
  const tokenMinter = findProgramAddress([utf8("token_minter")], TMM).address;
  const localToken = findProgramAddress([utf8("local_token"), mint], TMM).address;
  const eventAuthority = findProgramAddress([utf8("__event_authority")], TMM).address;
  const burnAccount = burnTokenAccount ? toPubkeyBytes(burnTokenAccount) : getAssociatedTokenAddressSync(mint, ownerKey);
  const rentPayer = eventRentPayer ? toPubkeyBytes(eventRentPayer) : ownerKey;

  const data = encodeDepositForBurnData({
    amount, destinationDomain, mintRecipient, destinationCaller, maxFee, minFinalityThreshold,
  });

  const keys = [
    meta(ownerKey, true, false),
    meta(rentPayer, true, true),
    meta(senderAuthority, false, false),
    meta(burnAccount, false, true),
    meta(denylist, false, false),
    meta(messageTransmitter, false, true),
    meta(tokenMessenger, false, false),
    meta(remoteTokenMessenger, false, false),
    meta(tokenMinter, false, false),
    meta(localToken, false, true),
    meta(mint, false, true),
    meta(messageSentEventData, true, true),
    meta(MT, false, false),
    meta(TMM, false, false),
    meta(tokenProgram, false, false),
    meta(systemProgram, false, false),
    meta(eventAuthority, false, false),
    meta(TMM, false, false),
  ];
  return { programId: TMM, keys, data };
}

/**
 * Build the 11 `remainingAccounts` that MessageTransmitterV2.receive_message
 * forwards (via CPI) to TokenMessengerMinterV2.handle_receive_{finalized,
 * unfinalized}_message. Order per the handler's account struct
 * (authority_pda is prepended by receive_message itself, so it is NOT here):
 *   token_messenger · remote_token_messenger[sourceDomain] · token_minter ·
 *   local_token · token_pair[sourceDomain, sourceToken] ·
 *   fee_recipient_token_account · recipient_token_account ·
 *   custody_token_account · SPL token program ·
 *   token_program_event_authority · TMM program.
 *
 * `recipientTokenAccount` MUST equal the mintRecipient the source burn named
 * (the handler asserts this) — for our wallet that is ATA(localMint, owner).
 */
export function buildHandleReceiveRemainingAccounts({
  sourceDomain,
  localMint = SOLANA_USDC_MINT,
  sourceToken,               // 32-byte remote burn token (from the message body)
  feeRecipient,              // TokenMessenger.fee_recipient (read from on-chain state)
  recipientTokenAccount,
  programs = SOLANA_CCTP,
}) {
  const TMM = toPubkeyBytes(programs.tokenMessengerMinterProgram);
  const mint = toPubkeyBytes(localMint);
  const tokenProgram = toPubkeyBytes(SPL_TOKEN_PROGRAM_ID);
  const domain = utf8(String(sourceDomain));

  const tokenMessenger = findProgramAddress([utf8("token_messenger")], TMM).address;
  const remoteTokenMessenger = findProgramAddress([utf8("remote_token_messenger"), domain], TMM).address;
  const tokenMinter = findProgramAddress([utf8("token_minter")], TMM).address;
  const localToken = findProgramAddress([utf8("local_token"), mint], TMM).address;
  const tokenPair = findProgramAddress([utf8("token_pair"), domain, toPubkeyBytes(sourceToken)], TMM).address;
  const feeRecipientAta = getAssociatedTokenAddressSync(mint, feeRecipient);
  const custody = findProgramAddress([utf8("custody"), mint], TMM).address;
  const tokenProgramEventAuthority = findProgramAddress([utf8("__event_authority")], TMM).address;

  return [
    meta(tokenMessenger, false, false),
    meta(remoteTokenMessenger, false, false),
    meta(tokenMinter, false, false),
    meta(localToken, false, true),
    meta(tokenPair, false, false),
    meta(feeRecipientAta, false, true),
    meta(recipientTokenAccount, false, true),
    meta(custody, false, true),
    meta(tokenProgram, false, false),
    meta(tokenProgramEventAuthority, false, false),
    meta(TMM, false, false),
  ];
}

/**
 * Build the MessageTransmitterV2 `receive_message` instruction (EVM → Solana).
 *
 * Account ORDER per the IDL (receive_message, 9 base accounts):
 *   0 payer                 (signer, writable)
 *   1 caller                (signer)                [defaults to payer]
 *   2 authority_pda         PDA MT ["message_transmitter_authority", receiver]
 *   3 message_transmitter   PDA MT ["message_transmitter"]
 *   4 used_nonce            (writable) PDA MT ["used_nonce", message[12..44]]
 *   5 receiver              TMM program (executable)
 *   6 system_program
 *   7 event_authority       PDA MT ["__event_authority"]
 *   8 program               = MT program
 * then any `remainingAccounts` (the 11 above for a burn message).
 *
 * @param {object} p
 * @param {Uint8Array|string} p.message       the CCTP message bytes (from Iris)
 * @param {Uint8Array|string} p.attestation   the signed attestation bytes
 * @param {Array<{pubkey,isSigner?,isWritable?}>} [p.remainingAccounts]
 */
export function buildSolanaReceiveMessage({
  payer,
  caller,
  message,
  attestation,
  remainingAccounts = [],
  receiverProgram = SOLANA_CCTP.tokenMessengerMinterProgram,
  programs = SOLANA_CCTP,
}) {
  const msg = Uint8Array.from(message);
  const att = Uint8Array.from(attestation);
  const MT = toPubkeyBytes(programs.messageTransmitterProgram);
  const payerKey = toPubkeyBytes(payer);
  const callerKey = caller === undefined || caller === null ? payerKey : toPubkeyBytes(caller);
  const receiverKey = toPubkeyBytes(receiverProgram);

  const authorityPda = findProgramAddress([utf8("message_transmitter_authority"), receiverKey], MT).address;
  const messageTransmitter = findProgramAddress([utf8("message_transmitter")], MT).address;
  const nonceSeed = msg.slice(MESSAGE_NONCE_INDEX, MESSAGE_SENDER_INDEX);
  const usedNonce = findProgramAddress([utf8("used_nonce"), nonceSeed], MT).address;
  const eventAuthority = findProgramAddress([utf8("__event_authority")], MT).address;

  const keys = [
    meta(payerKey, true, true),
    meta(callerKey, true, false),
    meta(authorityPda, false, false),
    meta(messageTransmitter, false, false),
    meta(usedNonce, false, true),
    meta(receiverKey, false, false),
    meta(SYSTEM_PROGRAM_ID, false, false),
    meta(eventAuthority, false, false),
    meta(MT, false, false),
    ...remainingAccounts.map((a) => meta(a.pubkey, !!a.isSigner, !!a.isWritable)),
  ];
  return { programId: MT, keys, data: encodeReceiveMessageData({ message: msg, attestation: att }) };
}

// ─────────────────────────────────────────────────────────────────── parsers

/**
 * Read TokenMessenger.fee_recipient out of the on-chain account data.
 * Layout: 8-byte discriminator || denylister(32) || owner(32) || pending_owner(32)
 *         || message_body_version(u32,4) || authority_bump(u8,1) || fee_recipient(32)
 * so fee_recipient starts at byte 109.
 */
export function parseTokenMessengerFeeRecipient(data) {
  const bytes = Uint8Array.from(data);
  if (bytes.length < 141) throw new Error("parseTokenMessengerFeeRecipient: account data too short");
  return bytes.slice(109, 141);
}

/** Extract the 32-byte remote burn token from a CCTP message's BurnMessage body. */
export function parseBurnMessageSourceToken(message) {
  const msg = Uint8Array.from(message);
  const start = MESSAGE_MESSAGE_BODY_INDEX + BURN_TOKEN_BODY_INDEX;
  if (msg.length < start + 32) throw new Error("parseBurnMessageSourceToken: message too short");
  return msg.slice(start, start + 32);
}
