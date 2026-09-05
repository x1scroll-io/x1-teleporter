/**
 * capture-dexdirect-golden-fixtures.mjs — LIVE READ-ONLY capture for the
 * Phase-6 dexDirect golden fixtures (test/fixtures/golden/dex-direct-leg/).
 *
 * 🔴 NO FUNDS, NO BROADCAST. Everything here is read-only:
 *   - EVM: quoter eth_call (static) — the REAL quote response is frozen.
 *   - Solana: getAccountInfo (pool/config/tick-array/vault state) + pure
 *     quote math + the constructed swap tx SIMULATED against mainnet
 *     (simulateTransaction with sigVerify:false — sandboxed, nothing
 *     broadcasts, no balance is touched).
 * The swap-EXECUTION side stays guarded (DexDirectLiveTestGateError) —
 * "swap-execution pending Mr. Esters' live anchor."
 *
 * Usage: node tools/capture-dexdirect-golden-fixtures.mjs [--evm | --sol]
 * Requires network egress to the public RPCs listed below.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

import { EVM_ADDRESS, SOLANA_ADDRESS } from "../test/golden/forwardLegBuilders.mjs";
import {
  shapeUniswapSwapArtifact,
  UNISWAP_V3_QUOTER_V2,
} from "../src/engine/legs/dexDirect/uniswapSwapLeg.js";
import {
  shapePancakeSwapArtifact,
  PANCAKESWAP_V3_QUOTER_V2,
} from "../src/engine/legs/dexDirect/pancakeswapSwapLeg.js";
import {
  decodeWhirlpoolState,
  decodeWhirlpoolTickArray,
  whirlpoolTickArrayPda,
  whirlpoolOraclePda,
  whirlpoolStartTick,
  whirlpoolQuote,
  shapeOrcaSwapArtifact,
  ORCA_TICK_ARRAY_SIZE,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../src/engine/legs/dexDirect/orcaSwapLeg.js";
import {
  decodeRaydiumCpmmPool,
  decodeRaydiumCpmmConfig,
  decodeRaydiumClmmPool,
  decodeRaydiumClmmConfig,
  decodeRaydiumClmmTickArray,
  raydiumClmmTickArrayPda,
  raydiumClmmPdas,
  raydiumClmmArrayStart,
  raydiumCpmmAuthority,
  shapeRaydiumCpmmArtifact,
  shapeRaydiumClmmArtifact,
  RAYDIUM_CLMM_TICK_ARRAY_SIZE,
} from "../src/engine/legs/dexDirect/raydiumSwapLeg.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DEX_DIRECT_FIXTURES = join(here, "..", "test", "fixtures", "golden", "dex-direct-leg");

const RPC = {
  eth: "https://ethereum-rpc.publicnode.com",
  arb: "https://arbitrum-rpc.publicnode.com",
  opt: "https://optimism-rpc.publicnode.com",
  pol: "https://polygon-bor-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
  sol: "https://berty-633y20-fast-mainnet.helius-rpc.com",
};

const TOKEN = {
  eth: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  arb: { USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
  opt: { USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" },
  pol: { USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
  bsc: { USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", USDT: "0x55d398326f99059fF775485246999027B3197955" },
};

const sha = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");

async function rpc(chain, method, params) {
  const r = await fetch(RPC[chain], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method} on ${chain}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

// ── EVM captures ────────────────────────────────────────────────────────────
async function captureEvmQuote({ dex, chain, tokens, fee, amount, rpcChain }) {
  const quoter = dex === "uni" ? UNISWAP_V3_QUOTER_V2 : PANCAKESWAP_V3_QUOTER_V2;
  const artifact = (dex === "uni" ? shapeUniswapSwapArtifact : shapePancakeSwapArtifact)({
    chain: rpcChain,
    fromSymbol: tokens[0],
    toSymbol: tokens[1],
    amount,
    fee,
    recipient: EVM_ADDRESS,
  });
  const out = await rpc(rpcChain, "eth_call", [{ to: artifact.quoteRequest.to, data: artifact.quoteRequest.data }, "latest"]);
  const capture = {
    dex,
    chain: rpcChain,
    fromToken: artifact.fromToken,
    toToken: artifact.toToken,
    amountIn: artifact.amountIn,
    fee: artifact.fee,
    quoter: artifact.quoter,
    request: artifact.quoteRequest,
    responseHex: out,
    capturedAt: new Date().toISOString(),
    rpc: RPC[rpcChain],
    liveStatus:
      "quote-level REAL — frozen live quoter eth_call (read-only). swap-execution pending Mr. Esters' live anchor.",
  };
  const file = `${dex}-${rpcChain}-${tokens[0]}-${tokens[1]}-f${fee}.json`;
  writeJson("inputs", file, capture);
  return { file, capture };
}

// ── Solana helpers ──────────────────────────────────────────────────────────
const solConn = new Connection(RPC.sol, "confirmed");
async function getAccount(pk) {
  const a = await solConn.getAccountInfo(new PublicKey(pk));
  if (!a) return null;
  return { dataBase64: Buffer.from(a.data).toString("base64"), len: a.data.length, owner: a.owner.toBase58() };
}

/** Simulate an UNSIGNED serialized tx (read-only sandbox — sigVerify false,
 *  nothing broadcasts, no balances touched). */
