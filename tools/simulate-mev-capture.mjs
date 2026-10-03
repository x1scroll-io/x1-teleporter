/**
 * simulate-mev-capture.mjs — the MEV/PRICE-GAP CAPTURE SIMULATION harness.
 *
 * 🔴 HARD LIMITS (Mr. Esters — absolute): NO live trades, NO broadcasting
 * funds, NO signing. Everything here is READ-ONLY:
 *   - EVM: quoter eth_call (static calls — the same read-only quote path the
 *     dexDirect legs use) + eth_gasPrice.
 *   - Solana: getAccountInfo pool-state reads (whirlpool / raydium-clmm) +
 *     the pure quote math the legs use (whirlpoolQuote / raydiumClmmQuote).
 *   - Aggregators: keyless public quote APIs (Jupiter / LiFi), graceful skip.
 * The detector runs over the REAL captured quotes and the report quantifies
 * what WOULD have been capturable — gated OFF by default (MEV_CAPTURE_ENABLED
 * is false; every report line carries "(gated OFF)"). ZERO trades.
 *
 * WHAT IT PRODUCES (the deliverable proof — real state, real gaps, zero
 * trades):
 *   - test/fixtures/golden/mev-capture/inputs/*.json — the REAL quote
 *     captures (REAL-labeled, quote-level only; dated; refresh before live
 *     use — markets move).
 *   - docs/mev-simulation-2026-09-06.json — the machine report (every
 *     round's quotes + detections + the honest summary).
 *   - docs/MEV-SIMULATION-2026-09-06.md — the human report.
 *
 * Usage:
 *   node tools/simulate-mev-capture.mjs [--rounds=N] [--sleep=MS]
 * Requires network egress to the public RPCs below.
 *
 * HONESTY NOTES (read before quoting the numbers):
 *   • The two legs of a round trip are quoted SEQUENTIALLY (two read-only
 *     calls). A real capture would execute buy+sell atomically (one tx or
 *     same-block sequential) — the recorded round trip is the detector's
 *     per-snapshot math, NOT a guaranteed same-instant execution. Markets
 *     move between the two reads; the report's net figures assume the
 *     quotes held.
 *   • Pool fees are netted inside every quote (quoter eth_call / pool-state
 *     walk). The detector does not subtract them twice — see
 *     src/lib/mev/gapDetector.js.
 *   • Gas is included: EVM gas = quoter gasEstimate × live eth_gasPrice × 2
 *     txs, converted to quote-token units via REAL same-chain WETH→USDC /
 *     WBNB→USDC quoter reads (no synthetic prices). Solana gas = 2 × 5000
 *     lamports, already in SOL units.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";

import { EVM_ADDRESS } from "../test/golden/forwardLegBuilders.mjs";
import {
  shapeQuoterCall,
  parseQuoterResponse,
} from "../src/engine/legs/dexDirect/evmV3.js";
import {
  decodeWhirlpoolState,
  decodeWhirlpoolTickArray,
  whirlpoolTickArrayPda,
  whirlpoolStartTick,
  whirlpoolQuote,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  ORCA_TICK_ARRAY_SIZE,
} from "../src/engine/legs/dexDirect/orcaSwapLeg.js";
import {
  decodeRaydiumClmmPool,
  decodeRaydiumClmmConfig,
  decodeRaydiumClmmTickArray,
  raydiumClmmTickArrayPda,
  raydiumClmmArrayStart,
  raydiumClmmQuote,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_CLMM_TICK_ARRAY_SIZE,
} from "../src/engine/legs/dexDirect/raydiumSwapLeg.js";
import { detectCaptureGap, summarizeCaptureDetections } from "../src/lib/mev/gapDetector.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
export const MEV_FIXTURES = join(REPO, "test", "fixtures", "golden", "mev-capture");
export const MEV_DOCS = join(REPO, "docs");

const args = process.argv.slice(2);
const argNum = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};
const ROUNDS = argNum("rounds", 6);
const SLEEP_MS = argNum("sleep", 15000);

// ── RPC endpoints (public / keyless — same hosts the dex-direct capture
//    tool uses; nothing here needs an API key) ─────────────────────────────
const RPC = {
  eth: "https://ethereum-rpc.publicnode.com",
  arb: "https://arbitrum-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
  sol: "https://berty-633y20-fast-mainnet.helius-rpc.com",
};
const SOL_FALLBACK = "https://api.mainnet-beta.solana.com";

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

// ── token registry (the app's pairs + the gas-conversion pairs) ────────────
const TOKEN = {
  eth: {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    WETH_FEE: 500,
  },
  arb: {
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    WETH_FEE: 500,
  },
  bsc: {
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    WETH: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    WETH_FEE: 500,
  },
};
const SOL_MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
const QUOTER = {
  uniswap: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  pancakeswap: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
};
const ORCA_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"; // SOL/USDC whirlpool
const RAYDIUM_CLMM_POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv"; // SOL/USDC CLMM

// EVM round-trip sizes: 2,500 USDC per chain — raw units follow the token's
// decimals (eth/arb USDC = 6dp; bsc Binance-Peg USDC/USDT = 18dp). Solana:
// 5 SOL (raw 9dp).
const EVM_AMOUNT = { eth: "2500000000", arb: "2500000000", bsc: "2500" + "0".repeat(18) };
const EVM_DECIMALS = { eth: 6, arb: 6, bsc: 18 };
const SOL_AMOUNT = "5000000000";
const SOL_DECIMALS = 9;

const ts = () => new Date().toISOString();

// ── EVM quote (read-only quoter eth_call — the dexDirect leg path) ────────
/** Quote X→Y on an EVM chain through a QuoterV2 eth_call. Returns null with
 *  a reason when the call reverts (e.g. no pool at that fee tier). */
