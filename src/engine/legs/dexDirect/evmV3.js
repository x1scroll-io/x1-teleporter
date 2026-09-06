/**
 * evmV3.js — shared construction for the DEX-direct EVM v3-family legs
 * (Uniswap v3 + PancakeSwap v3 — the same fork ABI, different deployments).
 *
 * QUOTE PATH (read-only — the "real quote" of the dexDirect EVM legs): the
 * protocol QuoterV2 contract's quoteExactInputSingle —
 *   quoteExactInputSingle((address tokenIn, address tokenOut, uint256
 *   amountIn, uint24 fee, uint160 sqrtPriceLimitX96))
 * via eth_call (static — no state change, no funds). The calldata is fully
 * static (5 × 32-byte words), so it is built with plain hex math here (no
 * ABI library) and the response is 4 × 32-byte words (amountOut,
 * sqrtPriceX96After, initializedTicksCrossed, gasEstimate). LIVE-VERIFIED
 * on eth/arb/opt/pol + bsc (2026-09-05 — see the dex-direct fixtures): the
 * eth USDC→USDT fee-100 quote returns amountOut 9997027 (10 USDC in — the
 * frozen 2026-09-05 capture; re-verified 2026-09-06: 9997212 — quotes are
 * market data, the oracle pins the CONSTRUCTION).
 *
 * EXECUTE PATH (GUARDED — the swap-call REQUEST the lane would sign): the
 * v3 SwapRouter exactInputSingle —
 *   exactInputSingle((address tokenIn, address tokenOut, uint24 fee,
 *   address recipient, uint256 deadline, uint256 amountIn, uint256
 *   amountOutMinimum, uint160 sqrtPriceLimitX96))
 * — the classic direct-periphery swap call (the no-aggregator path). Also
 * static calldata. The execute leg never signs: it pins the request
 * artifact and submit() throws DexDirectLiveTestGateError.
 *
 * Fee tiers: the quoter needs the pool's fee tier. This module ships a
 * deterministic default tier per protocol+chain+pair when known (captured
 * from the live factory getPool probes); the stage layer can supply any
 * tier via ctx.
 */
export const QUOTE_EXACT_INPUT_SINGLE_SELECTOR = "0xc6a5026a"; // quoteExactInputSingle((address,address,uint256,uint24,uint160))
export const EXACT_INPUT_SINGLE_SELECTOR = "0x414bf389"; // exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
export const ERC20_APPROVE_SELECTOR = "0x095ea7b3"; // approve(address,uint256)

/** Normalize an EVM address to lowercase 0x-hex. */
export function evmAddress(addr) {
  if (typeof addr !== "string" || !/^0[xX][0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`evmAddress: invalid EVM address "${addr}"`);
  }
  return addr.toLowerCase();
}

const WORD = 64;

/** ABI-encode a static word (right-aligned value). */
export function word(value) {
  const hex = typeof value === "bigint" ? value.toString(16) : BigInt(value).toString(16);
  if (hex.length > 64) throw new Error("word: value does not fit in 32 bytes");
  return "0".repeat(WORD - hex.length) + hex;
}

/**
 * validateExactInputSingleSwapRequest — the SKILL-ALIGNED pre-broadcast
 * check for a dexDirect EVM swap-call request artifact. This is the
 * official Uniswap swap-integration skill's "Pre-Broadcast Validation"
 * discipline adapted to the direct v3 SwapRouter periphery path (the
 * Trading API's validateSwapBeforeBroadcast guards an API-built tx; a
 * direct leg validates its OWN construction):
 *   1. the request targets the canonical v3 SwapRouter for its chain;
 *   2. data is non-empty hex of exactly selector + 8 static words;
 *   3. the selector is exactInputSingle;
 *   4. amountOutMinimum (word 7) is positive — a quote must have landed
 *      (a request shaped before the quote carries the 0 placeholder and
 *      must never be signed);
 *   5. deadline (word 5) is in the future — pass minDeadline (e.g.
 *      now + 30 min) to enforce freshness at the live anchor;
 *   6. value is 0 (exactInputSingle on the v3 SwapRouter is non-payable).
 * Pure. Throws with a precise reason; returns { ok: true } when valid.
 */