async function simulateUnsigned(txBuf) {
  const legacyTx = Transaction.from(txBuf);
  const vtx = new VersionedTransaction(legacyTx.compileMessage());
  return solConn.simulateTransaction(vtx, { sigVerify: false, commitment: "confirmed" });
}


// ── Orca capture ────────────────────────────────────────────────────────────
async function captureOrca() {
  const POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"; // SOL/USDC whirlpool (the main pool)
  const AMOUNT = "100000000"; // 0.1 SOL raw
  const wpRaw = await getAccount(POOL);
  const wpBuf = Buffer.from(wpRaw.dataBase64, "base64");
  const wp = decodeWhirlpoolState(wpBuf, POOL);
  const start0 = whirlpoolStartTick(wp.tickCurrent, wp.tickSpacing);
  const tickArrays = [];
  for (const start of [start0, start0 - wp.tickSpacing * ORCA_TICK_ARRAY_SIZE, start0 - 2 * wp.tickSpacing * ORCA_TICK_ARRAY_SIZE]) {
    const addr = await whirlpoolTickArrayPda(POOL, start);
    const raw = await getAccount(addr);
    if (!raw) throw new Error(`orca capture: tick array ${addr} absent`);
    const arr = decodeWhirlpoolTickArray(Buffer.from(raw.dataBase64, "base64"), wp.tickSpacing);
    arr.address = addr;
    arr.capturedLen = raw.len;
    tickArrays.push(arr);
  }
  const oracle = await whirlpoolOraclePda(POOL);
  // token programs from the vault token accounts
  const vA = await getAccount(wp.vaultA);
  const vB = await getAccount(wp.vaultB);
  const tokenProgramA = vA.owner;
  const tokenProgramB = vB.owner;

  const snapshot = {
    pool: POOL,
    programId: ORCA_WHIRLPOOL_PROGRAM_ID,
    capturedAt: new Date().toISOString(),
    tokenProgramA,
    tokenProgramB,
    oracle,
    whirlpool: wp,
    whirlpoolAccountLen: wpRaw.len,
    tickArrays,
    sample: { inputMint: wp.mintA, outputMint: wp.mintB, amountInRaw: AMOUNT, slippageBps: 50, userPubkey: SOLANA_ADDRESS },
  };
  const quote = whirlpoolQuote({ snapshot: { whirlpool: wp, tickArrays }, amount: AMOUNT, amountSpecifiedIsInput: true, aToB: true });
  snapshot.quote = quote;

  // The guarded-execute artifact + tx, SIMULATED (read-only) against mainnet.
  const blockhash = (await solConn.getLatestBlockhash("confirmed")).blockhash;
  const artifact = shapeOrcaSwapArtifact({
    snapshot,
    userPubkey: SOLANA_ADDRESS,
    inputMint: wp.mintA,
    amountInRaw: AMOUNT,
    slippageBps: 50,
    blockhash,
  });
  const txBuf = Buffer.from(artifact.transaction.serializedBase64, "base64");
  const sim = await simulateUnsigned(txBuf);
  snapshot.sim = {
    err: sim.value.err ?? null,
    logs: (sim.value.logs || []).slice(-4),
    note: "simulateTransaction with sigVerify:false — read-only sandbox; nothing broadcast.",
  };

  const file = "orca-sol-usdc-whirlpool-snapshot.json";
  writeJson("inputs", file, snapshot);
  return { file, snapshot };
}

