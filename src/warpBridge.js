// warpBridge.js — Stage 2 of the X1 on-ramp: Solana USDC -> X1 USDC.x via Warp.
//
// BUILT FROM THE FULL IDL extracted from the Warp Bridge frontend bundle
// (app.bridge.x1.xyz) + verified against two live mainnet bridge transactions.
//
// ── WHAT THIS DOES ──
//   1. Skims your 1% fee (a plain SPL transfer to YOUR fee wallet).
//   2. Calls the Warp `BridgeOut` instruction with the remaining 99%.
//   3. USDC.x lands on X1 at the SAME address as the Solana sender.
//
// ── SAFETY ──
//   * ALWAYS run simulate() first. Never go live without simulation passing.
//   * RunStage2({ allowLive: false }) is the default — set true to sign+send.
//
// Requires: @solana/web3.js and @solana/spl-token in your app.
//   npm i @solana/web3.js @solana/spl-token

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  Connection,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { simulateSolanaTx, guardedSendSolanaTx } from "./lib/simulateTx.js";
import { FEE_RATES } from "./lib/fees.ts";

// ── CONSTANTS ──
export const WARP_PROGRAM_ID = new PublicKey(
  "6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD"
);
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

// X1-side: USDC.x is a Token-2022 mint; the recipient ATA must EXIST on X1
// before Warp's guardians execute bridge_in_v2 (the v2 IDL has no
// associated_token_program in bridge_in_v2's account list — the program
// cannot create it, the client must).
export const X1_ATA_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

// Minimum lamports a Solana fee payer needs before stage 2 will even
// simulate. Covers rent-exempt for a 0-byte system account (~0.00089088 SOL)
// plus a few tx fees. Below this the RPC rejects the tx at load with the
// cryptic `AccountNotFound` (fee payer does not exist on-chain) — we preflight
// it so the user gets an actionable message instead.
export const SOLANA_FEE_PAYER_MIN_LAMPORTS = 1_000_000n; // 0.001 SOL

/**
 * Stage2FeePayerError — thrown when the user's Solana wallet cannot pay the
 * stage-2 tx fee (account missing on Solana mainnet, or below rent-exempt).
 * Without this preflight the RPC fails the simulation with the bare
 * `AccountNotFound`, which is indistinguishable from a broken account list.
 */
export class Stage2FeePayerError extends Error {
  constructor(message, { pubkey = null, lamports = null } = {}) {
    super(message);
    this.name = "Stage2FeePayerError";
    this.pubkey = pubkey;
    this.lamports = lamports;
  }
}

// BridgeOut instruction discriminator — from the IDL
export const BRIDGE_OUT_DISCRIMINATOR = Uint8Array.from([
  27, 194, 57, 119, 215, 165, 247, 150,
]);

// Known on-chain PDAs (verified against live txs)
export const WARP_ACCOUNTS = {
  config: new PublicKey("48Po6qAHRJojbXH7KRqt6s5GfNfs9VEGccfqYEHmubEi"),
  tokenRegistry: new PublicKey("34E131ZpUomghxgvW8RnYSucQrY2zNQZRyHgPzL4MqCf"),
  vault: new PublicKey("C6byAvMfEa9wrbfVDeLEWbCkQNa8HAtpGxDPZKG3FqRp"),
  vaultTokenAccount: new PublicKey("H3E5ywpQ96z5MfhKniB7n95sDq3asXeo46mQeLmiBZ26"),
  feePda: new PublicKey("7bz2ZNphReLcmwv1tbhG8VnR1RzAzyxPNuKa3s2Jig7j"),
  // Fee collector token account (account #9) for the Solana-side USDC lock.
  // GROUND TRUTH: successful forward lock 5EwuE3rr… (Jun 28 2026, Operation: lock,
  // seq 72058023433695936) transferred the flat 1 USDC Warp fee to THIS account.
  // The program validates account #9 against its configured fee token account;
  // a stale value here makes bridge_out fail with "Assertion failed".
  feeCollectorAta: new PublicKey("6ob9XW6f6mweGu5sGh3JwW2Vp6UNQApjuPvrubXMQXyi"),
};

const USDC_DECIMALS = 6;
export const ONE_USDC = 1_000_000n;
// 1.00% = 100 basis points. Sourced from src/lib/fees.ts (Step 1.3C) so the
// on-chain skim and every other fee read the SAME constant — if the rate ever
// changes there, this follows automatically and cannot drift.
export const SKIM_BPS = BigInt(Math.round(FEE_RATES.X1_HOP_SKIM * 10_000));

