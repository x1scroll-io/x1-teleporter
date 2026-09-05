/**
 * orcaSwapLeg.js — the ORCA WHIRLPOOL DEX-DIRECT swap leg (the dexDirect
 * family's Solana concentrated-liquidity fallback, Phase 6 scaffold).
 *
 * WHAT THIS LEG IS
 *   A DEX-DIRECT fallback leg: when the Jupiter AGGREGATOR path is down (or
 *   for fee comparison), the app can swap DIRECTLY into an Orca Whirlpool —
 *   the on-chain concentrated-liquidity AMM (program whirLbMiic…). Jupiter
 *   aggregates Whirlpool routes; this leg is the no-aggregator fallback.
 *
 *   The quote is REAL and read-only: it is computed from the LIVE on-chain
 *   pool state (the whirlpool account + the tick arrays along the swap
 *   path — getAccountInfo, never a signer) with the EXACT swap math the
 *   protocol runs (a faithful BigInt mirror of @orca-so/whirlpools-sdk's
 *   computeSwapStep / computeSwap / TickArraySequence / PriceMath — see
 *   the cross-checks frozen in the dex-direct fixtures: SDK quote == this
 *   leg's quote on the same captured state). No funds, no tx.
 *
 *   The execute half is a GUARDED STUB (submit() throws
 *   DexDirectLiveTestGateError) — pinned to the wire level: the swap_v2
 *   instruction (disc 2b04ed0b1ac91e62 = sha256("global:swap_v2")[..8] —
 *   the CURRENT deployed instruction; the account layout below was verified
 *   against a REAL live mainnet swap tx on the SOL/USDC whirlpool
 *   (Czfq3xZZ…, err ok) — 15 metas + the option byte) + the unsigned tx
 *   when a blockhash is supplied. "swap-execution pending Mr. Esters' live
 *   anchor."
 *
 * LIVE-VERIFIED ANCHOR (2026-09-05, read-only)
 *   - whirlpool SOL/USDC Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE
 *     (tickSpacing 4, feeRate 400 = 0.04%, ~$230M/24h) — the pool decode
 *     (offsets below) cross-validated against the Orca API record + price
 *     math (tick ↔ sqrtPrice ↔ ~127 USDC/SOL).
 *   - a live swap tx on that pool (44VxpkKE…, err ok) verified: the PDA
 *     derivations (tick array ["tick_array", whirlpool, startTick as a
 *     DECIMAL-STRING seed]; oracle ["oracle", whirlpool]) reproduce the
 *     tx's account list byte-for-byte; the oracle account does NOT exist
 *     on-chain and the swap still succeeds (non-adaptive pool).
 *   - vault token accounts are owned by the WHIRLPOOL address itself
 *     (program-side CPI signing) — the ix's tokenAuthority is the USER's
 *     wallet (a readonly signer).
 *   - tick arrays hold 88 ticks regardless of tickSpacing (9988 bytes:
 *     8 disc + 4 startTickIndex + 88 × 113-byte Tick + 32 whirlpool).
 *
 * ⚠️ HONEST BOUNDARIES (labeled, not hidden)
 *   - The walk mirrors the SDK's non-adaptive path exactly (feeRate fixed
 *     from the pool). Adaptive-fee pools (oracle-driven fee rates) are NOT
 *     handled — the fixture pools are static-fee pools.
 *   - Token-extension transfer fees (fee-on-transfer mints) are NOT modeled
 *     — SOL/USDC are standard SPL.
 *   - Tick-array bound: quotes that would cross more than the supplied
 *     arrays return the SDK-style partial-trade result (allTrade false) —
 *     the same boundary the SDK's quote enforces (3 arrays; swap_v2's
 *     remaining accounts can extend an actual ix beyond that).
 *
 * ctx (build): { snapshot: { whirlpool: <decodeWhirlpoolState>,
 *   tickArrays: [<decodeWhirlpoolTickArray>…], tokenProgramA, tokenProgramB,
 *   oracle }, userPubkey, inputMint, amountInRaw, slippageBps?,
 *   amountOutMinRaw?, sqrtPriceLimit?, blockhash?, feePayer? }
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
  ORCA_TICK_FACTORS,
  ORCA_MIN_TICK_INDEX,
  ORCA_MAX_TICK_INDEX,
  ORCA_MIN_SQRT_PRICE,
  ORCA_MAX_SQRT_PRICE,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
} from "./solanaMath.js";
import { DexDirectLiveTestGateError, DEX_DIRECT_LIVE_TEST_GATE_MESSAGE } from "./liveTestGate.js";

/** Orca's Whirlpool program (mainnet). */
export const ORCA_WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
/** The mainnet WhirlpoolsConfig (default config). */
export const ORCA_WHIRLPOOLS_CONFIG = "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ";
/** The deployed swap_v2 discriminator = sha256("global:swap_v2")[..8] —
 *  VERIFIED on the live mainnet swap tx 44VxpkKE… (err ok). */
