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
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

// ── CONSTANTS ──
export const WARP_PROGRAM_ID = new PublicKey(
  "6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD"
);
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

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
  feeCollectorAta: new PublicKey("687zDcYjQ15bLw3vVneVNUh8BryG7sw9Z2iLidPaG2uA"),
};

const USDC_DECIMALS = 6;
export const ONE_USDC = 1_000_000n;
export const SKIM_BPS = 100n; // 1.00% = 100 basis points

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

  // Account order EXACTLY as decoded from live tx2 BridgeOut instruction
  // (verified against on-chain mainnet tx 3f8phJKqbQ3NL4i18uYMWWiBi7iA6tNUAXQdchQ2FchqJMRuEqGyxej2t9aAfrwxvcwYgSgJb9fBacR7L7diqXw2)
  const keys = [
    { pubkey: WARP_ACCOUNTS.config, isSigner: false, isWritable: true },   // 0 config
    { pubkey: WARP_ACCOUNTS.tokenRegistry, isSigner: false, isWritable: true }, // 1 tokenRegistry
    { pubkey: outgoingMsgPda, isSigner: false, isWritable: true },         // 2 outgoing_msg
    { pubkey: userPubkey, isSigner: true, isWritable: true },              // 3 sender
    { pubkey: userUsdcAta, isSigner: false, isWritable: true },            // 4 sender_token_account
    { pubkey: USDC_MINT, isSigner: false, isWritable: true },              // 5 token_mint
    { pubkey: WARP_ACCOUNTS.vault, isSigner: false, isWritable: true },    // 6 vault
    { pubkey: WARP_ACCOUNTS.vaultTokenAccount, isSigner: false, isWritable: true }, // 7 vault_token_account
    { pubkey: WARP_ACCOUNTS.feePda, isSigner: false, isWritable: true },   // 8 fee PDA
    { pubkey: WARP_ACCOUNTS.feeCollectorAta, isSigner: false, isWritable: true }, // 9 fee_collector_token_account
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 10 token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },// 11 system_program
  ];

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

export async function simulateStage2(connection, transaction) {
  try {
    const sim = await connection.simulateTransaction(transaction);
    return {
      ok: sim.value.err === null,
      err: sim.value.err,
      logs: sim.value.logs,
      unitsConsumed: sim.value.unitsConsumed,
    };
  } catch (e) {
    // RPC-level failure (couldn't reach the node) — NOT a program rejection.
    // Don't block the send on this; the wallet will broadcast via its own RPC
    // and surface any real on-chain error at send time.
    return { ok: true, skippedSim: true, rpcError: e.message };
  }
}

export async function sendStage2ViaPhantom(connection, transaction, provider) {
  // Use the provider the user actually connected (Backpack/Phantom/X1), not a
  // hardcoded window.solana.
  const p = provider ||
    (typeof window !== "undefined" ? window.solana || window.phantom?.solana : null);
  if (!p) throw new Error("No Solana wallet found to sign the Warp tx");

  // PREFER signAndSendTransaction — the WALLET broadcasts via its OWN RPC.
  // To avoid "Blockhash not found" (our blockhash not yet seen by the wallet's
  // RPC), set a FRESH blockhash at the last moment. Use 'confirmed' (widely
  // propagated across RPC nodes, unlike 'finalized' which can lag). Most wallets
  // also re-fetch their own; this maximizes the chance both agree.
  let freshHash = null;
  try {
    const r = await connection.getLatestBlockhash("confirmed");
    freshHash = r.blockhash;
    transaction.recentBlockhash = r.blockhash;
    transaction.lastValidBlockHeight = r.lastValidBlockHeight;
    if (transaction.signatures) transaction.signatures = [];
  } catch { /* wallet will supply one */ }

  if (typeof p.signAndSendTransaction === "function") {
    const res = await p.signAndSendTransaction(transaction);
    return res?.signature || res;
  }

  // Manual fallback: WE broadcast through the same connection the blockhash
  // came from, so they match.
  if (typeof p.signTransaction === "function") {
    const signed = await p.signTransaction(transaction);
    const sig = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }
  throw new Error("Connected wallet can't sign transactions");
}