// ── WARP v2 SPEC — FULL ACCOUNT LISTS (extracted from the Warp UI bundle's
// own IDL at app.bridge.x1.xyz, Aug 2026; cross-checked against a live
// mainnet bridge_out tx 3f8phJKqb…). The stage-2 code builds bridge_out from
// this named spec so a test can prove every slot matches the IDL — order and
// role both matter to the program (accounts are read by position).
//
// bridge_out (Solana side, native-USDC lock):
//   config, token_registry, outgoing_msg, sender, sender_token_account,
//   token_mint, vault, vault_token_account, fee_collector,
//   fee_collector_token_account, token_program, system_program
export const WARP_BRIDGE_OUT_ACCOUNTS_SPEC = [
  { name: "config", writable: true, signer: false },
  { name: "token_registry", writable: true, signer: false },
  { name: "outgoing_msg", writable: true, signer: false },
  { name: "sender", writable: true, signer: true },
  { name: "sender_token_account", writable: true, signer: false },
  { name: "token_mint", writable: true, signer: false },
  { name: "vault", writable: true, signer: false },
  { name: "vault_token_account", writable: true, signer: false },
  { name: "fee_collector", writable: true, signer: false },
  { name: "fee_collector_token_account", writable: true, signer: false },
  { name: "token_program", writable: false, signer: false },
  { name: "system_program", writable: false, signer: false },
];

// bridge_in_v2 (X1 side, executed by Warp's guardians with the staged
// signature set — NOT submitted by this app; the app's job is to make every
// account it CAN control exist first, above all the recipient ATA):
//   config, guardian_set, token_registry, signature_set, incoming_msg, payer,
//   recipient, recipient_token_account, token_mint, mint_authority,
//   [vault, vault_token_account — OPTIONAL, native-only: omitted for wrapped
//   USDC.x], token_program, system_program
//
// NOTE: the v2 IDL has NO associated_token_program in this list — the program
// CANNOT create the recipient ATA. It must pre-exist, which is exactly what
// ensureX1RecipientAta() does (idempotent create, payer = the user's wallet)
// before the Solana-side bridge_out is broadcast.
export const WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC = [
  { name: "config", writable: true, signer: false, pdaSeeds: ["config"] },
  { name: "guardian_set", writable: false, signer: false, pdaSeeds: ["guardian_set"] },
  { name: "token_registry", writable: true, signer: false, pdaSeeds: ["token_registry", "<local_mint>"] },
  { name: "signature_set", writable: true, signer: false, pdaSeeds: ["sig_set", "<guardian_set_index>", "<source_seq>", "<sender>", "<source_token_mint>", "<local_mint>", "<amount>", "<source_timestamp>"] },
  { name: "incoming_msg", writable: true, signer: false, pdaSeeds: ["evt_in", "<source_seq>"] },
  { name: "payer", writable: true, signer: true },
  { name: "recipient", writable: true, signer: false }, // must equal sender (bridge-to-self)
  { name: "recipient_token_account", writable: true, signer: false }, // ← created idempotently by us
  { name: "token_mint", writable: true, signer: false },
  { name: "mint_authority", writable: true, signer: false, pdaSeeds: ["mint_authority", "<local_mint>"], optional: true }, // wrapped tokens
  { name: "vault", writable: true, signer: false, pdaSeeds: ["vault", "<local_mint>"], optional: true }, // native-only: OMITTED for USDC.x
  { name: "vault_token_account", writable: true, signer: false, optional: true }, // native-only: OMITTED for USDC.x
  { name: "token_program", writable: false, signer: false },
  { name: "system_program", writable: false, signer: false },
];

// ── PDA DERIVATION ──
// From the Warp IDL — verified against live on-chain accounts.
// outgoing_msg PDA = seeds=["evt_out", seq(u64, LE)]
// (Browser-safe: uses Uint8Array, not Node's Buffer.)
export function deriveOutgoingMsgPda(seq) {
  const sq = new Uint8Array(8);
  let v = BigInt(seq);
  for (let i = 0; i < 8; i++) { sq[i] = Number(v & 0xffn); v >>= 8n; }
  const seedStr = new TextEncoder().encode("evt_out");
  const [pda] = PublicKey.findProgramAddressSync(
    [seedStr, sq],
    WARP_PROGRAM_ID
  );
  return pda;
}

export function toBaseUnits(humanUsdc) {
  return BigInt(Math.round(Number(humanUsdc) * 10 ** USDC_DECIMALS));
}
export function fromBaseUnits(base) {
  return Number(base) / 10 ** USDC_DECIMALS;
}

function encodeBridgeOutData(seq, amountGross) {
  const buf = new Uint8Array(8 + 8 + 8);
  buf.set(BRIDGE_OUT_DISCRIMINATOR, 0);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(8, BigInt(seq), true);
  dv.setBigUint64(16, BigInt(amountGross), true);
  return buf;
}