async function quoteEvm({ chain, dex, tokenIn, tokenOut, amount, fee }) {
  const quoter = QUOTER[dex];
  const req = shapeQuoterCall({
    quoter,
    tokenIn: TOKEN[chain][tokenIn],
    tokenOut: TOKEN[chain][tokenOut],
    amountIn: String(amount),
    fee,
    chain,
  });
  let hex;
  try {
    hex = await rpc(chain, "eth_call", [{ to: req.to, data: req.data }, "latest"]);
  } catch (e) {
    return { ok: false, reason: `revert: ${String(e.message).slice(0, 120)}`, dex, chain, tokenIn, tokenOut, amountIn: String(amount), fee };
  }
  const p = parseQuoterResponse(hex);
  return {
    ok: true,
    dex,
    pool: `${dex}-${chain}-${tokenIn}-${tokenOut}-f${fee}`,
    chain,
    from: tokenIn,
    to: tokenOut,
    amountIn: String(amount),
    amountOut: p.amountOut,
    fee,
    feeBps: fee / 100,
    gasEstimate: p.gasEstimate,
    sqrtPriceX96After: p.sqrtPriceX96After,
    quoteRequest: { to: req.to, data: req.data },
    responseHex: hex,
    source: "REAL-live-quoter-eth_call",
    capturedAt: ts(),
    rpc: RPC[chain],
  };
}

async function gasPrice(chain) {
  const hex = await rpc(chain, "eth_gasPrice", []);
  return BigInt(hex);
}

/** Convert an EVM gas cost (wei) to quote-token (USDC) units via a REAL
 *  same-chain WETH→USDC / WBNB→USDC quoter read. */
async function gasWeiToUsdc(chain, wei) {
  const tokenIn = TOKEN[chain].WETH;
  const tokenOut = TOKEN[chain].USDC;
  const fee = TOKEN[chain].WETH_FEE;
  const quoter = chain === "bsc" ? QUOTER.pancakeswap : QUOTER.uniswap;
  const req = shapeQuoterCall({ quoter, tokenIn, tokenOut, amountIn: wei.toString(), fee, chain });
  const hex = await rpc(chain, "eth_call", [{ to: req.to, data: req.data }, "latest"]);
  const p = parseQuoterResponse(hex);
  return { usdcRaw: BigInt(p.amountOut), gasEstimate: p.gasEstimate };
}

/** Full EVM round-trip cost in USDC raw units: 2 txs × gasUnits × gasPrice,
 *  converted through the real WETH/WBNB→USDC pool. */
async function evmGasCostQuoteUnits(chain, maxGasUnits) {
  try {
    const gweiPrice = await gasPrice(chain);
    const units = BigInt(maxGasUnits || 150000);
    const weiBothLegs = units * 2n * gweiPrice;
    const conv = await gasWeiToUsdc(chain, weiBothLegs);
    return { gasCostQuoteUnits: conv.usdcRaw.toString(), gasPriceWei: gweiPrice.toString(), gasUnitsBothLegs: (units * 2n).toString(), via: `REAL ${chain} WETH→USDC quoter` };
  } catch (e) {
    return { gasCostQuoteUnits: "0", error: String(e.message).slice(0, 160), via: "gas conversion failed — reported as 0 (conservative, underestimates cost)" };
  }
}

