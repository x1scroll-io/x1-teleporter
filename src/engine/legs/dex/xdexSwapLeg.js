/**
 * xdexSwapLeg.js — the XDEX swap leg of the routing engine's DEX family
 * (Phase 4). XDEX = X1's DEX — a Raydium CP-Swap fork running ON X1. The
 * leg is a DIRECT integration (no aggregator router, no HTTP swap API —
 * XDEX has none; see the discovery note): the swap is a single on-chain
 * instruction to the XDEX program that the app constructs + signs itself.
 *
 * DISCOVERY (2026-09-02 — the real API is not HTTP): api.xdex.xyz exposes
 * price/token endpoints only (/api/token-price/price works; /api/pools is
 * Cloudflare-gated; every /api/swap/*, /api/v1/*, /api/pool/* probe 404s).
 * The REAL swap surface is the XDEX program on X1 mainnet:
 *
 *   program     sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN
 *               (upgradeable-loader, authority NONE — immutable; last deploy
 *               slot 21,171,632 ≈ 2026-01-07)
 *   method      SwapBaseInput (Anchor log "Instruction: SwapBaseInput" on
 *               live txs) — args (amount_in u64, minimum_amount_out u64)
 *   data        24 bytes: 8-byte discriminator 13bddf5c73d6bd24 + amount_in
 *               u64 LE + minimum_amount_out u64 LE
 *   accounts    13 metas (verified order + writable flags on live txs):
 *               payer(signer,wr) authority(ro) amm_config(ro) pool(wr)
 *               input ATA(wr) output ATA(wr) input vault(wr) output
 *               vault(wr) input token program(ro) output token program(ro)
 *               input mint(ro) output mint(ro) observation(wr)
 *
 * DISCRIMINATOR CORRECTION (important — the earlier 8fbe5ada note is
 * WRONG for the live program): the repo's Aug-2026 nebula-dex notes claim
 * the swap discriminator is 8fbe5adac41e33de (= sha256("global:
 * swap_base_input")[..8] under classic Anchor). EVERY live XDEX pool swap
 * sampled (273 txs across 12,504 pool signatures, slots 72.87M→76.0M,
 * Aug 20→Sep 2 2026) carries 13bddf5c73d6bd24 instead — and Raydium's own
 * live Solana CP-Swap program (CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C)
 * carries the SAME 13bddf5c73d6bd24 on its live swaps. XDEX is a faithful
 * fork of the CURRENT Raydium build (its AmmConfig account decodes
 * byte-for-byte against the current Raydium struct — len 236, fee fields at
 * the current offsets; pool account discriminator f7ede3f5d7c3de46 =
 * sha256("account:PoolState")). The Phase-4 oracle pins the OBSERVED live
 * discriminator.
 *
 * ARG-SEMANTICS HONESTY BOUNDARY (flagged integration prerequisite): the
 * swap layout above (args = amount_in u64 LE + min_out u64 LE) is the
 * Raydium CP-Swap source layout that the wire evidence is consistent with
 * (13-account Swap struct, 24-byte payload, per-tx-varying args). The pool's
 * recent live txs are relayer/AA-driven (native-XNT payers, ATA
 * create+sync patterns) whose arg bytes do NOT literally equal the observed
 * vault deltas — so arg byte semantics are NOT live-confirmed 1:1. Before
 * real funds: run ONE tiny controlled swap through this leg on the
 * operator's go-ahead and compare the vault deltas + program logs against
 * the fixture construction (the oracle's rebuild path doubles as the test
 * harness). The quote math below IS live-confirmed: the CP curve + the fee
 * config (trade 0.28% = 2800/1e6, protocol 25% + fund 5% of the trade fee,
 * creator 0 — decoded from the live AmmConfig) reproduce the observed
 * swap economics within rounding (raw-ratio price 0.3973 vs the XNT price
 * API 0.3926 USD — sane).
 *
 * QUOTE MATH (constant product, fee on input — Raydium curve):
 *   tradeFee  = ceil(amountInRaw × tradeFeeRate / 1_000_000)
 *   netIn     = amountInRaw − tradeFee
 *   outRaw    = floor(Rout × netIn / (Rin + netIn))     (Rin/Rout = vault
 *               raw balances of the input/output side from the pool snapshot)
 *   minOut    = floor(outRaw × (10000 − slippageBps) / 10000)
 * The input vault physically receives the GROSS amountIn; the fee accrues
 * in the vault for the protocol/fund collectors (Raydium semantics).
 *
 * ctx: { snapshot (the pool snapshot — vault balances + fee config + the
 *        fixed key set), userPubkey (X1/SVM session pubkey), inputMint,
 *        outputMint, amountInRaw, slippageBps?, blockhash? (DI — tests pin
 *        a synthetic one), feePayer? (defaults to userPubkey) }
 */
