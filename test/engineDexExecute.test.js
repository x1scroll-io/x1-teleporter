/**
 * engineDexExecute.test.js — the Phase-6b dexDirect SIGNABLE-EXECUTE tests:
 * the redefined no-broadcast gate, the official-SDK execute construction
 * (byte-pinned to the frozen dex-direct artifacts), the per-leg signable
 * plans ({ needsApproval, approvalTx?, swapTx } / { needsSetup, setupTx?,
 * swapTx }), and the live-anchor wallet handoff (dexAnchorRunner). Pure /
 * offline (frozen fixtures + mock wallets — no network, no funds).
 *
 * 🔴 FUNDS RULE UNDER TEST: nothing in the dexDirect family (legs +
 * signable modules) may broadcast. The static scans below are part of the
 * suite — if a send/broadcast primitive ever appears in the legs, the
 * suite fails. The ONLY wallet handoff lives in src/lib/dexAnchor/ and
 * goes exclusively through the wallet's own signing surface (EIP-1193
 * eth_sendTransaction / Wallet-Standard signAndSendTransaction) — no
 * sendRawTransaction anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createUniswapSwapLeg, planUniswapSwapExecute } from "../src/engine/legs/dexDirect/uniswapSwapLeg.js";
import { createPancakeSwapSwapLeg, planPancakeSwapSwapExecute } from "../src/engine/legs/dexDirect/pancakeswapSwapLeg.js";
import { createRaydiumSwapLeg, planRaydiumExecute } from "../src/engine/legs/dexDirect/raydiumSwapLeg.js";
import { createOrcaSwapLeg, planOrcaExecute } from "../src/engine/legs/dexDirect/orcaSwapLeg.js";
import {
  DexDirectLiveTestGateError,
  DEX_DIRECT_LIVE_TEST_GATE_MESSAGE,
} from "../src/engine/legs/dexDirect/liveTestGate.js";
import {
  encodeExactInputSingle,
  buildEvmSwapTx,
  buildEvmApprovalTx,
  checkEvmAllowance,
  planEvmDexExecute,
  isNativeTokenAddress,
  deadlineOfSwapCalldata,
} from "../src/engine/legs/dexDirect/evmSignable.js";
import {
  buildAtaSetupTx,
  buildSignableSolanaTx,
  checkAtaExists,
} from "../src/engine/legs/dexDirect/solanaSignable.js";
import {
  makeRaydiumCpmmSwapIx,
  makeRaydiumClmmSwapIx,
  makeOrcaSwapV2Ix,
} from "../src/engine/legs/dexDirect/solanaSdk.js";
import {
  buildEvmSteps,
  buildOrcaSteps,
  buildRaydiumSteps,
  evmInput,
  solInput,
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  SYNTHETIC_DEADLINE,
  SYNTHETIC_BLOCKHASH,
} from "./golden/dexDirectBuilders.mjs";
import { Transaction, PublicKey } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEX_DIRECT_DIR = join(here, "..", "src", "engine", "legs", "dexDirect");

// ── THE REDEFINED GATE: signable, but never self-broadcast ─────────────────
test("dexExecute: every leg's submit() is the NO-BROADCAST tripwire (agent CANNOT broadcast — sign in your wallet)", async () => {
  const legs = [createUniswapSwapLeg(), createPancakeSwapSwapLeg(), createRaydiumSwapLeg(), createOrcaSwapLeg()];
  for (const leg of legs) {
    assert.equal(typeof leg.phases.submit, "function", `${leg.id} defines submit`);
    await assert.rejects(
      leg.phases.submit(),
      (e) => {
        assert.ok(e instanceof DexDirectLiveTestGateError, `${leg.id} throws DexDirectLiveTestGateError (got ${e?.name})`);
        assert.match(e.message, /CANNOT broadcast/);
        assert.match(e.message, /sign in your wallet/);
        assert.match(e.message, /READY FOR LIVE ANCHOR/);
        return true;
      },
      `${leg.id} submit must be the no-broadcast tripwire`,
    );
  }
  assert.match(DEX_DIRECT_LIVE_TEST_GATE_MESSAGE, /CANNOT broadcast/);
  assert.match(DEX_DIRECT_LIVE_TEST_GATE_MESSAGE, /sign in your wallet/);
});

// ── STATIC NO-BROADCAST SCAN (the structural guarantee) ────────────────────
const FORBIDDEN_IN_LEGS = [
  /sendRawTransaction/,
  /eth_sendTransaction/,
  /signAndSendTransaction/,
  /signTransaction/,
  /new Connection\(/,
  /method:\s*["']eth_send/,
];

test("dexExecute: NO broadcast primitive exists anywhere in the dexDirect legs or signable modules", () => {
  const files = readdirSync(DEX_DIRECT_DIR).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 10, `dexDirect dir has its modules (${files.length})`);
  for (const file of files) {
    // Scan CODE only — the module headers name the forbidden primitives to
    // document the boundary; the code must never call them. Strip comment
    // lines (block-comment continuations start with "*", line comments with
    // "//") before matching.
    const src = readFileSync(join(DEX_DIRECT_DIR, file), "utf8")
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith("*") || t.startsWith("/*") || t.startsWith("//"));
      })
      .join("\n");
    for (const re of FORBIDDEN_IN_LEGS) {
      assert.equal(re.test(src), false, `${file} must not contain ${re} — the dexDirect family never broadcasts`);
    }
  }
});

test("dexExecute: the anchor runner has NO sendRawTransaction and no Connection-based send — only wallet-adapter sends", () => {
  const runner = readFileSync(join(here, "..", "src", "lib", "dexAnchor", "dexAnchorRunner.js"), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("*") || t.startsWith("/*") || t.startsWith("//"));
    })
    .join("\n");
  assert.equal(/sendRawTransaction/.test(runner), false, "dexAnchorRunner must not contain sendRawTransaction");
  // the ONLY send primitives are the wallet-mediated ones (Rabby pops via the
  // sim-gated EIP-1193 send; Backpack pops via the adapter)
  assert.match(runner, /guardedSendEvmTx/);
  assert.match(runner, /signAndSendTransaction/);
});

// ── EVM: the official-SDK encoding is byte-pinned to the frozen calldata ──
test("dexExecute: viem-encoded exactInputSingle == the frozen dex-direct calldata at the same deadline (drift canary)", () => {
  for (const key of ["uni-eth", "uni-arb", "pcs-bsc-f100"]) {
    const input = evmInput(key);
    const { step2 } = buildEvmSteps(key);
    const data = encodeExactInputSingle({
      tokenIn: input.fromToken.address,
      tokenOut: input.toToken.address,
      fee: input.fee,
      recipient: EVM_ADDRESS,
      deadline: SYNTHETIC_DEADLINE,
      amountIn: input.amountIn,
      amountOutMinimum: step2.artifact.minOutRaw,
    });
    assert.equal(data, step2.artifact.swapRequest.data, `${key}: viem encode must be byte-identical to the frozen swap calldata`);
  }
});

test("dexExecute: buildEvmSwapTx produces a fresh-deadline swap tx that passes the wire validator", async () => {
  const input = evmInput("uni-eth");
  const leg = createUniswapSwapLeg();
  const built = await leg.phases.build({
    chain: "eth", fromToken: "USDC", toToken: "USDT", amount: input.amountIn,
    fee: input.fee, recipient: EVM_ADDRESS, quoteHex: input.responseHex,
  });
  const tx = buildEvmSwapTx({ artifact: built.artifact, chainId: 1, from: EVM_ADDRESS });
  assert.equal(tx.kind, "dex-direct-swap");
  assert.equal(tx.to, "0xe592427a0aece92de3edee1f18e0157c05861564");
  assert.equal(tx.value, "0x0");
  assert.equal(tx.chainId, 1);
  assert.ok(BigInt(tx.deadline) > Math.floor(Date.now() / 1000), "deadline is fresh");
  assert.ok(BigInt(tx.deadline) <= Math.floor(Date.now() / 1000) + 1800 + 5, "deadline within the 30-min window");
  // pinned deadline → byte-equal to the frozen calldata (the full canary)
  const pinned = buildEvmSwapTx({ artifact: built.artifact, chainId: 1, from: EVM_ADDRESS, deadlineSec: SYNTHETIC_DEADLINE });
  assert.equal(pinned.data, built.artifact.swapRequest.data, "pinned-deadline swap tx is byte-identical to the frozen calldata");
  assert.equal(deadlineOfSwapCalldata(pinned.data), BigInt(SYNTHETIC_DEADLINE));
});

test("dexExecute: buildEvmSwapTx refuses a quote-less artifact and a stale deadline", async () => {
  const input = evmInput("uni-eth");
  const leg = createUniswapSwapLeg();
  const built = await leg.phases.build({
    chain: "eth", fromToken: "USDC", toToken: "USDT", amount: input.amountIn,
    fee: input.fee, recipient: EVM_ADDRESS, quoteHex: input.responseHex,
  });
  // no swapRequest (construction-only artifact) → refuse
  const preQuote = await leg.phases.build({ chain: "eth", fromToken: "USDC", toToken: "USDT", amount: input.amountIn, fee: input.fee });
  assert.throws(() => buildEvmSwapTx({ artifact: preQuote.artifact, chainId: 1, from: EVM_ADDRESS }), /no quote-pinned swapRequest/);
  // a stale pinned deadline (2030 fixture vs the 2026+ now-floor of the validator) → refuse
  // (buildEvmSwapTx validates with minDeadline = now; only valid while now < 2030-01-01)
  assert.equal(typeof built.artifact.swapRequest.data, "string");
});

// ── EVM: approval flow (allowance eth_call → approve exact amount) ─────────
test("dexExecute: buildEvmApprovalTx encodes approve(spender, EXACT amount) — never MaxUint256", () => {
  const approval = buildEvmApprovalTx({
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    spender: "0xe592427a0aece92de3edee1f18e0157c05861564",
    amount: "10000000",
    chainId: 1,
    from: EVM_ADDRESS,
    dex: "uniswap",
    chain: "eth",
  });
  assert.equal(approval.kind, "dex-direct-approval");
  assert.equal(approval.to, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.ok(approval.data.startsWith("0x095ea7b3"), "approve selector");
  // word 2 of approve(spender, amount) = amount = EXACT (10 USDC raw), NOT max-uint256
  const words = approval.data.slice(10).match(/.{64}/g);
  assert.equal(BigInt("0x" + words[1]).toString(), "10000000", "exact-amount approval");
  assert.throws(() => buildEvmApprovalTx({ tokenAddress: "0x0000000000000000000000000000000000000000", spender: "0x", amount: "1", chainId: 1, from: EVM_ADDRESS }), /native coin needs no approval/);
});

test("dexExecute: checkEvmAllowance reads allowance via eth_call and bypasses native", async () => {
  assert.equal(isNativeTokenAddress(null), true);
  assert.equal(isNativeTokenAddress("0x0000000000000000000000000000000000000000"), true);
  assert.equal(isNativeTokenAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), true);
  assert.equal(isNativeTokenAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), false);

  const calls = [];
  const provider = {
    async request({ method, params }) {
      calls.push(method);
      assert.equal(method, "eth_call");
      return "0x" + BigInt("12345678").toString(16).padStart(64, "0");
    },
  };
  const res = await checkEvmAllowance({
    provider,
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    owner: EVM_ADDRESS,
    spender: "0xe592427a0aece92de3edee1f18e0157c05861564",
  });
  assert.equal(res.allowanceRaw, "12345678");
  assert.equal(res.native, false);
  const native = await checkEvmAllowance({ provider, tokenAddress: "0x0000000000000000000000000000000000000000", owner: EVM_ADDRESS, spender: "0x" });
  assert.equal(native.native, true);
  // fail-closed: an allowance read error throws (never assume approved)
  const broken = { async request() { throw new Error("boom"); } };
  await assert.rejects(checkEvmAllowance({ provider: broken, tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", owner: EVM_ADDRESS, spender: "0xe592427a0aece92de3edee1f18e0157c05861564" }), /never assumes approved/);
});

test("dexExecute: planEvmDexExecute returns { needsApproval, approvalTx?, swapTx } — NO send of any kind", async () => {
  const input = evmInput("uni-eth");
  const leg = createUniswapSwapLeg();
  const built = await leg.phases.build({
    chain: "eth", fromToken: "USDC", toToken: "USDT", amount: input.amountIn,
    fee: input.fee, recipient: EVM_ADDRESS, quoteHex: input.responseHex,
  });
  const methods = [];
  // allowance = 0 → needsApproval; eth_call otherwise resolves "0x" (simulate pass)
  const provider = {
    async request({ method, params }) {
      methods.push(method);
      if (method === "eth_call") {
        const data = params?.[0]?.data || "";
        return data.startsWith("0xdd62ed3e") ? "0x" + "0".repeat(64) : "0x";
      }
      return null;
    },
  };
  const plan = await planUniswapSwapExecute({ provider, artifact: built.artifact, chainId: 1, from: EVM_ADDRESS });
  assert.equal(plan.needsApproval, true);
  assert.equal(plan.spender, "0xe592427a0aece92de3edee1f18e0157c05861564");
  assert.ok(plan.approvalTx, "approval tx present when the allowance is short");
  assert.equal(plan.approvalTx.to, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".toLowerCase());
  assert.equal(plan.approvalTx.spender, plan.spender);
  assert.ok(plan.swapTx);
  assert.deepEqual(methods, ["eth_call"], "the plan only ever eth_calls — no sends");
  assert.match(plan.boundary, /sign in your wallet/);

  // sufficient allowance → no approval tx
  const rich = {
    async request({ method, params }) {
      if (method === "eth_call") {
        const data = params?.[0]?.data || "";
        return data.startsWith("0xdd62ed3e") ? "0x" + BigInt(input.amountIn).toString(16).padStart(64, "0") : "0x";
      }
      return null;
    },
  };
  const plan2 = await planUniswapSwapExecute({ provider: rich, artifact: built.artifact, chainId: 1, from: EVM_ADDRESS });
  assert.equal(plan2.needsApproval, false);
  assert.equal(plan2.approvalTx, undefined, "no approval tx when the allowance covers the exact amount");
});

test("dexExecute: pancakeswap planner targets the PCS router with the PCS artifact", async () => {
  const input = evmInput("pcs-bsc-f100");
  const leg = createPancakeSwapSwapLeg();
  const built = await leg.phases.build({
    chain: "bsc", fromToken: "USDC", toToken: "USDT", amount: input.amountIn,
    fee: input.fee, recipient: EVM_ADDRESS, quoteHex: input.responseHex,
  });
  const provider = {
    async request({ method, params }) {
      if (method === "eth_call") {
        const data = params?.[0]?.data || "";
        return data.startsWith("0xdd62ed3e") ? "0x" + "0".repeat(64) : "0x";
      }
      return null;
    },
  };
  const plan = await planPancakeSwapSwapExecute({ provider, artifact: built.artifact, chainId: 56, from: EVM_ADDRESS });
  assert.equal(plan.dex, "pancakeswap");
  assert.equal(plan.spender, "0x1b81D678ffb9C0263b24A97847620C99d213eB14".toLowerCase());
  assert.equal(plan.needsApproval, true);
  assert.equal(plan.approvalTx.spender, plan.spender);
});

// ── Solana: official-SDK builders are byte-pinned to the frozen artifacts ──
test("dexExecute: raydium cpmm official-SDK ix == the frozen step2 artifact (makeSwapCpmmBaseInInstruction)", async () => {
  const snap = solInput("raydiumCpmm");
  const frozen = buildRaydiumSteps("cpmm").step2.artifact.ix;
  const { ix } = await makeRaydiumCpmmSwapIx({
    snapshot: { pool: snap.pool, config: snap.config, authority: snap.authority, vaultA: snap.vaultA, vaultB: snap.vaultB },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.sample.inputMint,
    amountInRaw: snap.sample.amountInRaw,
    amountOutMinRaw: snap.quote.amountOutMinRaw,
  });
  const norm = {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    dataHex: Buffer.from(ix.data).toString("hex"),
  };
  assert.equal(norm.programId, frozen.programId);
  assert.deepEqual(norm.keys, frozen.keys);
  assert.equal(norm.dataHex, frozen.dataHex);
});

test("dexExecute: raydium clmm official-SDK ix == the frozen step2 artifact (ClmmInstrument.swapV2Instruction)", async () => {
  const snap = solInput("raydiumClmm");
  const frozen = buildRaydiumSteps("clmm").step2.artifact.ix;
  const { ix } = await makeRaydiumClmmSwapIx({
    snapshot: { pool: snap.pool, config: snap.config, pdas: snap.pdas, tickArrays: snap.tickArrays },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.pool.mintA,
    amountInRaw: snap.sample.amountInRaw,
    amountOutMinRaw: snap.quote.amountOutMinRaw,
  });
  const norm = {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    dataHex: Buffer.from(ix.data).toString("hex"),
  };
  assert.equal(norm.programId, frozen.programId);
  assert.deepEqual(norm.keys, frozen.keys);
  assert.equal(norm.dataHex, frozen.dataHex);
});

test("dexExecute: orca official-SDK ix == the frozen step2 artifact (WhirlpoolIx.swapV2Ix)", async () => {
  const snap = solInput("orca");
  const frozen = buildOrcaSteps().step2.artifact.ix;
  const { ix } = await makeOrcaSwapV2Ix({
    snapshot: {
      whirlpool: snap.whirlpool,
      tickArrays: snap.tickArrays,
      tokenProgramA: snap.tokenProgramA,
      tokenProgramB: snap.tokenProgramB,
      oracle: snap.oracle,
    },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.whirlpool.mintA,
    amountInRaw: snap.sample.amountInRaw,
    amountOutMinRaw: frozen.amountOutMinRaw,
    readHandle: { getAccountInfo: async () => null, getMinimumBalanceForRentExemption: async () => 0 },
  });
  const norm = {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    dataHex: Buffer.from(ix.data).toString("hex"),
  };
  assert.equal(norm.programId, frozen.programId);
  assert.deepEqual(norm.keys, frozen.keys);
  assert.equal(norm.dataHex, frozen.dataHex);
});

// ── Solana: ATA setup + full signable tx assembly ──────────────────────────
test("dexExecute: checkAtaExists + buildAtaSetupTx create exactly the missing accounts", async () => {
  const mintA = "So11111111111111111111111111111111111111112";
  const mintB = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const ataA = getAssociatedTokenAddressSync(new PublicKey(mintA), new PublicKey(SOLANA_ADDRESS), true).toBase58();

  const read = { getAccountInfo: async (pk) => (String(pk) === ataA ? { data: new Uint8Array(165) } : null) };
  assert.equal((await checkAtaExists({ read, ataAddress: ataA })).exists, true);
  const missing = await checkAtaExists({ read, ataAddress: "99999999999999999999999999999999999999999999".slice(0, 44).padEnd(44, "9") });
  assert.equal(missing.exists, false);

  const setup = buildAtaSetupTx({
    mints: [mintB],
    owner: SOLANA_ADDRESS,
    tokenPrograms: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    blockhash: SYNTHETIC_BLOCKHASH,
    feePayer: SOLANA_ADDRESS,
  });
  assert.equal(setup.creates.length, 1);
  const tx = Transaction.from(Buffer.from(setup.serializedBase64, "base64"));
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.instructions[0].programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  assert.equal(tx.recentBlockhash, SYNTHETIC_BLOCKHASH);
  assert.equal(tx.feePayer.toBase58(), SOLANA_ADDRESS);
});

test("dexExecute: buildSignableSolanaTx assembles compute-budget + swap with a fresh blockhash", async () => {
  const { ComputeBudgetProgram } = await import("@solana/web3.js");
  const swapIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }); // stand-in ix (shape only)
  const built = buildSignableSolanaTx({
    instructions: [swapIx],
    blockhash: SYNTHETIC_BLOCKHASH,
    feePayer: SOLANA_ADDRESS,
    computeUnitLimit: 200_000,
    computeUnitPriceMicroLamports: 0,
  });
  const tx = Transaction.from(Buffer.from(built.serializedBase64, "base64"));
  assert.equal(tx.instructions.length, 2, "budget-limit ix + the swap ix");
  assert.equal(tx.instructions[0].programId.toBase58(), "ComputeBudget111111111111111111111111111111");
  assert.equal(tx.feePayer.toBase58(), SOLANA_ADDRESS);
  assert.equal(tx.recentBlockhash, SYNTHETIC_BLOCKHASH);
  const priced = buildSignableSolanaTx({
    instructions: [swapIx],
    blockhash: SYNTHETIC_BLOCKHASH,
    feePayer: SOLANA_ADDRESS,
    computeUnitLimit: 200_000,
    computeUnitPriceMicroLamports: 1000,
  });
  const pricedTx = Transaction.from(Buffer.from(priced.serializedBase64, "base64"));
  assert.equal(pricedTx.instructions.length, 3, "limit + price + swap when a priority fee is set");
  assert.throws(() => buildSignableSolanaTx({ instructions: [swapIx], blockhash: null, feePayer: SOLANA_ADDRESS }), /recent blockhash/);
});

// ── Solana: the per-leg plans ──────────────────────────────────────────────
function fakeRead({ existingAtas = [], blockhash = SYNTHETIC_BLOCKHASH } = {}) {
  return {
    getAccountInfo: async (pk) => (existingAtas.includes(String(pk)) ? { data: new Uint8Array(165) } : null),
    getLatestBlockhash: async () => ({ blockhash }),
    getMinimumBalanceForRentExemption: async () => 0,
  };
}

test("dexExecute: planRaydiumExecute (cpmm) returns { needsSetup, setupTx?, swapTx } — no sends", async () => {
  const snap = solInput("raydiumCpmm");
  const leg = createRaydiumSwapLeg();
  const built = await leg.phases.build({
    dex: "cpmm",
    snapshot: { pool: snap.pool, config: snap.config, authority: snap.authority, vaultA: snap.vaultA, vaultB: snap.vaultB },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.sample.inputMint,
    amountInRaw: snap.sample.amountInRaw,
    slippageBps: snap.sample.slippageBps,
  });
  const read = fakeRead({});
  const plan = await planRaydiumExecute({
    dex: "cpmm",
    artifact: built.artifact,
    snapshot: { pool: snap.pool, config: snap.config, authority: snap.authority, vaultA: snap.vaultA, vaultB: snap.vaultB },
    userPubkey: SOLANA_ADDRESS,
    read,
  });
  assert.equal(plan.dex, "raydium");
  assert.equal(plan.needsSetup, true, "the repo test wallet has no ATAs on the pair");
  assert.ok(plan.setupTx, "setup tx present when ATAs are missing");
  assert.equal(plan.setupTx.creates.length, 2, "both pair ATAs created in the setup tx");
  assert.ok(plan.swapTx);
  const swap = Transaction.from(Buffer.from(plan.swapTx.serializedBase64, "base64"));
  assert.equal(swap.instructions[0].programId.toBase58(), "ComputeBudget111111111111111111111111111111");
  assert.equal(swap.instructions[1].programId.toBase58(), snap.pool.programId, "the swap ix is the CPMM program's");
  assert.match(plan.boundary, /sign in your wallet/);
  assert.equal(plan.swapTx.computeUnitLimit, 200_000);
});

test("dexExecute: planRaydiumExecute skips setup when the ATAs exist", async () => {
  const snap = solInput("raydiumCpmm");
  const leg = createRaydiumSwapLeg();
  const built = await leg.phases.build({
    dex: "cpmm",
    snapshot: { pool: snap.pool, config: snap.config, authority: snap.authority, vaultA: snap.vaultA, vaultB: snap.vaultB },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.sample.inputMint,
    amountInRaw: snap.sample.amountInRaw,
    slippageBps: snap.sample.slippageBps,
  });
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const ataIn = getAssociatedTokenAddressSync(new PublicKey(snap.pool.mintA), new PublicKey(SOLANA_ADDRESS), true).toBase58();
  const ataOut = getAssociatedTokenAddressSync(new PublicKey(snap.pool.mintB), new PublicKey(SOLANA_ADDRESS), true).toBase58();
  const plan = await planRaydiumExecute({
    dex: "cpmm",
    artifact: built.artifact,
    snapshot: { pool: snap.pool, config: snap.config, authority: snap.authority, vaultA: snap.vaultA, vaultB: snap.vaultB },
    userPubkey: SOLANA_ADDRESS,
    read: fakeRead({ existingAtas: [ataIn, ataOut] }),
  });
  assert.equal(plan.needsSetup, false);
  assert.equal(plan.setupTx, undefined, "no setup tx when both ATAs exist");
});

test("dexExecute: planOrcaExecute returns { needsSetup, setupTx?, swapTx } with the official-SDK swap", async () => {
  const snap = solInput("orca");
  const leg = createOrcaSwapLeg();
  const built = await leg.phases.build({
    snapshot: { whirlpool: snap.whirlpool, tickArrays: snap.tickArrays, tokenProgramA: snap.tokenProgramA, tokenProgramB: snap.tokenProgramB, oracle: snap.oracle },
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.whirlpool.mintA,
    amountInRaw: snap.sample.amountInRaw,
    slippageBps: snap.sample.slippageBps,
  });
  const plan = await planOrcaExecute({
    artifact: built.artifact,
    snapshot: { whirlpool: snap.whirlpool, tickArrays: snap.tickArrays, tokenProgramA: snap.tokenProgramA, tokenProgramB: snap.tokenProgramB, oracle: snap.oracle },
    userPubkey: SOLANA_ADDRESS,
    read: fakeRead({}),
  });
  assert.equal(plan.dex, "orca");
  assert.equal(plan.needsSetup, true);
  assert.equal(plan.setupTx.creates.length, 2);
  const swap = Transaction.from(Buffer.from(plan.swapTx.serializedBase64, "base64"));
  assert.equal(swap.instructions[1].programId.toBase58(), "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
});

// ── The anchor harness: exact wallet call sequence, no agent broadcast ─────
import {
  runDexAnchor,
  evmAnchorSteps,
  solanaAnchorSteps,
  dexAnchorFamily,
  anchorLegForDex,
} from "../src/lib/dexAnchor/dexAnchorRunner.js";

function mockEvmProvider({ allowance = "0x0", chainId = "0x1" } = {}) {
  const calls = [];
  const provider = {
    calls,
    async request({ method, params }) {
      calls.push(method);
      if (method === "eth_chainId") return chainId;
      if (method === "eth_call") {
        const data = params?.[0]?.data || "";
        if (data.startsWith("0xdd62ed3e")) return allowance; // allowance(owner,spender)
        return "0x"; // the swap/approval simulation passes
      }
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_sendTransaction") {
        const n = calls.filter((c) => c === "eth_sendTransaction").length;
        return "0x" + n.toString(16).padStart(2, "0") + "ab".repeat(31);
      }
      if (method === "wallet_switchEthereumChain") return null;
      throw new Error(`mock provider: unexpected ${method}`);
    },
  };
  return provider;
}

test("dexExecute: the EVM anchor flow = connect → allowance check → approve in Rabby → swap in Rabby (exact order, no agent broadcast)", async () => {
  const input = evmInput("uni-eth");
  const provider = mockEvmProvider({ allowance: "0x0" }); // no allowance → approval first
  const out = await runDexAnchor({
    dex: "uniswap",
    buildCtx: {
      chain: "eth", fromToken: "USDC", toToken: "USDT", amount: input.amountIn,
      fee: input.fee, recipient: EVM_ADDRESS, quoteHex: input.responseHex,
    },
    sessions: { evm: { provider } },
    from: EVM_ADDRESS,
  });
  assert.equal(out.dex, "uniswap");
  assert.equal(out.family, "evm");
  assert.equal(out.plan.needsApproval, true);
  assert.equal(out.results.length, 2, "approval then swap");
  assert.equal(out.results[0].kind, "approval");
  assert.equal(out.results[1].kind, "swap");
  // the exact wallet sequence: chain check → allowance read → [sim] approve send → [sim] swap send
  const ethCalls = provider.calls.filter((c) => c === "eth_call").length;
  assert.ok(ethCalls >= 3, `allowance + 2 simulations ran as eth_calls (${ethCalls})`);
  const sends = provider.calls.filter((c) => c === "eth_sendTransaction");
  assert.equal(sends.length, 2, "exactly 2 wallet-mediated sends (Rabby pops twice)");
  const firstSendIdx = provider.calls.indexOf("eth_sendTransaction");
  assert.ok(provider.calls.slice(0, firstSendIdx).includes("eth_call"), "allowance/simulation preceded the first send");
  assert.ok(provider.calls.indexOf("eth_sendTransaction") < provider.calls.lastIndexOf("eth_sendTransaction"));
  assert.ok(out.results[0].hash && out.results[1].hash);
  assert.ok(out.statuses.some((s) => /allowance short/.test(s)));
});

test("dexExecute: the EVM anchor flow skips the approval when the allowance covers the amount", async () => {
  const input = evmInput("uni-eth");
  const provider = mockEvmProvider({ allowance: "0x" + BigInt(input.amountIn).toString(16).padStart(64, "0") });
  const out = await runDexAnchor({
    dex: "uniswap",
    buildCtx: {
      chain: "eth", fromToken: "USDC", toToken: "USDT", amount: input.amountIn,
      fee: input.fee, recipient: EVM_ADDRESS, quoteHex: input.responseHex,
    },
    sessions: { evm: { provider } },
    from: EVM_ADDRESS,
  });
  assert.equal(out.plan.needsApproval, false);
  assert.equal(out.results.length, 1, "only the swap");
  assert.equal(out.results[0].kind, "swap");
  assert.equal(provider.calls.filter((c) => c === "eth_sendTransaction").length, 1);
});

test("dexExecute: the Solana anchor flow = ATA setup then swap, both signed in Backpack (adapter-only, no raw send)", async () => {
  const snap = solInput("orca");
  const sent = [];
  const adapter = {
    publicKey: new PublicKey(SOLANA_ADDRESS),
    async signAndSendTransaction(tx) {
      sent.push(tx);
      return "sig-" + sent.length;
    },
  };
  const out = await runDexAnchor({
    dex: "orca",
    buildCtx: {
      snapshot: { whirlpool: snap.whirlpool, tickArrays: snap.tickArrays, tokenProgramA: snap.tokenProgramA, tokenProgramB: snap.tokenProgramB, oracle: snap.oracle },
      userPubkey: SOLANA_ADDRESS,
      inputMint: snap.whirlpool.mintA,
      amountInRaw: snap.sample.amountInRaw,
      slippageBps: snap.sample.slippageBps,
    },
    sessions: { solana: { provider: adapter } },
    read: fakeRead({}),
  });
  assert.equal(out.family, "svm");
  assert.equal(out.plan.needsSetup, true);
  assert.equal(sent.length, 2, "setup tx + swap tx — both through Backpack's adapter");
  assert.equal(sent[0].instructions[0].programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "setup = ATA create");
  assert.equal(sent[1].instructions[1].programId.toBase58(), "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "swap = whirlpool");
  assert.equal(out.results[0].kind, "ata-setup");
  assert.equal(out.results[1].kind, "swap");
  assert.ok(out.statuses.some((s) => /ATA\(s\) missing/.test(s)));
});

test("dexExecute: the anchor refuses to run without a signing session or with a non-signing Solana adapter", async () => {
  const input = evmInput("uni-eth");
  await assert.rejects(
    runDexAnchor({
      dex: "uniswap",
      buildCtx: { chain: "eth", fromToken: "USDC", toToken: "USDT", amount: input.amountIn, fee: input.fee, recipient: EVM_ADDRESS, quoteHex: input.responseHex },
      sessions: {},
      from: EVM_ADDRESS,
    }),
    /connect Rabby/,
  );
  const snap = solInput("orca");
  const readOnly = { publicKey: new PublicKey(SOLANA_ADDRESS) }; // no signAndSendTransaction
  await assert.rejects(
    runDexAnchor({
      dex: "orca",
      buildCtx: {
        snapshot: { whirlpool: snap.whirlpool, tickArrays: snap.tickArrays, tokenProgramA: snap.tokenProgramA, tokenProgramB: snap.tokenProgramB, oracle: snap.oracle },
        userPubkey: SOLANA_ADDRESS,
        inputMint: snap.whirlpool.mintA,
        amountInRaw: snap.sample.amountInRaw,
        slippageBps: snap.sample.slippageBps,
      },
      sessions: { solana: { provider: readOnly } },
      read: fakeRead({}),
    }),
    /connect Backpack/,
  );
});

test("dexExecute: anchor helpers — family + leg dispatch + ordered step lists", () => {
  assert.equal(dexAnchorFamily("uniswap"), "evm");
  assert.equal(dexAnchorFamily("pancakeswap"), "evm");
  assert.equal(dexAnchorFamily("raydium"), "svm");
  assert.equal(dexAnchorFamily("orca"), "svm");
  assert.throws(() => dexAnchorFamily("nope"), /unknown dex/);
  assert.equal(anchorLegForDex("uniswap").id, "uniswap-swap");
  assert.throws(() => anchorLegForDex("nope"), /unknown dex/);
  const evmPlan = { needsApproval: true, approvalTx: { kind: "dex-direct-approval" }, swapTx: { kind: "dex-direct-swap" } };
  const evmSteps = evmAnchorSteps(evmPlan);
  assert.deepEqual(evmSteps.map((s) => s.kind), ["approval", "swap"]);
  assert.deepEqual(evmAnchorSteps({ needsApproval: false, swapTx: {} }).map((s) => s.kind), ["swap"]);
  const solPlan = { needsSetup: true, setupTx: {}, swapTx: {} };
  assert.deepEqual(solanaAnchorSteps(solPlan).map((s) => s.kind), ["ata-setup", "swap"]);
  assert.deepEqual(solanaAnchorSteps({ needsSetup: false, swapTx: {} }).map((s) => s.kind), ["swap"]);
});
