/**
 * solanaMath.js — shared pure BigInt fixed-point helpers for the dexDirect
 * Solana legs (Raydium CPMM/CLMM + Orca Whirlpool).
 *
 * Every quantity is BigInt; every formula mirrors the protocol reference
 * implementations (the official SDKs) exactly — rounding direction included
 * (floor/ceil), because a swap quote's rounding is consensus-relevant (the
 * on-chain program rounds the same way; a quote that rounds differently is
 * a quote the program would not honor).
 *
 * Fixed point: Raydium CLMM and Orca Whirlpool both price ticks in Q64
 * (sqrtPriceX64 = sqrt(price) << 64). The tick↔sqrtPrice maps below are
 * direct mirrors of each protocol's reference:
 *   - Raydium CLMM: TICK_TO_SQRT_PRICE_FACTORS (19 factors, bit 0..18) +
 *     getTickAtSqrtPrice log2 search (BIT_PRECISION 16) —
 *     raydium-sdk-v2 raydium/clmm/libraries/tickArrayUtil.ts.
 *   - Orca: the same algorithm with its own factor list (bit 0..18, the
 *     identical Uniswap-v3 TickMath factor table) + BIT_PRECISION 14 —
 *     @orca-so/whirlpools-sdk utils/public/price-math.js + tick-utils.js.
 * The two factor tables are numerically identical in this range — kept as
 * two exports so each leg mirrors its own reference file (no cross-
 * contamination; if one protocol ever changes, only its table moves).
 */
export const Q64 = 1n << 64n;
export const Q128 = 1n << 128n;

export const RAYDIUM_CLMM_MIN_TICK = -443636;
export const RAYDIUM_CLMM_MAX_TICK = 443636;
export const RAYDIUM_CLMM_MIN_SQRT_PRICE_X64 = 4295048016n;
export const RAYDIUM_CLMM_MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;

export const ORCA_MIN_TICK_INDEX = -443636;
export const ORCA_MAX_TICK_INDEX = 443636;
export const ORCA_MIN_SQRT_PRICE = 4295048016n;
export const ORCA_MAX_SQRT_PRICE = 79226673515401279992447579055n;

// log2-based inverse-tick constants (identical in both SDKs).
const LOG_B_2_X32 = 59543866431248n;
const LOG_B_P_ERR_MARGIN_LOWER_X64 = 184467440737095516n;
const LOG_B_P_ERR_MARGIN_UPPER_X64 = 15793534762490258745n;

/** The Uniswap-v3 TickMath factor table (sqrt(1.0001^(2^i)) − 1 in Q64
 *  increments) — Raydium's table (bit 0..18). Orca's is the same values;
 *  see ORCA_TICK_FACTORS for the protocol-mirrored copy. */
export const RAYDIUM_TICK_FACTORS = [
  0xfffcb933bd6fb800n, 0xfff97272373d4000n, 0xfff2e50f5f657000n, 0xffe5caca7e10f000n,
  0xffcb9843d60f7000n, 0xff973b41fa98e800n, 0xff2ea16466c9b000n, 0xfe5dee046a9a3800n,
  0xfcbe86c7900bb000n, 0xf987a7253ac65800n, 0xf3392b0822bb6000n, 0xe7159475a2caf000n,
  0xd097f3bdfd2f2000n, 0xa9f746462d9f8000n, 0x70d869a156f31c00n, 0x31be135f97ed3200n,
  0x9aa508b5b85a500n, 0x5d6af8dedc582cn, 0x2216e584f5fan,
];

/** Orca's mirror copy of the same factor table (its tick-utils.js list). */
export const ORCA_TICK_FACTORS = RAYDIUM_TICK_FACTORS;

/** mulDivFloor — a×b÷d, rounded down (BigInt division is floor for
 *  non-negatives; both SDK helpers are used on non-negative quantities). */
export function mulDivFloor(a, b, d) {
  if (d === 0n) throw new Error("mulDivFloor: division by zero");
  return (a * b) / d;
}

/** mulDivCeil — a×b÷d, rounded up when the remainder is non-zero. */
export function mulDivCeil(a, b, d) {
  if (d === 0n) throw new Error("mulDivCeil: division by zero");
  const product = a * b;
  const quotient = product / d;
  return product % d === 0n ? quotient : quotient + 1n;
}

/** divRoundingUp(x, y) — ceil division. */
export function divRoundingUp(x, y) {
  if (y === 0n) throw new Error("divRoundingUp: division by zero");
  return x / y + (x % y === 0n ? 0n : 1n);
}

/** Read a little-endian unsigned BigInt from a Buffer at offset. */
export function readLe(buf, offset, bytes) {
  let v = 0n;
  for (let i = offset + bytes - 1; i >= offset; i--) v = (v << 8n) | BigInt(buf[i]);
  return v;
}

/** Interpret an LE unsigned BigInt as signed (two's complement, n bytes). */
export function toSigned(v, bytes) {
  const signBit = 1n << BigInt(bytes * 8 - 1);
  return v & signBit ? v - (1n << BigInt(bytes * 8)) : v;
}

/** Signed i128 → BigInt (two's complement over 16 bytes). */
export function fromSignedI128(v) {
  return toSigned(v, 16);
}

/** BigInt → signed i128 two's complement (as unsigned BigInt of 128 bits). */
export function toSignedI128(v) {
  if (v < 0n) return v + Q128;
  return v;
}

/**
 * getSqrtPriceAtTick — sqrt(1.0001^tick) in Q64, mirroring the SDKs'
 * TickUtil.getSqrtPriceAtTick: ratio starts at Q64 and multiplies in the
 * factors whose bit is set in |tick|; positive ticks invert.
 * @param {number} tick
 * @param {bigint[]} factors the protocol's factor table
 * @param {number} minTick protocol min tick
 * @param {number} maxTick protocol max tick
 */