// ── Raydium CLMM capture ────────────────────────────────────────────────────
async function captureRaydiumClmm() {
  const POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv"; // SOL/USDC CLMM (api-v3 #1 CLMM)
  const AMOUNT = "100000000"; // 0.1 SOL raw
  const poolRaw = await getAccount(POOL);
  const pool = decodeRaydiumClmmPool(Buffer.from(poolRaw.dataBase64, "base64"), POOL);
  const cfgRaw = await getAccount(pool.configId);
  const config = decodeRaydiumClmmConfig(Buffer.from(cfgRaw.dataBase64, "base64"));
  const pdas = await raydiumClmmPdas(POOL);
  const start0 = raydiumClmmArrayStart(pool.tickCurrent, pool.tickSpacing);
  const tickArrays = [];
  for (let off = 0; off < 4; off++) {
    const start = pool.tickCurrent < 0 ? start0 - off * pool.tickSpacing * RAYDIUM_CLMM_TICK_ARRAY_SIZE : start0 + off * pool.tickSpacing * RAYDIUM_CLMM_TICK_ARRAY_SIZE;
    const addr = await raydiumClmmTickArrayPda(POOL, start);
    const raw = await getAccount(addr);
    if (!raw) continue;
    const arr = decodeRaydiumClmmTickArray(Buffer.from(raw.dataBase64, "base64"), pool.tickSpacing, POOL);
    arr.address = addr;
    arr.capturedLen = raw.len;
    tickArrays.push(arr);
    if (tickArrays.length >= 4) break;
  }
  // order arrays in trade order (sell mintA → descending starts)
  const aToB = true;
  tickArrays.sort((x, y) => (aToB ? y.startTickIndex - x.startTickIndex : x.startTickIndex - y.startTickIndex));
  const zeroForOne = aToB;
  if (tickArrays[0]?.startTickIndex !== start0) {
    throw new Error("clmm capture: first array must contain the pool tick");
  }
  const snapshot = {
    pool: POOL,
    programId: pool.programId,
    capturedAt: new Date().toISOString(),
    poolAccountLen: poolRaw.len,
    pool,
    config,
    pdas,
    tickArrays,
    sample: { inputMint: pool.mintA, outputMint: pool.mintB, amountInRaw: AMOUNT, slippageBps: 50, userPubkey: SOLANA_ADDRESS, zeroForOne },
  };
  const artifact = shapeRaydiumClmmArtifact({
    snapshot,
    userPubkey: SOLANA_ADDRESS,
    inputMint: pool.mintA,
    amountInRaw: AMOUNT,
    slippageBps: 50,
  });
  snapshot.quote = artifact.quote;
  const blockhash = (await solConn.getLatestBlockhash("confirmed")).blockhash;
  const txArtifact = shapeRaydiumClmmArtifact({
    snapshot,
    userPubkey: SOLANA_ADDRESS,
    inputMint: pool.mintA,
    amountInRaw: AMOUNT,
    slippageBps: 50,
    blockhash,
  });
  const sim = await simulateUnsigned(Buffer.from(txArtifact.transaction.serializedBase64, "base64"));
  snapshot.sim = {
    err: sim.value.err ?? null,
    logs: (sim.value.logs || []).slice(-4),
    note: "simulateTransaction with sigVerify:false — read-only sandbox; nothing broadcast.",
  };
  const file = "raydium-clmm-sol-usdc-snapshot.json";
  writeJson("inputs", file, snapshot);
  return { file, snapshot };
}