export const ORCA_SWAP_V2_DISCRIMINATOR = "2b04ed0b1ac91e62";
/** Ticks per tick array (88 — same for every tickSpacing; VERIFIED on-chain:
 *  9988-byte arrays, 88 × 113-byte ticks). */
export const ORCA_TICK_ARRAY_SIZE = 88;
/** The SDK quote bound (3 arrays for quotes). */
export const ORCA_MAX_SWAP_TICK_ARRAYS = 3;
/** Fee-rate denominator: whirlpool feeRate is in units of 1e-6
 *  (feeRate 400 = 0.04%). */
export const ORCA_FEE_RATE_MUL_VALUE = 1_000_000n;
/** SPL Token program (tokenProgramA/B for standard mints). */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ── Whirlpool account decode (offsets VERIFIED against the live account +
//    Orca API record + price math — see module header) ──────────────────────
const W_CFG = 8; // whirlpoolsConfig
const W_TICK_SPACING = 41; // u16 LE
const W_FEE_RATE = 45; // u16 LE
const W_PROTOCOL_FEE_RATE = 47; // u16 LE
const W_LIQUIDITY = 49; // u128 LE
const W_SQRT_PRICE = 65; // u128 LE
const W_TICK = 81; // i32 LE
const W_MINT_A = 101;
const W_VAULT_A = 133;
const W_MINT_B = 181;
const W_VAULT_B = 213;

/**
 * Decode a Whirlpool account (the 653-byte layout) into the fields the
 * quote + ix need. Pure.
 * @param {Buffer} data the raw account bytes (getAccountInfo base64)
 * @param {string} [pool] the whirlpool address (for the artifact)
 */
export function decodeWhirlpoolState(data, pool = null) {
  if (!data || data.length < W_VAULT_B + 32) {
    throw new Error("decodeWhirlpoolState: data too short for a Whirlpool account");
  }
  const pk = (o) => new PublicKey(data.subarray(o, o + 32)).toBase58();
  const tick = toSigned(readLe(data, W_TICK, 4), 4);
  return {
    pool,
    config: pk(W_CFG),
    tickSpacing: Number(readLe(data, W_TICK_SPACING, 2)),
    feeRate: Number(readLe(data, W_FEE_RATE, 2)),
    protocolFeeRate: Number(readLe(data, W_PROTOCOL_FEE_RATE, 2)),
    liquidity: readLe(data, W_LIQUIDITY, 16).toString(),
    sqrtPrice: readLe(data, W_SQRT_PRICE, 16).toString(),
    tickCurrent: Number(tick),
    mintA: pk(W_MINT_A),
    vaultA: pk(W_VAULT_A),
    mintB: pk(W_MINT_B),
    vaultB: pk(W_VAULT_B),
  };
}

const T_START = 8; // i32 LE startTickIndex
const T_TICK_BYTES = 113; // Tick struct: bool(1)+i128(16)+u128(16)+u128(16)+u128(16)+[u128;3](48)
const T_INITIALIZED = 0; // bool
const T_LIQ_NET = 1; // i128 LE
const T_LIQ_GROSS = 17; // u128 LE

/**
 * Decode a Whirlpool TickArray account into { startTickIndex, ticks }.
 * Each slot i covers tickIndex = startTickIndex + i × tickSpacing.
 * @param {Buffer} data raw account bytes
 * @param {number} tickSpacing from the whirlpool
 */
export function decodeWhirlpoolTickArray(data, tickSpacing) {
  const startTickIndex = Number(toSigned(readLe(data, T_START, 4), 4));
  const count = (data.length - 12 - 32) / T_TICK_BYTES; // disc(8) + start(4) + ticks + whirlpool(32)
  const ticks = [];
  for (let i = 0; i < count; i++) {
    const off = 12 + i * T_TICK_BYTES;
    ticks.push({
      tickIndex: startTickIndex + i * tickSpacing,
      initialized: data[off + T_INITIALIZED] === 1,
      liquidityNet: toSigned(readLe(data, off + T_LIQ_NET, 16), 16).toString(),
      liquidityGross: readLe(data, off + T_LIQ_GROSS, 16).toString(),
    });
  }
  return { startTickIndex, tickCount: count, ticks };
}

/** PDA: the tick array whose first tick is `startTick` (seed = DECIMAL
 *  STRING of the start tick — verified against the live tx). */
export async function whirlpoolTickArrayPda(pool, startTick) {
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("tick_array"), new PublicKey(pool).toBuffer(), Buffer.from(String(startTick))],
    new PublicKey(ORCA_WHIRLPOOL_PROGRAM_ID),
  );
  return pda.toBase58();
}