export function getSqrtPriceAtTick(tick, factors = RAYDIUM_TICK_FACTORS, minTick = RAYDIUM_CLMM_MIN_TICK, maxTick = RAYDIUM_CLMM_MAX_TICK) {
  if (tick < minTick || tick > maxTick) {
    throw new Error(`getSqrtPriceAtTick: tick ${tick} out of range [${minTick}, ${maxTick}]`);
  }
  const absTick = Math.abs(tick);
  let ratio = Q64;
  for (let bit = 0; bit < factors.length; bit++) {
    if ((absTick & (1 << bit)) !== 0) {
      ratio = mulDivFloor(ratio, factors[bit], Q64);
    }
  }
  if (tick > 0) {
    ratio = mulDivFloor(Q64, Q64, ratio);
  }
  return ratio;
}

/**
 * getTickAtSqrtPrice — the inverse map (log2 search), mirroring both SDKs'
 * sqrtPriceX64ToTickIndex / getTickAtSqrtPrice.
 * @param {bigint} sqrtPriceX64
 * @param {{factors: bigint[], bitPrecision: number, minTick: number,
 *          maxTick: number, minSqrtPrice: bigint, maxSqrtPrice: bigint}} cfg
 */
export function getTickAtSqrtPrice(sqrtPriceX64, cfg = {}) {
  const {
    factors = RAYDIUM_TICK_FACTORS,
    bitPrecision = 16,
    minTick = RAYDIUM_CLMM_MIN_TICK,
    maxTick = RAYDIUM_CLMM_MAX_TICK,
    minSqrtPrice = RAYDIUM_CLMM_MIN_SQRT_PRICE_X64,
    maxSqrtPrice = RAYDIUM_CLMM_MAX_SQRT_PRICE_X64,
  } = cfg;
  if (sqrtPriceX64 < minSqrtPrice || sqrtPriceX64 > maxSqrtPrice) {
    throw new Error("getTickAtSqrtPrice: sqrtPrice out of supported range");
  }
  const msb = sqrtPriceX64.toString(2).length - 1;
  const msbMinus64 = msb - 64;
  const log2pIntegerX32 = msbMinus64 >= 0 ? BigInt(msbMinus64) << 32n : (-BigInt(-msbMinus64)) << 32n;
  let r = msb >= 64 ? sqrtPriceX64 >> BigInt(msb - 63) : sqrtPriceX64 << BigInt(63 - msb);
  let log2pFractionX64 = 0n;
  let bit = 1n << 63n;
  for (let precision = 0; precision < bitPrecision && bit !== 0n; precision++) {
    r = r * r;
    const isRMoreThanTwo = Number(r >> 127n);
    r = r >> BigInt(63 + isRMoreThanTwo);
    if (isRMoreThanTwo) log2pFractionX64 += bit;
    bit >>= 1n;
  }
  const log2pFractionX32 = log2pFractionX64 >> 32n;
  const log2pX32 = log2pIntegerX32 + log2pFractionX32;
  const logSqrt10001X64 = log2pX32 * LOG_B_2_X32;
  const tickLowBN = logSqrt10001X64 - LOG_B_P_ERR_MARGIN_LOWER_X64;
  const tickHighBN = logSqrt10001X64 + LOG_B_P_ERR_MARGIN_UPPER_X64;
  const tickLow = signedShrn64(tickLowBN);
  const tickHigh = signedShrn64(tickHighBN);
  if (tickLow === tickHigh) return tickLow;
  const sqrtPriceAtTickHigh = getSqrtPriceAtTick(tickHigh, factors, minTick, maxTick);
  if (sqrtPriceAtTickHigh <= sqrtPriceX64) return tickHigh;
  return tickLow;
}

/** signed floor-shift-right by 64 (the SDKs' signedShrn64). */
export function signedShrn64(bn) {
  if (bn < 0n) {
    const result = bn / Q64; // BigInt division truncates toward zero
    return bn % Q64 !== 0n ? Number(result - 1n) : Number(result);
  }
  return Number(bn >> 64n);
}

/**
 * getNextSqrtPriceFromInput / getNextSqrtPriceFromOutput — the Q64 core
 * price-move formulas (both protocols share the Uniswap-v3 core; the X64
 * versions are identical modulo the fixed-point shift).
 */
export function getNextSqrtPriceFromAmountARoundingUp(sqrtPrice, liquidity, amount, add) {
  if (amount === 0n) return sqrtPrice;
  const numerator = liquidity << 64n;
  if (add) {
    const product = amount * sqrtPrice;
    const denominator = numerator + product;
    if (denominator >= numerator) {
      return mulDivCeil(numerator, sqrtPrice, denominator);
    }
    const quotient = mulDivFloor(numerator, 1n, sqrtPrice);
    return mulDivCeil(numerator, 1n, quotient + amount);
  }
  const product = amount * sqrtPrice;
  if (numerator <= product) {
    throw new Error("Insufficient liquidity for token0 removal");
  }
  const denominator = numerator - product;
  return mulDivCeil(numerator, sqrtPrice, denominator);
}

export function getNextSqrtPriceFromAmountBRoundingDown(sqrtPrice, liquidity, amount, add) {
  if (amount === 0n) return sqrtPrice;
  if (add) {
    const quotient = (amount << 64n) / liquidity;
    return sqrtPrice + quotient;
  }
  const quotient = divRoundingUp(amount << 64n, liquidity);
  return sqrtPrice - quotient;
}