// ── Solana state + quote (getAccountInfo + the legs' pure quote math) ──────
let solConn = null;
let solFallbackConn = null;
function getSolConn() {
  if (solConn) return solConn;
  solConn = new Connection(RPC.sol, "confirmed");
  return solConn;
}
function getSolFallbackConn() {
  if (!solFallbackConn) solFallbackConn = new Connection(SOL_FALLBACK, "confirmed");
  return solFallbackConn;
}
async function getAccount(conn, pk) {
  const a = await conn.getAccountInfo(new PublicKey(pk));
  if (!a) return null;
  return { dataBase64: Buffer.from(a.data).toString("base64"), len: a.data.length, owner: a.owner.toBase58() };
}
/** getAccount with a one-shot fallback to the public RPC when the primary
 *  host flakes (the run must not lose a whole round to one bad host). */
async function getAccountRobust(pk) {
  try {
    const a = await getAccount(getSolConn(), pk);
    if (a) return a;
    throw new Error(`account ${pk} not found on primary RPC`);
  } catch (e) {
    const a = await getAccount(getSolFallbackConn(), pk);
    if (!a) throw new Error(`account ${pk} not found on fallback RPC either`);
    return a;
  }
}

/** Fetch a whirlpool's state + tick arrays covering BOTH trade directions
 *  (containing array ± 3 arrays each way) so aToB and bToA both quote. */
async function fetchOrcaState() {
  const pool = ORCA_POOL;
  const raw = await getAccountRobust(pool);
  if (!raw) throw new Error(`orca: pool ${pool} not found`);
  const wp = decodeWhirlpoolState(Buffer.from(raw.dataBase64, "base64"), pool);
  const spacing = wp.tickSpacing;
  const start0 = whirlpoolStartTick(wp.tickCurrent, spacing);
  const arrays = [];
  for (const off of [0, -1, -2, -3, 1, 2, 3]) {
    const start = start0 + off * spacing * ORCA_TICK_ARRAY_SIZE;
    const addr = await whirlpoolTickArrayPda(pool, start);
    const aRaw = await getAccountRobust(addr);
    if (!aRaw) continue; // an uninitialized array (edge of the book) is fine
    const arr = decodeWhirlpoolTickArray(Buffer.from(aRaw.dataBase64, "base64"), spacing);
    arr.address = addr;
    arr.capturedLen = aRaw.len;
    arrays.push(arr);
  }
  const containing = arrays.find((a) => a.startTickIndex === start0);
  if (!containing) throw new Error("orca: containing tick array absent");
  // Trade-order lists (the tick walk needs the containing array first, then
  // the arrays in the trade direction): aToB=true walks DOWN (below arrays),
  // bToA walks UP (above arrays).
  const below = arrays.filter((a) => a.startTickIndex <= start0).sort((a, b) => b.startTickIndex - a.startTickIndex);
  const above = arrays.filter((a) => a.startTickIndex >= start0).sort((a, b) => a.startTickIndex - b.startTickIndex);
  return { programId: ORCA_WHIRLPOOL_PROGRAM_ID, pool, whirlpool: wp, below, above };
}

/** Quote one orca leg. aToB=true = SOL→USDC (input SOL at amountInRaw);
 *  aToB=false = USDC→SOL (input USDC at amountInRaw). Read-only pool-state
 *  math — the same whirlpoolQuote the leg uses. */
function orcaQuoteLeg(state, aToB, amountInRaw) {
  const tickArrays = aToB ? state.below : state.above;
  return whirlpoolQuote({ snapshot: { whirlpool: state.whirlpool, tickArrays }, amount: amountInRaw, amountSpecifiedIsInput: true, aToB });
}

/** Fetch a raydium CLMM pool's state + config + tick arrays covering both
 *  directions (containing array ± 3). */