/** PDA: the oracle account (["oracle", whirlpool] — may not exist on-chain
 *  for non-adaptive pools; the live tx includes it regardless). */
export async function whirlpoolOraclePda(pool) {
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("oracle"), new PublicKey(pool).toBuffer()],
    new PublicKey(ORCA_WHIRLPOOL_PROGRAM_ID),
  );
  return pda.toBase58();
}

// ── The swap math (faithful BigInt mirror of the SDK's swap-math.js) ───────

/** The start tick of the array containing `tick`. */
export function whirlpoolStartTick(tick, tickSpacing) {
  const ticksInArray = tickSpacing * ORCA_TICK_ARRAY_SIZE;
  return Math.floor(tick / ticksInArray) * ticksInArray;
}

/** Amount delta of token A (the "price-denominated" leg): L×(√Pu−√Pl)×2^64
 *  ÷ (√Pl×√Pu), rounded per `roundUp`. Mirrors getAmountDeltaA. */
function amountDeltaA(sqrtLow, sqrtHigh, liquidity, roundUp) {
  const diff = sqrtHigh - sqrtLow;
  const numerator = liquidity * diff * Q64;
  const denominator = sqrtLow * sqrtHigh;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return roundUp && remainder !== 0n ? quotient + 1n : quotient;
}

/** Amount delta of token B: L×(√Pu−√Pl) with the X64 shift, rounded per
 *  `roundUp`. Mirrors getAmountDeltaB (u128-safe; BigInt cannot overflow). */
function amountDeltaB(sqrtLow, sqrtHigh, liquidity, roundUp) {
  const product = liquidity * (sqrtHigh - sqrtLow);
  const result = product >> 64n;
  const shouldRound = roundUp && (product & (Q64 - 1n)) !== 0n;
  return shouldRound ? result + 1n : result;
}

function getNextSqrtPriceFromA(sqrtPrice, liquidity, amount, add) {
  if (amount === 0n) return sqrtPrice;
  const numerator = liquidity << 64n;
  if (add) {
    const product = amount * sqrtPrice;
    const denominator = numerator + product;
    if (denominator >= numerator) return mulDivCeil(numerator, sqrtPrice, denominator);
    const quotient = mulDivFloor(numerator, 1n, sqrtPrice);
    return mulDivCeil(numerator, 1n, quotient + amount);
  }
  const product = amount * sqrtPrice;
  if (numerator <= product) throw new Error("Insufficient liquidity for token0 removal");
  return mulDivCeil(numerator, sqrtPrice, numerator - product);
}