// On-chain fallback for the forward direction: has the mint landed on X1?
// bridge_in on X1 creates the incoming-message PDA ["evt_in", u64LE(seq)] under
// the Warp program. If that account exists, USDC.x was minted for this seq —
// true regardless of whether the status API ever returns "complete".
export async function verifyX1Mint(x1Connection, seq) {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const enc = (s) => new TextEncoder().encode(s);
    const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
    const evtIn = PublicKey.findProgramAddressSync([enc("evt_in"), u64le(seq)], WARP_PROGRAM_ID)[0];
    const info = await x1Connection.getAccountInfo(evtIn);
    return { minted: !!info, evtIn: evtIn.toBase58() };
  } catch (e) {
    return { minted: false, error: e?.message };
  }
}

// Read the REAL outgoing sequence from the Warp Config account.
// The program asserts the seq passed to bridge_out matches its expected
// out_seq_counter; a made-up value (e.g. a timestamp) fails that assertion.
// Config layout: 8 (disc) + 32 (admin) + 1 (paused) + 160 (guardians[5])
//   + 1 (num_guardians) + 1 (threshold) => out_seq_counter (u64 LE) at byte 203.

// Read out_seq_counter (Config byte 203) with multi-RPC fallback + retry, so a
// single endpoint 403/429 doesn't kill the bridge. Pass extraRpcs (your Helius
// URL) first; we then try a few permissive public fallbacks.
// Helius Secure URL first (works without env var), then public fallbacks.
const FALLBACK_RPCS = [
  "https://berty-633y20-fast-mainnet.helius-rpc.com",
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
];

async function getConfigAccountData(primaryRpcUrl) {
  // primary (your configured RPC) first, then de-duped fallbacks
  const seen = new Set();
  const urls = [primaryRpcUrl, ...FALLBACK_RPCS].filter((u) => {
    if (!u || seen.has(u)) return false; seen.add(u); return true;
  });
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "getAccountInfo",
    params: [WARP_ACCOUNTS.config.toBase58(), { encoding: "base64", commitment: "confirmed" }],
  });
  const errors = [];
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (!resp.ok) { errors.push(`${shortRpc(url)}:HTTP${resp.status}`); break; }
        const j = await resp.json();
        if (j.error) { errors.push(`${shortRpc(url)}:${j.error.message || j.error.code}`); break; }
        const val = j.result?.value;
        if (!val?.data?.[0]) { errors.push(`${shortRpc(url)}:empty`); break; }
        return Uint8Array.from(atob(val.data[0]), (c) => c.charCodeAt(0));
      } catch (e) {
        errors.push(`${shortRpc(url)}:${(e.message || "fetch").slice(0, 30)}`);
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  throw new Error(
    "Could not read Warp Config from any RPC. Set VITE_SOLANA_RPC to a real " +
    "Solana RPC (Helius/Triton/QuickNode). Tried: " + errors.join(" | ")
  );
}

function shortRpc(u) {
  try { return new URL(u).hostname.replace(/\.helius-rpc\.com$/, "(helius)"); }
  catch { return u; }
}

// Chain IDs per Warp Integration Spec.
const CHAIN_ID_SOLANA = 0;
const CHAIN_ID_X1 = 1;

// Build a chain-discriminated sequence per the spec:
//   chainPair = (sourceChainId << 4) | destChainId    // Sol->X1 = 0x01
//   baseSeq   = slot * 1000 + ixIndex                 // ixIndex in [0,999]
//   seq       = (chainPair << 56) | baseSeq
// IMPORTANT: plain counters (e.g. reading out_seq_counter) are a TERMINAL
// failure per the spec and can LOCK funds. We must construct from the slot.
export function encodeWarpSeq(slot, ixIndex = 0, sourceChainId = CHAIN_ID_SOLANA, destChainId = CHAIN_ID_X1) {
  if (ixIndex < 0 || ixIndex > 999) throw new Error("ixIndex must be in [0,999]");
  const chainPair = BigInt((sourceChainId << 4) | destChainId);
  const baseSeq = BigInt(slot) * 1000n + BigInt(ixIndex);
  return (chainPair << 56n) | baseSeq;
}

// Fetch the current slot and construct the spec-compliant seq for Solana->X1.
// (ixIndex = 0 because our tx contains a single bridge_out.)
export async function fetchSeq(connection, ixIndex = 0) {
  let slot;
  try {
    slot = await connection.getSlot("confirmed");
  } catch (e) {
    // Fallback: read slot via raw fetch across known-good RPCs (Helius first).
    slot = await getSlotFallback();
  }
  return encodeWarpSeq(slot, ixIndex, CHAIN_ID_SOLANA, CHAIN_ID_X1);
}

