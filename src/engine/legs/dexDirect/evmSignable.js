/**
 * evmSignable.js — the SIGNED-IN-YOUR-WALLET execute surface for the EVM
 * dexDirect legs (Uniswap v3 + PancakeSwap v3 — the same fork ABI, per-leg
 * SwapRouter deployments).
 *
 * 🔴 FUNDS RULE — nothing in this module broadcasts. It PRODUCES the
 * correctly-encoded transactions for Mr. Esters' wallet (Rabby) to sign:
 *
 *   approvalTx — ERC-20 approve(spender, EXACT amount) on the source
 *     token, spender = the leg's own v3 SwapRouter. This is the official
 *     Uniswap swap-integration skill's LEGACY DIRECT-APPROVE pattern — the
 *     documented choice for the direct-periphery SwapRouter path this leg
 *     family pins (see uniswapSwapLeg.js's skill cross-check: Permit2 +
 *     Universal Router would add per-swap EIP-712 signing + command-encoded
 *     calldata + per-chain UR addresses for zero benefit on a single-hop v3
 *     swap; "Never approve to a Universal Router for this leg").
 *   swapTx     — SwapRouter.exactInputSingle, encoded with viem (the
 *     repo's official EVM SDK — the lifiApproval precedent, audit #65)
 *     from the quote-pinned artifact's parameters with a FRESH deadline
 *     (now + 30 min default; the skill-aligned pre-broadcast validator
 *     refuses a stale deadline or a zero min-out BEFORE anything is
 *     signable).
 *
 * The ONLY on-chain interaction is the read-only allowance eth_call
 * (fail-closed: an allowance that cannot be read never assumes "approved").
 * The anchor harness (src/lib/dexAnchor/dexAnchorRunner.js) hands the
 * returned txs to the EIP-1193 wallet adapter; Mr. Esters approves in
 * Rabby; RABBY's own connection broadcasts. There is no eth_sendTransaction
 * and no sendRawTransaction anywhere in this module or the legs.
 *
 * DRIFT CANARY: the viem encoding is byte-pinned to the frozen dex-direct
 * swap-request calldata (test/engineDexExecute.test.js re-encodes the
 * frozen artifacts at their pinned deadline and asserts byte-identity).
 * If the ABI/encoding ever diverged from the live-verified construction,
 * the canary fails loud.
 */
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { validateExactInputSingleSwapRequest, evmAddress } from "./evmV3.js";

/** The v3 SwapRouter exactInputSingle ABI (the canonical periphery ABI —
 *  same on Uniswap v3 and PancakeSwap v3). */
export const EXACT_INPUT_SINGLE_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)",
]);

/** The ERC-20 allowance + approve ABI. */
export const ERC20_ALLOWANCE_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** Fresh-deadline window for a live-anchor swap tx (now + 30 min). */
export const DEX_DIRECT_DEADLINE_WINDOW_SEC = 30 * 60;

/** True when a token address is the chain-native coin (or absent): the
 *  zero address or the 0xeee… marker. Anything that is not a plain 0x
 *  address is treated as native too (no approval path exists for it). */
export function isNativeTokenAddress(address) {
  if (!address) return true;
  const a = String(address).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return true;
  return a === "0x" + "0".repeat(40) || a === "0x" + "e".repeat(40);
}

/** Decode the deadline word from the frozen exactInputSingle calldata
 *  (selector + 8 words; deadline = word 5). */
export function deadlineOfSwapCalldata(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]+$/.test(data)) {
    throw new Error("deadlineOfSwapCalldata: data is not hex");
  }
  const words = data.slice(10).match(/.{64}/g);
  if (!words || words.length !== 8) {
    throw new Error("deadlineOfSwapCalldata: expected selector + 8 words");
  }
  return BigInt("0x" + words[4]);
}

/**
 * viem-encode the SwapRouter.exactInputSingle call (official-EVM-SDK
 * encoding of the direct-periphery swap — byte-identical to the frozen
 * hex-math construction at the same deadline; the canary pins it).
 */
