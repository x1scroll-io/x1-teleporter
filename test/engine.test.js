/**
 * engine.test.js — the routing-engine Phase 1 tests (src/engine/*).
 *
 * What these prove, on top of the UNCHANGED instruments
 * (test/golden.test.js + e2e/forward-leg.spec.js):
 *
 *   1. LegContract lifecycle — the five phases run in contract order
 *      (build → simulate → requestSignature → submit → confirm); a failed or
 *      skipped simulation NEVER reaches the wallet/network; undefined phases
 *      are skipped; a throwing sim propagates.
 *   2. SignerResolver — keyed by chain family; evm returns the PROVEN
 *      resolveEvmProvider result, svm the PROVEN resolveSolanaAdapter result
 *      (same session shapes the reference path resolves).
 *   3. RoutePlanner stub — the forward route plans EXACTLY four legs in
 *      order (approval → LiFi bridge → ATA create → warp lock), grouped into
 *      the two UI stages; unplanned directions return null (reverse/THORChain/
 *      DEX stay on their own paths).
 *   4. BYTE IDENTITY vs the golden fixtures — every leg builder's artifact is
 *      canonical-JSON-identical to its fixture and sha256-equal (step1 + 2a +
 *      2b artifacts AND the serialized tx bytes, step3 account construction +
 *      spec), and the cross-step chain of custody holds (the guardians'
 *      recipient ATA == the ATA step2a creates; the bridge_in_v2 amount ==
 *      the warp lock's post-skim bridge amount; the stage-1 calldata the
 *      engine forwards hashes to the recorded quoteReference).
 *   5. Stage-runner parity — the EVM stage returns { stage, txHash } with the
 *      reference sim-gate + error semantics; the SVM stage returns the
 *      runStage2 result shape (x1_ata_simulation / simulation /
 *      simulated_ok / sent) with the same fail-closed gates.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, Transaction, Keypair } from "@solana/web3.js";

import {
  canonicalJson,
  sha256Of,
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  FEE_WALLET_SVM,
  LIFI_DIAMOND_ETH,
  FIXED_BLOCKHASH,
  FIXED_SEQ_SLOT,
} from "./golden/forwardLegBuilders.mjs";
import {
  createLeg,
  runLeg,
  LEG_PHASES,
} from "../src/engine/legContract.js";
import {
  resolveSigner,
  familyCanSign,
  SIGNER_FAMILIES,
} from "../src/engine/signerResolver.js";
import {
  planForward,
  plan,
  legById,
  legsForStage,
  FORWARD_LEG_IDS,
} from "../src/engine/routePlanner.js";
import {
  buildApprovalArtifact,
  buildBridgeTxArtifact,
  shapeAtaCreateArtifact,
  shapeWarpLockArtifact,
  deriveBridgeInV2AccountList,
} from "../src/engine/index.js";
import { runForwardEvmStage } from "../src/engine/runners/forwardEvmStage.js";
import { runForwardSvmStage } from "../src/engine/runners/forwardSvmStage.js";
import {
  encodeWarpSeq,
  X1_USDCX_MINT,
  USDC_MINT,
  SKIM_BPS,
  X1_FORWARD_TOKENS,
} from "../src/warpBridge.js";
import { SimulationError } from "../src/lib/simulateTx.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "golden", "forward-leg");
const read = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const QUOTE = read("quote-eth-sol-usdc-25.65.json");
const FIX_STEP1 = read("step1-approval.json");
const FIX_STEP2A = read("step2a-x1-ata-prep.json");
const FIX_STEP2B = read("step2b-warp-lock.json");
const FIX_STEP3 = read("step3-bridge-in-v2.json");
const SUMMARY = read("forward-leg-summary.json");

const USER = new PublicKey(SOLANA_ADDRESS);
const FEE_WALLET = new PublicKey(FEE_WALLET_SVM);

// The deterministic inputs the fixtures were captured with.
const DELIVERED_HUMAN = Number(QUOTE.estimate.toAmount) / 10 ** 6; // 25.554929
const SEQ = encodeWarpSeq(FIXED_SEQ_SLOT, 0); // source Solana(0) → X1(1)

// ─────────────────────────────────────────────────────────────────────────────
// TEST DOUBLEs (mirror the shapes the reference tests use)
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic Solana connection: fee payer exists, fee-wallet USDC ATA
 *  exists (the live shape — no bundled fee-ATA create), sims pass, and the
 *  seq comes from a FIXED slot via getSlot (fetchSeq's DI seam — the same
 *  way warpBridge.test.js keeps runStage2 deterministic offline). */
