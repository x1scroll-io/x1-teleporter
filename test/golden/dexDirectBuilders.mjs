/**
 * dexDirectBuilders.mjs — deterministic rebuild helpers for the Phase-6
 * dexDirect golden fixtures (test/fixtures/golden/dex-direct-leg/).
 *
 * THE CONTRACT (mirror of the Phase-4 dex-leg builders): the dexDirect legs
 * (Uniswap v3 / PancakeSwap v3 — EVM quoter legs; Raydium CPMM+CLMM / Orca
 * Whirlpool — Solana on-chain-state legs) are correct IF AND ONLY IF, given
 * the SAME frozen inputs, they construct the EXACT artifacts the canonical
 * construction (this module + the leg files it imports) constructs. This
 * module is the single source of truth for the rebuild path: the capture
 * script (tools/capture-dexdirect-golden-fixtures.mjs) writes the INPUT
 * fixtures (live read-only captures), the step fixtures are built from
 * them, and test/goldenDexDirect.test.js rebuilds + asserts byte-identity
 * + sha256. The engine must make test/goldenDexDirect.test.js pass
 * UNCHANGED.
 *
 * LIVE-STATUS BOUNDARY (honest): the INPUT fixtures are LIVE READ-ONLY
 * captures (2026-09-05): quoter eth_calls (EVM) + on-chain pool/tick-array
 * state + read-only mainnet SIMULATIONS of the constructed swap txs
 * (sigVerify:false — sandboxed; nothing broadcast; the sims parse the
 * instructions to the user-ATA initialization check — the test wallet has
 * no ATAs — proving the wire construction: discriminators + account order
 * + data). Every Solana quote was additionally cross-checked against the
 * protocol's official SDK on the identical state (recorded in the
 * summary): Orca == @orca-so/whirlpools-sdk computeSwap; Raydium ==
 * raydium-sdk-v2 swapInternal / CurveCalculator. swap-EXECUTION stays
 * GUARDED (DexDirectLiveTestGateError) — "swap-execution pending Mr.
 * Esters' live anchor."
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVM_ADDRESS, SOLANA_ADDRESS, canonicalJson, sha256Of } from "./forwardLegBuilders.mjs";
import { shapeUniswapSwapArtifact } from "../../src/engine/legs/dexDirect/uniswapSwapLeg.js";
import { shapePancakeSwapArtifact } from "../../src/engine/legs/dexDirect/pancakeswapSwapLeg.js";
import { parseQuoterResponse } from "../../src/engine/legs/dexDirect/evmV3.js";
import {
  decodeWhirlpoolState,
  whirlpoolQuote,
  shapeOrcaSwapArtifact,
} from "../../src/engine/legs/dexDirect/orcaSwapLeg.js";
import {
  decodeRaydiumCpmmPool,
  decodeRaydiumCpmmConfig,
  decodeRaydiumClmmPool,
  decodeRaydiumClmmConfig,
  shapeRaydiumCpmmArtifact,
  shapeRaydiumClmmArtifact,
} from "../../src/engine/legs/dexDirect/raydiumSwapLeg.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DEX_DIRECT_FIXTURES = join(here, "..", "fixtures", "golden", "dex-direct-leg");
const INPUTS = join(DEX_DIRECT_FIXTURES, "inputs");
const STEPS = join(DEX_DIRECT_FIXTURES, "steps");

/** sha256 hex of a raw UTF-8 string. */
export function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** Deterministic synthetic DI blockhash (a real flow fetches a fresh one). */
export const SYNTHETIC_BLOCKHASH = "96BfNwYAmZ29CRUHtMGVj6K3wESXTCVbFUVZHSXKfuXP";
/** Deterministic synthetic EVM deadline (2030-01-01; real flows pass now+30m). */
export const SYNTHETIC_DEADLINE = 4102444800;

// ── INPUT FIXTURE READERS ───────────────────────────────────────────────────
const read = (name) => JSON.parse(readFileSync(join(INPUTS, name), "utf8"));

/** The six EVM quote captures (live quoter eth_calls). */
export const EVM_INPUTS = Object.freeze({
  "uni-eth": { file: "uni-eth-USDC-USDT-f100.json", chain: "eth", dex: "uniswap" },
  "uni-arb": { file: "uni-arb-USDC-USDT-f100.json", chain: "arb", dex: "uniswap" },
  "uni-opt": { file: "uni-opt-USDC-USDT-f500.json", chain: "opt", dex: "uniswap" },
  "uni-pol": { file: "uni-pol-USDC-USDT-f500.json", chain: "pol", dex: "uniswap" },
  "pcs-bsc-f100": { file: "pcs-bsc-USDC-USDT-f100.json", chain: "bsc", dex: "pancakeswap" },
  "pcs-bsc-f500": { file: "pcs-bsc-USDC-USDT-f500.json", chain: "bsc", dex: "pancakeswap" },
});

