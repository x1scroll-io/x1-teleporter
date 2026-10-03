// warpBridge.js — Stage 2 of the X1 on-ramp: Solana USDC -> X1 USDC.x via Warp.
//
// BUILT FROM THE FULL IDL extracted from the Warp Bridge frontend bundle
// (app.bridge.x1.xyz) + verified against two live mainnet bridge transactions.
//
// ── WHAT THIS DOES ──
//   1. Skims your 0.5% Teleporter fee (a plain SPL transfer to YOUR fee
//      wallet; the fee-model v2 cap — min(0.5%, $250) — never binds on
//      executable journeys: Warp's per-tx maxAmount caps them far below a
//      $50k route total).
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
// Signer resolution — the Warp leg signs through the wallet the user ACTUALLY
// connected via discovery, resolved from the WalletContext session layer (the
// same resolvers the React path uses). This replaces the old hardcoded
// injected-global fallback with the React-free connectedSessions seam.
import { resolveSolanaAdapter } from "./lib/wallet/sessionProviders.js";
import { getConnectedSession } from "./lib/wallet/connectedSessions.js";
// TOKEN IDENTITY (mints, decimals) reads from the canonical registry — see
// docs/TOKEN-RESOLVER.md. requireToken throws at import time if a pinned
// entry ever goes missing (loud config failure, never a silent null mint).
import { requireToken } from "./lib/tokenResolver.js";

