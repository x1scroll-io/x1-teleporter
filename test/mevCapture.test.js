/**
 * mevCapture.test.js — the MEV capture ENGINE tests (routing-layer wiring +
 * the dead-gated capture composition + REAL-fixture-backed detection).
 *
 * Spec coverage:
 *   • the RoutePlanner capture hook: captureCandidatesForChain / the
 *     CAPTURE_CANDIDATES registry (read of DEX_DIRECT_FALLBACKS — DEFAULT
 *     ROUTING UNCHANGED),
 *   • the capture-route CONSTRUCTOR (planCaptureSwapPair): COMPOSES two
 *     existing swap legs via composeRoute — the actual leg builders, no
 *     hand-rolled calldata; the route carries the gate (false) and is
 *     dead-gated (legs' submit() throws DexDirectLiveTestGateError),
 *   • BUILD-level composition over the frozen dex-direct captures (the leg
 *     builders construct the real artifacts from live-captured state),
 *   • observeCaptureForSwap over REAL same-chain same-pair fixture quotes
 *     (Solana: Orca + Raydium CLMM SOL→USDC — the engine's two-venue case)
 *     → detection reports the gated-off line.
 * Pure/offline (frozen fixtures — no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RoutePlanner, createLeg, runLeg } from "../src/engine/index.js";
import { DexDirectLiveTestGateError } from "../src/engine/legs/dexDirect/liveTestGate.js";
import { evmInput, solInput } from "./golden/dexDirectBuilders.mjs";
import { EVM_ADDRESS, SOLANA_ADDRESS } from "./golden/forwardLegBuilders.mjs";

// ── the routing hook: capture candidates (pure read of the registry) ───────
test("mev: captureCandidatesForChain returns the same-chain venue lists (registry order)", () => {
  assert.deepEqual(RoutePlanner.captureCandidatesForChain("eth"), ["lifi", "uniswap"]);
  assert.deepEqual(RoutePlanner.captureCandidatesForChain("arb"), ["lifi", "uniswap"]);
  assert.deepEqual(RoutePlanner.captureCandidatesForChain("bsc"), ["lifi", "pancakeswap"]);
  assert.deepEqual(RoutePlanner.captureCandidatesForChain("sol"), ["jupiter", "orca", "raydium"]);
  assert.deepEqual(RoutePlanner.captureCandidatesForChain("x1"), ["xdex"]);
  assert.deepEqual(RoutePlanner.captureCandidatesForChain("btc"), [], "unknown chains → no candidates");
  // the registry is derived from DEX_DIRECT_FALLBACKS — the planner's own fallback order
  assert.deepEqual([...RoutePlanner.DEX_DIRECT_FALLBACKS.svm.sol], RoutePlanner.captureCandidatesForChain("sol"));
});

test("mev: CAPTURE_SCAN_CHAINS covers the served same-chain swap chains", () => {
  assert.deepEqual(RoutePlanner.CAPTURE_SCAN_CHAINS, ["eth", "arb", "bas", "opt", "pol", "bsc", "sol"]);
  for (const chain of RoutePlanner.CAPTURE_SCAN_CHAINS) {
    assert.ok(RoutePlanner.captureCandidatesForChain(chain).length >= 1, `${chain} has candidates`);
  }
});

// ── the capture-route constructor (dead-gated composition) ─────────────────
test("mev: planCaptureSwapPair COMPOSES two existing swap legs via composeRoute", () => {
  const cap = RoutePlanner.planCaptureSwapPair({
    chain: "sol",
    pair: { from: "SOL", to: "USDC" },
    buy: { via: "dexDirect", dex: "orca" },
    sell: { via: "dexDirect", dex: "raydium" },
  });
  assert.equal(cap.id, "capture-sol-SOL-USDC-orca-raydium");
  assert.equal(cap.direction, "capture");
  assert.equal(cap.sourceChain, "sol");
  assert.equal(cap.destChain, "sol");
  assert.equal(cap.composedOf.length, 2, "composeRoute records the two source routes");
  assert.deepEqual(cap.legs.map((l) => l.id), ["orca-swap", "raydium-swap"], "the ACTUAL dex legs, in buy→sell order");
  for (const leg of cap.legs) {
    assert.equal(typeof leg.phases.build, "function");
    assert.equal(typeof leg.phases.submit, "function");
  }
  // stages are re-grouped under the capture prefix (composeRoute contract)
  assert.ok(cap.stages["capture-a-swap"], "buy leg stage present");
  assert.ok(cap.stages["capture-b-swap"], "sell leg stage present");
});

test("mev: planCaptureSwapPair composes EVM sides (dexDirect + lifi aggregator)", () => {
  const cap = RoutePlanner.planCaptureSwapPair({
    chain: "eth",
    pair: { from: "USDC", to: "USDT" },
    buy: { via: "dexDirect", dex: "uniswap" },
    sell: { via: "lifi" },
  });
  assert.equal(cap.id, "capture-eth-USDC-USDT-uniswap-lifi");
  assert.deepEqual(cap.legs.map((l) => l.id), ["uniswap-swap", "lifi-evm-swap"]);
  assert.equal(cap.capture.buy.dex, "uniswap");
  assert.equal(cap.capture.sell.via, "lifi");
});

test("mev: the capture route is DEAD-GATED — gate false by default, executable always false", () => {
  const cap = RoutePlanner.planCaptureSwapPair({
    chain: "bsc",
    pair: { from: "USDC", to: "USDT" },
    buy: { via: "dexDirect", dex: "pancakeswap" },
    sell: { via: "dexDirect", dex: "pancakeswap" },
  });
  assert.equal(cap.capture.kind, "same-chain-cross-venue-price-gap");
  assert.equal(cap.capture.atomic, true);
  assert.equal(cap.capture.gate.enabled, false, "MEV_CAPTURE_ENABLED=false under node (the repo default)");
  assert.equal(cap.capture.gate.executable, false, "never executable — structural");
  assert.equal(cap.capture.gate.label, "gated OFF");
});

test("mev: the capture route's legs are the guarded swap legs — submit throws DexDirectLiveTestGateError", async () => {
  const cap = RoutePlanner.planCaptureSwapPair({
    chain: "sol",
    buy: { via: "dexDirect", dex: "orca" },
    sell: { via: "dexDirect", dex: "raydium" },
  });
  for (const leg of cap.legs) {
    await assert.rejects(
      leg.phases.submit(),
      (e) => e instanceof DexDirectLiveTestGateError,
      `${leg.id} submit must be gated`,
    );
  }
});

test("mev: planCaptureSwapPair rejects unknown sides/vias (fail-closed)", () => {
  assert.throws(() => RoutePlanner.planCaptureSwapPair({ buy: { via: "dexDirect" }, sell: { via: "lifi" } }), /needs dex/);
  assert.throws(() => RoutePlanner.planCaptureSwapPair({ buy: { via: "madeup" }, sell: { via: "lifi" } }), /unknown swap via/);
  assert.throws(() => RoutePlanner.planCaptureSwapPair({ buy: { via: "lifi" } }), /buy and sell sides are required/);
});

// ── BUILD-level composition over the frozen REAL captures ──────────────────
test("mev: the composed capture legs BUILD the real artifacts from the frozen dex-direct captures", async () => {
  // EVM capture shape: buy leg = the Uniswap v3 leg on the frozen eth
  // capture; sell leg = the PancakeSwap v3 leg on the frozen bsc capture —
  // both are the ACTUAL dexDirect legs the capture route composes; each
  // must construct its quote-pinned artifact from REAL captured state.
  const capEvm = RoutePlanner.planCaptureSwapPair({
    chain: "bsc",
    buy: { via: "dexDirect", dex: "uniswap" }, // chain arg is shape; legs read ctx.chain at build
    sell: { via: "dexDirect", dex: "pancakeswap" },
  });
  const [buyLeg, sellLeg] = capEvm.legs;
  const uniInput = evmInput("uni-eth");
  const buy = await buyLeg.phases.build({
    chain: "eth",
    fromToken: "USDC",
    toToken: "USDT",
    amount: uniInput.amountIn,
    fee: uniInput.fee,
    recipient: EVM_ADDRESS,
    quoteHex: uniInput.responseHex,
  });
  assert.equal(buy.artifact.dex, "uniswap");
  assert.ok(buy.artifact.quoteRequest.kind === "quoter-quoteExactInputSingle");
  assert.ok(BigInt(buy.artifact.quote.amountOut) > 0n, "real captured eth quote parsed");

  const pcsInput = evmInput("pcs-bsc-f100");
  const sell = await sellLeg.phases.build({
    chain: "bsc",
    fromToken: "USDC",
    toToken: "USDT",
    amount: pcsInput.amountIn,
    fee: pcsInput.fee,
    recipient: EVM_ADDRESS,
    quoteHex: pcsInput.responseHex,
  });
  assert.equal(sell.artifact.dex, "pancakeswap");
  assert.ok(BigInt(sell.artifact.quote.amountOut) > 0n, "real captured bsc quote parsed");

  // Solana capture shape: orca buy leg + raydium clmm sell leg on the
  // frozen SOL→USDC pool states (the engine's real two-venue market).
  const capSol = RoutePlanner.planCaptureSwapPair({
    chain: "sol",
    buy: { via: "dexDirect", dex: "orca" },
    sell: { via: "dexDirect", dex: "raydium" },
  });
  const [orcaLeg, raydiumLeg] = capSol.legs;
  const orcaSnap = solInput("orca");
  const orca = await orcaLeg.phases.build({
    snapshot: { whirlpool: orcaSnap.whirlpool, tickArrays: orcaSnap.tickArrays, tokenProgramA: orcaSnap.tokenProgramA, tokenProgramB: orcaSnap.tokenProgramB, oracle: orcaSnap.oracle },
    userPubkey: SOLANA_ADDRESS,
    inputMint: orcaSnap.whirlpool.mintA,
    amountInRaw: orcaSnap.sample.amountInRaw,
    slippageBps: orcaSnap.sample.slippageBps,
  });
  assert.ok(BigInt(orca.artifact.quote.amountOutRaw) > 0n);
  assert.equal(orca.artifact.ix.discriminator, "2b04ed0b1ac91e62");

  const rdSnap = solInput("raydiumClmm");
  const raydium = await raydiumLeg.phases.build({
    dex: "clmm",
    snapshot: { pool: rdSnap.pool, config: rdSnap.config, pdas: rdSnap.pdas, tickArrays: rdSnap.tickArrays },
    userPubkey: SOLANA_ADDRESS,
    inputMint: rdSnap.pool.mintA,
    amountInRaw: rdSnap.sample.amountInRaw,
    slippageBps: rdSnap.sample.slippageBps,
  });
  assert.ok(BigInt(raydium.artifact.quote.amountOutRaw) > 0n);
  assert.equal(raydium.artifact.ix.discriminator, "2b04ed0b1ac91e62");
});

test("mev: runLeg over a capture leg drives build then stops at the guarded submit (never a broadcast)", async () => {
  const cap = RoutePlanner.planCaptureSwapPair({
    chain: "sol",
    buy: { via: "dexDirect", dex: "orca" },
    sell: { via: "dexDirect", dex: "raydium" },
  });
  const [orcaLeg] = cap.legs;
  const snap = solInput("orca");
  await assert.rejects(
    runLeg(orcaLeg, {
      snapshot: { whirlpool: snap.whirlpool, tickArrays: snap.tickArrays, tokenProgramA: snap.tokenProgramA, tokenProgramB: snap.tokenProgramB, oracle: snap.oracle },
      userPubkey: SOLANA_ADDRESS,
      inputMint: snap.whirlpool.mintA,
      amountInRaw: snap.sample.amountInRaw,
      slippageBps: snap.sample.slippageBps,
    }),
    (e) => e instanceof DexDirectLiveTestGateError,
    "runLeg propagates the live-test gate — nothing signs or broadcasts",
  );
});

// ── observeCaptureForSwap over REAL same-chain fixture quotes ──────────────
test("mev: observeCaptureForSwap runs the detector over the REAL Orca + Raydium SOL→USDC captures and reports (gated OFF)", () => {
  // The two REAL live captures (2026-09-05, frozen) quote the SAME pair on
  // the SAME chain from two independent venues — the engine's Solana
  // two-venue case. The sell side (USDC→SOL) is not in the frozen dex-
  // direct captures; the simulation harness captures it live — this test
  // runs the BUY-side spread through the scan with a single-route sell
  // note (honest: detection runs; the full round-trip evidence is the
  // simulation fixtures' job).
  const orcaSnap = solInput("orca");
  const rdSnap = solInput("raydiumClmm");
  const buyQuotes = [
    {
      dex: "orca",
      pool: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
      chain: "sol",
      from: "SOL",
      to: "USDC",
      amountIn: orcaSnap.sample.amountInRaw,
      amountOut: orcaSnap.quote.amountOut,
      source: "REAL-live-capture-2026-09-05",
    },
    {
      dex: "raydium",
      pool: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv",
      chain: "sol",
      from: "SOL",
      to: "USDC",
      amountIn: rdSnap.sample.amountInRaw,
      amountOut: rdSnap.quote.amountOutRaw,
      source: "REAL-live-capture-2026-09-05",
    },
  ];
  const { detection, gate, report } = RoutePlanner.observeCaptureForSwap({
    chain: "sol",
    pair: { from: "SOL", to: "USDC" },
    buyQuotes,
    // No USDC→SOL fixture exists in the dex-direct golden set — a single
    // reference sell quote keeps the scan honest (exact:false is flagged).
    sellQuotes: [{ dex: "orca", pool: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", amountIn: orcaSnap.quote.amountOut, amountOut: "1", source: "placeholder" }],
  });
  assert.ok(detection.gapBps !== null && detection.gapBps >= 0, "a real spread between the two venues exists");
  assert.equal(gate.label, "gated OFF");
  assert.match(report, /gated OFF/);
  assert.match(detection.whyNot || "", /single-route|below-threshold|no-arb/, "honest outcome — the round trip needs the live reverse leg");
});

test("mev: engine facade re-exports the capture surface", () => {
  assert.equal(typeof RoutePlanner.planCaptureSwapPair, "function");
  assert.equal(typeof RoutePlanner.observeCaptureForSwap, "function");
  assert.equal(typeof RoutePlanner.captureCandidatesForChain, "function");
  assert.equal(typeof RoutePlanner.plan, "function", "plan() untouched — default routing unchanged");
  assert.equal(RoutePlanner.plan({ direction: "swap", via: "jupiter" }).id, "swap-sol-sol-jupiter");
  assert.equal(RoutePlanner.plan({ direction: "forward" }).id, "forward-eth-x1");
});