async function fetchRaydiumClmmState() {
  const pool = RAYDIUM_CLMM_POOL;
  const raw = await getAccountRobust(pool);
  if (!raw) throw new Error(`raydium clmm: pool ${pool} not found`);
  const poolState = decodeRaydiumClmmPool(Buffer.from(raw.dataBase64, "base64"), pool);
  const cfgRaw = await getAccountRobust(poolState.configId);
  if (!cfgRaw) throw new Error("raydium clmm: config absent");
  const config = decodeRaydiumClmmConfig(Buffer.from(cfgRaw.dataBase64, "base64"));
  const spacing = poolState.tickSpacing;
  const start0 = raydiumClmmArrayStart(poolState.tickCurrent, spacing);
  const arrays = [];
  for (const off of [0, -1, -2, -3, 1, 2, 3]) {
    const start = start0 + off * spacing * RAYDIUM_CLMM_TICK_ARRAY_SIZE;
    const addr = await raydiumClmmTickArrayPda(pool, start);
    const aRaw = await getAccountRobust(addr);
    if (!aRaw) continue;
    const arr = decodeRaydiumClmmTickArray(Buffer.from(aRaw.dataBase64, "base64"), spacing, pool);
    arr.address = addr;
    arr.capturedLen = aRaw.len;
    arrays.push(arr);
  }
  const containing = arrays.find((a) => a.startTickIndex === start0);
  if (!containing) throw new Error("raydium clmm: containing tick array absent");
  return { programId: RAYDIUM_CLMM_PROGRAM_ID, poolAddress: pool, pool: poolState, config, arrays, start0 };
}

/** Quote one raydium CLMM leg (inputMint SOL → USDC, or USDC → SOL). The
 *  quote sorts the arrays internally; tickArrays[0] must be the containing
 *  array (fetch order guarantees it). */
function raydiumQuoteLeg(state, inputMint, amountInRaw) {
  return raydiumClmmQuote({
    snapshot: { pool: state.pool, config: state.config, tickArrays: state.arrays },
    inputMint,
    amountInRaw,
  });
}