function getNextSqrtPriceFromB(sqrtPrice, liquidity, amount, add) {
  if (amount === 0n) return sqrtPrice;
  if (add) return sqrtPrice + ((amount << 64n) / liquidity);
  return sqrtPrice - divRoundingUp(amount << 64n, liquidity);
}

/** Mirrors the SDK's swap-math computeSwapStep. */
export function computeWhirlpoolSwapStep(amountRemaining, feeRate, currLiquidity, currSqrtPrice, targetSqrtPrice, amountSpecifiedIsInput, aToB) {
  const [sqrtLow, sqrtHigh] = currSqrtPrice < targetSqrtPrice ? [currSqrtPrice, targetSqrtPrice] : [targetSqrtPrice, currSqrtPrice];
  // The FIXED delta is the token whose amount is specified by the price move
  // (token A when aToB===isInput, else token B) — rounded per the SDK.
  const fixedIsA = aToB === amountSpecifiedIsInput;
  const initialFixed = fixedIsA
    ? amountDeltaA(sqrtLow, sqrtHigh, currLiquidity, amountSpecifiedIsInput)
    : amountDeltaB(sqrtLow, sqrtHigh, currLiquidity, amountSpecifiedIsInput);

  const amountCalc = amountSpecifiedIsInput
    ? mulDivFloor(amountRemaining, ORCA_FEE_RATE_MUL_VALUE - BigInt(feeRate), ORCA_FEE_RATE_MUL_VALUE)
    : amountRemaining;

  const nextSqrtPrice = initialFixed <= amountCalc
    ? targetSqrtPrice
    : (fixedIsA
        ? getNextSqrtPriceFromA(currSqrtPrice, currLiquidity, amountCalc, amountSpecifiedIsInput)
        : getNextSqrtPriceFromB(currSqrtPrice, currLiquidity, amountCalc, amountSpecifiedIsInput));

  const isMaxSwap = nextSqrtPrice === targetSqrtPrice;
  const [nextLow, nextHigh] = currSqrtPrice < nextSqrtPrice ? [currSqrtPrice, nextSqrtPrice] : [nextSqrtPrice, currSqrtPrice];
  // The UNFIXED delta is the other token, rounded opposite.
  const amountUnfixed = fixedIsA
    ? amountDeltaB(nextLow, nextHigh, currLiquidity, !amountSpecifiedIsInput)
    : amountDeltaA(nextLow, nextHigh, currLiquidity, !amountSpecifiedIsInput);
  const amountFixed = fixedIsA
    ? amountDeltaA(nextLow, nextHigh, currLiquidity, amountSpecifiedIsInput)
    : amountDeltaB(nextLow, nextHigh, currLiquidity, amountSpecifiedIsInput);

  let amountIn = amountSpecifiedIsInput ? amountFixed : amountUnfixed;
  let amountOut = amountSpecifiedIsInput ? amountUnfixed : amountFixed;
  if (!amountSpecifiedIsInput && amountOut > amountRemaining) amountOut = amountRemaining;

  let feeAmount;
  if (amountSpecifiedIsInput && !isMaxSwap) {
    feeAmount = amountRemaining - amountIn;
  } else {
    const feeRateBN = BigInt(feeRate);
    feeAmount = mulDivCeil(amountIn, feeRateBN, ORCA_FEE_RATE_MUL_VALUE - feeRateBN);
  }
  return { amountIn, amountOut, nextPrice: nextSqrtPrice, feeAmount, isMaxSwap };
}

/**
 * findNextInitializedTickIndex — scan the supplied arrays (in trade order:
 * the array containing the current tick first, then the next arrays in the
 * trade direction) for the next initialized tick. Mirrors the SDK's
 * TickArraySequence scan (aToB searches at-or-below the current tick and
 * then down through the following arrays; bToA searches above).
 * @returns {{tickIndex: number, liquidityNet: bigint} | null} null when no
 *          initialized tick remains in the supplied range (boundary).
 */