export function encodeExactInputSingle({ tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96 = 0 }) {
  return encodeFunctionData({
    abi: EXACT_INPUT_SINGLE_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn,
        tokenOut,
        fee,
        recipient,
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96,
      },
    ],
  });
}

/**
 * Build the SIGNED-IN-RABBY swap tx for a dex-direct EVM artifact.
 * Re-encodes exactInputSingle from the artifact's quote-pinned parameters
 * with a FRESH deadline (now + 30 min unless `deadlineSec` is supplied),
 * then runs the skill-aligned pre-broadcast validator on the result — a
 * live anchor never receives a swap tx that fails its own wire checks
 * (canonical router target / exact 260-byte calldata / positive min-out /
 * fresh deadline / non-payable).
 *
 * @param {object} args
 * @param {object} args.artifact the leg build artifact (quote-pinned: has
 *   fromToken/toToken/fee/amountIn/quote.minOutRaw/router/swapRequest)
 * @param {number} args.chainId the EVM chain id the wallet must be on
 * @param {string} args.from the connected EVM wallet address
 * @param {number} [args.deadlineSec] unix seconds; default now + 30 min
 * @returns {{kind, dex, chain, chainId, from, to, data, value, deadline,
 *            note}} the wallet-ready tx params (eth_sendTransaction shape)
 */
export function buildEvmSwapTx({ artifact, chainId, from, deadlineSec = null }) {
  if (!artifact?.swapRequest) {
    throw new Error("buildEvmSwapTx: the artifact has no quote-pinned swapRequest — run the quote first");
  }
  const words = artifact.swapRequest.data.slice(10).match(/.{64}/g);
  const recipientAddr = "0x" + words[3].replace(/^0+/, "").padStart(40, "0"); // word 4 of 8 = recipient
  const deadline = deadlineSec ?? Math.floor(Date.now() / 1000) + DEX_DIRECT_DEADLINE_WINDOW_SEC;
  const data = encodeExactInputSingle({
    tokenIn: artifact.fromToken.address,
    tokenOut: artifact.toToken.address,
    fee: artifact.fee,
    recipient: recipientAddr,
    deadline,
    amountIn: artifact.amountIn,
    amountOutMinimum: artifact.quote.minOutRaw,
  });
  const tx = {
    kind: "dex-direct-swap",
    dex: artifact.dex,
    chain: artifact.chain,
    chainId,
    from,
    to: evmAddress(artifact.swapRequest.to),
    data,
    value: "0x0", // exactInputSingle on the v3 SwapRouter is non-payable
    deadline: String(deadline),
    note: "SwapRouter.exactInputSingle (viem-encoded) — sign in Rabby; the wallet broadcasts on YOUR confirm.",
  };
  // The skill-aligned wire validator on the FINAL tx (fresh deadline, so a
  // min-deadline floor of now passes only when the deadline really is fresh).
  validateExactInputSingleSwapRequest(
    { kind: "swap-exactInputSingle", to: tx.to, data: tx.data, value: tx.value },
    { router: artifact.router, minDeadline: Math.floor(Date.now() / 1000) },
  );
  return tx;
}

/**
 * Read-only allowance check (eth_call through the EIP-1193 provider —
 * Rabby forwards the read to its current network). Fail-closed: an
 * allowance that cannot be read throws — the anchor never assumes
 * "approved". Native-coin inputs need no approval.
 *
 * @returns {{ok: true, native: boolean, allowanceRaw: string|null}} the
 *   raw allowance ("0" when none); the caller compares it against the
 *   exact amount it plans to spend.
 */