/** The three Solana state captures (whirlpool / CLMM / CPMM). */
export const SOL_INPUTS = Object.freeze({
  orca: { file: "orca-sol-usdc-whirlpool-snapshot.json" },
  raydiumClmm: { file: "raydium-clmm-sol-usdc-snapshot.json" },
  raydiumCpmm: { file: "raydium-cpmm-token-usdc-snapshot.json" },
});

export const evmInput = (key) => read(EVM_INPUTS[key].file);
export const solInput = (key) => read(SOL_INPUTS[key].file);

// ── STEP BUILDERS ───────────────────────────────────────────────────────────
/** EVM step1+step2: the canonical quote parse + the guarded swap request,
 *  rebuilt through the leg's own shape functions from the frozen capture. */
export function buildEvmSteps(key) {
  const input = evmInput(key);
  const { dex, chain } = EVM_INPUTS[key];
  const shape = dex === "uniswap" ? shapeUniswapSwapArtifact : shapePancakeSwapArtifact;
  const artifact = shape({
    chain,
    fromSymbol: input.fromToken.symbol,
    toSymbol: input.toToken.symbol,
    amount: input.amountIn,
    fee: input.fee,
    recipient: EVM_ADDRESS,
    deadline: SYNTHETIC_DEADLINE,
    quoteHex: input.responseHex,
    slippageBps: 50,
  });
  const parsed = parseQuoterResponse(input.responseHex);
  const step1 = {
    step: `${dex}-${chain}-step1-quote`,
    artifact: {
      dex: artifact.dex,
      chain: artifact.chain,
      fromToken: artifact.fromToken,
      toToken: artifact.toToken,
      amountIn: artifact.amountIn,
      fee: artifact.fee,
      quoteRequest: artifact.quoteRequest,
      quote: {
        amountOut: parsed.amountOut,
        sqrtPriceX96After: parsed.sqrtPriceX96After,
        initializedTicksCrossed: parsed.initializedTicksCrossed,
        gasEstimate: parsed.gasEstimate,
      },
    },
    sha256: null,
    calldataSha256: sha256Text(artifact.quoteRequest.data),
    meta: {
      note:
        "The canonical DEX-direct EVM quote: QuoterV2.quoteExactInputSingle eth_call (static " +
        "calldata) with the FROZEN LIVE RESPONSE parsed (amountOut etc.). calldataSha256 pins " +
        "the canonical request bytes. quote-level REAL — swap-execution pending Mr. Esters' " +
        "live anchor.",
    },
  };
  step1.sha256 = sha256Of(step1.artifact);
  const step2 = {
    step: `${dex}-${chain}-step2-swap-request`,
    artifact: {
      dex: artifact.dex,
      chain: artifact.chain,
      swapRequest: artifact.swapRequest,
      minOutRaw: artifact.quote.minOutRaw,
      slippageBps: artifact.quote.slippageBps,
    },
    sha256: null,
    calldataSha256: sha256Text(artifact.swapRequest.data),
    meta: {
      note:
        "The guarded swap-call REQUEST (SwapRouter.exactInputSingle — the direct periphery " +
        "path). 🔴 The execute leg never signs/broadcasts: submit() throws " +
        "DexDirectLiveTestGateError — READY FOR LIVE ANCHOR (Mr. Esters fires the first live " +
        "swap with a funded wallet + real ATA/allowance to the router).",
    },
  };
  step2.sha256 = sha256Of(step2.artifact);
  return { step1, step2 };
}

/** Orca steps: step1 = the pool-state quote; step2 = the swap_v2 ix + the
 *  unsigned tx (synthetic DI blockhash). */
