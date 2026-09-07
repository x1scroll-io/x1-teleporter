/**
 * raydiumSwapLeg.js — the RAYDIUM DEX-DIRECT swap leg (the dexDirect
 * family's Solana fallback, Phase 6 scaffold). Two direct integrations on
 * one leg surface:
 *
 *   CPMM — the constant-product program (CPMMoo8…; the same curve the XDEX
 *          leg proved on X1 — Raydium's CP-Swap is XDEX's upstream). Quote
 *          = the constant-product math on the LIVE pool state (pool +
 *          config + vault balances — getAccountInfo, read-only). Swap ix =
 *          swap_base_input (disc 8fbe5adac41e33de, 13 metas — the exact
 *          layout makeSwapCpmmBaseInInstruction builds; identical family to
 *          the live-anchored XDEX construction).
 *   CLMM — the concentrated-liquidity program (CAMMCzo5…; Uniswap-v3-style
 *          with Q64 prices + fee-on-input). Quote = the full tick-walk
 *          swap simulator mirrored from raydium-sdk-v2's swapMath/
 *          swapSimulator (BigInt), cross-checked against the SDK on the
 *          frozen capture. Swap ix = swap_v2 (disc 2b04ed0b1ac91e62 —
 *          hmm, shared with Orca's swap_v2 name; Raydium's is
 *          sha256("global:swap_v2")[..8] from ITS program — the same
 *          preimage, so the same 8 bytes).
 *
 * Both halves are SIGNABLE on execute: the swap instruction is rebuilt by
 * the OFFICIAL raydium-sdk-v2 builders (makeSwapCpmmBaseInInstruction /
 * ClmmInstrument.swapV2Instruction — byte-pinned to the frozen layouts by
 * the solanaSdk drift canaries) and planRaydiumExecute returns
 * { needsSetup, setupTx?, swapTx } for Mr. Esters' wallet (Backpack) to
 * sign (ATA-create setup when the pair's accounts don't exist). submit()
 * throws DexDirectLiveTestGateError — the agent CANNOT broadcast; sign in
 * your wallet. No funds, no broadcast — quotes are read-only pool-state
 * math; the signable txs carry a fresh blockhash for the wallet UI.
 *
 * ctx (build): { dex: "cpmm"|"clmm", snapshot, userPubkey, inputMint,
 *   amountInRaw, slippageBps?, amountOutMinRaw?, blockhash?, feePayer? }
 *   snapshot for cpmm: { pool: decodeRaydiumCpmmPool, config:
 *   decodeRaydiumCpmmConfig, vaultA/vaultB: { mint, amountRaw } }
 *   snapshot for clmm: { pool: decodeRaydiumClmmPool, config:
 *   decodeRaydiumClmmConfig, tickArrays: [decodeRaydiumClmmTickArray…] }
 */
import { createLeg } from "../../legContract.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Q64,
  mulDivCeil,
  mulDivFloor,
  divRoundingUp,
  readLe,
  toSigned,
  RAYDIUM_TICK_FACTORS,
  RAYDIUM_CLMM_MIN_TICK,
  RAYDIUM_CLMM_MAX_TICK,
  RAYDIUM_CLMM_MIN_SQRT_PRICE_X64,
  RAYDIUM_CLMM_MAX_SQRT_PRICE_X64,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
} from "./solanaMath.js";
import { DexDirectLiveTestGateError, DEX_DIRECT_LIVE_TEST_GATE_MESSAGE } from "./liveTestGate.js";

/** Raydium CPMM (constant-product) program — mainnet. */
export const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
/** Raydium CLMM (concentrated) program — mainnet. */
export const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
/** The vault authority PDA seed (shared by both Raydium programs). */
export const RAYDIUM_AUTH_SEED = "vault_and_lp_mint_auth_seed";
/** Fee denominator (rates are /1e6). */
export const RAYDIUM_FEE_DENOMINATOR = 1_000_000n;
/** sha256("global:swap_base_input")[..8] — CPMM (LIVE-anchored family: the
 *  XDEX leg proved this exact discriminator on X1). */
export const RAYDIUM_CPMM_SWAP_BASE_INPUT_DISCRIMINATOR = "8fbe5adac41e33de";
/** sha256("global:swap_v2")[..8] — CLMM's swap instruction. */
export const RAYDIUM_CLMM_SWAP_V2_DISCRIMINATOR = "2b04ed0b1ac91e62";
/** CLMM: ticks per tick array (60) and the i32 BE seed convention. */
export const RAYDIUM_CLMM_TICK_ARRAY_SIZE = 60;
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ─────────────────────────────────────────────────────────────────────────────
// CPMM — account decodes (offsets = CpmmPoolInfoLayout / CpmmConfigInfoLayout
// from raydium-sdk-v2, pure borsh order; verified against the live pool)
// ─────────────────────────────────────────────────────────────────────────────
export function decodeRaydiumCpmmPool(data, pool = null) {
  if (!data || data.length < 637) throw new Error("decodeRaydiumCpmmPool: data too short");
  const pk = (o) => new PublicKey(data.subarray(o, o + 32)).toBase58();
  return {
    pool,
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    configId: pk(8),
    poolCreator: pk(40),
    vaultA: pk(72),
    vaultB: pk(104),
    mintLp: pk(136),
    mintA: pk(168),
    mintB: pk(200),
    mintProgramA: pk(232),
    mintProgramB: pk(264),
    observationId: pk(296),
    bump: data[328],
    status: data[329],
    lpDecimals: data[330],
    mintDecimalA: data[331],
    mintDecimalB: data[332],
    lpAmount: readLe(data, 333, 8).toString(),
    openTime: readLe(data, 373, 8).toString(),
    feeOn: data[389],
    enableCreatorFee: data[390] === 1,
  };
}