export function validateExactInputSingleSwapRequest(request, { router, minDeadline = null, requirePositiveMinOut = true } = {}) {
  if (!request || typeof request !== "object") {
    throw new Error("validateExactInputSingleSwapRequest: a request artifact is required");
  }
  if (request.kind !== "swap-exactInputSingle") {
    throw new Error(`validateExactInputSingleSwapRequest: not an exactInputSingle request (kind "${request.kind}")`);
  }
  const wantRouter = evmAddress(router);
  const gotRouter = evmAddress(request.to);
  if (gotRouter !== wantRouter) {
    throw new Error(`validateExactInputSingleSwapRequest: request targets ${gotRouter} — expected the canonical SwapRouter ${wantRouter}`);
  }
  const data = request.data;
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]+$/.test(data)) {
    throw new Error("validateExactInputSingleSwapRequest: data is not hex");
  }
  const EXPECTED_LEN = 2 + 8 + 8 * 64; // 0x + selector + 8 × 32-byte words
  if (data.length !== EXPECTED_LEN) {
    throw new Error(`validateExactInputSingleSwapRequest: data is ${(data.length - 2) / 2} bytes — expected 260 bytes (selector + 8-word struct)`);
  }
  if (!data.toLowerCase().startsWith(EXACT_INPUT_SINGLE_SELECTOR)) {
    throw new Error("validateExactInputSingleSwapRequest: data selector is not exactInputSingle");
  }
  // strip 0x + the 8-hex selector, then group the 8 × 32-byte words
  const words = data.slice(10).match(/.{64}/g);
  const amountOutMinimum = BigInt("0x" + words[6]);
  if (requirePositiveMinOut && amountOutMinimum <= 0n) {
    throw new Error("validateExactInputSingleSwapRequest: amountOutMinimum is 0 — no quote has landed; re-quote before any live anchor");
  }
  const deadline = BigInt("0x" + words[4]);
  const floor = minDeadline ?? Math.floor(Date.now() / 1000);
  if (deadline <= BigInt(floor)) {
    throw new Error(`validateExactInputSingleSwapRequest: deadline ${deadline} is not after ${floor} — a live anchor must pass a fresh deadline (now + ~30 min)`);
  }
  if (request.value !== undefined && request.value !== "0x0" && BigInt(request.value) !== 0n) {
    throw new Error("validateExactInputSingleSwapRequest: exactInputSingle is non-payable — value must be 0");
  }
  return { ok: true };
}

/** eth_call REQUEST for the quoter — the canonical quote artifact the stage
 *  layer sends (read-only). Returns { to, data, chain, note }. */
export function shapeQuoterCall({ quoter, tokenIn, tokenOut, amountIn, fee, chain }) {
  const data =
    QUOTE_EXACT_INPUT_SINGLE_SELECTOR +
    word(evmAddress(tokenIn)) +
    word(evmAddress(tokenOut)) +
    word(amountIn) +
    word(fee) +
    word(0); // sqrtPriceLimitX96 = 0 → no limit
  return {
    method: "eth_call",
    to: evmAddress(quoter),
    data,
    chain,
    from: null, // eth_call from null is the standard quote convention
    kind: "quoter-quoteExactInputSingle",
  };
}

/** Decode the quoter's 4-word response → { amountOut, sqrtPriceX96After,
 *  initializedTicksCrossed, gasEstimate }. Pure. */
export function parseQuoterResponse(hex) {
  if (!hex || hex === "0x" || (hex.length - 2) % 64 !== 0 || hex.length < 2 + 256) {
    throw new Error(`parseQuoterResponse: unexpected response "${String(hex).slice(0, 40)}…"`);
  }
  const words = hex.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));
  return {
    amountOut: words[0].toString(),
    sqrtPriceX96After: words[1].toString(),
    initializedTicksCrossed: Number(words[2]),
    gasEstimate: words[3].toString(),
  };
}

/** The ERC-20 approve(spender, amount) calldata (exact amount — the
 *  lifiApproval discipline). */
export function shapeApproveCalldata(spender, amount) {
  return ERC20_APPROVE_SELECTOR + word(evmAddress(spender)) + word(amount);
}

/** The SwapRouter exactInputSingle swap-call REQUEST (the guarded execute
 *  artifact's tx payload — the lane would sign { to: router, data }). */
export function shapeExactInputSingleCall({ router, tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96 = 0, chain }) {
  const data =
    EXACT_INPUT_SINGLE_SELECTOR +
    word(evmAddress(tokenIn)) +
    word(evmAddress(tokenOut)) +
    word(fee) +
    word(evmAddress(recipient)) +
    word(deadline) +
    word(amountIn) +
    word(amountOutMinimum) +
    word(sqrtPriceLimitX96);
  return {
    to: evmAddress(router),
    data,
    value: "0x0", // exactInputSingle on the v3 SwapRouter is non-payable
    chain,
    kind: "swap-exactInputSingle",
  };
}

/** A deterministic default fee tier per chain+pairs where a DIRECT pool was
 *  verified live (factory getPool probes, 2026-09-05). The stage layer may
 *  override via ctx (a real flow should re-probe the factory for the
 *  deepest live tier). */
export const DEFAULT_FEE_TIERS = {
  uni: {
    eth: { "USDC:USDT": 100 },
    arb: { "USDC:USDT": 100 },
    opt: { "USDC:USDT": 500 },
    pol: { "USDC:USDT": 500 },
  },
  pcs: {
    bsc: { "USDC:USDT": 100, "USDC:DAI": 100 },
  },
};