import { createLeg } from "../../legContract.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

/** The live XDEX program id on X1 mainnet (immutable since 2026-01-07). */
export const XDEX_PROGRAM_ID = "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN";
/** The live SwapBaseInput discriminator — OBSERVED on every live pool swap
 *  (see the module header: the 8fbe5ada… note in nebula-dex docs is stale —
 *  it does not match the live program). */
export const XDEX_SWAP_BASE_INPUT_DISCRIMINATOR = "13bddf5c73d6bd24";
/** Raydium/XDEX fee denominator (fee rates are hundredths of a bip, 1e-6). */
export const XDEX_FEE_DENOMINATOR = 1_000_000;
/** The pool's vault-authority PDA (constant per program — read from the
 *  snapshot in the artifact; exported for the fixed key documentation). */
export const XDEX_AUTHORITY = "9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU";

function toPubkey(pk) {
  return pk instanceof PublicKey ? pk : new PublicKey(pk);
}

/** Resolve the side roles from the pool snapshot for a requested pair.
 *  token0/token1 come from the snapshot's poolFields (token_0_mint /
 *  token_1_mint); the input side must be one of them. Returns the input
 *  vault, output vault, token programs, decimals and mints.
 * @throws when the pair is not the snapshot's pair
 */
export function resolveXdexDirection(snapshot, inputMint) {
  const t0 = snapshot?.poolFields?.token_0_mint;
  const t1 = snapshot?.poolFields?.token_1_mint;
  if (!t0 || !t1) throw new Error("resolveXdexDirection: snapshot has no token_0_mint/token_1_mint");
  const input = String(inputMint);
  let side;
  if (input === t0) side = { inputIsToken0: true };
  else if (input === t1) side = { inputIsToken0: false };
  else throw new Error(`resolveXdexDirection: ${input} is not the snapshot's pair (${t0}/${t1})`);

  const vault0 = snapshot.vault0 || {};
  const vault1 = snapshot.vault1 || {};
  const token0 = snapshot.token0 || {};
  const token1 = snapshot.token1 || {};
  return side.inputIsToken0
    ? {
        inputIsToken0: true,
        inputMint: t0,
        outputMint: t1,
        inputVault: snapshot.poolFields.token_0_vault,
        outputVault: snapshot.poolFields.token_1_vault,
        inputProgram: snapshot.poolFields.token_0_program,
        outputProgram: snapshot.poolFields.token_1_program,
        inputDecimals: token0.decimals,
        outputDecimals: token1.decimals,
        inputReserveRaw: vault0.amountRaw,
        outputReserveRaw: vault1.amountRaw,
      }
    : {
        inputIsToken0: false,
        inputMint: t1,
        outputMint: t0,
        inputVault: snapshot.poolFields.token_1_vault,
        outputVault: snapshot.poolFields.token_0_vault,
        inputProgram: snapshot.poolFields.token_1_program,
        outputProgram: snapshot.poolFields.token_0_program,
        inputDecimals: token1.decimals,
        outputDecimals: token0.decimals,
        inputReserveRaw: vault1.amountRaw,
        outputReserveRaw: vault0.amountRaw,
      };
}

/**
 * The XDEX constant-product quote for a fixed input amount (Raydium curve —
 * fee on input, gross amount physically lands in the input vault):
 *   tradeFee = ceil(amountInRaw × tradeFeeRate / 1e6)   (creator fee 0 in
 *     the live config; when a pool's creatorFeeRate > 0 AND the pool marks
 *     creator-fee-on-input, the input fee rate is trade + creator — the
 *     formula parameterizes via the snapshot's fee rates)
 *   outRaw   = floor(Rout × (amountInRaw − tradeFee) / (Rin + amountInRaw −
 *              tradeFee))
 *
 * @param {object} args
 * @param {object} args.snapshot the live pool snapshot (vault raw balances +
 *   ammConfig fee rates)
 * @param {string} args.inputMint the input mint (token0 or token1 of the pool)
 * @param {string|number} args.amountInRaw raw input amount in base units
 * @param {number} [args.slippageBps] slippage tolerance in bps (default 100)
 * @returns {{direction, tradeFeeRate, tradeFeeRaw, netInRaw, inRaw,
 *            outRaw, minOutRaw, priceImpactBps}} deterministic quote
 */