// ── Raydium CPMM capture ────────────────────────────────────────────────────
async function captureRaydiumCpmm() {
  // A live Raydium CPMM pool (CPMMoo8 program). Deepest from the api-v3 pool
  // list: SOL ↔ Dz9mQ9… ; the DvjbEsd…/USDC pool gives a USDC-input sample.
  const POOL = "5KXE8RMF7iW9Ptn665AHfzsMFjYb4LV2Ta8eZEtsTwWC"; // DvjbEsd…/USDC (api-v3, CPMMoo8)
  const INPUT = "USDC"; // we sell USDC (mintB) → mintA
  const AMOUNT = "100000000"; // 100 USDC raw (6 dp)
  const poolRaw = await getAccount(POOL);
  const pool = decodeRaydiumCpmmPool(Buffer.from(poolRaw.dataBase64, "base64"), POOL);
  const cfgRaw = await getAccount(pool.configId);
  const config = decodeRaydiumCpmmConfig(Buffer.from(cfgRaw.dataBase64, "base64"));
  const authority = await raydiumCpmmAuthority();
  const readVault = async (v) => {
    const a = await getAccount(v);
    const buf = Buffer.from(a.dataBase64, "base64");
    return {
      pubkey: v,
      owner: a.owner,
      mint: new PublicKey(buf.subarray(0, 32)).toBase58(),
      amountRaw: BigInt("0x" + Buffer.from(buf.subarray(64, 72)).reverse().toString("hex")).toString(),
    };
  };
  const vaultA = await readVault(pool.vaultA);
  const vaultB = await readVault(pool.vaultB);
  const snapshot = {
    pool: POOL,
    programId: pool.programId,
    capturedAt: new Date().toISOString(),
    poolAccountLen: poolRaw.len,
    pool,
    config,
    authority,
    vaultA,
    vaultB,
    sample: {
      inputMint: INPUT === "USDC" ? pool.mintB : pool.mintA,
      outputMint: INPUT === "USDC" ? pool.mintA : pool.mintB,
      amountInRaw: AMOUNT,
      slippageBps: 50,
      userPubkey: SOLANA_ADDRESS,
    },
  };
  const artifact = shapeRaydiumCpmmArtifact({
    snapshot,
    userPubkey: SOLANA_ADDRESS,
    inputMint: snapshot.sample.inputMint,
    amountInRaw: AMOUNT,
    slippageBps: 50,
  });
  snapshot.quote = artifact.quote;
  const blockhash = (await solConn.getLatestBlockhash("confirmed")).blockhash;
  const txArtifact = shapeRaydiumCpmmArtifact({
    snapshot,
    userPubkey: SOLANA_ADDRESS,
    inputMint: snapshot.sample.inputMint,
    amountInRaw: AMOUNT,
    slippageBps: 50,
    blockhash,
  });
  const sim = await simulateUnsigned(Buffer.from(txArtifact.transaction.serializedBase64, "base64"));
  snapshot.sim = {
    err: sim.value.err ?? null,
    logs: (sim.value.logs || []).slice(-4),
    note: "simulateTransaction with sigVerify:false — read-only sandbox; nothing broadcast.",
  };
  const file = "raydium-cpmm-token-usdc-snapshot.json";
  writeJson("inputs", file, snapshot);
  return { file, snapshot };
}

function writeJson(subdir, name, obj) {
  const dir = join(DEX_DIRECT_FIXTURES, subdir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  console.log("wrote", file, `(${obj.capturedAt ?? ""}) sha256 ${sha(obj)}`);
}

// ── main ────────────────────────────────────────────────────────────────────
const want = process.argv[2] ?? "all";
const results = {};
if (want === "all" || want === "--evm") {
  results.evmUniEth = await captureEvmQuote({ dex: "uni", chain: "eth", tokens: ["USDC", "USDT"], fee: 100, amount: "10000000", rpcChain: "eth" });
  results.evmUniArb = await captureEvmQuote({ dex: "uni", chain: "arb", tokens: ["USDC", "USDT"], fee: 100, amount: "10000000", rpcChain: "arb" });
  results.evmUniOpt = await captureEvmQuote({ dex: "uni", chain: "opt", tokens: ["USDC", "USDT"], fee: 500, amount: "10000000", rpcChain: "opt" });
  results.evmUniPol = await captureEvmQuote({ dex: "uni", chain: "pol", tokens: ["USDC", "USDT"], fee: 500, amount: "10000000", rpcChain: "pol" });
  // bsc USDC/USDT are 18-dp tokens — 10 USDC = 10e18 raw base units
  results.evmPcs100 = await captureEvmQuote({ dex: "pcs", chain: "bsc", tokens: ["USDC", "USDT"], fee: 100, amount: "10000000000000000000", rpcChain: "bsc" });
  results.evmPcs500 = await captureEvmQuote({ dex: "pcs", chain: "bsc", tokens: ["USDC", "USDT"], fee: 500, amount: "10000000000000000000", rpcChain: "bsc" });
}
if (want === "all" || want === "--sol") {
  results.orca = await captureOrca();
  results.raydiumClmm = await captureRaydiumClmm();
  results.raydiumCpmm = await captureRaydiumCpmm();
}
console.log("\ncapture done:", Object.keys(results).join(", "));
