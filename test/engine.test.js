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
import { resolveSolSigner } from "../src/lib/lifiSolanaTx.js";
import { resolveSolanaAdapter as resolveSolanaAdapterFn } from "../src/lib/wallet/sessionProviders.js";
import {
  planForward,
  planReverse,
  plan,
  legById,
  legsForStage,
  FORWARD_LEG_IDS,
  REVERSE_LEG_IDS,
  REVERSE_STAGES,
} from "../src/engine/routePlanner.js";
import {
  buildApprovalArtifact,
  buildBridgeTxArtifact,
  shapeAtaCreateArtifact,
  shapeWarpLockArtifact,
  deriveBridgeInV2AccountList,
  shapeReverseBurnArtifact,
  buildLifiOutArtifact,
} from "../src/engine/index.js";
import { runForwardEvmStage } from "../src/engine/runners/forwardEvmStage.js";
import { runForwardSvmStage } from "../src/engine/runners/forwardSvmStage.js";
import { runReverseX1Stage } from "../src/engine/runners/reverseX1Stage.js";
import { runReleaseWait } from "../src/engine/runners/reverseReleaseStage.js";
import { runReverseLiFiStage } from "../src/engine/runners/reverseLiFiStage.js";
import {
  encodeWarpSeq,
  encodeReverseSeq,
  buildReverseBurnWithSkim,
  X1_USDCX_MINT,
  USDC_MINT,
  SKIM_BPS,
  X1_FORWARD_TOKENS,
  X1_REVERSE_TOKENS,
} from "../src/warpBridge.js";
import { SimulationError } from "../src/lib/simulateTx.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "golden", "forward-leg");
const read = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const QUOTE = read("quote-eth-sol-usdc-25.65.json");
const FIX_STEP1 = read("step1-approval.json");
const FIX_STEP2A = read("step2a-x1-ata-prep.json");
const FIX_STEP2B = read("step2b-warp-lock.json");
const FIX_STEP3 = read("step3-bridge-in-v2.json");
const SUMMARY = read("forward-leg-summary.json");

// ── Phase-2 reverse-leg fixtures (the golden oracle for X1→EVM) ──
const REV_FIX = join(here, "fixtures", "golden", "reverse-leg");
const readRev = (name) => JSON.parse(readFileSync(join(REV_FIX, name), "utf8"));
const REV_STEP1 = readRev("step1-x1-burn.json");
const REV_STEP2 = readRev("step2-release-shape.json");
const REV_STEP3 = readRev("step3-lifi-out.json");
const REV_SUMMARY = readRev("reverse-leg-summary.json");
const REV_QUOTE = readRev("quote-wsol-usdc-eth-0.39501.json");
const {
  mockX1ReverseConnection,
  REVERSE_EVM_ADDRESS,
  canonicalJson: revCanonicalJson,
  sha256Of: revSha256Of,
} = await import("./golden/reverseLegBuilders.mjs");


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

