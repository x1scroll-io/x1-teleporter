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

export function toBaseUnits(humanUsdc, decimals = USDC_DECIMALS) {
  return BigInt(Math.round(Number(humanUsdc) * 10 ** decimals));
}
export function fromBaseUnits(base, decimals = USDC_DECIMALS) {
  return Number(base) / 10 ** decimals;
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

export function deriveX1WsolxAta(userPubkey) {
  return getAssociatedTokenAddressSync(
    X1_WSOLX_MINT, userPubkey, true, TOKEN_2022_PROGRAM_ID,
  );
}

/** Derive the X1 recipient ATA for a bridged-in token (USDC.x or wSOL.X). */
export function deriveX1TokenAta(userPubkey, mint = X1_USDCX_MINT) {
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  return getAssociatedTokenAddressSync(mintPk, userPubkey, true, TOKEN_2022_PROGRAM_ID);
}

export async function ensureX1RecipientAta({ connection, userPubkey, payer = null, mint = X1_USDCX_MINT }) {
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  if (payer && !(payer instanceof PublicKey)) payer = new PublicKey(payer);
  const payerPk = payer || userPubkey; // the connected wallet pays rent + signs
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const sym = mintPk.equals(X1_WSOLX_MINT) ? "wSOL.X" : "USDC.x";
  const ata = deriveX1TokenAta(userPubkey, mintPk);

  let info = null;
  try {
    info = await connection.getAccountInfo(ata);
  } catch (e) {
    throw new Error(
      `Could not check your X1 ${sym} account (${ata.toBase58()}): ${e?.message || e}. ` +
      `Retry when the X1 RPC is reachable.`,
    );
  }
  if (info) return { needsCreation: false, ata };

  // Idempotent create — plain create would throw "account already exists" if a
  // retry fires after the ATA got made (trading AccountNotFound for
  // AccountAlreadyExists). Payer = the user's connected wallet (its adapter
  // signs); the ATA is owned by the user, mint = USDC.x / wSOL.X (Token-2022).
  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payerPk, // payer (rent + fee)
      ata,     // associated token account to create/ensure
      userPubkey, // owner
      mintPk,  // mint (USDC.x / wSOL.X, Token-2022)
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
//
// Mirrors sendStage2ViaPhantom: PREFER signTransaction + app-side broadcast
// through the SAME connection the tx was simulated against (the X1 RPC at the
// call site). A wallet pointed at Solana mainnet cannot broadcast an X1
// transaction itself — signAndSendTransaction would send it to Solana where
// the X1 accounts don't exist and the RPC rejects it. A fresh blockhash is
// applied at the last moment to avoid RPC-sync "Blockhash not found" errors.
export async function sendX1AtaCreation(connection, transaction, provider) {
  const p = provider ||
    (typeof window !== "undefined" ? window.solana || window.phantom?.solana : null);
  if (!p) throw new Error("No Solana/X1 wallet found to sign the X1 account-creation tx");

  // Fresh blockhash applied BEFORE the guarded send, so the simulation gates
  // the EXACT transaction that gets signed + broadcast (same as Stage 2).
  try {
    const r = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = r.blockhash;
    transaction.lastValidBlockHeight = r.lastValidBlockHeight;
    if (transaction.signatures) transaction.signatures = [];
  } catch { /* wallet will supply one */ }

  return guardedSendSolanaTx(connection, transaction, async () => {
    if (typeof p.signTransaction === "function") {
      // Deterministic broadcast: WE send through the connection the blockhash
      // and simulation came from, so the tx lands on the X1 network regardless
      // of which network the wallet is currently pointed at.
      const signed = await p.signTransaction(transaction);
      const sig = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    }

    // Fallback: let the wallet broadcast via its own RPC (wallet already on X1).
    if (typeof p.signAndSendTransaction === "function") {
      const res = await p.signAndSendTransaction(transaction);
      return res?.signature || res;
    }
    throw new Error("Connected wallet can't sign the X1 account-creation transaction");
  });
}

// Build the full Stage-2 transaction
// destToken = the X1 destination token ("USDC.x" | "wSOL.X") — drives the
// Solana-side SOURCE mint (USDC | WSOL), the decimals (6 | 9), the Warp fee
// collector ATA (per-token, live config) and the vault PDAs (native path).
export async function buildStage2({
  connection,
  userPubkey,
  feeWalletSvm,
  amountHuman,
  seq,
  destToken = "USDC.x",
}) {
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  if (!(feeWalletSvm instanceof PublicKey)) feeWalletSvm = new PublicKey(feeWalletSvm);

  const fwd = X1_FORWARD_TOKENS[destToken] || X1_FORWARD_TOKENS["USDC.x"];
  const { sourceMint, decimals, feeAccount, minBase } = fwd;

  const grossAll = toBaseUnits(amountHuman, decimals);
  const skimBase = (grossAll * SKIM_BPS) / 10_000n;
  const bridgeBase = grossAll - skimBase;

  if (bridgeBase < minBase) {
    throw new Error(
      `After 1% skim, ${fromBaseUnits(bridgeBase, decimals)} ${destToken === "wSOL.X" ? "WSOL" : "USDC"} is below the Warp minimum.`
    );
  }

  const userTokenAta = await getAssociatedTokenAddress(sourceMint, userPubkey);
  const feeTokenAta = await getAssociatedTokenAddress(sourceMint, feeWalletSvm);

  const theSeq = seq ?? (await fetchSeq(connection));
  const outgoingMsgPda = deriveOutgoingMsgPda(theSeq);
  // Vault path (native tokens — both USDC and WSOL are native/locked on
  // Solana). The WSOL vault PDA 9ZFmvmJk… exists on mainnet; the USDC vault
  // derivation must equal WARP_ACCOUNTS.vault (asserted in tests).
  const { vault, vaultTokenAccount } = deriveVaultAccounts(sourceMint, TOKEN_PROGRAM_ID);

  const tx = new Transaction();

  // 1) Compute budget
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }));

  // 2) Our 1% skim — the fee wallet's SOURCE-token ATA must exist. USDC's
  //    exists (long-lived fee wallet); WSOL's does NOT yet (verified on
  //    mainnet) — bundle the idempotent create FIRST when missing so the
  //    forward leg never dead-ends on a missing fee ATA (the same-chain
  //    analog of the reverse leg's ensureX1FeeWalletAta bundling).
  let feeAtaCreated = false;
  try {
    const feeAtaInfo = await connection.getAccountInfo(feeTokenAta);
    if (!feeAtaInfo) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          userPubkey,   // payer (rent + fee — the user)
          feeTokenAta,  // the fee wallet's source-token ATA
          feeWalletSvm, // owner = the fee wallet
          sourceMint,
          TOKEN_PROGRAM_ID,
        ),
      );
      feeAtaCreated = true;
    }
  } catch { /* RPC hiccup — the transfer will surface it; never block on this */ }
  tx.add(
    createTransferInstruction(
      userTokenAta,
      feeTokenAta,
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
    sender_token_account: userTokenAta,
    token_mint: sourceMint,
    vault,
    vault_token_account: vaultTokenAccount,
    fee_collector: WARP_ACCOUNTS.feePda,
    fee_collector_token_account: feeAccount, // per-token (6ob9XW… USDC / GxfLqezi… WSOL)
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

  return { transaction: tx, skimBase, bridgeBase, seq: theSeq, outgoing_msg: outgoingMsgPda, destToken, feeAtaCreated };
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
  destToken = "USDC.x", // the X1 destination token ("USDC.x" | "wSOL.X")
}) {
  // 0) Fee-payer preflight (Solana): the bare `AccountNotFound` from the live
  //    hop was the fee payer missing on Solana — surface it as an actionable
  //    error instead of letting the simulation die cryptically.
  await assertSolanaFeePayer(connection, userPubkey);

  // 1) X1 destination prep: bridge_in_v2 (guardians) requires the recipient's
  //    token ATA (USDC.x or wSOL.X — both Token-2022) to already exist on X1.
  //    Create it idempotently via the connected wallet (payer = user) BEFORE
  //    the Solana leg locks funds. allowLive:false still SIMULATES the ATA tx
  //    (fail-closed) but broadcasts nothing — same no-touch promise as the
  //    Solana leg.
  const fwd = X1_FORWARD_TOKENS[destToken] || X1_FORWARD_TOKENS["USDC.x"];
  let prep = null;
  if (x1Connection && createX1Ata) {
    prep = await ensureX1RecipientAta({
      connection: x1Connection,
      userPubkey,
      payer: userPubkey, // the user's connected wallet pays rent + signs
      mint: fwd.destMint, // USDC.x / wSOL.X recipient ATA
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
    destToken,
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

// ── WSOL / wSOL.X — the SOL rail (ground truth: live Warp config
//    https://api.bridge.mainnet.x1.xyz/config, Sep 2026) ──
// X1-side wSOL.X: wrapped (isNative=false), 9 decimals, Token-2022 mint,
//   flat fee 0, percentageFeeBps 25 (0.25%), feeCollectorAta 9Tdid7tM….
// Solana-side WSOL (So111…): native (isNative=true), 9 decimals, spl-token
//   v1 mint, same 25 bps fee, feeCollectorAta GxfLqezi…. The X1 burn and the
//   Solana lock BOTH charge the pct fee (verified on-chain: a live wSOL.X
//   burn debited 0.11 wSOL.X gross → 0.000275 to the fee collector = exactly
//   25 bps of the gross, net release 0.109725).
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // Solana native wSOL (spl-token v1)
export const X1_WSOLX_MINT = new PublicKey("JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8"); // X1 wrapped wSOL.X (Token-2022)
// Warp fee-collector token accounts (per-token, from the live config):
export const X1_WSOLX_FEE_ACCOUNT = new PublicKey("9Tdid7tM1bKv8hMyiTDLfB2LhfCGoaBv5GoezQzW2VP9"); // X1 wSOL.X fee collector ATA
const SOL_WSOL_FEE_ACCOUNT = new PublicKey("GxfLqeziL8wrUF31H1thWVAHkqzPodoqbwZeoDTRAkyU"); // Solana wSOL fee collector ATA

/** Warp's per-token fee on the X1 side (bridge_out burn) — from the LIVE
 *  Warp config token registry. USDC.x: flat $1 (1_000_000 base, 6 dec).
 *  wSOL.X: percentage 25 bps of the bridge gross, flat 0. The program carves
 *  the fee OUT of the gross inside bridge_out (verified on-chain). */
export const X1_WARP_FEES = {
  "USDC.x": { kind: "flat", amountBase: 1_000_000n, decimals: 6 },
  "wSOL.X": { kind: "pct", bps: 25, decimals: 9 },
};

/** Warp's per-token fee on the SOLANA side (bridge_out lock) — same config. */
export const SOL_WARP_FEES = {
  USDC: { kind: "flat", amountBase: 1_000_000n, decimals: 6 },
  WSOL: { kind: "pct", bps: 25, decimals: 9 },
};

/** The reverse (X1→Sol) token map — which mint/decimals/fee account each
 *  bridged X1 token burns against. wSOL.X is WRAPPED on X1 (isNative=false):
 *  bridge_out BURNS it (Token-2022) exactly like USDC.x — the account spec is
 *  IDENTICAL (config, token_registry PDA, outgoing_msg, sender, sender ATA,
 *  mint, program, program, fee_collector, fee_collector_ata, token_program,
 *  system_program); only the mint, the registry PDA seed, the sender ATA and
 *  the fee-collector ATA change. Verified against live mainnet wSOL.X burns
 *  (12-account BridgeOut, Token-2022, fee 25bps) + the current program's IDL
 *  (bridge_out has NO mint_authority account — the mint_authority PDA belongs
 *  to bridge_in_v2, the RECEIVE side, where guardians mint wrapped tokens).
 *  The Anchor client fills the optional vault slots with the program ID when
 *  the token is wrapped (accounts 6+7 = the program itself, exactly as the
 *  USDC.x burn tx the code was built from). */
export const X1_REVERSE_TOKENS = {
  "USDC.x": { mint: X1_USDCX_MINT, decimals: 6, feeAccount: new PublicKey("4uRFjqVU5ZKkp7hQLx3Lm3YeWFts17ER8a5HLUE18ayG") },
  "wSOL.X": { mint: X1_WSOLX_MINT, decimals: 9, feeAccount: X1_WSOLX_FEE_ACCOUNT },
};

/** The forward (Sol→X1) token map — the Solana-side SOURCE token (locked by
 *  bridge_out) and its X1-side wrapped twin (minted by the guardians). Both
 *  are native/locked on Solana (vault path), so the bridge_out account spec
 *  is the vault variant; the token program is spl-token v1 for both. */
export const X1_FORWARD_TOKENS = {
  "USDC.x": {
    sourceMint: USDC_MINT,
    destMint: X1_USDCX_MINT,
    decimals: 6,
    feeAccount: WARP_ACCOUNTS.feeCollectorAta, // 6ob9XW… (live USDC lock tx)
    minBase: 10n * ONE_USDC, // Warp's $10 floor in USDC base units
  },
  "wSOL.X": {
    sourceMint: WSOL_MINT,
    destMint: X1_WSOLX_MINT,
    decimals: 9,
    feeAccount: SOL_WSOL_FEE_ACCOUNT, // GxfLqezi… (live config)
    minBase: 100_000_000n, // config minAmount for wSOL (0.1 WSOL)
  },
};

/** Derive the per-mint vault PDA + vault token account for a NATIVE source
 *  token on the chain the bridge_out executes on (Solana). Verified: the
 *  WSOL vault PDA 9ZFmvmJk… exists on Solana mainnet and the USDC vault
 *  C6byAvMf… (WARP_ACCOUNTS.vault) is the same derivation for USDC. */
export function deriveVaultAccounts(sourceMint, tokenProgramId) {
  const enc = (s) => new TextEncoder().encode(s);
  const [vault] = PublicKey.findProgramAddressSync(
    [enc("vault"), new PublicKey(sourceMint).toBytes()], WARP_PROGRAM_ID);
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    new PublicKey(sourceMint), vault, true, tokenProgramId);
  return { vault, vaultTokenAccount };
}

// Minimum lamports an X1 fee payer needs before the reverse burn will even
// simulate. X1 is SVM-compatible: same mechanics as Solana (rent-exempt for a
// 0-byte system account + a few tx fees), so the threshold mirrors
// SOLANA_FEE_PAYER_MIN_LAMPORTS. Below this the X1 RPC rejects the tx at load
// with the bare `AccountNotFound` — preflight it so the user gets an
// actionable message instead (the mirror of assertSolanaFeePayer).
export const X1_FEE_PAYER_MIN_LAMPORTS = 1_000_000n; // 0.001 XNT

/**
 * X1FeePayerError — thrown when the user's X1 (SVM) wallet cannot pay the
 * reverse-burn tx fee (account missing on X1 mainnet, or below rent-exempt).
 * Mirrors Stage2FeePayerError for the X1 side of the round trip.
 */
export class X1FeePayerError extends Error {
  constructor(message, { pubkey = null, lamports = null } = {}) {
    super(message);
    this.name = "X1FeePayerError";
    this.pubkey = pubkey;
    this.lamports = lamports;
  }
}

// ── X1 FEE-PAYER PREFLIGHT (the reverse mirror of assertSolanaFeePayer) ──
// The X1-side bridge_out burn is an SVM tx paid by the user's X1 wallet. If
// that account is missing on X1 (a wallet that only ever received USDC.x via
// a guardian mint has NO X1 system account), the RPC rejects the tx at LOAD
// with `AccountNotFound` — the same cryptic failure the forward hop hit on
// Solana. Preflight it so the failure is actionable instead of cryptic.
export async function assertX1FeePayer(connection, userPubkey) {
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  let info = null;
  try {
    info = await connection.getAccountInfo(userPubkey);
  } catch (e) {
    throw new X1FeePayerError(
      `Could not check your X1 wallet (${userPubkey.toBase58()}) before burning: ${e?.message || e}. ` +
      `Retry when the X1 RPC is reachable.`,
      { pubkey: userPubkey.toBase58() },
    );
  }
  const lamports = info ? BigInt(info.lamports) : 0n;
  if (lamports < X1_FEE_PAYER_MIN_LAMPORTS) {
    throw new X1FeePayerError(
      `Your X1 wallet (${userPubkey.toBase58()}) has no spendable XNT on X1 mainnet ` +
      `(${Number(lamports) / 1e9} XNT) — the Warp burn needs a funded X1 account to pay the tx fee. ` +
      `Send ~0.001 XNT to that address (or connect an X1 wallet that has XNT), then retry. ` +
      `Your funds stay safe in your wallet until then.`,
      { pubkey: userPubkey.toBase58(), lamports },
    );
  }
  return { ok: true, lamports };
}

// ── X1 USDC.x BALANCE PREFLIGHT (the reverse mirror of assertX1FeePayer) ──
// The reverse burn's total debit on the user's X1 USDC.x ATA is the 1% skim
// transfer PLUS the Warp bridge_out gross amount. Warp carves its own $1
// token fee OUT of that gross (verified against mainnet burn tx 35DfdwHKB…:
// gross 11.00 → token fee 1.00 → net 10.00 — the sender was debited exactly
// 11.00). So the requirement is exactly `feeAmount + amountHuman`, and a
// shortfall makes Warp's internal Token-2022 burn CPI fail with the bare
// `custom program error: 0x1` — Token-2022 Custom(1) = InsufficientFunds
// (NOT InvalidMint, which is 2). Indistinguishable from a broken account
// list, which is exactly what the v2 armed-preview user hit. Preflight the
// balance so the failure is actionable instead of cryptic.
export const X1_USDC_DECIMALS = 6;

/**
 * X1UsdcBalanceError — thrown when the user's X1 USDC.x ATA cannot cover
 * the reverse burn's total debit (skim transfer + Warp gross). Mirrors
 * X1FeePayerError for the token-balance side of the reverse leg.
 */
export class X1UsdcBalanceError extends Error {
  constructor(message, { pubkey = null, available = null, required = null } = {}) {
    super(message);
    this.name = "X1UsdcBalanceError";
    this.pubkey = pubkey;
    this.available = available;
    this.required = required;
  }
}

export async function assertX1TokenBalance(connection, userPubkey, { mint = X1_USDCX_MINT, decimals = 6, requiredHuman, sym = "USDC.x" }) {
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const ata = getAssociatedTokenAddressSync(
    mintPk, userPubkey, true, TOKEN_2022_PROGRAM_ID,
  );
  const requiredBase = BigInt(toBaseUnits(requiredHuman, decimals));
  let available = 0n;
  try {
    const info = await connection.getAccountInfo(ata);
    if (info) {
      const bal = await connection.getTokenAccountBalance(ata);
      available = BigInt(bal?.value?.amount || 0);
    }
  } catch (e) {
    throw new X1UsdcBalanceError(
      `Could not verify your X1 ${sym} balance (${ata.toBase58()}) before burning: ${e?.message || e}. ` +
      `Retry when the X1 RPC is reachable.`, // fail-closed: cannot prove funds → do not build
      { pubkey: userPubkey.toBase58() },
    );
  }
  if (available < requiredBase) {
    const need = fromBaseUnits(requiredBase, decimals);
    const have = fromBaseUnits(available, decimals);
    throw new X1UsdcBalanceError(
      `Not enough ${sym} on X1 to bridge ${need.toFixed(2)} ${sym} — the burn needs the full amount ` +
      `(1% fee transfer + Warp gross; Warp takes its fee out of the gross). Your X1 wallet ` +
      `(${userPubkey.toBase58()}) holds ${have.toFixed(2)} ${sym}. ` +
      `Top up ${(need - have).toFixed(2)} ${sym} or send a smaller amount. Your funds are safe.`,
      { pubkey: userPubkey.toBase58(), available, required: requiredBase },
    );
  }
  return { ok: true, available, required: requiredBase };
}

export async function assertX1UsdcBalance(connection, userPubkey, requiredBase) {
  // Legacy wrapper: keeps the USDC.x-specific signature (base units) for the
  // existing callers/tests; the token-aware path goes through
  // assertX1TokenBalance (human units + per-token decimals).
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  const ata = getAssociatedTokenAddressSync(
    X1_USDCX_MINT, userPubkey, true, TOKEN_2022_PROGRAM_ID,
  );
  let available = 0n;
  try {
    const info = await connection.getAccountInfo(ata);
    if (info) {
      const bal = await connection.getTokenAccountBalance(ata);
      available = BigInt(bal?.value?.amount || 0);
    }
  } catch (e) {
    throw new X1UsdcBalanceError(
      `Could not verify your X1 USDC.x balance (${ata.toBase58()}) before burning: ${e?.message || e}. ` +
      `Retry when the X1 RPC is reachable.`, // fail-closed: cannot prove funds → do not build
      { pubkey: userPubkey.toBase58() },
    );
  }
  if (available < BigInt(requiredBase)) {
    const need = fromBaseUnits(BigInt(requiredBase));
    const have = fromBaseUnits(available);
    throw new X1UsdcBalanceError(
      `Not enough USDC.x on X1 to bridge ${need.toFixed(2)} USDC.x — the burn needs the full amount ` +
      `(1% fee transfer + Warp gross; Warp takes its $1 out of the gross). Your X1 wallet ` +
      `(${userPubkey.toBase58()}) holds ${have.toFixed(2)} USDC.x. ` +
      `Top up ${(need - have).toFixed(2)} USDC.x or send a smaller amount. Your funds are safe.`,
      { pubkey: userPubkey.toBase58(), available, required: BigInt(requiredBase) },
    );
  }
  return { ok: true, available, required: BigInt(requiredBase) };
}

// ── X1 FEE-WALLET ATA PREP — idempotent, payer = the user (reverse prep) ──
// The reverse burn prepends OUR 1% skim as a Token-2022 USDC.x transfer from
// the user's ATA to the FEE WALLET's X1 USDC.x ATA. An SPL transfer requires
// the destination ATA to EXIST — and step 1.2's root-cause note said the fee
// ATA was missing on X1 ("the route is dead at step one"). This builds the
// idempotent create (create-if-missing, no-op if present) with the USER
// paying rent (payer = user, owner = fee wallet — the ATA program allows any
// payer). runReverse BUNDLES the returned `instruction` into the burn
// transaction (create → transfer → burn in ONE tx) so the reverse leg never
// dead-ends on a missing fee ATA — the same-chain analog of the forward leg's
// separate recipient-ATA prep (ensureX1RecipientAta, different chain, so it
// stays its own tx there).
export async function ensureX1FeeWalletAta({ connection, userPubkey, feeWallet, payer = null, mint = X1_USDCX_MINT, decimals = 6 }) {
  if (!(userPubkey instanceof PublicKey)) userPubkey = new PublicKey(userPubkey);
  if (!(feeWallet instanceof PublicKey)) feeWallet = new PublicKey(feeWallet);
  if (payer && !(payer instanceof PublicKey)) payer = new PublicKey(payer);
  const payerPk = payer || userPubkey; // the connected wallet pays rent + signs
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const sym = mintPk.equals(X1_WSOLX_MINT) ? "wSOL.X" : "USDC.x";
  const ata = getAssociatedTokenAddressSync(
    mintPk, feeWallet, true, TOKEN_2022_PROGRAM_ID,
  );

  let info = null;
  try {
    info = await connection.getAccountInfo(ata);
  } catch (e) {
    throw new Error(
      `Could not check the fee wallet's X1 ${sym} account (${ata.toBase58()}): ${e?.message || e}. ` +
      `Retry when the X1 RPC is reachable.`,
    );
  }
  if (info) return { needsCreation: false, ata };

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payerPk,      // payer (rent + fee — the USER's wallet)
      ata,          // the fee wallet's token ATA to create/ensure
      feeWallet,    // owner = the fee wallet
      mintPk,       // mint (USDC.x / wSOL.X, both Token-2022)
      TOKEN_2022_PROGRAM_ID, // token program
    ),
  );
  tx.feePayer = payerPk;
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
  } catch { /* wallet may supply one */ }
  // `instruction` lets callers BUNDLE the idempotent create into the burn tx
  // (create → skim transfer → burn in one tx, one sim, one send) instead of
  // broadcasting a separate creation tx — the reverse leg's same-chain analog
  // of the forward leg's separate ATA prep (different chain, so it stays its
  // own tx there).
  return { needsCreation: true, transaction: tx, instruction: tx.instructions[0], ata };
}
// The fee account at slot 9 is a FIXED program fee account (not a derivable
// ATA) — taken verbatim from the real mainnet burn tx mMQt8Ypjed...
const X1_FEE_ACCOUNT = new PublicKey("4uRFjqVU5ZKkp7hQLx3Lm3YeWFts17ER8a5HLUE18ayG");
const CHAIN_PAIR_X1_TO_SOL = 0x10;