export function decodeRaydiumCpmmConfig(data) {
  if (!data || data.length < 236) throw new Error("decodeRaydiumCpmmConfig: data too short (CpmmConfig = 236 bytes)");
  return {
    bump: data[8],
    disableCreatePool: data[9] === 1,
    index: Number(readLe(data, 10, 2)),
    tradeFeeRate: readLe(data, 12, 8).toString(),
    protocolFeeRate: readLe(data, 20, 8).toString(),
    fundFeeRate: readLe(data, 28, 8).toString(),
    createPoolFee: readLe(data, 36, 8).toString(),
    protocolOwner: new PublicKey(data.subarray(44, 76)).toBase58(),
    fundOwner: new PublicKey(data.subarray(76, 108)).toBase58(),
    creatorFeeRate: readLe(data, 108, 8).toString(),
  };
}

/** The CPMM vault-authority PDA (["vault_and_lp_mint_auth_seed"]). */
export async function raydiumCpmmAuthority() {
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from(RAYDIUM_AUTH_SEED)],
    new PublicKey(RAYDIUM_CPMM_PROGRAM_ID),
  );
  return pda.toBase58();
}

/**
 * The CPMM constant-product quote (mirror of the SDK's
 * CurveCalculator.swapBaseInput + ConstantProductCurve — the same curve the
 * xdexSwapLeg proved live on X1): trade fee (ceil) on input, optional
 * creator fee on input or output per the pool's flag, then
 * out = floor(Rout × net / (Rin + net)) on the vault raw balances.
 */
export function raydiumCpmmQuote({ snapshot, inputMint, amountInRaw, slippageBps = 100 }) {
  const pool = snapshot.pool;
  const config = snapshot.config;
  const inputIsA = inputMint === pool.mintA;
  if (!inputIsA && inputMint !== pool.mintB) {
    throw new Error(`raydiumCpmmQuote: inputMint ${inputMint} is not a mint of pool ${pool.pool}`);
  }
  const vaultIn = inputIsA ? snapshot.vaultA : snapshot.vaultB;
  const vaultOut = inputIsA ? snapshot.vaultB : snapshot.vaultA;
  const inRaw = BigInt(String(amountInRaw));
  if (inRaw <= 0n) throw new Error("raydiumCpmmQuote: a positive raw input amount is required");
  const rin = BigInt(String(vaultIn.amountRaw));
  const rout = BigInt(String(vaultOut.amountRaw));
  if (rin <= 0n || rout <= 0n) throw new Error("raydiumCpmmQuote: vault reserves must be positive");

  const tradeFeeRate = BigInt(config.tradeFeeRate);
  const creatorFeeRate = BigInt(config.creatorFeeRate ?? "0");
  const isCreatorFeeOnInput = pool.feeOn === 1 && pool.enableCreatorFee === true;
  const tradeFee = mulDivCeil(inRaw, tradeFeeRate, RAYDIUM_FEE_DENOMINATOR);
  let netIn = inRaw - tradeFee;
  let creatorFee = 0n;
  if (isCreatorFeeOnInput && creatorFeeRate > 0n) {
    creatorFee = mulDivCeil(inRaw, creatorFeeRate, RAYDIUM_FEE_DENOMINATOR);
    netIn = netIn - creatorFee;
  }
  const cpOut = (rout * netIn) / (rin + netIn); // floor — the CP curve
  let outRaw = cpOut;
  if (!isCreatorFeeOnInput && creatorFeeRate > 0n) {
    creatorFee = mulDivCeil(cpOut, creatorFeeRate, RAYDIUM_FEE_DENOMINATOR);
    outRaw = cpOut - creatorFee;
  }
  const minOutRaw = (outRaw * BigInt(10000 - slippageBps)) / 10000n;
  const outputDecimals = (inputIsA ? pool.mintDecimalB : pool.mintDecimalA);
  return {
    inputIsA,
    inputMint,
    outputMint: inputIsA ? pool.mintB : pool.mintA,
    inputVault: inputIsA ? pool.vaultA : pool.vaultB,
    outputVault: inputIsA ? pool.vaultB : pool.vaultA,
    tradeFeeRate: tradeFeeRate.toString(),
    tradeFeeRaw: tradeFee.toString(),
    creatorFeeRaw: creatorFee.toString(),
    netInRaw: netIn.toString(),
    inRaw: inRaw.toString(),
    outRaw: outRaw.toString(),
    minOutRaw: minOutRaw.toString(),
    outHuman: Number(outRaw) / 10 ** outputDecimals,
    slippageBps,
  };
}

/**
 * Build the CPMM swap_base_input instruction artifact (+ unsigned tx with a
 * blockhash). 13 metas in the SDK's order; data = disc + amountIn u64 LE +
 * minOut u64 LE.
 */