async function getSlotFallback() {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "confirmed" }] });
  for (const url of FALLBACK_RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!r.ok) continue;
      const j = await r.json();
      if (typeof j.result === "number") return j.result;
    } catch { /* next */ }
  }
  throw new Error("Could not read current slot from any RPC (needed to build the seq).");
}

// ── STAGE-2 PREFLIGHT (fee payer must exist on Solana) ──
// The live hop failed with the bare `AccountNotFound`. Reproduction: when the
// fee payer's system account does not exist on Solana mainnet (a wallet that
// only ever received USDC via a LiFi-created ATA has NO Solana account), the
// RPC rejects the tx at LOAD — before any instruction runs — with
// TransactionError::AccountNotFound. All 12 bridge_out accounts exist
// on-chain; the tx construction is spec-perfect (proven by simulation reaching
// `Instruction: BridgeOut` with a funded fee payer). The fix is to preflight
// the fee payer so the failure is actionable instead of cryptic.
export async function assertSolanaFeePayer(connection, userPubkey) {
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  let info = null;
  try {
    info = await connection.getAccountInfo(userPubkey);
  } catch (e) {
    // RPC read failed — fail closed with the same class of error, but say WHY.
    throw new Stage2FeePayerError(
      `Could not check your Solana wallet (${userPubkey.toBase58()}) before bridging: ${e?.message || e}. ` +
      `Retry when the RPC is reachable.`,
      { pubkey: userPubkey.toBase58() },
    );
  }
  const lamports = info ? BigInt(info.lamports) : 0n;
  if (lamports < SOLANA_FEE_PAYER_MIN_LAMPORTS) {
    throw new Stage2FeePayerError(
      `Your Solana wallet (${userPubkey.toBase58()}) has no spendable SOL on Solana mainnet ` +
      `(${Number(lamports) / 1e9} SOL) — the Warp bridge needs a funded Solana account to pay the tx fee. ` +
      `Send ~0.001 SOL to that address (or connect a Solana wallet that has SOL), then retry. ` +
      `Your funds stay safe in your wallet until then.`,
      { pubkey: userPubkey.toBase58(), lamports },
    );
  }
  return { ok: true, lamports };
}

// ── X1 DESTINATION PREP — idempotent recipient ATA (Warp v2 spec step 1) ──
// Warp's own UI creates the recipient's USDC.x ATA on X1 BEFORE bridging; the
// v2 IDL's bridge_in_v2 has no associated_token_program, so the guardian mint
// REQUIRES the ATA to pre-exist. Our stage-2 previously never touched X1 — the
// guardian bridge_in_v2 would fail on a missing recipient ATA. This creates it
// idempotently (create-if-missing, no-op if present) so stage-2 is retryable:
// a retry after a half-finished attempt cannot hit "account already exists".
export function deriveX1UsdcxAta(userPubkey) {
  return getAssociatedTokenAddressSync(
    X1_USDCX_MINT, userPubkey, true, TOKEN_2022_PROGRAM_ID,
  );
}

export async function ensureX1RecipientAta({ connection, userPubkey, payer = null }) {
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  if (payer && !(payer instanceof PublicKey)) payer = new PublicKey(payer);
  const payerPk = payer || userPubkey; // the connected wallet pays rent + signs
  const ata = deriveX1UsdcxAta(userPubkey);

  let info = null;
  try {
    info = await connection.getAccountInfo(ata);
  } catch (e) {
    throw new Error(
      `Could not check your X1 USDC.x account (${ata.toBase58()}): ${e?.message || e}. ` +
      `Retry when the X1 RPC is reachable.`,
    );
  }
  if (info) return { needsCreation: false, ata };

  // Idempotent create — plain create would throw "account already exists" if a
  // retry fires after the ATA got made (trading AccountNotFound for
  // AccountAlreadyExists). Payer = the user's connected wallet (its adapter
  // signs); the ATA is owned by the user, mint = USDC.x (Token-2022).
  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payerPk, // payer (rent + fee)
      ata,     // associated token account to create/ensure
      userPubkey, // owner
      X1_USDCX_MINT, // mint (USDC.x, Token-2022)
      TOKEN_2022_PROGRAM_ID, // token program
    ),
  );
  tx.feePayer = payerPk;
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
  } catch { /* wallet may supply one */ }
  return { needsCreation: true, transaction: tx, ata };
}