function deriveX1RevAccounts(mint = X1_USDCX_MINT) {
  const enc = (s) => new TextEncoder().encode(s);
  // X1-side bridge program is the SAME 6JbPTux on mainnet.
  const [config] = PublicKey.findProgramAddressSync([enc("config")], WARP_PROGRAM_ID);
  const [tokenRegistry] = PublicKey.findProgramAddressSync(
    [enc("token_registry"), new PublicKey(mint).toBytes()], WARP_PROGRAM_ID);
  return { config, tokenRegistry };
}
const _x1rev = deriveX1RevAccounts(X1_USDCX_MINT); // kept for tests/back-compat; buildReverseBurn derives per-mint now

function deriveX1RevOutgoingMsgPda(seq) {
  const sq = new Uint8Array(8);
  let v = BigInt(seq);
  for (let i = 0; i < 8; i++) { sq[i] = Number(v & 0xffn); v >>= 8n; }
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("evt_out"), sq], WARP_PROGRAM_ID);
  return pda;
}

export function encodeReverseSeq(slot, ixIndex = 0) {
  if (ixIndex < 0 || ixIndex > 999) throw new Error("ixIndex must be in [0,999]");
  const baseSeq = BigInt(slot) * 1000n + BigInt(ixIndex);
  return (BigInt(CHAIN_PAIR_X1_TO_SOL) << 56n) | baseSeq;
}