export function shapeRaydiumCpmmArtifact({ snapshot, userPubkey, inputMint, amountInRaw, slippageBps = 100, amountOutMinRaw = null, blockhash = null, feePayer = null, authority = null }) {
  const pool = snapshot.pool;
  const user = new PublicKey(userPubkey);
  const quote = raydiumCpmmQuote({ snapshot, inputMint, amountInRaw, slippageBps });
  const inRaw = BigInt(quote.inRaw);
  const minOut = amountOutMinRaw !== null ? BigInt(String(amountOutMinRaw)) : BigInt(quote.minOutRaw);
  const inputProgram = quote.inputIsA ? pool.mintProgramA : pool.mintProgramB;
  const outputProgram = quote.inputIsA ? pool.mintProgramB : pool.mintProgramA;
  const inputAta = getAssociatedTokenAddressSync(new PublicKey(quote.inputMint), user, true, new PublicKey(inputProgram));
  const outputAta = getAssociatedTokenAddressSync(new PublicKey(quote.outputMint), user, true, new PublicKey(outputProgram));

  const keys = [
    { pubkey: user.toBase58(), isSigner: true, isWritable: false }, // 0 payer
    { pubkey: authority || snapshot.authority, isSigner: false, isWritable: false }, // 1 authority (vault PDA)
    { pubkey: pool.configId, isSigner: false, isWritable: false }, // 2 config
    { pubkey: pool.pool, isSigner: false, isWritable: true }, // 3 pool
    { pubkey: inputAta.toBase58(), isSigner: false, isWritable: true }, // 4
    { pubkey: outputAta.toBase58(), isSigner: false, isWritable: true }, // 5
    { pubkey: quote.inputVault, isSigner: false, isWritable: true }, // 6
    { pubkey: quote.outputVault, isSigner: false, isWritable: true }, // 7
    { pubkey: inputProgram, isSigner: false, isWritable: false }, // 8
    { pubkey: outputProgram, isSigner: false, isWritable: false }, // 9
    { pubkey: quote.inputMint, isSigner: false, isWritable: false }, // 10
    { pubkey: quote.outputMint, isSigner: false, isWritable: false }, // 11
    { pubkey: pool.observationId, isSigner: false, isWritable: true }, // 12
  ];
  if (!keys[1].pubkey) throw new Error("shapeRaydiumCpmmArtifact: snapshot.authority (the vault-authority PDA) is required");

  const data = Buffer.concat([
    Buffer.from(RAYDIUM_CPMM_SWAP_BASE_INPUT_DISCRIMINATOR, "hex"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(inRaw); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(minOut); return b; })(),
  ]);
  const ix = {
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    discriminator: RAYDIUM_CPMM_SWAP_BASE_INPUT_DISCRIMINATOR,
    keys: keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })),
    dataBase64: data.toString("base64"),
    dataHex: data.toString("hex"),
  };
  const artifact = {
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    pool: pool.pool,
    userPubkey: user.toBase58(),
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    quote: {
      amountInRaw: quote.inRaw,
      tradeFeeRaw: quote.tradeFeeRaw,
      outRaw: quote.outRaw,
      amountOutMinRaw: minOut.toString(),
      slippageBps: quote.slippageBps,
      outHuman: quote.outHuman,
    },
    ix,
  };
  if (blockhash) {
    const payer = feePayer ? new PublicKey(feePayer) : user;
    const tx = new Transaction();
    tx.feePayer = payer;
    tx.recentBlockhash = blockhash;
    tx.add({
      programId: new PublicKey(RAYDIUM_CPMM_PROGRAM_ID),
      keys: keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
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

// ─────────────────────────────────────────────────────────────────────────────
// CLMM — account decodes (PoolInfoLayout head / ClmmConfigLayout /
// TickArrayLayout from raydium-sdk-v2; pure borsh order)
// ─────────────────────────────────────────────────────────────────────────────
export function decodeRaydiumClmmPool(data, pool = null) {
  if (!data || data.length < 391) throw new Error("decodeRaydiumClmmPool: data too short");
  const pk = (o) => new PublicKey(data.subarray(o, o + 32)).toBase58();
  const tick = toSigned(readLe(data, 269, 4), 4);
  return {
    pool,
    programId: RAYDIUM_CLMM_PROGRAM_ID,
    configId: pk(9),
    creator: pk(41),
    mintA: pk(73),
    mintB: pk(105),
    vaultA: pk(137),
    vaultB: pk(169),
    observationId: pk(201),
    mintDecimalsA: data[233],
    mintDecimalsB: data[234],
    tickSpacing: Number(readLe(data, 235, 2)),
    liquidity: readLe(data, 237, 16).toString(),
    sqrtPriceX64: readLe(data, 253, 16).toString(),
    tickCurrent: Number(tick),
    status: data[389],
    feeOn: data[390],
  };
}

export function decodeRaydiumClmmConfig(data) {
  if (!data || data.length < 117) throw new Error("decodeRaydiumClmmConfig: data too short (ClmmConfig = 117 bytes)");
  return {
    bump: data[8],
    index: Number(readLe(data, 9, 2)),
    owner: new PublicKey(data.subarray(11, 43)).toBase58(),
    protocolFeeRate: readLe(data, 43, 4).toString(),
    tradeFeeRate: readLe(data, 47, 4).toString(),
    tickSpacing: Number(readLe(data, 51, 2)),
    fundFeeRate: readLe(data, 53, 4).toString(),
    fundOwner: new PublicKey(data.subarray(61, 93)).toBase58(),
  };
}

const RAY_TICK_BYTES = 168;
const RAY_TICK_OFF = 44; // disc(8) + poolId(32) + startTickIndex(4)

export function decodeRaydiumClmmTickArray(data, tickSpacing, poolId = null) {
  const startTickIndex = Number(toSigned(readLe(data, 40, 4), 4));
  const ticks = [];
  for (let i = 0; i < RAYDIUM_CLMM_TICK_ARRAY_SIZE; i++) {
    const off = RAY_TICK_OFF + i * RAY_TICK_BYTES;
    const liquidityGross = readLe(data, off + 20, 16);
    const ordersAmount = readLe(data, off + 124, 8);
    const partFilled = readLe(data, off + 132, 8);
    ticks.push({
      // Raydium tick arrays hold ticks at SPACING multiples: slot i covers
      // startTickIndex + i × tickSpacing (TickArrayUtil.getTickOffsetInArray).
      tickIndex: startTickIndex + i * tickSpacing,
      liquidityNet: toSigned(readLe(data, off + 4, 16), 16).toString(),
      liquidityGross: liquidityGross.toString(),
      ordersAmount: ordersAmount.toString(),
      partFilledOrdersRemaining: partFilled.toString(),
      initialized: liquidityGross !== 0n || ordersAmount !== 0n || partFilled !== 0n,
    });
  }
  return { startTickIndex, poolId, tickCount: ticks.length, ticks };
}

/** Raydium CLMM PDA: the tick array for `startTickIndex` (i32 BE seed). */
export async function raydiumClmmTickArrayPda(pool, startTickIndex) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(startTickIndex, 0);
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("tick_array"), new PublicKey(pool).toBuffer(), buf],
    new PublicKey(RAYDIUM_CLMM_PROGRAM_ID),
  );
  return pda.toBase58();
}