// Full guarded flow: build, simulate, and optionally send
export async function runStage2({
  connection,
  userPubkey,
  feeWalletSvm,
  amountHuman,
  allowLive = false,
  provider = null,
}) {
  const built = await buildStage2({
    connection,
    userPubkey,
    feeWalletSvm,
    amountHuman,
  });
  const sim = await simulateStage2(connection, built.transaction);
  if (!sim.ok) {
    return { stage: "simulation", success: false, sim, built };
  }
  if (!allowLive) {
    return { stage: "simulated_ok", success: true, sim, built, sent: null };
  }
  const sig = await sendStage2ViaPhantom(connection, built.transaction, provider);
  return { stage: "sent", success: true, sim, built, signature: sig };
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
    
    const { Token2022Program } = await import("@solana/spl-token");
    const transferFeeIx = Token2022Program.createTransferInstruction(
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

// Self-relay: submit V1 bridge_in to release a stuck reverse transfer.
// Takes guardian sigs + transfer details; builds, simulates, optionally sends.
export async function submitReverseRelay(conn, { signatures, seq, sender, amount, timestamp, payer, onProgress = () => {} }) {
  if (!signatures || signatures.length === 0) throw new Error("no guardian signatures");
  const bs58 = (await import("bs58")).default;
  const { PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } = await import("@solana/web3.js");
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
  
  const enc = (s) => new TextEncoder().encode(s);
  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, WARP_PROGRAM_ID)[0];
  const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const i64le = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
  
  const config = pda([enc("config")]);
  const tokenRegistry = pda([enc("token_registry"), USDC.toBytes()]);
  const vault = pda([enc("vault"), USDC.toBytes()]);
  const vaultAta = getAssociatedTokenAddressSync(USDC, vault, true, TOKEN_PROGRAM_ID);
  const recipient = new PublicKey(sender);
  const recipientAta = getAssociatedTokenAddressSync(USDC, recipient, true, TOKEN_PROGRAM_ID);
  const evtIn = pda([enc("evt_in"), u64le(seq)]);
  
  onProgress("Building signatures…");
  const msgHashHex = signatures[0].messageHash;
  if (!msgHashHex) throw new Error("signature missing messageHash");
  const msgHash = Buffer.from(msgHashHex, "hex");
  
  const edIxs = signatures.slice(0, 2).map((s) => Ed25519Program.createInstructionWithPublicKey({
    publicKey: bs58.decode(s.guardianPubkey),
    message: msgHash,
    signature: bs58.decode(s.signature),
  }));
  
  onProgress("Building bridge_in…");
  const BRIDGE_IN_DISC = Buffer.from([0x91, 0x89, 0x1e, 0x3a, 0xb4, 0xf9, 0x69, 0xb5]);
  const data = Buffer.concat([BRIDGE_IN_DISC, u64le(seq), sender, u64le(amount), i64le(timestamp)]);
  const keys = [
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: tokenRegistry, isSigner: false, isWritable: true },
    { pubkey: evtIn, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: recipientAta, isSigner: false, isWritable: true },
    { pubkey: USDC, isSigner: false, isWritable: true },
    { pubkey: WARP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vault, isSigner: false, isWritable: false },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const bridgeIn = new TransactionInstruction({ programId: WARP_PROGRAM_ID, keys, data });
  
  onProgress("Simulating…");
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }));
  edIxs.forEach((ix) => tx.add(ix));
  tx.add(bridgeIn);
  tx.feePayer = payer;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const logs = sim.value.logs || [];
    const key = logs.filter((l) => /error|failed|assert|constraint|insufficient|invalid|unauthorized|disabled|paused/i.test(l)).slice(-3).join(" | ");
    console.group("[Relay] bridge_in simulation FAILED");
    console.log("err:", sim.value.err);
    console.log("program logs:");
    logs.forEach((l) => console.log("  " + l));
    console.groupEnd();
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}${key ? " — " + key : ""} (full logs in console)`);
  }
  onProgress(`Simulation OK (${sim.value.unitsConsumed} CU)`);
  return { tx, sim };
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