export function buildOrcaSteps() {
  const snap = solInput("orca");
  const snapshot = {
    whirlpool: snap.whirlpool,
    tickArrays: snap.tickArrays,
    tokenProgramA: snap.tokenProgramA,
    tokenProgramB: snap.tokenProgramB,
    oracle: snap.oracle,
  };
  const quote = whirlpoolQuote({
    snapshot,
    amount: snap.sample.amountInRaw,
    amountSpecifiedIsInput: true,
    aToB: true,
  });
  const step1 = {
    step: "orca-step1-quote",
    artifact: {
      pool: snap.pool,
      programId: snap.programId,
      inputMint: snap.whirlpool.mintA,
      outputMint: snap.whirlpool.mintB,
      amountInRaw: quote.amountIn,
      amountOutRaw: quote.amountOut,
      feeAmount: quote.feeAmount,
      allTrade: quote.allTrade,
      appliedFeeRate: quote.appliedFeeRate,
      endTickIndex: quote.endTickIndex,
      tickSpacing: snap.whirlpool.tickSpacing,
      capturedAt: snap.capturedAt,
    },
    sha256: null,
    meta: {
      note:
        "The Orca Whirlpool DEX-direct quote from the FROZEN live pool state (whirlpool + 3 " +
        "tick arrays — 2026-09-05 capture) — numerically identical to @orca-so/whirlpools-sdk " +
        "computeSwap on the same state (see the summary). quote-level REAL — swap-execution " +
        "pending Mr. Esters' live anchor.",
    },
  };
  step1.sha256 = sha256Of(step1.artifact);
  const artifact = shapeOrcaSwapArtifact({
    snapshot,
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.whirlpool.mintA,
    amountInRaw: snap.sample.amountInRaw,
    slippageBps: snap.sample.slippageBps,
    blockhash: SYNTHETIC_BLOCKHASH,
  });
  const step2 = {
    step: "orca-step2-swap-ix",
    artifact: {
      programId: artifact.programId,
      pool: artifact.pool,
      userPubkey: artifact.userPubkey,
      inputAta: artifact.inputAta,
      outputAta: artifact.outputAta,
      quote: artifact.quote,
      ix: artifact.ix,
      transaction: artifact.transaction,
    },
    sha256: null,
    dataSha256: sha256Text(artifact.ix.dataHex),
    txSha256: sha256Text(artifact.transaction.serializedBase64),
    meta: {
      note:
        "The Orca swap_v2 instruction + unsigned tx (disc 2b04ed0b1ac91e62 — the live-verified " +
        "deployed instruction; 15 metas + option None). LIVE-READ-ONLY SIMULATED on mainnet " +
        "during capture (sigVerify:false): the program parsed the ix and stopped only at the " +
        "user-ATA initialization check (the repo test wallet has no ATAs) — the wire " +
        "construction is correct. 🔴 submit() throws DexDirectLiveTestGateError — READY FOR " +
        "LIVE ANCHOR.",
    },
  };
  step2.sha256 = sha256Of(step2.artifact);
  return { step1, step2 };
}