export function xdexQuote({ snapshot, inputMint, amountInRaw, slippageBps = 100 }) {
  const dir = resolveXdexDirection(snapshot, inputMint);
  const inRaw = BigInt(String(amountInRaw));
  if (inRaw <= 0n) throw new Error("xdexQuote: a positive raw input amount is required");

  const tradeFeeRate = BigInt(snapshot?.ammConfig?.tradeFeeRate ?? 0);
  const creatorFeeRate = BigInt(snapshot?.ammConfig?.creatorFeeRate ?? 0);
  // is_creator_fee_on_input is a per-pool runtime flag (not in the static
  // snapshot); with creatorFeeRate = 0 on the live config the distinction is
  // moot — the input fee rate is trade + creator when creator fees exist.
  const inputFeeRate = tradeFeeRate + creatorFeeRate;
  const feeDen = BigInt(XDEX_FEE_DENOMINATOR);
  // ceil(a × r / d)
  const tradeFeeRaw = (inRaw * inputFeeRate + feeDen - 1n) / feeDen;
  const netInRaw = inRaw - tradeFeeRaw;
  const rin = BigInt(String(dir.inputReserveRaw));
  const rout = BigInt(String(dir.outputReserveRaw));
  const outRaw = (rout * netInRaw) / (rin + netInRaw);
  const minOutRaw = (outRaw * BigInt(10000 - slippageBps)) / 10000n;

  // price impact vs the raw reserve ratio (in the output token per input token)
  const spotOut = (rout * 10000n) / rin; // out per 10000 in, raw
  const execOut = (outRaw * 10000n) / inRaw;
  const priceImpactBps = spotOut > 0n && execOut < spotOut
    ? Number(((spotOut - execOut) * 10000n) / spotOut)
    : 0;

  return {
    ...dir,
    tradeFeeRate: tradeFeeRate.toString(),
    tradeFeeRaw: tradeFeeRaw.toString(),
    netInRaw: netInRaw.toString(),
    inRaw: inRaw.toString(),
    outRaw: outRaw.toString(),
    minOutRaw: minOutRaw.toString(),
    outHuman: Number(outRaw) / 10 ** dir.outputDecimals,
    priceImpactBps,
    slippageBps,
  };
}

/**
 * Shape the golden artifact: the swap instruction (13 metas in the verified
 * order + the 24-byte data) and — when a blockhash is supplied — the full
 * unsigned serialized transaction (fee payer = the session pubkey). ATAs are
 * derived offline (getAssociatedTokenAddressSync, allowOwnerOffCurve).
 *
 * @param {object} args
 * @param {object} args.snapshot the live pool snapshot
 * @param {string} args.userPubkey the X1/SVM session pubkey
 * @param {string} args.inputMint token0 or token1 mint (the input side)
 * @param {string|number} args.amountInRaw raw input amount
 * @param {number} [args.slippageBps] slippage tolerance in bps
 * @param {string} [args.blockhash] DI'd blockhash — present → serialize the tx
 * @param {string} [args.feePayer] defaults to userPubkey
 * @returns {object} the fixture-shaped artifact
 */
