/**
 * engineDexDirect.test.js — the Phase-6 dexDirect engine tests: leg shapes,
 * the GUARDED execute boundary (DexDirectLiveTestGateError), quote/parse
 * unit checks per DEX, and the RoutePlanner fallback wiring. Pure/offline
 * (frozen fixtures — no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createUniswapSwapLeg,
  validateUniswapSwapRequest,
  UNISWAP_V3_QUOTER_V2,
} from "../src/engine/legs/dexDirect/uniswapSwapLeg.js";
import { createPancakeSwapSwapLeg } from "../src/engine/legs/dexDirect/pancakeswapSwapLeg.js";
import { createRaydiumSwapLeg } from "../src/engine/legs/dexDirect/raydiumSwapLeg.js";
import { createOrcaSwapLeg } from "../src/engine/legs/dexDirect/orcaSwapLeg.js";
import {
  DexDirectLiveTestGateError,
  DEX_DIRECT_LIVE_TEST_GATE_MESSAGE,
} from "../src/engine/legs/dexDirect/liveTestGate.js";
import {
  parseQuoterResponse,
  word,
  QUOTE_EXACT_INPUT_SINGLE_SELECTOR,
  EXACT_INPUT_SINGLE_SELECTOR,
} from "../src/engine/legs/dexDirect/evmV3.js";
import {
  buildEvmSteps,
  buildOrcaSteps,
  buildRaydiumSteps,
  evmInput,
  solInput,
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  SYNTHETIC_DEADLINE,
} from "./golden/dexDirectBuilders.mjs";
import { RoutePlanner } from "../src/engine/routePlanner.js";
import { createLeg, runLeg } from "../src/engine/legContract.js";

// ── the guarded execute boundary (every dexDirect leg) ─────────────────────
test("dexDirect: every execute leg is a GUARDED STUB that throws DexDirectLiveTestGateError", async () => {
  const legs = [createUniswapSwapLeg(), createPancakeSwapSwapLeg(), createRaydiumSwapLeg(), createOrcaSwapLeg()];
  for (const leg of legs) {
    assert.equal(typeof leg.phases.submit, "function", `${leg.id} defines submit`);
    await assert.rejects(
      leg.phases.submit(),
      (e) => {
        assert.ok(e instanceof DexDirectLiveTestGateError, `${leg.id} throws DexDirectLiveTestGateError (got ${e?.name})`);
        assert.match(e.message, /READY FOR LIVE ANCHOR/);
        assert.match(e.message, /dex-direct-execute: not wired for autonomous broadcast/);
        return true;
      },
      `${leg.id} submit must be gated`,
    );
  }
  assert.match(DEX_DIRECT_LIVE_TEST_GATE_MESSAGE, /READY FOR LIVE ANCHOR/);
});

// ── EVM legs ────────────────────────────────────────────────────────────────
test("dexDirect: uniswap leg builds the quoter request + guarded swap request from the frozen capture", async () => {
  const leg = createUniswapSwapLeg();
  const input = evmInput("uni-eth");
  const built = await leg.phases.build({
    chain: "eth",
    fromToken: "USDC",
    toToken: "USDT",
    amount: input.amountIn,
    fee: input.fee,
    recipient: EVM_ADDRESS,
    quoteHex: input.responseHex,
  });
  const a = built.artifact;
  assert.equal(a.quoteRequest.kind, "quoter-quoteExactInputSingle");
  assert.equal(a.quoteRequest.to, a.quoter.toLowerCase());
  assert.ok(BigInt(a.quote.amountOut) > 9_900_000n, `the frozen eth quote is a sane ~10 USDC amountOut (${a.quote.amountOut})`);
  assert.equal(a.quoteRequest.data.startsWith(QUOTE_EXACT_INPUT_SINGLE_SELECTOR), true);
  assert.equal(a.swapRequest.data.startsWith(EXACT_INPUT_SINGLE_SELECTOR), true);
  assert.match(a.liveStatus, /live anchor/);
  // the leg's parse of the frozen response == the canonical parse of the same bytes
  assert.equal(a.quote.amountOut, parseQuoterResponse(input.responseHex).amountOut);
});

test("dexDirect: uniswap leg rejects chains without a verified v3 deployment", async () => {
  const leg = createUniswapSwapLeg();
  await assert.rejects(leg.phases.build({ chain: "sonic", fromToken: "USDC", toToken: "USDT", amount: "10000000" }), /no canonical Uniswap v3 deployment verified/);
});

test("dexDirect: parseQuoterResponse decodes the 4-word quoter response", () => {
  const hex = "0x" + word("9997036") + word("79226673515401279992447579055") + word("1") + word("85000");
  const p = parseQuoterResponse(hex);
  assert.equal(p.amountOut, "9997036");
  assert.equal(p.initializedTicksCrossed, 1);
  assert.equal(p.gasEstimate, "85000");
  assert.throws(() => parseQuoterResponse("0x1234"), /unexpected response/);
});

test("dexDirect: pancakeswap leg serves bsc with the PCS deployment addresses", async () => {
  const leg = createPancakeSwapSwapLeg();
  const input = evmInput("pcs-bsc-f100");
  const built = await leg.phases.build({
    chain: "bsc",
    fromToken: "USDC",
    toToken: "USDT",
    amount: input.amountIn,
    fee: input.fee,
    recipient: EVM_ADDRESS,
    quoteHex: input.responseHex,
  });
  assert.equal(built.artifact.quoter, "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
  assert.ok(BigInt(built.artifact.quote.amountOut) > 9_900_000n, "the frozen bsc quote is a sane ~10 USDT amountOut");
  assert.equal(built.artifact.quote.amountOut, parseQuoterResponse(input.responseHex).amountOut);
  await assert.rejects(leg.phases.build({ chain: "eth", fromToken: "USDC", toToken: "USDT", amount: "10000000" }), /PancakeSwap v3 is deployed on bsc/);
});

// ── Solana legs (frozen snapshots — offline) ───────────────────────────────
test("dexDirect: orca leg quotes + builds the swap_v2 artifact from the frozen whirlpool snapshot", async () => {
  const leg = createOrcaSwapLeg();
  const snap = solInput("orca");
  const { step1, step2 } = buildOrcaSteps();
  const built = await leg.phases.build({
    snapshot: { whirlpool: snap.whirlpool, tickArrays: snap.tickArrays, tokenProgramA: snap.tokenProgramA, tokenProgramB: snap.tokenProgramB, oracle: snap.oracle },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.whirlpool.mintA,
    amountInRaw: snap.sample.amountInRaw,
    slippageBps: snap.sample.slippageBps,
  });
  assert.equal(built.artifact.quote.amountOutRaw, step1.artifact.amountOutRaw, "leg quote == frozen step1 quote");
  assert.equal(built.artifact.ix.discriminator, "2b04ed0b1ac91e62");
  assert.equal(built.artifact.ix.keys.length, 15);
  assert.equal(built.artifact.ix.keys[3].isSigner, true, "tokenAuthority (user) is the readonly signer");
  assert.equal(step2.artifact.ix.keys.length, 15);
  assert.equal(typeof built.artifact.pool, "string");
});

test("dexDirect: raydium clmm leg quotes + builds the swap_v2 artifact from the frozen snapshot", async () => {
  const leg = createRaydiumSwapLeg();
  const snap = solInput("raydiumClmm");
  const built = await leg.phases.build({
    dex: "clmm",
    snapshot: { pool: snap.pool, config: snap.config, pdas: snap.pdas, tickArrays: snap.tickArrays },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.pool.mintA,
    amountInRaw: snap.sample.amountInRaw,
    slippageBps: snap.sample.slippageBps,
  });
  assert.ok(BigInt(built.artifact.quote.amountOutRaw) > 0n);
  assert.equal(built.artifact.quote.amountOutRaw, snap.quote.amountOutRaw, "leg quote == captured quote");
  assert.equal(built.artifact.ix.discriminator, "2b04ed0b1ac91e62");
  // keys: payer, config, pool, 2 owner, 2 vault, observation, 3 programs, 2 mints, bitmap ext, 4 tick arrays
  assert.ok(built.artifact.ix.keys.length >= 18, `clmm ix has the full key set (${built.artifact.ix.keys.length})`);
});

test("dexDirect: raydium cpmm leg quotes + builds the swap_base_input artifact from the frozen snapshot", async () => {
  const leg = createRaydiumSwapLeg();
  const snap = solInput("raydiumCpmm");
  const built = await leg.phases.build({
    dex: "cpmm",
    snapshot: { pool: snap.pool, config: snap.config, authority: snap.authority, vaultA: snap.vaultA, vaultB: snap.vaultB },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.sample.inputMint,
    amountInRaw: snap.sample.amountInRaw,
    slippageBps: snap.sample.slippageBps,
  });
  assert.equal(built.artifact.quote.outRaw, snap.quote.outRaw, "leg quote == captured quote");
  assert.equal(built.artifact.ix.discriminator, "8fbe5adac41e33de");
  assert.equal(built.artifact.ix.keys.length, 13, "13 metas — the CPMM swap_base_input layout");
  assert.equal(built.artifact.ix.keys[1].pubkey, snap.authority, "the vault authority PDA rides at key 1");
});

// ── RoutePlanner fallback wiring ────────────────────────────────────────────
test("dexDirect: RoutePlanner plans the four dexDirect routes", () => {
  const uniswap = RoutePlanner.planDexDirect({ dex: "uniswap" });
  assert.equal(uniswap.id, "swap-eth-eth-dexdirect-uniswap");
  assert.equal(uniswap.legs[0].id, "uniswap-swap");
  assert.equal(RoutePlanner.planDexDirect({ dex: "pancakeswap" }).id, "swap-bsc-bsc-dexdirect-pancakeswap");
  assert.equal(RoutePlanner.planDexDirect({ dex: "orca" }).sourceChain, "sol");
  assert.equal(RoutePlanner.planDexDirect({ dex: "raydium" }).sourceChain, "sol");
  assert.throws(() => RoutePlanner.planDexDirect({ dex: "nope" }), /unknown dex/);
  // plan({direction:"swap", via:"dexDirect"}) dispatches
  assert.equal(RoutePlanner.plan({ direction: "swap", via: "dexDirect", dex: "orca" }).id, "swap-sol-sol-dexdirect-orca");
  // default routing unchanged (unknown via → null, aggregator vias unchanged)
  assert.equal(RoutePlanner.plan({ direction: "swap", via: "jupiter" }).id, "swap-sol-sol-jupiter");
  assert.equal(RoutePlanner.plan({ direction: "swap", via: "lifi" }).id, "swap-eth-eth-lifi");
  assert.equal(RoutePlanner.plan({ direction: "swap", via: "madeup" }), null);
});

test("dexDirect: the fallback registry keeps aggregators first and direct legs as candidates", () => {
  assert.deepEqual([...RoutePlanner.DEX_DIRECT_FALLBACKS.evm.eth], ["lifi", "uniswap"]);
  assert.deepEqual([...RoutePlanner.DEX_DIRECT_FALLBACKS.evm.bsc], ["lifi", "pancakeswap"]);
  assert.deepEqual([...RoutePlanner.DEX_DIRECT_FALLBACKS.svm.sol], ["jupiter", "orca", "raydium"]);
  assert.equal(RoutePlanner.DEX_DIRECT_DEFAULT_DEX.bsc, "pancakeswap");
  assert.equal(RoutePlanner.DEX_DIRECT_DEFAULT_DEX.sol, "orca");
});

// ── the legs run through the generic LegContract runner (build gate) ───────
test("dexDirect: runLeg drives build and the guarded submit throws through the runner", async () => {
  const uniswap = createUniswapSwapLeg();
  const input = evmInput("uni-eth");
  await assert.rejects(
    runLeg(uniswap, {
      chain: "eth",
      fromToken: "USDC",
      toToken: "USDT",
      amount: input.amountIn,
      fee: input.fee,
      recipient: EVM_ADDRESS,
      quoteHex: input.responseHex,
    }),
    (e) => {
      assert.ok(e instanceof DexDirectLiveTestGateError, `the gate error propagates (got ${e?.name})`);
      return true;
    },
    "runLeg must propagate the DexDirectLiveTestGateError from submit",
  );
});

test("dexDirect: createLeg contract shape is respected by the four legs", () => {
  for (const leg of [createUniswapSwapLeg(), createPancakeSwapSwapLeg(), createRaydiumSwapLeg(), createOrcaSwapLeg()]) {
    assert.ok(leg.id.endsWith("-swap"));
    assert.ok(["evm", "svm"].includes(leg.family));
    assert.equal(typeof leg.phases.build, "function");
    assert.equal(typeof leg.phases.submit, "function");
  }
});

// ── skill cross-check (official Uniswap swap-integration skill v1.5.0) ────
// The pre-broadcast validator (skill's validation discipline adapted to the
// direct SwapRouter periphery path) + the wire-level guards this review
// added. See the uniswapSwapLeg.js header for the full comparison notes.

test("dexDirect: the deprecated Universal Router v1 export is gone (skill: 0x3fC91A3a… is deprecated; UR is per-chain)", async () => {
  const uniModule = await import("../src/engine/legs/dexDirect/uniswapSwapLeg.js");
  assert.equal("UNISWAP_UNIVERSAL_ROUTER" in uniModule, false, "the deprecated UR v1 constant must not be exported");
  // the canonical constants the leg actually targets stay
  assert.equal(uniModule.UNISWAP_V3_SWAP_ROUTER, "0xE592427A0AEce92De3Edee1F18E0157C05861564");
  assert.equal(typeof uniModule.validateUniswapSwapRequest, "function");
});

test("dexDirect: validateUniswapSwapRequest accepts the frozen quote-pinned swap request (router/calldata/min-out/deadline)", async () => {
  const input = evmInput("uni-eth");
  const leg = createUniswapSwapLeg();
  const built = await leg.phases.build({
    chain: "eth",
    fromToken: "USDC",
    toToken: "USDT",
    amount: input.amountIn,
    fee: input.fee,
    recipient: EVM_ADDRESS,
    deadline: SYNTHETIC_DEADLINE,
    quoteHex: input.responseHex,
  });
  const res = validateUniswapSwapRequest(built.artifact.swapRequest);
  assert.deepEqual(res, { ok: true });
});

test("dexDirect: validateUniswapSwapRequest rejects wire hazards a live anchor must never sign", async () => {
  const input = evmInput("uni-eth");
  const leg = createUniswapSwapLeg();
  const built = await leg.phases.build({
    chain: "eth",
    fromToken: "USDC",
    toToken: "USDT",
    amount: input.amountIn,
    fee: input.fee,
    recipient: EVM_ADDRESS,
    deadline: SYNTHETIC_DEADLINE,
    quoteHex: input.responseHex,
  });
  const { swapRequest } = built.artifact;
  // wrong router target (e.g. the quoter, or a deprecated UR) — must refuse
  assert.throws(() => validateUniswapSwapRequest({ ...swapRequest, to: UNISWAP_V3_QUOTER_V2 }), /canonical SwapRouter/);
  // truncated calldata — must refuse
  assert.throws(() => validateUniswapSwapRequest({ ...swapRequest, data: swapRequest.data.slice(0, -64) }), /expected 260 bytes/);
  // a pre-quote request (min-out 0 placeholder) — must refuse
  const preQuote = await leg.phases.build({
    chain: "eth",
    fromToken: "USDC",
    toToken: "USDT",
    amount: input.amountIn,
    fee: input.fee,
    recipient: EVM_ADDRESS,
    deadline: SYNTHETIC_DEADLINE,
  });
  assert.throws(() => validateUniswapSwapRequest(preQuote.artifact.swapRequest), /no quote has landed/);
  // stale deadline (fixture default 2030 vs an enforced now+30m AFTER 2030) — must refuse
  assert.throws(
    () => validateUniswapSwapRequest(swapRequest, { minDeadline: SYNTHETIC_DEADLINE + 1 }),
    /fresh deadline/,
  );
  // wrong kind — must refuse
  assert.throws(() => validateUniswapSwapRequest({ ...swapRequest, kind: "quoter-quoteExactInputSingle" }), /not an exactInputSingle request/);
});

test("dexDirect: quote-pinned swap requests without a recipient are refused (never shape a burn-recipient swap)", async () => {
  const uniInput = evmInput("uni-eth");
  const uniModule = await import("../src/engine/legs/dexDirect/uniswapSwapLeg.js");
  assert.throws(
    () =>
      uniModule.shapeUniswapSwapArtifact({
        chain: "eth",
        fromSymbol: "USDC",
        toSymbol: "USDT",
        amount: uniInput.amountIn,
        fee: uniInput.fee,
        quoteHex: uniInput.responseHex,
      }),
    /zero address/,
  );
  const pcsInput = evmInput("pcs-bsc-f100");
  const pcsModule = await import("../src/engine/legs/dexDirect/pancakeswapSwapLeg.js");
  assert.throws(
    () =>
      pcsModule.shapePancakeSwapArtifact({
        chain: "bsc",
        fromSymbol: "USDC",
        toSymbol: "USDT",
        amount: pcsInput.amountIn,
        fee: pcsInput.fee,
        quoteHex: pcsInput.responseHex,
      }),
    /zero address/,
  );
  // construction-only shape (no quote, no recipient) still emits NO swap request — the capture path
  const art = uniModule.shapeUniswapSwapArtifact({
    chain: "eth",
    fromSymbol: "USDC",
    toSymbol: "USDT",
    amount: uniInput.amountIn,
    fee: uniInput.fee,
  });
  assert.equal(art.swapRequest, undefined);
  assert.equal(art.quote, undefined);
});
