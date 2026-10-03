/**
 * forwardLegBuilders.mjs — deterministic rebuild helpers for the
 * golden-transaction fixtures (Tool 1 — the regression oracle for the
 * routing-engine migration).
 *
 * THE CONTRACT
 *   A routing engine will migrate the forward leg (ETH → X1). It is correct
 *   IF AND ONLY IF, given the SAME inputs, it constructs the EXACT
 *   transactions the current reference implementation constructs —
 *   byte-for-byte. This module is the single source of truth for the fixed
 *   sample input + the rebuild path: the capture script
 *   (tools/capture-golden-fixtures.mjs) writes the fixtures from it, and
 *   test/golden.test.js rebuilds from it and asserts byte-identity + sha256.
 *   The engine must make test/golden.test.js pass UNCHANGED.
 *
 * THE THREE FORWARD-LEG STEPS (what the current code produces TODAY)
 *   1. ERC-20 approval calldata — EXACT-amount approve() for the LiFi
 *      Diamond spender (src/lib/lifiApproval.js buildApprovalData). The code
 *      sends raw JSON-RPC params ({from,to,data,value}) — the wallet builds
 *      the envelope — so the app-controlled byte artifact is the calldata
 *      hex + the params object. Never MaxUint256.
 *   2. The Solana-side txs the forward leg constructs:
 *      2a. X1 recipient ATA create (idempotent, Token-2022) — the
 *          bridge_in_v2 prerequisite (warpBridge.js ensureX1RecipientAta).
 *      2b. The Warp lock tx — 1% skim SPL transfer + BridgeOut, built by
 *          warpBridge.js buildStage2 (compute budget + skim transfer +
 *          bridge_out, all in ONE transaction).
 *   3. The bridge_in_v2 account construction — the 14-row
 *      WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC serialized canonically, plus the
 *      concrete account list for the wrapped USDC.x case (11 offline-derivable
 *   keys in spec order + the guardian-signed signature_set — 12 at runtime).
 *      controls every slot it can: config/guardian_set/token_registry/
 *      incoming_msg/recipient ATA PDAs are all derived; signature_set is
 *      guardian-signed and NOT derivable offline — recorded as a seed
 *      template, see buildBridgeInV2AccountList).
 *
 * DETERMINISM
 *   - All wallet addresses are the repo's own test constants (warpBridge
 *     tests: USER / FEE_WALLET; teleportQuote tests: the EVM address).
 *   - The LiFi quote (which the current leg consumes verbatim — the stage-1
 *     bridge calldata is LI.Fi's, not ours) is FROZEN as an input fixture
 *     captured from the live v2 proxy on 2026-09-02 (Relay route, USDC
 *     ETH→SOL, 25.65 USDC). The oracle is about tx CONSTRUCTION given the
 *     same quote — not about the live quote.
 *   - The SVM txs need a blockhash + one RPC read (fee-ATA existence) —
 *     supplied by the deterministic mock connection below. The seq is fixed
 *     from a deterministic slot (see SAMPLE_INPUT) instead of fetchSeq().
 */