/** Raydium CLMM PDAs: observation + tick-array-bitmap-extension. */
export async function raydiumClmmPdas(pool) {
  const obs = await PublicKey.findProgramAddress(
    [Buffer.from("observation"), new PublicKey(pool).toBuffer()],
    new PublicKey(RAYDIUM_CLMM_PROGRAM_ID),
  );
  const ext = await PublicKey.findProgramAddress(
    [Buffer.from("pool_tick_array_bitmap_extension"), new PublicKey(pool).toBuffer()],
    new PublicKey(RAYDIUM_CLMM_PROGRAM_ID),
  );
  return { observation: obs[0].toBase58(), bitmapExtension: ext[0].toBase58() };
}

/** CLMM array start for a tick (Raydium: arrays are spacing-multiples of 60). */
export function raydiumClmmArrayStart(tick, tickSpacing) {
  const ticksInArray = RAYDIUM_CLMM_TICK_ARRAY_SIZE * tickSpacing;
  return Math.floor(tick / ticksInArray) * ticksInArray;
}

// ── CLMM swap math (mirror of raydium-sdk-v2 swapMath.ts + swapSimulator.ts
//    — Q64, fee ON INPUT; static-fee pools only) ─────────────────────────────

/** amount delta A (roundUp per flag) — Raydium's LiquidityMathUtil
 *  getDeltaAmountAUnsigned semantics on Q64. */
function rayDeltaA(sqrtLow, sqrtHigh, liquidity, roundUp) {
  const diff = sqrtHigh - sqrtLow;
  const numerator = liquidity * diff * Q64;
  const denominator = sqrtLow * sqrtHigh;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return roundUp && remainder !== 0n ? quotient + 1n : quotient;
}

/** amount delta B (roundUp per flag). */
function rayDeltaB(sqrtLow, sqrtHigh, liquidity, roundUp) {
  const product = liquidity * (sqrtHigh - sqrtLow);
  const result = product >> 64n;
  const shouldRound = roundUp && (product & (Q64 - 1n)) !== 0n;
  return shouldRound ? result + 1n : result;
}

function rayNextSqrtPriceFromInput(sqrtPrice, liquidity, amountIn, zeroForOne) {
  if (sqrtPrice <= 0n) throw new Error("rayNextSqrtPriceFromInput: sqrtPrice must be positive");
  if (liquidity <= 0n) throw new Error("rayNextSqrtPriceFromInput: liquidity must be positive");
  if (zeroForOne) {
    // A-type move up (adding A lowers price? no — zeroForOne price falls = A added)
    const numerator = liquidity << 64n;
    const product = amountIn * sqrtPrice;
    const denominator = numerator + product;
    if (denominator >= numerator) return mulDivCeil(numerator, sqrtPrice, denominator);
    const quotient = mulDivFloor(numerator, 1n, sqrtPrice);
    return mulDivCeil(numerator, 1n, quotient + amountIn);
  }
  return sqrtPrice + ((amountIn << 64n) / liquidity);
}

function rayNextSqrtPriceFromOutput(sqrtPrice, liquidity, amountOut, zeroForOne) {
  if (zeroForOne) {
    const quotient = divRoundingUp(amountOut << 64n, liquidity);
    return sqrtPrice - quotient;
  }
  const numerator = liquidity << 64n;
  const product = amountOut * sqrtPrice;
  const denominator = numerator - product;
  if (numerator <= product) throw new Error("Insufficient liquidity for token0 removal");
  return mulDivCeil(numerator, sqrtPrice, denominator);
}