export function findNextInitializedTickIndex(snapshot, tickCurrent, aToB) {
  const { tickSpacing, tickArrays } = snapshot;
  const currentStart = whirlpoolStartTick(tickCurrent, tickSpacing);
  if (tickArrays[0]?.startTickIndex !== currentStart) {
    throw new Error("findNextInitializedTickIndex: tickArrays[0] must contain the pool's current tick");
  }
  for (const arr of tickArrays) {
    if (aToB) {
      // start at the current tick's slot (or the bottom of the array) going down
      const offsetInArray = Math.min(Math.floor((tickCurrent - arr.startTickIndex) / tickSpacing), arr.tickCount - 1);
      for (let i = offsetInArray; i >= 0; i--) {
        const t = arr.ticks[i];
        if (t.initialized) return { tickIndex: t.tickIndex, liquidityNet: BigInt(t.liquidityNet) };
      }
    } else {
      const offsetInArray = Math.max(Math.floor((tickCurrent - arr.startTickIndex) / tickSpacing) + 1, 0);
      for (let i = offsetInArray; i < arr.tickCount; i++) {
        const t = arr.ticks[i];
        if (t.initialized) return { tickIndex: t.tickIndex, liquidityNet: BigInt(t.liquidityNet) };
      }
    }
  }
  return null; // boundary — the supplied arrays are exhausted
}

/**
 * whirlpoolQuote — the full tick-walk quote (SDK computeSwap mirror, static
 * fee path). Walks initialized ticks until the input amount is consumed or
 * the supplied tick arrays run out (SDK-style partial trade).
 *
 * @param {object} args
 * @param {object} args.snapshot { whirlpool: decodeWhirlpoolState(...),
 *   tickArrays: [decodeWhirlpoolTickArray(...)…] } — arrays in trade order.
 * @param {string|number} args.amount raw amount in base units
 * @param {boolean} [args.amountSpecifiedIsInput] default true
 * @param {boolean} args.aToB true = selling token A for token B
 * @param {string} [args.sqrtPriceLimit] default MIN+1 (aToB) / MAX−1 (bToA)
 * @returns {{amountIn, amountOut, feeAmount, allTrade, endSqrtPrice,
 *            endTickIndex, appliedFeeRate, aToB}}
 */