import { createHash } from "node:crypto";
import {
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { buildApprovalData } from "../../src/lib/lifiApproval.js";
import {
  buildStage2,
  ensureX1RecipientAta,
  deriveX1UsdcxAta,
  deriveVaultAccounts,
  encodeWarpSeq,
  deriveOutgoingMsgPda,
  toBaseUnits,
  WARP_PROGRAM_ID,
  WARP_ACCOUNTS,
  WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC,
  X1_USDCX_MINT,
  USDC_MINT,
} from "../../src/warpBridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// FIXED SAMPLE INPUT — deterministic, reproducible offline, drawn from the
// repo's own test constants (no live wallet, no live network needed).
// ─────────────────────────────────────────────────────────────────────────────
/** The connected EVM address used in the repo's quote tests + the live
 *  quote capture (teleportQuote.test.js EVM_ADDR). */
export const EVM_ADDRESS =
  "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";

/** The Solana/X1 wallet used in the repo's warpBridge tests (USER). */
export const SOLANA_ADDRESS = "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";

/** The Teleporter fee wallet (src/lib/fees.ts FEE_WALLETS.SVM). */
export const FEE_WALLET_SVM = "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu";

/** LI.Fi Diamond on Ethereum mainnet (lifiDiamondAllowlist.js chain 1) —
 *  the approval spender AND the stage-1 bridge tx target on this route. */
export const LIFI_DIAMOND_ETH =
  "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

/** The fixed blockhash every captured SVM tx serializes with. Same constant
 *  the repo's warpBridge tests use (US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx). */
export const FIXED_BLOCKHASH = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";

/** Deterministic Warp seq source: encodeWarpSeq(slot) with a FIXED slot so
 *  the bridge_out data + outgoing_msg PDA are reproducible offline. (The
 *  live leg derives seq from the current slot; the oracle fixes the input.) */
export const FIXED_SEQ_SLOT = 305_000_000;

/** The route sample: user sends 25.65 USDC on Ethereum → X1 as USDC.x. */
export const SAMPLE_INPUT = Object.freeze({
  from: "eth",
  token: "USDC",
  destToken: "USDC.x",
  amountUser: 25.65, // the tested amount (the task's fixed sample)
  evmAddress: EVM_ADDRESS,
  solanaAddress: SOLANA_ADDRESS,
  feeWalletSvm: FEE_WALLET_SVM,
  liFiDiamondEth: LIFI_DIAMOND_ETH,
  blockhash: FIXED_BLOCKHASH,
  seqSlot: FIXED_SEQ_SLOT,
});

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL SERIALIZATION + HASHING (fixtures are stored as canonical JSON)
// ─────────────────────────────────────────────────────────────────────────────
/** Canonical JSON: recursively sorted object keys, no insignificant
 *  whitespace. Byte-stable across runs/engines for the same logical object. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]))
      .join(",") +
    "}"
  );
}

/** sha256 hex of the canonical JSON of a value (UTF-8 bytes). */
export function sha256Of(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** sha256 hex of raw bytes (Uint8Array/Buffer). */
export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC MOCK CONNECTION (what the builders read from the network)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The capture/rebuild connection: one fixed blockhash, and the fee wallet's
 * source-token ATA reported as EXISTING — the live shape (the long-lived fee
 * wallet's USDC ATA exists on mainnet, so buildStage2 does NOT bundle a
 * fee-ATA create on the USDC route; the fixture captures the real shape).
 */
export function mockBuildConnection({ blockhash = FIXED_BLOCKHASH } = {}) {
  return {
    async getLatestBlockhash() {
      return { blockhash, lastValidBlockHeight: 99 };
    },
    async getAccountInfo() {
      // Every account queried exists — fee ATA present, X1 ATA absent is
      // handled by the caller-specific mock below where needed.
      return { lamports: 2_039_280, data: null };
    },
  };
}

/** X1-side connection for ensureX1RecipientAta: the recipient ATA does NOT
 *  exist yet (the create tx is what we capture). */
export function mockX1Connection({ blockhash = FIXED_BLOCKHASH } = {}) {
  return {
    async getLatestBlockhash() {
      return { blockhash, lastValidBlockHeight: 99 };
    },
    async getAccountInfo() {
      return null; // ATA missing → needsCreation (the captured shape)
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — ERC-20 EXACT-AMOUNT APPROVAL (the PR #3 shape)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Rebuild the approval artifact from the frozen quote + sample input.
 * `quote` = the frozen LiFi quote fixture (carries action.fromAmount = the
 * EXACT raw source amount + estimate.approvalAddress = the Diamond).
 *
 * Mirrors executeLiFiEvmTx: validateLiFiApproval resolves spender+amount
 * from the SAME step object that supplies the bridge tx, then
 * buildApprovalData(spender, EXACT amount) — never MaxUint256. The app sends
 * these params to eth_sendTransaction; the wallet builds the envelope.
 */
export function buildStep1Approval({ quote, evmAddress = EVM_ADDRESS }) {
  const step = quote?.transactionRequest ? quote : quote?.steps?.[0] || quote;
  const action = step?.action || {};
  const est = step?.estimate || {};
  const txReq = quote?.transactionRequest || quote?.steps?.[0]?.transactionRequest || {};
  const spender = (est?.approvalAddress || txReq?.to || "").toLowerCase();
  const amount = BigInt(action?.fromAmount ?? est?.fromAmount ?? 0);
  if (!/^0x[0-9a-f]{40}$/.test(spender)) {
    throw new Error("buildStep1Approval: quote carries no usable spender");
  }
  if (amount <= 0n) {
    throw new Error("buildStep1Approval: quote carries no positive fromAmount");
  }
  const calldata = buildApprovalData({ spender, amount });
  const params = {
    from: evmAddress.toLowerCase(),
    to: (action?.fromToken?.address || "").toLowerCase(),
    data: calldata,
    value: "0x0",
  };
  const artifact = {
    selector: calldata.slice(0, 10),
    spender,
    amountRaw: amount.toString(),
    amountHuman: Number(amount) / 10 ** (action?.fromToken?.decimals ?? 6),
    tokenAddress: params.to,
    evmAddress: params.from,
    calldata,
    txParams: params,
  };
  return {
    step: "approval",
    artifact,
    sha256: sha256Of(artifact),
    meta: {
      note:
        "EXACT-amount approve() calldata + eth_sendTransaction params the forward leg sends. " +
        "The wallet builds the envelope (nonce/gas) — the app-controlled bytes end at calldata.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2a — X1 RECIPIENT ATA PREP (bridge_in_v2 prerequisite, X1 chain)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Rebuild the X1 ATA-create transaction exactly as the forward leg builds it
 * (ensureX1RecipientAta: idempotent create, payer = the user, Token-2022).
 * Serialized with the fixed blockhash, requireAllSignatures:false (the
 * unsigned shape the wallet signs).
 */
export async function buildStep2aX1Ata({
  solanaAddress = SOLANA_ADDRESS,
  connection = mockX1Connection(),
  blockhash = FIXED_BLOCKHASH,
} = {}) {
  const user = new PublicKey(solanaAddress);
  const res = await ensureX1RecipientAta({
    connection,
    userPubkey: user,
    payer: user,
    mint: X1_USDCX_MINT,
  });
  if (!res.needsCreation) {
    throw new Error("buildStep2aX1Ata: mock must report the ATA missing");
  }
  const tx = res.transaction;
  tx.recentBlockhash = blockhash; // pin (mock already returns it — belt+braces)
  const bytes = tx.serialize({ requireAllSignatures: false });
  const artifact = {
    programId: res.transaction.instructions[0].programId.toBase58(),
    ata: res.ata.toBase58(),
    owner: solanaAddress,
    payer: solanaAddress,
    mint: X1_USDCX_MINT.toBase58(),
    tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    serializedBase64: Buffer.from(bytes).toString("base64"),
  };
  return {
    step: "x1-ata-prep",
    artifact,
    sha256: sha256Of(artifact),
    bytesSha256: sha256Bytes(bytes),
    meta: {
      note:
        "Idempotent createAssociatedTokenAccount (Token-2022) on X1 for the bridge_in_v2 " +
        "recipient ATA — built by ensureX1RecipientAta, executed on X1 before the Solana lock.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2b — THE WARP LOCK TX (Solana: skim SPL transfer + BridgeOut)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Rebuild the stage-2 Solana transaction exactly as buildStage2 builds it
 * (compute budget + 1% skim transfer to the fee wallet + Warp BridgeOut).
 * Fixed seq + fixed blockhash → byte-deterministic.
 */
export async function buildStep2bWarpLock({
  solanaAddress = SOLANA_ADDRESS,
  feeWalletSvm = FEE_WALLET_SVM,
  amountHuman,
  seq,
  blockhash = FIXED_BLOCKHASH,
  connection = mockBuildConnection(),
} = {}) {
  if (amountHuman === undefined) {
    throw new Error("buildStep2bWarpLock: amountHuman (LiFi-delivered) required");
  }
  const built = await buildStage2({
    connection,
    userPubkey: new PublicKey(solanaAddress),
    feeWalletSvm: new PublicKey(feeWalletSvm),
    amountHuman,
    seq, // fixed — no fetchSeq()
    destToken: "USDC.x",
  });
  const tx = built.transaction;
  tx.recentBlockhash = blockhash; // pin the fixed blockhash
  const bytes = tx.serialize({ requireAllSignatures: false });

  // The bridge_out instruction (last) account list, for the spec-order assert.
  const warpIx = tx.instructions.find((i) => i.programId.equals(WARP_PROGRAM_ID));
  const accountList = warpIx.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));

  const artifact = {
    seq: built.seq.toString(),
    seqSlot: FIXED_SEQ_SLOT,
    grossBase: toBaseUnits(amountHuman, 6).toString(),
    skimBase: built.skimBase.toString(),
    bridgeBase: built.bridgeBase.toString(),
    amountHuman,
    outgoingMsgPda: built.outgoing_msg.toBase58(),
    feeAtaCreated: built.feeAtaCreated,
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
    step: "warp-lock",
    artifact,
    sha256: sha256Of(artifact),
    bytesSha256: sha256Bytes(bytes),
    meta: {
      note:
        "The stage-2 Solana tx: ComputeBudget(60k) + 1% skim SPL transfer (user → fee wallet) " +
        "+ Warp BridgeOut(seq, bridgeBase) — built by buildStage2, serialized unsigned.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — bridge_in_v2 ACCOUNT CONSTRUCTION (the 14-row spec + account list)
// ─────────────────────────────────────────────────────────────────────────────
/** u64 little-endian bytes (browser-safe, mirrors warpBridge.js). */
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
 * Derive the concrete bridge_in_v2 account list for the wrapped USDC.x case
 * (bridge-to-self: recipient == the Solana sender).
 *
 * WHAT IS DERIVABLE OFFLINE (the app's side of the contract):
 *   config              PDA["config"]                        → 48Po6q… (verified)
 *   guardian_set        PDA["guardian_set"]
 *   token_registry      PDA["token_registry", local_mint]    (USDC.x on X1)
 *   incoming_msg        PDA["evt_in", u64le(source_seq)]
 *   payer               the user (signer)
 *   recipient           the user (bridge-to-self)
 *   recipient_token_account  ATA(USDC.x, recipient, Token-2022) ← the ATA the
 *                           app creates idempotently (step 2a) — the 
 *                           associated_token_program-free v2 IDL requires it
 *                           to pre-exist
 *   token_mint          X1_USDCX_MINT
 *   mint_authority      PDA["mint_authority", local_mint]    (wrapped: included)
 *   token_program       Token-2022
 *   system_program      SystemProgram
 *   vault / vault_token_account  native-only → OMITTED for wrapped USDC.x
 *
 * NOT DERIVABLE OFFLINE:
 *   signature_set       PDA seeds ["sig_set", guardian_set_index, source_seq,
 *                        sender, source_token_mint, local_mint, amount,
 *                        source_timestamp] — the source_timestamp (and the
 *                        guardian set index) come from the signed source
 *                        message the guardians verify. Guardian-side; the
 *                        fixture records the SEED TEMPLATE, and the engine
 *                        must reproduce every derivable slot byte-for-byte.
 *
 * `sourceTokenMint` = the SOLANA-side mint the bridge_out locked (USDC).
 * `amountBase` = the bridge gross the bridge_out locked (post-skim).
 */
export function buildBridgeInV2AccountList({
  solanaAddress = SOLANA_ADDRESS,
  seq,
  amountBase,
  sourceTokenMint = USDC_MINT,
  localMint = X1_USDCX_MINT,
  sourceChainId = 0,
  destChainId = 1,
} = {}) {
  const enc = (s) => new TextEncoder().encode(s);
  const pda = (seeds) =>
    PublicKey.findProgramAddressSync(seeds, WARP_PROGRAM_ID)[0].toBase58();
  const user = new PublicKey(solanaAddress);
  const localPk = localMint instanceof PublicKey ? localMint : new PublicKey(localMint);

  const derived = {
    config: pda([enc("config")]),
    guardian_set: pda([enc("guardian_set")]),
    token_registry: pda([enc("token_registry"), localPk.toBytes()]),
    incoming_msg: pda([enc("evt_in"), u64le(seq)]),
    payer: user.toBase58(),
    recipient: user.toBase58(),
    recipient_token_account: deriveX1UsdcxAta(user).toBase58(),
    token_mint: localPk.toBase58(),
    mint_authority: pda([enc("mint_authority"), localPk.toBytes()]),
    token_program: TOKEN_2022_PROGRAM_ID.toBase58(),
    system_program: SystemProgram.programId.toBase58(),
  };

  // Spec order, wrapped-token variant: every non-optional slot in spec
  // order, mint_authority included (wrapped), vault pair omitted (native-only).
  const keys = [];
  for (const row of WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC) {
    if (row.name === "vault" || row.name === "vault_token_account") continue; // native-only
    if (row.name === "signature_set") continue; // guardian-derived, below
    keys.push({
      name: row.name,
      pubkey: derived[row.name],
      isSigner: row.signer,
      isWritable: row.writable,
    });
  }

  const accountList = keys;
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
    amountBase: BigInt(amountBase).toString(),
    sourceTokenMint: (sourceTokenMint instanceof PublicKey ? sourceTokenMint : new PublicKey(sourceTokenMint)).toBase58(),
    localMint: localPk.toBase58(),
    wrappedVariant: true,
    signatureSetSeedTemplate: [
      "sig_set", "<guardian_set_index>", "<source_seq>", "<sender>",
      "<source_token_mint>", "<local_mint>", "<amount>", "<source_timestamp>",
    ],
    accountCount: accountList.length,
    accountList,
  };

  return {
    step: "bridge-in-v2",
    artifact,
    spec: {
      rows: specCanonical,
      rowCount: specCanonical.length,
    },
    sha256: sha256Of(artifact),
    specSha256: sha256Of(specCanonical),
    meta: {
      note:
        "The 14-row WARP_BRIDGE_IN_V2_ACCOUNTS_SPEC serialized canonically (specSha256) + the " +
        "concrete account list for wrapped USDC.x (bridge-to-self, 11 derivable keys + the " +
        "guardian-signed signature_set — 12 at runtime). signature_set is " +
        "guardian-signed (source_timestamp + guardian set index live in the signed message) — " +
        "recorded as its seed template. The engine must reproduce every derivable slot exactly.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FULL CAPTURE — one entry point for the capture script + the golden test
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build ALL three forward-leg fixtures from the frozen quote + fixed inputs.
 * `quote` = the frozen live quote (fixture input). Returns the four capture
 * objects {step, artifact, sha256, ...} plus the sample input and the
 * quote's own reference checksums (the stage-1 bridge calldata is LI.Fi's —
 * the engine must pass the quote through UNCHANGED).
 */
export async function captureForwardLeg({ quote }) {
  const action = quote?.action || {};
  const est = quote?.estimate || {};
  const deliveredBase = BigInt(est?.toAmount ?? 0);
  const amountHuman = Number(deliveredBase) / 10 ** 6; // Solana USDC, 6 dec
  const seq = encodeWarpSeq(SAMPLE_INPUT.seqSlot, 0); // source=Solana(0)→X1(1)

  const step1 = buildStep1Approval({ quote });
  const step2a = await buildStep2aX1Ata({});
  const step2b = await buildStep2bWarpLock({ amountHuman, seq });
  const step3 = buildBridgeInV2AccountList({
    seq,
    amountBase: step2b.artifact.bridgeBase, // what bridge_out actually locked
  });

  // The stage-1 EVM bridge tx (from the quote) as a byte-reference: the app
  // forwards transactionRequest verbatim — the engine must too.
  const txReq = quote?.transactionRequest || {};
  const quoteReference = {
    id: quote?.id ?? null,
    tool: quote?.tool ?? null,
    fromAmountRaw: String(action?.fromAmount ?? ""),
    toAmountRaw: String(est?.toAmount ?? ""),
    approvalAddress: (est?.approvalAddress ?? "").toLowerCase(),
    txTo: (txReq?.to ?? "").toLowerCase(),
    txChainId: txReq?.chainId ?? null,
    txValue: txReq?.value ?? null,
    txDataSha256: txReq?.data
      ? sha256Bytes(Buffer.from(txReq.data.slice(2), "hex"))
      : null,
  };

  return {
    sampleInput: SAMPLE_INPUT,
    derived: {
      rawAmount: String(action?.fromAmount ?? ""),
      deliveredBase: deliveredBase.toString(),
      amountHuman,
      seq: seq.toString(),
      seqSlot: SAMPLE_INPUT.seqSlot,
      skimBase: step2b.artifact.skimBase,
      bridgeBase: step2b.artifact.bridgeBase,
    },
    quoteReference,
    steps: { step1, step2a, step2b, step3 },
  };
}