/** Raydium's SwapMathUtil.computeSwap — mirrored exactly. */
export function raydiumClmmComputeSwap(sqrtPriceCurrent, sqrtPriceTarget, liquidity, amountRemaining, feeRate, isBaseInput, zeroForOne, isFeeOnInput) {
  const amountForPriceCalc = isBaseInput
    ? (isFeeOnInput ? mulDivFloor(amountRemaining, RAYDIUM_FEE_DENOMINATOR - BigInt(feeRate), RAYDIUM_FEE_DENOMINATOR) : amountRemaining)
    : (isFeeOnInput ? amountRemaining : mulDivCeil(amountRemaining, RAYDIUM_FEE_DENOMINATOR, RAYDIUM_FEE_DENOMINATOR - BigInt(feeRate)));
  const [sLow, sHigh] = sqrtPriceCurrent < sqrtPriceTarget ? [sqrtPriceCurrent, sqrtPriceTarget] : [sqrtPriceTarget, sqrtPriceCurrent];
  const calcInRange = (roundUpIn, roundUpOut) => ({
    in: zeroForOne ? rayDeltaA(sLow, sHigh, liquidity, roundUpIn) : rayDeltaB(sLow, sHigh, liquidity, roundUpIn),
    out: zeroForOne ? rayDeltaB(sLow, sHigh, liquidity, roundUpOut) : rayDeltaA(sLow, sHigh, liquidity, roundUpOut),
  });
  const amounts = calcInRange(true, true); // amountIn roundUp (base input); the simulator recomputes below
  let nextSqrtPrice;
  if (isBaseInput) {
    nextSqrtPrice = amounts.in <= amountForPriceCalc ? sqrtPriceTarget : rayNextSqrtPriceFromInput(sqrtPriceCurrent, liquidity, amountForPriceCalc, zeroForOne);
  } else {
    nextSqrtPrice = amounts.out <= amountForPriceCalc ? sqrtPriceTarget : rayNextSqrtPriceFromOutput(sqrtPriceCurrent, liquidity, amountForPriceCalc, zeroForOne);
  }
  const max = nextSqrtPrice === sqrtPriceTarget;
  // Recompute actual in/out for the reached price (mirror the SDK's step
  // ordering: for zeroForOne amountIn uses the A formula, amountOut the B).
  const [nLow, nHigh] = sqrtPriceCurrent < nextSqrtPrice ? [sqrtPriceCurrent, nextSqrtPrice] : [nextSqrtPrice, sqrtPriceCurrent];
  let amountIn;
  let amountOut;
  if (zeroForOne) {
    amountIn = !(max && isBaseInput) ? rayDeltaA(nLow, nHigh, liquidity, true) : amounts.in;
    amountOut = !(max && !isBaseInput) ? rayDeltaB(nLow, nHigh, liquidity, false) : amounts.out;
  } else {
    amountIn = !(max && isBaseInput) ? rayDeltaB(nLow, nHigh, liquidity, true) : amounts.in;
    amountOut = !(max && !isBaseInput) ? rayDeltaA(nLow, nHigh, liquidity, false) : amounts.out;
  }
  let feeAmount;
  if (isBaseInput) {
    if (isFeeOnInput) {
      if (nextSqrtPrice !== sqrtPriceTarget) {
        feeAmount = amountRemaining - amountIn;
      } else {
        feeAmount = mulDivCeil(amountIn, BigInt(feeRate), RAYDIUM_FEE_DENOMINATOR - BigInt(feeRate));
      }
    } else {
      feeAmount = mulDivCeil(amountOut, BigInt(feeRate), RAYDIUM_FEE_DENOMINATOR);
      amountOut = amountOut - feeAmount;
      if (!max) amountIn = amountRemaining;
    }
  } else {
    if (isFeeOnInput) {
      amountOut = amountOut < amountRemaining ? amountOut : amountRemaining;
      feeAmount = mulDivCeil(amountIn, BigInt(feeRate), RAYDIUM_FEE_DENOMINATOR - BigInt(feeRate));
    } else {
      feeAmount = mulDivCeil(amountOut, BigInt(feeRate), RAYDIUM_FEE_DENOMINATOR);
      const netOutput = amountOut - feeAmount;
      if (netOutput > amountRemaining) {
        feeAmount = amountOut - amountRemaining;
        amountOut = amountRemaining;
      } else {
        amountOut = netOutput;
      }
    }
  }
  return { amountIn, amountOut, feeAmount, sqrtPriceNextX64: nextSqrtPrice };
}

/**
 * The CLMM tick-walk quote (mirror of the SDK's swapInternal — static-fee
 * pools, NO dynamic-fee / limit-order handling: a crossed tick carrying
 * limit orders THROWS honestly; the fixture cross-check against the SDK
 * proves the fixture path crosses none).
 */