// Guarded broadcast of the X1 ATA-creation tx: simulate on the X1 RPC first
// (fail-closed — a rejection or an unreachable RPC blocks the send), then let
// the connected wallet sign + broadcast on the X1 network.
export async function sendX1AtaCreation(connection, transaction, provider) {
  const p = provider ||
    (typeof window !== "undefined" ? window.solana || window.phantom?.solana : null);
  if (!p) throw new Error("No Solana/X1 wallet found to sign the X1 account-creation tx");
  return guardedSendSolanaTx(connection, transaction, async () => {
    if (typeof p.signAndSendTransaction === "function") {
      const res = await p.signAndSendTransaction(transaction);
      return res?.signature || res;
    }
    throw new Error("Connected wallet can't sign the X1 account-creation transaction");
  });
}

// Build the full Stage-2 transaction
export async function buildStage2({
  connection,
  userPubkey,
  feeWalletSvm,
  amountHuman,
  seq,
}) {
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  if (!(feeWalletSvm instanceof PublicKey)) feeWalletSvm = new PublicKey(feeWalletSvm);

  const grossAll = toBaseUnits(amountHuman);
  const skimBase = (grossAll * SKIM_BPS) / 10_000n;
  const bridgeBase = grossAll - skimBase;

  if (bridgeBase < 10n * ONE_USDC) {
    throw new Error(
      `After 1% skim, ${fromBaseUnits(bridgeBase)} USDC is below Warp's $10 minimum.`
    );
  }

  const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, userPubkey);
  const feeUsdcAta = await getAssociatedTokenAddress(USDC_MINT, feeWalletSvm);

  const theSeq = seq ?? (await fetchSeq(connection));
  const outgoingMsgPda = deriveOutgoingMsgPda(theSeq);

  const tx = new Transaction();

  // 1) Compute budget
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }));

  // 2) Our 1% skim
  tx.add(
    createTransferInstruction(
      userUsdcAta,
      feeUsdcAta,
      userPubkey,
      skimBase,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  // 3) Warp BridgeOut
  const data = encodeBridgeOutData(theSeq, bridgeBase);

  // Account order driven by WARP_BRIDGE_OUT_ACCOUNTS_SPEC (extracted from the
  // Warp v2 IDL + verified against live mainnet tx
  // 3f8phJKqbQ3NL4i18uYMWWiBi7iA6tNUAXQdchQ2FchqJMRuEqGyxej2t9aAfrwxvcwYgSgJb9fBacR7L7diqXw2).
  // The program reads accounts by POSITION — order and writable/signer flags
  // are part of the contract. A test asserts every slot against the spec.
  const byName = {
    config: WARP_ACCOUNTS.config,
    token_registry: WARP_ACCOUNTS.tokenRegistry,
    outgoing_msg: outgoingMsgPda,
    sender: userPubkey,
    sender_token_account: userUsdcAta,
    token_mint: USDC_MINT,
    vault: WARP_ACCOUNTS.vault,
    vault_token_account: WARP_ACCOUNTS.vaultTokenAccount,
    fee_collector: WARP_ACCOUNTS.feePda,
    fee_collector_token_account: WARP_ACCOUNTS.feeCollectorAta,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  };
  const keys = WARP_BRIDGE_OUT_ACCOUNTS_SPEC.map(({ name, writable, signer }) => ({
    pubkey: byName[name],
    isSigner: signer,
    isWritable: writable,
  }));

  tx.add(
    new TransactionInstruction({
      programId: WARP_PROGRAM_ID,
      keys,
      data, // already a Uint8Array (browser-safe, no Buffer needed)
    })
  );

  tx.feePayer = userPubkey;
  // Initial blockhash (confirmed = widely propagated). This is refreshed again
  // right before send to avoid RPC-sync "Blockhash not found" errors.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  return { transaction: tx, skimBase, bridgeBase, seq: theSeq, outgoing_msg: outgoingMsgPda };
}

// Simulation gate for Stage 2 (Step 1.3A). Delegates to src/lib/simulateTx.js
// (same behavior, DI-friendly, unit-tested). FAIL-CLOSED: a program rejection
// blocks the send, and an RPC-level simulation failure ALSO blocks — if we
// cannot prove the tx would succeed, we do not broadcast it.
export async function simulateStage2(connection, transaction) {
  return simulateSolanaTx(connection, transaction);
}

export async function sendStage2ViaPhantom(connection, transaction, provider) {
  // Use the provider the user actually connected (Backpack/Phantom/X1), not a
  // hardcoded window.solana.
  const p = provider ||
    (typeof window !== "undefined" ? window.solana || window.phantom?.solana : null);
  if (!p) throw new Error("No Solana wallet found to sign the Warp tx");

  // PREFER signTransaction + OUR broadcast through the SAME connection the tx
  // was simulated against. X1 is SVM-compatible: a wallet on the X1 network
  // would broadcast a Solana tx to X1 via signAndSendTransaction — where the
  // Solana accounts don't exist and the RPC rejects it (again with
  // `AccountNotFound` when the wallet itself isn't on X1). Broadcasting via the
  // app's Solana connection makes the destination chain deterministic and
  // matches the simulation. A fresh blockhash is applied at the last moment to
  // avoid "Blockhash not found".
  let freshHash = null;
  try {
    const r = await connection.getLatestBlockhash("confirmed");
    freshHash = r.blockhash;
    transaction.recentBlockhash = r.blockhash;
    transaction.lastValidBlockHeight = r.lastValidBlockHeight;
    if (transaction.signatures) transaction.signatures = [];
  } catch { /* wallet will supply one */ }

  // ── MANDATORY PRE-SEND SIMULATION (Step 1.3A, fail-closed) ──
  // Simulate the EXACT transaction we are about to broadcast (fresh blockhash
  // already applied above). If it would fail — or if we cannot prove it would
  // succeed because the simulation RPC is down — the send is BLOCKED and the
  // surfaced reason propagates. No wallet prompt, no broadcast, no wasted gas.
  return guardedSendSolanaTx(connection, transaction, async () => {
    if (typeof p.signTransaction === "function") {
      // Deterministic broadcast: WE send through the connection the blockhash
      // and simulation came from, so the tx lands on Solana mainnet regardless
      // of which network the wallet is currently pointed at.
      const signed = await p.signTransaction(transaction);
      const sig = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    }

    // Fallback: let the wallet broadcast via its own RPC.
    if (typeof p.signAndSendTransaction === "function") {
      const res = await p.signAndSendTransaction(transaction);
      return res?.signature || res;
    }
    throw new Error("Connected wallet can't sign transactions");
  });
}

// Full guarded flow: preflight the fee payer, prepare the X1 recipient ATA
// (idempotent, if an X1 connection is supplied), build, simulate, optionally
// send.
export async function runStage2({
  connection,          // Solana RPC (the chain bridge_out executes on)
  userPubkey,
  feeWalletSvm,
  amountHuman,
  allowLive = false,
  provider = null,
  x1Connection = null, // X1 RPC — enables the recipient-ATA prep (Warp v2 spec step 1)
  createX1Ata = true,
}) {
  // 0) Fee-payer preflight (Solana): the bare `AccountNotFound` from the live
  //    hop was the fee payer missing on Solana — surface it as an actionable
  //    error instead of letting the simulation die cryptically.
  await assertSolanaFeePayer(connection, userPubkey);

  // 1) X1 destination prep: bridge_in_v2 (guardians) requires the recipient's
  //    USDC.x ATA to already exist on X1. Create it idempotently via the
  //    connected wallet (payer = user) BEFORE the Solana leg locks funds.
  //    allowLive:false still SIMULATES the ATA tx (fail-closed) but broadcasts
  //    nothing — same no-touch promise as the Solana leg.
  let prep = null;
  if (x1Connection && createX1Ata) {
    prep = await ensureX1RecipientAta({
      connection: x1Connection,
      userPubkey,
      payer: userPubkey, // the user's connected wallet pays rent + signs
    });
    if (prep.needsCreation) {
      if (allowLive) {
        // Guarded: simulate on X1 (fail-closed), then wallet signs + broadcasts.
        await sendX1AtaCreation(x1Connection, prep.transaction, provider);
      } else {
        const prepSim = await simulateStage2(x1Connection, prep.transaction);
        if (!prepSim.ok) {
          return { stage: "x1_ata_simulation", success: false, sim: prepSim, prep, built: null };
        }
      }
    }
  }

  const built = await buildStage2({
    connection,
    userPubkey,
    feeWalletSvm,
    amountHuman,
  });
  const sim = await simulateStage2(connection, built.transaction);
  if (!sim.ok) {
    return { stage: "simulation", success: false, sim, built, prep };
  }
  if (!allowLive) {
    return { stage: "simulated_ok", success: true, sim, built, sent: null, prep };
  }
  const sig = await sendStage2ViaPhantom(connection, built.transaction, provider);
  return { stage: "sent", success: true, sim, built, signature: sig, prep };
}

// ════════════════════════════════════════════════════════════════════════════
//  REVERSE: X1 → Solana  (BURN USDC.x on X1 mainnet, release USDC on Solana)
//  Decoded from real mainnet tx mMQt8Ypjed... (Operation: burn).
//  MAINNET SPECIFICS (differ from testnet):
//   - SAME program 6JbPTux on both chains (no separate X1 program)
//   - USDC.x is a TOKEN-2022 mint (B69chRz), so ATAs + token program differ
//   - account 9 = feeCollector's USDC.x ATA, account 10 = Token-2022 program
// ════════════════════════════════════════════════════════════════════════════
export const X1_USDCX_MINT = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const X1_FEE_COLLECTOR = new PublicKey("7bz2ZNphReLcmwv1tbhG8VnR1RzAzyxPNuKa3s2Jig7j");
// The fee account at slot 9 is a FIXED program fee account (not a derivable
// ATA) — taken verbatim from the real mainnet burn tx mMQt8Ypjed...
const X1_FEE_ACCOUNT = new PublicKey("4uRFjqVU5ZKkp7hQLx3Lm3YeWFts17ER8a5HLUE18ayG");
const CHAIN_PAIR_X1_TO_SOL = 0x10;

function deriveX1RevAccounts() {
  const enc = (s) => new TextEncoder().encode(s);
  // X1-side bridge program is the SAME 6JbPTux on mainnet.
  const [config] = PublicKey.findProgramAddressSync([enc("config")], WARP_PROGRAM_ID);
  const [tokenRegistry] = PublicKey.findProgramAddressSync(
    [enc("token_registry"), X1_USDCX_MINT.toBytes()], WARP_PROGRAM_ID);
  return { config, tokenRegistry };
}
const _x1rev = deriveX1RevAccounts();

function deriveX1RevOutgoingMsgPda(seq) {
  const sq = new Uint8Array(8);
  let v = BigInt(seq);
  for (let i = 0; i < 8; i++) { sq[i] = Number(v & 0xffn); v >>= 8n; }
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("evt_out"), sq], WARP_PROGRAM_ID);
  return pda;
}

