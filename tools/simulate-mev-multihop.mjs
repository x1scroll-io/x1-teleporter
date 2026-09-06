/**
 * simulate-mev-multihop.mjs — the MULTI-HOP ROUTE-CHOICE CAPTURE SIMULATION
 * harness (the framing correction — Mr. Esters, 2026-09-06).
 *
 * 🔴 HARD LIMITS (Mr. Esters — absolute): NO live trades, NO broadcasting
 * funds, NO signing. Everything here is READ-ONLY:
 *   - EVM: quoter eth_call (static calls — the same read-only quote path the
 *     dexDirect legs use) + eth_gasPrice.
 *   - Solana: getAccountInfo pool-state reads (whirlpool / raydium-clmm /
 *     raydium-cpmm vaults) + the pure quote math the legs use.
 *   - X1: getAccountInfo vault reads (public RPC) + the xdexQuote math.
 *   - Aggregators: keyless public quote APIs (Jupiter / LiFi), graceful skip.
 * The route analyzer (src/lib/mev/routeAnalyzer.js) runs over the REAL
 * per-leg-per-venue quotes and the report quantifies what best-venue routing
 * WOULD have captured per hop + accumulated across each journey — gated OFF
 * by default (MEV_CAPTURE_ENABLED=false; every report line carries
 * "(gated OFF)"). ZERO trades.
 *
 * THE MODEL (see src/lib/mev/routeAnalyzer.js): a user journey = an ordered
 * list of LEGS (swaps + bridges). For each leg the engine has venue CHOICE
 * (DEX_DIRECT_FALLBACKS / CAPTURE_CANDIDATES + the bridge options) and the
 * quotes are already on the wire. The capturable value per hop = the delta
 * between the venue the engine ROUTED (the DEX_DIRECT_FALLBACKS default =
 * aggregator-first; the "agg-down" variants route the DIRECT fallback — the
 * scenario the fallback registry exists for) and the BEST venue for that
 * hop. The ACCUMULATED route capture = the per-leg nets summed across the
 * whole journey — concentrated on the APING flow (any-to-any routes ending
 * at volatile/exotic destinations).
 *
 * WHAT IT PRODUCES (the deliverable proof — real state, real per-hop venue
 * deltas, zero trades):
 *   - test/fixtures/golden/mev-multihop/inputs/route-*.json — the REAL
 *     per-leg quote captures (REAL-labeled, quote-level only; dated;
 *     refresh before live use — markets move).
 *   - docs/mev-multihop-simulation-2026-09-06.json — the machine report.
 *   - (docs/MEV-MULTIHOP-SIMULATION-2026-09-06.md — built offline by
 *     tools/mev-multihop-report-build.mjs.)
 *
 * Usage:
 *   node tools/simulate-mev-multihop.mjs [--rounds=N] [--sleep=MS]
 * Requires network egress to the public RPCs below (THORChain hosts and the
 * Rango mainnet API are NOT reachable keyless from this environment — the
 * native→SOL leg is documented with the repo's REAL Rango capture instead;
 * see ROUTE LEGEND in the report).
 *
 * HONESTY NOTES (read before quoting the numbers):
 *   • Every leg's venues are quoted at the SAME amountIn (the size the
 *     journey's CHOSEN path delivers to that leg). When the best venue
 *     differs from the chosen venue the downstream legs would carry
 *     slightly more — the recorded route is the CHOSEN path's journey with
 *     per-leg best-venue deltas measured at that leg's actual size
 *     (rate-implied exactness is flagged per leg by the analyzer).
 *   • Pool/bridge fees are netted inside every quote (quoter eth_call /
 *     pool-state walk / aggregator net output). The analyzer never
 *     subtracts them twice.
 *   • USD conversions are REAL same-round rates only: stable pairs ≈ $1 by
 *     peg construction (~1e-3 tolerance, documented — the same convention
 *     as the single-pair sim); SOL legs value through the round's own real
 *     SOL→USDC venue quotes; the exotic (sol) leg values through the
 *     round's own real Jupiter USDC→EXOTIC quote; the X1 exotic leg values
 *     through the XDEX pool's own real vault reserves × the round's real
 *     SOL price. No synthetic prices anywhere.
 *   • Quotes are market data — they move; fixtures are dated.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";

import { EVM_ADDRESS } from "../test/golden/forwardLegBuilders.mjs";
import { shapeQuoterCall, parseQuoterResponse } from "../src/engine/legs/dexDirect/evmV3.js";
import {
  decodeWhirlpoolState,
  decodeWhirlpoolTickArray,
  whirlpoolQuote,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  ORCA_TICK_ARRAY_SIZE,
  whirlpoolTickArrayPda,
  whirlpoolStartTick,
} from "../src/engine/legs/dexDirect/orcaSwapLeg.js";
import {
  decodeRaydiumClmmPool,
  decodeRaydiumClmmConfig,
  decodeRaydiumClmmTickArray,
  raydiumClmmQuote,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_CLMM_TICK_ARRAY_SIZE,
  raydiumClmmTickArrayPda,
  raydiumClmmArrayStart,
  decodeRaydiumCpmmPool,
  decodeRaydiumCpmmConfig,
  raydiumCpmmQuote,
} from "../src/engine/legs/dexDirect/raydiumSwapLeg.js";
import { xdexQuote } from "../src/engine/legs/dex/xdexSwapLeg.js";
import { analyzeRoute, summarizeRouteAnalyses } from "../src/lib/mev/routeAnalyzer.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..");
export const MEV_MH_FIXTURES = join(REPO, "test", "fixtures", "golden", "mev-multihop");
export const MEV_DOCS = join(REPO, "docs");

const args = process.argv.slice(2);
const argNum = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};
const ROUNDS = argNum("rounds", 2);
const SLEEP_MS = argNum("sleep", 8000);

// ── RPC endpoints (public / keyless — same hosts the dex-direct capture
//    tool + the single-pair sim use; nothing here needs an API key) ────────
const RPC = {
  eth: "https://ethereum-rpc.publicnode.com",
  sol: "https://berty-633y20-fast-mainnet.helius-rpc.com",
  x1: "https://rpc.mainnet.x1.xyz",
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

// ── token registry (the app's pairs + the exotic destinations) ─────────────
const EVM = {
  eth: {
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    WETH_FEE: 500,
    UNISWAP_QUOTER: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  },
};
const SOL_MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
/** The REAL Solana-side exotic destination — the Raydium CPMM pool
 *  DvjbE…/USDC (a real low-liquidity micro-cap token; 9dp). Live state read
 *  per round (pool + config + both vaults). */