export function whirlpoolQuote({ snapshot, amount, amountSpecifiedIsInput = true, aToB, sqrtPriceLimit = null }) {
  const wp = snapshot.whirlpool;
  let amountRemaining = BigInt(String(amount));
  let amountCalculated = 0n;
  let currSqrtPrice = BigInt(wp.sqrtPrice);
  let currLiquidity = BigInt(wp.liquidity);
  let currTickIndex = wp.tickCurrent;
  let totalFeeAmount = 0n;
  const feeRate = wp.feeRate;
  const limit = sqrtPriceLimit !== null ? BigInt(String(sqrtPriceLimit))
    : (aToB ? ORCA_MIN_SQRT_PRICE + 1n : ORCA_MAX_SQRT_PRICE - 1n);
  if ((aToB && limit >= currSqrtPrice) || (!aToB && limit <= currSqrtPrice)) {
    throw new Error("whirlpoolQuote: sqrtPriceLimit is not in the trade direction");
  }
  if (amountRemaining === 0n) throw new Error("whirlpoolQuote: zero tradable amount");

  let allTrade = true;
  let safety = 0;
  while (amountRemaining > 0n && currSqrtPrice !== limit) {
    if (++safety > 5000) throw new Error("whirlpoolQuote: walk safety bound exceeded");
    const next = findNextInitializedTickIndex({ tickSpacing: wp.tickSpacing, tickArrays: snapshot.tickArrays }, currTickIndex, aToB);
    if (next === null) {
      allTrade = false;
      break;
    }
    const nextTickPrice = getSqrtPriceAtTick(next.tickIndex, ORCA_TICK_FACTORS, ORCA_MIN_TICK_INDEX, ORCA_MAX_TICK_INDEX);
    const sqrtPriceTarget = aToB ? (limit > nextTickPrice ? limit : nextTickPrice) : (limit < nextTickPrice ? limit : nextTickPrice);
    const step = computeWhirlpoolSwapStep(amountRemaining, feeRate, currLiquidity, currSqrtPrice, sqrtPriceTarget, amountSpecifiedIsInput, aToB);
    totalFeeAmount += step.feeAmount;
    if (amountSpecifiedIsInput) {
      amountRemaining = amountRemaining - step.amountIn - step.feeAmount;
      amountCalculated += step.amountOut;
    } else {
      amountRemaining -= step.amountOut;
      amountCalculated += step.amountIn + step.feeAmount;
    }
    if (amountRemaining < 0n) throw new Error("whirlpoolQuote: amount remaining negative");
    if (step.nextPrice === nextTickPrice) {
      if (aToB) currLiquidity = currLiquidity - next.liquidityNet;
      else currLiquidity = currLiquidity + next.liquidityNet;
      currTickIndex = aToB ? next.tickIndex - 1 : next.tickIndex;
    } else {
      currTickIndex = getTickAtSqrtPrice(step.nextPrice, {
        factors: ORCA_TICK_FACTORS,
        bitPrecision: 14,
        minTick: ORCA_MIN_TICK_INDEX,
        maxTick: ORCA_MAX_TICK_INDEX,
        minSqrtPrice: ORCA_MIN_SQRT_PRICE,
        maxSqrtPrice: ORCA_MAX_SQRT_PRICE,
      });
    }
    currSqrtPrice = step.nextPrice;
  }
  // calculateEstTokens (SDK): aToB === isInput → amountA = amount − remaining.
  const spentA = aToB === amountSpecifiedIsInput;
  const amountA = spentA ? BigInt(String(amount)) - amountRemaining : amountCalculated;
  const amountB = spentA ? amountCalculated : BigInt(String(amount)) - amountRemaining;
  return {
    aToB,
    amountSpecifiedIsInput,
    amountIn: (aToB ? amountA : amountB).toString(),
    amountOut: (aToB ? amountB : amountA).toString(),
    feeAmount: totalFeeAmount.toString(),
    allTrade,
    endSqrtPrice: currSqrtPrice.toString(),
    endTickIndex: currTickIndex,
    appliedFeeRate: feeRate,
    sqrtPriceLimit: limit.toString(),
  };
}

// ── Instruction construction (the wire level — GUARDED execute) ────────────

/**
 * Build the swap_v2 instruction artifact + (with a blockhash) the unsigned
 * serialized tx. Mirrors the live tx account layout 1:1 (15 metas + the
 * None option byte). Owner ATAs derived offline.
 *
 * @param {object} args { snapshot, userPubkey, inputMint, amountInRaw,
 *   amountOutMinRaw?, slippageBps?, sqrtPriceLimit?, blockhash?, feePayer? }
 */