export function encodeReverseSeq(slot, ixIndex = 0) {
  const baseSeq = BigInt(slot) * 1000n + BigInt(ixIndex);
  return (BigInt(CHAIN_PAIR_X1_TO_SOL) << 56n) | baseSeq;
}

export async function buildReverseBurn({ connection, userPubkey, amountHuman, seq }) {
  const toPk = (v) => {
    if (v instanceof PublicKey) return v;
    if (typeof v === "string") return new PublicKey(v);
    if (v && typeof v.toBase58 === "function") return new PublicKey(v.toBase58());
    if (v && typeof v.toString === "function") return new PublicKey(v.toString());
    throw new Error("Cannot resolve a Solana public key from the wallet");
  };
  userPubkey = toPk(userPubkey);
  const amount = toBaseUnits(amountHuman);

  // user's USDC.x token account — TOKEN-2022 ATA
  const userUsdcxAta = getAssociatedTokenAddressSync(
    X1_USDCX_MINT, userPubkey, true, TOKEN_2022_PROGRAM_ID);

  let slot;
  try { slot = await connection.getSlot("confirmed"); }
  catch { slot = await getSlotFallback(); }
  const theSeq = seq ?? encodeReverseSeq(slot, 0);
  const outgoingMsgPda = deriveX1RevOutgoingMsgPda(theSeq);

  const data = encodeBridgeOutData(theSeq, amount);

  // Account order EXACTLY from real mainnet X1->Sol burn tx (mMQt8Ypjed...)
  const keys = [
    { pubkey: _x1rev.config, isSigner: false, isWritable: true },              // 0 config (48Po6q)
    { pubkey: _x1rev.tokenRegistry, isSigner: false, isWritable: true },       // 1 token_registry (2etcJK)
    { pubkey: outgoingMsgPda, isSigner: false, isWritable: true },             // 2 outgoing_msg
    { pubkey: userPubkey, isSigner: true, isWritable: true },                  // 3 sender
    { pubkey: userUsdcxAta, isSigner: false, isWritable: true },               // 4 user USDC.x acct (burn src)
    { pubkey: X1_USDCX_MINT, isSigner: false, isWritable: true },              // 5 USDC.x mint (burned)
    { pubkey: WARP_PROGRAM_ID, isSigner: false, isWritable: false },           // 6 program self
    { pubkey: WARP_PROGRAM_ID, isSigner: false, isWritable: false },           // 7 program self
    { pubkey: X1_FEE_COLLECTOR, isSigner: false, isWritable: true },           // 8 feeCollector wallet
    { pubkey: X1_FEE_ACCOUNT, isSigner: false, isWritable: true },             // 9 fixed fee account (4uRFjq)
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },     // 10 Token-2022 program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 11 system program
  ];

  const tx = new Transaction();
  tx.add(new TransactionInstruction({ programId: WARP_PROGRAM_ID, keys, data }));
  tx.feePayer = userPubkey;
  try {
    const r = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = r.blockhash;
  } catch { /* wallet supplies */ }

  return { transaction: tx, seq: theSeq, amount, outgoing_msg: outgoingMsgPda };
}