function mockSolanaConnection({ simOk = true, feePayerExists = true } = {}) {
  const calls = [];
  return {
    calls,
    async getSlot() {
      calls.push("getSlot");
      return FIXED_SEQ_SLOT;
    },
    async getLatestBlockhash() {
      calls.push("getLatestBlockhash");
      return { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: 99 };
    },
    async getAccountInfo() {
      calls.push("getAccountInfo");
      return feePayerExists ? { lamports: 5_000_000 } : null; // fee-payer + fee ATA both "exist"
    },
    async simulateTransaction() {
      calls.push("simulateTransaction");
      return simOk
        ? { value: { err: null, logs: ["Program log: Instruction: BridgeOut"], unitsConsumed: 12345 } }
        : { value: { err: "AccountNotFound", logs: [] } };
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
}

/** Deterministic X1 connection: the recipient ATA is missing (needs creation). */
function mockX1Connection({ simOk = true } = {}) {
  const calls = [];
  return {
    calls,
    async getLatestBlockhash() {
      calls.push("getLatestBlockhash");
      return { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: 99 };
    },
    async getAccountInfo() {
      calls.push("getAccountInfo");
      return null; // recipient ATA missing → needsCreation
    },
    async simulateTransaction() {
      calls.push("simulateTransaction");
      return simOk ? { value: { err: null, logs: [] } } : { value: { err: "custom program error", logs: [] } };
    },
    async sendRawTransaction() {
      calls.push("sendRawTransaction");
      return "x1-raw-sig";
    },
    async confirmTransaction() {
      calls.push("confirmTransaction");
      return { value: { err: null } };
    },
  };
}

/** Sign-capable Solana adapter (Wallet-Standard shape). With a real keypair
 *  the mock signs VALID ed25519 signatures (web3.js serialize() verifies them
 *  by default) — the reference tests' approach. */
function makeSolAdapter({ publicKey = USER, keypair = null } = {}) {
  return {
    publicKey,
    async signTransaction(tx) {
      if (keypair) tx.partialSign(keypair);
      return tx;
    },
    async signAndSendTransaction() {
      return { signature: "adapter-sig" };
    },
  };
}

/** Recording EIP-1193 provider. allowanceHex: what allowance() returns.
 *  revertSim: eth_call throws a decodable Error(string) revert. sendMode:
 *  "hash" (resolves), "hang" (never), "reject" (4001). */
function makeEvmProvider({
  allowanceHex = "0x0000000000000000000000000000000000000000000000000000000000000000",
  revertSim = false,
  sendMode = "hash",
  receipt = { blockNumber: "0x1", status: "0x1" },
} = {}) {
  const calls = [];
  const sends = [];
  const revertData =
    "0x08c379a0" +
    "0".repeat(62) + "20" +
    "0".repeat(62) + "12" +
    Buffer.from("Not enough balance").toString("hex").padEnd(64, "0");
  const request = async ({ method, params = [] }) => {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId":
        return "0x1";
      case "eth_call": {
        const data = String(params?.[0]?.data || "0x");
        if (data.startsWith("0xdd62ed3e")) return allowanceHex; // allowance read
        if (revertSim) {
          const err = new Error("execution reverted: Not enough balance");
          err.data = revertData;
          throw err;
        }
        return "0x";
      }
      case "eth_estimateGas":
        return "0x5208";
      case "eth_sendTransaction": {
        sends.push(params[0]);
        if (sendMode === "hang") return new Promise(() => {});
        if (sendMode === "reject") {
          const err = new Error("User rejected the request.");
          err.code = 4001;
          throw err;
        }
        return "0xbridgehash";
      }
      case "eth_getTransactionReceipt":
        return receipt;
      default:
        return null;
    }
  };
  return { provider: { request }, calls, sends };
}

/** Stub /api/lifi/tools (and any other fetch) with a canned response. */
function stubFetch(jsonBody) {
  const fetcher = mock.fn(async () => ({ ok: true, json: async () => jsonBody }));
  mock.method(globalThis, "fetch", fetcher);
  return fetcher;
}

/** The /v1/tools body for chain 1 — the SAME fixture the browser harness
 *  intercepts with (e2e/fixtures/tools-chain-1.json — contains
 *  relaydepository, the frozen quote's tool). */
function toolsBody() {
  return JSON.parse(
    readFileSync(join(here, "..", "e2e", "fixtures", "tools-chain-1.json"), "utf8"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LegContract lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test("engine legContract: the five phases run in contract order (build → simulate → requestSignature → submit → confirm)", async () => {
  const order = [];
  const leg = createLeg({
    id: "fake-full",
    family: "evm",
    chain: "eth",
    phases: {
      build: async () => { order.push("build"); return { artifact: "a" }; },
      simulate: async () => { order.push("simulate"); return { ok: true }; },
      requestSignature: async () => { order.push("requestSignature"); return "sig"; },
      submit: async () => { order.push("submit"); return "hash"; },
      confirm: async () => { order.push("confirm"); return { receipt: true }; },
    },
  });
  const trace = await runLeg(leg, {});
  assert.deepEqual(order, ["build", "simulate", "requestSignature", "submit", "confirm"]);
  assert.equal(trace.stoppedAt, null);
  assert.equal(trace.results.submit, "hash");
  assert.equal(trace.results.confirm.receipt, true);
  assert.deepEqual(LEG_PHASES, ["build", "simulate", "requestSignature", "submit", "confirm"]);
});

test("engine legContract: a non-ok simulation BLOCKS submit/confirm (failed sim never reaches the wallet)", async () => {
  const order = [];
  const leg = createLeg({
    id: "fake-simfail",
    family: "svm",
    chain: "sol",
    phases: {
      build: async () => { order.push("build"); return { needed: true }; },
      simulate: async () => { order.push("simulate"); return { ok: false, err: "program rejected" }; },
      submit: async () => { order.push("submit"); return "hash"; },
    },
  });
  const trace = await runLeg(leg, {});
  assert.deepEqual(order, ["build", "simulate"]);
  assert.equal(trace.stoppedAt, "simulate");
  assert.equal(trace.results.submit, undefined);
});

test("engine legContract: a skipSubmit marker stops the lifecycle after simulate", async () => {
  const order = [];
  const leg = createLeg({
    id: "fake-skip",
    family: "evm",
    chain: "eth",
    phases: {
      build: async () => { order.push("build"); return { needed: true }; },
      simulate: async () => { order.push("simulate"); return { ok: true, skipSubmit: true, reason: "allowance-sufficient" }; },
      submit: async () => { order.push("submit"); return "hash"; },
      confirm: async () => { order.push("confirm"); return {}; },
    },
  });
  const trace = await runLeg(leg, {});
  assert.deepEqual(order, ["build", "simulate"]);
  assert.equal(trace.stoppedAt, "simulate");
});

test("engine legContract: undefined phases are skipped; a throwing sim propagates and submit never runs", async () => {
  const order = [];
  const leg = createLeg({
    id: "fake-throw",
    family: "evm",
    chain: "eth",
    phases: {
      build: async () => { order.push("build"); return {}; },
      simulate: async () => { order.push("simulate"); throw new SimulationError("Simulation failed: nope", { code: "evm-revert" }); },
      submit: async () => { order.push("submit"); return "hash"; },
    },
  });
  await assert.rejects(() => runLeg(leg, {}), SimulationError);
  assert.deepEqual(order, ["build", "simulate"]); // no submit on a doomed tx
});

test("engine legContract: createLeg rejects bad definitions", () => {
  assert.throws(() => createLeg({ id: "", family: "evm", phases: {} }));
  assert.throws(() => createLeg({ id: "x", family: "cosmos", phases: {} }));
  assert.throws(() => createLeg({ id: "x", family: "evm", phases: { build: "not-a-fn" } }));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SignerResolver (reuses the PROVEN sessionProviders resolvers)
// ─────────────────────────────────────────────────────────────────────────────

test("engine signerResolver: evm resolves the PROVEN EIP-1193 provider shapes", async () => {
  // raw EIP-1193 provider passes through
  const raw = { request: async () => "0x" };
  assert.equal(await resolveSigner("evm", { provider: raw }), raw);
  // real adapter shape — discovered wagmi connector getProvider()
  const inner = { request: async () => "0x" };
  const wrapper = { provider: { discovered: { provider: { getProvider: async () => inner } } } };
  assert.equal(await resolveSigner("evm", wrapper), inner);
  // no signing surface → null
  assert.equal(await resolveSigner("evm", { provider: { connect: async () => {} } }), null);
  assert.equal(await resolveSigner("evm", null), null);
});

test("engine signerResolver: svm resolves the PROVEN sign-capable Solana adapter shapes", async () => {
  const adapter = { publicKey: USER, signAndSendTransaction: async () => ({ signature: "s" }) };
  // real Wallet-Standard wrapper: adapter behind provider.adapter
  assert.equal(await resolveSigner("svm", { provider: { adapter } }), adapter);
  // raw adapter passes through
  assert.equal(await resolveSigner("svm", { provider: adapter }), adapter);
  // nothing sign-capable (mock providers by design) → null
  assert.equal(await resolveSigner("svm", { provider: { connect: async () => {} } }), null);
  assert.equal(await resolveSigner("svm", null), null);
  // sync hint
  assert.equal(familyCanSign("svm", { provider: { adapter } }), true);
  assert.equal(familyCanSign("svm", { provider: { connect: async () => {} } }), false);
});

test("engine signerResolver: unknown families resolve null (fail-soft)", async () => {
  assert.equal(await resolveSigner("cosmos", { provider: {} }), null);
  assert.equal(SIGNER_FAMILIES.evm, "evm");
  assert.equal(SIGNER_FAMILIES.svm, "svm");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. RoutePlanner stub
// ─────────────────────────────────────────────────────────────────────────────

test("engine routePlanner: the forward route plans EXACTLY the four legs in order, grouped into the two UI stages", () => {
  const route = planForward();
  assert.equal(route.id, "forward-eth-x1");
  assert.equal(route.direction, "forward");
  assert.deepEqual(route.legs.map((l) => l.id), [...FORWARD_LEG_IDS]);
  assert.deepEqual(route.legs.map((l) => l.family), ["evm", "evm", "svm", "svm"]);
  assert.deepEqual(legsForStage(route, "evm").map((l) => l.id), ["evm-approval", "lifi-evm-bridge"]);
  assert.deepEqual(legsForStage(route, "svm").map((l) => l.id), ["x1-ata-create", "warp-lock"]);
  assert.equal(legById(route, "warp-lock").id, "warp-lock");
  assert.equal(legById(route, "thorchain-deposit"), null);
});

test("engine routePlanner: unplanned directions return null — reverse/THORChain/DEX are NOT planned here", () => {
  assert.equal(plan({ direction: "forward" }).id, "forward-eth-x1");
  assert.equal(plan({ direction: "reverse" }), null);
  assert.equal(plan({ direction: "thorchain" }), null);
  assert.equal(plan({ direction: "dex" }), null);
  assert.equal(plan({}).id, "forward-eth-x1"); // forward is the Phase-1 default
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. BYTE IDENTITY vs the golden fixtures (the engine is the WRONG one if any
//    of these differ — fix the engine, never the oracle)
// ─────────────────────────────────────────────────────────────────────────────

test("engine byte-identity step1: approvalLeg.build artifact == golden step1 (canonical JSON + sha256)", () => {
  const built = buildApprovalArtifact({ lifiData: QUOTE, address: EVM_ADDRESS });
  assert.equal(built.needed, true);
  assert.equal(canonicalJson(built.artifact), canonicalJson(FIX_STEP1.artifact));
  assert.equal(sha256Of(built.artifact), FIX_STEP1.sha256);
  // The PR #3 invariants hold on the engine's artifact too.
  assert.equal(built.artifact.selector, "0x095ea7b3");
  assert.equal(built.artifact.spender, LIFI_DIAMOND_ETH.toLowerCase());
  assert.equal(built.artifact.amountRaw, "25650000");
  assert.equal(built.artifact.calldata.endsWith("f".repeat(64)), false); // never MaxUint256
  assert.equal(built.artifact.txParams.data, built.artifact.calldata);
  assert.equal(built.artifact.txParams.value, "0x0");
});

test("engine byte-identity stage-1 bridge: lifiEvmLeg forwards the quote VERBATIM (txDataSha256 == the recorded quoteReference)", async () => {
  const built = await buildBridgeTxArtifact({ lifiData: QUOTE, address: EVM_ADDRESS });
  const txReq = QUOTE.transactionRequest;
  assert.equal(built.artifact.txDataSha256, SUMMARY.quoteReference.txDataSha256);
  assert.equal(built.artifact.to, SUMMARY.quoteReference.txTo);
  assert.equal(built.artifact.chainId, txReq.chainId);
  assert.equal(built.artifact.value, txReq.value);
  // The exact params the wallet will be asked to sign:
  assert.equal(built.artifact.txParams.from, EVM_ADDRESS.toLowerCase());
  assert.equal(built.artifact.txParams.to, txReq.to);
  assert.equal(built.artifact.txParams.data, txReq.data); // verbatim — no rewrite
  assert.equal(built.artifact.txParams.value, txReq.value || "0x0");
  assert.equal(built.artifact.txParams.gas, txReq.gasLimit); // gasLimit carried as-is
});

test("engine byte-identity step2a: ataCreateLeg artifact == golden step2a (canonical JSON + sha256 + serialized bytes)", async () => {
  const x1 = mockX1Connection();
  const prep = await (async () => {
    const { ensureX1RecipientAta } = await import("../src/warpBridge.js");
    return ensureX1RecipientAta({ connection: x1, userPubkey: USER, payer: USER, mint: X1_USDCX_MINT });
  })();
  assert.equal(prep.needsCreation, true);
  const artifact = shapeAtaCreateArtifact({
    prep,
    solanaAddress: SOLANA_ADDRESS,
    blockhash: FIXED_BLOCKHASH,
    mint: X1_USDCX_MINT,
  });
  assert.equal(canonicalJson(artifact), canonicalJson(FIX_STEP2A.artifact));
  assert.equal(sha256Of(artifact), FIX_STEP2A.sha256);
  const { sha256Bytes } = await import("./golden/forwardLegBuilders.mjs");
  assert.equal(sha256Bytes(Buffer.from(artifact.serializedBase64, "base64")), FIX_STEP2A.bytesSha256);
  // Deserializes to the same single-instruction Token-2022 create.
  const tx = Transaction.from(Buffer.from(artifact.serializedBase64, "base64"));
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.feePayer.toBase58(), SOLANA_ADDRESS);
  assert.equal(tx.recentBlockhash, FIXED_BLOCKHASH);
});

test("engine byte-identity step2b: warpLockLeg artifact == golden step2b (canonical JSON + sha256 + serialized bytes)", async () => {
  const sol = mockSolanaConnection();
  const { buildStage2 } = await import("../src/warpBridge.js");
  const built = await buildStage2({
    connection: sol,
    userPubkey: USER,
    feeWalletSvm: FEE_WALLET,
    amountHuman: DELIVERED_HUMAN,
    seq: SEQ,
    destToken: "USDC.x",
  });
  const artifact = shapeWarpLockArtifact({
    built,
    amountHuman: DELIVERED_HUMAN,
    destToken: "USDC.x",
    blockhash: FIXED_BLOCKHASH,
    seqSlot: FIXED_SEQ_SLOT,
  });
  assert.equal(canonicalJson(artifact), canonicalJson(FIX_STEP2B.artifact));
  assert.equal(sha256Of(artifact), FIX_STEP2B.sha256);
  const { sha256Bytes } = await import("./golden/forwardLegBuilders.mjs");
  assert.equal(sha256Bytes(Buffer.from(artifact.serializedBase64, "base64")), FIX_STEP2B.bytesSha256);
  // Derived math holds on the engine-shaped artifact.
  assert.equal(artifact.seq, SEQ.toString());
  assert.equal(artifact.grossBase, "25554929");
  assert.equal(artifact.skimBase, ((25554929n * SKIM_BPS) / 10_000n).toString());
  assert.equal(artifact.bridgeBase, (25554929n - (25554929n * SKIM_BPS) / 10_000n).toString());
  assert.equal(artifact.feeAtaCreated, false);
  assert.equal(artifact.instructionCount, 3);
});

test("engine byte-identity step3: deriveBridgeInV2AccountList == golden step3 (account list + spec sha256 + chain of custody)", async () => {
  const skim = (25554929n * SKIM_BPS) / 10_000n;
  const bridgeBase = 25554929n - skim;
  const { artifact, spec } = deriveBridgeInV2AccountList({
    solanaAddress: SOLANA_ADDRESS,
    seq: SEQ,
    amountBase: bridgeBase,
  });
  assert.equal(canonicalJson(artifact), canonicalJson(FIX_STEP3.artifact));
  assert.equal(sha256Of(artifact), FIX_STEP3.sha256);
  assert.equal(canonicalJson(spec.rows), canonicalJson(FIX_STEP3.spec.rows ?? FIX_STEP3.spec));
  assert.equal(spec.rowCount, 14);
  assert.equal(artifact.accountCount, 11);
  // CHAIN OF CUSTODY: the guardians mint into EXACTLY the ATA step2a creates.
  assert.equal(artifact.accountList.find((k) => k.name === "recipient_token_account").pubkey, FIX_STEP2A.artifact.ata);
  // And the wrapped-variant slots: Token-2022 + system program at the tail.
  const list = artifact.accountList;
  assert.equal(list[list.length - 2].pubkey, TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(list[list.length - 1].name, "system_program");
  assert.equal(list[list.length - 1].pubkey, "11111111111111111111111111111111");
});

test("engine byte-identity: the FULL forward capture reproduces all four fixture sha256s + the quote reference", async () => {
  // step1
  const s1 = buildApprovalArtifact({ lifiData: QUOTE, address: EVM_ADDRESS }).artifact;
  assert.equal(sha256Of(s1), SUMMARY.steps.step1Approval.sha256);
  // step2a
  const x1 = mockX1Connection();
  const { ensureX1RecipientAta } = await import("../src/warpBridge.js");
  const prep = await ensureX1RecipientAta({ connection: x1, userPubkey: USER, payer: USER, mint: X1_USDCX_MINT });
  const s2a = shapeAtaCreateArtifact({ prep, solanaAddress: SOLANA_ADDRESS, blockhash: FIXED_BLOCKHASH, mint: X1_USDCX_MINT });
  assert.equal(sha256Of(s2a), SUMMARY.steps.step2aX1AtaPrep.sha256);
  // step2b
  const sol = mockSolanaConnection();
  const { buildStage2 } = await import("../src/warpBridge.js");
  const built = await buildStage2({
    connection: sol, userPubkey: USER, feeWalletSvm: FEE_WALLET,
    amountHuman: DELIVERED_HUMAN, seq: SEQ, destToken: "USDC.x",
  });
  const s2b = shapeWarpLockArtifact({ built, amountHuman: DELIVERED_HUMAN, destToken: "USDC.x", blockhash: FIXED_BLOCKHASH, seqSlot: FIXED_SEQ_SLOT });
  assert.equal(sha256Of(s2b), SUMMARY.steps.step2bWarpLock.sha256);
  // step3 (amountBase = what the lock actually bridged — the same custody link)
  const { artifact: s3 } = deriveBridgeInV2AccountList({ solanaAddress: SOLANA_ADDRESS, seq: SEQ, amountBase: built.bridgeBase });
  assert.equal(sha256Of(s3), SUMMARY.steps.step3BridgeInV2.sha256);
  assert.equal(SUMMARY.derived.bridgeBase, built.bridgeBase.toString());
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Stage-runner parity
// ─────────────────────────────────────────────────────────────────────────────

test("engine forwardEvmStage: no-approval quote → approval leg skips, bridge tx sim-gated + sent once, { stage: evm_sent, txHash }", async () => {
  const route = planForward();
  const { provider, calls, sends } = makeEvmProvider();
  // A LiFi quote with NO approvalAddress (the TeleportTab reference shape).
  const noApprovalQuote = {
    id: "0xmock",
    estimate: { toAmount: "99000000", fromAmount: "100000000" },
    transactionRequest: { chainId: 1, to: "0x1234", data: "0xabcdef", value: "0x0", gasLimit: "0x5208" },
    action: {
      fromToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1 },
      toToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chainId: "SOL" },
    },
  };
  const statuses = [];
  const res = await runForwardEvmStage({
    route, lifiData: noApprovalQuote, provider, address: EVM_ADDRESS,
    onStatus: (m) => statuses.push(m),
  });
  assert.deepEqual(res, { stage: "evm_sent", txHash: "0xbridgehash" });
  assert.equal(sends.length, 1, "exactly ONE eth_sendTransaction (the bridge tx)");
  assert.equal(sends[0].to, "0x1234");
  assert.equal(sends[0].data, "0xabcdef"); // verbatim
  assert.equal(sends[0].gas, "0x5208");
  const methods = calls.map((c) => c.method);
  assert.ok(methods.indexOf("eth_call") < methods.indexOf("eth_sendTransaction"), "sim before send");
  assert.ok(methods.includes("eth_estimateGas"), "gas estimate ran");
  assert.equal(calls.filter((c) => c.method === "eth_sendTransaction").length, 1);
});

test("engine forwardEvmStage: a reverting bridge sim BLOCKS the send (SimulationError, eth_sendTransaction NEVER called)", async () => {
  const route = planForward();
  const { provider, sends } = makeEvmProvider({ revertSim: true });
  const noApprovalQuote = {
    estimate: { toAmount: "99000000", fromAmount: "100000000" },
    transactionRequest: { chainId: 1, to: "0x1234", data: "0xabcdef", value: "0x0" },
    action: { fromToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1 } },
  };
  await assert.rejects(
    () => runForwardEvmStage({ route, lifiData: noApprovalQuote, provider, address: EVM_ADDRESS }),
    (e) => e instanceof SimulationError && /Not enough balance/.test(e.message),
  );
  assert.equal(sends.length, 0, "doomed tx never reaches the wallet");
});

test("engine forwardEvmStage: approval-needed quote signs the EXACT golden approval FIRST, then the bridge (two sends, byte-identical calldata)", async () => {
  const route = planForward();
  stubFetch(toolsBody());
  const { provider, sends } = makeEvmProvider(); // allowance 0 → approval needed
  const statuses = [];
  try {
    const res = await runForwardEvmStage({
      route, lifiData: QUOTE, provider, address: EVM_ADDRESS,
      onStatus: (m) => statuses.push(m),
    });
    assert.equal(res.stage, "evm_sent");
    assert.equal(sends.length, 2, "approval + bridge");
    // First sign request = the golden approval, byte-for-byte.
    assert.equal(sends[0].from.toLowerCase(), EVM_ADDRESS.toLowerCase());
    assert.equal(sends[0].to.toLowerCase(), FIX_STEP1.artifact.tokenAddress);
    assert.equal(sends[0].data, FIX_STEP1.artifact.calldata);
    assert.equal(sends[0].value, "0x0");
    // Second = the bridge tx (the quote forwarded verbatim).
    assert.equal(sends[1].to, QUOTE.transactionRequest.to);
    assert.equal(sends[1].data, QUOTE.transactionRequest.data);
    // The reference status lines fired in order.
    assert.ok(statuses.some((m) => m.includes("Approve token spend first (1 of 2)")), "1-of-2 status");
    assert.ok(statuses.some((m) => m.includes("Approved")), "approved status");
  } finally {
    mock.restoreAll();
  }
});

test("engine forwardEvmStage: a sufficient allowance SKIPS the approval entirely (one send, no approve status)", async () => {
  const route = planForward();
  stubFetch(toolsBody());
  const { provider, sends } = makeEvmProvider({ allowanceHex: "0x" + (25_650_000n).toString(16).padStart(64, "0") });
  try {
    const res = await runForwardEvmStage({ route, lifiData: QUOTE, provider, address: EVM_ADDRESS });
    assert.equal(res.stage, "evm_sent");
    assert.equal(sends.length, 1, "only the bridge tx");
    assert.equal(sends[0].data, QUOTE.transactionRequest.data);
  } finally {
    mock.restoreAll();
  }
});

test("engine forwardEvmStage: a wallet rejection of the approval surfaces the reference 'Token approval failed' wrap", async () => {
  const route = planForward();
  stubFetch(toolsBody());
  const { provider, sends } = makeEvmProvider({ sendMode: "reject" });
  try {
    await assert.rejects(
      () => runForwardEvmStage({ route, lifiData: QUOTE, provider, address: EVM_ADDRESS }),
      (e) => /Token approval failed: User rejected the request/.test(e.message),
    );
    assert.equal(sends.length, 1, "only the approval was attempted; the bridge was never asked");
  } finally {
    mock.restoreAll();
  }
});

test("engine forwardEvmStage: LiFiApprovalValidationError propagates UNWRAPPED (fail-closed spender check)", async () => {
  const route = planForward();
  const badQuote = JSON.parse(JSON.stringify(QUOTE));
  badQuote.estimate.approvalAddress = "0x000000000000000000000000000000000000dEaD"; // not the Diamond
  // tools fetch fails → ALSO fail-closed; validate aborts either way
  mock.method(globalThis, "fetch", async () => ({ ok: false, json: async () => ({}) }));
  const { provider } = makeEvmProvider();
  try {
    const { LiFiApprovalValidationError } = await import("../src/lib/lifiApproval.js");
    await assert.rejects(
      () => runForwardEvmStage({ route, lifiData: badQuote, provider, address: EVM_ADDRESS }),
      (e) => e instanceof LiFiApprovalValidationError,
    );
  } finally {
    mock.restoreAll();
  }
});

test("engine forwardSvmStage (sim mode): X1 ATA prep simulated + Warp lock simulated → { stage: simulated_ok }, nothing broadcast", async () => {
  const route = planForward();
  const sol = mockSolanaConnection();
  const x1 = mockX1Connection();
  const res = await runForwardSvmStage({
    route,
    solAdapter: makeSolAdapter(),
    amountHuman: DELIVERED_HUMAN,
    allowLive: false,
    destToken: "USDC.x",
    feeWalletSvm: FEE_WALLET,
    connections: { solana: sol, x1 },
  });
  assert.equal(res.stage, "simulated_ok");
  assert.equal(res.success, true);
  assert.equal(res.sent, null);
  assert.ok(res.sim.ok, "solana sim passed");
  assert.ok(res.prep.needsCreation, "the X1 ATA was missing → prep built a create tx");
  assert.ok(!sol.calls.includes("sendRawTransaction"), "nothing broadcast on Solana");
  assert.ok(!x1.calls.includes("sendRawTransaction"), "nothing broadcast on X1");
  // The result shape the form reads (runStage2 parity) — seq from the fixed
  // getSlot mock, NOT a live RPC fallback.
  assert.equal(res.built.destToken, "USDC.x");
  assert.equal(res.built.seq.toString(), SEQ.toString());
});

test("engine forwardSvmStage (live mode): ATA broadcast on X1, then the Warp lock sent on Solana → { stage: sent, signature }", async () => {
  const route = planForward();
  const sol = mockSolanaConnection();
  const x1 = mockX1Connection();
  const userKp = Keypair.generate(); // real keypair → VALID signatures (serialize verifies)
  const res = await runForwardSvmStage({
    route,
    solAdapter: makeSolAdapter({ publicKey: userKp.publicKey, keypair: userKp }),
    amountHuman: DELIVERED_HUMAN,
    allowLive: true,
    destToken: "USDC.x",
    feeWalletSvm: FEE_WALLET,
    connections: { solana: sol, x1 },
  });
  assert.equal(res.stage, "sent");
  assert.equal(res.success, true);
  assert.equal(res.signature, "raw-sig");
  assert.ok(x1.calls.includes("sendRawTransaction"), "X1 ATA create broadcast through the X1 connection");
  assert.ok(sol.calls.includes("sendRawTransaction"), "Warp lock broadcast through the Solana connection");
});

test("engine forwardSvmStage: a failing X1 ATA sim returns { stage: x1_ata_simulation, success: false } (fail-closed)", async () => {
  const route = planForward();
  const sol = mockSolanaConnection();
  const x1 = mockX1Connection({ simOk: false });
  const res = await runForwardSvmStage({
    route,
    solAdapter: makeSolAdapter(),
    amountHuman: DELIVERED_HUMAN,
    allowLive: false,
    destToken: "USDC.x",
    feeWalletSvm: FEE_WALLET,
    connections: { solana: sol, x1 },
  });
  assert.equal(res.stage, "x1_ata_simulation");
  assert.equal(res.success, false);
  assert.equal(res.built, null);
  assert.equal(res.sim.ok, false);
  assert.ok(!x1.calls.includes("sendRawTransaction"), "failed sim never broadcasts");
});

test("engine forwardSvmStage: a failing Warp-lock sim returns { stage: simulation, success: false } (fail-closed)", async () => {
  const route = planForward();
  const sol = mockSolanaConnection({ simOk: false });
  const x1 = mockX1Connection();
  const res = await runForwardSvmStage({
    route,
    solAdapter: makeSolAdapter(),
    amountHuman: DELIVERED_HUMAN,
    allowLive: false,
    destToken: "USDC.x",
    feeWalletSvm: FEE_WALLET,
    connections: { solana: sol, x1 },
  });
  assert.equal(res.stage, "simulation");
  assert.equal(res.success, false);
  assert.ok(res.built, "the built tx is reported for diagnosis");
  assert.equal(res.sim.err, "AccountNotFound");
});

test("engine forwardSvmStage: a missing Solana fee payer blocks BEFORE anything is built (Stage2FeePayerError)", async () => {
  const route = planForward();
  const sol = mockSolanaConnection({ feePayerExists: false });
  const x1 = mockX1Connection();
  const { Stage2FeePayerError } = await import("../src/warpBridge.js");
  await assert.rejects(
    () =>
      runForwardSvmStage({
        route,
        solAdapter: makeSolAdapter(),
        amountHuman: DELIVERED_HUMAN,
        allowLive: false,
        destToken: "USDC.x",
        feeWalletSvm: FEE_WALLET,
        connections: { solana: sol, x1 },
      }),
    Stage2FeePayerError,
  );
  assert.ok(!x1.calls.includes("simulateTransaction"), "nothing built or simmed after the preflight failure");
});

// The fee-ATA-bundling variant (wSOL.X rail / missing fee ATA) stays covered by
// warpBridge.test.js on the wrapped functions — the engine wraps them 1:1.
test("engine forwardSvmStage: wSOL.X destination routes the ATA leg to the wSOL.X mint (token map parity)", async () => {
  const fwd = X1_FORWARD_TOKENS["wSOL.X"];
  assert.equal(fwd.destMint.toBase58(), "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8");
  assert.equal(fwd.sourceMint.toBase58(), "So11111111111111111111111111111111111111112");
  const route = planForward();
  const sol = mockSolanaConnection();
  const x1 = mockX1Connection();
  // A 9-dec amount clears the wSOL floor and exercises the wSOL.X path.
  const res = await runForwardSvmStage({
    route,
    solAdapter: makeSolAdapter(),
    amountHuman: 0.3,
    allowLive: false,
    destToken: "wSOL.X",
    feeWalletSvm: FEE_WALLET,
    connections: { solana: sol, x1 },
  });
  assert.equal(res.stage, "simulated_ok");
  assert.equal(res.built.destToken, "wSOL.X");
});