const EXOTIC_SOL = {
  symbol: "EXOTIC(sol)",
  mint: "DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV",
  decimals: 9,
  pool: "5KXE8RMF7iW9Ptn665AHfzsMFjYb4LV2Ta8eZEtsTwWC",
  config: "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2",
  vaultA: "7jzdRNd8rutdT38CKGkSeuaBmQDyucFJfbh6WEfwnDss", // EXOTIC vault
  vaultB: "AQrpuddRvJeVvbBbtQrUdV8YFeh3om9eyBQX2h5ojKh2", // USDC vault
};
/** The REAL X1-side exotic destination — the XDEX CP pool SOL/B69ch…
 *  (Token-2022; 6dp) — the "land as any token" lane. Pool fields + fee
 *  config are the repo's frozen LIVE capture (2026-09-02,
 *  test/fixtures/golden/dex-leg/xdex-pool-snapshot.json — the XDEX program
 *  layout has no in-repo decoder, so the static fields are the frozen
 *  capture and the VAULT BALANCES are refreshed live per round (official
 *  SPL token-account layout — amount at offset 64). Fee rates are
 *  admin-set ammConfig constants (tradeFeeRate 2800 → 28 bps). */
const EXOTIC_X1 = {
  symbol: "EXOTIC(x1)",
  mint: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq",
  decimals: 6,
  vault0Addr: "8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb", // SOL vault (token0)
  vault1Addr: "7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg", // B69ch vault (token1)
};
const ORCA_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"; // SOL/USDC whirlpool
const RAYDIUM_CLMM_POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv"; // SOL/USDC CLMM
const QUOTER_UNI = EVM.eth.UNISWAP_QUOTER;

const ts = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── EVM quote (read-only quoter eth_call — the dexDirect leg path) ────────
async function quoteEvmDirect({ tokenIn, tokenOut, amount, fee = 500 }) {
  const req = shapeQuoterCall({
    quoter: QUOTER_UNI,
    tokenIn: EVM.eth[tokenIn],
    tokenOut: EVM.eth[tokenOut],
    amountIn: String(amount),
    fee,
    chain: "eth",
  });
  let hex;
  try {
    hex = await rpc("eth", "eth_call", [{ to: req.to, data: req.data }, "latest"]);
  } catch (e) {
    return { ok: false, reason: `revert: ${String(e.message).slice(0, 120)}`, tokenIn, tokenOut, amountIn: String(amount), fee };
  }
  const p = parseQuoterResponse(hex);
  return {
    ok: true,
    venue: "uniswap",
    pool: `uniswap-eth-${tokenIn}-${tokenOut}-f${fee}`,
    chain: "eth",
    from: tokenIn,
    to: tokenOut,
    amountIn: String(amount),
    amountOut: p.amountOut,
    fee,
    feeBps: fee / 100,
    gasEstimate: p.gasEstimate,
    source: "REAL-live-quoter-eth_call",
    capturedAt: ts(),
    rpc: RPC.eth,
  };
}

async function gasPrice(chain) {
  const hex = await rpc(chain, "eth_gasPrice", []);
  return BigInt(hex);
}

/** Convert an EVM gas cost (wei) to USDC $ via a REAL same-chain WETH→USDC
 *  quoter read (the single-pair sim's path — no synthetic prices). */
async function gasWeiToUsd(chain, wei) {
  try {
    const req = shapeQuoterCall({
      quoter: QUOTER_UNI,
      tokenIn: EVM.eth.WETH,
      tokenOut: EVM.eth.USDC,
      amountIn: wei.toString(),
      fee: 500,
      chain: "eth",
    });
    const hex = await rpc(chain, "eth_call", [{ to: req.to, data: req.data }, "latest"]);
    const p = parseQuoterResponse(hex);
    return Number(BigInt(p.amountOut)) / 1e6;
  } catch {
    return null;
  }
}

/** EVM direct-venue gas in $ (real gasPrice × real WETH→USDC conversion). */
async function evmGasUsd(gasUnits) {
  try {
    const gwei = await gasPrice("eth");
    const wei = BigInt(gasUnits || 120000) * gwei;
    const usd = await gasWeiToUsd("eth", wei);
    return usd;
  } catch {
    return null;
  }
}