// ── CONSTANTS ──
export const WARP_PROGRAM_ID = new PublicKey(
  "6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD"
);
export const USDC_MINT = new PublicKey(
  requireToken("USDC", "sol").address // canonical Solana USDC (tokenResolver)
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

const USDC_DECIMALS = requireToken("USDC", "sol").decimals; // 6 — canonical (tokenResolver)
export const ONE_USDC = 1_000_000n;
// 0.50% = 50 basis points (fee-model v2, 2026-09-02 — was 100bps at the old
// 1% rate). Sourced from src/lib/fees.ts (Step 1.3C) so the on-chain skim and
// every other fee read the SAME constant — if the rate ever changes there,
// this follows automatically and cannot drift.
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

/** Human-readable SOURCE symbol for a forward X1 destination token: the
 *  dotted wraps lose their suffix (USDC.x → USDC, wSOL.X → wSOL), the stock
 *  twins the Warp/engine `x` convention (SPCXx → SPCX). Used by the
 *  buildStage2 minimum message so it names the token the user actually sends. */
function forwardSourceSymbol(destToken) {
  const t = String(destToken);
  if (/\.x$/i.test(t)) return t.replace(/\.x$/i, "");
  if (/x$/.test(t)) return t.slice(0, -1);
  return t;
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

/**
 * Resolve the Solana/X1 signer for the Warp legs.
 *
 * The engine passes the sign-capable adapter it already resolved from the
 * connected WalletContext session (SignerResolver → sessionProviders.js). When
 * no explicit provider is given (legacy/direct callers), fall back to the
 * CURRENTLY CONNECTED Solana session — resolved through the SAME session layer
 * (resolveSolanaAdapter over the connectedSessions registry the WalletContext
 * publishes into). NEVER a hardcoded injected global: the bridge signs through
 * whatever wallet the user actually connected via discovery.
 *
 * @param {object} [provider] the explicit provider from the caller (preferred)
 * @returns {Promise<object|null>} a sign-capable adapter
 *   (`publicKey` + signTransaction/signAndSendTransaction), or null when no
 *   connected wallet can sign (the caller surfaces the connect-a-wallet error).
 */
async function resolveWarpSolanaSigner(provider) {
  if (provider) return provider;
  return resolveSolanaAdapter(getConnectedSession("solana"));
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
  const p = await resolveWarpSolanaSigner(provider);
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

  const fwd = resolveForwardToken(destToken);
  const { sourceMint, decimals, feeAccount, minBase } = fwd;

  const grossAll = toBaseUnits(amountHuman, decimals);
  const skimBase = (grossAll * SKIM_BPS) / 10_000n;
  const bridgeBase = grossAll - skimBase;

  if (bridgeBase < minBase) {
    // Token-aware symbol for the message (USDC.x → USDC, wSOL.X → wSOL, stock
    // twin SPCXx → SPCX) — the forward map's destToken is the X1 token.
    throw new Error(
      `After the 0.5% Teleporter skim, ${fromBaseUnits(bridgeBase, decimals)} ${forwardSourceSymbol(destToken)} is below the Warp minimum.`
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

  // 2) Our 0.5% Teleporter skim — the fee wallet's SOURCE-token ATA must exist. USDC's
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
  // Use the wallet the user actually connected via discovery — the explicit
  // provider from the engine, or the CURRENTLY CONNECTED Solana session
  // resolved through the session layer. Never an injected global.
  const p = await resolveWarpSolanaSigner(provider);
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
  const fwd = resolveForwardToken(destToken);
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
export const X1_USDCX_MINT = new PublicKey(requireToken("USDC.x", "x1").address); // X1 USDC.x — canonical (tokenResolver)
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
export const WSOL_MINT = new PublicKey(requireToken("WSOL", "sol").address); // Solana native wSOL (spl-token v1) — canonical (tokenResolver)
export const X1_WSOLX_MINT = new PublicKey(requireToken("wSOL.X", "x1").address); // X1 wrapped wSOL.X (Token-2022) — canonical (tokenResolver)

// ── ETH / ETH.X + cbBTC / cbBTC.X — the ETH + BTC rails (ground truth: the
//    SAME live Warp config https://api.bridge.mainnet.x1.xyz/config, Sep 2026) ──
// Solana-side ETH (Wormhole 7vfCX…, native vault token) + cbBTC (cbbtcf3a…,
// native vault token): BOTH 8 decimals, flat 0, percentageFeeBps 25 — exactly
// like wSOL. Their X1 twins (ETH.X / cbBTC.X) are wrapped Token-2022 mints
// with the same 8 decimals + 25 bps. Fee shapes from the live token registry
// (feeCollectorAta per token below); ZERO bridge volume on both sides as of
// the 2026-09-03 capture (config dailyVolume 0, no live burns — see the
// synthetic-labeled ETH.X golden fixture), so these entries pin the CONFIG
// fee shape, not an observed burn.
export const ETH_MINT = new PublicKey(requireToken("ETH", "sol").address); // Solana ETH (Wormhole) — 8 dec, 25bps (live config) — canonical (tokenResolver)
export const X1_ETHX_MINT = new PublicKey(requireToken("ETH.X", "x1").address); // X1 wrapped ETH.X (Token-2022) — canonical (tokenResolver)
export const CBBTC_MINT = new PublicKey(requireToken("cbBTC", "sol").address); // Solana cbBTC — 8 dec, 25bps (live config) — canonical (tokenResolver)
export const X1_CBBTCX_MINT = new PublicKey(requireToken("cbBTC.X", "x1").address); // X1 wrapped cbBTC.X (Token-2022) — canonical (tokenResolver)
// Warp fee-collector token accounts (per-token, from the live config):
export const X1_WSOLX_FEE_ACCOUNT = new PublicKey("9Tdid7tM1bKv8hMyiTDLfB2LhfCGoaBv5GoezQzW2VP9"); // X1 wSOL.X fee collector ATA
const SOL_WSOL_FEE_ACCOUNT = new PublicKey("GxfLqeziL8wrUF31H1thWVAHkqzPodoqbwZeoDTRAkyU"); // Solana wSOL fee collector ATA
export const X1_ETHX_FEE_ACCOUNT = new PublicKey("4JXWhxSyMB5fy7GDkqXqNCgA6tRWfK5qSY6gXChkHTvJ"); // X1 ETH.X fee collector ATA (live config)
export const SOL_ETH_FEE_ACCOUNT = new PublicKey("FHZFWBfhdCj7yZr75j8kTbCqWHCKvxqDiH9XPz8sH2uK"); // Solana ETH fee collector ATA (live config)
export const X1_CBBTCX_FEE_ACCOUNT = new PublicKey("7JsdSDzJskwoMFnmhbHzVrue8vwHBRNmH5LVbZBwfmDc"); // X1 cbBTC.X fee collector ATA (live config)
export const SOL_CBBTC_FEE_ACCOUNT = new PublicKey("6WFfCbyw2TRfJuGSNZp2VCtcFXqA8UngVQHs8bNaQsPD"); // Solana cbBTC fee collector ATA (live config)

// ── STOCK RAILS — SPCX / META / TSLA / COIN / PLTR / NVDA / AMD / SPY / GOOGL ──
// Ground truth: the SAME live Warp config (https://api.bridge.mainnet.x1.xyz/config,
// captured 2026-09-20 → docs/bridge-token-floor-config.json). Each Solana source
// mint (sourceMint / locked by bridge_out) has an X1 wrapped twin (destMint /
// minted by the guardians); BOTH sides are 8 decimals and charge the 25 bps pct
// Warp fee (no flat — the flat $1 is USDC.x-ONLY). The per-token fee-collector
// ATAs below come from the same config. The mints are literal here (these rails
// are pinned in tokenResolver.js; kept literal for byte-parity with the wallet
// port they were lifted from).
const STOCK_DECIMALS = 8;
export const SOL_SPCX_MINT = new PublicKey("Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8");
export const SOL_META_MINT = new PublicKey("Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu");
export const SOL_TSLA_MINT = new PublicKey("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB");
export const SOL_COIN_MINT = new PublicKey("Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu");
export const SOL_PLTR_MINT = new PublicKey("XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4");
export const SOL_NVDA_MINT = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
export const SOL_AMD_MINT = new PublicKey("XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF");
export const SOL_SPY_MINT = new PublicKey("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
export const SOL_GOOGL_MINT = new PublicKey("XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN");
export const X1_SPCXX_MINT = new PublicKey("CCqoyVud4QNCccV9EJtWEFPaC6jBaGJsaFTnyD8Ss47m");
export const X1_METAX_MINT = new PublicKey("36fxZScbKNXxAfJoiqk76egFGm5b7wWFutjJfXTU5nhT");
export const X1_TSLAX_MINT = new PublicKey("47wNUaHJyuiknQswU5qsfYKjaZ9ijueRB63ZrsxuRb4F");
export const X1_COINX_MINT = new PublicKey("44QsUuVsKVGk5A1X5Vx7MnevsNe7UTVnijfkbSi3rtpY");
export const X1_PLTRX_MINT = new PublicKey("2EPkJGy9C4CwdXFc7zpa4VxeansMRcRVdPnR52nBVZbW");
export const X1_NVDAX_MINT = new PublicKey("4JfDXUw8N7b1VJ1og1K3Nc4Z6nwtWxWJUSQKYBcdsiJz");
export const X1_AMDX_MINT = new PublicKey("7Y5bai9oWEjZMYMkHxVBUzpUXJqAcwaHi8MptdcDhKk2");
export const X1_SPYX_MINT = new PublicKey("5Z7K1BaM36ubfNHkXbiDm5GW3KGzVSt3DFxD2b7p4VtJ");
export const X1_GOOGLX_MINT = new PublicKey("E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5");
// Warp fee-collector token accounts (per-token, live config): Solana-side (lock)
export const SOL_SPCX_FEE_ACCOUNT = new PublicKey("RcyUsKGJVVUqhTCkE2qQNH39JccZGn8tjxQqeLv76XK");
export const SOL_META_FEE_ACCOUNT = new PublicKey("rxf9HBuo58vRQ5HPK6ZGmev9spRPECPhV2VZ4n6TzEk");
export const SOL_TSLA_FEE_ACCOUNT = new PublicKey("94aMjiPSitiEFU8XGRgeSZcXeRqEGFLRG2JCcdMLyLz7");
export const SOL_COIN_FEE_ACCOUNT = new PublicKey("9sXq7eNDgr5ourJupW9ok8V75qJrb77yJ2Ddfd2wpb3F");
export const SOL_PLTR_FEE_ACCOUNT = new PublicKey("HQbVeT39zncthmbNEWBkVbGjYdaEXmjR3PW2nrHLt5K1");
export const SOL_NVDA_FEE_ACCOUNT = new PublicKey("H5krn3SzGtq414Fde7KnV7EUneBpYLDQC8pU2kHBpiFT");
export const SOL_AMD_FEE_ACCOUNT = new PublicKey("HKUdcZLRKyGALchhiqKN3rzrfMUakgpnoHHrf7trWG2W");
export const SOL_SPY_FEE_ACCOUNT = new PublicKey("GpdnZWDTvCgnLdB2cH4WXFWbiScAfzRnEiUNqa2Hq27D");
export const SOL_GOOGL_FEE_ACCOUNT = new PublicKey("3cwHKotdejo4Wnc688zeu1QAMiMD8wbhRBa2coo1gBB8");
// X1-side (burn) fee-collector token accounts (per-token, live config):
export const X1_SPCXX_FEE_ACCOUNT = new PublicKey("2bwDWHU5bhm6gtmXpenHg7yGWcHELUZmVSRSHRjx285J");
export const X1_METAX_FEE_ACCOUNT = new PublicKey("Gfj5mZSSBMjYGzLte2oWrpHtpk4S7TRkeeudNL1kU6TY");
export const X1_TSLAX_FEE_ACCOUNT = new PublicKey("GC1vAXQWbokNsoSdKAaZBaPbu2nNs55ePRcedd2sGo63");
export const X1_COINX_FEE_ACCOUNT = new PublicKey("B1T1iz61rFooy9ZqDsd828VptPRuc7ykZBbeXJaf5K4e");
export const X1_PLTRX_FEE_ACCOUNT = new PublicKey("PcqXLTXLDWQ2j9Kfs4jbRDAhaYr1Yc6huFVqyA3dCFe");
export const X1_NVDAX_FEE_ACCOUNT = new PublicKey("CFPTPYANWnhBLVnb45zTRGMUKUN3naiqrMcYB5cwbki1");
export const X1_AMDX_FEE_ACCOUNT = new PublicKey("3wZ1vEP7mwU7dnQUuiWgxK2kYDCjWope9nUT2mkQivSW");
export const X1_SPYX_FEE_ACCOUNT = new PublicKey("6YgSpSMuuv6aXmXsEbjNpySTkpZv1qJ26mzhEQzY8qtB");
export const X1_GOOGLX_FEE_ACCOUNT = new PublicKey("GpbrnKinhzEh8sWfuv1MCL7vJ3qLQZHHKu8HWwbm5pd");

/** Warp's per-token fee on the X1 side (bridge_out burn) — from the LIVE
 *  Warp config token registry. FLAT $1 applies ONLY to USDC.x (1_000_000
 *  base, 6 dec — VERIFIED on-chain 2026-09-02). EVERY other token charges a
 *  percentage of the bridge gross, flat 0: wSOL.X 25 bps (verified
 *  on-chain), ETH.X + cbBTC.X 25 bps (live config, 8 dec each — no live
 *  burns yet, see the synthetic-labeled fixture). UNKNOWN/future tokens
 *  default to the SAME 25 bps pct (X1_WARP_FEE_PCT_DEFAULT) — flat $1 is
 *  USDC.x-ONLY (Mr. Esters, verified live 2026-09-02 via the official Warp
 *  UI: USDC→USDC.x flat $1; ETH/BTC/SOL/OTHER 0.25%). The program carves
 *  the fee OUT of the gross inside bridge_out (verified on-chain). */
export const X1_WARP_FEES = {
  "USDC.x": { kind: "flat", amountBase: 1_000_000n, decimals: requireToken("USDC.x", "x1").decimals },
  "wSOL.X": { kind: "pct", bps: 25, decimals: requireToken("wSOL.X", "x1").decimals },
  "ETH.X": { kind: "pct", bps: 25, decimals: requireToken("ETH.X", "x1").decimals },
  "cbBTC.X": { kind: "pct", bps: 25, decimals: requireToken("cbBTC.X", "x1").decimals },
  // Stock rails — 25 bps pct, 8 dec (live Warp config; flat $1 is USDC.x-ONLY).
  "SPCXx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  "METAx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  "TSLAx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  "COINx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  "PLTRx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  "NVDAx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  "AMDx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  "SPYx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  "GOOGLx": { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
};

/** The DEFAULT Warp fee shape for an UNKNOWN X1 token: 25 bps pct — flat $1
 *  applies ONLY to USDC.x. Never default an unknown asset to the flat. */
export const X1_WARP_FEE_PCT_DEFAULT = { kind: "pct", bps: 25, decimals: 9 };

/** Per-asset X1 Warp fee lookup — unknown tokens fall back to the 25 bps pct
 *  default (NEVER the USDC.x flat $1). The one function consumers use so the
 *  default cannot drift per call site. */
export function x1WarpFeeFor(token) {
  return X1_WARP_FEES[token] || X1_WARP_FEE_PCT_DEFAULT;
}

/** Warp's per-token fee on the SOLANA side (bridge_out lock) — same config,
 *  same rule: flat $1 for USDC ONLY; WSOL/ETH/cbBTC charge 25 bps pct;
 *  unknown tokens default to the pct (SOL_WARP_FEE_PCT_DEFAULT). */
export const SOL_WARP_FEES = {
  USDC: { kind: "flat", amountBase: 1_000_000n, decimals: requireToken("USDC", "sol").decimals },
  WSOL: { kind: "pct", bps: 25, decimals: requireToken("WSOL", "sol").decimals },
  ETH: { kind: "pct", bps: 25, decimals: requireToken("ETH", "sol").decimals },
  cbBTC: { kind: "pct", bps: 25, decimals: requireToken("cbBTC", "sol").decimals },
  // Stock rails — 25 bps pct, 8 dec (live Warp config; flat $1 is USDC-ONLY).
  SPCX: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  META: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  TSLA: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  COIN: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  PLTR: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  NVDA: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  AMD: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  SPY: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
  GOOGL: { kind: "pct", bps: 25, decimals: STOCK_DECIMALS },
};

/** The DEFAULT Warp fee shape for an UNKNOWN Solana-side token: 25 bps pct. */
export const SOL_WARP_FEE_PCT_DEFAULT = { kind: "pct", bps: 25, decimals: 8 };

/** Per-asset Solana-side Warp fee lookup — unknown tokens fall back to the
 *  25 bps pct default (NEVER the USDC flat $1). */
export function solWarpFeeFor(token) {
  return SOL_WARP_FEES[token] || SOL_WARP_FEE_PCT_DEFAULT;
}

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
  "USDC.x": { mint: X1_USDCX_MINT, decimals: requireToken("USDC.x", "x1").decimals, feeAccount: new PublicKey("4uRFjqVU5ZKkp7hQLx3Lm3YeWFts17ER8a5HLUE18ayG") },
  "wSOL.X": { mint: X1_WSOLX_MINT, decimals: requireToken("wSOL.X", "x1").decimals, feeAccount: X1_WSOLX_FEE_ACCOUNT },
  "ETH.X": { mint: X1_ETHX_MINT, decimals: requireToken("ETH.X", "x1").decimals, feeAccount: X1_ETHX_FEE_ACCOUNT }, // live config — 25bps pct fee (no live burn yet: synthetic-labeled fixture)
  "cbBTC.X": { mint: X1_CBBTCX_MINT, decimals: requireToken("cbBTC.X", "x1").decimals, feeAccount: X1_CBBTCX_FEE_ACCOUNT }, // live config — 25bps pct fee
  // Stock rails — X1 wrapped Token-2022 mints (8 dec) + per-token fee ATAs
  // from the live config (docs/bridge-token-floor-config.json, 2026-09-20).
  "SPCXx": { mint: X1_SPCXX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_SPCXX_FEE_ACCOUNT },
  "METAx": { mint: X1_METAX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_METAX_FEE_ACCOUNT },
  "TSLAx": { mint: X1_TSLAX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_TSLAX_FEE_ACCOUNT },
  "COINx": { mint: X1_COINX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_COINX_FEE_ACCOUNT },
  "PLTRx": { mint: X1_PLTRX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_PLTRX_FEE_ACCOUNT },
  "NVDAx": { mint: X1_NVDAX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_NVDAX_FEE_ACCOUNT },
  "AMDx": { mint: X1_AMDX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_AMDX_FEE_ACCOUNT },
  "SPYx": { mint: X1_SPYX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_SPYX_FEE_ACCOUNT },
  "GOOGLx": { mint: X1_GOOGLX_MINT, decimals: STOCK_DECIMALS, feeAccount: X1_GOOGLX_FEE_ACCOUNT },
};

/** The forward (Sol→X1) token map — the Solana-side SOURCE token (locked by
 *  bridge_out) and its X1-side wrapped twin (minted by the guardians). Both
 *  are native/locked on Solana (vault path), so the bridge_out account spec
 *  is the vault variant; the token program is spl-token v1 for both. */
export const X1_FORWARD_TOKENS = {
  "USDC.x": {
    sourceMint: USDC_MINT,
    destMint: X1_USDCX_MINT,
    decimals: requireToken("USDC", "sol").decimals, // source-side (Solana USDC) — canonical (tokenResolver)
    feeAccount: WARP_ACCOUNTS.feeCollectorAta, // 6ob9XW… (live USDC lock tx)
    minBase: 10n * ONE_USDC, // Warp's $10 floor in USDC base units
  },
  "wSOL.X": {
    sourceMint: WSOL_MINT,
    destMint: X1_WSOLX_MINT,
    decimals: requireToken("WSOL", "sol").decimals, // source-side (Solana WSOL) — canonical (tokenResolver)
    feeAccount: SOL_WSOL_FEE_ACCOUNT, // GxfLqezi… (live config)
    minBase: 100_000_000n, // config minAmount for wSOL (0.1 WSOL)
  },
  // Stock rails — Solana source mint (locked) → X1 wrapped twin (minted); both
  // 8-dec. minBase = the token's Warp minimum (docs/bridge-token-floor-config.json).
  "SPCXx": { sourceMint: SOL_SPCX_MINT, destMint: X1_SPCXX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_SPCX_FEE_ACCOUNT, minBase: 10_050_000n },
  "METAx": { sourceMint: SOL_META_MINT, destMint: X1_METAX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_META_FEE_ACCOUNT, minBase: 2_250_000n },
  "TSLAx": { sourceMint: SOL_TSLA_MINT, destMint: X1_TSLAX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_TSLA_FEE_ACCOUNT, minBase: 3_750_000n },
  "COINx": { sourceMint: SOL_COIN_MINT, destMint: X1_COINX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_COIN_FEE_ACCOUNT, minBase: 8_100_000n },
  "PLTRx": { sourceMint: SOL_PLTR_MINT, destMint: X1_PLTRX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_PLTR_FEE_ACCOUNT, minBase: 8_700_000n },
  "NVDAx": { sourceMint: SOL_NVDA_MINT, destMint: X1_NVDAX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_NVDA_FEE_ACCOUNT, minBase: 7_500_000n },
  "AMDx": { sourceMint: SOL_AMD_MINT, destMint: X1_AMDX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_AMD_FEE_ACCOUNT, minBase: 3_000_000n },
  "SPYx": { sourceMint: SOL_SPY_MINT, destMint: X1_SPYX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_SPY_FEE_ACCOUNT, minBase: 1_950_000n },
  "GOOGLx": { sourceMint: SOL_GOOGL_MINT, destMint: X1_GOOGLX_MINT, decimals: STOCK_DECIMALS, feeAccount: SOL_GOOGL_FEE_ACCOUNT, minBase: 4_350_000n },
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

// ── Warp fee accounting (F3) ────────────────────────────────
// Warp carves its fee OUT of the bridge gross: USDC.x/USDC a FLAT $1 (1_000_000
// at 6 dp) and every other token 25 bps (live config, verified on-chain). The
// NET amount the guardians mint (forward) / release (reverse) is what the
// following hop must be asked for — returning the GROSS over-asks the next leg.
// The xStocks (SPCXx…GOOGLx) are 25 bps pct × 8 dp, exactly like the wallet's
// rails (the flat $1 is USDC.x-ONLY).
export function warpFeeCut(base, token) {
  const b = BigInt(base ?? 0);
  const fee = x1WarpFeeResolved(token);
  return fee.kind === "flat" ? fee.amountBase : (b * BigInt(fee.bps)) / 10_000n;
}

/** NET amount minted on X1 after Warp's fee, for a forward bridge gross. */
export function warpForwardNetBase(bridgeBase, destToken = "USDC.x") {
  return BigInt(bridgeBase ?? 0) - warpFeeCut(bridgeBase, destToken);
}

/** NET amount released on Solana after Warp's fee, for a reverse burn gross. */
export function warpReverseNetBase(burnBase, token = "USDC.x") {
  return BigInt(burnBase ?? 0) - warpFeeCut(burnBase, token);
}

// ── REVERSE DESTINATION MINIMUM (F8) ────────────────────────────────────────
// The reverse off-ramp BURNS on X1 and the guardians RELEASE the NET on the
// DESTINATION chain. The destination's token registry enforces a MINIMUM on
// that release: a net below it reverts BridgeInV2 `BelowMinimum(6000)` —
// forever. The live dust re-check burned gross 10.058455 → $1 Warp fee → net
// 9.058455 on X1 and the Solana USDC release could NEVER land (~$9.06
// stranded). So the reverse must check the DESTINATION floor against the NET
// (burn − Warp fee) BEFORE it burns — see planReverseRelease / runReverse.
// Values are in the SOURCE token's decimals (USDC.x 6≈USDC 6, wSOL.X 9≈WSOL 9;
// the xStocks 8≈8). Each value is the 1.5× UX floor (floorBase in
// docs/bridge-token-floor-config.json = 1.5 × the destination's Warp minAmount),
// NOT Warp's raw min — so a reverse whose NET lands just under the raw min is
// refused with headroom instead of reverting FOREVER. USDC.x: 1.5 × $10 = $15;
// wSOL.X: 1.5 × 0.1 = 0.15.
export const X1_REVERSE_DEST_MIN = {
  // Solana token-registry minAmount = $10 → 1.5× UX floor $15.
  "USDC.x": 15n * ONE_USDC,
  // Solana WSOL config minAmount = 0.1 → 1.5× UX floor 0.15 WSOL.
  "wSOL.X": 150_000_000n,
  // ETH.X / cbBTC.X: 1.5× the live config min (8 dec).
  "ETH.X": 600_000n,
  "cbBTC.X": 18_750n,
  // Stock rails: 1.5× the live config min (8 dec).
  "SPCXx": 10_050_000n,
  "METAx": 2_250_000n,
  "TSLAx": 3_750_000n,
  "COINx": 8_100_000n,
  "PLTRx": 8_700_000n,
  "NVDAx": 7_500_000n,
  "AMDx": 3_000_000n,
  "SPYx": 1_950_000n,
  "GOOGLx": 4_350_000n,
};

/**
 * planReverseRelease — PURE. Given the reverse BURN (the Warp bridge gross the
 * program debits on X1), compute the NET the guardians will RELEASE on the
 * destination chain and check it clears the DESTINATION-side minimum.
 *
 * Accepts the burn directly (`burnBase` / `burnHuman`) OR the user's off-ramp
 * amount (`grossHuman`, which the wallet first skims SKIM_BPS off) — the SAME
 * math runReverse/reverseX1Stage use, so the check cannot drift from the burn.
 *
 * Returns `ok:false` (with a clear, user-facing `reason`) when the net cannot
 * be released — so the caller REFUSES BEFORE burning and never strands funds
 * (F8). `ok:true` when the net clears the floor.
 *
 * @returns {{ok:boolean, token:string, decimals:number, burnBase:bigint,
 *   feeBase:bigint, netBase:bigint, destMinBase:bigint,
 *   requiredBurnBase:bigint, reason:string|null}}
 */
export function planReverseRelease({ burnBase, burnHuman, grossHuman, token = "USDC.x", destMinBase } = {}) {
  const tok = resolveReverseToken(token);
  const decimals = tok.decimals;
  let burn;
  if (burnBase != null) burn = BigInt(burnBase);
  else if (burnHuman != null) burn = toBaseUnits(burnHuman, decimals);
  else if (grossHuman != null) {
    const skim = (Number(grossHuman) * Number(SKIM_BPS)) / 10_000;
    burn = toBaseUnits(Number(grossHuman) - skim, decimals);
  } else burn = 0n;

  const fee = warpFeeCut(burn, token);
  const net = burn - fee;
  const min = resolveReverseDestMin(token, destMinBase);
  const ok = net >= min;
  const requiredBurn = min + fee;
  const sym = String(token).replace(/\.x$/i, "");
  const reason = ok
    ? null
    : `amount below destination minimum after fee — need ≥ ${fromBaseUnits(requiredBurn, decimals)} ${sym} ` +
      `(net ${fromBaseUnits(net, decimals)} < destination min ${fromBaseUnits(min, decimals)}); ` +
      `nothing was burned`;
  return {
    ok, token, decimals,
    burnBase: burn, feeBase: fee, netBase: net,
    destMinBase: min, requiredBurnBase: requiredBurn, reason,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  DYNAMIC TOKEN DISCOVERY + LANE HEALTH (live Warp config)
//
//  The hardcoded maps above are the KNOWN BASELINE (verified on-chain). The
//  Warp operator (Jack/XDEX) adds tokens to the bridge over time — the LIVE
//  config (api.bridge.mainnet.x1.xyz/config) is the source of NEW rails. We
//  merge discovered tokens into the offerable set (NEVER replacing a known
//  entry) and gate EVERYTHING on lane health (chain-level + per-token pause).
//
//  FAIL-CLOSED CONTRACT (absolute):
//    * A discovered token is offered ONLY when the live registry yields a
//      COMPLETE rail — both mints, matching decimals, BOTH fee-collector ATAs,
//      a positive minAmount, and a readable fee shape. Anything missing or
//      ambiguous is SKIPPED (with a recorded reason), never guessed.
//    * A token/lane the config reports `paused` is DROPPED from the offer.
//    * If the config is unreachable the KNOWN baseline stays (we never invent
//      data and never fall back to a wrong token); discovered rails simply do
//      not appear until the registry can attest them.
// ════════════════════════════════════════════════════════════════════════════

/** Owner-excluded base symbols (docs/bridge-token-floor-config.json) — never
 *  offered even if the live registry carries them. */
export const WARP_LANE_EXCLUDE = Object.freeze(["xencat", "dgn", "xnt", "wxnt"]);
/** Our UX floor = 1.5× the Warp per-token minAmount (docs/bridge-token-floor-config.json). */
export const WARP_FLOOR_MULTIPLIER = 1.5;

/** The base symbol behind a rail key (USDC.x → USDC, wSOL.X → wSOL, SPCXx →
 *  SPCX, AAPLx → AAPL) — the key the live config indexes tokens by. */
export function railBaseSymbol(key) {
  return String(key).replace(/\.x$/i, "").replace(/x$/, "");
}

/** WarpTokenError — thrown by the resolvers when a symbol is absent from BOTH
 *  the known baseline and the discovered overlay. A LOUD, fail-closed error —
 *  NEVER a silent USDC.x fallback (which would burn the wrong token). */
export class WarpTokenError extends Error {
  constructor(message, { symbol = null } = {}) {
    super(message);
    this.name = "WarpTokenError";
    this.symbol = symbol;
  }
}

// The runtime overlay of LIVE-discovered rails (empty until registerDiscoveredRails).
// Kept module-level so the executor's resolution + the form's offer list read
// the SAME source. Never mutates the frozen-by-convention known maps above.
let WARP_DISCOVERED = {
  ok: false, fetchedAt: null, error: null,
  forward: {}, reverse: {}, destMin: {}, x1Fees: {}, solFees: {},
  tokens: [], skipped: [], pausedSymbols: new Set(),
  chainPaused: false, lanes: { solana: null, x1: null },
};

/** Per-asset X1 Warp fee: discovered rails first, then the known baseline,
 *  then the pct default. NEVER the flat $1 for an unknown asset. */
export function x1WarpFeeResolved(token) {
  return WARP_DISCOVERED.x1Fees[token] || X1_WARP_FEES[token] || X1_WARP_FEE_PCT_DEFAULT;
}

/** Per-asset Solana-side Warp fee (same precedence as above). */
export function solWarpFeeResolved(token) {
  return WARP_DISCOVERED.solFees[token] || SOL_WARP_FEES[token] || SOL_WARP_FEE_PCT_DEFAULT;
}

const _mintAddr = (t) => (typeof t?.mint === "string" && t.mint.length >= 32 ? t.mint : null);
const _ata = (t) => (typeof t?.feeCollectorAta === "string" && t.feeCollectorAta.length >= 32 ? t.feeCollectorAta : null);
const _big = (v) => { try { if (v == null || v === "") return null; return BigInt(v); } catch { return null; } };

/** Read a token's Warp fee shape from its config row. Fail-closed: a row with
 *  neither a positive flat nor a numeric bps returns null (→ the pair is
 *  skipped rather than charged a guessed fee). */
function _feeShapeFromToken(t) {
  const flat = _big(t?.flatFeeAmount);
  if (flat != null && flat > 0n) return { kind: "flat", amountBase: flat };
  const bps = Number(t?.percentageFeeBps);
  if (Number.isFinite(bps) && bps >= 0) return { kind: "pct", bps };
  return null;
}

/** Validate + normalize the live Warp /config into per-side objects. Pure.
 *  Never throws; ok:false when the shape is unusable. */
export function parseWarpConfig(config) {
  const sides = {};
  for (const side of ["solana", "x1"]) {
    const s = config?.[side];
    if (!s || !Array.isArray(s.tokens)) return { ok: false, error: `config.${side}.tokens[] missing` };
    sides[side] = {
      paused: s.config?.paused === true,
      pauseReason: s.config?.pauseReason ?? null,
      tokens: s.tokens,
    };
  }
  return { ok: true, solana: sides.solana, x1: sides.x1 };
}

/**
 * deriveDiscoveredRails — PURE. Given a parsed config, compute the rails that
 * are NEW (absent from the known baseline) and COMPLETE. Pairs the Solana and
 * X1 token lists by base symbol; emits a rail only when BOTH sides carry a
 * valid mint, equal decimals, a fee-collector ATA and a positive minAmount,
 * the pair is not owner-excluded, and neither the lane nor the token is paused.
 * Already-known rails (matched by source/X1 mint) are left to the baseline.
 *
 * @returns {{ok:boolean, forward:Object, reverse:Object, destMin:Object,
 *   x1Fees:Object, solFees:Object, tokens:string[], skipped:Array<{symbol,reason}>,
 *   pausedSymbols:Set<string>, chainPaused:boolean, lanes:Object, error?:string}}
 */
export function deriveDiscoveredRails(parsed, {
  exclude = WARP_LANE_EXCLUDE,
  floorMultiplier = WARP_FLOOR_MULTIPLIER,
  knownForward = X1_FORWARD_TOKENS,
  knownReverse = X1_REVERSE_TOKENS,
} = {}) {
  const empty = {
    ok: false, forward: {}, reverse: {}, destMin: {}, x1Fees: {}, solFees: {},
    tokens: [], skipped: [], pausedSymbols: new Set(), chainPaused: false,
    lanes: { solana: null, x1: null },
  };
  if (!parsed?.ok) return { ...empty, error: parsed?.error || "no config" };

  const lanes = {
    solana: { paused: parsed.solana.paused === true, reason: parsed.solana.pauseReason ?? null },
    x1: { paused: parsed.x1.paused === true, reason: parsed.x1.pauseReason ?? null },
  };
  const chainPaused = lanes.solana.paused || lanes.x1.paused;
  const excl = new Set(exclude.map((s) => String(s).toLowerCase()));
  const knownSrc = new Set(Object.values(knownForward).map((f) => f.sourceMint.toBase58()));
  const knownMint = new Set(Object.values(knownReverse).map((r) => r.mint.toBase58()));

  const bySym = (list) => {
    const m = new Map();
    for (const t of list) if (t && typeof t.symbol === "string") m.set(String(t.symbol).toLowerCase(), t);
    return m;
  };
  const solBy = bySym(parsed.solana.tokens);
  const x1By = bySym(parsed.x1.tokens);

  const pausedSymbols = new Set();
  for (const [sym, st] of solBy) if (st.paused === true) pausedSymbols.add(sym);
  for (const [sym, xt] of x1By) if (xt.paused === true) pausedSymbols.add(sym);

  const forward = {}, reverse = {}, destMin = {}, x1Fees = {}, solFees = {}, tokens = [], skipped = [];
  const mult = BigInt(Math.round(floorMultiplier * 1000)); // 1.5 → 1500 → ×min/1000

  for (const [sym, st] of solBy) {
    const xt = x1By.get(sym);
    if (!xt) { skipped.push({ symbol: st?.symbol || sym, reason: "no matching X1 twin in config" }); continue; }
    if (excl.has(sym)) { skipped.push({ symbol: st.symbol, reason: "owner-excluded" }); continue; }
    const solMint = _mintAddr(st), x1Mint = _mintAddr(xt);
    if (!solMint || !x1Mint) { skipped.push({ symbol: st.symbol, reason: "missing mint" }); continue; }
    if (knownSrc.has(solMint) || knownMint.has(x1Mint)) continue; // baseline wins — not "new"
    if (chainPaused) { skipped.push({ symbol: st.symbol, reason: "warp lane paused" }); continue; }
    if (st.paused === true || xt.paused === true) { skipped.push({ symbol: st.symbol, reason: "token paused on the lane" }); continue; }
    const solDec = Number(st.decimals), x1Dec = Number(xt.decimals);
    if (!Number.isInteger(solDec) || solDec < 0 || !Number.isInteger(x1Dec) || x1Dec < 0) { skipped.push({ symbol: st.symbol, reason: "invalid decimals" }); continue; }
    if (solDec !== x1Dec) { skipped.push({ symbol: st.symbol, reason: `decimals mismatch (${solDec} vs ${x1Dec})` }); continue; }
    const solFeeAta = _ata(st), x1FeeAta = _ata(xt);
    if (!solFeeAta || !x1FeeAta) { skipped.push({ symbol: st.symbol, reason: "missing fee-collector ATA" }); continue; }
    const min = _big(st.minAmount);
    if (min == null || min <= 0n) { skipped.push({ symbol: st.symbol, reason: "missing/zero minAmount" }); continue; }
    const solFee = _feeShapeFromToken(st), x1Fee = _feeShapeFromToken(xt);
    if (!solFee || !x1Fee) { skipped.push({ symbol: st.symbol, reason: "unreadable fee shape" }); continue; }
    const floorBase = (min * mult) / 1000n;
    const key = (typeof st.displaySymbol === "string" && st.displaySymbol) ? st.displaySymbol : st.symbol;
    forward[key] = { sourceMint: new PublicKey(solMint), destMint: new PublicKey(x1Mint), decimals: solDec, feeAccount: new PublicKey(solFeeAta), minBase: floorBase };
    reverse[key] = { mint: new PublicKey(x1Mint), decimals: solDec, feeAccount: new PublicKey(x1FeeAta) };
    destMin[key] = floorBase;
    x1Fees[key] = x1Fee;
    solFees[key] = solFee;
    // Also index by base symbol so warpFeeCut(base) resolves for either form.
    x1Fees[railBaseSymbol(key)] = x1Fee;
    solFees[railBaseSymbol(key)] = solFee;
    tokens.push(key);
  }
  tokens.sort();
  return { ok: true, forward, reverse, destMin, x1Fees, solFees, tokens, skipped, pausedSymbols, chainPaused, lanes };
}

/**
 * fetchWarpRegistry — read + parse + derive the live Warp registry. NEVER
 * throws (returns ok:false on any failure) so callers stay fail-closed.
 * The fetch is injectable for tests.
 */
export async function fetchWarpRegistry(api = WARP_API.mainnet, { fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) return { ok: false, error: "no fetch implementation available" };
  try {
    const resp = await f(`${api}/config`);
    if (!resp || !resp.ok) return { ok: false, error: `HTTP ${resp?.status ?? "?"}` };
    const config = await resp.json();
    const parsed = parseWarpConfig(config);
    if (!parsed.ok) return { ok: false, error: `config shape: ${parsed.error}`, raw: config };
    const rails = deriveDiscoveredRails(parsed);
    return { ...rails, raw: config };
  } catch (e) {
    return { ok: false, error: e?.message || "registry fetch failed" };
  }
}

/** Install (or clear) the discovered-rails overlay. A failed/unavailable
 *  registry CLEARS any previously-discovered rails (fail-closed: stale rails
 *  are never offered) while leaving the known baseline untouched. */
export function registerDiscoveredRails(rails, { fetchedAt = Date.now() } = {}) {
  if (!rails || rails.ok !== true) {
    WARP_DISCOVERED = {
      ok: false, fetchedAt, error: rails?.error || "registry unavailable",
      forward: {}, reverse: {}, destMin: {}, x1Fees: {}, solFees: {},
      tokens: [], skipped: rails?.skipped || [], pausedSymbols: new Set(),
      chainPaused: false, lanes: rails?.lanes || { solana: null, x1: null },
    };
    return WARP_DISCOVERED;
  }
  WARP_DISCOVERED = {
    ok: true, fetchedAt, error: null,
    forward: rails.forward || {}, reverse: rails.reverse || {}, destMin: rails.destMin || {},
    x1Fees: rails.x1Fees || {}, solFees: rails.solFees || {},
    tokens: Array.isArray(rails.tokens) ? rails.tokens : [], skipped: rails.skipped || [],
    pausedSymbols: rails.pausedSymbols instanceof Set ? rails.pausedSymbols : new Set(),
    chainPaused: rails.chainPaused === true, lanes: rails.lanes || { solana: null, x1: null },
  };
  return WARP_DISCOVERED;
}

/** Reset the overlay (baseline-only). Exported for tests + session teardown. */
export function clearDiscoveredRails() {
  WARP_DISCOVERED = {
    ok: false, fetchedAt: null, error: null,
    forward: {}, reverse: {}, destMin: {}, x1Fees: {}, solFees: {},
    tokens: [], skipped: [], pausedSymbols: new Set(),
    chainPaused: false, lanes: { solana: null, x1: null },
  };
  return WARP_DISCOVERED;
}

/** The current overlay (read-only view). */
export function getDiscoveredRails() { return WARP_DISCOVERED; }

/** Lane-health snapshot for the UI: whether the chain lane is paused, which
 *  base symbols are paused, and whether the registry answered at all. */
export function warpRailHealth() {
  return {
    ok: WARP_DISCOVERED.ok === true,
    chainPaused: WARP_DISCOVERED.chainPaused === true,
    pausedSymbols: WARP_DISCOVERED.pausedSymbols instanceof Set ? WARP_DISCOVERED.pausedSymbols : new Set(),
    lanes: WARP_DISCOVERED.lanes,
    error: WARP_DISCOVERED.error || null,
  };
}

/**
 * offerableWarpTokenKeys — the FINAL offer list: the registry-backed baseline
 * keys the caller passes (already intersected with the executor rails) UNION
 * the discovered rails, MINUS anything paused, and EMPTY when the whole lane is
 * paused (fail-closed: a closed lane surfaces no route).
 */
export function offerableWarpTokenKeys(knownKeys = []) {
  const h = warpRailHealth();
  if (h.chainPaused) return [];
  const isOpen = (k) => !h.pausedSymbols.has(railBaseSymbol(k).toLowerCase());
  const known = knownKeys.filter(isOpen);
  const extra = WARP_DISCOVERED.tokens.filter((k) => isOpen(k) && !known.includes(k));
  return [...known, ...extra];
}

/** resolveForwardToken — the executor's forward rail lookup: known baseline
 *  first, then the discovered overlay. THROWS WarpTokenError when unknown
 *  (fail-closed — never a silent wrong-token fallback). */
export function resolveForwardToken(symbol) {
  const known = X1_FORWARD_TOKENS[symbol];
  if (known) return known;
  const disc = WARP_DISCOVERED.forward[symbol];
  if (disc) return disc;
  throw new WarpTokenError(`unknown forward token "${symbol}" — not in the baseline rails or the live Warp registry`, { symbol });
}

/** resolveReverseToken — the executor's reverse rail lookup (known ∪ discovered).
 *  THROWS WarpTokenError when unknown (fail-closed). */
export function resolveReverseToken(symbol) {
  const known = X1_REVERSE_TOKENS[symbol];
  if (known) return known;
  const disc = WARP_DISCOVERED.reverse[symbol];
  if (disc) return disc;
  throw new WarpTokenError(`unknown reverse token "${symbol}" — not in the baseline rails or the live Warp registry`, { symbol });
}

/** resolveReverseDestMin — the reverse destination floor (known ∪ discovered),
 *  with an explicit override winning. Returns 0n when neither source has one
 *  (the gate is then a no-op — same fail-open shape as the baseline default). */
export function resolveReverseDestMin(symbol, override) {
  if (override != null) return BigInt(override);
  return WARP_DISCOVERED.destMin[symbol] ?? X1_REVERSE_DEST_MIN[symbol] ?? 0n;
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
// The reverse burn's total debit on the user's X1 USDC.x ATA is the 0.5% skim
// transfer PLUS the Warp bridge_out gross amount. Warp carves its own $1
// token fee OUT of that gross (verified against mainnet burn tx 35DfdwHKB…:
// gross 11.00 → token fee 1.00 → net 10.00 — the sender was debited exactly
// 11.00). So the requirement is exactly `feeAmount + amountHuman`, and a
// shortfall makes Warp's internal Token-2022 burn CPI fail with the bare
// `custom program error: 0x1` — Token-2022 Custom(1) = InsufficientFunds
// (NOT InvalidMint, which is 2). Indistinguishable from a broken account
// list, which is exactly what the v2 armed-preview user hit. Preflight the
// balance so the failure is actionable instead of cryptic.
export const X1_USDC_DECIMALS = requireToken("USDC.x", "x1").decimals; // 6 — canonical (tokenResolver)

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
      `(0.5% fee transfer + Warp gross; Warp takes its fee out of the gross). Your X1 wallet ` +
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
      `(0.5% fee transfer + Warp gross; Warp takes its $1 out of the gross). Your X1 wallet ` +
      `(${userPubkey.toBase58()}) holds ${have.toFixed(2)} USDC.x. ` +
      `Top up ${(need - have).toFixed(2)} USDC.x or send a smaller amount. Your funds are safe.`,
      { pubkey: userPubkey.toBase58(), available, required: BigInt(requiredBase) },
    );
  }
  return { ok: true, available, required: BigInt(requiredBase) };
}

// ── X1 FEE-WALLET ATA PREP — idempotent, payer = the user (reverse prep) ──
// The reverse burn prepends OUR 0.5% skim as a Token-2022 USDC.x transfer from
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

/**
 * Build the full reverse burn tx — the construction half of runReverse,
 * extracted so the routing engine's x1-burn leg and the reference path share
 * ONE code path (wrap, don't rewrite): X1 fee-wallet ATA prep (bundled
 * idempotent create when missing) + the Warp bridge_out burn + the prepended
 * 0.5% skim transfer (create → transfer → burn in ONE tx when the fee ATA is
 * missing; transfer → burn when it exists).
 *
 * PREFLIGHTS ARE NOT PART OF THIS HELPER — runReverse (and the engine's
 * stage runner) run assertX1FeePayer + assertX1TokenBalance BEFORE calling
 * it, exactly like the reference order.
 *
 * @param {{connection: object, userPubkey: PublicKey|string,
 *          amountHuman: number, feeAmount?: number, feeWallet?: PublicKey|string,
 *          token?: "USDC.x"|"wSOL.X", seq?: bigint|number}} args
 *   amountHuman = the BURN amount (gross − skim — bridge_out burns the net;
 *   the caller computes the 0.5% skim from the gross and passes it as
 *   feeAmount). token drives the mint/decimals/fee account (wSOL.X: 9-dec,
 *   25bps, per-token fee ATA — the token-aware path).
 * @returns {Promise<{built: object, prep: object|null, mint: PublicKey,
 *            decimals: number, feeAccount: PublicKey, sym: string}>}
 *   built = the buildReverseBurn result with the skim transfer (+ create)
 *   prepended to built.transaction; prep = the ensureX1FeeWalletAta result
 *   (null when no fee is due).
 */
export async function buildReverseBurnWithSkim({ connection, userPubkey, amountHuman, feeAmount = 0, feeWallet = null, token = "USDC.x", seq }) {
  // The bridged X1 token drives the mint, decimals and Warp fee account:
  // USDC.x (6 dec, flat $1) or wSOL.X (9 dec, 25 bps — live Warp config).
  const tok = resolveReverseToken(token);
  const { mint, decimals, feeAccount } = tok;

  // 1) X1 fee-wallet ATA prep: our 0.5% skim is a Token-2022 transfer to
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

  const built = await buildReverseBurn({ connection, userPubkey, amountHuman, mint, decimals, feeAccount, seq });

  // If a Teleporter fee is due, prepend the skim transfer (0.5% of the token to
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

  return { built, prep, mint, decimals, feeAccount, sym: token };
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
  const sym = token;
  const { mint, decimals } = resolveReverseToken(token);

  // 0) DESTINATION-MINIMUM PREFLIGHT (F8) — MUST run before anything is built
  //    or burned. `amountHuman` is the Warp BURN (gross); the guardians RELEASE
  //    `net = burn − Warp fee` on the destination chain, which enforces a
  //    minimum. A net below it reverts BridgeInV2 BelowMinimum(6000) FOREVER,
  //    so refuse CLEANLY here: nothing is signed, nothing is burned, no funds
  //    are stranded. (The live dust pass burned ~$10.06 and stranded ~$9.06.)
  const plan = planReverseRelease({ burnHuman: amountHuman, token });
  if (!plan.ok) {
    return { stage: "destination-minimum", success: false, reason: plan.reason, plan, built: null, prep: null };
  }

  // 0a) X1 fee-payer preflight: the bare `AccountNotFound` on the X1 RPC was
  //    the fee payer missing on X1 (same failure class as the forward hop on
  //    Solana). Surface it as an actionable error BEFORE anything is built.
  await assertX1FeePayer(connection, userPubkey);

  // 0b) X1 token-balance preflight: the live v2 reverse failure
  //    (`custom program error: 0x1` = Token-2022 Custom(1) InsufficientFunds)
  //    was a balance shortfall — the burn's total debit (0.5% skim transfer +
  //    Warp gross, Warp's fee carved out of the gross) exceeded the user's
  //    balance, and the sim died cryptically inside Warp's burn CPI. Preflight
  //    it so the user gets an actionable message instead of a raw error code.
  //    Token-aware: wSOL.X is 9-dec (amounts + skim in wSOL.X units).
  if (feeAmount > 0 && feeWallet) {
    await assertX1TokenBalance(connection, userPubkey, {
      mint, decimals, sym,
      requiredHuman: feeAmount + amountHuman, // 0.5% skim transfer + Warp gross
    });
  }

  // 1) The construction — fee-wallet ATA prep + bridge_out burn + the
  //    prepended 0.5% skim transfer — via the SHARED helper (the engine's
  //    x1-burn leg uses the SAME code path: one construction, both callers).
  const { built, prep } = await buildReverseBurnWithSkim({
    connection, userPubkey, amountHuman, feeAmount, feeWallet, token,
  });

  onBuilt();
  const sim = await simulateStage2(connection, built.transaction);
  if (!sim.ok) return { stage: "simulation", success: false, sim, built, prep, plan, destMinBase: plan.destMinBase };
  // F3: the NET released amount = burn gross − Warp's fee (flat $1 USDC.x / 25 bps).
  const netBase = warpReverseNetBase(built.amount, token);
  if (!allowLive) return { stage: "simulated_ok", success: true, sim, built, sent: null, prep, netBase, grossBase: built.amount, destMinBase: plan.destMinBase };
  const sig = await sendStage2ViaPhantom(connection, built.transaction, provider);
  return { stage: "sent", success: true, sim, built, signature: sig, prep, netBase, grossBase: built.amount, destMinBase: plan.destMinBase };
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
// fail/terminal) is unchanged from fix/warp-poll-desttxsig (#34), EXTENDED to
// distinguish a PERMANENT failure (a terminal status, or an explicit error in
// the payload — e.g. the release's `BelowMinimum(6000)` revert) from a release
// that is merely still PENDING (the timedOut return, funds safe).
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
        // Permanent-failure detection (runs BEFORE the completion check so a
        // failed release that still carries a stale status can never be read
        // as complete). The release reverts BridgeInV2 `BelowMinimum(6000)`
        // when the net (burn − Warp fee) lands under the destination token
        // minimum — a FOREVER failure the reverse must never wait on. Read
        // the explicit error fields on both the nested and top-level shapes.
        const errText = [t.error, t.errorCode, t.err, t.reason, tj.error, tj.errorCode, tj.reason, tj.message]
          .filter((v) => v !== undefined && v !== null && String(v) !== "" && String(v).toLowerCase() !== "null")
          .join(" ")
          .toLowerCase();
        const belowMinimum = /belowminimum|below[_ -]?minimum/.test(errText) || /(^|\D)6000(\D|$)/.test(errText);
        const failedFinal = final.includes("fail") || final.includes("terminal") || final.includes("reject");
        if (belowMinimum || failedFinal || /belowminimum|below[_ -]?minimum/.test(final)) {
          const reason = belowMinimum
            ? "the release reverted BelowMinimum (net below the destination minimum)"
            : (errText || final || "the Warp bridge reported a terminal failure");
          onUpdate("failed", { raw: tj, reason, permanent: true });
          return { ok: false, terminal: true, permanent: true, reason, raw: tj };
        }
        if (dest || final.includes("complete") || final.includes("executed") || final.includes("success")) {
          onUpdate("complete", { destinationTx: dest, raw: tj });
          return { ok: true, destinationTx: dest, raw: tj };
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
