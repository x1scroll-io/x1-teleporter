/**
 * goldenReverse.test.js — THE REGRESSION ORACLE for the Phase-2 routing-engine
 * migration: the REVERSE leg (X1 → EVM).
 *
 * The routing engine that will migrate the reverse leg is correct IF AND ONLY
 * IF it reproduces the EXACT artifacts the current reference implementation
 * constructs — byte-for-byte. This test REBUILDS each step of the reverse leg
 * from the fixed sample input + the frozen live quote and asserts the rebuilt
 * bytes are IDENTICAL to the captured golden fixtures (canonical JSON
 * equality + sha256 match + raw serialized-byte sha256 for the burn tx).
 *
 *   step1  the X1 reverse burn tx — 1% skim Token-2022 transfer + Warp
 *          bridge_out in ONE tx (warpBridge.buildReverseBurnWithSkim — the
 *          shared construction helper runReverse uses; token-aware wSOL.X,
 *          9-dec, 25bps fee account)
 *   step2  the release SHAPE — the bridge_in_v2 NATIVE-variant account
 *          construction (vault slots present, mint_authority = program-self)
 *          + the expected release math (what the official submitter's
 *          release must deliver) — app- vs submitter-constructed documented
 *   step3  the LiFi WSOL→USDC-on-ETH query — buildReverseLifiQuoteParams
 *          with the PINNED EVM destination (toAddress = the EVM wallet
 *          0x1870aFAfA… — the #44 display value) + the frozen quote's
 *          reference (fromToken WSOL 9-dec, toToken USDC on eth, recipient
 *          == the pinned EVM wallet)
 *
 * Fixtures: test/fixtures/golden/reverse-leg/*.json
 * Rebuild:  test/golden/reverseLegBuilders.mjs (single source of truth —
 *           the capture script and this test share it, so the test can never
 *           drift from what was captured).
 *
 * Ground truth (captured 2026-09-02 from last night's WORKING reverse run —
 * the one that delivered USDC to Ethereum): X1 burn 3q7H3kV4…, Solana
 * release v6etkXX21…, LiFi tx 25fvaCmt… — see the summary + builders.
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
  captureReverseLeg,
  canonicalJson,
  sha256Of,
  buildStep1ReverseBurn,
  buildReverseReleaseShape,
  buildStep3LifiOut,
  reverseBurnMath,
  reverseReleaseMath,
  quoteReferenceOf,
  SAMPLE_INPUT,
  ETHX_SAMPLE_INPUT,
  REVERSE_EVM_ADDRESS,
  REVERSE_EVM_ADDRESS_LC,
  mockX1ReverseConnection,
} from "./golden/reverseLegBuilders.mjs";
import {
  encodeReverseSeq,
  X1_WSOLX_MINT,
  WSOL_MINT,
  X1_WSOLX_FEE_ACCOUNT,
  WARP_PROGRAM_ID,
  WARP_ACCOUNTS,
  WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC,
  deriveVaultAccounts,
  SKIM_BPS,
  X1_REVERSE_TOKENS,
} from "../src/warpBridge.js";
import { computeReverseLegs, buildReverseLifiQuoteParams, deriveReverseQuote } from "../src/lib/reverseQuote.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "golden", "reverse-leg");
const read = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const QUOTE = read("quote-wsol-usdc-eth-0.39501.json");
const FIX_STEP1 = read("step1-x1-burn.json");
const FIX_STEP2 = read("step2-release-shape.json");
const FIX_STEP3 = read("step3-lifi-out.json");
const SUMMARY = read("reverse-leg-summary.json");

// The seq the fixtures were captured with (chain-pair 0x10 = X1→Sol).
const SEQ = encodeReverseSeq(SAMPLE_INPUT.seqSlot, 0);

// ── Sample-input self-consistency (the fixture chain of custody) ──
test("golden reverse: fixture input is the documented sample (addresses, amount, PINNED EVM destination, quote)", () => {
  assert.equal(SUMMARY.sampleInput.amountUser, 0.4);
  assert.equal(SUMMARY.sampleInput.from, "x1");
  assert.equal(SUMMARY.sampleInput.to, "eth");
  assert.equal(SUMMARY.sampleInput.token, "wSOL.X");
  assert.equal(SUMMARY.sampleInput.toToken, "USDC");
  assert.equal(SUMMARY.sampleInput.solanaAddress, SAMPLE_INPUT.solanaAddress);
  assert.equal(SUMMARY.sampleInput.feeWallet, SAMPLE_INPUT.feeWallet);
  assert.equal(SUMMARY.sampleInput.blockhash, SAMPLE_INPUT.blockhash);
  assert.equal(SUMMARY.sampleInput.seqSlot, SAMPLE_INPUT.seqSlot);
  // THE PIN: the fixture's EVM destination is the canonical checksummed form
  // of the ground-truth EVM wallet 0x1870aFAFA… (all-caps is not valid EIP-55
  // and LI.Fi rejects it; the canonical form is the same account).
  assert.equal(SUMMARY.sampleInput.evmDestination, REVERSE_EVM_ADDRESS);
  assert.equal(REVERSE_EVM_ADDRESS_LC, "0x1870afafa502223f6f70b6ddb93dc4099c86c239");
  assert.equal(SAMPLE_INPUT.evmDestination, REVERSE_EVM_ADDRESS);

  // The frozen quote: the exact live capture (relaydepository, WSOL→USDC).
  assert.equal(QUOTE.tool, "relaydepository");
  assert.equal(QUOTE.action.fromToken.address, "So11111111111111111111111111111111111111112"); // WSOL
  assert.equal(QUOTE.action.fromToken.decimals, 9);
  assert.equal(QUOTE.action.toToken.address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"); // USDC
  assert.equal(QUOTE.action.toToken.chainId, 1); // on Ethereum
  assert.equal(QUOTE.action.fromAmount, "395010000"); // 0.39501 WSOL @ 9 dec
  assert.equal(QUOTE.action.toAddress.toLowerCase(), REVERSE_EVM_ADDRESS_LC); // recipient == the pinned EVM wallet
  assert.ok(QUOTE.transactionRequest?.data, "quote carries the executable Solana tx payload");
});

// ── STEP 1 — the X1 reverse burn tx (skim transfer + Warp bridge_out) ──
test("golden reverse step1: the X1 burn tx rebuild is byte-identical (serialized) + sha256", async () => {
  const rebuilt = await buildStep1ReverseBurn({ seq: SEQ });

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP1.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP1.sha256);
  assert.equal(rebuilt.bytesSha256, FIX_STEP1.bytesSha256);

  const a = rebuilt.artifact;
  // The deterministic stage-1 math (fee-model v2): 0.4 gross → 0.5% skim
  // 2,000,000 → bridge_out 398,000,000 (wSOL.X 9-dec). The 25bps Warp fee is
  // carved out of the bridge gross inside bridge_out (the live burn's fee
  // collector ATA received exactly 990,000 at the OLD 1% skim; the new-model
  // burn is 398,000,000 → Warp fee 995,000). Old 1% values: skim 4,000,000 /
  // bridge 396,000,000.
  assert.equal(a.seq, SEQ.toString());
  assert.equal(a.token, "wSOL.X");
  assert.equal(a.decimals, 9);
  assert.equal(a.grossBase, "400000000");
  assert.equal(a.skimBase, "2000000");
  assert.equal(a.bridgeBase, "398000000");
  assert.equal(a.feeAtaCreated, false); // live shape: the fee wallet's wSOL.X ATA exists on X1
  // CHAIN OF CUSTODY to ground truth: the skim destination ATA is the SAME
  // ATA the live burn tx 3q7H3kV4… transferred to (8YxSUo3… — the fee wallet
  // is the repo's own FEE_WALLETS constant in prod AND test).
  assert.equal(a.feeAta, "8YxSUo3EjM14C3UnRw7kJqTcNwHnAtvW15vP9nCqCCmw");
  assert.equal(a.blockhash, SAMPLE_INPUT.blockhash);
  assert.equal(a.instructionCount, 2); // skim transfer + bridge_out (no bundled create — ATA exists)

  // Serialized bytes must be a valid unsigned tx with the fixed blockhash.
  const tx = Transaction.from(Buffer.from(a.serializedBase64, "base64"));
  assert.equal(tx.recentBlockhash, SAMPLE_INPUT.blockhash);
  assert.equal(tx.feePayer.toBase58(), SAMPLE_INPUT.solanaAddress);
  assert.equal(tx.instructions.length, 2);

  // Instruction order + programs (Token-2022 skim transfer, then Warp).
  assert.equal(tx.instructions[0].programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(tx.instructions[1].programId.toBase58(), WARP_PROGRAM_ID.toBase58());

  // BridgeOut data = discriminator + u64le(seq) + u64le(bridgeBase).
  const data = tx.instructions[1].data;
  assert.equal(data.length, 24);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(dv.getBigUint64(8, true), BigInt(a.seq));
  assert.equal(dv.getBigUint64(16, true), BigInt(a.bridgeBase));

  // Account list slot-for-slot vs the VERIFIED mainnet burn shape (12
  // accounts — the same order as the live tx 3q7H3kV4…).
  assert.equal(a.accountList.length, 12);
  assert.equal(a.accountList[0].pubkey, "48Po6qAHRJojbXH7KRqt6s5GfNfs9VEGccfqYEHmubEi"); // config PDA
  assert.equal(a.accountList[3].pubkey, SAMPLE_INPUT.solanaAddress); // sender = the user
  assert.equal(a.accountList[3].isSigner, true);
  assert.equal(a.accountList[5].pubkey, X1_WSOLX_MINT.toBase58()); // wSOL.X mint
  assert.equal(a.accountList[8].pubkey, WARP_ACCOUNTS.feePda.toBase58()); // fee collector wallet
  assert.equal(a.accountList[9].pubkey, X1_WSOLX_FEE_ACCOUNT.toBase58()); // per-token fee ATA (9Tdid7tM…)
  assert.equal(a.accountList[10].pubkey, TOKEN_2022_PROGRAM_ID.toBase58()); // Token-2022
  assert.equal(a.accountList[11].pubkey, SystemProgram.programId.toBase58());
});

// ── STEP 2 — the release SHAPE (bridge_in_v2 native variant + release math) ──
test("golden reverse step2: the release shape rebuild is byte-identical + spec sha256 + release math", () => {
  const skim = (400000000n * SKIM_BPS) / 10_000n;
  const bridgeBase = 400000000n - skim; // 398,000,000 (0.5% skim — was 396,000,000 at 1%)
  const rebuilt = buildReverseReleaseShape({ seq: SEQ, bridgeBase });

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP2.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP2.sha256);
  assert.equal(rebuilt.specSha256, FIX_STEP2.specSha256);

  // The SPEC itself: 14 rows, exact names (the same spec both directions).
  assert.equal(rebuilt.spec.rowCount, 14);
  assert.deepEqual(
    rebuilt.spec.rows.map((r) => r.name),
    [
      "config", "guardian_set", "token_registry", "signature_set", "incoming_msg",
      "payer", "recipient", "recipient_token_account", "token_mint", "mint_authority",
      "vault", "vault_token_account", "token_program", "system_program",
    ],
  );

  // NATIVE variant (the release unlocks WSOL from the vault — verified
  // against the live release tx v6etkXX21…): vault pair INCLUDED,
  // mint_authority = the program-self placeholder. 11 offline-derivable rows
  // in spec order; signature_set / incoming_msg / payer are submitter- or
  // guardian-constructed (documented, never guessed).
  const a = rebuilt.artifact;
  assert.equal(a.nativeVariant, true);
  assert.equal(a.accountCount, 11);
  assert.equal(a.sourceTokenMint, X1_WSOLX_MINT.toBase58()); // burned on X1
  assert.equal(a.localMint, WSOL_MINT.toBase58()); // released on Solana
  assert.equal(a.accountList[0].pubkey, "48Po6qAHRJojbXH7KRqt6s5GfNfs9VEGccfqYEHmubEi"); // config
  assert.equal(a.accountList[2].name, "token_registry");
  assert.equal(a.accountList[3].name, "recipient");
  assert.equal(a.accountList[3].pubkey, SAMPLE_INPUT.solanaAddress);
  // recipient_token_account = the user's WSOL ATA (spl-token v1) — the ATA
  // the submitter creates-if-missing in front of its release tx.
  assert.equal(
    a.accountList[4].pubkey,
    getAssociatedTokenAddressSync(WSOL_MINT, new PublicKey(SAMPLE_INPUT.solanaAddress), false, TOKEN_PROGRAM_ID).toBase58(),
  );
  assert.equal(a.accountList[5].pubkey, WSOL_MINT.toBase58()); // token_mint
  assert.equal(a.accountList[6].name, "mint_authority");
  assert.equal(a.accountList[6].pubkey, WARP_PROGRAM_ID.toBase58()); // program-self placeholder (native)
  // CHAIN OF CUSTODY to ground truth: the vault pair == the live release's
  // vault accounts (9ZFmvmJk… / 3VPdmFYN… on Solana mainnet).
  const vaultPair = deriveVaultAccounts(WSOL_MINT, TOKEN_PROGRAM_ID);
  assert.equal(a.accountList[7].pubkey, vaultPair.vault.toBase58());
  assert.equal(a.accountList[7].pubkey, "9ZFmvmJkSpSuesGfSXj5VftVSDQpPNpFzu1vFi3yYeTG");
  assert.equal(a.accountList[8].pubkey, vaultPair.vaultTokenAccount.toBase58());
  assert.equal(a.accountList[8].pubkey, "3VPdmFYNvgF689JDTZfyrrP5pf9DuqbZ5gGQdjRmngGN");
  assert.equal(a.accountList[9].pubkey, TOKEN_PROGRAM_ID.toBase58()); // spl-token v1
  assert.equal(a.accountList[10].pubkey, SystemProgram.programId.toBase58());

  // Submitter/guardian rows are DOCUMENTED as templates — never guessed.
  const sc = a.submitterConstructed.map((r) => r.name);
  assert.deepEqual(sc, ["signature_set", "incoming_msg", "payer", "recipient_token_account_create"]);

  // THE RELEASE MATH (the poll leg's completion contract, fee-model v2):
  // bridge 398,000,000 − Warp 25bps (995,000) = 397,005,000 released on
  // Solana. (Old 1% values: bridge 396,000,000 − 990,000 = 395,010,000.)
  assert.equal(a.burnAmountBase, "398000000");
  assert.equal(a.warpFeeBase, "995000");
  assert.equal(a.releaseBase, "397005000");
  assert.equal(a.releaseHuman, 0.397005);

  // Cross-check vs the app's deterministic stage-1 math (computeReverseLegs):
  // the SAME numbers the quote box + the stage-2 LiFi leg use (fee-model v2).
  const legs = computeReverseLegs({ amount: 0.4, token: "wSOL.X" });
  assert.ok(Math.abs(legs.skim - 0.002) < 1e-12);
  assert.ok(Math.abs(legs.burnAmount - 0.398) < 1e-12);
  assert.ok(Math.abs(legs.warpFee - 0.000995) < 1e-12);
  assert.ok(Math.abs(legs.netOnSolana - 0.397005) < 1e-9);
});

// ── STEP 3 — the LiFi WSOL→USDC-on-ETH query (the toAddress PIN) ──
test("golden reverse step3: the LiFi-out query rebuild is byte-identical + sha256 + toAddress PINNED to the EVM wallet", () => {
  const rebuilt = buildStep3LifiOut({});

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_STEP3.artifact));
  assert.equal(rebuilt.sha256, FIX_STEP3.sha256);

  const a = rebuilt.artifact;
  // The PIN: the deterministic query's recipient == the EVM destination.
  assert.equal(a.toAddress, REVERSE_EVM_ADDRESS);
  assert.equal(a.toAddress.toLowerCase(), REVERSE_EVM_ADDRESS_LC);
  assert.equal(a.toAddress, SUMMARY.sampleInput.evmDestination);
  // The Solana-side fromToken: WSOL (9-dec) — what the Warp burn releases.
  assert.equal(a.fromSymbol, "WSOL");
  assert.equal(a.fromToken, "So11111111111111111111111111111111111111112");
  assert.equal(a.fromDecimals, 9);
  // The destination: USDC on Ethereum (chainId 1).
  assert.equal(a.toToken, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(a.toChain, "eth");
  // The deterministic net (fee-model v2): 0.397005 WSOL — what actually
  // lands on Solana after the 0.5% skim + Warp 25bps. (Old 1%: 0.39501.)
  assert.equal(a.fromAmountRaw, "397005000");
  assert.equal(a.fromAddress, SAMPLE_INPUT.solanaAddress);
  // x1-class query shape: no fee param (absent means absent — policy).
  assert.equal(a.hasFeeParam, false);
  assert.equal(a.x1Class, "1");
  assert.equal(a.slippage, "0.005");
  assert.equal(a.order, "CHEAPEST");
  assert.equal(a.allowSwitchChain, "false");

  // The query params the runner sends are EXACTLY what the pure builder
  // produces for the pinned destination (one code path — the leg cannot
  // drift from the reference builder).
  const direct = buildReverseLifiQuoteParams({
    to: "eth",
    toTokenSymbol: "USDC",
    netOnSolana: a.netOnSolana,
    fromAddress: SAMPLE_INPUT.solanaAddress,
    toAddress: REVERSE_EVM_ADDRESS,
    token: "wSOL.X",
  });
  assert.equal(direct.qs.get("toAddress"), REVERSE_EVM_ADDRESS);
  assert.equal(direct.qs.get("fromAmount"), "397005000");
});

test("golden reverse: the frozen quote's recipient == the PINNED EVM wallet (the engine cannot drift)", () => {
  const ref = quoteReferenceOf(QUOTE);
  assert.equal(ref.toAddress, REVERSE_EVM_ADDRESS); // canonical checksummed form
  assert.equal(ref.toAddress.toLowerCase(), REVERSE_EVM_ADDRESS_LC);
  assert.equal(ref.toAddress.toLowerCase(), SUMMARY.quoteReference.toAddress.toLowerCase());
  // fromToken WSOL 9-dec on Solana; toToken USDC on Ethereum.
  assert.equal(ref.fromTokenSymbol, "wSOL");
  assert.equal(ref.fromToken, "So11111111111111111111111111111111111111112");
  assert.equal(ref.fromTokenDecimals, 9);
  assert.equal(ref.toTokenSymbol, "USDC");
  assert.equal(ref.toToken, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(ref.toTokenChainId, 1);
  assert.equal(ref.fromAmountRaw, "395010000");
  assert.equal(ref.hasExecutablePayload, true);
  // The executable payload reference (sha256 over the base64-decoded bytes).
  assert.equal(ref.txPayloadSha256, SUMMARY.quoteReference.txPayloadSha256);
  const expectSha = createHash("sha256")
    .update(Buffer.from(QUOTE.transactionRequest.data, "base64"))
    .digest("hex");
  assert.equal(ref.txPayloadSha256, expectSha);
});

// ── Cross-step + determinism ──
test("golden reverse: full capture is reproducible + deterministic (rebuild twice, same bytes) + release chain of custody", async () => {
  const c1 = await captureReverseLeg({ quote: QUOTE });
  const c2 = await captureReverseLeg({ quote: QUOTE });
  for (const k of ["step1", "step2", "step3"]) {
    assert.equal(c1.steps[k].sha256, c2.steps[k].sha256, `${k} sha256 stable`);
    assert.equal(
      canonicalJson(c1.steps[k].artifact),
      canonicalJson(c2.steps[k].artifact),
      `${k} artifact stable`,
    );
  }

  // Derived math (the stage-1 → release chain, fee-model v2): 0.4 gross →
  // skim 2,000,000 → bridge 398,000,000 → Warp 25bps 995,000 → release
  // 397,005,000. (Old 1% values: 4,000,000 / 396,000,000 / 990,000 /
  // 395,010,000.)
  assert.equal(c1.derived.rawAmountGrossBase, "400000000");
  assert.equal(c1.derived.skimBase, "2000000");
  assert.equal(c1.derived.bridgeBase, "398000000");
  assert.equal(c1.derived.warpFeeBase, "995000");
  assert.equal(c1.derived.releaseBase, "397005000");
  assert.equal(c1.derived.seq, SEQ.toString());

  // Cross-step chain of custody: the release shape's burn amount == the burn
  // tx's bridge amount == the deterministic stage-1 math.
  assert.equal(c1.steps.step2.artifact.burnAmountBase, c1.steps.step1.artifact.bridgeBase);
  assert.equal(c1.steps.step1.artifact.bridgeBase, reverseBurnMath({ amountGross: 0.4 }).bridgeBase.toString());
  assert.equal(c1.steps.step2.artifact.releaseBase, reverseReleaseMath({ bridgeBase: 398000000n }).releaseBase.toString());
  assert.equal(c1.steps.step3.artifact.fromAmountRaw, c1.steps.step2.artifact.releaseBase); // LiFi bridges the net release

  // The sample's mock connection reports the live shape (fee ATA exists).
  const conn = mockX1ReverseConnection();
  const userInfo = await conn.getAccountInfo(new PublicKey(SAMPLE_INPUT.solanaAddress));
  assert.ok(userInfo && userInfo.lamports > 0, "mock reports the user's X1 fee-payer account");
  const feeAta = getAssociatedTokenAddressSync(
    X1_WSOLX_MINT, new PublicKey(SAMPLE_INPUT.feeWallet), true, TOKEN_2022_PROGRAM_ID,
  );
  const feeAtaInfo = await conn.getAccountInfo(feeAta);
  assert.ok(feeAtaInfo, "mock reports the fee wallet's wSOL.X ATA (the live shape)");
});

// ════════════════════════════════════════════════════════════════════════════
//  SYNTHETIC-LABELED ETH.X ROUTE — the per-asset PCT-DEFAULT oracle (the fee
//  lookup fix on v2 @ 1b541e5): a non-USDC percentage route must price the
//  Warp fee at 25 bps pct — NEVER the USDC.x flat $1. No live ETH.X bridge_out
//  burn exists to anchor (verified 2026-09-03 via getSignaturesForAddress on
//  the X1 mainnet RPC for the ETH.X mint 4wxJFFn… — only 4 txs, all ATA
//  creates, ZERO BridgeOut; live Warp config ETH.X dailyVolume 0), so the
//  input is SYNTHETIC-LABELED (mirrors the wSOL.X oracle's shape). The fee
//  SHAPE is anchored to the live Warp config (25 bps, 8 dec) and the stage-2
//  LiFi leg is a REAL live quote capture (relaydepository ETH-on-Solana →
//  USDC-on-eth) — see the summary's syntheticLabel block + README.
// ════════════════════════════════════════════════════════════════════════════

const ETHX_QUOTE = read("quote-ethx-usdc-eth-synthetic-0.4.json");
const FIX_ETHX_STEP1 = read("step1-x1-burn-ethx-synthetic.json");
const FIX_ETHX_STEP2 = read("step2-release-shape-ethx-synthetic.json");
const FIX_ETHX_STEP3 = read("step3-lifi-out-ethx-synthetic.json");
const ETHX_SUMMARY = read("reverse-leg-summary-ethx-synthetic.json");

test("golden reverse ETH.X (synthetic): the fixture input is the synthetic-labeled sample (mirrors the wSOL.X oracle shape)", () => {
  assert.equal(ETHX_SUMMARY.sampleInput.amountUser, 0.4);
  assert.equal(ETHX_SUMMARY.sampleInput.token, "ETH.X");
  assert.equal(ETHX_SUMMARY.sampleInput.to, "eth");
  assert.equal(ETHX_SUMMARY.sampleInput.toToken, "USDC");
  assert.equal(ETHX_SUMMARY.sampleInput.solanaAddress, SAMPLE_INPUT.solanaAddress);
  assert.equal(ETHX_SUMMARY.sampleInput.evmDestination, REVERSE_EVM_ADDRESS);
  assert.match(ETHX_SUMMARY.syntheticLabel.note, /SYNTHETIC-LABELED/);
  assert.match(ETHX_SUMMARY.syntheticLabel.note, /no live ETH\.X bridge_out burn exists/);
  // The frozen quote: a REAL live capture of the stage-2 leg (ETH on Solana → USDC on Ethereum).
  assert.equal(ETHX_QUOTE.tool, "relaydepository");
  assert.equal(ETHX_QUOTE.action.fromToken.address, "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"); // Solana ETH twin
  assert.equal(ETHX_QUOTE.action.fromToken.decimals, 8);
  assert.equal(ETHX_QUOTE.action.fromToken.symbol, "ETH");
  assert.equal(ETHX_QUOTE.action.toToken.address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"); // USDC on eth
  assert.equal(ETHX_QUOTE.action.toToken.chainId, 1);
  assert.equal(ETHX_QUOTE.action.fromAmount, "39700500"); // the deterministic release net @ 8 dec
  assert.equal(ETHX_QUOTE.action.toAddress.toLowerCase(), REVERSE_EVM_ADDRESS_LC);
});

test("golden reverse ETH.X (synthetic) step1: the X1 burn tx rebuild is byte-identical — ETH.X mint + fee ATA, bundled fee-ATA create", async () => {
  const seq = encodeReverseSeq(ETHX_SAMPLE_INPUT.seqSlot, 0);
  const rebuilt = await buildStep1ReverseBurn({
    solanaAddress: ETHX_SAMPLE_INPUT.solanaAddress,
    feeWallet: ETHX_SAMPLE_INPUT.feeWallet,
    amountGross: ETHX_SAMPLE_INPUT.amountUser,
    token: "ETH.X",
    seq,
    blockhash: ETHX_SAMPLE_INPUT.blockhash,
    connection: mockX1ReverseConnection({
      solanaAddress: ETHX_SAMPLE_INPUT.solanaAddress,
      mint: X1_REVERSE_TOKENS["ETH.X"].mint,
      decimals: 8,
      feeAtaExists: false, // synthetic shape: the fee wallet's ETH.X ATA does not exist on X1
    }),
  });
  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_ETHX_STEP1.artifact));
  assert.equal(rebuilt.sha256, FIX_ETHX_STEP1.sha256);
  assert.equal(rebuilt.bytesSha256, FIX_ETHX_STEP1.bytesSha256);

  const a = rebuilt.artifact;
  assert.equal(a.token, "ETH.X");
  assert.equal(a.decimals, 8);
  assert.equal(a.grossBase, "40000000"); // 0.4 ETH.X @ 8 dec
  assert.equal(a.skimBase, "200000"); // 0.5% skim
  assert.equal(a.bridgeBase, "39800000"); // bridge_out gross
  assert.equal(a.feeAtaCreated, true, "no live ETH.X fee ATA → the idempotent create is bundled");
  assert.equal(a.instructionCount, 3); // create → skim transfer → bridge_out
  assert.equal(a.accountList[5].pubkey, "4wxJFFnRSCgFgS8GvWH9iHgSjFsKbQpXkBG5Y826cbvw"); // ETH.X mint
  assert.equal(a.accountList[9].pubkey, "4JXWhxSyMB5fy7GDkqXqNCgA6tRWfK5qSY6gXChkHTvJ"); // ETH.X fee collector ATA (live config)
});

test("golden reverse ETH.X (synthetic) step2: release shape rebuild is byte-identical + the PER-ASSET PCT fee pin (25bps, never flat $1)", () => {
  const seq = encodeReverseSeq(ETHX_SAMPLE_INPUT.seqSlot, 0);
  const rebuilt = buildReverseReleaseShape({
    solanaAddress: ETHX_SAMPLE_INPUT.solanaAddress,
    seq,
    bridgeBase: 39800000n,
    token: "ETH.X",
    sourceTokenMint: X1_REVERSE_TOKENS["ETH.X"].mint,
    localMint: new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"),
    decimals: 8,
  });
  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_ETHX_STEP2.artifact));
  assert.equal(rebuilt.sha256, FIX_ETHX_STEP2.sha256);

  const a = rebuilt.artifact;
  assert.equal(a.token, "ETH.X");
  assert.equal(a.burnAmountBase, "39800000");
  assert.equal(a.warpFeeBase, "99500", "25 bps of the bridge gross — the pct fee, NOT the flat $1 (1_000_000 base)");
  assert.equal(a.releaseBase, "39700500");
  assert.equal(a.releaseHuman, 0.397005);

  // THE PIN: the per-asset fee lookup resolves ETH.X to pct 25bps — flat $1 is USDC.x-ONLY.
  const rel = reverseReleaseMath({ bridgeBase: 39800000n, token: "ETH.X" });
  assert.equal(rel.kind, "pct");
  assert.equal(rel.bps, 25);
  assert.equal(rel.warpFeeBase, 99500n);
  // Cross-check vs the app's deterministic stage-1 math (the same numbers the quote box uses).
  const legs = computeReverseLegs({ amount: 0.4, token: "ETH.X" });
  assert.ok(Math.abs(legs.skim - 0.002) < 1e-12);
  assert.ok(Math.abs(legs.burnAmount - 0.398) < 1e-12);
  assert.ok(Math.abs(legs.warpFee - 0.000995) < 1e-12, "0.25% of the gross — the pct default for a non-USDC asset");
  assert.ok(Math.abs(legs.netOnSolana - 0.397005) < 1e-9);
});

test("golden reverse ETH.X (synthetic) step3: the LiFi-out query rebuild is byte-identical — fromToken = Solana ETH (8 dec), toAddress PINNED", () => {
  const rebuilt = buildStep3LifiOut({
    token: "ETH.X",
    amountUser: ETHX_SAMPLE_INPUT.amountUser,
    toAddress: REVERSE_EVM_ADDRESS,
  });
  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_ETHX_STEP3.artifact));
  assert.equal(rebuilt.sha256, FIX_ETHX_STEP3.sha256);

  const a = rebuilt.artifact;
  assert.equal(a.token, "ETH.X");
  assert.equal(a.fromSymbol, "ETH"); // an ETH.X burn releases ETH on Solana (per-asset twin)
  assert.equal(a.fromToken, "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs");
  assert.equal(a.fromDecimals, 8);
  assert.equal(a.fromAmountRaw, "39700500"); // the deterministic release net @ 8 dec
  assert.equal(a.toAddress, REVERSE_EVM_ADDRESS);
  assert.equal(a.hasFeeParam, false);
  assert.equal(a.x1Class, "1");
});

test("golden reverse ETH.X (synthetic): the quote-box Warp line is warp-pct 0.25% — the summary pins the per-asset display", () => {
  // The fee lines in the summary come from the REAL fee code (deriveReverseQuote).
  const warpLine = ETHX_SUMMARY.quoteBox.feeLines.find((l) => l.id === "warp-pct");
  assert.ok(warpLine, "the ETH.X quote box shows warp-pct");
  assert.equal(warpLine.label, "Warp bridge fee (0.25%)");
  assert.equal(ETHX_SUMMARY.quoteBox.feeLines.find((l) => l.id === "warp-flat"), undefined, "NO flat $1 line on a non-USDC route");
  assert.equal(ETHX_SUMMARY.feePins.token, "ETH.X");
  assert.equal(ETHX_SUMMARY.feePins.warpFeeKind, "pct");
  assert.equal(ETHX_SUMMARY.feePins.warpFeeBps, 25);

  // Rebuild the quote-box strings from the live code — they must match the summary exactly.
  const dq = deriveReverseQuote({
    data: ETHX_QUOTE,
    to: "eth",
    amount: 0.4,
    token: "ETH.X",
    toToken: "USDC",
  });
  const ids = dq.feeLines.map((l) => l.id).sort();
  assert.deepEqual(ids, ["warp-pct", "warp-skim"]);
  assert.equal(dq.feeLines.find((l) => l.id === "warp-pct").label, "Warp bridge fee (0.25%)");
  assert.equal(dq.thirdPartyFeeUsd, 0.001, "0.25% of the 0.4 source — the raw third-party pass-through");
  assert.ok(Math.abs(dq.net - 951.729865) < 1e-6, "you-receive = the real LiFi toAmount (951.73 USDC on Ethereum)");
  assert.equal(dq.recvToken, "USDC");
  assert.equal(dq.recvChain, "Ethereum");
});

test("golden reverse ETH.X (synthetic): full capture is reproducible + deterministic (rebuild twice, same bytes)", async () => {
  const c1 = await captureReverseLeg({ quote: ETHX_QUOTE, sampleInput: ETHX_SAMPLE_INPUT });
  const c2 = await captureReverseLeg({ quote: ETHX_QUOTE, sampleInput: ETHX_SAMPLE_INPUT });
  for (const k of ["step1", "step2", "step3"]) {
    assert.equal(c1.steps[k].sha256, c2.steps[k].sha256, `${k} sha256 stable`);
    assert.equal(canonicalJson(c1.steps[k].artifact), canonicalJson(c2.steps[k].artifact), `${k} artifact stable`);
    assert.equal(c1.steps[k].sha256, ETHX_SUMMARY.steps[`${k === "step1" ? "step1X1Burn" : k === "step2" ? "step2ReleaseShape" : "step3LifiOut"}`].sha256, `${k} matches the committed fixture`);
  }
  // Derived chain (fee-model v2, per-asset pct): 0.4 ETH.X gross → skim 200,000 →
  // bridge 39,800,000 → Warp 25bps 99,500 → release 39,700,500 (0.397005 ETH).
  assert.equal(c1.derived.rawAmountGrossBase, "40000000");
  assert.equal(c1.derived.skimBase, "200000");
  assert.equal(c1.derived.bridgeBase, "39800000");
  assert.equal(c1.derived.warpFeeBase, "99500");
  assert.equal(c1.derived.releaseBase, "39700500");
  // Cross-step chain of custody.
  assert.equal(c1.steps.step2.artifact.burnAmountBase, c1.steps.step1.artifact.bridgeBase);
  assert.equal(c1.steps.step3.artifact.fromAmountRaw, c1.steps.step2.artifact.releaseBase);
});