// ── LiFi quotes (keyless — the same-chain EVM swap venue + the EVM→SOL
//    bridge venue; the repo's own lane) ────────────────────────────────────
const SOLANA_ADDRESS = "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";
async function quoteLifi({ fromChain, toChain, fromToken, toToken, fromAmount, toAddress = null }) {
  const url =
    `https://li.quest/v1/quote?fromChain=${fromChain}&toChain=${toChain}` +
    `&fromToken=${fromToken}&toToken=${toToken}&fromAmount=${fromAmount}` +
    `&fromAddress=${EVM_ADDRESS}${toAddress ? `&toAddress=${toAddress}` : ""}` +
    `&slippage=0.005&integrator=x1-teleporter-labs&fee=0`;
  const r0 = await fetch(url, { headers: { accept: "application/json" } });
  if (!r0.ok) {
    const t = await r0.text().catch(() => "");
    throw new Error(`lifi HTTP ${r0.status} ${String(t).slice(0, 120)}`);
  }
  let j = await r0.json().catch(() => null);
  if (!j || j?.error || !j?.estimate?.toAmount) {
    // transient LiFi flap (route availability rotates between tools) — one
    // retry before giving up; the flap itself is documented report context
    await sleep(900);
    const r2 = await fetch(url, { headers: { accept: "application/json" } });
    if (r2.ok) {
      j = await r2.json().catch(() => null);
    }
  }
  if (!j || j?.error || !j?.estimate?.toAmount) throw new Error(`lifi: ${j?.message ?? "no estimate"}`);
  return {
    amountOut: j.estimate.toAmount,
    feeCostsUsd: (j.estimate.feeCosts || []).map((f) => Number(f.amountUSD ?? 0)).reduce((a, b) => a + b, 0),
    gasCostsUsd: (j.estimate.gasCosts || []).map((g) => Number(g.amountUSD ?? 0)).reduce((a, b) => a + b, 0),
    tool: j.tool ?? null,
  };
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

async function fetchOrcaState() {
  const raw = await getAccountRobust(ORCA_POOL);
  if (!raw) throw new Error(`orca: pool ${ORCA_POOL} not found`);
  const wp = decodeWhirlpoolState(Buffer.from(raw.dataBase64, "base64"), ORCA_POOL);
  const spacing = wp.tickSpacing;
  const start0 = whirlpoolStartTick(wp.tickCurrent, spacing);
  const arrays = [];
  for (const off of [0, -1, -2, -3, 1, 2, 3]) {
    const start = start0 + off * spacing * ORCA_TICK_ARRAY_SIZE;
    const addr = await whirlpoolTickArrayPda(ORCA_POOL, start);
    const aRaw = await getAccountRobust(addr);
    if (!aRaw) continue;
    const arr = decodeWhirlpoolTickArraySafe(aRaw, spacing);
    if (arr) arrays.push(arr);
  }
  const containing = arrays.find((a) => a.startTickIndex === start0);
  if (!containing) throw new Error("orca: containing tick array absent");
  const below = arrays.filter((a) => a.startTickIndex <= start0).sort((a, b) => b.startTickIndex - a.startTickIndex);
  const above = arrays.filter((a) => a.startTickIndex >= start0).sort((a, b) => a.startTickIndex - b.startTickIndex);
  return { programId: ORCA_WHIRLPOOL_PROGRAM_ID, pool: ORCA_POOL, whirlpool: wp, below, above };
}
function decodeWhirlpoolTickArraySafe(raw, spacing) {
  try {
    const arr = decodeWhirlpoolTickArray(Buffer.from(raw.dataBase64, "base64"), spacing);
    arr.address = raw.address ?? null;
    arr.capturedLen = raw.len;
    return arr;
  } catch {
    return null;
  }
}

function orcaQuoteLeg(state, aToB, amountInRaw) {
  const tickArrays = aToB ? state.below : state.above;
  try {
    return whirlpoolQuote({ snapshot: { whirlpool: state.whirlpool, tickArrays }, amount: amountInRaw, amountSpecifiedIsInput: true, aToB });
  } catch (e) {
    return { error: String(e.message).slice(0, 160) };
  }
}

async function fetchRaydiumClmmState() {
  const raw = await getAccountRobust(RAYDIUM_CLMM_POOL);
  if (!raw) throw new Error(`raydium clmm: pool ${RAYDIUM_CLMM_POOL} not found`);
  const poolState = decodeRaydiumClmmPool(Buffer.from(raw.dataBase64, "base64"), RAYDIUM_CLMM_POOL);
  const cfgRaw = await getAccountRobust(poolState.configId);
  if (!cfgRaw) throw new Error("raydium clmm: config absent");
  const config = decodeRaydiumClmmConfig(Buffer.from(cfgRaw.dataBase64, "base64"));
  const spacing = poolState.tickSpacing;
  const start0 = raydiumClmmArrayStart(poolState.tickCurrent, spacing);
  const arrays = [];
  for (const off of [0, -1, -2, -3, 1, 2, 3]) {
    const start = start0 + off * spacing * RAYDIUM_CLMM_TICK_ARRAY_SIZE;
    const addr = await raydiumClmmTickArrayPda(RAYDIUM_CLMM_POOL, start);
    const aRaw = await getAccountRobust(addr);
    if (!aRaw) continue;
    const arr = decodeRaydiumClmmTickArray(Buffer.from(aRaw.dataBase64, "base64"), spacing, RAYDIUM_CLMM_POOL);
    arr.address = addr;
    arr.capturedLen = aRaw.len;
    arrays.push(arr);
  }
  const containing = arrays.find((a) => a.startTickIndex === start0);
  if (!containing) throw new Error("raydium clmm: containing tick array absent");
  return { programId: RAYDIUM_CLMM_PROGRAM_ID, poolAddress: RAYDIUM_CLMM_POOL, pool: poolState, config, arrays, start0 };
}

function raydiumClmmQuoteLeg(state, inputMint, amountInRaw) {
  try {
    return raydiumClmmQuote({ snapshot: { pool: state.pool, config: state.config, tickArrays: state.arrays }, inputMint, amountInRaw });
  } catch (e) {
    return { error: String(e.message).slice(0, 160) };
  }
}

/** Fetch the exotic CPMM pool state (pool + config + both vault balances). */
async function fetchExoticCpmmState() {
  const raw = await getAccountRobust(EXOTIC_SOL.pool);
  const cfgRaw = await getAccountRobust(EXOTIC_SOL.config);
  const vaRaw = await getAccountRobust(EXOTIC_SOL.vaultA);
  const vbRaw = await getAccountRobust(EXOTIC_SOL.vaultB);
  const pool = decodeRaydiumCpmmPool(Buffer.from(raw.dataBase64, "base64"), EXOTIC_SOL.pool);
  const config = decodeRaydiumCpmmConfig(Buffer.from(cfgRaw.dataBase64, "base64"));
  const vaultFrom = (acc, pubkey, mint) => ({
    pubkey,
    owner: acc.owner,
    mint,
    amountRaw: splTokenAccountAmount(acc),
  });
  return {
    pool,
    config,
    vaultA: vaultFrom(vaRaw, EXOTIC_SOL.vaultA, pool.mintA),
    vaultB: vaultFrom(vbRaw, EXOTIC_SOL.vaultB, pool.mintB),
  };
}
/** The official SPL token-account amount (bytes 64..72 LE — the base layout
 *  shared by legacy Token and Token-2022). */
function splTokenAccountAmount(acc) {
  const buf = Buffer.from(acc.dataBase64, "base64");
  if (buf.length < 72) throw new Error(`token account too short (${buf.length})`);
  return BigInt(`0x${buf.subarray(64, 72).reverse().toString("hex")}`).toString();
}

function exoticCpmmQuoteLeg(state, inputMint, amountInRaw) {
  try {
    return raydiumCpmmQuote({ snapshot: state, inputMint, amountInRaw, slippageBps: 100 });
  } catch (e) {
    return { error: String(e.message).slice(0, 160) };
  }
}

// ── Jupiter quotes (keyless — the Solana aggregator venue) ────────────────
async function quoteJupiter(inputMint, outputMint, amount) {
  const url =
    `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amount}&slippageBps=100&onlyDirectRoutes=false&maxAccounts=30`;
  await sleep(900); // the keyless endpoint rate-limits hard — pace the calls
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`jupiter HTTP ${r.status}`);
      const j = await r.json();
      if (!j?.outAmount) throw new Error("jupiter: no outAmount in quote");
      return {
        amountOut: String(j.outAmount),
        raw: {
          priceImpactPct: j.priceImpactPct ?? null,
          routePlanLength: j.routePlan?.length ?? null,
          routes: j.routes?.length ?? null,
        },
      };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ── X1 xdex state refresh (vault balances live; static fields frozen) ─────
function xdexStaticSnapshot() {
  const file = join(REPO, "test", "fixtures", "golden", "dex-leg", "xdex-pool-snapshot.json");
  return JSON.parse(readFileSync(file, "utf8"));
}
async function refreshXdexVaults() {
  const snap = xdexStaticSnapshot();
  const mk = async (addr, label) => {
    const a = await rpc("x1", "getAccountInfo", [addr, { encoding: "base64" }]);
    const v = a?.value;
    if (!v) throw new Error(`xdex ${label} vault ${addr} not found`);
    return { pubkey: addr, owner: v.owner, mint: label === "vault0" ? snap.token0.mint : snap.token1.mint, amountRaw: splTokenAccountAmount({ dataBase64: v.data[0], len: v.data[0].length, owner: v.owner }) };
  };
  const vault0 = await mk(EXOTIC_X1.vault0Addr, "vault0");
  const vault1 = await mk(EXOTIC_X1.vault1Addr, "vault1");
  return { ...snap, vault0, vault1, capturedAt: ts() };
}

// ── the ROUTE CATALOG (realistic journeys per the teleportRail coverage
//    matrix — COVERAGE_MATRIX — and the DEX_DIRECT_FALLBACKS order) ────────
//
// Venue labels: "jupiter" | "orca" | "raydium" | "raydium-cpmm" | "lifi" |
// "uniswap" | "xdex". venueChosen per route = the routing state modeled:
//   * "agg-up"   — the DEX_DIRECT_FALLBACKS default (aggregator first:
//                  jupiter on sol, lifi on evm). When the aggregator IS the
//                  best venue the route is already-optimal (capture 0).
//   * "agg-down" — the aggregator is unavailable → the engine routes the
//                  DIRECT fallback (orca/raydium/cpmm/uniswap-direct). The
//                  best-venue delta is then the value best-venue routing
//                  would have restored (the reason the fallback registry +
//                  the analyzer exist).
//
// startUsd ~ $2,500 per journey (the console's real sizes) except the $10k
// size-effect route. Native-source (BTC/DOGE/…) journeys are documented —
// the native→SOL leg is NOT re-quotable in this environment (Rango mainnet
// is server-keyed, THORChain hosts are egress-blocked; the repo's REAL
// Rango capture 2026-09-05 is pinned in test/fixtures/golden/rango-leg/) —
// the measurable venue choice is the SOL-side journey (the rail matrix's
// own landing shape: native → SOL.SOL then the Solana DEX legs).

/** One route definition: { id, legend, startAmountRaw, legs: [...] } — each
 *  leg: { hop, from, to, chain, kind, venueChosen, options: [venue ids the
 *  harness quotes for this leg] } + the quoting config the harness maps. */
const ROUTE_DEFS = [
  {
    id: "sol-ape-2500-down",
    legend: "SOL → USDC → EXOTIC(sol) @ ~$2,550 (25 SOL). Aggregator-DOWN routing: orca then the direct CPMM — the DEX_DIRECT_FALLBACKS scenario. Destination: a real low-liquidity Solana token (Raydium CPMM pool DvjbE…/USDC).",
    start: { amount: "25000000000", unit: "SOL" }, // 25 SOL ≈ $2,550
    legs: [
      { hop: 1, from: "SOL", to: "USDC", chain: "sol", kind: "swap", venueChosen: "orca", options: ["jupiter", "orca", "raydium"] },
      { hop: 2, from: "USDC", to: "EXOTIC(sol)", chain: "sol", kind: "swap", venueChosen: "raydium-cpmm", options: ["jupiter", "raydium-cpmm"] },
    ],
  },
  {
    id: "sol-ape-2500-up",
    legend: "SOL → USDC → EXOTIC(sol) @ ~$2,550. Aggregator-UP routing (jupiter both legs — the DEX_DIRECT_FALLBACKS default). Contrast: when the aggregator is up AND best, route-choice value ≈ 0.",
    start: { amount: "25000000000", unit: "SOL" },
    legs: [
      { hop: 1, from: "SOL", to: "USDC", chain: "sol", kind: "swap", venueChosen: "jupiter", options: ["jupiter", "orca", "raydium"] },
      { hop: 2, from: "USDC", to: "EXOTIC(sol)", chain: "sol", kind: "swap", venueChosen: "jupiter", options: ["jupiter", "raydium-cpmm"] },
    ],
  },
  {
    id: "sol-ape-10000-down",
    legend: "SOL → USDC → EXOTIC(sol) @ ~$10,000 (98 SOL). Aggregator-DOWN — the SIZE effect on the exotic leg's venue spread (the ape case at a bigger notional).",
    start: { amount: "98000000000", unit: "SOL" },
    legs: [
      { hop: 1, from: "SOL", to: "USDC", chain: "sol", kind: "swap", venueChosen: "orca", options: ["jupiter", "orca", "raydium"] },
      { hop: 2, from: "USDC", to: "EXOTIC(sol)", chain: "sol", kind: "swap", venueChosen: "raydium-cpmm", options: ["jupiter", "raydium-cpmm"] },
    ],
  },
  {
    id: "btc-ape-2500-down",
    legend: "NATIVE-SOURCE ape (BTC → SOL → USDC → EXOTIC(sol), ~$2,550). The BTC→SOL leg is NOT re-quotable in this environment (Rango mainnet = server-keyed; THORChain hosts = egress-blocked; REAL Rango capture 2026-09-05 pinned in test/fixtures/golden/rango-leg/) — the measurable venue choice is the SOL-side journey the native rail lands into. Aggregator-DOWN routing on the Solana legs.",
    start: { amount: "25000000000", unit: "SOL" },
    legs: [
      { hop: 1, from: "SOL", to: "USDC", chain: "sol", kind: "swap", venueChosen: "orca", options: ["jupiter", "orca", "raydium"] },
      { hop: 2, from: "USDC", to: "EXOTIC(sol)", chain: "sol", kind: "swap", venueChosen: "raydium-cpmm", options: ["jupiter", "raydium-cpmm"] },
    ],
  },
  {
    id: "evm-ape-2500-down",
    legend: "EVM ape (WETH → USDC on Ethereum → LiFi bridge → USDC on Solana → EXOTIC(sol)) @ ~$2,550. Leg 1 = the EVM aggregator-vs-direct venue choice (lifi vs uniswap v3 f500 — DEX_DIRECT_FALLBACKS.evm.eth). Leg 2 = the EVM→SOL bridge (one serving carrier today — single venue, contributes 0, honest). Leg 3 = the Solana ape leg. Aggregator-DOWN routing on legs 1 + 3.",
    start: { amount: "1000000000000000000", unit: "WETH" }, // 1 WETH ≈ $2,550
    legs: [
      { hop: 1, from: "WETH", to: "USDC", chain: "eth", kind: "swap", venueChosen: "uniswap", options: ["lifi", "uniswap"] },
      { hop: 2, from: "USDC", to: "USDC", chain: "eth→sol", kind: "bridge", venueChosen: "lifi", options: ["lifi"] },
      { hop: 3, from: "USDC", to: "EXOTIC(sol)", chain: "sol", kind: "swap", venueChosen: "raydium-cpmm", options: ["jupiter", "raydium-cpmm"] },
    ],
  },
  {
    id: "evm-x1-stable-2500-down",
    legend: "EVM stable → X1 (the bridge's REAL flow to a STABLE destination — USDC.x via the Warp hop; the 0.5% Warp skim is invariant across venue choices and documented, not quoted). Leg 1 = the EVM aggregator-vs-direct swap; leg 2 = the bridge. No exotic destination — the honest control: stable-heavy journeys carry only the liquid-pair venue deltas.",
    start: { amount: "1000000000000000000", unit: "WETH" },
    legs: [
      { hop: 1, from: "WETH", to: "USDC", chain: "eth", kind: "swap", venueChosen: "uniswap", options: ["lifi", "uniswap"] },
      { hop: 2, from: "USDC", to: "USDC", chain: "eth→sol", kind: "bridge", venueChosen: "lifi", options: ["lifi"] },
    ],
  },
  {
    id: "x1-exotic-2500-down",
    legend: "EVM stable → X1 EXOTIC (USDC on Ethereum → LiFi → USDC on Solana → SOL on Solana → Warp → wSOL.X on X1 → XDEX → EXOTIC(x1) B69ch…, ~$2,550) — the full 'land as any token' flow to a fresh X1 token. Leg 2 = the Solana USDC→SOL venue choice (aggregator-DOWN: orca routed); legs 1/3/4 = single-venue rails (bridge / Warp / X1's only DEX — contribute 0, honest: X1 has ONE DEX, so route-choice value concentrates on the Solana-side legs). The Warp hop (0.5% skim) is documented, not quoted; the XDEX leg is quoted live (vault balances refreshed this round) at the journey size.",
    start: { amount: "2500000000", unit: "USDC" }, // $2,500 (6dp)
    legs: [
      { hop: 1, from: "USDC", to: "USDC", chain: "eth→sol", kind: "bridge", venueChosen: "lifi", options: ["lifi"] },
      { hop: 2, from: "USDC", to: "SOL", chain: "sol", kind: "swap", venueChosen: "orca", options: ["jupiter", "orca", "raydium"] },
      { hop: 3, from: "SOL", to: "wSOL.X", chain: "sol→x1", kind: "bridge", venueChosen: "warp", options: ["warp"] },
      { hop: 4, from: "wSOL.X", to: "EXOTIC(x1)", chain: "x1", kind: "swap", venueChosen: "xdex", options: ["xdex"] },
    ],
  },
];

// ── per-leg quote fetch: every option venue at the leg's size ─────────────
async function quoteLegVenues({ leg, amountInRaw, states }) {
  const out = [];
  const cacheKey = `${leg.chain}|${leg.from}|${leg.to}|${amountInRaw}`;
  const push = (q) => {
    if (q && q.ok !== false && q.amountOut !== undefined && q.amountOut !== null && BigInt(String(q.amountOut)) > 0n) out.push(q);
  };
  // Per-round success cache (identical legs across routes — the btc-ape and
  // sol-ape down-variants share hop sizes): quotes are market data, so the
  // cache is ROUND-scoped (never across rounds).
  const cache = states?.quoteCache ?? null;
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey).map((q) => ({ ...q }));
  }
  const hits = [];
  for (const venue of leg.options) {
    try {
      if (venue === "jupiter") {
        // input mint depends on the leg's from token
        const inputMint = leg.from === "SOL" ? SOL_MINTS.SOL : leg.from === "USDC" ? SOL_MINTS.USDC : null;
        const outputMint = leg.to === "USDC" ? SOL_MINTS.USDC : leg.to === "SOL" ? SOL_MINTS.SOL : leg.to === "EXOTIC(sol)" ? EXOTIC_SOL.mint : null;
        if (!inputMint || !outputMint) throw new Error(`jupiter: unsupported leg ${leg.from}→${leg.to}`);
        const j = await quoteJupiter(inputMint, outputMint, amountInRaw);
        push({
          venue,
          pool: `jupiter-${leg.from}-${leg.to}`,
          chain: "sol",
          from: leg.from,
          to: leg.to,
          amountIn: String(amountInRaw),
          amountOut: j.amountOut,
          feeBps: null,
          source: "REAL-live-jupiter-quote",
          capturedAt: ts(),
          ...(j.raw || {}),
        });
      } else if (venue === "orca") {
        const q = orcaQuoteLeg(states.orca, leg.from === "SOL", String(amountInRaw));
        if (q.error) push({ venue, ok: false, reason: q.error, amountIn: String(amountInRaw), from: leg.from, to: leg.to, source: "skip" });
        else
          push({
            venue,
            pool: ORCA_POOL,
            chain: "sol",
            from: leg.from,
            to: leg.to,
            amountIn: q.amountIn,
            amountOut: q.amountOut,
            feeBps: Math.round(Number(q.appliedFeeRate) / 100),
            source: "REAL-live-whirlpool-state-walk",
            capturedAt: ts(),
            state: { pool: ORCA_POOL, programId: ORCA_WHIRLPOOL_PROGRAM_ID, tickCurrent: states.orca.whirlpool.tickCurrent },
          });
      } else if (venue === "raydium") {
        const inputMint = leg.from === "SOL" ? SOL_MINTS.SOL : leg.from === "USDC" ? SOL_MINTS.USDC : null;
        if (!inputMint) throw new Error(`raydium: unsupported leg ${leg.from}→${leg.to}`);
        const q = raydiumClmmQuoteLeg(states.raydium, inputMint, String(amountInRaw));
        if (q.error) push({ venue, ok: false, reason: q.error, amountIn: String(amountInRaw), from: leg.from, to: leg.to, source: "skip" });
        else
          push({
            venue,
            pool: RAYDIUM_CLMM_POOL,
            chain: "sol",
            from: leg.from,
            to: leg.to,
            amountIn: q.amountInRaw,
            amountOut: q.amountOutRaw,
            feeBps: Math.round(Number(q.appliedFeeRate) / 100),
            source: "REAL-live-raydium-clmm-state-walk",
            capturedAt: ts(),
            state: { pool: RAYDIUM_CLMM_POOL, programId: RAYDIUM_CLMM_PROGRAM_ID, tickCurrent: states.raydium.pool.tickCurrent },
          });
      } else if (venue === "raydium-cpmm") {
        // input = USDC (mintB) — the ape leg USDC → EXOTIC(sol)
        const q = exoticCpmmQuoteLeg(states.exoticCpmm, SOL_MINTS.USDC, String(amountInRaw));
        if (q.error) push({ venue, ok: false, reason: q.error, amountIn: String(amountInRaw), from: leg.from, to: leg.to, source: "skip" });
        else
          push({
            venue,
            pool: EXOTIC_SOL.pool,
            chain: "sol",
            from: leg.from,
            to: leg.to,
            amountIn: q.inRaw,
            amountOut: q.outRaw,
            feeBps: Math.round(Number(q.tradeFeeRate) / 100), // 1e6-denominated rate -> bps (2500 -> 25 bps)
            source: "REAL-live-raydium-cpmm-state-walk",
            capturedAt: ts(),
            state: { pool: EXOTIC_SOL.pool, programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", vaultBUsdc: states.exoticCpmm.vaultB.amountRaw, vaultAExotic: states.exoticCpmm.vaultA.amountRaw },
          });
      } else if (venue === "lifi") {
        const isBridge = leg.chain.includes("→");
        const q = await quoteLifi({
          fromChain: "ETH",
          toChain: isBridge ? "SOL" : "ETH",
          fromToken: leg.from === "WETH" ? "WETH" : "USDC",
          toToken: leg.to === "USDC" || leg.to === "USDC.x" ? "USDC" : leg.to === "SOL" ? "SOL" : "USDC",
          fromAmount: String(amountInRaw),
          toAddress: isBridge ? SOLANA_ADDRESS : null,
        });
        push({
          venue,
          pool: `lifi-${leg.chain.replace("→", "-")}-${leg.from}-${leg.to}`,
          chain: leg.chain,
          from: leg.from,
          to: leg.to,
          amountIn: String(amountInRaw),
          amountOut: q.amountOut,
          feeBps: null,
          source: "REAL-live-lifi-quote(fee=0)",
          capturedAt: ts(),
          tool: q.tool,
          context: { feeCostsUsd: q.feeCostsUsd, gasCostsUsd: q.gasCostsUsd },
        });
      } else if (venue === "uniswap") {
        const q = await quoteEvmDirect({ tokenIn: leg.from === "WETH" ? "WETH" : "USDC", tokenOut: "USDC", amount: amountInRaw, fee: 500 });
        if (!q.ok) push(q);
        else {
          const gasUsd = await evmGasUsd(q.gasEstimate);
          push({
            ...q,
            venue,
            from: leg.from,
            to: leg.to,
            context: { gasUsd },
          });
        }
      } else if (venue === "warp") {
        // The Warp hop (Solana → X1): the 0.5% skim is an invariant across
        // venue choices and the Warp program quote is not keyless-quotable
        // here — recorded as a single-venue leg with the documented fee.
        push({
          venue,
          pool: "warp-sol-x1",
          chain: leg.chain,
          from: leg.from,
          to: leg.to,
          amountIn: String(amountInRaw),
          amountOut: String((BigInt(String(amountInRaw)) * 9950n) / 10000n), // 0.5% skim — the documented Warp fee
          feeBps: 50,
          source: "DOCUMENTED-warp-skim-0.5pct (not live-quoted — invariant across venue choices)",
          capturedAt: ts(),
        });
      } else if (venue === "xdex") {
        const x = states.xdex;
        const q = xdexQuote({ snapshot: x, inputMint: x.token0.mint, amountInRaw: String(amountInRaw), slippageBps: 100 });
        push({
          venue,
          pool: x.pool,
          chain: "x1",
          from: leg.from,
          to: leg.to,
          amountIn: q.inRaw,
          amountOut: q.outRaw,
          feeBps: Math.round(Number(q.tradeFeeRate) / 100), // 1e6-denominated rate -> bps (2800 -> 28 bps)
          priceImpactBps: q.priceImpactBps,
          source: "REAL-xdex-quote (vault balances refreshed live this round; static pool fields + fee config = frozen 2026-09-02 capture — the XDEX program layout has no in-repo decoder)",
          capturedAt: ts(),
          state: { pool: x.pool, vault0Sol: x.vault0.amountRaw, vault1Exotic: x.vault1.amountRaw },
        });
      }
    } catch (e) {
      out.push({ venue, ok: false, reason: String(e.message).slice(0, 160), amountIn: String(amountInRaw), from: leg.from, to: leg.to, source: "skip", capturedAt: ts() });
    }
  }
  if (cache && out.some((q) => q.ok !== false)) cache.set(cacheKey, out.filter((q) => q.ok !== false).map((q) => ({ ...q })));
  return out;
}