export function raydiumClmmQuote({ snapshot, inputMint, amountInRaw, slippageBps = 100 }) {
  const pool = snapshot.pool;
  const config = snapshot.config;
  const zeroForOne = inputMint === pool.mintA;
  if (!zeroForOne && inputMint !== pool.mintB) {
    throw new Error(`raydiumClmmQuote: inputMint ${inputMint} is not a mint of pool ${pool.pool}`);
  }
  if (!snapshot.tickArrays?.length) throw new Error("raydiumClmmQuote: snapshot.tickArrays are required");
  let amountSpecifiedRemaining = BigInt(String(amountInRaw));
  let amountCalculated = 0n;
  let sqrtPrice = BigInt(pool.sqrtPriceX64);
  let liquidity = BigInt(pool.liquidity);
  let tick = pool.tickCurrent;
  let lpFee = 0n; let protocolFee = 0n; let fundFee = 0n;
  const feeRate = Number(config.tradeFeeRate);
  const protocolFeeRate = BigInt(config.protocolFeeRate);
  const fundFeeRate = BigInt(config.fundFeeRate);
  // CollectFeeOn: FromInput=0, TokenOnlyA=1, TokenOnlyB=2 (default = on input).
  const isFeeOnInput = pool.feeOn === 1 ? zeroForOne : pool.feeOn === 2 ? !zeroForOne : true;
  const limit = zeroForOne ? RAYDIUM_CLMM_MIN_SQRT_PRICE_X64 + 1n : RAYDIUM_CLMM_MAX_SQRT_PRICE_X64 - 1n;
  const tickSpacing = pool.tickSpacing;
  const startIndex = raydiumClmmArrayStart(tick, tickSpacing);
  if (snapshot.tickArrays[0].startTickIndex !== startIndex) {
    throw new Error("raydiumClmmQuote: tickArrays[0] must start at the array containing the pool tick");
  }
  // arrays sorted in trade order: [containing, next-down/up, …]
  const arrays = [...snapshot.tickArrays].sort((a, b) => (zeroForOne ? b.startTickIndex - a.startTickIndex : a.startTickIndex - b.startTickIndex));

  let safety = 0;
  let allTrade = true;
  while (amountSpecifiedRemaining !== 0n && sqrtPrice !== limit) {
    if (++safety > 5000) throw new Error("raydiumClmmQuote: walk safety bound exceeded");
    // find the next initialized tick: current array from the current slot, then next arrays
    let nextTick = null;
    for (const arr of arrays) {
      const inArray = arr.startTickIndex === startIndex; // only the first array contains the pool tick
      const offsetInArray = Math.floor((tick - arr.startTickIndex) / tickSpacing);
      let t = null;
      if (zeroForOne) {
        const from = inArray ? Math.min(Math.max(offsetInArray, 0), arr.tickCount - 1) : arr.tickCount - 1;
        for (let i = from; i >= 0; i--) {
          if (arr.ticks[i].initialized) { t = arr.ticks[i]; break; }
        }
      } else {
        const from = inArray ? Math.max(offsetInArray + 1, 0) : 0;
        for (let i = from; i < arr.tickCount; i++) {
          if (arr.ticks[i].initialized) { t = arr.ticks[i]; break; }
        }
      }
      if (t) { nextTick = t; break; }
      if (inArray && arrays.length === 1) break;
      if (!inArray && arr === arrays[arrays.length - 1]) break;
    }
    if (!nextTick) {
      // The SDK returns a partial trade (allTrade false) when arrays run out.
      allTrade = false;
      break;
    }
    if (BigInt(nextTick.ordersAmount) !== 0n || BigInt(nextTick.partFilledOrdersRemaining) !== 0n) {
      throw new Error("raydiumClmmQuote: the swap path crosses a tick with LIMIT ORDERS — not supported by this leg (use the Jupiter aggregator path)");
    }
    const targetPrice = getSqrtPriceAtTick(nextTick.tickIndex, RAYDIUM_TICK_FACTORS, RAYDIUM_CLMM_MIN_TICK, RAYDIUM_CLMM_MAX_TICK);
    const bounded = zeroForOne ? (targetPrice < limit ? limit : targetPrice) : (targetPrice > limit ? limit : targetPrice);
    const step = raydiumClmmComputeSwap(sqrtPrice, bounded, liquidity, amountSpecifiedRemaining, feeRate, true, zeroForOne, isFeeOnInput);
    const amountInConsumed = isFeeOnInput ? step.amountIn + step.feeAmount : step.amountIn;
    amountSpecifiedRemaining -= amountInConsumed;
    amountCalculated += step.amountOut;
    // fee split (protocol + fund first; the rest is LP fee)
    let remainingFee = step.feeAmount;
    if (protocolFeeRate > 0n) {
      const p = (step.feeAmount * protocolFeeRate) / RAYDIUM_FEE_DENOMINATOR;
      protocolFee += p; remainingFee -= p;
    }
    if (fundFeeRate > 0n) {
      const f = (step.feeAmount * fundFeeRate) / RAYDIUM_FEE_DENOMINATOR;
      fundFee += f; remainingFee -= f;
    }
    lpFee += remainingFee;
    if (amountSpecifiedRemaining < 0n) throw new Error("raydiumClmmQuote: amount remaining negative");
    if (step.sqrtPriceNextX64 === targetPrice) {
      const net = BigInt(nextTick.liquidityNet);
      liquidity = zeroForOne ? liquidity - net : liquidity + net;
      tick = zeroForOne ? nextTick.tickIndex - 1 : nextTick.tickIndex;
    } else {
      tick = getTickAtSqrtPrice(step.sqrtPriceNextX64, {
        factors: RAYDIUM_TICK_FACTORS,
        bitPrecision: 16,
        minTick: RAYDIUM_CLMM_MIN_TICK,
        maxTick: RAYDIUM_CLMM_MAX_TICK,
        minSqrtPrice: RAYDIUM_CLMM_MIN_SQRT_PRICE_X64,
        maxSqrtPrice: RAYDIUM_CLMM_MAX_SQRT_PRICE_X64,
      });
    }
    sqrtPrice = step.sqrtPriceNextX64;
  }
  const amountIn = amountSpecifiedRemaining === 0n ? BigInt(String(amountInRaw)) : BigInt(String(amountInRaw)) - amountSpecifiedRemaining;
  const outDecimals = zeroForOne ? pool.mintDecimalsB : pool.mintDecimalsA;
  const totalFee = lpFee + protocolFee + fundFee;
  return {
    zeroForOne,
    inputMint,
    outputMint: zeroForOne ? pool.mintB : pool.mintA,
    amountInRaw: amountIn.toString(),
    amountOutRaw: amountCalculated.toString(),
    feeAmount: totalFee.toString(),
    minOutRaw: ((amountCalculated * BigInt(10000 - slippageBps)) / 10000n).toString(),
    allTrade,
    endSqrtPrice: sqrtPrice.toString(),
    endTick: tick,
    outHuman: Number(amountCalculated) / 10 ** outDecimals,
    appliedFeeRate: feeRate,
    isFeeOnInput,
    slippageBps,
  };
}

