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
} from "./warpBridge.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
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
  assert.equal(SKIM_BPS, 100n); // 1.00% — the rate actually charged today
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
