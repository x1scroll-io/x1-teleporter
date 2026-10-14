/**
 * reverseLegBuilders.mjs — deterministic rebuild helpers for the REVERSE-leg
 * golden-transaction fixtures (Phase 2 of the routing-engine migration).
 *
 * THE CONTRACT (mirror of test/golden/forwardLegBuilders.mjs)
 *   A routing engine will migrate the reverse leg (X1 → EVM). It is correct
 *   IF AND ONLY IF, given the SAME inputs, it constructs the EXACT
 *   transactions/artifacts the current reference implementation constructs —
 *   byte-for-byte. This module is the single source of truth for the fixed
 *   sample input + the rebuild path: the capture script
 *   (tools/capture-reverse-golden-fixtures.mjs) writes the fixtures from it,
 *   and test/goldenReverse.test.js rebuilds from it and asserts byte-identity
 *   + sha256. The engine must make test/goldenReverse.test.js pass UNCHANGED.
 *
 * THE THREE REVERSE-LEG STEPS (captured 2026-09-02 from last night's WORKING
 * reverse run — the one that delivered USDC to Ethereum — plus the live txs
 * used as ground truth: the X1 burn 3q7H3kV4…, the Solana release
 * v6etkXX21…, and the LiFi WSOL→USDC-on-ETH tx 25fvaCmt…):
 *   1. The X1 reverse burn tx — the app-constructed bytes: the 1% skim
 *      Token-2022 transfer to the Teleporter fee wallet + the Warp
 *      bridge_out BURN (token-aware wSOL.X: 9-dec, 25bps fee account) in ONE
 *      transaction (warpBridge buildReverseBurnWithSkim — the shared
 *      construction helper runReverse uses). Verified slot-for-slot against
 *      the live X1 burn tx (12-account BridgeOut; no fee-ATA create — the
 *      fee wallet's wSOL.X ATA exists on mainnet).
 *   2. The release SHAPE — the app's side of the Solana release contract:
 *      the expected release math (burn − Warp's 25bps = what the guardians
 *      release) + the bridge_in_v2 account construction in the NATIVE
 *      variant (the release unlocks WSOL from the vault: vault +
 *      vault_token_account present, mint_authority slot = the program id —
 *      verified against the live release tx v6etkXX21…). The release tx
 *      itself is SUBMITTER-constructed (official submitter + guardians) —
 *      documented, never built by the app.
 *   3. The LiFi WSOL→USDC-on-ETH query — the app-constructed query params
 *      (buildReverseLifiQuoteParams) with the PINNED EVM destination
 *      (toAddress = the EVM wallet — the #44 display value), plus the frozen
 *      live quote as the input fixture. The toAddress pin makes a
 *      wrong-recipient execution structurally impossible to drift into the
 *      fixtures.
 *
 * DETERMINISM
 *   - Wallet set = the repo's own test constants (the SAME set the forward
 *     fixtures use): SOLANA_ADDRESS (warpBridge USER), FEE_WALLET_SVM
 *     (FEE_WALLETS.X1/SVM). The EVM DESTINATION is pinned to the live
 *     destination wallet from the ground-truth run (0x1870aFAfA… — the
 *     canonical EIP-55 casing of the task's 0x1870aFAFA…; the all-caps
 *     variant fails the checksum and is rejected by LI.Fi).
 *   - The LiFi quote (which the app consumes verbatim) is FROZEN as an input
 *     fixture captured live through the stable v2 proxy on 2026-09-02
 *     (relaydepository route, WSOL→USDC on eth, 0.39501 WSOL). The oracle is
 *     about tx/query CONSTRUCTION given the same inputs — not the live quote.
 *   - The burn tx needs a blockhash + a few RPC reads — supplied by the
 *     deterministic mock X1 connection below. The seq is fixed from a
 *     deterministic slot (SAMPLE_INPUT.seqSlot) instead of the live slot.
 */
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  canonicalJson,
  sha256Of,
  sha256Bytes,
  SOLANA_ADDRESS,
  FEE_WALLET_SVM,
  FIXED_BLOCKHASH,
  FIXED_SEQ_SLOT,
} from "./forwardLegBuilders.mjs";
import {
  buildReverseBurnWithSkim,
  encodeReverseSeq,
  X1_REVERSE_TOKENS,
  X1_WSOLX_MINT,
  X1_ETHX_MINT,
  WSOL_MINT,
  ETH_MINT,
  USDC_MINT,
  X1_WSOLX_FEE_ACCOUNT,
  x1WarpFeeFor,
  WARP_PROGRAM_ID,
  WARP_ACCOUNTS,
  WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC,
  deriveVaultAccounts,
  toBaseUnits,
  SKIM_BPS,
} from "../../src/warpBridge.js";
import { buildReverseLifiQuoteParams, computeReverseLegs, reverseSolanaToken } from "../../src/lib/reverseQuote.js";