test("engine routePlanner: unplanned directions return null — THORChain/DEX are NOT planned here (reverse IS — Phase 2)", () => {
  assert.equal(plan({ direction: "forward" }).id, "forward-eth-x1");
  assert.equal(plan({ direction: "reverse" }).id, "reverse-x1-eth"); // Phase 2 plans the reverse route
  assert.equal(plan({ direction: "thorchain" }), null);
  assert.equal(plan({ direction: "dex" }), null);
  assert.equal(plan({}).id, "forward-eth-x1"); // forward is the default
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

// ════════════════════════════════════════════════════════════════════════════
// 6. PHASE 2 — the REVERSE route (X1 → EVM) on the engine. The reverse golden
//    oracle (test/goldenReverse.test.js + test/fixtures/golden/reverse-leg/)
//    pins the reference artifacts; these tests prove the ENGINE reproduces
//    them byte-for-byte and that the reverse LiFi-out signer resolves through
//    the SAME single SignerResolver the forward leg uses.
// ════════════════════════════════════════════════════════════════════════════

const REV_GROSS = 0.4; // the golden sample (0.4 wSOL.X on X1)

/** Deterministic X1 connection for the reverse burn (the golden mock shape:
 *  fee payer exists, user ATA funded, fee wallet's wSOL.X ATA EXISTS (the
 *  live shape — no bundled create), fixed blockhash + slot. */
function mockReverseX1Connection() {
  return mockX1ReverseConnection();
}

/** The reverse route's deterministic seq (chain-pair 0x10: X1→Sol). */
function reverseSeq() {
  return encodeReverseSeq(FIXED_SEQ_SLOT, 0);
}

test("engine routePlanner (Phase 2): the reverse route plans EXACTLY the three legs in order, grouped into the reverse UI stages", () => {
  const route = planReverse({ to: "eth" });
  assert.equal(route.id, "reverse-x1-eth");
  assert.equal(route.direction, "reverse");
  assert.equal(route.sourceChain, "x1");
  assert.equal(route.destChain, "eth");
  assert.deepEqual(route.legs.map((l) => l.id), [...REVERSE_LEG_IDS]);
  assert.deepEqual(route.legs.map((l) => l.id), ["x1-reverse-burn", "warp-release-wait", "lifi-solana-out"]);
  assert.deepEqual(route.legs.map((l) => l.family), ["svm", "svm", "svm"]);
  assert.deepEqual(legsForStage(route, "burn").map((l) => l.id), ["x1-reverse-burn"]);
  assert.deepEqual(legsForStage(route, "release").map((l) => l.id), ["warp-release-wait"]);
  assert.deepEqual(legsForStage(route, "lifi").map((l) => l.id), ["lifi-solana-out"]);
  assert.equal(REVERSE_STAGES.burn.label, "stage 1 of 2 (X1 burn)");
  assert.equal(REVERSE_STAGES.lifi.label, "stage 2 of 2 (LiFi Solana → EVM)");
  assert.equal(legById(route, "x1-reverse-burn").goldenStep, "step1-x1-burn");
  assert.equal(legById(route, "lifi-solana-out").goldenStep, "step3-lifi-out (toAddress pin + quote reference)");
  // plan() dispatches reverse (Phase 2); THORChain/DEX stay unplanned.
  assert.equal(plan({ direction: "reverse" }).id, "reverse-x1-eth");
  assert.equal(plan({ direction: "thorchain" }), null);
});

test("engine reverse byte-identity step1: the x1-burn leg artifact == golden step1 (canonical JSON + sha256 + serialized bytes)", async () => {
  const connection = mockReverseX1Connection();
  const userPubkey = USER;
  const feeWallet = FEE_WALLET;
  const skim = (REV_GROSS * Number(SKIM_BPS)) / 10_000; // 1% of the gross (0.004)
  const burnAmount = REV_GROSS - skim; // 0.396
  const { built, prep } = await buildReverseBurnWithSkim({
    connection,
    userPubkey,
    amountHuman: burnAmount,
    feeAmount: skim,
    feeWallet,
    token: "wSOL.X",
    seq: reverseSeq(),
  });
  const artifact = shapeReverseBurnArtifact({
    built,
    prep,
    amountHuman: burnAmount,
    feeAmount: skim,
    token: "wSOL.X",
    blockhash: FIXED_BLOCKHASH,
    seqSlot: FIXED_SEQ_SLOT,
  });
  // Byte-identity with the golden step1 fixture (canonical JSON + sha256 +
  // the raw serialized bytes). The ENGINE is the wrong one if this differs.
  assert.equal(revCanonicalJson(artifact), revCanonicalJson(REV_STEP1.artifact));
  assert.equal(revSha256Of(artifact), REV_STEP1.sha256);
  const { sha256Bytes } = await import("./golden/forwardLegBuilders.mjs");
  assert.equal(sha256Bytes(Buffer.from(artifact.serializedBase64, "base64")), REV_STEP1.bytesSha256);
  // The pinned math + live-shape facts hold on the engine artifact too.
  assert.equal(artifact.seq, reverseSeq().toString());
  assert.equal(artifact.grossBase, "400000000");
  assert.equal(artifact.skimBase, "4000000");
  assert.equal(artifact.bridgeBase, "396000000");
  assert.equal(artifact.feeAtaCreated, false);
  assert.equal(artifact.instructionCount, 2);
  assert.equal(artifact.feeAta, "8YxSUo3EjM14C3UnRw7kJqTcNwHnAtvW15vP9nCqCCmw"); // live ground truth
  // Deserializes to the same 2-instruction tx (Token-2022 transfer + Warp burn).
  const tx = Transaction.from(Buffer.from(artifact.serializedBase64, "base64"));
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.feePayer.toBase58(), SOLANA_ADDRESS);
  assert.equal(tx.recentBlockhash, FIXED_BLOCKHASH);
});

test("engine reverse byte-identity step3: the lifi-solana-out leg artifact == golden step3 (canonical JSON + sha256 + the toAddress PIN)", async () => {
  const artifact = buildLifiOutArtifact({
    to: "eth",
    toTokenSymbol: "USDC",
    netOnSolana: REV_STEP3.artifact.netOnSolana,
    fromAddress: SOLANA_ADDRESS,
    toAddress: REVERSE_EVM_ADDRESS,
    token: "wSOL.X",
  });
  assert.ok(artifact, "the sample chain/token/wallet set must resolve");
  assert.equal(revCanonicalJson(artifact), revCanonicalJson(REV_STEP3.artifact));
  assert.equal(revSha256Of(artifact), REV_STEP3.sha256);
  // THE PIN: the engine's query artifact carries the EVM destination — the
  // fixture's sampleInput.evmDestination — byte-for-byte.
  assert.equal(artifact.toAddress, REV_STEP3.artifact.toAddress);
  assert.equal(artifact.toAddress, REV_SUMMARY.sampleInput.evmDestination);
  assert.equal(artifact.toAddress, REVERSE_EVM_ADDRESS);
  assert.equal(artifact.fromAmountRaw, "395010000");
  assert.equal(artifact.fromToken, "So11111111111111111111111111111111111111112");
  assert.equal(artifact.hasFeeParam, false);
});

test("engine reverse: the release-wait leg + runner build the poll artifact and confirm via pollWarpStatus (the #40 proxy path)", async () => {
  const route = planReverse();
  const calls = [];
  const fetcher = mock.fn(async (url) => {
    calls.push(String(url));
    if (String(url).includes("/api/warp/signatures")) {
      return { ok: false, status: 404, json: async () => ({}) }; // pre-detection is NORMAL
    }
    if (String(url).includes("/api/warp/status")) {
      return {
        ok: true,
        json: async () => ({
          transaction: { status: "executed", destTxSig: "dest-release-sig" },
          signatures: [1, 2, 3, 4, 5],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  mock.method(globalThis, "fetch", fetcher);
  try {
    const res = await runReleaseWait({ route, sig: "x1-burn-sig", maxMs: 5000 });
    assert.equal(res.ok, true);
    assert.equal(res.destinationTx, "dest-release-sig");
    // The poll hit the app's OWN same-origin proxy endpoints (from=x1).
    assert.ok(calls.some((u) => u.includes("/api/warp/signatures?sig=x1-burn-sig&from=x1")));
    assert.ok(calls.some((u) => u.includes("/api/warp/status?sig=x1-burn-sig&from=x1")));
  } finally {
    mock.restoreAll();
  }
});

test("engine reverseX1Stage (sim mode): returns the runReverse shape { simulated_ok } and the built burn tx is BYTE-IDENTICAL to golden step1", async () => {
  const route = planReverse();
  const connection = mockReverseX1Connection();
  const res = await runReverseX1Stage({
    route,
    solAdapter: makeSolAdapter(), // publicKey = USER (the golden sample wallet)
    amountHuman: REV_GROSS,
    allowLive: false, // WARP_LIVE_SEND gate held → confirm-mode
    token: "wSOL.X",
    feeWallet: FEE_WALLET,
    connection,
  });
  assert.equal(res.stage, "simulated_ok");
  assert.equal(res.success, true);
  assert.equal(res.sent, null);
  assert.ok(res.sim.ok, "the burn sim passed (fail-closed gate)");
  // The runner-built burn tx serializes to the GOLDEN step1 bytes — the
  // runner + leg reproduce the reference burn byte-for-byte end to end.
  const tx = res.built.transaction;
  tx.recentBlockhash = FIXED_BLOCKHASH; // the mock already returns it — belt+braces
  const bytes = Buffer.from(tx.serialize({ requireAllSignatures: false }));
  const { sha256Bytes } = await import("./golden/forwardLegBuilders.mjs");
  assert.equal(sha256Bytes(bytes), REV_STEP1.bytesSha256);
  assert.equal(Buffer.from(REV_STEP1.artifact.serializedBase64, "base64").equals(bytes), true);
});

test("engine reverseX1Stage (live mode): a failing burn sim BLOCKS the send ({ stage: simulation, success: false } — nothing signed)", async () => {
  const route = planReverse();
  const connection = mockReverseX1Connection();
  // Break the sim: swap simulateTransaction for a failing one.
  connection.simulateTransaction = async () => ({ value: { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: Error: insufficient funds"] } });
  const adapter = makeSolAdapter();
  const res = await runReverseX1Stage({
    route,
    solAdapter: adapter,
    amountHuman: REV_GROSS,
    allowLive: true,
    token: "wSOL.X",
    feeWallet: FEE_WALLET,
    connection,
  });
  assert.equal(res.stage, "simulation");
  assert.equal(res.success, false);
  assert.equal(res.signature, undefined);
});

test("engine reverseX1Stage (live mode): the burn signs via the adapter and broadcasts → { stage: sent, signature } (WARP_LIVE_SEND gate forwarded)", async () => {
  const route = planReverse();
  // The signer must BE the fee payer (web3.js serialize verifies signatures)
  // — use a real keypair as the wallet, like the reference live-mode tests.
  const userKp = Keypair.generate();
  const connection = mockX1ReverseConnection({ solanaAddress: userKp.publicKey.toBase58() });
  const adapter = makeSolAdapter({ publicKey: userKp.publicKey, keypair: userKp });
  const res = await runReverseX1Stage({
    route,
    solAdapter: adapter,
    amountHuman: REV_GROSS,
    allowLive: true,
    token: "wSOL.X",
    feeWallet: FEE_WALLET,
    connection,
  });
  assert.equal(res.stage, "sent");
  assert.equal(res.success, true);
  assert.ok(res.signature, "the guarded send returned the X1 burn signature");
});

test("engine reverse: a missing X1 fee payer blocks BEFORE anything is built (X1FeePayerError — actionable, not AccountNotFound)", async () => {
  const route = planReverse();
  const { X1FeePayerError } = await import("../src/warpBridge.js");
  const connection = mockReverseX1Connection();
  connection.getAccountInfo = async () => null; // user missing on X1
  await assert.rejects(
    () => runReverseX1Stage({
      route,
      solAdapter: makeSolAdapter(),
      amountHuman: REV_GROSS,
      allowLive: false,
      token: "wSOL.X",
      feeWallet: FEE_WALLET,
      connection,
    }),
    (err) => err instanceof X1FeePayerError && /no spendable XNT/.test(err.message),
  );
});

// ── THE SINGLE SIGNER RESOLVER (the whole point — one resolver, both
//    directions, the #43 wrong-wallet-field bug structurally impossible) ──
test("engine reverse: the LiFi-out signer resolves through the SAME SignerResolver as forward (one resolver, one code path, both directions)", async () => {
  // A wrapper-shaped session ({ provider: { family, adapter } }) — the v2
  // WalletContext shape whose RAW provider has no sign fns (the #43 bug).
  const adapter = {
    name: "Test Wallet",
    publicKey: { toBase58: () => SOLANA_ADDRESS },
    async connect() {},
    async signAndSendTransaction() {
      return { signature: "adapter-sig" };
    },
  };
  const wrapper = {
    family: "solana",
    id: "wallet-standard:Test Wallet",
    isReal: true,
    walletName: "Test Wallet",
    adapter,
    async connect() {
      return { family: "solana", address: SOLANA_ADDRESS, provider: this };
    },
    async disconnect() {},
  };
  const session = { family: "solana", address: SOLANA_ADDRESS, provider: wrapper };

  // The forward leg's resolver (executeStage1/2 use SignerResolver.resolve):
  const viaEngine = await resolveSigner("svm", session);
  assert.equal(viaEngine, adapter, "SignerResolver.resolve('svm') unwraps the wrapper's adapter");

  // The reverse leg's executor path accepts the SAME resolved adapter (the
  // runner passes SignerResolver.resolve("svm", session) into the leg):
  const viaReverseExecutor = await resolveSolSigner(session, null);
  assert.equal(viaReverseExecutor, adapter);
  assert.equal(viaEngine, viaReverseExecutor, "forward + reverse resolve the SAME adapter");

  // And the proven stage-1 resolver agrees (the reference path's resolver):
  const viaReference = await resolveSolanaAdapterFn(session);
  assert.equal(viaReference, adapter);
  assert.equal(viaEngine, viaReference);

  // The raw session/provider shape NEVER reaches the executor — the leg's
  // submit phase reads ctx.solAdapter (the resolved adapter) only; the
  // runner resolves BEFORE the leg runs.
  const route = planReverse();
  const outLeg = legById(route, "lifi-solana-out");
  assert.equal(typeof outLeg.phases.submit, "function");
});

test("engine reverseLiFiStage: runReverseLiFiStage drives the lifi-out leg end to end — fresh quote, destination pin, resolved-adapter send → the final-leg signature", async () => {
  const route = planReverse();
  const seenSigners = [];
  const adapter = {
    publicKey: { toBase58: () => SOLANA_ADDRESS },
    async signAndSendTransaction(vtx) {
      seenSigners.push(this);
      return { signature: "final-leg-sig" };
    },
  };
  // A minimal executable LiFi quote (the golden quote's payload shape) with
  // toAddress = the PINNED EVM destination.
  const { Keypair, MessageV0, VersionedTransaction } = await import("@solana/web3.js");
  const compiled = MessageV0.compile({
    payerKey: Keypair.generate().publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  });
  const b64 = Buffer.from(new VersionedTransaction(compiled).serialize()).toString("base64");
  const lifiData = {
    action: {
      toAddress: REVERSE_EVM_ADDRESS,
      fromToken: { address: "So11111111111111111111111111111111111111112" },
      toToken: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    },
    transactionRequest: { data: b64 },
  };
  const fetcher = mock.fn(async (url) => {
    const u = String(url);
    assert.ok(u.includes("toAddress=" + REVERSE_EVM_ADDRESS), "the quote query pins the EVM destination");
    return { ok: true, json: async () => lifiData };
  });
  mock.method(globalThis, "fetch", fetcher);
  const simOk = async () => ({ ok: true, logs: [], unitsConsumed: 0 });
  try {
    const sig = await runReverseLiFiStage({
      route,
      solAdapter: adapter,
      evmAddress: REVERSE_EVM_ADDRESS,
      to: "eth",
      toTokenSymbol: "USDC",
      netOnSolana: 0.39501,
      token: "wSOL.X",
      simulate: simOk, // test seam — the fail-closed Step 1.3A gate is untouched
    });
    assert.equal(sig, "final-leg-sig");
    assert.equal(seenSigners.length, 1);
    assert.equal(seenSigners[0], adapter, "the executor signs with the RESOLVED adapter — never the raw session");
  } finally {
    mock.restoreAll();
  }
});

test("engine reverse lifi-out leg: a quote whose recipient DRIFTED from the pinned EVM destination is REFUSED before any send", async () => {
  const route = planReverse();
  const leg = legById(route, "lifi-solana-out");
  const { MessageV0, VersionedTransaction, Keypair } = await import("@solana/web3.js");
  const compiled = MessageV0.compile({
    payerKey: Keypair.generate().publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  });
  const b64 = Buffer.from(new VersionedTransaction(compiled).serialize()).toString("base64");
  // The quote's toAddress = a DIFFERENT wallet (the wrong-wallet-field bug
  // class — the exact thing the engine must make impossible).
  const drifted = {
    action: { toAddress: "0x1111111111111111111111111111111111111111" },
    transactionRequest: { data: b64 },
  };
  const outBuild = await leg.phases.build({
    to: "eth", toTokenSymbol: "USDC", netOnSolana: 0.39501,
    fromAddress: SOLANA_ADDRESS, toAddress: REVERSE_EVM_ADDRESS, token: "wSOL.X",
  });
  const simOk = async () => ({ ok: true, logs: [], unitsConsumed: 0 });
  await assert.rejects(
    () => leg.phases.simulate(
      {
        lifiData: drifted,
        solAdapter: { publicKey: { toBase58: () => SOLANA_ADDRESS } },
        toAddress: REVERSE_EVM_ADDRESS,
        simulate: simOk,
      },
      { build: outBuild },
    ),
    (err) => /Refusing to send/.test(err.message) && /does not match the connected EVM wallet/.test(err.message),
  );
});

test("engine reverseLiFiStage: a quote error surfaces verbatim (fail-closed — never guess the leg)", async () => {
  const route = planReverse();
  const adapter = {
    publicKey: { toBase58: () => SOLANA_ADDRESS },
    async signAndSendTransaction() {
      return { signature: "should-never-sign" };
    },
  };
  const fetcher = mock.fn(async () => ({ ok: true, json: async () => ({ error: "lifi_quote_failed", message: "No route found" }) }));
  mock.method(globalThis, "fetch", fetcher);
  try {
    await assert.rejects(
      () => runReverseLiFiStage({
        route,
        solAdapter: adapter,
        evmAddress: REVERSE_EVM_ADDRESS,
        to: "eth",
        toTokenSymbol: "USDC",
        netOnSolana: 0.39501,
        token: "wSOL.X",
      }),
      /No route found/,
    );
  } finally {
    mock.restoreAll();
  }
});