export async function buildReverseBurn({ connection, userPubkey, amountHuman, seq, mint = X1_USDCX_MINT, decimals = 6, feeAccount = X1_REVERSE_TOKENS["USDC.x"].feeAccount }) {
  const toPk = (v) => {
    if (v instanceof PublicKey) return v;
    if (typeof v === "string") return new PublicKey(v);
    if (v && typeof v.toBase58 === "function") return new PublicKey(v.toBase58());
    if (v && typeof v.toString === "function") return new PublicKey(v.toString());
    throw new Error("Cannot resolve a Solana public key from the wallet");
  };
  userPubkey = toPk(userPubkey);
  const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const feeAcctPk = feeAccount instanceof PublicKey ? feeAccount : new PublicKey(feeAccount);
  const amount = toBaseUnits(amountHuman, decimals);

  // user's token account — TOKEN-2022 ATA (USDC.x and wSOL.X are both Token-2022)
  const userTokenAta = getAssociatedTokenAddressSync(
    mintPk, userPubkey, true, TOKEN_2022_PROGRAM_ID);

  let slot;
  try { slot = await connection.getSlot("confirmed"); }
  catch { slot = await getSlotFallback(); }
  const theSeq = seq ?? encodeReverseSeq(slot, 0);
  const outgoingMsgPda = deriveX1RevOutgoingMsgPda(theSeq);
  const { config, tokenRegistry } = deriveX1RevAccounts(mintPk);

  const data = encodeBridgeOutData(theSeq, amount);

  // Account order EXACTLY from real mainnet X1->Sol burn txs (mMQt8Ypjed… for
  // USDC.x; 5rUiHoLE12L5… for wSOL.X — the same 12-account BridgeOut shape:
  // wrapped tokens get WARP in the optional vault slots 6+7, no mint_authority
  // — that PDA belongs to the RECEIVE-side bridge_in_v2, verified against the
  // current program IDL + live wSOL.X burns). Slots 8/9 are the fee collector
  // wallet + the TOKEN'S OWN fee collector ATA (4uRFjq… USDC.x / 9Tdid7tM…
  // wSOL.X from the live config).
  const keys = [
    { pubkey: config, isSigner: false, isWritable: true },              // 0 config (48Po6q)
    { pubkey: tokenRegistry, isSigner: false, isWritable: true },       // 1 token_registry (per-mint PDA)
    { pubkey: outgoingMsgPda, isSigner: false, isWritable: true },      // 2 outgoing_msg
    { pubkey: userPubkey, isSigner: true, isWritable: true },           // 3 sender
    { pubkey: userTokenAta, isSigner: false, isWritable: true },        // 4 user token acct (burn src)
    { pubkey: mintPk, isSigner: false, isWritable: true },              // 5 mint (burned)
    { pubkey: WARP_PROGRAM_ID, isSigner: false, isWritable: false },    // 6 program self
    { pubkey: WARP_PROGRAM_ID, isSigner: false, isWritable: false },    // 7 program self
    { pubkey: X1_FEE_COLLECTOR, isSigner: false, isWritable: true },    // 8 feeCollector wallet
    { pubkey: feeAcctPk, isSigner: false, isWritable: true },           // 9 fee collector ATA (per-token)
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 10 Token-2022 program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 11 system program
  ];

  const tx = new Transaction();
  tx.add(new TransactionInstruction({ programId: WARP_PROGRAM_ID, keys, data }));
  tx.feePayer = userPubkey;
  try {
    const r = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = r.blockhash;
  } catch { /* wallet supplies */ }

  return { transaction: tx, seq: theSeq, amount, outgoing_msg: outgoingMsgPda, mint: mintPk, decimals };
}