/** Raydium steps (clmm + cpmm): step1 = quote; step2 = swap ix + unsigned tx. */
export function buildRaydiumSteps(kind) {
  if (kind === "clmm") {
    const snap = solInput("raydiumClmm");
    const snapshot = {
      pool: snap.pool,
      poolAccountLen: snap.poolAccountLen,
      pool: snap.pool,
      config: snap.config,
      pdas: snap.pdas,
      tickArrays: snap.tickArrays,
    };
    const artifact = shapeRaydiumClmmArtifact({
      snapshot,
      userPubkey: SOLANA_ADDRESS,
      inputMint: snap.pool.mintA,
      amountInRaw: snap.sample.amountInRaw,
      slippageBps: snap.sample.slippageBps,
      blockhash: SYNTHETIC_BLOCKHASH,
    });
    const step1 = {
      step: "raydium-clmm-step1-quote",
      artifact: {
        pool: snap.pool,
        programId: snap.programId,
        inputMint: artifact.inputMint,
        outputMint: artifact.outputMint,
        quote: artifact.quote,
        capturedAt: snap.capturedAt,
      },
      sha256: null,
      meta: {
        note:
          "The Raydium CLMM DEX-direct quote from the FROZEN live pool state (pool + config + " +
          "4 tick arrays — 2026-09-05 capture) — numerically identical to raydium-sdk-v2 " +
          "swapInternal on the same state (see the summary). quote-level REAL — " +
          "swap-execution pending Mr. Esters' live anchor.",
      },
    };
    step1.sha256 = sha256Of(step1.artifact);
    const step2 = {
      step: "raydium-clmm-step2-swap-ix",
      artifact: {
        programId: artifact.programId,
        pool: artifact.pool,
        userPubkey: artifact.userPubkey,
        quote: artifact.quote,
        ix: artifact.ix,
        transaction: artifact.transaction,
      },
      sha256: null,
      dataSha256: sha256Text(artifact.ix.dataHex),
      txSha256: sha256Text(artifact.transaction.serializedBase64),
      meta: {
        note:
          "The Raydium CLMM swap_v2 instruction + unsigned tx (disc 2b04ed0b1ac91e62). " +
          "LIVE-READ-ONLY SIMULATED on mainnet during capture (sigVerify:false): parsed to " +
          "the user-ATA initialization check — wire construction correct. 🔴 submit() throws " +
          "DexDirectLiveTestGateError — READY FOR LIVE ANCHOR.",
      },
    };
    step2.sha256 = sha256Of(step2.artifact);
    return { step1, step2 };
  }
  const snap = solInput("raydiumCpmm");
  const snapshot = {
    pool: snap.pool,
    poolAccountLen: snap.poolAccountLen,
    pool: snap.pool,
    config: snap.config,
    authority: snap.authority,
    vaultA: snap.vaultA,
    vaultB: snap.vaultB,
  };
  const artifact = shapeRaydiumCpmmArtifact({
    snapshot,
    userPubkey: SOLANA_ADDRESS,
    inputMint: snap.sample.inputMint,
    amountInRaw: snap.sample.amountInRaw,
    slippageBps: snap.sample.slippageBps,
    blockhash: SYNTHETIC_BLOCKHASH,
  });
  const step1 = {
    step: "raydium-cpmm-step1-quote",
    artifact: {
      pool: snap.pool,
      programId: snap.programId,
      inputMint: artifact.inputMint,
      outputMint: artifact.outputMint,
      quote: artifact.quote,
      capturedAt: snap.capturedAt,
    },
    sha256: null,
    meta: {
      note:
        "The Raydium CPMM DEX-direct quote from the FROZEN live pool state (pool + config + " +
        "vault balances — 2026-09-05 capture) — numerically identical to raydium-sdk-v2 " +
        "CurveCalculator.swapBaseInput on the same state (see the summary). quote-level REAL " +
        "— swap-execution pending Mr. Esters' live anchor.",
    },
  };
  step1.sha256 = sha256Of(step1.artifact);
  const step2 = {
    step: "raydium-cpmm-step2-swap-ix",
    artifact: {
      programId: artifact.programId,
      pool: artifact.pool,
      userPubkey: artifact.userPubkey,
      quote: artifact.quote,
      ix: artifact.ix,
      transaction: artifact.transaction,
    },
    sha256: null,
    dataSha256: sha256Text(artifact.ix.dataHex),
    txSha256: sha256Text(artifact.transaction.serializedBase64),
    meta: {
      note:
        "The Raydium CPMM swap_base_input instruction + unsigned tx (disc 8fbe5adac41e33de — " +
        "the same discriminator family the XDEX leg anchored LIVE on X1). LIVE-READ-ONLY " +
        "SIMULATED on mainnet during capture (sigVerify:false): parsed to the user-ATA " +
        "initialization check — wire construction correct. 🔴 submit() throws " +
        "DexDirectLiveTestGateError — READY FOR LIVE ANCHOR.",
    },
  };
  step2.sha256 = sha256Of(step2.artifact);
  return { step1, step2 };
}

// ── WRITE THE STEP FIXTURES ─────────────────────────────────────────────────
function writeStep(name, step) {
  if (!existsSync(STEPS)) mkdirSync(STEPS, { recursive: true });
  const file = join(STEPS, name);
  writeFileSync(file, JSON.stringify(step, null, 2) + "\n");
  console.log("wrote", file, "sha256", step.sha256);
}

export function writeDexDirectStepFixtures() {
  for (const key of Object.keys(EVM_INPUTS)) {
    const { step1, step2 } = buildEvmSteps(key);
    const input = evmInput(key);
    const tag = `${EVM_INPUTS[key].dex}-${EVM_INPUTS[key].chain}-f${input.fee}`;
    writeStep(`${tag}-step1-quote.json`, step1);
    writeStep(`${tag}-step2-swap-request.json`, step2);
  }
  const orca = buildOrcaSteps();
  writeStep("orca-step1-quote.json", orca.step1);
  writeStep("orca-step2-swap-ix.json", orca.step2);
  const clmm = buildRaydiumSteps("clmm");
  writeStep("raydium-clmm-step1-quote.json", clmm.step1);
  writeStep("raydium-clmm-step2-swap-ix.json", clmm.step2);
  const cpmm = buildRaydiumSteps("cpmm");
  writeStep("raydium-cpmm-step1-quote.json", cpmm.step1);
  writeStep("raydium-cpmm-step2-swap-ix.json", cpmm.step2);
}

export { canonicalJson, sha256Of, EVM_ADDRESS, SOLANA_ADDRESS };