// ── real USD per output raw unit for a leg's to-token (this round's own
//    real rates — no synthetic prices) ─────────────────────────────────────
function usdPerOutUnitFor({ leg, quotes, states }) {
  const to = leg.to;
  if (to === "USDC" || to === "USDC.x" || to === "USDT") return 1 / 1e6; // peg ≈ $1 (documented ~1e-3 tolerance)
  if (to === "SOL" || to === "wSOL.X") {
    // real SOL $ per lamport: this round's own live SOL→USDC reference
    // quote (1 SOL, fetched per round) — fall back to the leg's own real
    // SOL→USDC venue quotes when the reference is missing.
    if (states?.solUsdPerLamport != null) return states.solUsdPerLamport;
    const jup = quotes.find((q) => q.venue === "jupiter" && q.to === "USDC");
    const ref = jup || quotes.find((q) => q.amountOut && q.to === "USDC");
    if (ref && ref.amountIn && ref.amountOut) {
      const usdcPerLamport = Number(BigInt(String(ref.amountOut))) / Number(BigInt(String(ref.amountIn)));
      return usdcPerLamport / 1e6; // USDC raw per SOL raw × $ per USDC raw
    }
    return null;
  }
  if (to === "EXOTIC(sol)") {
    // real $ per exotic raw unit: this round's own Jupiter USDC→EXOTIC rate
    const jup = quotes.find((q) => q.venue === "jupiter" && q.to === "EXOTIC(sol)");
    if (jup) {
      const usdIn = Number(BigInt(String(jup.amountIn))) / 1e6;
      return usdIn / Number(BigInt(String(jup.amountOut)));
    }
    // fall back to the pool's own real reserves (USDC vault $ ÷ exotic vault)
    const st = states.exoticCpmm;
    if (st && st.vaultB?.amountRaw && st.vaultA?.amountRaw) {
      return Number(BigInt(String(st.vaultB.amountRaw))) / 1e6 / Number(BigInt(String(st.vaultA.amountRaw)));
    }
    return null;
  }
  if (to === "EXOTIC(x1)") {
    // real $ per B69ch raw unit: the XDEX pool's own reserves (SOL vault $
    // ÷ B69ch vault) — SOL priced by this round's real SOL→USDC rate.
    const x = states.xdex;
    if (x && states?.solUsdPerLamport != null) {
      const solVaultUsd = Number(BigInt(String(x.vault0.amountRaw))) * states.solUsdPerLamport;
      return solVaultUsd / Number(BigInt(String(x.vault1.amountRaw)));
    }
    return null;
  }
  return null;
}

