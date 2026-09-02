/**
 * goldenDex.test.js — THE REGRESSION ORACLE for the Phase-4 DEX swap legs
 * (the routing-engine DEX migration: Jupiter on Solana, XDEX on X1 — direct
 * on-chain — and the LiFi EVM same-chain swap verdict leg).
 *
 * The engine's DEX legs are correct IF AND ONLY IF they reproduce the EXACT
 * artifacts the canonical construction produces — byte-for-byte. This test
 * is the oracle: it REBUILDS each step from the frozen live input captures
 * (the Jupiter quote, the XDEX pool snapshot, the LiFi same-chain quote —
 * all read-only live captures, 2026-09-02) + the fixed sample inputs and
 * asserts the rebuilt artifacts are IDENTICAL to the captured golden
 * fixtures (canonical JSON equality + sha256 match).
 *
 *   jupiter step1  the canonical QUOTE REQUEST (api.jup.ag/swap/v1/quote —
 *                  the current host; the old quote-api.jup.ag/v6 host is
 *                  dead) with the RAW base-unit amount + slippage bps
 *   jupiter step2  the canonical SWAP-INSTRUCTIONS REQUEST (the frozen quote
 *                  forwarded VERBATIM as quoteResponse + the pinned session
 *                  pubkey + the fixed option set)
 *   xdex step1     the constant-product QUOTE from the LIVE pool snapshot
 *                  (0.28% trade fee on input — live AmmConfig decode)
 *   xdex step2     the SwapBaseInput INSTRUCTION + unsigned tx (disc
 *                  13bddf5c73d6bd24 — the OBSERVED live discriminator — +
 *                  amount_in u64 LE + min_out u64 LE, 13 accounts)
 *   lifi step1     the same-chain EVM swap QUOTE REQUEST through the
 *                  /api/lifi/quote policy (forced 1% integrator fee on
 *                  same-chain routes) + the exact upstream URL
 *
 * Fixtures: test/fixtures/golden/dex-leg/*.json
 * Rebuild:  test/golden/dexLegBuilders.mjs (single source of truth — the
 *           capture script and this test share it).
 *
 * LIVE-STATUS BOUNDARY (honest): the quote/snapshot INPUT fixtures are live
 * captures frozen as inputs; the oracle pins the CONSTRUCTION. XDEX arg
 * semantics are source-consistent + wire-size-verified but not 1:1
 * live-confirmed (relayer-driven sampled txs) — see the fixture README +
 * the leg header; the integration prerequisite is a single tiny controlled
 * swap on the operator's go-ahead.
 *
 * The engine must make this file pass UNCHANGED. Do not weaken assertions to
 * accommodate the engine — fix the engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureDexLeg,
  canonicalJson,
  sha256Of,
  sha256Text,
  buildJupiterStep1,
  buildJupiterStep2,
  buildXdexStep1,
  buildXdexStep2,
  buildLifiSwapStep1,
  jupiterQuoteInput,
  xdexSnapshotInput,
  lifiSwapQuoteInput,
  JUPITER_SAMPLE,
  XDEX_SAMPLE,
  LIFI_SWAP_SAMPLE,
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  XDEX_PROGRAM_ID,
  XDEX_SWAP_BASE_INPUT_DISCRIMINATOR,
} from "./golden/dexLegBuilders.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "golden", "dex-leg");
const read = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const FIX_JUP1 = read("jupiter-step1-quote-request.json");
const FIX_JUP2 = read("jupiter-step2-swap-request.json");
const FIX_XD1 = read("xdex-step1-swap-quote.json");
const FIX_XD2 = read("xdex-step2-swap-ix.json");
const FIX_LIFI1 = read("lifi-step1-samechain-swap-request.json");
const SUMMARY = read("dex-leg-summary.json");

// ── Sample-input self-consistency (the fixture chain of custody) ──
test("golden dex: fixture inputs are the documented samples + the frozen live captures", () => {
  const jq = jupiterQuoteInput();
  const snap = xdexSnapshotInput();
  const lq = lifiSwapQuoteInput();

  // Jupiter sample: SOL → USDC, 0.5 SOL raw, 50 bps.
  assert.equal(JUPITER_SAMPLE.inputMint, "So11111111111111111111111111111111111111112");
  assert.equal(JUPITER_SAMPLE.outputMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(JUPITER_SAMPLE.amount, "500000000");
  assert.equal(JUPITER_SAMPLE.slippageBps, 50);
  assert.equal(JUPITER_SAMPLE.userPublicKey, SOLANA_ADDRESS);
  // The frozen quote agrees with the sample (raw inAmount, same pair).
  assert.equal(jq.inputMint, JUPITER_SAMPLE.inputMint);
  assert.equal(jq.outputMint, JUPITER_SAMPLE.outputMint);
  assert.equal(jq.inAmount, JUPITER_SAMPLE.amount);
  assert.ok(Number(jq.outAmount) > 0, "frozen quote has an outAmount");

  // XDEX snapshot: the live wXNT/USDC.x pool, program-owned, sane reserves.
  assert.equal(snap.pool, XDEX_SAMPLE.pool);
  assert.equal(snap.programId, XDEX_PROGRAM_ID);
  assert.equal(snap.poolOwner, XDEX_PROGRAM_ID); // the pool account is program-owned
  assert.equal(snap.poolDiscriminator, "f7ede3f5d7c3de46"); // sha256("account:PoolState")[..8]
  assert.equal(snap.ammConfig.tradeFeeRate, "2800"); // 0.28% — live config
  assert.equal(snap.ammConfig.creatorFeeRate, "0");
  assert.equal(snap.token0.mint, XDEX_SAMPLE.outputMint); // wXNT = token_0
  assert.equal(snap.token1.mint, XDEX_SAMPLE.inputMint); // USDC.x = token_1
  assert.ok(BigInt(snap.vault0.amountRaw) > 0n && BigInt(snap.vault1.amountRaw) > 0n);

  // LiFi same-chain quote: the swap-route EVIDENCE (Leg C verdict).
  assert.equal(lq.type, "lifi");
  const swapStep = (lq.includedSteps || []).find((s) => s.type === "swap");
  assert.ok(swapStep, "the same-chain quote includes a swap step (LiFi covers EVM swaps)");
  assert.ok(lq.tool && lq.tool !== "", "the route has a swap tool");

  // Summary agrees with the fixtures.
  assert.equal(SUMMARY.evidence.xdexSnapshot.pool, snap.pool);
  assert.equal(SUMMARY.steps.jupiterStep1QuoteRequest.urlSha256, FIX_JUP1.urlSha256);
  assert.equal(SUMMARY.steps.xdexStep2SwapIx.dataSha256, FIX_XD2.dataSha256);
});

// ── JUPITER step1 — the canonical quote request ──
test("golden dex jupiter step1: quote-request rebuild is byte-identical (canonical URL + sha256)", () => {
  const rebuilt = buildJupiterStep1();

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_JUP1.artifact));
  assert.equal(rebuilt.sha256, FIX_JUP1.sha256);

  const a = rebuilt.artifact;
  assert.ok(a.url.startsWith("https://api.jup.ag/swap/v1/quote?"), "current host (v6 is dead)");
  assert.ok(a.url.includes("inputMint=" + JUPITER_SAMPLE.inputMint));
  assert.ok(a.url.includes("outputMint=" + JUPITER_SAMPLE.outputMint));
  assert.ok(a.url.includes("amount=500000000"), "RAW base-unit amount — never human units");
  assert.ok(a.url.includes("slippageBps=50"));
  assert.ok(!a.url.includes("onlyDirectRoutes"), "onlyDirectRoutes omitted when false");
  assert.equal(FIX_JUP1.urlSha256, sha256Text(a.url));
});

// ── JUPITER step2 — the canonical swap-instructions request ──
test("golden dex jupiter step2: swap-request rebuild is byte-identical (quote verbatim + pinned pubkey)", () => {
  const rebuilt = buildJupiterStep2();
  const quote = jupiterQuoteInput();

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_JUP2.artifact));
  assert.equal(rebuilt.sha256, FIX_JUP2.sha256);

  const a = rebuilt.artifact;
  assert.equal(a.url, "https://api.jup.ag/swap/v1/swap-instructions");
  assert.equal(a.body.userPublicKey, SOLANA_ADDRESS); // the pinned session pubkey
  assert.equal(a.body.wrapAndUnwrapSol, true);
  assert.equal(a.body.dynamicComputeUnitLimit, true);
  assert.equal(a.body.prioritizationFeeLamports, "auto");
  // The quote is forwarded VERBATIM — byte-identical to the frozen input.
  assert.equal(canonicalJson(a.body.quoteResponse), canonicalJson(quote));
  assert.equal(FIX_JUP2.bodySha256, sha256Text(JSON.stringify(a.body)));
});

// ── XDEX step1 — the constant-product quote from the live snapshot ──
test("golden dex xdex step1: swap-quote rebuild is byte-identical (CP math + live fee config)", () => {
  const rebuilt = buildXdexStep1();

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_XD1.artifact));
  assert.equal(rebuilt.sha256, FIX_XD1.sha256);

  const a = rebuilt.artifact;
  const snap = xdexSnapshotInput();
  assert.equal(a.pool, snap.pool);
  assert.equal(a.programId, XDEX_PROGRAM_ID);
  assert.equal(a.inputMint, XDEX_SAMPLE.inputMint); // USDC.x
  assert.equal(a.outputMint, XDEX_SAMPLE.outputMint); // wXNT
  assert.equal(a.amountInRaw, "10000000"); // 10 USDC.x (6 dp) raw
  assert.equal(a.tradeFeeRate, "2800"); // 0.28% — the LIVE AmmConfig
  // fee on input: ceil(10,000,000 × 2800 / 1e6) = 28,000; net = 9,972,000
  assert.equal(a.tradeFeeRaw, "28000");
  assert.equal(a.netInRaw, "9972000");
  // CP: out = floor(Rout × net / (Rin + net)) on the live vault raw balances
  const rin = BigInt(snap.vault1.amountRaw);
  const rout = BigInt(snap.vault0.amountRaw);
  const expectedOut = (rout * 9972000n) / (rin + 9972000n);
  assert.equal(a.outRaw, expectedOut.toString());
  assert.equal(a.minOutRaw, ((expectedOut * 9900n) / 10000n).toString()); // 100 bps slippage
  assert.equal(a.outHuman, Number(expectedOut) / 10 ** 9); // wXNT 9 dp
  assert.ok(Number(a.priceImpactBps) >= 0 && Number(a.priceImpactBps) < 1000, "impact sane");
  assert.equal(FIX_XD1.sha256, SUMMARY.steps.xdexStep1SwapQuote.sha256);
});

// ── XDEX step2 — the SwapBaseInput instruction + unsigned tx ──
test("golden dex xdex step2: swap-ix rebuild is byte-identical (observed discriminator + 13 metas + tx)", () => {
  const rebuilt = buildXdexStep2();

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_XD2.artifact));
  assert.equal(rebuilt.sha256, FIX_XD2.sha256);

  const a = rebuilt.artifact;
  assert.equal(a.discriminator, XDEX_SWAP_BASE_INPUT_DISCRIMINATOR);
  assert.equal(a.discriminator, "13bddf5c73d6bd24"); // the OBSERVED live discriminator
  assert.equal(a.programId, XDEX_PROGRAM_ID);
  assert.equal(a.userPubkey, SOLANA_ADDRESS);
  assert.equal(a.amountInRaw, "10000000");
  assert.equal(a.minOutRaw, FIX_XD1.artifact.minOutRaw); // agrees with the quote step

  // The 24-byte payload: disc + amount_in u64 LE + min_out u64 LE.
  assert.equal(a.ix.dataHex.length, 48);
  assert.equal(a.ix.dataHex.slice(0, 16), "13bddf5c73d6bd24");
  assert.equal(a.ix.dataHex.slice(16, 32), "8096980000000000"); // 10,000,000 LE
  // 13 accounts in the verified order (payer first, observation last).
  assert.equal(a.ix.keys.length, 13);
  assert.equal(a.ix.keys[0].pubkey, SOLANA_ADDRESS);
  assert.equal(a.ix.keys[0].isSigner, true);
  assert.equal(a.ix.keys[1].pubkey, "9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU"); // authority
  assert.equal(a.ix.keys[3].pubkey, XDEX_SAMPLE.pool); // pool state
  assert.equal(a.ix.keys[12].isWritable, true); // observation

  // The unsigned tx serializes deterministically (synthetic DI'd blockhash).
  assert.equal(a.transaction.blockhash, XDEX_SAMPLE.blockhash);
  assert.equal(a.transaction.feePayer, SOLANA_ADDRESS);
  assert.equal(a.transaction.instructionCount, 1);
  assert.equal(rebuilt.txSha256, sha256Text(a.transaction.serializedBase64));
  assert.equal(FIX_XD2.txSha256, rebuilt.txSha256);
  assert.equal(FIX_XD2.dataSha256, rebuilt.dataSha256);
});

// ── LIFI same-chain step1 — the verdict-leg quote request ──
test("golden dex lifi step1: same-chain swap-request rebuild is byte-identical (forced 1% fee)", () => {
  const rebuilt = buildLifiSwapStep1();

  assert.equal(canonicalJson(rebuilt.artifact), canonicalJson(FIX_LIFI1.artifact));
  assert.equal(rebuilt.sha256, FIX_LIFI1.sha256);

  const a = rebuilt.artifact;
  assert.equal(a.chain, "eth");
  assert.equal(a.chainId, "eth"); // CHAINS.eth.lifiKey — LiFi accepts the chain key (the live
  // capture through this construction returned a swap route, proving it)
  assert.equal(a.params.fromAddress, EVM_ADDRESS);
  assert.equal(a.params.toAddress, EVM_ADDRESS);
  assert.equal(a.amount, "10000000");
  // Same chain on both ends → LiFi returns a swap route (the frozen evidence).
  assert.equal(a.params.fromChain, "eth");
  assert.equal(a.params.toChain, "eth");
  // Server fee policy: same-chain is NOT x1-class → the 1% integrator fee is FORCED.
  assert.equal(a.policy.forcedFee, "0.01");
  assert.equal(a.policy.x1ClassPresent, false);
  assert.ok(a.upstreamUrl.startsWith("https://li.quest/v1/quote?"));
  assert.ok(a.upstreamUrl.includes("integrator=x1-teleporter-labs"));
  assert.ok(a.upstreamUrl.includes("fee=0.01"), "same-chain routes carry the forced 1% fee");
  assert.ok(!a.upstreamUrl.includes("x1Class"), "the marker is never forwarded upstream");
  assert.equal(FIX_LIFI1.urlSha256, sha256Text(a.upstreamUrl));
});

// ── Full capture: reproducible + deterministic ──
test("golden dex: full capture is reproducible + deterministic (rebuild twice, same bytes)", () => {
  const c1 = captureDexLeg();
  const c2 = captureDexLeg();
  for (const k of Object.keys(c1.steps)) {
    assert.equal(c1.steps[k].sha256, c2.steps[k].sha256, `${k} sha256 stable`);
    assert.equal(
      canonicalJson(c1.steps[k].artifact),
      canonicalJson(c2.steps[k].artifact),
      `${k} artifact stable`,
    );
  }
  // Step fixtures agree with the summary + the per-step fixtures.
  assert.equal(c1.steps.jupiterStep1QuoteRequest.sha256, SUMMARY.steps.jupiterStep1QuoteRequest.sha256);
  assert.equal(c1.steps.jupiterStep2SwapRequest.sha256, SUMMARY.steps.jupiterStep2SwapRequest.sha256);
  assert.equal(c1.steps.xdexStep1SwapQuote.sha256, SUMMARY.steps.xdexStep1SwapQuote.sha256);
  assert.equal(c1.steps.xdexStep2SwapIx.sha256, SUMMARY.steps.xdexStep2SwapIx.sha256);
  assert.equal(c1.steps.lifiStep1SameChainSwapRequest.sha256, SUMMARY.steps.lifiStep1SameChainSwapRequest.sha256);
  assert.equal(c1.steps.jupiterStep1QuoteRequest.urlSha256, FIX_JUP1.urlSha256);
  assert.equal(c1.steps.jupiterStep2SwapRequest.bodySha256, FIX_JUP2.bodySha256);
  assert.equal(c1.steps.xdexStep1SwapQuote.artifact.minOutRaw, FIX_XD2.artifact.minOutRaw);
  assert.equal(c1.steps.lifiStep1SameChainSwapRequest.urlSha256, FIX_LIFI1.urlSha256);
});
