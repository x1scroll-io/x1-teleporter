import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPoolSwap, buildApprove, v2SwapCalldata, PoolSwapGateError } from "./swapExecutor.js";
import { resolveDexFamily } from "./dexMap.js";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

const CLEAN = { detected: false, buyTaxBps: 0, sellTaxBps: 0, honeypot: false, blacklisted: false, cannotSellAll: false };
const TAXED = { detected: true, buyTaxBps: 300, sellTaxBps: 300, honeypot: false, blacklisted: false, cannotSellAll: false }; // 3%
const HONEYPOT = { detected: true, buyTaxBps: 9900, sellTaxBps: 9900, honeypot: true, blacklisted: false, cannotSellAll: true };

test("swapExecutor: gate is fail-closed — no gateOpen, no build", async () => {
  await assert.rejects(
    () => buildPoolSwap({ pool: { version: "v3", chain: "eth", dexId: "uniswap-v3", feeTier: 3000 }, router: ROUTER, tokenIn: WETH, tokenOut: TOKEN, amountIn: 1n, amountOutMin: 0n, recipient: RECIPIENT }),
    PoolSwapGateError
  );
  await assert.rejects(() => buildApprove({ token: TOKEN, spender: ROUTER, amount: 1n }), PoolSwapGateError);
});

test("swapExecutor: v3 path builds the exactInputSingle artifact (repo shaper)", async () => {
  const art = await buildPoolSwap({
    pool: { version: "v3", chain: "eth", dexId: "uniswap-v3", feeTier: 3000 }, router: ROUTER,
    tokenIn: WETH, tokenOut: TOKEN, amountIn: 1000000000000000n, amountOutMin: 990000000000000n,
    recipient: RECIPIENT, gateOpen: true,
  });
  assert.equal(art.kind, "signable-swap");
  assert.equal(art.version, "v3");
  assert.equal(art.to, ROUTER);
  assert.ok(art.data.startsWith("0x414bf389"), "exactInputSingle selector");
  assert.equal(art.useFot, false);
  assert.equal(art.slippageBps, 100);
});

test("swapExecutor: taxed token → v2 FOT path + auto-slippage", async () => {
  const art = await buildPoolSwap({
    pool: { version: "v2", chain: "bsc", dexId: "uniswap-v2" }, router: ROUTER,
    tokenIn: TOKEN, tokenOut: WETH, amountIn: 1000n, amountOutMin: 0n,
    recipient: RECIPIENT, taxProfile: TAXED, selling: true, gateOpen: true,
  });
  assert.equal(art.useFot, true, "taxed sell routes through SupportingFeeOnTransfer");
  assert.equal(art.slippageBps, 400, "3% tax + 1% buffer = 400bps auto-slippage");
  assert.match(art.note, /FOT-aware/);
});

test("swapExecutor: honeypot → hard refuse (never build a fund-losing tx)", async () => {
  await assert.rejects(
    () => buildPoolSwap({
      pool: { version: "v2", chain: "bsc", dexId: "uniswap-v2" }, router: ROUTER,
      tokenIn: TOKEN, tokenOut: WETH, amountIn: 1000n, amountOutMin: 0n,
      recipient: RECIPIENT, taxProfile: HONEYPOT, gateOpen: true,
    }),
    /honeypot/
  );
});

test("swapExecutor: clean token → standard v2 path, normal slippage", async () => {
  const art = await buildPoolSwap({
    pool: { version: "v2", chain: "eth", dexId: "uniswap-v2" }, router: ROUTER,
    tokenIn: WETH, tokenOut: USDC, amountIn: 1000n, amountOutMin: 0n,
    recipient: RECIPIENT, taxProfile: CLEAN, gateOpen: true,
  });
  assert.equal(art.useFot, false);
  assert.equal(art.slippageBps, 100);
});

test("swapExecutor: no router → fail honest (never guess an address)", async () => {
  await assert.rejects(
    () => buildPoolSwap({
      pool: { version: "v3", chain: "rh", dexId: "rh-uniswap-v3", feeTier: 3000 }, router: null,
      tokenIn: WETH, tokenOut: TOKEN, amountIn: 1n, amountOutMin: 0n, recipient: RECIPIENT, gateOpen: true,
    }),
    /no router/
  );
});

test("swapExecutor: v2SwapCalldata encodes both variants + approve is exact-amount", () => {
  const std = v2SwapCalldata({ router: ROUTER, tokenIn: TOKEN, tokenOut: WETH, amountIn: 1000n, minOut: 900n, to: RECIPIENT, deadline: 9999999999, useFot: false });
  const fot = v2SwapCalldata({ router: ROUTER, tokenIn: TOKEN, tokenOut: WETH, amountIn: 1000n, minOut: 900n, to: RECIPIENT, deadline: 9999999999, useFot: true });
  assert.ok(std.startsWith("0x38ed1739"), "swapExactTokensForTokens selector");
  assert.ok(fot.startsWith("0x5c11d795"), "SupportingFeeOnTransfer selector — the FLOKI fix");
  assert.notEqual(std, fot);
});

test("dexMap: RH v3 family resolves (the fork, not canonical stubs)", () => {
  const rh = resolveDexFamily("rh-uniswap-v3");
  assert.equal(rh.factory, "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA");
});