export async function runReverse({ connection, userPubkey, amountHuman, feeAmount = 0, feeWallet = null, allowLive = false, provider = null, onBuilt = () => {} }) {
  const built = await buildReverseBurn({ connection, userPubkey, amountHuman });
  
  // If a Teleporter fee is due, prepend a transfer instruction (1% USDC.x to fee wallet).
  if (feeAmount > 0 && feeWallet) {
    const { PublicKey } = await import("@solana/web3.js");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const userPk = userPubkey instanceof PublicKey ? userPubkey : new PublicKey(userPubkey);
    const feeWalletPk = feeWallet instanceof PublicKey ? feeWallet : new PublicKey(feeWallet);
    
    const userUsdcxAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, userPk, true, TOKEN_2022_PROGRAM_ID);
    const feeUsdcxAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, feeWalletPk, true, TOKEN_2022_PROGRAM_ID);
    const feeAmount_base = toBaseUnits(feeAmount);
    
    // USDC.x is a Token-2022 mint — use createTransferInstruction with the
    // Token-2022 program id (there is no separate "Token2022Program" class).
    const transferFeeIx = createTransferInstruction(
      userUsdcxAta, feeUsdcxAta, userPk, feeAmount_base, [], TOKEN_2022_PROGRAM_ID
    );
    built.transaction.instructions.unshift(transferFeeIx);
  }
  
  onBuilt();
  const sim = await simulateStage2(connection, built.transaction);
  if (!sim.ok) return { stage: "simulation", success: false, sim, built };
  if (!allowLive) return { stage: "simulated_ok", success: true, sim, built, sent: null };
  const sig = await sendStage2ViaPhantom(connection, built.transaction, provider);
  return { stage: "sent", success: true, sim, built, signature: sig };
}