export function shapeXdexSwapArtifact({
  snapshot,
  userPubkey,
  inputMint,
  amountInRaw,
  slippageBps = 100,
  blockhash = null,
  feePayer = null,
}) {
  const user = toPubkey(userPubkey);
  const quote = xdexQuote({ snapshot, inputMint, amountInRaw, slippageBps });
  const payer = feePayer ? toPubkey(feePayer) : user;

  const inputAta = getAssociatedTokenAddressSync(
    toPubkey(quote.inputMint),
    user,
    true, // allowOwnerOffCurve — the engine's session pubkeys can be PDAs
    toPubkey(quote.inputProgram),
  );
  const outputAta = getAssociatedTokenAddressSync(
    toPubkey(quote.outputMint),
    user,
    true,
    toPubkey(quote.outputProgram),
  );

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true }, // 0 payer
    { pubkey: toPubkey(XDEX_AUTHORITY), isSigner: false, isWritable: false }, // 1 authority
    { pubkey: toPubkey(snapshot.poolFields.amm_config), isSigner: false, isWritable: false }, // 2
    { pubkey: toPubkey(snapshot.pool), isSigner: false, isWritable: true }, // 3 pool
    { pubkey: inputAta, isSigner: false, isWritable: true }, // 4 input ATA
    { pubkey: outputAta, isSigner: false, isWritable: true }, // 5 output ATA
    { pubkey: toPubkey(quote.inputVault), isSigner: false, isWritable: true }, // 6
    { pubkey: toPubkey(quote.outputVault), isSigner: false, isWritable: true }, // 7
    { pubkey: toPubkey(quote.inputProgram), isSigner: false, isWritable: false }, // 8
    { pubkey: toPubkey(quote.outputProgram), isSigner: false, isWritable: false }, // 9
    { pubkey: toPubkey(quote.inputMint), isSigner: false, isWritable: false }, // 10
    { pubkey: toPubkey(quote.outputMint), isSigner: false, isWritable: false }, // 11
    { pubkey: toPubkey(snapshot.poolFields.observation_key), isSigner: false, isWritable: true }, // 12
  ];

  const data = Buffer.concat([
    Buffer.from(XDEX_SWAP_BASE_INPUT_DISCRIMINATOR, "hex"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(quote.inRaw)); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(quote.minOutRaw)); return b; })(),
  ]);

  const ix = {
    programId: XDEX_PROGRAM_ID,
    keys: keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    dataBase64: data.toString("base64"),
    dataHex: data.toString("hex"),
  };

  const artifact = {
    programId: XDEX_PROGRAM_ID,
    discriminator: XDEX_SWAP_BASE_INPUT_DISCRIMINATOR,
    pool: snapshot.pool,
    userPubkey: user.toBase58(),
    inputAta: inputAta.toBase58(),
    outputAta: outputAta.toBase58(),
    amountInRaw: quote.inRaw,
    minOutRaw: quote.minOutRaw,
    quote: {
      tradeFeeRate: quote.tradeFeeRate,
      tradeFeeRaw: quote.tradeFeeRaw,
      netInRaw: quote.netInRaw,
      inRaw: quote.inRaw,
      outRaw: quote.outRaw,
      minOutRaw: quote.minOutRaw,
      outHuman: quote.outHuman,
      priceImpactBps: quote.priceImpactBps,
      slippageBps: quote.slippageBps,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inputDecimals: quote.inputDecimals,
      outputDecimals: quote.outputDecimals,
    },
    ix,
  };

  if (blockhash) {
    const tx = new Transaction();
    tx.feePayer = payer;
    tx.recentBlockhash = blockhash;
    tx.add({
      programId: toPubkey(XDEX_PROGRAM_ID),
      keys: keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })),
      data,
    });
    artifact.transaction = {
      blockhash: tx.recentBlockhash,
      feePayer: payer.toBase58(),
      instructionCount: tx.instructions.length,
      serializedBase64: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64"),
    };
  }

  return artifact;
}

/**
 * Create the XDEX swap leg.
 * ctx per phase:
 *   build: { snapshot, userPubkey, inputMint, amountInRaw, slippageBps?,
 *            blockhash?, feePayer? }
 */
export function createXdexSwapLeg() {
  return createLeg({
    id: "xdex-swap",
    family: "svm",
    chain: "x1",
    description:
      "The XDEX swap leg (X1's Raydium-CP-Swap-fork DEX — DIRECT on-chain integration, " +
      "no HTTP swap API): the constant-product quote from the pool snapshot (0.28% trade " +
      "fee from the live AmmConfig) + the SwapBaseInput instruction (13 metas, disc " +
      "13bddf5c73d6bd24 — the OBSERVED live discriminator — + amount_in u64 LE + min_out " +
      "u64 LE) + the unsigned serialized tx (golden dex-leg fixtures). family svm — the " +
      "signer is the engine's single SignerResolver.",
    goldenStep: "xdex",
    phases: {
      async build(ctx) {
        if (!ctx.snapshot) throw new Error("xdexSwapLeg.build: snapshot (the pool state) is required");
        if (!ctx.userPubkey) throw new Error("xdexSwapLeg.build: userPubkey is required");
        if (!ctx.inputMint) throw new Error("xdexSwapLeg.build: inputMint is required");
        if (!Number.isFinite(Number(ctx.amountInRaw)) || Number(ctx.amountInRaw) <= 0) {
          throw new Error("xdexSwapLeg.build: a positive raw amountInRaw is required");
        }
        const artifact = shapeXdexSwapArtifact({
          snapshot: ctx.snapshot,
          userPubkey: ctx.userPubkey,
          inputMint: ctx.inputMint,
          amountInRaw: String(ctx.amountInRaw),
          slippageBps: ctx.slippageBps ?? 100,
          blockhash: ctx.blockhash ?? null,
          feePayer: ctx.feePayer ?? null,
        });
        return { needed: true, artifact };
      },
    },
    meta: {
      wraps:
        "GREENFIELD DIRECT integration (no HTTP API — the discovery): XDEX program " +
        "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN SwapBaseInput (disc 13bddf5c73d6bd24 — " +
        "observed live; the nebula 8fbe5ada note is stale) + the Raydium CP curve (fee on " +
        "input; live AmmConfig trade 2800/1e6, protocol 250000/1e6, fund 50000/1e6, creator 0). " +
        "ARG-SEMANTICS PREREQUISITE: layout source-consistent + wire-size-verified; run one " +
        "tiny controlled swap on the operator's go-ahead before real funds (sampled live txs " +
        "are relayer-driven and do not 1:1 expose the arg↔vault-delta mapping).",
    },
  });
}