export async function checkEvmAllowance({ provider, tokenAddress, owner, spender }) {
  if (isNativeTokenAddress(tokenAddress)) {
    return { ok: true, native: true, allowanceRaw: null };
  }
  if (!provider || typeof provider.request !== "function") {
    throw new Error("checkEvmAllowance: no EIP-1193 provider (connect Rabby first)");
  }
  const data = encodeFunctionData({
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });
  let hex;
  try {
    hex = await provider.request({ method: "eth_call", params: [{ to: tokenAddress, data }, "latest"] });
  } catch (e) {
    throw new Error(`checkEvmAllowance: the allowance read failed (${e?.message || e}) — the anchor never assumes approved; retry with the wallet on the right network`);
  }
  // Some providers return "0x" / "0x0" for a zero allowance — normalize to a
  // full 32-byte word before decoding (a real allowance read is 32 bytes).
  const clean = !hex || hex === "0x" || hex === "0x0" ? "0x" + "0".repeat(64) : hex;
  const allowanceRaw = decodeFunctionResult({ abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", data: clean }).toString();
  return { ok: true, native: false, allowanceRaw };
}

/**
 * Build the SIGNED-IN-RABBY approval tx — ERC-20 approve(spender, EXACT
 * amount) on the source token (never MaxUint256 — the lifiApproval
 * discipline). viem-encoded.
 */
export function buildEvmApprovalTx({ tokenAddress, spender, amount, chainId, from, dex = null, chain = null }) {
  if (isNativeTokenAddress(tokenAddress)) {
    throw new Error("buildEvmApprovalTx: the native coin needs no approval (this leg serves ERC-20 pairs)");
  }
  const data = encodeFunctionData({
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "approve",
    args: [spender, BigInt(String(amount))],
  });
  return {
    kind: "dex-direct-approval",
    dex,
    chain,
    chainId,
    from,
    to: evmAddress(tokenAddress),
    data,
    value: "0x0",
    spender: evmAddress(spender),
    note: `ERC-20 approve(${spender}, exact amount) — sign in Rabby; the wallet broadcasts on YOUR confirm.`,
  };
}

/**
 * The per-leg execute PLAN (the task-shaped return): check the on-chain
 * allowance (read-only) and return exactly which tx Mr. Esters signs
 * first. NO send of any kind happens here.
 *
 * @param {object} args { provider (EIP-1193 — read-only usage), artifact,
 *   chainId, from, deadlineSec? }
 * @returns {{dex, chain, chainId, from, spender, needsApproval,
 *            approvalTx?: object, swapTx: object,
 *            boundary: string}}
 */
export async function planEvmDexExecute({ provider, artifact, chainId, from, deadlineSec = null }) {
  if (!artifact || !artifact.fromToken || !artifact.quote || !artifact.swapRequest) {
    throw new Error("planEvmDexExecute: a quote-pinned artifact is required (build the leg first)");
  }
  if (!from) throw new Error("planEvmDexExecute: from (the connected EVM wallet address) is required");
  const spender = evmAddress(artifact.router);
  const amountIn = String(artifact.amountIn);

  if (isNativeTokenAddress(artifact.fromToken.address)) {
    throw new Error(
      "planEvmDexExecute: native-coin input is not servable by the direct SwapRouter leg " +
        "(exactInputSingle is non-payable; a native swap needs a WETH wrap). The served pairs are ERC-20.",
    );
  }

  const allowance = await checkEvmAllowance({ provider, tokenAddress: artifact.fromToken.address, owner: from, spender });
  const needsApproval = !allowance.native && BigInt(allowance.allowanceRaw || "0") < BigInt(amountIn);

  const plan = {
    dex: artifact.dex,
    chain: artifact.chain,
    chainId,
    from,
    spender,
    needsApproval,
    boundary:
      "sign-in-wallet: Rabby approves each tx (approval first when needed, then the swap). " +
      "The agent never broadcasts — sign in your wallet; the wallet's own connection sends " +
      "on Mr. Esters' confirm.",
  };
  if (needsApproval) {
    plan.approvalTx = buildEvmApprovalTx({
      tokenAddress: artifact.fromToken.address,
      spender,
      amount: amountIn,
      chainId,
      from,
      dex: artifact.dex,
      chain: artifact.chain,
    });
  }
  plan.swapTx = buildEvmSwapTx({ artifact, chainId, from, deadlineSec });
  return plan;
}