// ─────────────────────────────────────────────────────────────────────────────
// FIXED SAMPLE INPUT — deterministic, reproducible offline. Wallet set = the
// repo's own test constants (the SAME set as the forward fixtures).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The PINNED EVM destination — the connected EVM wallet the reverse LiFi leg
 * delivers to. Canonical EIP-55 casing of the ground-truth destination from
 * last night's working run (0x1870aFAFA… as logged — all-caps is NOT valid
 * EIP-55 and LI.Fi rejects it; the canonical form below is the same account).
 */
export const REVERSE_EVM_ADDRESS = "0x1870aFAfA502223f6F70b6DDB93dc4099C86C239";
export const REVERSE_EVM_ADDRESS_LC = REVERSE_EVM_ADDRESS.toLowerCase();

/** The route sample: user burns 0.4 wSOL.X on X1 → 0.39501 WSOL released on
 *  Solana → LiFi carries it to Ethereum as USDC. */
export const SAMPLE_INPUT = Object.freeze({
  from: "x1",
  to: "eth",
  token: "wSOL.X", // the X1 burn source (9-dec, Warp 25bps)
  toToken: "USDC", // the destination stable on Ethereum
  amountUser: 0.4, // the tested gross amount (the task's fixed sample)
  solanaAddress: SOLANA_ADDRESS,
  feeWallet: FEE_WALLET_SVM, // FEE_WALLETS.X1 === FEE_WALLETS.SVM (same wallet)
  evmDestination: REVERSE_EVM_ADDRESS,
  blockhash: FIXED_BLOCKHASH,
  seqSlot: FIXED_SEQ_SLOT,
});

/** SYNTHETIC-LABELED ETH.X route sample (the pct-default oracle for a
 *  non-USDC percentage route — the fee-model fix on v2 @ 1b541e5): the SAME
 *  shape as the wSOL.X sample (0.4 gross, same wallet set, same pinned EVM
 *  destination), but burning ETH.X (8 dec, Warp 25 bps pct). SYNTHETIC-LABELED
 *  per the honesty rule: NO live ETH.X bridge_out burn exists to anchor it —
 *  verified 2026-09-03 via getSignaturesForAddress on the X1 mainnet RPC for
 *  the ETH.X mint (4wxJFFn… — only 4 txs, all ATA creates, ZERO BridgeOut) +
 *  the live Warp config (ETH.X dailyVolume 0). The fee SHAPE (25 bps pct) is
 *  anchored to the live config token registry; the stage-2 LiFi leg IS a real
 *  live capture (relaydepository ETH-on-Solana → USDC-on-eth, quote
 *  quote-ethx-usdc-eth-synthetic-0.4.json, fromAmount 39700500 = the exact
 *  deterministic release net of this sample). */