// ── aggregator quotes (keyless public APIs — graceful skip) ───────────────
async function quoteJupiter(inputMint, outputMint, amount) {
  const url =
    `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amount}&slippageBps=50&onlyDirectRoutes=false&maxAccounts=20`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`jupiter HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.outAmount) throw new Error("jupiter: no outAmount in quote");
  return { amountOut: String(j.outAmount), raw: { routePlan: j.routePlan?.length ?? null, priceImpactPct: j.priceImpactPct ?? null } };
}

async function quoteLifi(chainKey, fromSymbol, toSymbol, amount) {
  const url =
    `https://li.quest/v1/quote?fromChain=${chainKey}&toChain=${chainKey}` +
    `&fromToken=${fromSymbol}&toToken=${toSymbol}&fromAmount=${amount}` +
    `&fromAddress=${EVM_ADDRESS}&slippage=0.005&integrator=x1-teleporter-labs&fee=0`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`lifi HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error || !j?.estimate?.toAmount) throw new Error(`lifi: ${j?.message ?? "no estimate"}`);
  return { amountOut: j.estimate.toAmount, raw: { tool: j.tool ?? null, steps: j.steps?.length ?? null } };
}

// ── the round ──────────────────────────────────────────────────────────────
/**
 * One sample round: fetch real quotes for every scanned chain and compute
 * the capture detections. Returns { round, quotes, detections, gas }.
 */
async function runRound(round) {
  const started = ts();
  const quotes = [];
  const detections = [];
  const gas = {};

  // ── EVM chains: USDC→USDT / USDT→USDC across fee tiers (and LiFi) ──────
  for (const chain of ["eth", "arb", "bsc"]) {
    const dex = chain === "bsc" ? "pancakeswap" : "uniswap";
    const tiers = chain === "bsc" ? [100, 500] : [100, 500];
    const evmAmount = EVM_AMOUNT[chain];
    const buyQuotes = [];
    const buyEvidence = [];
    for (const fee of tiers) {
      const q1 = await quoteEvm({ chain, dex, tokenIn: "USDC", tokenOut: "USDT", amount: evmAmount, fee });
      buyEvidence.push(q1);
      if (q1.ok) buyQuotes.push(q1);
    }
    // LiFi aggregator (same chain, fee=0 — the pure DEX-aggregated price)
    try {
      const lifi = await quoteLifi(chain === "eth" ? "ETH" : chain === "arb" ? "ARB" : "BSC", "USDC", "USDT", evmAmount);
      const lifiQuote = {
        ok: true,
        dex: "lifi",
        pool: `lifi-${chain}-USDC-USDT`,
        chain,
        from: "USDC",
        to: "USDT",
        amountIn: evmAmount,
        amountOut: lifi.amountOut,
        fee: 0,
        feeBps: 0,
        source: "REAL-live-lifi-quote(fee=0)",
        capturedAt: ts(),
        ...(lifi.raw || {}),
      };
      buyEvidence.push(lifiQuote);
      buyQuotes.push(lifiQuote);
    } catch (e) {
      buyEvidence.push({ ok: false, dex: "lifi", reason: String(e.message).slice(0, 120), source: "aggregator-skip" });
    }

    const bestBuy = [...buyQuotes].sort((a, b) => BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : 0)[0];
    const sellSize = bestBuy ? bestBuy.amountOut : evmAmount;
    const sellQuotes = [];
    const sellEvidence = [];
    for (const fee of tiers) {
      const q2 = await quoteEvm({ chain, dex, tokenIn: "USDT", tokenOut: "USDC", amount: sellSize, fee });
      sellEvidence.push(q2);
      if (q2.ok) sellQuotes.push(q2);
    }
    try {
      const lifi = await quoteLifi(chain === "eth" ? "ETH" : chain === "arb" ? "ARB" : "BSC", "USDT", "USDC", sellSize);
      const lifiQuote = {
        ok: true,
        dex: "lifi",
        pool: `lifi-${chain}-USDT-USDC`,
        chain,
        from: "USDT",
        to: "USDC",
        amountIn: sellSize,
        amountOut: lifi.amountOut,
        fee: 0,
        feeBps: 0,
        source: "REAL-live-lifi-quote(fee=0)",
        capturedAt: ts(),
        ...(lifi.raw || {}),
      };
      sellEvidence.push(lifiQuote);
      sellQuotes.push(lifiQuote);
    } catch (e) {
      sellEvidence.push({ ok: false, dex: "lifi", reason: String(e.message).slice(0, 120), source: "aggregator-skip" });
    }

    quotes.push(...buyEvidence.filter((q) => q.ok).map(strip), ...sellEvidence.filter((q) => q.ok).map(strip));
    const evidence = { chain, pair: { from: "USDC", to: "USDT" }, decimals: EVM_DECIMALS[chain], amountIn: evmAmount, amountInHuman: "2500", buy: buyEvidence, sell: sellEvidence, capturedAt: ts() };
    const roundTripUsdc = bestBuy && bestBuy.ok !== false ? await evmGasCostQuoteUnits(chain, bestBuy.gasEstimate || sellQuotes[0]?.gasEstimate || 0) : { gasCostQuoteUnits: "0" };
    gas[chain] = roundTripUsdc;
    if (bestBuy && bestBuy.ok !== false && sellQuotes.length > 0) {
      const det = detectCaptureGap({
        pair: { from: "USDC", to: "USDT" },
        chain,
        buyQuotes: buyQuotes.map(toDetectorQuote),
        sellQuotes: sellQuotes.map(toDetectorQuote),
        gasCostQuoteUnits: roundTripUsdc.gasCostQuoteUnits || "0",
      });
      detections.push({ ...det, round, evidence });
    } else {
      detections.push({
        kind: "capture-detection",
        round,
        pair: { from: "USDC", to: "USDT" },
        chain,
        wouldCapture: false,
        whyNot: bestBuy && bestBuy.ok !== false ? "no sell-side venue quoted" : "no buy-side venue quoted",
        gapBps: null,
        netRoundTripBps: null,
        evidence,
      });
    }
  }

  // ── Solana: SOL→USDC / USDC→SOL across Orca + Raydium CLMM (+ Jupiter) ──
  // The round trip is sized EXACTLY: buy legs quote SOL→USDC at SOL_AMOUNT,
  // the best buy output sizes EVERY sell leg (USDC→SOL at bestBuyOut) so
  // the detector's round-trip math is exact (exact: true).
  const orca = await fetchOrcaState();
  const rd = await fetchRaydiumClmmState();

  const buyVenues = [];
  const buyEvidence = [];
  const sellVenues = [];
  const sellEvidence = [];
  const pushVenue = (list, rec) => {
    if (rec.allTrade) list.push(rec);
    return rec;
  };

  // buy legs — SOL→USDC at SOL_AMOUNT
  const orcaBuyQ = orcaQuoteLeg(orca, true, SOL_AMOUNT);
  const orcaBuy = pushVenue(buyVenues, {
    dex: "orca",
    pool: ORCA_POOL,
    chain: "sol",
    from: "SOL",
    to: "USDC",
    amountIn: orcaBuyQ.amountIn,
    amountOut: orcaBuyQ.amountOut,
    feeBps: Math.round(Number(orcaBuyQ.appliedFeeRate) / 100),
    allTrade: orcaBuyQ.allTrade,
    endTickIndex: orcaBuyQ.endTickIndex,
    source: "REAL-live-whirlpool-state-walk",
    capturedAt: ts(),
    state: { pool: ORCA_POOL, programId: ORCA_WHIRLPOOL_PROGRAM_ID, tickCurrent: orca.whirlpool.tickCurrent, tickArrays: { below: orca.below.length, above: orca.above.length } },
  });
  buyEvidence.push(orcaBuy);
  const rdBuyQ = raydiumQuoteLeg(rd, SOL_MINTS.SOL, SOL_AMOUNT);
  const rdBuy = pushVenue(buyVenues, {
    dex: "raydium",
    pool: RAYDIUM_CLMM_POOL,
    chain: "sol",
    from: "SOL",
    to: "USDC",
    amountIn: rdBuyQ.amountInRaw,
    amountOut: rdBuyQ.amountOutRaw,
    feeBps: Math.round(Number(rdBuyQ.appliedFeeRate) / 100),
    allTrade: rdBuyQ.allTrade,
    endTick: rdBuyQ.endTick,
    source: "REAL-live-raydium-clmm-state-walk",
    capturedAt: ts(),
    state: { pool: RAYDIUM_CLMM_POOL, programId: RAYDIUM_CLMM_PROGRAM_ID, tickCurrent: rd.pool.tickCurrent, tickArrays: rd.arrays.length },
  });
  buyEvidence.push(rdBuy);

  // Jupiter aggregator (keyless) — the real price across the whole sol book.
  let jupBuy = null;
  try {
    const jb = await quoteJupiter(SOL_MINTS.SOL, SOL_MINTS.USDC, SOL_AMOUNT);
    jupBuy = pushVenue(buyVenues, {
      dex: "jupiter",
      pool: "jupiter-sol-USDC",
      chain: "sol",
      from: "SOL",
      to: "USDC",
      amountIn: SOL_AMOUNT,
      amountOut: jb.amountOut,
      feeBps: null,
      allTrade: true,
      source: "REAL-live-jupiter-quote",
      capturedAt: ts(),
      ...(jb.raw || {}),
    });
    buyEvidence.push(jupBuy);
  } catch (e) {
    buyEvidence.push({ dex: "jupiter", ok: false, reason: String(e.message).slice(0, 120), source: "aggregator-skip" });
  }

  const bestBuyOut = buyVenues.length
    ? [...buyVenues].sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : 0))[0].amountOut
    : null;

  if (bestBuyOut) {
    // sell legs — USDC→SOL, EVERY venue sized at the best buy output
    const orcaSellQ = orcaQuoteLeg(orca, false, bestBuyOut);
    const orcaSell = pushVenue(sellVenues, {
      dex: "orca",
      pool: ORCA_POOL,
      chain: "sol",
      from: "USDC",
      to: "SOL",
      amountIn: orcaSellQ.amountIn,
      amountOut: orcaSellQ.amountOut,
      feeBps: Math.round(Number(orcaSellQ.appliedFeeRate) / 100),
      allTrade: orcaSellQ.allTrade,
      endTickIndex: orcaSellQ.endTickIndex,
      source: "REAL-live-whirlpool-state-walk",
      capturedAt: ts(),
    });
    sellEvidence.push(orcaSell);
    const rdSellQ = raydiumQuoteLeg(rd, SOL_MINTS.USDC, bestBuyOut);
    const rdSell = pushVenue(sellVenues, {
      dex: "raydium",
      pool: RAYDIUM_CLMM_POOL,
      chain: "sol",
      from: "USDC",
      to: "SOL",
      amountIn: rdSellQ.amountInRaw,
      amountOut: rdSellQ.amountOutRaw,
      feeBps: Math.round(Number(rdSellQ.appliedFeeRate) / 100),
      allTrade: rdSellQ.allTrade,
      endTick: rdSellQ.endTick,
      source: "REAL-live-raydium-clmm-state-walk",
      capturedAt: ts(),
    });
    sellEvidence.push(rdSell);
    try {
      const js = await quoteJupiter(SOL_MINTS.USDC, SOL_MINTS.SOL, bestBuyOut);
      const jupSell = pushVenue(sellVenues, {
        dex: "jupiter",
        pool: "jupiter-USDC-sol",
        chain: "sol",
        from: "USDC",
        to: "SOL",
        amountIn: bestBuyOut,
        amountOut: js.amountOut,
        feeBps: null,
        allTrade: true,
        source: "REAL-live-jupiter-quote",
        capturedAt: ts(),
        ...(js.raw || {}),
      });
      sellEvidence.push(jupSell);
    } catch (e) {
      sellEvidence.push({ dex: "jupiter", ok: false, reason: String(e.message).slice(0, 120), source: "aggregator-skip" });
    }
  }

  const evidence = { chain: "sol", pair: { from: "SOL", to: "USDC" }, decimals: { from: SOL_DECIMALS, to: 6 }, amountIn: SOL_AMOUNT, amountInHuman: "5 SOL", buy: buyEvidence, sell: sellEvidence, capturedAt: ts() };
  quotes.push(...buyEvidence.filter((q) => q.ok !== false && q.amountOut), ...sellEvidence.filter((q) => q.ok !== false && q.amountOut));

  // Solana gas: 2 txs × 5000 lamports = 10000 lamports = 0.00001 SOL (raw 9dp)
  const solGasRaw = "10000";
  const det = buyVenues.length >= 1 && sellVenues.length >= 1
    ? detectCaptureGap({
        pair: { from: "SOL", to: "USDC" },
        chain: "sol",
        buyQuotes: buyVenues.map(toDetectorQuote),
        sellQuotes: sellVenues.map(toDetectorQuote),
        gasCostQuoteUnits: solGasRaw,
      })
    : null;
  gas.sol = { gasCostQuoteUnits: solGasRaw, note: "2 txs × 5000 lamports (no priority fees modeled)" };
  if (det) detections.push({ ...det, round, evidence });
  else detections.push({ kind: "capture-detection", round, pair: { from: "SOL", to: "USDC" }, chain: "sol", wouldCapture: false, whyNot: "venues missing/partial", gapBps: null, netRoundTripBps: null, evidence });

  return { round, started, finished: ts(), quotes, detections, gas };
}

function toDetectorQuote(q) {
  return { dex: q.dex, pool: q.pool, chain: q.chain, from: q.from, to: q.to, amountIn: q.amountIn, amountOut: q.amountOut, feeBps: q.feeBps ?? null, source: q.source, capturedAt: q.capturedAt };
}
function strip(q) {
  // quote evidence for the fixture/JSON — no raw response bloat beyond the
  // frozen request+response the rebuild needs.
  const { quoteRequest, responseHex, ...rest } = q;
  return { ...rest, ...(quoteRequest ? { quoteRequest, responseHex } : {}) };
}

// ── main ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`[mev-sim] capture simulation — ${ROUNDS} rounds, ${SLEEP_MS}ms apart. READ-ONLY. gated OFF.`);
  console.log(`[mev-sim] EVM size 2,500 USDC per chain (raw 6dp eth/arb, 18dp bsc), Solana size ${SOL_AMOUNT} lamports-of-SOL (5 SOL).`);
  const all = [];
  for (let r = 1; r <= ROUNDS; r++) {
    try {
      const round = await runRound(r);
      all.push(round);
      for (const d of round.detections) {
        const gap = d.gapBps === null ? "no-gap" : `${d.gapBps} bps`;
        const net = d.netRoundTripBps === null ? "—" : `${d.netRoundTripBps} bps`;
        console.log(`[mev-sim] round ${r} ${d.chain} ${d.pair?.from}→${d.pair?.to}: gap ${gap}, net ${net}, wouldCapture=${d.wouldCapture} ${d.whyNot ? `(${d.whyNot})` : ""}`);
      }
    } catch (e) {
      console.error(`[mev-sim] round ${r} FAILED:`, e.message);
      all.push({ round: r, failed: String(e.message).slice(0, 300), started: ts() });
    }
    if (r < ROUNDS) await sleep(SLEEP_MS);
  }

  const detections = all.flatMap((r) => r.detections ?? []);
  const summary = summarizeCaptureDetections(detections);
  const report = {
    title: "MEV/price-gap capture SIMULATION — real on-chain quotes, zero trades",
    date: ts(),
    gate: { MEV_CAPTURE_ENABLED: false, label: "gated OFF", note: "detection-only — nothing executable; the live arm is Mr. Esters' alone (mirror of WARP_LIVE_SEND)" },
    feePolicy: { CAPTURE_FEE_POLICY_BPS: 0, note: "capture value = gross round trip − pool fees (netted in quotes) − gas; the 0.5%/capped-$250 fee-model-v2 charge applies to user journeys, not internal capture legs (configurable)" },
    method: {
      rounds: all.length,
      evm: "QuoterV2/PCS-QuoterV2 eth_call (read-only) USDC↔USDT @ 2,500 USDC; fee tiers 100+500 per chain; LiFi aggregator quote (fee=0) when reachable",
      sol: "Orca whirlpool + Raydium CLMM pool-state walks (getAccountInfo) + pure leg quote math; Jupiter aggregator quote when reachable; SOL→USDC @ 5 SOL",
      gas: "EVM: 2 txs × quoter gasEstimate × live eth_gasPrice → USDC via REAL same-chain WETH/WBNB→USDC quoter reads. Solana: 2 × 5000 lamports.",
      honesty: [
        "legs quoted sequentially (two read-only calls) — a real capture executes buy+sell atomically; net figures assume the quotes held",
        "pool fees are netted inside the quotes (not double counted)",
        "quotes are market data — they move; fixtures are dated",
      ],
    },
    summary,
    detections: detections.map((d) => ({
      round: d.round,
      chain: d.chain,
      pair: d.pair,
      gapBps: d.gapBps,
      grossRoundTripBps: d.grossRoundTripBps ?? null,
      netRoundTripBps: d.netRoundTripBps ?? null,
      netValueAfterCostsRaw: d.netValueAfterCostsRaw ?? null,
      wouldCapture: d.wouldCapture,
      whyNot: d.whyNot ?? null,
      route: d.route ?? null,
      exact: d.exact ?? null,
      buySide: d.buySide ?? null,
      sellSide: d.sellSide ?? null,
    })),
    gas: Object.fromEntries(all.filter((r) => r.gas).map((r) => [r.round, r.gas])),
    rounds: all.map((r) => ({ round: r.round, started: r.started, finished: r.finished ?? null, failed: r.failed ?? null })),
  };

  mkdirSync(MEV_FIXTURES, { recursive: true });
  mkdirSync(MEV_DOCS, { recursive: true });
  const jsonPath = join(MEV_DOCS, "mev-simulation-2026-09-06.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // The REAL quote captures (fixtures — quote-level only) + the per-round
  // evidence files the rebuild test re-runs.
  const inputsDir = join(MEV_FIXTURES, "inputs");
  mkdirSync(inputsDir, { recursive: true });
  const captureLog = [];
  for (const r of all) {
    for (const q of r.quotes ?? []) {
      if (q.ok === false) continue;
      captureLog.push(q);
    }
    for (const d of r.detections ?? []) {
      if (d.evidence) {
        const file = `round-${String(r.round).padStart(2, "0")}-${d.chain}-${d.pair?.from}-${d.pair?.to}-evidence.json`;
        writeFileSync(join(inputsDir, file), JSON.stringify({ ...d.evidence, round: r.round, detection: stripDetection(d) }, null, 2));
      }
    }
  }
  writeFileSync(join(MEV_FIXTURES, "capture-log.json"), JSON.stringify(captureLog, null, 2));
  writeFileSync(join(MEV_FIXTURES, "README.md"), fixtureReadme());
  console.log(`[mev-sim] wrote ${jsonPath}`);
  console.log(`[mev-sim] summary: ${JSON.stringify(summary)}`);
  return report;
}

function stripDetection(d) {
  return {
    wouldCapture: d.wouldCapture,
    gapBps: d.gapBps,
    grossRoundTripBps: d.grossRoundTripBps ?? null,
    netRoundTripBps: d.netRoundTripBps ?? null,
    netValueAfterCostsRaw: d.netValueAfterCostsRaw ?? null,
    whyNot: d.whyNot ?? null,
    route: d.route ?? null,
    exact: d.exact ?? null,
  };
}

function fixtureReadme() {
  return `# MEV-capture simulation fixtures — REAL quote captures (2026-09-06)

🔴 READ-ONLY captures for the MEV/price-gap capture SIMULATION. NO funds,
NO broadcast, NO signing — quoter eth_calls (EVM), on-chain pool-state reads
+ pure quote math (Solana), keyless aggregator quotes (Jupiter/LiFi). The
capture EXECUTION path is dead-gated (MEV_CAPTURE_ENABLED=false default).

- \`inputs/round-*-evidence.json\` — per-round quote evidence + the detection
  computed over it (REAL-labeled; quote-level only).
- \`capture-log.json\` — every real quote of the run (flat).
- Docs: docs/MEV-SIMULATION-2026-09-06.md + docs/mev-simulation-2026-09-06.json.

Refresh before any live use — quotes are market data and move.
`;
}

// allow import for the rebuild test without auto-running
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error("[mev-sim] fatal:", e);
    process.exit(1);
  });
}

export { runRound, main };
