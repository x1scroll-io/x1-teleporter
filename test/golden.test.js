/**
 * golden.test.js — THE REGRESSION ORACLE for the routing-engine migration.
 *
 * The routing engine that will migrate the forward leg (ETH → X1) is correct
 * IF AND ONLY IF it reproduces the EXACT transactions the current reference
 * implementation constructs — byte-for-byte. This test is the oracle: it
 * REBUILDS each step of the forward leg from the fixed sample input + the
 * frozen live quote and asserts the rebuilt bytes are IDENTICAL to the
 * captured golden fixtures (canonical JSON equality + sha256 match + raw
 * serialized-byte sha256 for the SVM txs).
 *
 *   step1  ERC-20 EXACT-amount approval  (lifiApproval.buildApprovalData)
 *   step2a X1 recipient ATA create tx    (warpBridge.ensureX1RecipientAta)
 *   step2b Warp lock tx — 0.5% skim + BridgeOut (warpBridge.buildStage2)
 *   step3  bridge_in_v2 account construction (WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC)
 *
 * Fixtures: test/fixtures/golden/forward-leg/*.json
 * Rebuild:  test/golden/forwardLegBuilders.mjs (single source of truth —
 *           the capture script and this test share it, so the test can never
 *           drift from what was captured).
 *
 * The engine must make this file pass UNCHANGED. Do not weaken assertions to
 * accommodate the engine — fix the engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, Transaction } from "@solana/web3.js";

import {
  captureForwardLeg,
  canonicalJson,
  sha256Of,
  buildStep1Approval,
  buildStep2aX1Ata,
  buildStep2bWarpLock,
  buildBridgeInV2AccountList,
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  FEE_WALLET_SVM,
  LIFI_DIAMOND_ETH,
  FIXED_BLOCKHASH,
  FIXED_SEQ_SLOT,
  mockBuildConnection,
  mockX1Connection,
} from "./golden/forwardLegBuilders.mjs";
import {
  WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC,
  WARP_ACCOUNTS,
  X1_USDCX_MINT,
  USDC_MINT,
  deriveX1UsdcxAta,
  encodeWarpSeq,
  SKIM_BPS,
} from "../src/warpBridge.js";
import { MAX_UINT256, isMaxUint256Amount, spenderFromApprovalData, amountFromApprovalData } from "../src/lib/lifiApproval.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "golden", "forward-leg");
const read = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const QUOTE = read("quote-eth-sol-usdc-25.65.json");
const FIX_STEP1 = read("step1-approval.json");
const FIX_STEP2A = read("step2a-x1-ata-prep.json");
const FIX_STEP2B = read("step2b-warp-lock.json");
const FIX_STEP3 = read("step3-bridge-in-v2.json");
const SUMMARY = read("forward-leg-summary.json");

// ── Sample-input self-consistency (the fixture chain of custody) ──
test("golden: fixture input is the documented sample (addresses, amount, quote)", () => {
  assert.equal(SUMMARY.sampleInput.amountUser, 25.65);
  assert.equal(SUMMARY.sampleInput.from, "eth");
  assert.equal(SUMMARY.sampleInput.token, "USDC");
  assert.equal(SUMMARY.sampleInput.destToken, "USDC.x");
  assert.equal(SUMMARY.sampleInput.evmAddress, EVM_ADDRESS);
  assert.equal(SUMMARY.sampleInput.solanaAddress, SOLANA_ADDRESS);
  assert.equal(SUMMARY.sampleInput.feeWalletSvm, FEE_WALLET_SVM);
  assert.equal(SUMMARY.sampleInput.liFiDiamondEth.toLowerCase(), LIFI_DIAMOND_ETH.toLowerCase());
  assert.equal(SUMMARY.sampleInput.blockhash, FIXED_BLOCKHASH);
  assert.equal(SUMMARY.sampleInput.seqSlot, FIXED_SEQ_SLOT);

  // The frozen quote: the exact live capture (Relay, 25.65 USDC ETH→SOL).
  assert.equal(QUOTE.tool, "relaydepository");
  assert.equal(QUOTE.action.fromAmount, "25650000"); // 25.65 USDC @ 6 dec
  assert.equal(QUOTE.action.fromToken.address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(QUOTE.estimate.approvalAddress.toLowerCase(), LIFI_DIAMOND_ETH.toLowerCase());
  assert.equal(QUOTE.transactionRequest.to.toLowerCase(), LIFI_DIAMOND_ETH.toLowerCase());
  assert.equal(QUOTE.transactionRequest.chainId, 1);
  // LiFi delivered 25.554929 USDC to Solana (Relay's own fee came out of the
  // 25.65) — this is the stage-2 skim base (leg-1-delivered).
  assert.equal(QUOTE.estimate.toAmount, "25554929");
});

// ── STEP 1 — EXACT-amount ERC-20 approval ──
test("golden step1: approval rebuild is byte-identical (calldata + txParams) + sha256", () => {
  const rebuilt = buildStep1Approval({ quote: QUOTE });

  // 1) The fixture itself must be the exact approval the code builds today.
  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP1.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP1.sha256);

  // 2) The oracle invariants — what makes this approval SAFE (PR #3 shape):
  //    EXACT amount, never MaxUint256, spender = the LiFi Diamond, target =
  //    the same contract the bridge tx calls.
  const a = rebuilt.artifact;
  assert.equal(a.selector, "0x095ea7b3"); // approve(address,uint256)
  assert.equal(a.amountRaw, "25650000"); // EXACT raw source amount from the quote
  assert.equal(isMaxUint256Amount(a.calldata), false);
  assert.notEqual(amountFromApprovalData(a.calldata), MAX_UINT256);
  assert.equal(a.spender, LIFI_DIAMOND_ETH.toLowerCase()); // allowlisted Diamond
  assert.equal(spenderFromApprovalData(a.calldata), LIFI_DIAMOND_ETH.toLowerCase());
  assert.equal(amountFromApprovalData(a.calldata), 25_650_000n);
  assert.equal(a.tokenAddress, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"); // USDC
  assert.equal(a.txParams.to, a.tokenAddress);
  assert.equal(a.txParams.value, "0x0");
  assert.equal(a.txParams.data, a.calldata);
  assert.equal(a.evmAddress, EVM_ADDRESS.toLowerCase());
});

// ── STEP 2a — X1 recipient ATA prep tx ──
test("golden step2a: X1 ATA-create tx rebuild is byte-identical (serialized) + sha256", async () => {
  const rebuilt = await buildStep2aX1Ata({});

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP2A.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP2A.sha256);
  assert.equal(rebuilt.bytesSha256, FIX_STEP2A.bytesSha256);

  const a = rebuilt.artifact;
  assert.equal(a.programId, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"); // ATA program
  assert.equal(a.tokenProgram, TOKEN_2022_PROGRAM_ID.toBase58()); // USDC.x is Token-2022
  assert.equal(a.mint, X1_USDCX_MINT.toBase58());
  assert.equal(a.owner, SOLANA_ADDRESS);
  assert.equal(a.payer, SOLANA_ADDRESS);
  assert.equal(a.ata, deriveX1UsdcxAta(new PublicKey(SOLANA_ADDRESS)).toBase58());
  assert.equal(FIX_STEP2A.artifact.ata, a.ata);

  // The serialized bytes must deserialize back to the same single-instruction tx.
  const tx = Transaction.from(Buffer.from(a.serializedBase64, "base64"));
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.feePayer.toBase58(), SOLANA_ADDRESS);
  assert.equal(tx.recentBlockhash, FIXED_BLOCKHASH);
});

// ── STEP 2b — the Warp lock tx (Solana: skim transfer + BridgeOut) ──
test("golden step2b: stage-2 Warp lock tx rebuild is byte-identical (serialized) + sha256", async () => {
  const seq = encodeWarpSeq(FIXED_SEQ_SLOT, 0);
  const amountHuman = Number(QUOTE.estimate.toAmount) / 10 ** 6; // 25.554929
  const rebuilt = await buildStep2bWarpLock({ amountHuman, seq });

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP2B.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP2B.sha256);
  assert.equal(rebuilt.bytesSha256, FIX_STEP2B.bytesSha256);

  const a = rebuilt.artifact;
  assert.equal(a.seq, seq.toString());
  assert.equal(a.grossBase, "25554929"); // what LiFi delivered (base units)
  // 0.5% skim = floor(gross × SKIM_BPS / 10000); the bridge locks the remainder.
  assert.equal(a.skimBase, ((25554929n * SKIM_BPS) / 10_000n).toString());
  assert.equal(a.bridgeBase, (25554929n - (25554929n * SKIM_BPS) / 10_000n).toString());
  assert.equal(a.feeAtaCreated, false); // live shape: fee wallet's USDC ATA exists
  assert.equal(a.blockhash, FIXED_BLOCKHASH);
  assert.equal(a.instructionCount, 3); // compute budget + skim transfer + BridgeOut
  assert.equal(a.accountList.length, 12);

  // Serialized bytes must be a valid unsigned tx with the fixed blockhash.
  const tx = Transaction.from(Buffer.from(a.serializedBase64, "base64"));
  assert.equal(tx.recentBlockhash, FIXED_BLOCKHASH);
  assert.equal(tx.feePayer.toBase58(), SOLANA_ADDRESS);
  assert.equal(tx.instructions.length, 3);

  // Instruction order + programs (compute budget, spl-token transfer, Warp).
  const { ComputeBudgetProgram } = await import("@solana/web3.js");
  assert.equal(tx.instructions[0].programId.toBase58(), ComputeBudgetProgram.programId.toBase58());
  assert.equal(tx.instructions[1].programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(tx.instructions[2].programId.toBase58(), "6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD");

  // BridgeOut data = discriminator + u64le(seq) + u64le(bridgeBase).
  const data = tx.instructions[2].data;
  assert.equal(data.length, 24);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(dv.getBigUint64(8, true), BigInt(a.seq));
  assert.equal(dv.getBigUint64(16, true), BigInt(a.bridgeBase));

  // Account list slot-for-slot vs the spec (order + roles are the contract).
  const names = [
    "config", "token_registry", "outgoing_msg", "sender", "sender_token_account",
    "token_mint", "vault", "vault_token_account", "fee_collector",
    "fee_collector_token_account", "token_program", "system_program",
  ];
  assert.equal(a.accountList[0].pubkey, WARP_ACCOUNTS.config.toBase58());
  assert.equal(a.accountList[3].pubkey, SOLANA_ADDRESS); // sender = the user
  assert.equal(a.accountList[3].isSigner, true);
  assert.equal(a.accountList[4].isWritable, true);
  assert.equal(a.accountList[8].pubkey, WARP_ACCOUNTS.feePda.toBase58());
  assert.equal(a.accountList[9].pubkey, WARP_ACCOUNTS.feeCollectorAta.toBase58());
  for (let i = 0; i < names.length; i++) {
    assert.equal(a.accountList[i].pubkey, a.accountList[i].pubkey); // exists
    assert.ok(a.accountList[i].pubkey.length >= 32);
  }
  assert.equal(tx.instructions[2].keys.length, names.length);
});

// ── STEP 3 — bridge_in_v2 account construction (the 14-row spec) ──
test("golden step3: bridge_in_v2 account-list rebuild is byte-identical + spec sha256", async () => {
  const seq = encodeWarpSeq(FIXED_SEQ_SLOT, 0);
  const skim = (25554929n * SKIM_BPS) / 10_000n;
  const bridgeBase = 25554929n - skim;
  const rebuilt = buildBridgeInV2AccountList({ seq, amountBase: bridgeBase });

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP3.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP3.sha256);
  assert.equal(rebuilt.specSha256, FIX_STEP3.specSha256);

  // The SPEC itself: 14 rows, exact names, wrapped-token optionality.
  assert.equal(rebuilt.spec.rowCount, 14);
  assert.deepEqual(
    rebuilt.spec.rows.map((r) => r.name),
    [
      "config", "guardian_set", "token_registry", "signature_set", "incoming_msg",
      "payer", "recipient", "recipient_token_account", "token_mint", "mint_authority",
      "vault", "vault_token_account", "token_program", "system_program",
    ],
  );
  // No associated_token_program anywhere: the v2 IDL cannot create the ATA —
  // it must pre-exist (that's exactly what step2a does).
  assert.ok(!rebuilt.spec.rows.some((r) => r.name === "associated_token_program"));

  // The concrete wrapped-USDC.x list: 11 offline-derivable keys in spec order.
  const a = rebuilt.artifact;
  assert.equal(a.accountCount, 11);
  assert.equal(a.wrappedVariant, true);
  assert.equal(a.accountList[0].pubkey, "48Po6qAHRJojbXH7KRqt6s5GfNfs9VEGccfqYEHmubEi"); // config PDA
  assert.equal(a.accountList[3].name, "incoming_msg"); // signature_set skipped (guardian)
  assert.equal(a.accountList[7].pubkey, X1_USDCX_MINT.toBase58()); // token_mint
  assert.equal(a.accountList[8].name, "mint_authority"); // wrapped → included
  assert.equal(a.accountList[9].pubkey, TOKEN_2022_PROGRAM_ID.toBase58()); // Token-2022
  assert.equal(a.accountList[10].pubkey, SystemProgram.programId.toBase58());

  // CHAIN OF CUSTODY: the recipient_token_account the guardians will mint into
  // is EXACTLY the ATA step2a creates on X1 (the app's side of the contract).
  assert.equal(a.accountList[6].pubkey, FIX_STEP2A.artifact.ata);
  assert.equal(a.accountList[6].pubkey, deriveX1UsdcxAta(new PublicKey(SOLANA_ADDRESS)).toBase58());
});

// ── Cross-step + engine contract ──
test("golden: full capture is reproducible + deterministic (rebuild twice, same bytes)", async () => {
  const c1 = await captureForwardLeg({ quote: QUOTE });
  const c2 = await captureForwardLeg({ quote: QUOTE });
  for (const k of ["step1", "step2a", "step2b", "step3"]) {
    assert.equal(c1.steps[k].sha256, c2.steps[k].sha256, `${k} sha256 stable`);
    assert.equal(
      canonicalJson(c1.steps[k].artifact),
      canonicalJson(c2.steps[k].artifact),
      `${k} artifact stable`,
    );
  }

  // Derived math (fee-model v2): skim base = 0.5% of delivered, bridge =
  // delivered − skim. (Old 1% values: skim 255549 / bridge 25299380.)
  assert.equal(c1.derived.deliveredBase, "25554929");
  assert.equal(c1.derived.skimBase, "127774");
  assert.equal(c1.derived.bridgeBase, "25427155");
  assert.equal(c1.derived.amountHuman, 25.554929);
  assert.equal(c1.derived.seq, encodeWarpSeq(FIXED_SEQ_SLOT, 0).toString());

  // Stage-1 EVM bridge calldata reference: the app forwards the quote's
  // transactionRequest verbatim — the engine must too. The sha256 recorded at
  // capture time is over the exact calldata bytes (0x-prefix stripped).
  const txReq = QUOTE.transactionRequest;
  const { createHash } = await import("node:crypto");
  const dataSha = createHash("sha256")
    .update(Buffer.from(txReq.data.slice(2), "hex"))
    .digest("hex");
  assert.equal(c1.quoteReference.txDataSha256, dataSha);
  assert.equal(c1.quoteReference.txDataSha256, SUMMARY.quoteReference.txDataSha256);
  assert.equal(c1.quoteReference.txTo, LIFI_DIAMOND_ETH.toLowerCase());
  assert.equal(c1.quoteReference.fromAmountRaw, "25650000");
});