export async function runReverse({ connection, userPubkey, amountHuman, feeAmount = 0, feeWallet = null, allowLive = false, provider = null, onBuilt = () => {}, token = "USDC.x" }) {
  // The bridged X1 token drives the mint, decimals and Warp fee account:
  // USDC.x (6 dec, flat $1) or wSOL.X (9 dec, 25 bps — live Warp config).
  const tok = X1_REVERSE_TOKENS[token] || X1_REVERSE_TOKENS["USDC.x"];
  const { mint, decimals, feeAccount } = tok;
  const sym = token;

  // 0) X1 fee-payer preflight: the bare `AccountNotFound` on the X1 RPC was
  //    the fee payer missing on X1 (same failure class as the forward hop on
  //    Solana). Surface it as an actionable error BEFORE anything is built.
  await assertX1FeePayer(connection, userPubkey);

  // 0b) X1 token-balance preflight: the live v2 reverse failure
  //    (`custom program error: 0x1` = Token-2022 Custom(1) InsufficientFunds)
  //    was a balance shortfall — the burn's total debit (1% skim transfer +
  //    Warp gross, Warp's fee carved out of the gross) exceeded the user's
  //    balance, and the sim died cryptically inside Warp's burn CPI. Preflight
  //    it so the user gets an actionable message instead of a raw error code.
  //    Token-aware: wSOL.X is 9-dec (amounts + skim in wSOL.X units).
  if (feeAmount > 0 && feeWallet) {
    await assertX1TokenBalance(connection, userPubkey, {
      mint, decimals, sym,
      requiredHuman: feeAmount + amountHuman, // 1% skim transfer + Warp gross
    });
  }

  // 1) X1 fee-wallet ATA prep: our 1% skim is a Token-2022 transfer to
  //    the FEE wallet's X1 ATA — which must EXIST for the transfer to work
  //    (the step-1.2 root cause: "fee ATA missing on X1"). When it is missing
  //    we do NOT broadcast a separate creation tx anymore: the idempotent
  //    create instruction is BUNDLED into the burn transaction
  //    (create → skim transfer → burn), so ONE simulation gates ONE send and
  //    the reverse leg works on the FIRST run in both sim and live mode — no
  //    dead-end while the fee ATA is missing, no double wallet prompt. This is
  //    the same-chain analog of the forward leg's proven pattern (PR #28/#30:
  //    idempotent ATA prep then guarded send).
  let prep = null;
  if (feeAmount > 0 && feeWallet) {
    prep = await ensureX1FeeWalletAta({
      connection,
      userPubkey,
      feeWallet,
      payer: userPubkey, // the user's connected wallet pays rent + signs
      mint, decimals, // the token's own mint (wSOL.X fee wallet ATA when token="wSOL.X")
    });
  }

  const built = await buildReverseBurn({ connection, userPubkey, amountHuman, mint, decimals, feeAccount });
  
  // If a Teleporter fee is due, prepend the skim transfer (1% of the token to
  // the fee wallet). When the fee wallet's ATA doesn't exist yet, the
  // idempotent create comes FIRST so the transfer destination exists within
  // the same tx.
  if (feeAmount > 0 && feeWallet) {
    const { PublicKey } = await import("@solana/web3.js");
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const userPk = userPubkey instanceof PublicKey ? userPubkey : new PublicKey(userPubkey);
    const feeWalletPk = feeWallet instanceof PublicKey ? feeWallet : new PublicKey(feeWallet);
    
    const userTokenAta = getAssociatedTokenAddressSync(mint, userPk, true, TOKEN_2022_PROGRAM_ID);
    const feeTokenAta = getAssociatedTokenAddressSync(mint, feeWalletPk, true, TOKEN_2022_PROGRAM_ID);
    const feeAmountBase = toBaseUnits(feeAmount, decimals);
    
    // USDC.x and wSOL.X are Token-2022 mints — createTransferInstruction with
    // the Token-2022 program id (there is no separate "Token2022Program" class).
    const transferFeeIx = createTransferInstruction(
      userTokenAta, feeTokenAta, userPk, feeAmountBase, [], TOKEN_2022_PROGRAM_ID
    );
    const prepend = prep?.needsCreation
      ? [prep.instruction, transferFeeIx] // create → transfer → burn
      : [transferFeeIx];                  // transfer → burn
    built.transaction.instructions.unshift(...prepend);
  }
  
  onBuilt();
  const sim = await simulateStage2(connection, built.transaction);
  if (!sim.ok) return { stage: "simulation", success: false, sim, built, prep };
  if (!allowLive) return { stage: "simulated_ok", success: true, sim, built, sent: null, prep };
  const sig = await sendStage2ViaPhantom(connection, built.transaction, provider);
  return { stage: "sent", success: true, sim, built, signature: sig, prep };
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
//
// SAME-ORIGIN (fix/proxy-warp-poll): the poll fetches the app's OWN serverless
// proxy (/api/warp/status + /api/warp/signatures) instead of the Warp API
// directly from the browser. The live reverse flow was stuck at "Still
// awaiting the release" while server-side every burn showed status
// "executed" + destTxSig — the direct browser→Warp-API fetch was the
// non-deterministic variable (CORS/cache/browser-network) that could not be
// reproduced from the server. The proxy removes it: the poll is now a
// same-origin fetch to the app's backend, exactly like /api/lifi/quote.
// `api` is the ORIGIN-RELATIVE base ("" = same origin); kept as a param so
// tests can inject a base or a fake fetch. The completion-detection logic
// below (nested `transaction` shape, destTxSig, executed/complete/success,
// fail/terminal) is unchanged from fix/warp-poll-desttxsig (#34).
export async function pollWarpStatus(sourceSig, { api = "", from = "sol", onUpdate = () => {}, maxMs = 180000, intervalMs = 4000 } = {}) {
  const start = Date.now();
  let sawSigs = false;
  const enc = (v) => encodeURIComponent(String(v));
  while (Date.now() - start < maxMs) {
    // 1) signatures endpoint — tells us guardian quorum progress
    try {
      const sresp = await fetch(`${api}/api/warp/signatures?sig=${enc(sourceSig)}&from=${enc(from)}`);
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
      const tresp = await fetch(`${api}/api/warp/status?sig=${enc(sourceSig)}&from=${enc(from)}`);
      if (tresp.ok) {
        const tj = await tresp.json();
        onUpdate("status", tj);
        // The Warp API nests the transaction under `transaction` (with the
        // destination release sig as `destTxSig`), e.g.
        //   { transaction: { status: "executed", destTxSig: "2LsD...", ... }, signatures: [...] }
        // Some endpoints/historical shapes return the same fields at the top
        // level. Normalize BOTH shapes before reading anything.
        const t = tj.transaction && typeof tj.transaction === "object" ? tj.transaction : tj;
        const dest = t.destinationTxSignature || t.destination_tx || t.destTxSig || t.destTx;
        const final = (t.status || t.executionStatus || "").toString().toLowerCase();
        if (dest || final.includes("complete") || final.includes("executed") || final.includes("success")) {
          onUpdate("complete", { destinationTx: dest, raw: tj });
          return { ok: true, destinationTx: dest, raw: tj };
        }
        if (final.includes("fail") || final.includes("terminal") || final.includes("reject")) {
          onUpdate("failed", { raw: tj });
          return { ok: false, terminal: true, raw: tj };
        }
      } else if (tresp.status === 404) {
        // Before the relay detects the burn the status endpoint 404s — same
        // as the signatures endpoint. That is "still awaiting guardians",
        // NOT an error: keep polling (the proxy passes upstream 404s through
        // verbatim, so this branch is the normal pre-detection state).
        onUpdate("awaiting_guardians", { note: "no status yet (404 is normal)" });
      }
    } catch (e) { onUpdate("poll_error", { where: "status", msg: e.message }); }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, timedOut: true, sawSigs };
}