// ── Warp API status polling ──
export const WARP_API = {
  mainnet: "https://api.bridge.mainnet.x1.xyz",
  testnet: "https://api.bridge.testnet.x1.xyz",
};

// Fetch daily inflow/outflow limits from Warp config (Sol/X1 caps per 24h)
export async function fetchWarpLimits(api = WARP_API.mainnet) {
  try {
    const resp = await fetch(`${api}/config`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const config = await resp.json();
    // Expected: { chains: { sol: { dailyInflow, dailyOutflow, ... }, x1: { ... } } }
    return {
      ok: true,
      sol: {
        inflow: config?.chains?.sol?.dailyInflow || 0,
        outflow: config?.chains?.sol?.dailyOutflow || 0,
      },
      x1: {
        inflow: config?.chains?.x1?.dailyInflow || 0,
        outflow: config?.chains?.x1?.dailyOutflow || 0,
      },
      raw: config,
    };
  } catch (e) {
    console.warn("[Warp] fetchWarpLimits error:", e?.message);
    return { ok: false, error: e?.message };
  }
}

// Poll for guardian signatures + final status. onUpdate(stage, detail) is called
// as state changes. Returns the terminal result. 404 before sigs is NORMAL.
export async function pollWarpStatus(sourceSig, { api = WARP_API.mainnet, from = "sol", onUpdate = () => {}, maxMs = 180000, intervalMs = 4000 } = {}) {
  const start = Date.now();
  let sawSigs = false;
  while (Date.now() - start < maxMs) {
    // 1) signatures endpoint — tells us guardian quorum progress
    try {
      const sresp = await fetch(`${api}/transactions/${sourceSig}/signatures?from=${from}`);
      if (sresp.ok) {
        const sj = await sresp.json();
        const sigs = Array.isArray(sj) ? sj : (sj.signatures || []);
        if (sigs.length > 0) { sawSigs = true; onUpdate("guardians_signing", { count: sigs.length, sigs }); }
      } else if (sresp.status === 404) {
        onUpdate("awaiting_guardians", { note: "no guardian sigs yet (404 is normal)" });
      }
    } catch (e) { onUpdate("poll_error", { where: "signatures", msg: e.message }); }

    // 2) status endpoint — detection, submitter status, destination tx, final
    try {
      const tresp = await fetch(`${api}/transactions/${sourceSig}?from=${from}`);
      if (tresp.ok) {
        const tj = await tresp.json();
        onUpdate("status", tj);
        const dest = tj.destinationTxSignature || tj.destination_tx || tj.destTx;
        const final = (tj.status || tj.executionStatus || "").toString().toLowerCase();
        if (dest || final.includes("complete") || final.includes("executed") || final.includes("success")) {
          onUpdate("complete", { destinationTx: dest, raw: tj });
          return { ok: true, destinationTx: dest, raw: tj };
        }
        if (final.includes("fail") || final.includes("terminal") || final.includes("reject")) {
          onUpdate("failed", { raw: tj });
          return { ok: false, terminal: true, raw: tj };
        }
      }
    } catch (e) { onUpdate("poll_error", { where: "status", msg: e.message }); }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, timedOut: true, sawSigs };
}