/** The venue the route CHOSE for a leg (the quote whose venue matches). */
function chosenQuote(quotes, venueChosen) {
  return quotes.find((q) => q.venue === venueChosen && q.ok !== false) || null;
}

// ── the round ──────────────────────────────────────────────────────────────
async function runRound(round) {
  const started = ts();
  const detections = [];
  const routeRecords = [];
  const stateNotes = [];

  // Shared live state, fetched ONCE per round (cacheable across routes):
  const states = {
    orca: await fetchOrcaState(),
    raydium: await fetchRaydiumClmmState(),
    exoticCpmm: await fetchExoticCpmmState(),
    xdex: await refreshXdexVaults(),
    quoteCache: new Map(), // round-scoped venue-quote success cache
  };
  // The round's real SOL price reference (1 SOL → USDC via Jupiter — used
  // to value SOL/wSOL.X legs + the X1 exotic in $; real same-round rate).
  try {
    const solRef = await quoteJupiter(SOL_MINTS.SOL, SOL_MINTS.USDC, "1000000000");
    states.solUsdPerLamport = Number(BigInt(String(solRef.amountOut))) / 1e6 / 1e9;
  } catch (e) {
    states.solUsdPerLamport = null;
    stateNotes.push(`sol price reference unavailable: ${String(e.message).slice(0, 100)}`);
  }
  stateNotes.push(`sol price ref $/SOL = ${states.solUsdPerLamport === null ? "n/a" : (states.solUsdPerLamport * 1e9).toFixed(4)}`);
  stateNotes.push(`orca pool ${ORCA_POOL} tick ${states.orca.whirlpool.tickCurrent}`);
  stateNotes.push(`raydium clmm pool ${RAYDIUM_CLMM_POOL} tick ${states.raydium.pool.tickCurrent}`);
  stateNotes.push(`exotic cpmm vaultB(USDC) ${states.exoticCpmm.vaultB.amountRaw} vaultA(exotic) ${states.exoticCpmm.vaultA.amountRaw}`);
  stateNotes.push(`xdex vault0(SOL) ${states.xdex.vault0.amountRaw} vault1(exotic-x1) ${states.xdex.vault1.amountRaw}`);

  for (const def of ROUTE_DEFS) {
    try {
      const rec = await runRoute({ def, states, round });
      routeRecords.push(rec);
      detections.push(rec.analysis);
    } catch (e) {
      routeRecords.push({ routeId: def.id, failed: String(e.message).slice(0, 300), started: ts() });
    }
  }
  return { round, started, finished: ts(), routeRecords, detections, stateNotes };
}