export function shapeOrcaSwapArtifact({ snapshot, userPubkey, inputMint, amountInRaw, amountOutMinRaw = null, slippageBps = 100, sqrtPriceLimit = null, blockhash = null, feePayer = null }) {
  const wp = snapshot.whirlpool;
  const user = new PublicKey(userPubkey);
  const aToB = inputMint === wp.mintA;
  if (!aToB && inputMint !== wp.mintB) {
    throw new Error(`shapeOrcaSwapArtifact: inputMint ${inputMint} is not a mint of whirlpool ${wp.pool}`);
  }
  const amountIn = BigInt(String(amountInRaw));
  const quote = whirlpoolQuote({ snapshot, amount: amountIn.toString(), amountSpecifiedIsInput: true, aToB, sqrtPriceLimit });
  if (!quote.allTrade) {
    throw new Error("shapeOrcaSwapArtifact: quote exceeds the supplied tick arrays — supply more arrays or a smaller amount");
  }
  const outRaw = BigInt(quote.amountOut);
  const minOut = amountOutMinRaw !== null ? BigInt(String(amountOutMinRaw)) : (outRaw * BigInt(10000 - slippageBps)) / 10000n;
  const limit = sqrtPriceLimit !== null ? BigInt(String(sqrtPriceLimit)) : (aToB ? ORCA_MIN_SQRT_PRICE + 1n : ORCA_MAX_SQRT_PRICE - 1n);

  const tokenProgramA = snapshot.tokenProgramA || SPL_TOKEN_PROGRAM_ID;
  const tokenProgramB = snapshot.tokenProgramB || SPL_TOKEN_PROGRAM_ID;
  const ataA = getAssociatedTokenAddressSync(new PublicKey(wp.mintA), user, true, new PublicKey(tokenProgramA));
  const ataB = getAssociatedTokenAddressSync(new PublicKey(wp.mintB), user, true, new PublicKey(tokenProgramB));
  if (!snapshot.oracle) {
    throw new Error("shapeOrcaSwapArtifact: snapshot.oracle (the derived oracle PDA) is required");
  }
  const keys = [
    { pubkey: tokenProgramA, isSigner: false, isWritable: false }, // 0 tokenProgramA
    { pubkey: tokenProgramB, isSigner: false, isWritable: false }, // 1 tokenProgramB
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }, // 2 memo
    { pubkey: user.toBase58(), isSigner: true, isWritable: false }, // 3 tokenAuthority (readonly signer)
    { pubkey: wp.pool, isSigner: false, isWritable: true }, // 4 whirlpool
    { pubkey: wp.mintA, isSigner: false, isWritable: false }, // 5 tokenMintA
    { pubkey: wp.mintB, isSigner: false, isWritable: false }, // 6 tokenMintB
    { pubkey: ataA.toBase58(), isSigner: false, isWritable: true }, // 7 tokenOwnerAccountA
    { pubkey: wp.vaultA, isSigner: false, isWritable: true }, // 8 tokenVaultA
    { pubkey: ataB.toBase58(), isSigner: false, isWritable: true }, // 9 tokenOwnerAccountB
    { pubkey: wp.vaultB, isSigner: false, isWritable: true }, // 10 tokenVaultB
    ...snapshot.tickArrays.slice(0, ORCA_MAX_SWAP_TICK_ARRAYS).map((ta) => ({ pubkey: ta.address, isSigner: false, isWritable: true })), // 11-13
    { pubkey: snapshot.oracle, isSigner: false, isWritable: true }, // 14 oracle
  ];

  const data = Buffer.concat([
    Buffer.from(ORCA_SWAP_V2_DISCRIMINATOR, "hex"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(amountIn); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(minOut); return b; })(),
    (() => { const b = Buffer.alloc(16); b.writeBigUInt64LE(limit & 0xffffffffffffffffn); b.writeBigUInt64LE(limit >> 64n, 8); return b; })(),
    Buffer.from([1]), // amountSpecifiedIsInput = true (this leg quotes base-in)
    Buffer.from([aToB ? 1 : 0]),
    Buffer.from([0]), // remainingAccountsInfo = None
  ]);

  const ix = {
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
    discriminator: ORCA_SWAP_V2_DISCRIMINATOR,
    aToB,
    amountInRaw: amountIn.toString(),
    amountOutMinRaw: minOut.toString(),
    sqrtPriceLimit: limit.toString(),
    keys: keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })),
    dataBase64: data.toString("base64"),
    dataHex: data.toString("hex"),
  };

  const artifact = {
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
    pool: wp.pool,
    userPubkey: user.toBase58(),
    inputMint,
    outputMint: aToB ? wp.mintB : wp.mintA,
    inputAta: (aToB ? ataA : ataB).toBase58(),
    outputAta: (aToB ? ataB : ataA).toBase58(),
    quote: {
      amountInRaw: quote.amountIn,
      amountOutRaw: quote.amountOut,
      amountOutMinRaw: minOut.toString(),
      feeAmount: quote.feeAmount,
      allTrade: quote.allTrade,
      appliedFeeRate: quote.appliedFeeRate,
      endSqrtPrice: quote.endSqrtPrice,
      endTickIndex: quote.endTickIndex,
      aToB: quote.aToB,
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
      programId: new PublicKey(ORCA_WHIRLPOOL_PROGRAM_ID),
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
 * Create the Orca Whirlpool DEX-direct swap leg.
 * ctx per phase:
 *   build: { snapshot, userPubkey, inputMint, amountInRaw, slippageBps?,
 *            amountOutMinRaw?, sqrtPriceLimit?, blockhash?, feePayer? }
 *   submit: 🔴 always throws DexDirectLiveTestGateError.
 */
export function createOrcaSwapLeg() {
  return createLeg({
    id: "orca-swap",
    family: "svm",
    chain: "sol",
    description:
      "The Orca Whirlpool DEX-direct swap leg (Solana CLMM fallback — the no-aggregator path " +
      "when Jupiter is down or for fee comparison): the REAL read-only quote computed from the " +
      "live on-chain pool state (whirlpool + tick arrays — the exact SDK/on-chain swap math " +
      "mirrored in BigInt; cross-checked against @orca-so/whirlpools-sdk on the frozen capture) " +
      "+ the swap_v2 instruction + unsigned tx pinned to the wire level (disc 2b04ed0b1ac91e62 " +
      "— VERIFIED on the live mainnet swap tx 44VxpkKE… on the SOL/USDC whirlpool Czfq3xZZ…, " +
      "err ok). 🔴 GUARDED STUB: submit() always throws DexDirectLiveTestGateError — " +
      "swap-execution pending Mr. Esters' live anchor.",
    goldenStep: "orca",
    phases: {
      async build(ctx) {
        if (!ctx.snapshot?.whirlpool) throw new Error("orcaSwapLeg.build: snapshot.whirlpool (the decoded pool state) is required");
        if (!ctx.snapshot?.tickArrays?.length) throw new Error("orcaSwapLeg.build: snapshot.tickArrays (the decoded arrays along the path) are required");
        if (!ctx.userPubkey) throw new Error("orcaSwapLeg.build: userPubkey is required");
        if (!ctx.inputMint) throw new Error("orcaSwapLeg.build: inputMint is required");
        if (!Number.isFinite(Number(ctx.amountInRaw)) || Number(ctx.amountInRaw) <= 0) {
          throw new Error("orcaSwapLeg.build: a positive raw amountInRaw is required");
        }
        const artifact = shapeOrcaSwapArtifact({
          snapshot: ctx.snapshot,
          userPubkey: ctx.userPubkey,
          inputMint: ctx.inputMint,
          amountInRaw: String(ctx.amountInRaw),
          ...(ctx.amountOutMinRaw !== undefined ? { amountOutMinRaw: String(ctx.amountOutMinRaw) } : {}),
          ...(ctx.slippageBps !== undefined ? { slippageBps: ctx.slippageBps } : {}),
          ...(ctx.sqrtPriceLimit !== undefined ? { sqrtPriceLimit: ctx.sqrtPriceLimit } : {}),
          ...(ctx.blockhash ? { blockhash: ctx.blockhash } : {}),
          ...(ctx.feePayer ? { feePayer: ctx.feePayer } : {}),
        });
        return { needed: true, artifact };
      },
      // 🔴 THE GUARD — the honest live-anchor boundary (never signs/broadcasts).
      async submit() {
        throw new DexDirectLiveTestGateError(DEX_DIRECT_LIVE_TEST_GATE_MESSAGE);
      },
    },
    meta: {
      wraps:
        "GREENFIELD DIRECT integration: the Whirlpool program (whirLbMiic…) swap_v2 " +
        "instruction (disc 2b04ed0b1ac91e62 = sha256(global:swap_v2)[..8]) + the pool-state " +
        "quote (mirror of @orca-so/whirlpools-sdk computeSwap/computeSwapStep/PriceMath). " +
        "PDA seeds VERIFIED against the live tx 44VxpkKE… (tick_array with the DECIMAL-STRING " +
        "start tick; oracle may not exist on-chain for non-adaptive pools). Vaults are owned " +
        "by the whirlpool address (program CPI-signs); the ix tokenAuthority is the user " +
        "wallet (readonly signer). Boundary: static fee pools only (no adaptive/oracle fee " +
        "model); no token-extension transfer fees; quotes bounded by the supplied tick " +
        "arrays (SDK-style partial result beyond them).",
      liveTestAnchor: "orca-swap-execution",
    },
  });
}