/**
 * Build the CLMM swap_v2 instruction artifact (+ unsigned tx). Mirrors the
 * SDK's swapV2Instruction (payer, ammConfig, pool, owner in/out accounts,
 * vaults, observation, Token/Token-2022/Memo programs, mints, bitmap
 * extension, tick arrays) with data = disc + amount u64 + minOut u64 +
 * sqrtPriceLimitX64 u128 + isBaseInput bool.
 */
export function shapeRaydiumClmmArtifact({ snapshot, userPubkey, inputMint, amountInRaw, slippageBps = 100, amountOutMinRaw = null, sqrtPriceLimitX64 = null, blockhash = null, feePayer = null }) {
  const pool = snapshot.pool;
  const user = new PublicKey(userPubkey);
  const quote = raydiumClmmQuote({ snapshot, inputMint, amountInRaw, slippageBps });
  if (!quote.allTrade) throw new Error("shapeRaydiumClmmArtifact: quote exceeds the supplied tick arrays");
  const zeroForOne = quote.zeroForOne;
  const inRaw = BigInt(quote.amountInRaw);
  const minOut = amountOutMinRaw !== null ? BigInt(String(amountOutMinRaw)) : BigInt(quote.minOutRaw);
  const limit = sqrtPriceLimitX64 !== null ? BigInt(String(sqrtPriceLimitX64)) : (zeroForOne ? RAYDIUM_CLMM_MIN_SQRT_PRICE_X64 + 1n : RAYDIUM_CLMM_MAX_SQRT_PRICE_X64 - 1n);
  const inputProgram = zeroForOne ? pool.mintProgramA || SPL_TOKEN_PROGRAM_ID : pool.mintProgramB || SPL_TOKEN_PROGRAM_ID;
  const outputProgram = zeroForOne ? pool.mintProgramB || SPL_TOKEN_PROGRAM_ID : pool.mintProgramA || SPL_TOKEN_PROGRAM_ID;
  const inputAta = getAssociatedTokenAddressSync(new PublicKey(quote.inputMint), user, true, new PublicKey(inputProgram));
  const outputAta = getAssociatedTokenAddressSync(new PublicKey(quote.outputMint), user, true, new PublicKey(outputProgram));
  const inputVault = zeroForOne ? pool.vaultA : pool.vaultB;
  const outputVault = zeroForOne ? pool.vaultB : pool.vaultA;
  if (!snapshot.pdas?.observation || !snapshot.pdas?.bitmapExtension) {
    throw new Error("shapeRaydiumClmmArtifact: snapshot.pdas { observation, bitmapExtension } are required");
  }
  const keys = [
    { pubkey: user.toBase58(), isSigner: true, isWritable: false }, // 0 payer
    { pubkey: pool.configId, isSigner: false, isWritable: false }, // 1 ammConfig
    { pubkey: pool.pool, isSigner: false, isWritable: true }, // 2 pool
    { pubkey: inputAta.toBase58(), isSigner: false, isWritable: true }, // 3
    { pubkey: outputAta.toBase58(), isSigner: false, isWritable: true }, // 4
    { pubkey: inputVault, isSigner: false, isWritable: true }, // 5
    { pubkey: outputVault, isSigner: false, isWritable: true }, // 6
    { pubkey: pool.observationId, isSigner: false, isWritable: true }, // 7
    { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 8
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 9
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }, // 10
    { pubkey: quote.inputMint, isSigner: false, isWritable: false }, // 11
    { pubkey: quote.outputMint, isSigner: false, isWritable: false }, // 12
    { pubkey: snapshot.pdas.bitmapExtension, isSigner: false, isWritable: true }, // 13
    ...snapshot.tickArrays.slice(0, 4).map((ta) => ({ pubkey: ta.address, isSigner: false, isWritable: true })), // 14+
  ];
  const data = Buffer.concat([
    Buffer.from(RAYDIUM_CLMM_SWAP_V2_DISCRIMINATOR, "hex"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(inRaw); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(minOut); return b; })(),
    (() => { const b = Buffer.alloc(16); b.writeBigUInt64LE(limit & 0xffffffffffffffffn); b.writeBigUInt64LE(limit >> 64n, 8); return b; })(),
    Buffer.from([1]), // isBaseInput
  ]);
  const ix = {
    programId: RAYDIUM_CLMM_PROGRAM_ID,
    discriminator: RAYDIUM_CLMM_SWAP_V2_DISCRIMINATOR,
    keys: keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })),
    dataBase64: data.toString("base64"),
    dataHex: data.toString("hex"),
  };
  const artifact = {
    programId: RAYDIUM_CLMM_PROGRAM_ID,
    pool: pool.pool,
    userPubkey: user.toBase58(),
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    quote: {
      amountInRaw: quote.amountInRaw,
      amountOutRaw: quote.amountOutRaw,
      amountOutMinRaw: minOut.toString(),
      feeAmount: quote.feeAmount,
      appliedFeeRate: quote.appliedFeeRate,
      endTick: quote.endTick,
      allTrade: quote.allTrade,
      outHuman: quote.outHuman,
      tickArrays: snapshot.tickArrays.map((t) => t.address),
    },
    ix,
  };
  if (blockhash) {
    const payer = feePayer ? new PublicKey(feePayer) : user;
    const tx = new Transaction();
    tx.feePayer = payer;
    tx.recentBlockhash = blockhash;
    tx.add({
      programId: new PublicKey(RAYDIUM_CLMM_PROGRAM_ID),
      keys: keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
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
 * Create the Raydium DEX-direct swap leg (dex: "cpmm" | "clmm").
 * ctx per phase:
 *   build: { dex, snapshot, userPubkey, inputMint, amountInRaw, ... }
 *   submit: 🔴 always throws DexDirectLiveTestGateError.
 */
export function createRaydiumSwapLeg() {
  return createLeg({
    id: "raydium-swap",
    family: "svm",
    chain: "sol",
    description:
      "The Raydium DEX-direct swap leg (Solana fallback — the no-aggregator path when " +
      "Jupiter is down or for fee comparison): REAL read-only quotes from the live on-chain " +
      "pool state — CPMM (constant product on vault balances, the curve the XDEX leg proved " +
      "live) and CLMM (the full tick-walk swap simulator mirrored from raydium-sdk-v2's " +
      "swapMath/swapSimulator; cross-checked against the SDK on the frozen capture) — plus " +
      "the SIGNABLE execute: official raydium-sdk-v2 swap instructions + planRaydiumExecute " +
      "returns { needsSetup, setupTx?, swapTx } for Mr. Esters' wallet (Backpack) to sign. " +
      "🔴 NO-BROADCAST GATE: submit() always throws DexDirectLiveTestGateError — the agent " +
      "CANNOT broadcast; sign in your wallet. Swap-execution pending Mr. Esters' live anchor.",
    goldenStep: "raydium",
    phases: {
      async build(ctx) {
        if (!ctx.dex || !["cpmm", "clmm"].includes(ctx.dex)) {
          throw new Error('raydiumSwapLeg.build: dex must be "cpmm" or "clmm"');
        }
        if (!ctx.snapshot) throw new Error("raydiumSwapLeg.build: snapshot (the decoded pool state) is required");
        if (!ctx.userPubkey) throw new Error("raydiumSwapLeg.build: userPubkey is required");
        if (!ctx.inputMint) throw new Error("raydiumSwapLeg.build: inputMint is required");
        if (!Number.isFinite(Number(ctx.amountInRaw)) || Number(ctx.amountInRaw) <= 0) {
          throw new Error("raydiumSwapLeg.build: a positive raw amountInRaw is required");
        }
        const common = {
          snapshot: ctx.snapshot,
          userPubkey: ctx.userPubkey,
          inputMint: ctx.inputMint,
          amountInRaw: String(ctx.amountInRaw),
          ...(ctx.slippageBps !== undefined ? { slippageBps: ctx.slippageBps } : {}),
          ...(ctx.amountOutMinRaw !== undefined ? { amountOutMinRaw: String(ctx.amountOutMinRaw) } : {}),
          ...(ctx.blockhash ? { blockhash: ctx.blockhash } : {}),
          ...(ctx.feePayer ? { feePayer: ctx.feePayer } : {}),
        };
        const artifact = ctx.dex === "cpmm"
          ? shapeRaydiumCpmmArtifact(common)
          : shapeRaydiumClmmArtifact({ ...common, ...(ctx.sqrtPriceLimitX64 !== undefined ? { sqrtPriceLimitX64: ctx.sqrtPriceLimitX64 } : {}) });
        return { needed: true, artifact };
      },
      // 🔴 THE GUARD — the honest live-anchor boundary (never signs/broadcasts).
      async submit() {
        throw new DexDirectLiveTestGateError(DEX_DIRECT_LIVE_TEST_GATE_MESSAGE);
      },
    },
    meta: {
      wraps:
        "GREENFIELD DIRECT integration (Raydium mainnet): CPMM program CPMMoo8… " +
        "swap_base_input (disc 8fbe5adac41e33de — same family as the LIVE-ANCHORED XDEX " +
        "construction on X1) + CLMM program CAMMCzo5… swap_v2 (disc 2b04ed0b1ac91e62). " +
        "Quotes: CP constant product on vault balances / CLMM tick-walk mirror of " +
        "raydium-sdk-v2 swapInternal (Q64, fee-on-input from the pool's feeOn flag + config " +
        "rates). Boundary: CLMM limit-order ticks throw honestly (use Jupiter for those); " +
        "no dynamic-fee pools; refresh snapshots before any live use.",
      liveTestAnchor: "raydium-swap-execution",
    },
  });
}

/**
 * The Raydium leg's SIGNABLE execute planner. Returns
 * { needsSetup, setupTx?, swapTx } for Backpack — see
 * solanaSignable.planRaydiumExecute (official raydium-sdk-v2 instruction
 * construction; read-only ATA/getAccountInfo checks only; no broadcast).
 */
export { planRaydiumExecute } from "./solanaSignable.js";