async function runRoute({ def, states, round }) {
  const legInputs = [];
  const quoteLog = [];
  let carryRaw = String(def.start.amount); // the journey size (chosen path)
  for (const legDef of def.legs) {
    const quotes = await quoteLegVenues({ leg: legDef, amountInRaw: carryRaw, states });
    quoteLog.push(...quotes.filter((q) => q.ok !== false));
    const chosen = chosenQuote(quotes, legDef.venueChosen);
    if (!chosen) {
      throw new Error(`${def.id} hop ${legDef.hop}: chosen venue ${legDef.venueChosen} not quoted at size ${carryRaw}`);
    }
    legInputs.push({ legDef, quotes, carryRaw });
    carryRaw = String(chosen.amountOut); // the chosen path's cascade
  }

  // Build the analyzer leg inputs (venue quotes at the leg's routed size +
  // real usdPerOutUnit for the output token).
  const legs = legInputs.map(({ legDef, quotes }) => {
    const usable = quotes.filter((q) => q.ok !== false && q.amountOut !== undefined);
    const usdPerOutUnit = usdPerOutUnitFor({ leg: legDef, quotes: usable, states });
    return {
      hop: legDef.hop,
      from: legDef.from,
      to: legDef.to,
      chain: legDef.chain,
      kind: legDef.kind,
      venueChosen: legDef.venueChosen,
      usdPerOutUnit,
      usdPerOutUnitNote:
        usdPerOutUnit === null
          ? "no real USD conversion available this round"
          : "real $ per raw output unit from this round's own real venue/pool rates (see the report method notes)",
      quotes: usable.map((q) => ({
        venue: q.venue,
        pool: q.pool ?? null,
        amountIn: q.amountIn,
        amountOut: q.amountOut,
        feeBps: q.feeBps ?? null,
        source: q.source,
        capturedAt: q.capturedAt,
        context: q.context ?? null,
        state: q.state ?? null,
      })),
    };
  });

  const analysis = analyzeRoute({ id: def.id, legs });
  const routeUsd = {
    journeyUnit: def.start.unit,
    journeyAmountRaw: def.start.amount,
    notes: def.legend,
  };
  return {
    round,
    routeId: def.id,
    legend: def.legend,
    started: ts(),
    quotes: quoteLog.map((q) => {
      const { context, state, ...rest } = q;
      return { ...rest, ...(context ? { context } : {}), ...(state ? { state } : {}) };
    }),
    legs: legs.map((l) => ({ ...l, quotes: l.quotes })),
    routeUsd,
    analysis: {
      kind: analysis.kind,
      routeId: analysis.routeId,
      legs: analysis.legs,
      routeGapBps: analysis.routeGapBps,
      routeNetBps: analysis.routeNetBps,
      routeGapUsd: analysis.routeGapUsd,
      routeNetUsd: analysis.routeNetUsd,
      routeUsdPartial: analysis.routeUsdPartial,
      wouldCapture: analysis.wouldCapture,
      whyNot: analysis.whyNot,
      economical: analysis.economical,
      optimalRoute: analysis.optimalRoute,
    },
  };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[mev-multihop-sim] MULTI-HOP route-choice capture simulation — ${ROUNDS} rounds, ${SLEEP_MS}ms apart. READ-ONLY. gated OFF.`);
  console.log(`[mev-multihop-sim] ${ROUTE_DEFS.length} route archetypes per round (the APING flow — any-to-any journeys ending at volatile/exotic destinations).`);
  const all = [];
  for (let r = 1; r <= ROUNDS; r++) {
    try {
      const round = await runRound(r);
      all.push(round);
      for (const rec of round.routeRecords) {
        if (rec.failed) {
          console.log(`[mev-multihop-sim] round ${r} ${rec.routeId}: FAILED ${rec.failed}`);
          continue;
        }
        const a = rec.analysis;
        const gap = a.routeGapBps === null ? "—" : `${a.routeGapBps} bps`;
        const net = a.routeNetUsd === null ? "—" : `$${a.routeNetUsd}`;
        console.log(`[mev-multihop-sim] round ${r} ${a.routeId}: route gap ${gap}, net ${net}, wouldCapture=${a.wouldCapture}${a.economical ? " ECONOMICAL" : ""} ${a.whyNot ? `(${a.whyNot.slice(0, 90)})` : ""}`);
        for (const l of a.legs) {
          const lg = l.gapBps === null ? "single-venue" : `${l.gapBps} bps`;
          console.log(`[mev-multihop-sim]   hop ${l.hop} ${l.from}→${l.to} ${l.chain}: chosen ${l.venueChosen}, best ${l.venueBest}, gap ${lg}${l.gapUsd === null ? "" : ` ($${l.gapUsd})`}`);
        }
      }
    } catch (e) {
      console.error(`[mev-multihop-sim] round ${r} FAILED:`, e.message);
      all.push({ round: r, failed: String(e.message).slice(0, 300), started: ts() });
    }
    if (r < ROUNDS) await sleep(SLEEP_MS);
  }

  const analyses = all.flatMap((r) => r.routeRecords ?? []).filter((r) => r.analysis).map((r) => r.analysis);
  const summary = summarizeRouteAnalyses(analyses);
  const report = {
    title: "MULTI-HOP route-choice capture SIMULATION — real per-hop venue quotes, zero trades (the framing correction)",
    date: ts(),
    gate: { MEV_CAPTURE_ENABLED: false, label: "gated OFF", note: "observation + report only — nothing executable; the live arm is Mr. Esters' alone (mirror of WARP_LIVE_SEND)" },
    feePolicy: {
      note: "capture value here = ROUTE-CHOICE improvement (best venue per hop vs the routed venue), net of per-leg explicit cost deltas; pool/bridge fees are netted inside every quote (never double counted). fee-model-v2 (0.5% capped $250 once-per-journey, src/lib/fees.ts) applies to USER journeys regardless of venue choice and cancels out of every venue comparison; the Warp skim (0.5%) is invariant across venue choices. CAPTURE_FEE_POLICY_BPS default 0 — see src/lib/mev/gapDetector.js.",
    },
    method: {
      rounds: all.length,
      routesPerRound: ROUTE_DEFS.length,
      sizes: "~$2,500 journeys (25 SOL / 1 WETH / 2,500 USDC) + one ~$10,000 size-effect route (98 SOL)",
      venues: {
        evm: "LiFi keyless quote API (aggregator) vs Uniswap v3 QuoterV2 eth_call f500 (direct) — WETH→USDC on Ethereum",
        bridge: "LiFi EVM→Solana USDC (keyless — one serving carrier observed this run; THORChain hosts egress-blocked, Rango mainnet server-keyed → native→SOL legs documented with the repo's REAL Rango capture 2026-09-05, not re-quoted)",
        sol: "Jupiter (aggregator, keyless) vs Orca whirlpool + Raydium CLMM pool-state walks (getAccountInfo + the legs' pure quote math) — SOL↔USDC",
        ape: "Jupiter vs Raydium CPMM direct (pool-state walk) — USDC→EXOTIC(sol) on a real low-liquidity token (DvjbE…/USDC)",
        x1: "XDEX (X1's only DEX) — the SOL/B69ch… pool: vault balances refreshed live this round (official SPL layout), static pool fields + fee config = the repo's frozen 2026-09-02 capture",
        warp: "the Warp hop (0.5% skim — documented invariant; not live-quoted)",
      },
      usd: "real same-round rates only: stable pairs ≈ $1 by peg construction (~1e-3 tolerance); SOL via the round's real SOL→USDC venue rates; EXOTIC(sol) via the round's real Jupiter USDC→EXOTIC rate; EXOTIC(x1) via the XDEX pool's real reserves × the round's real SOL price. No synthetic prices. Reporting only — never on a money path.",
      honesty: [
        "every leg's venues are quoted at the SAME amountIn (the size the CHOSEN path delivers); when the best venue differs, downstream legs would carry slightly more — per-leg deltas are measured at the leg's actual routed size (the analyzer flags rate-implied math per leg when sizes differ)",
        "legs are quoted SEQUENTIALLY (read-only calls); markets move between reads — the recorded deltas are per-snapshot math, not a guaranteed same-instant execution",
        "pool/bridge fees are netted inside the quotes (never double counted)",
        "quotes are market data — they move; fixtures are dated 2026-09-06",
      ],
    },
    summary,
    routes: all.flatMap((r) => r.routeRecords ?? []).map((rec) => ({
      round: rec.round,
      routeId: rec.routeId,
      failed: rec.failed ?? null,
      legend: rec.legend ?? null,
      started: rec.started ?? null,
    })),
    detections: all.flatMap((r) => r.routeRecords ?? []).filter((rec) => rec.analysis).map((rec) => ({
      round: rec.round,
      routeId: rec.routeId,
      routeGapBps: rec.analysis.routeGapBps,
      routeNetBps: rec.analysis.routeNetBps,
      routeGapUsd: rec.analysis.routeGapUsd,
      routeNetUsd: rec.analysis.routeNetUsd,
      routeUsdPartial: rec.analysis.routeUsdPartial,
      wouldCapture: rec.analysis.wouldCapture,
      whyNot: rec.analysis.whyNot,
      economical: rec.analysis.economical,
      optimalRoute: rec.analysis.optimalRoute,
      legs: rec.analysis.legs.map((l) => ({
        hop: l.hop,
        from: l.from,
        to: l.to,
        chain: l.chain,
        kind: l.kind,
        venueChosen: l.venueChosen,
        venueBest: l.venueBest,
        singleVenue: l.singleVenue,
        gapBps: l.gapBps,
        gapUsd: l.gapUsd,
        netUsd: l.netUsd,
        exact: l.exact,
      })),
    })),
    stateNotes: all.flatMap((r) => (r.stateNotes ?? []).map((n) => ({ round: r.round, note: n }))),
  };

  mkdirSync(MEV_MH_FIXTURES, { recursive: true });
  mkdirSync(MEV_DOCS, { recursive: true });
  const jsonPath = join(MEV_DOCS, "mev-multihop-simulation-2026-09-06.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // The REAL per-leg quote captures (fixtures — quote-level only) + the
  // per-route evidence files the rebuild test re-runs.
  const inputsDir = join(MEV_MH_FIXTURES, "inputs");
  mkdirSync(inputsDir, { recursive: true });
  const captureLog = [];
  for (const r of all) {
    for (const rec of r.routeRecords ?? []) {
      if (!rec.analysis) continue;
      const evidence = {
        capturedAt: rec.started,
        round: rec.round,
        routeId: rec.routeId,
        legend: rec.legend,
        legs: rec.legs,
        routeUsd: rec.routeUsd,
        analysis: rec.analysis,
      };
      const file = `route-${String(rec.round).padStart(2, "0")}-${rec.routeId}.json`;
      writeFileSync(join(inputsDir, file), JSON.stringify(evidence, null, 2));
      for (const q of rec.quotes ?? []) {
        if (q.ok === false) continue;
        captureLog.push({ ...q, routeId: rec.routeId, round: rec.round });
      }
    }
  }
  writeFileSync(join(MEV_MH_FIXTURES, "capture-log.json"), JSON.stringify(captureLog, null, 2));
  writeFileSync(join(MEV_MH_FIXTURES, "README.md"), fixtureReadme());
  console.log(`[mev-multihop-sim] wrote ${jsonPath}`);
  console.log(`[mev-multihop-sim] summary: ${JSON.stringify(summary)}`);
  return report;
}

function fixtureReadme() {
  return `# MEV multi-hop simulation fixtures — REAL per-leg quote captures (2026-09-06)

🔴 READ-ONLY captures for the MULTI-HOP route-choice capture SIMULATION. NO
funds, NO broadcast, NO signing — quoter eth_calls (EVM), on-chain pool-state
reads + pure quote math (Solana / X1), keyless aggregator quotes (Jupiter /
LiFi). The capture EXECUTION path is dead-gated (MEV_CAPTURE_ENABLED=false
default).

- \`inputs/route-*.json\` — per-route REAL quote evidence (every leg's venue
  options at the leg's routed size) + the analysis computed over it
  (REAL-labeled; quote-level only).
- \`capture-log.json\` — every real quote of the run (flat).
- Docs: docs/MEV-MULTIHOP-SIMULATION-2026-09-06.md +
  docs/mev-multihop-simulation-2026-09-06.json.

Refresh before any live use — quotes are market data and move.
`;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error("[mev-multihop-sim] fatal:", e);
    process.exit(1);
  });
}

export { runRound, main, ROUTE_DEFS };