export const ETHX_SAMPLE_INPUT = Object.freeze({
  from: "x1",
  to: "eth",
  token: "ETH.X", // the X1 burn source (8-dec, Warp 25bps pct — non-USDC pct rail)
  toToken: "USDC", // the destination stable on Ethereum
  amountUser: 0.4, // mirrors the wSOL.X sample gross
  solanaAddress: SOLANA_ADDRESS,
  feeWallet: FEE_WALLET_SVM,
  evmDestination: REVERSE_EVM_ADDRESS,
  blockhash: FIXED_BLOCKHASH,
  seqSlot: FIXED_SEQ_SLOT,
});

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC MOCK X1 CONNECTION (what the reverse builders read)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The capture/rebuild X1 connection: one fixed blockhash, the fee wallet's
 * wSOL.X ATA reported as EXISTING (the live shape — the live burn tx
 * 3q7H3kV4… had NO bundled create: the fee wallet's X1 wSOL.X ATA
 * 8YxSUo3EjM14C3UnRw7kJqTcNwHnAtvW15vP9nCqCCmw exists on mainnet), the
 * user's X1 system account + wSOL.X ATA funded (balance preflight passes).
 */
export function mockX1ReverseConnection({
  solanaAddress = SOLANA_ADDRESS,
  blockhash = FIXED_BLOCKHASH,
  slot = FIXED_SEQ_SLOT,
  mint = X1_WSOLX_MINT, // the X1 token mint whose ATAs the mock reports
  decimals = 9, // that token's decimals (balance base scale)
  feeAtaExists = true, // the fee wallet's X1 ATA for `mint` — true = the live wSOL.X shape (no bundled create)
} = {}) {
  const user = new PublicKey(solanaAddress);
  const userAta = getAssociatedTokenAddressSync(
    mint, user, true, TOKEN_2022_PROGRAM_ID,
  );
  const feeAta = getAssociatedTokenAddressSync(
    mint, new PublicKey(FEE_WALLET_SVM), true, TOKEN_2022_PROGRAM_ID,
  );
  return {
    async getAccountInfo(pk) {
      const p = pk instanceof PublicKey ? pk : new PublicKey(pk);
      if (p.equals(user)) return { lamports: 5_000_000, data: null };
      if (p.equals(userAta)) return { lamports: 2_039_280, data: null };
      if (p.equals(feeAta) && feeAtaExists) return { lamports: 2_039_280, data: null };
      return null;
    },
    async getTokenAccountBalance(pk) {
      const p = pk instanceof PublicKey ? pk : new PublicKey(pk);
      if (!p.equals(userAta)) throw new Error("mock: unexpected token account");
      const amount = String(10n ** BigInt(decimals)); // exactly 1.0 token
      return { value: { amount, decimals, uiAmount: 1 } };
    },
    async getSlot() {
      return slot;
    },
    async getLatestBlockhash() {
      return { blockhash, lastValidBlockHeight: 99 };
    },
    async simulateTransaction() {
      return { value: { err: null, logs: ["Program log: Instruction: BridgeOut"], unitsConsumed: 12345 } };
    },
    async sendRawTransaction() {
      return "x1-burn-sig";
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — THE X1 REVERSE BURN TX (skim transfer + Warp bridge_out)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The deterministic Stage-1 base math for the sample (mirror of the runner:
 * skim = 1% of the GROSS via SKIM_BPS; bridge_out burns the net). All human
 * values are derived FROM the integer base values so the artifact is
 * JSON-stable across runs.
 */
export function reverseBurnMath({ amountGross = SAMPLE_INPUT.amountUser, decimals = 9 } = {}) {
  const skimHuman = (amountGross * Number(SKIM_BPS)) / 10_000; // 1% of the gross
  const burnHuman = amountGross - skimHuman; // bridge_out burns the net
  const skimBase = toBaseUnits(skimHuman, decimals);
  const bridgeBase = toBaseUnits(burnHuman, decimals);
  return { skimHuman, burnHuman, skimBase, bridgeBase };
}

/**
 * Rebuild the X1 reverse burn tx exactly as the reference path builds it
 * (buildReverseBurnWithSkim — the SHARED construction helper: fee-wallet ATA
 * prep + buildReverseBurn + the prepended 1% skim transfer). Fixed seq +
 * fixed blockhash → byte-deterministic. Serialized unsigned
 * (requireAllSignatures:false — the shape the wallet signs).
 */
export async function buildStep1ReverseBurn({
  solanaAddress = SOLANA_ADDRESS,
  feeWallet = FEE_WALLET_SVM,
  amountGross = SAMPLE_INPUT.amountUser,
  token = "wSOL.X",
  seq,
  blockhash = FIXED_BLOCKHASH,
  connection = mockX1ReverseConnection({ solanaAddress }),
} = {}) {
  const tok = X1_REVERSE_TOKENS[token] || X1_REVERSE_TOKENS["USDC.x"];
  const { decimals } = tok;
  const { skimHuman, burnHuman, skimBase, bridgeBase } = reverseBurnMath({ amountGross, decimals });
  const theSeq = seq ?? encodeReverseSeq(SAMPLE_INPUT.seqSlot, 0);
  const { built, prep } = await buildReverseBurnWithSkim({
    connection,
    userPubkey: solanaAddress,
    amountHuman: burnHuman,
    feeAmount: skimHuman,
    feeWallet,
    token,
    seq: theSeq,
  });
  const tx = built.transaction;
  tx.recentBlockhash = blockhash; // pin the fixed blockhash
  const bytes = tx.serialize({ requireAllSignatures: false });

  // The bridge_out instruction (last) account list, for the spec-order assert.
  const burnIx = tx.instructions.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  const accountList = burnIx.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));

  const artifact = {
    seq: theSeq.toString(),
    seqSlot: SAMPLE_INPUT.seqSlot,
    token,
    decimals,
    grossBase: toBaseUnits(amountGross, decimals).toString(),
    skimBase: skimBase.toString(),
    bridgeBase: bridgeBase.toString(),
    grossHuman: Number(toBaseUnits(amountGross, decimals)) / 10 ** decimals,
    amountHuman: Number(bridgeBase) / 10 ** decimals,
    skimHuman: Number(skimBase) / 10 ** decimals,
    outgoingMsgPda: built.outgoing_msg.toBase58(),
    feeAtaCreated: prep?.needsCreation === true,
    feeAta: prep?.ata ? prep.ata.toBase58() : null,
    blockhash,
    instructionCount: tx.instructions.length,
    instructions: tx.instructions.map((ix) => ({
      programId: ix.programId.toBase58(),
      dataBase64: Buffer.from(ix.data).toString("base64"),
    })),
    accountList,
    serializedBase64: Buffer.from(bytes).toString("base64"),
  };
  return {
    step: "x1-reverse-burn",
    artifact,
    sha256: sha256Of(artifact),
    bytesSha256: sha256Bytes(bytes),
    meta: {
      note:
        "The X1 reverse burn tx: 1% skim Token-2022 transfer (user → fee wallet's wSOL.X ATA) " +
        "+ Warp BridgeOut(seq, bridgeBase) in ONE tx — built by buildReverseBurnWithSkim " +
        "(runReverse's shared construction helper), serialized unsigned. Live ground truth: " +
        "X1 burn 3q7H3kV4ZrrUPEbQ37DQv1cWRNmJ2V4pSMYZV3xCDYr8VrD58YZV9irDiveeCaYVmBqCxTu3cmxrXhepgJxegPe1 " +
        "(skim 4,000,000 base + bridge_out 396,000,000 base, 12-account BridgeOut, slot 75951086).",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — THE RELEASE SHAPE (bridge_in_v2 native variant + release math)
// ─────────────────────────────────────────────────────────────────────────────
/** u64 little-endian bytes (browser-safe; mirrors warpBridge.js). */
export function u64le(value) {
  const b = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

/**
 * The deterministic release net math: what the guardians release on Solana
 * after the X1 burn. bridge_out burns `bridgeBase` (the gross − our 0.5% skim);
 * the Warp program carves its own PER-TOKEN fee out of the burn gross INSIDE
 * bridge_out on X1 (wSOL.X: 25 bps — verified on-chain: the live burn's fee
 * collector ATA received exactly 990,000 base = 25bps of 396,000,000;
 * ETH.X/cbBTC.X: 25 bps per the live config; USDC.x: flat $1 — x1WarpFeeFor
 * is the per-asset lookup, so an UNKNOWN token resolves to the pct default,
 * never the flat) and the guardians release the remainder on Solana.
 */
export function reverseReleaseMath({ bridgeBase, token = "wSOL.X" } = {}) {
  const fee = x1WarpFeeFor(token);
  const warpFeeBase = fee.kind === "pct"
    ? (BigInt(bridgeBase) * BigInt(fee.bps)) / 10_000n
    : fee.amountBase;
  const releaseBase = BigInt(bridgeBase) - warpFeeBase;
  return { warpFeeBase, releaseBase, kind: fee.kind, bps: fee.kind === "pct" ? fee.bps : null };
}

/**
 * Rebuild the release SHAPE — the app's side of the Solana bridge_in_v2
 * contract (native variant): the WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC (14 rows)
 * serialized canonically + the concrete offline-derivable account list for
 * the WSOL release (11 derivable keys in spec order — the vault pair is
 * INCLUDED for native tokens, mint_authority is the program-self placeholder,
 * and the guardian/submitter rows — signature_set, incoming_msg, payer — are
 * recorded as submitter-constructed templates, never guessed).
 *
 * The release tx itself is constructed + broadcast by the OFFICIAL submitter
 * service (never the app — step 1.2 removed the self-relay); this fixture
 * pins what the APP knows: the derivable account shape + the expected release
 * amount (the poll leg's completion contract).
 */
export function buildReverseReleaseShape({
  solanaAddress = SOLANA_ADDRESS,
  seq,
  bridgeBase, // the burn amount bridge_out locked (gross − skim)
  token = "wSOL.X", // the X1 burn source — drives the per-asset Warp fee + decimals
  sourceTokenMint = X1_WSOLX_MINT,
  localMint = WSOL_MINT,
  decimals = 9, // the LOCAL (Solana-side release) token's decimals
  sourceChainId = 1, // X1
  destChainId = 0, // Solana
} = {}) {
  const enc = (s) => new TextEncoder().encode(s);
  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, WARP_PROGRAM_ID)[0];
  const user = new PublicKey(solanaAddress);
  const localPk = localMint instanceof PublicKey ? localMint : new PublicKey(localMint);
  const srcPk = sourceTokenMint instanceof PublicKey ? sourceTokenMint : new PublicKey(sourceTokenMint);

  const { warpFeeBase, releaseBase } = reverseReleaseMath({ bridgeBase, token });
  const vaultPair = deriveVaultAccounts(localPk, TOKEN_PROGRAM_ID);
  const recipientTokenAccount = getAssociatedTokenAddressSync(
    localPk, user, false, TOKEN_PROGRAM_ID, // WSOL is spl-token v1 — the release unlocks from the vault
  );

  const derived = {
    config: pda([enc("config")]).toBase58(),
    guardian_set: pda([enc("guardian_set")]).toBase58(),
    token_registry: pda([enc("token_registry"), localPk.toBytes()]).toBase58(),
    recipient: user.toBase58(),
    recipient_token_account: recipientTokenAccount.toBase58(),
    token_mint: localPk.toBase58(),
    // NATIVE variant (verified in the live release tx): the mint_authority
    // slot is filled with the PROGRAM ID (the Anchor optional-account
    // placeholder) — the vault pair is present because the release unlocks
    // WSOL from the vault instead of minting.
    mint_authority: WARP_PROGRAM_ID.toBase58(),
    vault: vaultPair.vault.toBase58(),
    vault_token_account: vaultPair.vaultTokenAccount.toBase58(),
    token_program: TOKEN_PROGRAM_ID.toBase58(),
    system_program: SystemProgram.programId.toBase58(),
  };

  // Derivable rows in spec order — signature_set (guardian-signed),
  // incoming_msg (message-derived) and payer (the submitter) are NOT
  // derivable offline: recorded as templates below, never guessed.
  const DERIVABLE_ROW_NAMES = [
    "config", "guardian_set", "token_registry", "recipient",
    "recipient_token_account", "token_mint", "mint_authority", "vault",
    "vault_token_account", "token_program", "system_program",
  ];
  const accountList = [];
  for (const row of WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC) {
    if (!DERIVABLE_ROW_NAMES.includes(row.name)) continue;
    accountList.push({
      name: row.name,
      pubkey: derived[row.name],
      isSigner: row.signer,
      isWritable: row.writable,
    });
  }
  if (accountList.length !== 11) {
    throw new Error(`buildReverseReleaseShape: expected 11 derivable rows, got ${accountList.length}`);
  }

  const specCanonical = WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC.map((row) => ({
    name: row.name,
    writable: row.writable,
    signer: row.signer,
    ...(row.optional ? { optional: true } : {}),
    ...(row.pdaSeeds ? { pdaSeeds: row.pdaSeeds } : {}),
  }));

  const artifact = {
    chainPair: `source=${sourceChainId} dest=${destChainId}`,
    seq: BigInt(seq).toString(),
    token,
    sourceTokenMint: srcPk.toBase58(), // burned on X1 (Token-2022)
    localMint: localPk.toBase58(), // released on Solana (native, spl-token v1)
    nativeVariant: true,
    burnAmountBase: BigInt(bridgeBase).toString(),
    warpFeeBase: warpFeeBase.toString(),
    releaseBase: releaseBase.toString(),
    releaseHuman: Number(releaseBase) / 10 ** decimals,
    accountCount: accountList.length,
    accountList,
    // Submitter/guardian-constructed rows — DOCUMENTED, never guessed. The
    // live release tx (v6etkXX21…) shows the concrete shapes.
    submitterConstructed: [
      {
        name: "signature_set",
        note: "guardian-signed PDA (source_timestamp + guardian set index live in the signed message) — created by the guardians",
      },
      {
        name: "incoming_msg",
        note: "message-derived PDA — NOT PDA['evt_in', seq] on the reverse leg (verified against the live release tx: slot 4 = 7qXzgMU8…, not the evt_in derivation)",
      },
      {
        name: "payer",
        note: "the OFFICIAL submitter service wallet (live release tx payer 84WXAPhJWLDjP16vqPL576UPubU2xb9EjNdP1YA1PvDE) — pays the release tx fee + signs",
      },
      {
        name: "recipient_token_account_create",
        note: "the submitter BUNDLES the idempotent ATA create in front when the recipient's WSOL ATA is missing (live release tx ix0 = createIdempotent for RC4yGH6Y…)",
      },
    ],
  };

  return {
    step: "release-shape",
    artifact,
    spec: {
      rows: specCanonical,
      rowCount: specCanonical.length,
    },
    sha256: sha256Of(artifact),
    specSha256: sha256Of(specCanonical),
    meta: {
      note:
        "The app's side of the Solana release contract: the 14-row WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC " +
        "(specSha256) + the NATIVE-variant derivable account list (11 rows in spec order — vault + " +
        "vault_token_account present, mint_authority = program-self placeholder) + the expected " +
        "release math. The release tx itself is SUBMITTER-constructed (official submitter + " +
        "guardians); the poll leg only DETECTS its destination tx. Live ground truth: Solana " +
        "release v6etkXX21dQdfeZf6TabWMv16PEQoKBLhHPEQGnriSkcRRkUgfYkb5jAd2q8KCwuHxSwyYqGExb4PY4rHCGszbk " +
        "(14-account bridge_in_v2, vault 9ZFmvmJk… debited exactly 395,010,000 base, submitter " +
        "84WXAPhJWLDjP16vqPL576UPubU2xb9EjNdP1YA1PvDE, slot 443613057).",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — THE LIFI WSOL→USDC-ON-ETH QUERY (the toAddress PIN)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Rebuild the reverse LiFi-out query artifact: buildReverseLifiQuoteParams
 * with the PINNED EVM destination. The deterministic query the stage-2
 * runner sends to /api/lifi/quote — the app-controlled bytes end at the
 * query (the executable Solana tx is LI.Fi's, frozen as the quote input).
 */
export function buildStep3LifiOut({
  to = "eth",
  toTokenSymbol = "USDC",
  token = "wSOL.X",
  amountUser = SAMPLE_INPUT.amountUser,
  netOnSolana, // the deterministic stage-1 net (defaults to the sample's)
  fromAddress = SOLANA_ADDRESS,
  toAddress = REVERSE_EVM_ADDRESS,
  slippage = 0.5,
} = {}) {
  if (netOnSolana === undefined) {
    netOnSolana = computeReverseLegs({ amount: amountUser, token }).netOnSolana;
  }
  const built = buildReverseLifiQuoteParams({
    to,
    toTokenSymbol,
    netOnSolana,
    fromAddress,
    toAddress, // THE PIN — the EVM destination (no placeholders)
    slippage,
    token,
  });
  if (!built) throw new Error("buildStep3LifiOut: no route for the sample chain/token set");

  const fromSymbol = reverseSolanaToken(token);
  const artifact = {
    to,
    toTokenSymbol,
    token, // the X1 source token — drives the Solana-side fromToken
    fromSymbol,
    decimals: built.decimals,
    toDecimals: built.toDecimals,
    fromDecimals: built.decimals,
    netOnSolana,
    fromAmountRaw: built.qs.get("fromAmount"),
    fromChain: built.qs.get("fromChain"),
    toChain: built.qs.get("toChain"),
    fromToken: built.qs.get("fromToken"), // WSOL (So111…) — the Warp release token
    toToken: built.qs.get("toToken"), // USDC on the destination EVM chain
    fromAddress: built.qs.get("fromAddress"),
    toAddress: built.qs.get("toAddress"), // THE PINNED EVM DESTINATION
    slippage: built.qs.get("slippage"),
    integrator: built.qs.get("integrator"),
    order: built.qs.get("order"),
    allowSwitchChain: built.qs.get("allowSwitchChain"),
    x1Class: built.qs.get("x1Class"),
    hasFeeParam: built.qs.has("fee"), // x1-class: the fee key is ABSENT (policy)
    qsParams: Object.fromEntries([...built.qs.entries()].sort()),
  };
  return {
    step: "lifi-out",
    artifact,
    sha256: sha256Of(artifact),
    meta: {
      note:
        "The deterministic Solana→EVM LiFi query (buildReverseLifiQuoteParams): WSOL (9-dec, " +
        "released by the Warp burn) → the user-selected stable on the destination EVM chain, " +
        "with toAddress PINNED to the EVM destination 0x1870aFAfA… — the #44 display value. " +
        "x1-class: no fee param (absent means absent). The executable tx bytes are LI.Fi's — " +
        "frozen as the quote input fixture; the oracle pins the QUERY + the recipient.",
    },
  };
}

/**
 * The quote reference: what the FROZEN quote must carry for this sample
 * (from/to tokens, the PINNED recipient, the executable payload reference).
 */
export function quoteReferenceOf(quote) {
  const action = quote?.action || {};
  const est = quote?.estimate || {};
  const txReq = quote?.transactionRequest || {};
  const b64 = txReq?.data || txReq?.transaction || null;
  return {
    tool: quote?.tool ?? null,
    fromAmountRaw: String(action?.fromAmount ?? ""),
    toAmountRaw: String(est?.toAmount ?? ""),
    fromTokenSymbol: action?.fromToken?.symbol ?? null,
    fromToken: action?.fromToken?.address ?? null,
    fromTokenDecimals: action?.fromToken?.decimals ?? null,
    fromTokenChainId: action?.fromToken?.chainId ?? null,
    toTokenSymbol: action?.toToken?.symbol ?? null,
    toToken: action?.toToken?.address ?? null,
    toTokenChainId: action?.toToken?.chainId ?? null,
    fromAddress: action?.fromAddress ?? null,
    toAddress: action?.toAddress ?? null, // MUST equal the pinned EVM destination
    hasExecutablePayload: Boolean(b64),
    txPayloadSha256: b64
      ? sha256Bytes(Buffer.from(b64, "base64"))
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FULL CAPTURE — one entry point for the capture script + the golden test
// ─────────────────────────────────────────────────────────────────────────────
/** The Solana-side twin (local release mint + decimals) of each X1 burn
 *  source — per the live Warp config token registry. ETH.X releases ETH
 *  (Wormhole 7vfCX…, 8 dec); wSOL.X releases WSOL (So111…, 9 dec); USDC.x
 *  releases USDC (6 dec). */
export const SOLANA_TWINS = {
  "USDC.x": { localMint: USDC_MINT, decimals: 6 },
  "wSOL.X": { localMint: WSOL_MINT, decimals: 9 },
  "ETH.X": { localMint: ETH_MINT, decimals: 8 },
};

/** Whether the FEE WALLET's X1 ATA for the sample token already exists on
 *  mainnet (drives feeAtaCreated in the step1 burn artifact):
 *   - wSOL.X: TRUE — the live shape (fee wallet's wSOL.X ATA 8YxSUo3… exists;
 *     the live burn tx 3q7H3kV4… had NO bundled create)
 *   - ETH.X: FALSE — SYNTHETIC shape (no live ETH.X burn exists to anchor;
 *     the fee wallet has no ETH.X ATA on X1 — verified via the mint's tx
 *     history, all ATA creates for other wallets — so an executable burn
 *     would bundle the idempotent create)
 */
export const FEE_ATA_EXISTS = {
  "wSOL.X": true,
  "ETH.X": false,
};

/**
 * Build ALL three reverse-leg fixtures from the fixed sample input + the
 * frozen quote. `quote` = the frozen live quote (input fixture); `sampleInput`
 * defaults to the wSOL.X SAMPLE_INPUT (the historical oracle) — pass
 * ETHX_SAMPLE_INPUT for the synthetic ETH.X pct-default route. Returns the
 * three capture objects {step, artifact, sha256, ...} plus the sample input,
 * the deterministic stage-1/release math, and the quote's reference.
 */
export async function captureReverseLeg({ quote, sampleInput = SAMPLE_INPUT }) {
  const seq = encodeReverseSeq(sampleInput.seqSlot, 0); // chain-pair 0x10: X1→Sol
  const x1tok = X1_REVERSE_TOKENS[sampleInput.token];
  const twin = SOLANA_TWINS[sampleInput.token] || { localMint: WSOL_MINT, decimals: 9 };
  const feeAtaExists = FEE_ATA_EXISTS[sampleInput.token] !== false;
  const burn = await buildStep1ReverseBurn({
    solanaAddress: sampleInput.solanaAddress,
    feeWallet: sampleInput.feeWallet,
    amountGross: sampleInput.amountUser,
    token: sampleInput.token,
    seq,
    blockhash: sampleInput.blockhash,
    connection: mockX1ReverseConnection({
      solanaAddress: sampleInput.solanaAddress,
      blockhash: sampleInput.blockhash,
      slot: sampleInput.seqSlot,
      mint: x1tok.mint,
      decimals: x1tok.decimals,
      feeAtaExists,
    }),
  });
  const { bridgeBase } = burn.artifact;
  const step2 = buildReverseReleaseShape({
    solanaAddress: sampleInput.solanaAddress,
    seq,
    bridgeBase, // the burn amount bridge_out actually locked
    token: sampleInput.token,
    sourceTokenMint: x1tok.mint,
    localMint: twin.localMint,
    decimals: twin.decimals,
  });
  const step3 = buildStep3LifiOut({
    token: sampleInput.token,
    amountUser: sampleInput.amountUser,
    toAddress: sampleInput.evmDestination,
  });
  const math = reverseBurnMath({ amountGross: sampleInput.amountUser, decimals: x1tok.decimals });
  const release = reverseReleaseMath({ bridgeBase, token: sampleInput.token });

  return {
    sampleInput,
    derived: {
      rawAmountGrossBase: (math.skimBase + math.bridgeBase).toString(),
      skimBase: math.skimBase.toString(),
      bridgeBase: math.bridgeBase.toString(),
      warpFeeBase: release.warpFeeBase.toString(),
      releaseBase: release.releaseBase.toString(),
      releaseHuman: Number(release.releaseBase) / 10 ** twin.decimals,
      seq: seq.toString(),
      seqSlot: sampleInput.seqSlot,
    },
    quoteReference: quoteReferenceOf(quote),
    steps: { step1: burn, step2, step3 },
  };
}

export { canonicalJson, sha256Of, sha256Bytes };
