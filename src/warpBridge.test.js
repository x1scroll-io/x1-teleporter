/**
 * Integration tests for the Step 1.3A simulation gate on the Warp Bridge
 * Stage-2 send path (src/warpBridge.js). Runs under node --test.
 *
 * The runbook guarantee, applied to the REAL send path:
 *   - simulateStage2 is FAIL-CLOSED: a program rejection OR an RPC-level
 *     simulation failure blocks the send (previously an RPC failure was
 *     advisory and skipped the gate).
 *   - sendStage2ViaPhantom simulates the EXACT transaction (with the fresh
 *     blockhash it is about to broadcast) BEFORE calling the wallet's
 *     signAndSendTransaction — on a failed simulation the wallet is never
 *     prompted and nothing is broadcast.
 *
 * Mocks only — no real chain, no real wallet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction, PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import {
  simulateStage2,
  sendStage2ViaPhantom,
  sendX1AtaCreation,
  buildStage2,
  runStage2,
  ensureX1RecipientAta,
  assertSolanaFeePayer,
  deriveX1UsdcxAta,
  Stage2FeePayerError,
  SKIM_BPS,
  WARP_BRIDGE_OUT_ACCOUNTS_SPEC,
  WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC,
  X1_USDCX_MINT,
  WARP_ACCOUNTS,
  WARP_PROGRAM_ID,
  USDC_MINT,
  pollWarpStatus,
  X1_WSOLX_MINT,
  WSOL_MINT,
  X1_WSOLX_FEE_ACCOUNT,
  X1_REVERSE_TOKENS,
  X1_FORWARD_TOKENS,
  toBaseUnits,
  fromBaseUnits,
  deriveVaultAccounts,
} from "./warpBridge.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SimulationError } from "./lib/simulateTx.js";
import { FEE_RATES } from "./lib/fees.ts";

// Real keypairs so the mock wallet can produce VALID signatures (web3.js
// serialize() verifies ed25519 signatures by default).
const K1 = Keypair.generate();
const K2 = Keypair.generate();

function makeLegacyTx() {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: K1.publicKey,
      toPubkey: K2.publicKey,
      lamports: 1,
    }),
  );
  tx.feePayer = K1.publicKey;
  tx.recentBlockhash = "11111111111111111111111111111111";
  return tx;
}

function mockConnection({ simResult, simError } = {}) {
  const calls = [];
  const connection = {
    calls,
    async getLatestBlockhash() {
      calls.push("getLatestBlockhash");
      return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 };
    },
    async simulateTransaction(tx) {
      calls.push("simulateTransaction");
      if (simError) throw simError;
      return simResult;
    },
    async sendRawTransaction() {
      calls.push("sendRawTransaction");
      return "raw-sig";
    },
    async confirmTransaction() {
      calls.push("confirmTransaction");
      return { value: { err: null } };
    },
  };
  return connection;
}

function mockWallet({ signAndSend = true, keypairs = [] } = {}) {
  const calls = [];
  const wallet = {
    calls,
    async signAndSendTransaction(tx) {
      calls.push({ method: "signAndSendTransaction", tx });
      return { signature: "wallet-sig" };
    },
    async signTransaction(tx) {
      calls.push({ method: "signTransaction", tx });
      // Real wallets return the tx with valid signatures attached.
      if (keypairs.length > 0) tx.partialSign(...keypairs);
      return tx;
    },
  };
  return wallet;
}

test("simulateStage2 is FAIL-CLOSED: a program rejection blocks", async () => {
  const conn = mockConnection({ simResult: { value: { err: { InstructionError: [0, "Custom"] }, logs: [] } } });
  const res = await simulateStage2(conn, makeLegacyTx());
  assert.equal(res.ok, false);
  assert.deepEqual(res.err, { InstructionError: [0, "Custom"] });
});

test("simulateStage2 is FAIL-CLOSED: an RPC-level simulation failure blocks (was advisory before 1.3A)", async () => {
  const conn = mockConnection({ simError: new Error("fetch failed: ECONNREFUSED") });
  const res = await simulateStage2(conn, makeLegacyTx());
  assert.equal(res.ok, false);
  assert.equal(res.simUnavailable, true);
  assert.match(res.rpcError, /ECONNREFUSED/);
});

test("simulateStage2 passes when the program accepts the tx", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: ["ok"], unitsConsumed: 12345 } } });
  const res = await simulateStage2(conn, makeLegacyTx());
  assert.equal(res.ok, true);
  assert.equal(res.unitsConsumed, 12345);
});

test("KEY: sendStage2ViaPhantom NEVER calls the wallet when simulation fails — reason surfaced", async () => {
  const conn = mockConnection({
    simResult: {
      value: {
        err: { InstructionError: [0, "Custom"] },
        logs: ["Program log: Error: insufficient funds"],
      },
    },
  });
  const wallet = mockWallet();
  const tx = makeLegacyTx();

  await assert.rejects(
    () => sendStage2ViaPhantom(conn, tx, wallet),
    (err) => {
      assert.ok(err instanceof SimulationError, `expected SimulationError, got ${err?.name}: ${err?.message}`);
      assert.equal(err.code, "solana-sim-failed");
      assert.match(err.message, /insufficient funds/);
      assert.match(err.message, /Simulation failed/);
      return true;
    },
  );
  assert.ok(
    !wallet.calls.some((c) => c.method === "signAndSendTransaction" || c.method === "signTransaction"),
    "wallet must not be asked to sign a tx whose simulation failed",
  );
  assert.ok(!conn.calls.includes("sendRawTransaction"), "must not broadcast a tx whose simulation failed");
});

test("KEY: sendStage2ViaPhantom NEVER signs when the simulation RPC is down (fail-closed)", async () => {
  const conn = mockConnection({ simError: new Error("fetch failed") });
  const wallet = mockWallet();
  await assert.rejects(
    () => sendStage2ViaPhantom(conn, makeLegacyTx(), wallet),
    (err) => err instanceof SimulationError && err.code === "sim-unavailable",
  );
  assert.ok(!wallet.calls.some((c) => c.method === "signAndSendTransaction" || c.method === "signTransaction"));
});

test("sendStage2ViaPhantom simulates the EXACT tx (fresh blockhash applied) then broadcasts via OUR connection", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: [] } } });
  const wallet = mockWallet({ keypairs: [K1] });
  const tx = makeLegacyTx();

  const sig = await sendStage2ViaPhantom(conn, tx, wallet);
  // Deterministic broadcast: signTransaction + sendRawTransaction through the
  // same connection the tx was simulated against (a wallet on the X1 network
  // would otherwise broadcast a Solana tx to X1).
  assert.equal(sig, "raw-sig");

  // Order matters: fresh blockhash → simulation of that exact tx → sign → broadcast.
  assert.deepEqual(conn.calls, ["getLatestBlockhash", "simulateTransaction", "sendRawTransaction", "confirmTransaction"]);
  assert.deepEqual(wallet.calls.map((c) => c.method), ["signTransaction"]);
  // The simulated tx is the same object that gets signed, with the fresh blockhash.
  assert.equal(tx.recentBlockhash, "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
  assert.equal(wallet.calls[0].tx, tx);
});

test("sendStage2ViaPhantom fallback (signAndSendTransaction) is also simulation-gated", async () => {
  const conn = mockConnection({ simResult: { value: { err: { InstructionError: [0, "Custom"] }, logs: [] } } });
  const wallet = mockWallet();
  // Force the fallback branch by removing signTransaction.
  delete wallet.signTransaction;
  await assert.rejects(
    () => sendStage2ViaPhantom(conn, makeLegacyTx(), wallet),
    (err) => err instanceof SimulationError && err.code === "solana-sim-failed",
  );
  assert.ok(!wallet.calls.some((c) => c.method === "signAndSendTransaction"));
  assert.ok(!conn.calls.includes("sendRawTransaction"));
});

test("sendStage2ViaPhantom falls back to signAndSendTransaction when signTransaction is unavailable", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: [] } } });
  const wallet = mockWallet();
  delete wallet.signTransaction;
  const sig = await sendStage2ViaPhantom(conn, makeLegacyTx(), wallet);
  assert.equal(sig, "wallet-sig");
  assert.deepEqual(wallet.calls.map((c) => c.method), ["signAndSendTransaction"]);
});

// ── X1 ATA-creation send (Step 1) ──
// sendX1AtaCreation must mirror sendStage2ViaPhantom: PREFER signTransaction +
// app-side broadcast through the X1 connection (a wallet pointed at Solana
// mainnet cannot broadcast an X1 tx itself — the app must send it through the
// X1 RPC), with signAndSendTransaction only as a fallback. These pin the live
// failure "Connected wallet can't sign the X1 account-creation transaction":
// the wallet COULD sign — the function just never tried the signTransaction
// path.
test("sendX1AtaCreation prefers signTransaction + app broadcast through the X1 connection", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: [] } } });
  const wallet = mockWallet({ keypairs: [K1] });
  const tx = makeLegacyTx();

  const sig = await sendX1AtaCreation(conn, tx, wallet);
  assert.equal(sig, "raw-sig");

  // Order matters: fresh blockhash → simulation of that exact tx → sign → app broadcast.
  assert.deepEqual(conn.calls, ["getLatestBlockhash", "simulateTransaction", "sendRawTransaction", "confirmTransaction"]);
  assert.deepEqual(wallet.calls.map((c) => c.method), ["signTransaction"]);
  // The simulated tx is the same object that gets signed, with the fresh blockhash.
  assert.equal(tx.recentBlockhash, "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
  assert.equal(wallet.calls[0].tx, tx);
});

test("sendX1AtaCreation is fail-closed: a rejected simulation blocks the send without asking the wallet to sign", async () => {
  const conn = mockConnection({
    simResult: {
      value: {
        err: { InstructionError: [0, "Custom"] },
        logs: ["Program log: Error: insufficient funds"],
      },
    },
  });
  const wallet = mockWallet();
  await assert.rejects(
    () => sendX1AtaCreation(conn, makeLegacyTx(), wallet),
    (err) => err instanceof SimulationError && err.code === "solana-sim-failed",
  );
  assert.ok(
    !wallet.calls.some((c) => c.method === "signTransaction" || c.method === "signAndSendTransaction"),
    "wallet must not be asked to sign a tx whose simulation failed",
  );
  assert.ok(!conn.calls.includes("sendRawTransaction"), "must not broadcast a tx whose simulation failed");
});

test("sendX1AtaCreation falls back to signAndSendTransaction when signTransaction is unavailable", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: [] } } });
  const wallet = mockWallet();
  delete wallet.signTransaction;
  const sig = await sendX1AtaCreation(conn, makeLegacyTx(), wallet);
  assert.equal(sig, "wallet-sig");
  assert.deepEqual(wallet.calls.map((c) => c.method), ["signAndSendTransaction"]);
});

test("sendX1AtaCreation throws the no-wallet error when no provider is available", async () => {
  const conn = mockConnection({ simResult: { value: { err: null, logs: [] } } });
  await assert.rejects(
    () => sendX1AtaCreation(conn, makeLegacyTx(), null),
    /No Solana\/X1 wallet found to sign the X1 account-creation tx/,
  );
});

// ── Step 1.3C fee-unification guard ──
// The on-chain skim must stay sourced from the unified fee module. If someone
// hardcodes SKIM_BPS again (or drifts the rate in fees.ts), this fails.
test("SKIM_BPS is sourced from the unified X1-hop skim rate (Step 1.3C)", () => {
  assert.equal(SKIM_BPS, BigInt(Math.round(FEE_RATES.X1_HOP_SKIM * 10_000)));
  assert.equal(SKIM_BPS, 50n); // 0.50% — the rate actually charged today (fee-model v2)
});

// ── Warp v2 spec conformance (extracted from the Warp UI bundle's own IDL) ──

function mockBuildConnection() {
  return {
    async getSlot() { return 123_456_789; },
    async getLatestBlockhash() {
      return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 };
    },
  };
}

const USER = new PublicKey("wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV");
const FEE_WALLET = new PublicKey("TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu");

// The bridge_out instruction account list MUST match the IDL spec slot-for-slot:
// the program reads accounts by POSITION, so a permutation is a real bug even
// when every pubkey is right. This is the regression guard for the
// AccountNotFound diagnosis (the list itself was verified correct — the
// missing account was the fee payer, covered by assertSolanaFeePayer).
test("buildStage2 bridge_out account list matches the Warp v2 IDL spec (order + roles)", async () => {
  const built = await buildStage2({
    connection: mockBuildConnection(),
    userPubkey: USER,
    feeWalletSvm: FEE_WALLET,
    amountHuman: 25,
  });
  const ix = built.transaction.instructions.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  assert.ok(ix, "bridge_out instruction present");
  assert.equal(ix.keys.length, WARP_BRIDGE_OUT_ACCOUNTS_SPEC.length);

  const spl = await import("@solana/spl-token");
  // Expected pubkey per spec slot (bridge_out, native USDC on Solana).
  const expected = [
    WARP_ACCOUNTS.config,
    WARP_ACCOUNTS.tokenRegistry,
    built.outgoing_msg, // outgoing_msg PDA (derived from the seq)
    USER, // sender
    await spl.getAssociatedTokenAddress(USDC_MINT, USER), // sender_token_account
    USDC_MINT,
    WARP_ACCOUNTS.vault,
    WARP_ACCOUNTS.vaultTokenAccount,
    WARP_ACCOUNTS.feePda, // fee_collector (SOL fees)
    WARP_ACCOUNTS.feeCollectorAta, // fee_collector_token_account (token fees)
    spl.TOKEN_PROGRAM_ID,
    SystemProgram.programId,
  ];
  for (let i = 0; i < WARP_BRIDGE_OUT_ACCOUNTS_SPEC.length; i++) {
    const slot = WARP_BRIDGE_OUT_ACCOUNTS_SPEC[i];
    const key = ix.keys[i];
    assert.ok(
      key.pubkey.equals(expected[i]),
      `slot ${i} (${slot.name}): expected ${expected[i].toBase58()}, got ${key.pubkey.toBase58()}`,
    );
    assert.equal(key.isWritable, slot.writable, `slot ${i} ${slot.name}: writable flag`);
    assert.equal(key.isSigner, slot.signer, `slot ${i} ${slot.name}: signer flag`);
  }
});

test("WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC matches the v2 IDL: PDAs derivable, recipient ATA is the one we create", () => {
  const enc = (s) => new TextEncoder().encode(s);
  const u64le = (v) => {
    const b = new Uint8Array(8);
    let n = BigInt(v);
    for (let i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n; }
    return b;
  };
  const names = WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC.map((a) => a.name);
  assert.deepEqual(names, [
    "config", "guardian_set", "token_registry", "signature_set", "incoming_msg",
    "payer", "recipient", "recipient_token_account", "token_mint", "mint_authority",
    "vault", "vault_token_account", "token_program", "system_program",
  ]);

  // config PDA — ground truth: 48Po6q (verified on both chains).
  const [config] = PublicKey.findProgramAddressSync([enc("config")], WARP_PROGRAM_ID);
  assert.equal(config.toBase58(), "48Po6qAHRJojbXH7KRqt6s5GfNfs9VEGccfqYEHmubEi");

  // guardian_set PDA — derivable per IDL seeds ["guardian_set"].
  const [guardianSet] = PublicKey.findProgramAddressSync([enc("guardian_set")], WARP_PROGRAM_ID);
  assert.ok(guardianSet);

  // token_registry PDA for USDC.x — the X1 registry the reverse path already uses.
  const [tokenRegistry] = PublicKey.findProgramAddressSync(
    [enc("token_registry"), X1_USDCX_MINT.toBytes()], WARP_PROGRAM_ID);
  assert.ok(tokenRegistry);

  // incoming_msg PDA — same derivation verifyX1Mint already uses on X1.
  const [incomingMsg] = PublicKey.findProgramAddressSync([enc("evt_in"), u64le(72058023007512936)], WARP_PROGRAM_ID);
  assert.ok(incomingMsg);

  // mint_authority PDA for USDC.x (wrapped) — present in the v2 list.
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [enc("mint_authority"), X1_USDCX_MINT.toBytes()], WARP_PROGRAM_ID);
  assert.ok(mintAuthority);

  // The recipient_token_account the spec requires IS the ATA ensureX1RecipientAta creates.
  assert.equal(
    deriveX1UsdcxAta(USER).toBase58(),
    getAssociatedTokenAddressSync(X1_USDCX_MINT, USER, true, TOKEN_2022_PROGRAM_ID).toBase58(),
  );

  // vault / vault_token_account are native-only OPTIONAL slots — omitted for
  // wrapped USDC.x (the mint_authority slot is the wrapped-token one).
  const vaultSlot = WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC.find((a) => a.name === "vault");
  assert.equal(vaultSlot.optional, true);
  // No associated_token_program anywhere in the v2 list: the program cannot
  // create the recipient ATA — it must pre-exist (that's our prep step).
  assert.ok(!WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC.some((a) => a.name === "associated_token_program"));
});

// ── X1 recipient ATA prep (Warp v2 spec destination-flow step 1) ──

test("ensureX1RecipientAta: no-op when the USDC.x ATA already exists on X1", async () => {
  const x1 = { async getAccountInfo() { return { lamports: 2039280 }; } };
  const res = await ensureX1RecipientAta({ connection: x1, userPubkey: USER });
  assert.equal(res.needsCreation, false);
  assert.ok(res.ata.equals(deriveX1UsdcxAta(USER)));
});

test("ensureX1RecipientAta: builds an IDEMPOTENT create-ATA tx (payer = user, Token-2022) when missing", async () => {
  const x1 = {
    async getAccountInfo() { return null; },
    async getLatestBlockhash() {
      return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 };
    },
  };
  const res = await ensureX1RecipientAta({ connection: x1, userPubkey: USER });
  assert.equal(res.needsCreation, true);
  assert.ok(res.ata.equals(deriveX1UsdcxAta(USER)));

  const tx = res.transaction;
  assert.equal(tx.instructions.length, 1);
  const ix = tx.instructions[0];
  // ATA program, not the Warp program.
  assert.equal(ix.programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  // Idempotent create (instruction byte 1), NOT plain create (byte 0): a retry
  // after the ATA already got made must be a no-op, not "account already exists".
  assert.equal(ix.data[0], 1, "must use createAssociatedTokenAccountIdempotent (discriminator 1)");

  // Payer = the user's connected wallet (signer + writable, pays rent).
  assert.equal(ix.keys[0].pubkey.toBase58(), USER.toBase58());
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[0].isWritable, true);
  // ATA being created.
  assert.equal(ix.keys[1].pubkey.toBase58(), deriveX1UsdcxAta(USER).toBase58());
  assert.equal(ix.keys[1].isWritable, true);
  // Owner = user, mint = USDC.x.
  assert.equal(ix.keys[2].pubkey.toBase58(), USER.toBase58());
  assert.equal(ix.keys[3].pubkey.toBase58(), X1_USDCX_MINT.toBase58());
  // Token program = Token-2022 (USDC.x is a Token-2022 mint).
  assert.equal(ix.keys[5].pubkey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  // Fee payer = the user's wallet (it signs and pays).
  assert.equal(tx.feePayer.toBase58(), USER.toBase58());
});

test("ensureX1RecipientAta: explicit payer is honored (requirement: payer = the user's connected wallet)", async () => {
  const x1 = {
    async getAccountInfo() { return null; },
    async getLatestBlockhash() {
      return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 };
    },
  };
  const payer = new PublicKey("8TJFteVyhghBMK6cQLNe5fHQjsCsVEvzGNW9z3Eyps69");
  const res = await ensureX1RecipientAta({ connection: x1, userPubkey: USER, payer });
  assert.equal(res.transaction.feePayer.toBase58(), payer.toBase58());
  assert.equal(res.transaction.instructions[0].keys[0].pubkey.toBase58(), payer.toBase58());
});

// ── Solana fee-payer preflight (the actual AccountNotFound root cause) ──

test("assertSolanaFeePayer: missing account → Stage2FeePayerError with an actionable message", async () => {
  const conn = { async getAccountInfo() { return null; } };
  await assert.rejects(
    () => assertSolanaFeePayer(conn, USER),
    (err) => {
      assert.ok(err instanceof Stage2FeePayerError);
      assert.match(err.message, /no spendable SOL/);
      assert.match(err.message, /send ~0.001 SOL/i);
      assert.equal(err.pubkey, USER.toBase58());
      return true;
    },
  );
});

test("assertSolanaFeePayer: underfunded (below rent-exempt) → Stage2FeePayerError", async () => {
  const conn = { async getAccountInfo() { return { lamports: 5_000 }; } };
  await assert.rejects(() => assertSolanaFeePayer(conn, USER), Stage2FeePayerError);
});

test("assertSolanaFeePayer: funded account passes", async () => {
  const conn = { async getAccountInfo() { return { lamports: 5_000_000 }; } };
  const res = await assertSolanaFeePayer(conn, USER);
  assert.equal(res.ok, true);
  assert.equal(res.lamports, 5_000_000n);
});

// ── runStage2 wiring ──

function mockStage2Connections({ feePayerExists = true, x1AtaExists = true, simOk = true } = {}) {
  const calls = { sol: [], x1: [] };
  const sol = {
    calls: calls.sol,
    async getAccountInfo() { calls.sol.push("getAccountInfo"); return feePayerExists ? { lamports: 5_000_000 } : null; },
    async getSlot() { calls.sol.push("getSlot"); return 123_456_789; },
    async getLatestBlockhash() { calls.sol.push("getLatestBlockhash"); return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 }; },
    async simulateTransaction() { calls.sol.push("simulateTransaction"); return simOk ? { value: { err: null, logs: ["Program log: Instruction: BridgeOut"], unitsConsumed: 12345 } } : { value: { err: "AccountNotFound", logs: [] } }; },
    async sendRawTransaction() { calls.sol.push("sendRawTransaction"); return "raw-sig"; },
    async confirmTransaction() { calls.sol.push("confirmTransaction"); return { value: { err: null } }; },
  };
  const x1 = {
    calls: calls.x1,
    async getAccountInfo() { calls.x1.push("getAccountInfo"); return x1AtaExists ? { lamports: 2_039_280 } : null; },
    async getLatestBlockhash() { calls.x1.push("getLatestBlockhash"); return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 }; },
    async simulateTransaction() { calls.x1.push("simulateTransaction"); return { value: { err: null, logs: [] } }; },
    async sendRawTransaction() { calls.x1.push("sendRawTransaction"); return "x1-raw-sig"; },
    async confirmTransaction() { calls.x1.push("confirmTransaction"); return { value: { err: null } }; },
  };
  return { sol, x1, calls };
}

test("runStage2: missing Solana fee payer blocks BEFORE anything is built (actionable error, not AccountNotFound)", async () => {
  const { sol, x1 } = mockStage2Connections({ feePayerExists: false });
  await assert.rejects(
    () => runStage2({ connection: sol, x1Connection: x1, userPubkey: USER, feeWalletSvm: FEE_WALLET, amountHuman: 25, allowLive: false }),
    (err) => err instanceof Stage2FeePayerError && /no spendable SOL/.test(err.message),
  );
  // The Solana tx was never built or simulated: getSlot/simulate never called.
  assert.ok(!sol.calls.includes("getSlot"));
  assert.ok(!sol.calls.includes("simulateTransaction"));
  // The X1 prep never ran either (fee-payer check is first).
  assert.equal(x1.calls.length, 0);
});

test("runStage2 (sim mode): X1 ATA tx is SIMULATED but not broadcast; Solana leg simulated; prep reported", async () => {
  const { sol, x1 } = mockStage2Connections({ feePayerExists: true, x1AtaExists: false });
  const wallet = mockWallet();
  const res = await runStage2({
    connection: sol, x1Connection: x1, userPubkey: USER, feeWalletSvm: FEE_WALLET,
    amountHuman: 25, allowLive: false, provider: wallet,
  });
  assert.equal(res.stage, "simulated_ok");
  assert.equal(res.success, true);
  assert.equal(res.prep.needsCreation, true);
  // X1: account checked, blockhash fetched, ATA tx simulated — never sent.
  assert.deepEqual(x1.calls, ["getAccountInfo", "getLatestBlockhash", "simulateTransaction"]);
  // Wallet was never asked to sign anything in sim mode.
  assert.equal(wallet.calls.length, 0);
  // Solana leg simulated (build + sim), nothing broadcast.
  assert.ok(sol.calls.includes("simulateTransaction"));
  assert.ok(!sol.calls.includes("sendRawTransaction"));
});

test("runStage2 (live mode): X1 ATA broadcast via the wallet, then the Solana leg sends deterministically", async () => {
  const { sol, x1 } = mockStage2Connections({ feePayerExists: true, x1AtaExists: false });
  const userKp = Keypair.generate();
  const wallet = mockWallet({ keypairs: [userKp] });
  const res = await runStage2({
    connection: sol, x1Connection: x1, userPubkey: userKp.publicKey, feeWalletSvm: FEE_WALLET,
    amountHuman: 25, allowLive: true, provider: wallet,
  });
  assert.equal(res.stage, "sent");
  assert.equal(res.success, true);
  // X1 ATA tx: signed via signTransaction + broadcast through the X1 connection
  // (deterministic chain — a wallet pointed at Solana mainnet can't broadcast
  // an X1 tx itself; signAndSendTransaction would target the wrong network).
  assert.ok(wallet.calls.some((c) => c.method === "signTransaction"), "wallet signed the X1 ATA tx");
  assert.ok(x1.calls.includes("sendRawTransaction"), "X1 ATA tx broadcast through the X1 connection");
  assert.ok(x1.calls.includes("confirmTransaction"), "X1 ATA tx confirmed on the X1 connection");
  // Solana leg broadcast via OUR connection (deterministic chain).
  assert.ok(sol.calls.includes("sendRawTransaction"));
  assert.equal(res.signature, "raw-sig");
});

test("runStage2: X1 ATA already exists → prep is a no-op, no X1 tx built or sent", async () => {
  const { sol, x1 } = mockStage2Connections({ feePayerExists: true, x1AtaExists: true });
  const userKp = Keypair.generate();
  const wallet = mockWallet({ keypairs: [userKp] });
  const res = await runStage2({
    connection: sol, x1Connection: x1, userPubkey: userKp.publicKey, feeWalletSvm: FEE_WALLET,
    amountHuman: 25, allowLive: true, provider: wallet,
  });
  assert.equal(res.prep.needsCreation, false);
  assert.deepEqual(x1.calls, ["getAccountInfo"]);
  // No X1 tx was signed — the only wallet interaction is the Solana sign.
  assert.ok(!wallet.calls.some((c) => c.method === "signAndSendTransaction"));
  assert.ok(wallet.calls.some((c) => c.method === "signTransaction"));
});

// ════════════════════════════════════════════════════════════════════════════
//  REVERSE LEG (X1 → Solana): the Warp bridge_out BURN on X1 mainnet.
//  The reverse completes the round trip: X1 USDC.x burns on X1, guardians
//  release USDC on Solana (then the form's stage 2 runs the LiFi Solana→EVM
//  leg). These pin the X1 outbound construction + gates, mirroring the
//  forward buildStage2 / runStage2 tests.
// ════════════════════════════════════════════════════════════════════════════
import {
  buildReverseBurn,
  runReverse,
  encodeReverseSeq,
  assertX1FeePayer,
  assertX1UsdcBalance,
  ensureX1FeeWalletAta,
  X1FeePayerError,
  X1UsdcBalanceError,
  X1_FEE_PAYER_MIN_LAMPORTS,
} from "./warpBridge.js";

// The fixed X1-side fee account from the real mainnet burn tx mMQt8Ypjed…
// (account slot 9 — a FIXED program fee account, not a derivable ATA).
const X1_FEE_ACCOUNT_GT = "4uRFjqVU5ZKkp7hQLx3Lm3YeWFts17ER8a5HLUE18ayG";
// The fee collector wallet at slot 8 = WARP_ACCOUNTS.feePda (7bz2ZN…).
const X1_FEE_COLLECTOR_GT = WARP_ACCOUNTS.feePda.toBase58();

function mockX1Connection({ userPubkey = USER, feePayerExists = true, feeAtaExists = true, simOk = true, simErr = null, usdcBalance = 1_000_000_000_000n, usdcBalanceExists = true } = {}) {
  const calls = [];
  const connection = {
    calls,
    async getAccountInfo(pk) {
      calls.push("getAccountInfo");
      // Fee-payer preflight: the USER's system account.
      if (pk.equals(userPubkey)) return feePayerExists ? { lamports: 5_000_000 } : null;
      // Balance preflight: the USER's USDC.x ATA.
      const userAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, userPubkey, true, TOKEN_2022_PROGRAM_ID);
      if (pk.equals(userAta)) return usdcBalanceExists ? { lamports: 2_039_280 } : null;
      // Fee-wallet ATA check (ensureX1FeeWalletAta).
      const feeAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, FEE_WALLET, true, TOKEN_2022_PROGRAM_ID);
      if (pk.equals(feeAta)) return feeAtaExists ? { lamports: 2_039_280 } : null;
      return null;
    },
    async getTokenAccountBalance(pk) {
      calls.push("getTokenAccountBalance");
      const userAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, userPubkey, true, TOKEN_2022_PROGRAM_ID);
      if (!pk.equals(userAta)) throw new Error("mock: unexpected token account");
      if (!usdcBalanceExists) throw new Error("AccountNotFound");
      return { value: { amount: String(usdcBalance), decimals: 6, uiAmount: Number(usdcBalance) / 1e6 } };
    },
    async getSlot() { calls.push("getSlot"); return 123_456_789; },
    async getLatestBlockhash() { calls.push("getLatestBlockhash"); return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 }; },
    async simulateTransaction() {
      calls.push("simulateTransaction");
      if (simErr) throw simErr;
      return simOk ? { value: { err: null, logs: ["Program log: Instruction: BridgeOut"], unitsConsumed: 12345 } } : { value: { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: Error: insufficient funds"] } };
    },
    async sendRawTransaction() { calls.push("sendRawTransaction"); return "x1-burn-sig"; },
    async confirmTransaction() { calls.push("confirmTransaction"); return { value: { err: null } }; },
  };
  return connection;
}

// The reverse burn tx must match the REAL mainnet X1→Sol burn layout
// (mMQt8Ypjed…), slot-for-slot: config, token_registry (USDC.x), outgoing_msg,
// sender, user's USDC.x ATA (Token-2022), the USDC.x mint, program-self ×2,
// fee collector wallet, FIXED fee account, Token-2022 program, system program.
test("buildReverseBurn: X1 bridge_out account list matches the verified mainnet burn (order + roles)", async () => {
  const built = await buildReverseBurn({
    connection: mockBuildConnection(), // getSlot + getLatestBlockhash
    userPubkey: USER,
    amountHuman: 25,
  });
  const ix = built.transaction.instructions.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  assert.ok(ix, "bridge_out instruction present");
  assert.equal(ix.keys.length, 12, "verified mainnet burn has exactly 12 accounts");

  const userUsdcxAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, USER, true, TOKEN_2022_PROGRAM_ID);
  const enc = (s) => new TextEncoder().encode(s);
  const u64le = (v) => { const b = new Uint8Array(8); let n = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
  const [config] = PublicKey.findProgramAddressSync([enc("config")], WARP_PROGRAM_ID);
  const [tokenRegistry] = PublicKey.findProgramAddressSync([enc("token_registry"), X1_USDCX_MINT.toBytes()], WARP_PROGRAM_ID);
  const [outgoingMsg] = PublicKey.findProgramAddressSync([enc("evt_out"), u64le(built.seq)], WARP_PROGRAM_ID);

  const expected = [
    config,                    // 0 config (48Po6q — same PDA on both chains)
    tokenRegistry,             // 1 token_registry (USDC.x registry)
    outgoingMsg,               // 2 outgoing_msg (evt_out PDA for the seq)
    USER,                      // 3 sender (signer)
    userUsdcxAta,              // 4 user's USDC.x ATA (Token-2022 burn source)
    X1_USDCX_MINT,             // 5 USDC.x mint
    WARP_PROGRAM_ID,           // 6 program self (burn authority pattern)
    WARP_PROGRAM_ID,           // 7 program self
    new PublicKey(X1_FEE_COLLECTOR_GT), // 8 fee collector wallet
    new PublicKey(X1_FEE_ACCOUNT_GT),   // 9 FIXED fee account (4uRFjq…)
    TOKEN_2022_PROGRAM_ID,     // 10 Token-2022 program (USDC.x is Token-2022)
    SystemProgram.programId,   // 11 system program
  ];
  for (let i = 0; i < 12; i++) {
    const key = ix.keys[i];
    assert.ok(
      key.pubkey.equals(expected[i]),
      `slot ${i}: expected ${expected[i].toBase58()}, got ${key.pubkey.toBase58()}`,
    );
  }
  assert.equal(ix.keys[3].isSigner, true, "sender must sign the burn");
  assert.equal(ix.keys[3].isWritable, true);
  assert.equal(ix.keys[0].isWritable, true);

  // Instruction data: BRIDGE_OUT discriminator + seq (u64 LE) + amount (u64 LE).
  assert.equal(ix.data.length, 24);
  assert.deepEqual([...ix.data.slice(0, 8)], [27, 194, 57, 119, 215, 165, 247, 150]);
  assert.equal(BigInt(ix.data[8]) | (BigInt(ix.data[9]) << 8n) | (BigInt(ix.data[10]) << 16n) | (BigInt(ix.data[11]) << 24n), BigInt(built.seq) & 0xffffffffn);
  const amountLE = ix.data.slice(16, 24);
  let amt = 0n; for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(amountLE[i]);
  assert.equal(amt, 25_000_000n, "burn amount = 25 USDC.x in base units");
});

test("encodeReverseSeq: chain-pair 0x10 (X1→Sol) encodes into the top byte, slot·1000 + ixIndex below", () => {
  const seq = encodeReverseSeq(123_456_789, 0);
  assert.equal(seq >> 56n, 0x10n, "chain pair X1→Sol = 0x10 in the top byte");
  assert.equal(seq & 0x00ffffffffffffffn, 123_456_789n * 1000n);
  const seq2 = encodeReverseSeq(123_456_789, 42);
  assert.equal(seq2 & 0x00ffffffffffffffn, 123_456_789n * 1000n + 42n);
  assert.throws(() => encodeReverseSeq(1, 1000), /ixIndex/);
  assert.throws(() => encodeReverseSeq(1, -1), /ixIndex/);
});

test("assertX1FeePayer: missing X1 account → X1FeePayerError with an actionable XNT message", async () => {
  const conn = { async getAccountInfo() { return null; } };
  await assert.rejects(
    () => assertX1FeePayer(conn, USER),
    (err) => {
      assert.ok(err instanceof X1FeePayerError);
      assert.match(err.message, /no spendable XNT/);
      assert.match(err.message, /send ~0.001 XNT/i);
      assert.equal(err.pubkey, USER.toBase58());
      return true;
    },
  );
});

test("assertX1FeePayer: funded X1 account passes; threshold mirrors the Solana preflight", async () => {
  const conn = { async getAccountInfo() { return { lamports: 5_000_000 }; } };
  const res = await assertX1FeePayer(conn, USER);
  assert.equal(res.ok, true);
  assert.equal(X1_FEE_PAYER_MIN_LAMPORTS, 1_000_000n);
});

test("ensureX1FeeWalletAta: builds an IDEMPOTENT Token-2022 create (owner = fee wallet, payer = user) when missing", async () => {
  const x1 = {
    async getAccountInfo() { return null; },
    async getLatestBlockhash() { return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 }; },
  };
  const res = await ensureX1FeeWalletAta({ connection: x1, userPubkey: USER, feeWallet: FEE_WALLET });
  assert.equal(res.needsCreation, true);
  const tx = res.transaction;
  assert.equal(tx.instructions.length, 1);
  const ix = tx.instructions[0];
  assert.equal(ix.programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  assert.equal(ix.data[0], 1, "idempotent create (discriminator 1), not plain create");
  // payer = the USER (pays rent + signs); owner = the FEE wallet.
  assert.equal(ix.keys[0].pubkey.toBase58(), USER.toBase58());
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[2].pubkey.toBase58(), FEE_WALLET.toBase58(), "owner = fee wallet");
  assert.equal(ix.keys[3].pubkey.toBase58(), X1_USDCX_MINT.toBase58());
  assert.equal(ix.keys[5].pubkey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(tx.feePayer.toBase58(), USER.toBase58());
  // The ATA it creates IS the transfer destination the skim uses.
  assert.equal(
    res.ata.toBase58(),
    getAssociatedTokenAddressSync(X1_USDCX_MINT, FEE_WALLET, true, TOKEN_2022_PROGRAM_ID).toBase58(),
  );
});

test("ensureX1FeeWalletAta: no-op when the fee wallet's USDC.x ATA already exists on X1", async () => {
  const x1 = { async getAccountInfo() { return { lamports: 2_039_280 }; } };
  const res = await ensureX1FeeWalletAta({ connection: x1, userPubkey: USER, feeWallet: FEE_WALLET });
  assert.equal(res.needsCreation, false);
});

test("runReverse: X1 fee-payer preflight blocks BEFORE anything is built (actionable XNT error, not AccountNotFound)", async () => {
  const conn = mockX1Connection({ feePayerExists: false, feeAtaExists: true });
  const wallet = mockWallet();
  await assert.rejects(
    () => runReverse({ connection: conn, userPubkey: USER, amountHuman: 25, feeAmount: 0.125, feeWallet: FEE_WALLET, allowLive: false, provider: wallet }),
    (err) => err instanceof X1FeePayerError && /no spendable XNT/.test(err.message),
  );
  // Nothing built, nothing simulated, wallet never asked to sign.
  assert.ok(!conn.calls.includes("getSlot"));
  assert.ok(!conn.calls.includes("simulateTransaction"));
  assert.equal(wallet.calls.length, 0);
});

test("runReverse (sim mode): missing fee ATA → create is BUNDLED into the burn tx, sims clean, nothing broadcast", async () => {
  const conn = mockX1Connection({ feePayerExists: true, feeAtaExists: false, simOk: true });
  const wallet = mockWallet();
  const res = await runReverse({
    connection: conn, userPubkey: USER, amountHuman: 24.875,
    feeAmount: 0.125, feeWallet: FEE_WALLET, allowLive: false, provider: wallet,
  });
  assert.equal(res.stage, "simulated_ok");
  assert.equal(res.success, true);
  assert.equal(res.prep.needsCreation, true);
  // The fee ATA does NOT exist → the idempotent create is bundled in front of
  // the skim transfer, so the single burn tx sims CLEAN (no dead-end: the
  // transfer destination exists within the same tx).
  const tx = res.built.transaction;
  assert.equal(tx.instructions.length, 3, "create → skim transfer → burn in one tx");
  assert.equal(tx.instructions[0].programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ix0 = idempotent ATA create");
  assert.equal(tx.instructions[0].data[0], 1, "idempotent create (discriminator 1)");
  assert.equal(tx.instructions[1].programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), "ix1 = skim transfer");
  assert.equal(tx.instructions[2].programId.toBase58(), WARP_PROGRAM_ID.toBase58(), "ix2 = Warp bridge_out burn");
  // Wallet never asked to sign in sim mode.
  assert.equal(wallet.calls.length, 0);
  // ONE simulation (the bundled burn tx), nothing broadcast.
  assert.equal(conn.calls.filter((c) => c === "simulateTransaction").length, 1);
  assert.ok(!conn.calls.includes("sendRawTransaction"));
});

test("runReverse (live mode): missing fee ATA → create+transfer+burn in ONE tx, ONE guarded send (no dead-end, no double prompt)", async () => {
  const userKp = Keypair.generate();
  const conn = mockX1Connection({ userPubkey: userKp.publicKey, feePayerExists: true, feeAtaExists: false, simOk: true });
  const wallet = mockWallet({ keypairs: [userKp] });
  const res = await runReverse({
    connection: conn, userPubkey: userKp.publicKey, amountHuman: 24.875,
    feeAmount: 0.125, feeWallet: FEE_WALLET, allowLive: true, provider: wallet,
  });
  assert.equal(res.stage, "sent");
  assert.equal(res.signature, "x1-burn-sig");
  assert.equal(res.prep.needsCreation, true);

  // Instruction order: [0] idempotent create (payer = user, owner = fee wallet),
  // [1] our 0.5% skim transfer, [2] Warp bridge_out burn.
  const tx = res.built.transaction;
  assert.equal(tx.instructions.length, 3);
  const create = tx.instructions[0];
  assert.equal(create.programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  assert.equal(create.data[0], 1, "idempotent create");
  assert.equal(create.keys[0].pubkey.toBase58(), userKp.publicKey.toBase58(), "payer = user (pays rent + signs)");
  assert.equal(create.keys[0].isSigner, true);
  assert.equal(create.keys[2].pubkey.toBase58(), FEE_WALLET.toBase58(), "owner = fee wallet");
  assert.equal(create.keys[3].pubkey.toBase58(), X1_USDCX_MINT.toBase58(), "mint = USDC.x");
  const feeAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, FEE_WALLET, true, TOKEN_2022_PROGRAM_ID);
  assert.equal(create.keys[1].pubkey.toBase58(), feeAta.toBase58(), "creates the fee wallet's USDC.x ATA");

  // The skim transfers 0.5% (0.125 USDC.x = 125000 base) to that same ATA.
  const skim = tx.instructions[1];
  assert.equal(skim.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  const skimAmount = Buffer.from(skim.data).readBigUInt64LE(1);
  assert.equal(skimAmount, 125_000n);
  const userUsdcxAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, userKp.publicKey, true, TOKEN_2022_PROGRAM_ID);
  assert.equal(skim.keys[0].pubkey.toBase58(), userUsdcxAta.toBase58(), "skim from the user's USDC.x ATA");
  assert.equal(skim.keys[1].pubkey.toBase58(), feeAta.toBase58(), "skim to the fee wallet's USDC.x ATA");

  // The burn amount = gross − skim = 24.875 USDC.x (24875000 base).
  const burn = tx.instructions[2];
  assert.equal(burn.programId.toBase58(), WARP_PROGRAM_ID.toBase58());
  let amt = 0n; const amountLE = burn.data.slice(16, 24);
  for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(amountLE[i]);
  assert.equal(amt, 24_875_000n, "bridge_out burns the net (gross − 0.5% skim)");

  // ONE guarded send: fresh blockhash → sim → signTransaction → app
  // sendRawTransaction. The ATA creation is NOT a separate broadcast.
  assert.equal(conn.calls.filter((c) => c === "sendRawTransaction").length, 1, "single broadcast (no separate ATA tx)");
  // Two simulations by design: the runReverse fail-closed gate + the
  // guardedSendSolanaTx pre-send gate (same tx, both must pass).
  assert.equal(conn.calls.filter((c) => c === "simulateTransaction").length, 2, "runReverse gate + guarded-send gate");
  assert.ok(conn.calls.includes("confirmTransaction"));
  assert.ok(wallet.calls.some((c) => c.method === "signTransaction"));
  assert.equal(wallet.calls.length, 1, "ONE wallet signature (no separate ATA-creation prompt)");
});

test("runReverse (live mode): 0.5% skim transfer FIRST, then the burn; broadcast through the X1 connection", async () => {
  const userKp = Keypair.generate();
  const conn = mockX1Connection({ userPubkey: userKp.publicKey, feePayerExists: true, feeAtaExists: true, simOk: true });
  const wallet = mockWallet({ keypairs: [userKp] });
  const res = await runReverse({
    connection: conn, userPubkey: userKp.publicKey, amountHuman: 24.875,
    feeAmount: 0.125, feeWallet: FEE_WALLET, allowLive: true, provider: wallet,
  });
  assert.equal(res.stage, "sent");
  assert.equal(res.signature, "x1-burn-sig");

  // Instruction order: [0] = our 0.5% skim transfer, [1] = Warp bridge_out burn.
  const tx = res.built.transaction;
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0].programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), "skim transfer uses Token-2022 (USDC.x)");
  assert.equal(tx.instructions[1].programId.toBase58(), WARP_PROGRAM_ID.toBase58(), "burn follows the skim");

  // The skim transfers 0.5% (0.125 USDC.x = 125000 base) to the fee wallet's X1 ATA.
  const skim = tx.instructions[0];
  const skimAmount = Buffer.from(skim.data).readBigUInt64LE(1);
  assert.equal(skimAmount, 125_000n, "skim = 0.5% of 25 = 0.125 USDC.x (125000 base units)");
  const userUsdcxAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, userKp.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const feeUsdcxAta = getAssociatedTokenAddressSync(X1_USDCX_MINT, FEE_WALLET, true, TOKEN_2022_PROGRAM_ID);
  assert.equal(skim.keys[0].pubkey.toBase58(), userUsdcxAta.toBase58(), "skim from the user's USDC.x ATA");
  assert.equal(skim.keys[1].pubkey.toBase58(), feeUsdcxAta.toBase58(), "skim to the fee wallet's USDC.x ATA");

  // The burn amount = gross − skim = 24.875 USDC.x (24875000 base).
  const burn = tx.instructions[1];
  let amt = 0n; const amountLE = burn.data.slice(16, 24);
  for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(amountLE[i]);
  assert.equal(amt, 24_875_000n, "bridge_out burns the net (gross − 0.5% skim)");

  // Deterministic broadcast: fresh blockhash → sim → signTransaction → app
  // sendRawTransaction through the X1 connection (PR #30 pattern).
  assert.ok(conn.calls.includes("sendRawTransaction"));
  assert.ok(conn.calls.includes("confirmTransaction"));
  assert.ok(wallet.calls.some((c) => c.method === "signTransaction"));
});

test("runReverse is FAIL-CLOSED: a rejected burn simulation blocks — no send, wallet never asked to sign", async () => {
  const conn = mockX1Connection({ feePayerExists: true, feeAtaExists: true, simOk: false });
  const wallet = mockWallet();
  const res = await runReverse({
    connection: conn, userPubkey: USER, amountHuman: 25,
    feeAmount: 0.25, feeWallet: FEE_WALLET, allowLive: true, provider: wallet,
  });
  assert.equal(res.stage, "simulation");
  assert.equal(res.success, false);
  assert.deepEqual(res.sim.err, { InstructionError: [0, "Custom"] });
  assert.ok(!conn.calls.includes("sendRawTransaction"), "must not broadcast a tx whose simulation failed");
  assert.ok(!wallet.calls.some((c) => c.method === "signTransaction" || c.method === "signAndSendTransaction"));
});

test("runReverse: X1 USDC.x balance preflight — a shortfall throws an ACTIONABLE error BEFORE anything is built (the real v2 live failure)", async () => {
  // The v2 armed-preview failure was Token-2022 `custom program error: 0x1` =
  // Custom(1) InsufficientFunds — the burn's total debit (0.5% skim + Warp
  // gross) exceeded the user's balance and the sim died cryptically inside
  // Warp's burn CPI. The preflight turns that into an actionable message.
  const conn = mockX1Connection({ feePayerExists: true, feeAtaExists: true, usdcBalance: 25_000_000n }); // 25.00 < 25.25 required
  const wallet = mockWallet();
  await assert.rejects(
    () => runReverse({
      connection: conn, userPubkey: USER, amountHuman: 25,
      feeAmount: 0.125, feeWallet: FEE_WALLET, allowLive: true, provider: wallet,
    }),
    (err) => {
      assert.ok(err instanceof X1UsdcBalanceError);
      assert.match(err.message, /Not enough USDC\.x on X1/);
      assert.match(err.message, /holds 25\.00 USDC\.x/);
      assert.equal(err.available, 25_000_000n);
      assert.equal(err.required, 25_125_000n);
      return true;
    },
  );
  // Nothing built, nothing simulated, wallet never asked to sign.
  assert.ok(!conn.calls.includes("getSlot"), "burn was never built");
  assert.ok(!conn.calls.includes("simulateTransaction"));
  assert.equal(wallet.calls.length, 0);
});

test("runReverse: X1 USDC.x balance preflight — exact balance passes; missing ATA treated as 0 and blocks with an actionable message", async () => {
  // Exact balance (30.00 for a 30.00 send) → preflight passes, flow proceeds.
  const conn = mockX1Connection({ feePayerExists: true, feeAtaExists: true, usdcBalance: 30_000_000n, simOk: true });
  const wallet = mockWallet();
  const res = await runReverse({
    connection: conn, userPubkey: USER, amountHuman: 29.70,
    feeAmount: 0.30, feeWallet: FEE_WALLET, allowLive: false, provider: wallet,
  });
  assert.equal(res.stage, "simulated_ok");
  assert.equal(res.success, true);

  // Missing USDC.x ATA (no balance on X1) → 0 available → blocks with the
  // actionable message, still fail-closed and before any build.
  const conn2 = mockX1Connection({ feePayerExists: true, feeAtaExists: true, usdcBalanceExists: false });
  await assert.rejects(
    () => runReverse({
      connection: conn2, userPubkey: USER, amountHuman: 25,
      feeAmount: 0.125, feeWallet: FEE_WALLET, allowLive: false, provider: wallet,
    }),
    (err) => err instanceof X1UsdcBalanceError && /holds 0\.00 USDC\.x/.test(err.message),
  );
  assert.ok(!conn2.calls.includes("getSlot"));
  assert.equal(wallet.calls.length, 0);
});

test("assertX1UsdcBalance: RPC failure is fail-closed (cannot prove funds → actionable error)", async () => {
  const conn = {
    async getAccountInfo() { throw new Error("fetch failed: ECONNREFUSED"); },
  };
  await assert.rejects(
    () => assertX1UsdcBalance(conn, USER, 25_000_000n),
    (err) => err instanceof X1UsdcBalanceError && /Could not verify your X1 USDC\.x balance/.test(err.message),
  );
});

test("assertX1UsdcBalance: sufficient balance resolves with the checked amounts", async () => {
  const conn = mockX1Connection({ feePayerExists: true, feeAtaExists: true, usdcBalance: 50_000_000n });
  const res = await assertX1UsdcBalance(conn, USER, 25_000_000n);
  assert.equal(res.ok, true);
  assert.equal(res.available, 50_000_000n);
  assert.equal(res.required, 25_000_000n);
});

// ── pollWarpStatus: Warp release-polling detection (fix/warp-poll-desttxsig) ──
// The live Warp API nests the transaction under `transaction` and names the
// destination release sig `destTxSig`. The poller previously read top-level
// fields only and never looked for `destTxSig`, so a COMPLETED reverse leg
// (X1 burn executed, guardians released on Solana) was never detected and the
// UI sat on "Guardians signing" forever. These tests pin the fix.

const POLL_SIG =
  "2YrCSbPjVGYnd3YggvVVtLfUUYwtGTunq2tWTUv9fyRB891T8ptNeDt9JmKaBxxrt5TfgMWcyCD9yFCxPnNJkVuc";
const DEST_SIG =
  "2LsDtErwXZaipeS9SE2ruN7EwFNr4hftBnnHqojSzqmWvnJRsxXvjzHG9sV2RAvbK8g2FLEuReBahBsTTaLrBEGG";

// Stub global fetch for the two Warp endpoints the poller hits:
//   {api}/transactions/{sig}/signatures?from=…  and  {api}/transactions/{sig}?from=…
function mockWarpFetch({ statusBody, sigsBody = { signatures: [{ guardian: "g1" }] }, statusOk = true } = {}) {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/signatures?")) {
      return { ok: true, status: 200, async json() { return sigsBody; } };
    }
    return { ok: statusOk, status: statusOk ? 200 : 404, async json() { return statusBody; } };
  };
  return { calls, restore: () => { globalThis.fetch = origFetch; } };
}

test("pollWarpStatus: detects completion on the REAL Warp API shape — { transaction: { status: \"executed\", destTxSig } }", async () => {
  // REGRESSION PIN for fix/warp-poll-desttxsig (#34) — now polled over the
  // same-origin proxy (/api/warp/*, fix/proxy-warp-poll): the nested
  // `transaction` shape with `destTxSig` must STILL complete the poll.
  const mock = mockWarpFetch({
    statusBody: {
      transaction: {
        txSig: POLL_SIG, from: "x1", to: "sol", status: "executed",
        token: "USDC", amount: "28700000",
        signaturesCollected: 7, signaturesRequired: 5,
        destTxSig: DEST_SIG, destSlot: "443400608",
      },
      signatures: [{ guardian: "g1" }],
    },
  });
  try {
    const stages = [];
    const res = await pollWarpStatus(POLL_SIG, {
      from: "x1",
      intervalMs: 5, maxMs: 2000,
      onUpdate: (s, d) => stages.push([s, d]),
    });
    assert.equal(res.ok, true);
    assert.equal(res.destinationTx, DEST_SIG);
    const complete = stages.find(([s]) => s === "complete");
    assert.ok(complete, "complete stage fired");
    assert.equal(complete[1].destinationTx, DEST_SIG);
  } finally { mock.restore(); }
});

test("pollWarpStatus: nested transaction.destinationTxSignature variant also completes", async () => {
  const mock = mockWarpFetch({ statusBody: { transaction: { status: "executed", destinationTxSignature: DEST_SIG } } });
  try {
    const res = await pollWarpStatus(POLL_SIG, { from: "x1", intervalMs: 5, maxMs: 2000 });
    assert.equal(res.ok, true);
    assert.equal(res.destinationTx, DEST_SIG);
  } finally { mock.restore(); }
});

test("pollWarpStatus: top-level { status: \"executed\", destTxSig } variant also completes", async () => {
  const mock = mockWarpFetch({ statusBody: { status: "executed", destTxSig: DEST_SIG } });
  try {
    const res = await pollWarpStatus(POLL_SIG, { from: "x1", intervalMs: 5, maxMs: 2000 });
    assert.equal(res.ok, true);
    assert.equal(res.destinationTx, DEST_SIG);
  } finally { mock.restore(); }
});

test("pollWarpStatus: polls the SAME-ORIGIN proxy paths — never the external Warp API host", async () => {
  const mock = mockWarpFetch({
    statusBody: { transaction: { status: "executed", destTxSig: DEST_SIG } },
  });
  try {
    await pollWarpStatus(POLL_SIG, { from: "x1", intervalMs: 5, maxMs: 2000 });
    assert.ok(mock.calls.length >= 2, `both endpoints polled: ${mock.calls.join(", ")}`);
    for (const u of mock.calls) {
      assert.ok(u.startsWith("/api/warp/"), `same-origin proxy path: ${u}`);
      assert.ok(!u.includes("api.bridge.mainnet.x1.xyz"), `no direct Warp API fetch: ${u}`);
    }
    assert.ok(mock.calls.some((u) => u.startsWith("/api/warp/status?")), "status proxy polled");
    assert.ok(mock.calls.some((u) => u.startsWith("/api/warp/signatures?")), "signatures proxy polled");
    assert.ok(mock.calls.every((u) => u.includes("from=x1")), `from=x1 forwarded on every poll: ${mock.calls.join(", ")}`);
    assert.ok(mock.calls.every((u) => u.includes(`sig=${POLL_SIG}`)), "sig forwarded on every poll");
  } finally { mock.restore(); }
});

test("pollWarpStatus: upstream 404 (proxy pass-through) is awaiting_guardians, NOT an exception", async () => {
  // The proxy passes upstream 404s through verbatim — before the relay
  // detects the burn BOTH endpoints 404. The poller must treat that as
  // "still awaiting guardians" and keep polling, never throw or surface
  // poll_error.
  const mock = mockWarpFetch({ statusOk: false, statusBody: { error: "not found" } });
  try {
    const stages = [];
    const res = await pollWarpStatus(POLL_SIG, {
      from: "x1", intervalMs: 5, maxMs: 60,
      onUpdate: (s, d) => stages.push([s, d]),
    });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    const awaiting = stages.filter(([s]) => s === "awaiting_guardians");
    assert.ok(awaiting.length >= 2, `awaiting_guardians fired for both endpoints: ${JSON.stringify(stages)}`);
    assert.ok(!stages.some(([s]) => s === "poll_error"), "404 must not surface as poll_error");
  } finally { mock.restore(); }
});

test("pollWarpStatus: reverse-leg polling hits the API with from=x1 on BOTH endpoints", async () => {
  const mock = mockWarpFetch({ statusBody: { transaction: { status: "executed", destTxSig: DEST_SIG } } });
  try {
    await pollWarpStatus(POLL_SIG, { from: "x1", intervalMs: 5, maxMs: 2000 });
    const statusUrls = mock.calls.filter((u) => !u.includes("/signatures?"));
    const sigUrls = mock.calls.filter((u) => u.includes("/signatures?"));
    assert.ok(statusUrls.length > 0, "status endpoint polled");
    assert.ok(statusUrls.every((u) => u.includes("from=x1")), `status URLs use from=x1: ${statusUrls.join(", ")}`);
    assert.ok(sigUrls.length > 0, "signatures endpoint polled");
    assert.ok(sigUrls.every((u) => u.includes("from=x1")), `signatures URLs use from=x1: ${sigUrls.join(", ")}`);
  } finally { mock.restore(); }
});

test("pollWarpStatus: status \"executed\" alone is terminal-complete (no dest sig required)", async () => {
  const mock = mockWarpFetch({ statusBody: { transaction: { status: "executed", signaturesCollected: 7, signaturesRequired: 5 } } });
  try {
    const res = await pollWarpStatus(POLL_SIG, { from: "x1", intervalMs: 5, maxMs: 2000 });
    assert.equal(res.ok, true);
  } finally { mock.restore(); }
});

test("pollWarpStatus: a pending status does NOT complete early — keeps polling until timeout", async () => {
  const mock = mockWarpFetch({ statusBody: { transaction: { status: "pending", signaturesCollected: 3, signaturesRequired: 5 } } });
  try {
    const res = await pollWarpStatus(POLL_SIG, { from: "x1", intervalMs: 5, maxMs: 60 });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
  } finally { mock.restore(); }
});

// ════════════════════════════════════════════════════════════════════════════
//  WSOL / wSOL.X — the SOL rail (feat/wsol-path). Ground truth: live Warp
//  config (api.bridge.mainnet.x1.xyz/config, Sep 2026): wSOL.X is a WRAPPED
//  Token-2022 mint on X1 (JDqX4…, 9 dec, flat 0, 25 bps pct fee,
//  feeCollectorAta 9Tdid7tM…) and WSOL is NATIVE on Solana (So111…, 9 dec,
//  same 25 bps, feeCollectorAta GxfLqezi…). Verified against live mainnet
//  wSOL.X burns: the X1 bridge_out is the SAME 12-account shape as the USDC.x
//  burn (program-self in the optional vault slots — NO mint_authority account;
//  that PDA belongs to the RECEIVE-side bridge_in_v2). The account-spec
//  correction (mint_authority NOT in bridge_out) was verified against the
//  current program's IDL + a live wSOL.X burn tx (5rUiHoLE12L5…: gross 0.11
//  wSOL.X → 0.000275 fee = exactly 25 bps → net release 0.109725).
// ════════════════════════════════════════════════════════════════════════════

// wSOL.X-aware X1 connection mock (mirrors mockX1Connection, mint-swapped).
function mockX1ConnectionWsol({ userPubkey = USER, feePayerExists = true, feeAtaExists = false, simOk = true, wsolBalance = 1_000_000_000_000n, wsolBalanceExists = true } = {}) {
  const calls = [];
  const connection = {
    calls,
    async getAccountInfo(pk) {
      calls.push("getAccountInfo");
      if (pk.equals(userPubkey)) return feePayerExists ? { lamports: 5_000_000 } : null;
      const userAta = getAssociatedTokenAddressSync(X1_WSOLX_MINT, userPubkey, true, TOKEN_2022_PROGRAM_ID);
      if (pk.equals(userAta)) return wsolBalanceExists ? { lamports: 2_039_280 } : null;
      const feeAta = getAssociatedTokenAddressSync(X1_WSOLX_MINT, FEE_WALLET, true, TOKEN_2022_PROGRAM_ID);
      if (pk.equals(feeAta)) return feeAtaExists ? { lamports: 2_039_280 } : null;
      return null;
    },
    async getTokenAccountBalance(pk) {
      calls.push("getTokenAccountBalance");
      const userAta = getAssociatedTokenAddressSync(X1_WSOLX_MINT, userPubkey, true, TOKEN_2022_PROGRAM_ID);
      if (!pk.equals(userAta)) throw new Error("mock: unexpected token account");
      if (!wsolBalanceExists) throw new Error("AccountNotFound");
      return { value: { amount: String(wsolBalance), decimals: 9, uiAmount: Number(wsolBalance) / 1e9 } };
    },
    async getSlot() { calls.push("getSlot"); return 123_456_789; },
    async getLatestBlockhash() { calls.push("getLatestBlockhash"); return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 }; },
    async simulateTransaction() {
      calls.push("simulateTransaction");
      return simOk ? { value: { err: null, logs: ["Program log: Instruction: BridgeOut"], unitsConsumed: 12345 } } : { value: { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: Error: insufficient funds"] } };
    },
    async sendRawTransaction() { calls.push("sendRawTransaction"); return "x1-wsol-burn-sig"; },
    async confirmTransaction() { calls.push("confirmTransaction"); return { value: { err: null } }; },
  };
  return connection;
}

test("wSOL.X burn: buildReverseBurn uses 9-dec amounts + the wSOL.X mint/registry/ATA/fee account (mint_authority NOT in bridge_out — verified against live wSOL.X burns + the current IDL)", async () => {
  const built = await buildReverseBurn({
    connection: mockBuildConnection(),
    userPubkey: USER,
    amountHuman: 25, // 25 wSOL.X (9 decimals)
    mint: X1_WSOLX_MINT,
    decimals: 9,
    feeAccount: X1_WSOLX_FEE_ACCOUNT,
  });
  const ix = built.transaction.instructions.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  assert.ok(ix, "bridge_out instruction present");
  assert.equal(ix.keys.length, 12, "wSOL.X burn = the SAME 12-account shape as USDC.x (verified on-chain)");

  const userWsolxAta = getAssociatedTokenAddressSync(X1_WSOLX_MINT, USER, true, TOKEN_2022_PROGRAM_ID);
  const enc = (s) => new TextEncoder().encode(s);
  const u64le = (v) => { const b = new Uint8Array(8); let n = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
  const [config] = PublicKey.findProgramAddressSync([enc("config")], WARP_PROGRAM_ID);
  const [tokenRegistry] = PublicKey.findProgramAddressSync([enc("token_registry"), X1_WSOLX_MINT.toBytes()], WARP_PROGRAM_ID);
  const [outgoingMsg] = PublicKey.findProgramAddressSync([enc("evt_out"), u64le(built.seq)], WARP_PROGRAM_ID);

  const expected = [
    config,                    // 0 config
    tokenRegistry,             // 1 token_registry (wSOL.X registry PDA)
    outgoingMsg,               // 2 outgoing_msg
    USER,                      // 3 sender (signer)
    userWsolxAta,              // 4 user's wSOL.X ATA (Token-2022 burn source)
    X1_WSOLX_MINT,             // 5 wSOL.X mint (burned)
    WARP_PROGRAM_ID,           // 6 program self (optional vault slot — Anchor fills nulls with the program ID)
    WARP_PROGRAM_ID,           // 7 program self (optional vault_token_account slot)
    new PublicKey("7bz2ZNphReLcmwv1tbhG8VnR1RzAzyxPNuKa3s2Jig7j"), // 8 fee collector wallet
    X1_WSOLX_FEE_ACCOUNT,      // 9 wSOL.X fee collector ATA (9Tdid7tM… — live config)
    TOKEN_2022_PROGRAM_ID,     // 10 Token-2022 program (wSOL.X is Token-2022)
    SystemProgram.programId,   // 11 system program
  ];
  for (let i = 0; i < 12; i++) {
    const key = ix.keys[i];
    assert.ok(key.pubkey.equals(expected[i]), `slot ${i}: expected ${expected[i].toBase58()}, got ${key.pubkey.toBase58()}`);
  }
  assert.ok(!ix.keys.some((k) => k.pubkey.toBase58().startsWith("GiTfQ")), "NO mint_authority PDA in bridge_out (that PDA belongs to bridge_in_v2, the receive side)");

  // 9-dec amount math: 25 wSOL.X = 25_000_000_000 base units.
  const amountLE = ix.data.slice(16, 24);
  let amt = 0n; for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(amountLE[i]);
  assert.equal(amt, 25_000_000_000n, "burn amount = 25 wSOL.X in 9-dec base units");
  assert.equal(ix.data.length, 24, "disc + seq + amount");
  assert.deepEqual([...ix.data.slice(0, 8)], [27, 194, 57, 119, 215, 165, 247, 150], "current program's BridgeOut discriminator");
});

test("toBaseUnits/fromBaseUnits: token-aware decimals — 9 for wSOL.X/WSOL, 6 for USDC.x/USDC", () => {
  assert.equal(toBaseUnits(25, 9), 25_000_000_000n, "25 wSOL.X → 9-dec base");
  assert.equal(toBaseUnits(25, 6), 25_000_000n, "25 USDC.x → 6-dec base");
  assert.equal(toBaseUnits(25), 25_000_000n, "default stays 6-dec (back-compat)");
  assert.equal(fromBaseUnits(25_000_000_000n, 9), 25, "9-dec base → 25 human");
  assert.equal(fromBaseUnits(25_000_000n, 6), 25, "6-dec base → 25 human");
  assert.equal(fromBaseUnits(25_000_000n), 25, "default stays 6-dec");
});

test("ensureX1FeeWalletAta: builds an idempotent wSOL.X ATA create for the fee wallet (payer = user) when missing", async () => {
  const conn = mockX1ConnectionWsol({ feeAtaExists: false });
  const res = await ensureX1FeeWalletAta({
    connection: conn, userPubkey: USER, feeWallet: FEE_WALLET, payer: USER,
    mint: X1_WSOLX_MINT, decimals: 9,
  });
  assert.equal(res.needsCreation, true);
  assert.ok(res.instruction, "bundled create instruction returned");
  const expectedAta = getAssociatedTokenAddressSync(X1_WSOLX_MINT, FEE_WALLET, true, TOKEN_2022_PROGRAM_ID);
  assert.ok(res.ata.equals(expectedAta), "fee wallet's wSOL.X ATA");
  const createIx = res.instruction;
  assert.ok(createIx.keys.some((k) => k.pubkey.equals(expectedAta)), "create targets the fee wallet's wSOL.X ATA");
  assert.ok(createIx.keys.some((k) => k.pubkey.equals(FEE_WALLET)), "owner = the fee wallet");
  assert.ok(createIx.keys.some((k) => k.pubkey.equals(X1_WSOLX_MINT)), "mint = wSOL.X");
});

test("ensureX1FeeWalletAta: no-op when the fee wallet's wSOL.X ATA already exists", async () => {
  const conn = mockX1ConnectionWsol({ feeAtaExists: true });
  const res = await ensureX1FeeWalletAta({
    connection: conn, userPubkey: USER, feeWallet: FEE_WALLET, payer: USER,
    mint: X1_WSOLX_MINT, decimals: 9,
  });
  assert.equal(res.needsCreation, false);
});

test("runReverse (wSOL.X, sim mode): bundled fee-ATA create → 9-dec skim transfer → burn in ONE tx; WARP_LIVE_SEND gate holds (nothing broadcast)", async () => {
  const conn = mockX1ConnectionWsol({ feeAtaExists: false, wsolBalance: 5_000_000_000_000n }); // 5000 wSOL.X
  const wallet = {
    publicKey: USER,
    calls: [],
    async signTransaction(tx) { this.calls.push({ method: "signTransaction" }); return tx; },
    async signAndSendTransaction() { this.calls.push({ method: "signAndSendTransaction" }); return "sig"; },
  };
  const res = await runReverse({
    connection: conn, userPubkey: USER,
    amountHuman: 99, // burn gross (post-skim)
    feeAmount: 0.5,  // 0.5% skim of a 100 wSOL.X gross, in wSOL.X
    feeWallet: FEE_WALLET,
    allowLive: false, // the WARP_LIVE_SEND gate — must hold
    provider: wallet,
    token: "wSOL.X",
  });
  assert.equal(res.stage, "simulated_ok", "simulated only — live sends are OFF");
  assert.equal(res.success, true);
  assert.equal(wallet.calls.length, 0, "wallet never asked to sign in sim mode");

  const ixs = res.built.transaction.instructions;
  const burnIx = ixs.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  assert.ok(burnIx, "bridge_out present");
  // create → skim transfer → burn (3 instructions: the create + transfer + bridge_out).
  assert.equal(ixs.length, 3, "create (fee ATA) + skim transfer + burn in ONE tx");
  const transferIx = ixs[1];
  assert.ok(transferIx.keys.some((k) => k.pubkey.equals(
    getAssociatedTokenAddressSync(X1_WSOLX_MINT, FEE_WALLET, true, TOKEN_2022_PROGRAM_ID),
  )), "skim transfer targets the fee wallet's wSOL.X ATA");
  const amountLE = burnIx.data.slice(16, 24);
  let amt = 0n; for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(amountLE[i]);
  assert.equal(amt, 99_000_000_000n, "burn amount = 99 wSOL.X in 9-dec base units");
});

test("runReverse (wSOL.X, live mode): ONE guarded send through the X1 connection when WARP_LIVE_SEND allows", async () => {
  const userKp = Keypair.generate();
  const conn = mockX1ConnectionWsol({ userPubkey: userKp.publicKey, feeAtaExists: true, wsolBalance: 5_000_000_000_000n });
  const wallet = mockWallet({ keypairs: [userKp] });
  const res = await runReverse({
    connection: conn, userPubkey: userKp.publicKey,
    amountHuman: 99,
    feeAmount: 1,
    feeWallet: FEE_WALLET,
    allowLive: true, // armed
    provider: wallet,
    token: "wSOL.X",
  });
  assert.equal(res.stage, "sent", "live burn broadcast");
  assert.equal(res.signature, "x1-wsol-burn-sig");
  assert.ok(wallet.calls.some((c) => c.method === "signTransaction"), "wallet signed via signTransaction");
  assert.ok(conn.calls.includes("simulateTransaction"), "fail-closed sim ran before the send");
  assert.ok(conn.calls.includes("sendRawTransaction"), "broadcast through the X1 connection");
  assert.equal(conn.calls.filter((c) => c === "sendRawTransaction").length, 1, "single broadcast");
  // The burn amount stays 9-dec: 99 wSOL.X = 99_000_000_000 base.
  const burn = res.built.transaction.instructions.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  let amt = 0n; const amountLE = burn.data.slice(16, 24);
  for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(amountLE[i]);
  assert.equal(amt, 99_000_000_000n, "burn amount in 9-dec wSOL.X base units");
});

test("buildStage2 (destToken=wSOL.X): WSOL source mint, per-mint vault PDAs, GxfLqezi fee account, 9-dec skim, bundled fee-ATA create when the fee wallet's WSOL ATA is missing", async () => {
  // A connection that reports the fee wallet's WSOL ATA as MISSING (verified on
  // mainnet: Ewi8CcePvnomV87z5pUpasVbhKBn4Xh61rMnbY4KP8Hf does not exist).
  const feeWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, FEE_WALLET);
  const conn = {
    async getSlot() { return 123_456_789; },
    async getLatestBlockhash() { return { blockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: 99 }; },
    async getAccountInfo(pk) {
      if (pk.equals(feeWsolAta)) return null; // fee wallet's WSOL ATA missing
      return { lamports: 10_000_000 };
    },
  };
  const built = await buildStage2({
    connection: conn,
    userPubkey: USER,
    feeWalletSvm: FEE_WALLET,
    amountHuman: 25, // 25 WSOL (9 decimals)
    destToken: "wSOL.X",
  });
  const ixs = built.transaction.instructions;
  // compute budget + fee-ATA create + skim transfer + bridge_out
  assert.equal(ixs.length, 4, "compute budget + fee-ATA create + skim transfer + bridge_out");
  const createIx = ixs[1];
  assert.ok(createIx.keys.some((k) => k.pubkey.equals(feeWsolAta)), "idempotent create for the fee wallet's WSOL ATA bundled first");
  assert.equal(built.feeAtaCreated, true, "fee ATA create was bundled");

  const burnIx = ixs.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  assert.ok(burnIx, "bridge_out present");
  const enc = (s) => new TextEncoder().encode(s);
  const [vault] = PublicKey.findProgramAddressSync([enc("vault"), WSOL_MINT.toBytes()], WARP_PROGRAM_ID);
  const vaultAta = getAssociatedTokenAddressSync(WSOL_MINT, vault, true, TOKEN_PROGRAM_ID);
  const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, USER);
  const expected = [
    WARP_ACCOUNTS.config,
    WARP_ACCOUNTS.tokenRegistry,
    built.outgoing_msg,
    USER,
    userWsolAta,
    WSOL_MINT,                                   // source mint = WSOL (native, spl-token v1)
    vault,                                       // vault PDA ["vault", WSOL] (9ZFmvmJk… on mainnet)
    vaultAta,                                    // vault WSOL token account
    WARP_ACCOUNTS.feePda,
    new PublicKey("GxfLqeziL8wrUF31H1thWVAHkqzPodoqbwZeoDTRAkyU"), // Solana wSOL fee collector ATA (live config)
    TOKEN_PROGRAM_ID,                            // spl-token v1 (WSOL is native)
    SystemProgram.programId,
  ];
  for (let i = 0; i < 12; i++) {
    assert.ok(burnIx.keys[i].pubkey.equals(expected[i]), `slot ${i}: expected ${expected[i].toBase58()}, got ${burnIx.keys[i].pubkey.toBase58()}`);
  }
  // 9-dec skim math: 25 WSOL gross → 0.125 skim → 24.875 bridge amount (0.5%).
  const amountLE = burnIx.data.slice(16, 24);
  let amt = 0n; for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(amountLE[i]);
  assert.equal(amt, 24_875_000_000n, "bridge amount = 24.875 WSOL (25 − 0.5% skim) in 9-dec base");
});

test("deriveVaultAccounts: WSOL vault derivation matches the live mainnet PDA (9ZFmvmJk…) and the USDC derivation equals WARP_ACCOUNTS.vault", () => {
  const { vault: wsolVault } = deriveVaultAccounts(WSOL_MINT, TOKEN_PROGRAM_ID);
  assert.equal(wsolVault.toBase58(), "9ZFmvmJkSpSuesGfSXj5VftVSDQpPNpFzu1vFi3yYeTG", "WSOL vault PDA verified on Solana mainnet");
  const { vault: usdcVault, vaultTokenAccount: usdcVaultAta } = deriveVaultAccounts(USDC_MINT, TOKEN_PROGRAM_ID);
  assert.ok(usdcVault.equals(WARP_ACCOUNTS.vault), "USDC vault derivation = the known mainnet vault (C6byAvMf…)");
  assert.ok(usdcVaultAta.equals(WARP_ACCOUNTS.vaultTokenAccount), "USDC vault ATA derivation = the known mainnet vault ATA (H3E5ywp…)");
});

test("X1_REVERSE_TOKENS / X1_FORWARD_TOKENS: ground-truth mints + fee accounts from the live Warp config", () => {
  // Reverse (X1 → Solana) — the burn side.
  assert.equal(X1_REVERSE_TOKENS["USDC.x"].mint.toBase58(), "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
  assert.equal(X1_REVERSE_TOKENS["USDC.x"].decimals, 6);
  assert.equal(X1_REVERSE_TOKENS["USDC.x"].feeAccount.toBase58(), "4uRFjqVU5ZKkp7hQLx3Lm3YeWFts17ER8a5HLUE18ayG");
  assert.equal(X1_REVERSE_TOKENS["wSOL.X"].mint.toBase58(), "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8");
  assert.equal(X1_REVERSE_TOKENS["wSOL.X"].decimals, 9);
  assert.equal(X1_REVERSE_TOKENS["wSOL.X"].feeAccount.toBase58(), "9Tdid7tM1bKv8hMyiTDLfB2LhfCGoaBv5GoezQzW2VP9");
  // Forward (Solana → X1) — the lock side.
  assert.equal(X1_FORWARD_TOKENS["USDC.x"].sourceMint.toBase58(), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(X1_FORWARD_TOKENS["USDC.x"].destMint.toBase58(), "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
  assert.equal(X1_FORWARD_TOKENS["wSOL.X"].sourceMint.toBase58(), "So11111111111111111111111111111111111111112");
  assert.equal(X1_FORWARD_TOKENS["wSOL.X"].destMint.toBase58(), "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8");
  assert.equal(X1_FORWARD_TOKENS["wSOL.X"].feeAccount.toBase58(), "GxfLqeziL8wrUF31H1thWVAHkqzPodoqbwZeoDTRAkyU");
  assert.equal(X1_FORWARD_TOKENS["wSOL.X"].decimals, 9);
});
