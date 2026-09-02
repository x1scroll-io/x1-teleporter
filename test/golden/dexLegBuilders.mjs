/**
 * dexLegBuilders.mjs — deterministic rebuild helpers for the Phase-4 DEX-leg
 * golden fixtures (test/fixtures/golden/dex-leg/).
 *
 * THE CONTRACT (mirror of the forward/reverse/thorchain golden builders)
 *   The routing engine's DEX swap legs (Phase 4: Jupiter on Solana, XDEX on
 *   X1 — direct on-chain, and the LiFi EVM same-chain swap verdict) are
 *   correct IF AND ONLY IF, given the SAME inputs, they construct the EXACT
 *   artifacts the canonical construction (this module + the leg files it
 *   imports) constructs. This module is the single source of truth for the
 *   fixed sample inputs + the rebuild path: the capture script
 *   (tools/capture-dex-golden-fixtures.mjs) writes the fixtures from it, and
 *   test/goldenDex.test.js rebuilds from it and asserts byte-identity +
 *   sha256. The engine must make test/goldenDex.test.js pass UNCHANGED.
 *
 * THE THREE LEGS
 *   A. JUPITER (Solana DEX aggregator — greenfield, no reference lane):
 *      step1 = the canonical quote-request URL (GET api.jup.ag/swap/v1/quote
 *      — input mint, output mint, RAW base-unit amount, slippage bps; host
 *      note: the old quote-api.jup.ag/v6 host is dead — DNS fails, so the
 *      fixture pins the CURRENT api.jup.ag/swap/v1 host). step2 = the
 *      canonical swap-instructions request body (POST …/swap-instructions —
 *      the quote response forwarded VERBATIM as quoteResponse + the pinned
 *      session pubkey + the fixed option set wrapAndUnwrapSol /
 *      dynamicComputeUnitLimit / prioritizationFeeLamports).
 *   B. XDEX (X1's Raydium-CP-Swap-style DEX — DIRECT on-chain integration,
 *      no HTTP swap API): step1 = the constant-product quote from the LIVE
 *      pool snapshot (fee on input: trade 2800/1e6 from the live AmmConfig
 *      — 0.28%; protocol 25% + fund 5% of the trade fee are internal
 *      accounting; creator 0) + minOut at slippage; step2 = the
 *      SwapBaseInput instruction (13 metas in the LIVE-VERIFIED order, disc
 *      8fbe5adac41e33de — sha256("global:swap_base_input")[..8], verified on
 *      the live anchor swap tx 65xjdHVd…, slot 76,014,947, err ok — + amount_in
 *      u64 LE + min_out u64 LE) + the unsigned serialized transaction
 *      (deterministic DI'd blockhash). XDEX truth = its own live on-chain
 *      data ONLY (the anchor tx + live pool snapshot) — nebula-dex is a
 *      SEPARATE project and never informs this leg.
 *   C. LIFI EVM same-chain swap (VERDICT LEG — verified live 2026-09-02):
 *      li.quest/v1/quote with both ends on the same chain returns a SWAP
 *      route (observed tools: sushiswap AND nordstern — type "lifi",
 *      includedSteps [protocol:feeCollection, swap:<dex>]). EVM swap legs
 *      are DONE by LiFi — the fixture pins the canonical quote REQUEST
 *      through our /api/lifi/quote policy (same-chain → NOT x1-class → the
 *      1% integrator fee is FORCED, resolveForcedFee) + the exact upstream
 *      URL the proxy fetches, with the frozen live swap-route quote as the
 *      input fixture.
 *
 * LIVE-STATUS BOUNDARY (honest — same discipline as every phase):
 *   - The Jupiter quote + the LiFi same-chain quote are LIVE captures
 *     (2026-09-02, read-only — no signing, no broadcast), frozen as oracle
 *     INPUTS. The oracle pins the CONSTRUCTION given the same quote — the
 *     same way the forward leg freezes the LiFi quote.
 *   - The XDEX pool snapshot is a LIVE capture of the X1 mainnet pool state
 *     (vault raw balances + the AmmConfig fee decode) — dated in the file;
 *     refresh on first live use (the fixture's quote math is deterministic
 *     FROM the snapshot).
 *   - XDEX arg semantics are LIVE-CONFIRMED 1:1 by the anchor swap tx
 *     65xjdHVd… (slot 76,014,947 — Mr. Esters' controlled $5 swap: 5 USDC.x
 *     → ~12.74 XNT on pool CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR,
 *     err ok): the decoded args (disc 8fbe5adac41e33de, amount_in 5,000,000
 *     LE, min_out 0 LE) + the inner Token-2022/Token TransferChecked vault
 *     moves match this construction. The sample below IS the live swap
 *     (user = the anchor signer, amount = the anchor amount_in; slippageBps
 *     10000 reproduces the anchor's min_out = 0 byte-for-byte — a real flow
 *     passes the operator's actual slippage policy, leg default 100 bps).
 *     before real funds.
 *
 * DETERMINISM
 *   - Wallet addresses = the repo's own test constants (SOLANA_ADDRESS /
 *     EVM_ADDRESS — the same wallets the forward/reverse fixtures use).
 *   - The XDEX tx uses a deterministic SYNTHETIC blockhash (DI — the live
 *     leg fetches a fresh one; the fixture pins the construction).
 *   - No network, no wallet, no chain: every shape* function is pure + DI.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVM_ADDRESS, SOLANA_ADDRESS, canonicalJson, sha256Of, sha256Bytes } from "./forwardLegBuilders.mjs";
import {
  shapeJupiterQuoteRequestArtifact,
  shapeJupiterSwapRequestArtifact,
  JUPITER_SWAP_API,
  JUPITER_QUOTE_PATH,
  JUPITER_SWAP_INSTRUCTIONS_PATH,
} from "../../src/engine/legs/dex/jupiterSwapLeg.js";
import {
  shapeXdexSwapArtifact,
  xdexQuote,
  XDEX_PROGRAM_ID,
  XDEX_SWAP_BASE_INPUT_DISCRIMINATOR,
} from "../../src/engine/legs/dex/xdexSwapLeg.js";
import { shapeLifiSameChainSwapArtifact } from "../../src/engine/legs/dex/lifiEvmSwapLeg.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DEX_FIXTURES = join(here, "..", "fixtures", "golden", "dex-leg");

/** sha256 hex of a raw UTF-8 string (the URL / memo artifacts). */
export function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXED SAMPLE INPUTS — deterministic, reproducible offline. Wallets = the
// repo's own test constants (the SAME set as the forward/reverse fixtures).
// ─────────────────────────────────────────────────────────────────────────────

/** The Jupiter sample: 0.5 SOL → USDC (raw 9-dp base units), 50 bps
 *  slippage. The quote itself is the frozen LIVE input fixture. */
export const JUPITER_SAMPLE = Object.freeze({
  inputMint: "So11111111111111111111111111111111111111112", // SOL (native)
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  amount: "500000000", // 0.5 SOL raw
  slippageBps: 50,
  userPublicKey: SOLANA_ADDRESS,
  quoteFile: "jupiter-quote-input.json",
});

/** The XDEX sample = THE LIVE ANCHOR SWAP (tx 65xjdHVd…, slot 76,014,947,
 *  Mr. Esters' controlled $5 swap — 5 USDC.x → ~12.74 XNT on the live
 *  wXNT/USDC.x pool, err ok). userPubkey/amountInRaw are the anchor tx's;
 *  slippageBps 10000 reproduces the anchor's min_out = 0 byte-for-byte. The
 *  pool snapshot is the frozen LIVE input fixture. */
export const XDEX_SAMPLE = Object.freeze({
  liveTx: "65xjdHVdHKgnDgdBN7DDcUQEwMXWjRJoTHQgbSibojWY433MW7mPdLFUiuzxtfkumK52vHGR2ipYB6Bv4hsjQ3SR",
  liveSlot: "76014947",
  pool: "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR",
  inputMint: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq", // USDC.x (token_1)
  outputMint: "So11111111111111111111111111111111111111112", // wXNT (token_0)
  amountInRaw: "5000000", // 5 USDC.x raw (6 dp) — the anchor tx's amount_in
  slippageBps: 10000, // → minOutRaw = 0 = the anchor tx's min_out (no minimum)
  userPubkey: "FKBMEQ6yyEyaK49hEnct3HnKXrCDy5o6W3LcU2ojBtrZ", // the anchor tx signer
  blockhash: "96BfNwYAmZ29CRUHtMGVj6K3wESXTCVbFUVZHSXKfuXP", // deterministic SYNTHETIC (DI)
  snapshotFile: "xdex-pool-snapshot.json",
});

/** The LiFi same-chain sample: eth USDC → USDT, 10 USDC raw, 0.5% slippage,
 *  both ends = the repo-test EVM wallet. The quote is the frozen LIVE input
 *  fixture (captured THROUGH the pinned construction — see the README). */
export const LIFI_SWAP_SAMPLE = Object.freeze({
  chain: "eth",
  fromToken: "USDC",
  toToken: "USDT",
  amount: "10000000", // 10 USDC raw (6 dp)
  fromAddress: EVM_ADDRESS,
  toAddress: EVM_ADDRESS,
  slippage: 0.5,
  quoteFile: "lifi-samechain-quote-input.json",
});

// ─────────────────────────────────────────────────────────────────────────────
// INPUT FIXTURE READERS (the frozen live captures — see the README's
// live-status boundary)
// ─────────────────────────────────────────────────────────────────────────────
const read = (name) => JSON.parse(readFileSync(join(DEX_FIXTURES, name), "utf8"));
export const jupiterQuoteInput = () => read(JUPITER_SAMPLE.quoteFile);
export const xdexSnapshotInput = () => read(XDEX_SAMPLE.snapshotFile);
export const lifiSwapQuoteInput = () => read(LIFI_SWAP_SAMPLE.quoteFile);

// ─────────────────────────────────────────────────────────────────────────────
// STEP BUILDERS — each returns { step, artifact, sha256, <hash siblings> }
// ─────────────────────────────────────────────────────────────────────────────

/** Jupiter step1 — the canonical quote-request URL (raw amount, slippage bps). */
export function buildJupiterStep1({} = {}) {
  const artifact = shapeJupiterQuoteRequestArtifact({
    inputMint: JUPITER_SAMPLE.inputMint,
    outputMint: JUPITER_SAMPLE.outputMint,
    amount: JUPITER_SAMPLE.amount,
    slippageBps: JUPITER_SAMPLE.slippageBps,
  });
  return {
    step: "jupiter-step1-quote-request",
    artifact,
    sha256: sha256Of(artifact),
    urlSha256: sha256Text(artifact.url),
    meta: {
      note:
        "The canonical Jupiter quote request (GET api.jup.ag/swap/v1/quote). Amount in RAW " +
        "base units (never human units); slippage in bps; host = the current api.jup.ag/swap/v1 " +
        "(the older quote-api.jup.ag/v6 host no longer resolves). urlSha256 pins the canonical " +
        "serialized request.",
    },
  };
}

/** Jupiter step2 — the canonical swap-instructions request body (the frozen
 *  quote forwarded verbatim + the pinned session pubkey + fixed options). */
export function buildJupiterStep2({} = {}) {
  const quote = jupiterQuoteInput();
  const artifact = shapeJupiterSwapRequestArtifact({
    quote,
    userPublicKey: JUPITER_SAMPLE.userPublicKey,
  });
  return {
    step: "jupiter-step2-swap-request",
    artifact,
    sha256: sha256Of(artifact),
    bodySha256: sha256Text(JSON.stringify(artifact.body)),
    meta: {
      note:
        "The canonical swap-instructions request (POST api.jup.ag/swap/v1/swap-instructions): " +
        "the quote response forwarded VERBATIM as quoteResponse (never reshaped — the " +
        "aggregator requires the exact quote it issued) + the pinned Solana/X1 session pubkey " +
        "+ the fixed option set (wrapAndUnwrapSol, dynamicComputeUnitLimit, " +
        "prioritizationFeeLamports 'auto'). bodySha256 pins the canonical request body.",
    },
  };
}

/** XDEX step1 — the constant-product quote from the LIVE pool snapshot
 *  (0.28% trade fee on input) + minOut at the sample's slippage. */
export function buildXdexStep1({} = {}) {
  const snapshot = xdexSnapshotInput();
  const quote = xdexQuote({
    snapshot,
    inputMint: XDEX_SAMPLE.inputMint,
    amountInRaw: XDEX_SAMPLE.amountInRaw,
    slippageBps: XDEX_SAMPLE.slippageBps,
  });
  const artifact = {
    pool: snapshot.pool,
    programId: XDEX_PROGRAM_ID,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    amountInRaw: quote.inRaw,
    slippageBps: quote.slippageBps,
    tradeFeeRate: quote.tradeFeeRate,
    tradeFeeRaw: quote.tradeFeeRaw,
    netInRaw: quote.netInRaw,
    outRaw: quote.outRaw,
    outHuman: quote.outHuman,
    minOutRaw: quote.minOutRaw,
    priceImpactBps: quote.priceImpactBps,
  };
  return {
    step: "xdex-step1-swap-quote",
    artifact,
    sha256: sha256Of(artifact),
    meta: {
      note:
        "The XDEX constant-product quote (CP curve — fee on input): tradeFee = ceil(" +
        "in × 2800/1e6) from the LIVE AmmConfig decode, out = floor(Rout × net / (Rin + net)) " +
        "on the LIVE vault raw balances. The sample = the LIVE ANCHOR swap (tx 65xjdHVd…, " +
        "slot 76,014,947 — 5 USDC.x in): slippageBps 10000 reproduces the anchor's " +
        "min_out = 0 byte-for-byte (a real flow passes the operator's slippage policy; " +
        "leg default 100 bps). Deterministic FROM the frozen pool snapshot (refresh the " +
        "snapshot on first live use).",
    },
  };
}

/** XDEX step2 — the SwapBaseInput instruction (13 metas + 24-byte data) and
 *  the unsigned serialized transaction (deterministic synthetic blockhash). */
export function buildXdexStep2({} = {}) {
  const snapshot = xdexSnapshotInput();
  const artifact = shapeXdexSwapArtifact({
    snapshot,
    userPubkey: XDEX_SAMPLE.userPubkey,
    inputMint: XDEX_SAMPLE.inputMint,
    amountInRaw: XDEX_SAMPLE.amountInRaw,
    slippageBps: XDEX_SAMPLE.slippageBps,
    blockhash: XDEX_SAMPLE.blockhash,
  });
  return {
    step: "xdex-step2-swap-ix",
    artifact,
    sha256: sha256Of(artifact),
    dataSha256: sha256Bytes(Buffer.from(artifact.ix.dataHex, "hex")),
    txSha256: sha256Text(artifact.transaction.serializedBase64),
    meta: {
      note:
        "The XDEX SwapBaseInput instruction + unsigned tx — ANCHORED TO THE LIVE MAINNET SWAP " +
        "tx 65xjdHVd… (slot 76,014,947, err ok — Mr. Esters' controlled $5 swap, 5 USDC.x → " +
        "~12.74 XNT on pool CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR): disc " +
        "8fbe5adac41e33de (sha256(global:swap_base_input)[..8] — LIVE-VERIFIED) + amount_in " +
        "u64 LE (5,000,000) + min_out u64 LE (0); 13 accounts in the LIVE-VERIFIED order " +
        "(payer signer, authority 9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU, amm_config " +
        "2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c, pool, input ATA GvBWHMoBjrWhNzypAmD6sErMPWFXqCqvTwvsYsfh7A8V, " +
        "output ATA RC4yGH6Yh477r4FYSAxZjGXrWsGqT2tdTtt2sGnS3Dd, input vault " +
        "7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg, output vault " +
        "8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb, Token-2022, Token, USDC.x mint, wXNT " +
        "mint, observation 4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ); ATAs derived " +
        "offline. dataSha256 pins the instruction bytes; txSha256 pins the serialized tx " +
        "(synthetic DI'd blockhash). If the program is ever upgraded, re-anchor from a NEW " +
        "live swap — never from a note.",
    },
  };
}

/** LiFi same-chain (Leg C verdict) — the canonical quote request through the
 *  /api/lifi/quote policy (forced 1% integrator fee on same-chain) + the
 *  exact upstream URL the proxy fetches. */
export function buildLifiSwapStep1({} = {}) {
  const artifact = shapeLifiSameChainSwapArtifact({
    chain: LIFI_SWAP_SAMPLE.chain,
    fromTokenSymbol: LIFI_SWAP_SAMPLE.fromToken,
    toTokenSymbol: LIFI_SWAP_SAMPLE.toToken,
    amount: LIFI_SWAP_SAMPLE.amount,
    fromAddress: LIFI_SWAP_SAMPLE.fromAddress,
    toAddress: LIFI_SWAP_SAMPLE.toAddress,
    slippage: LIFI_SWAP_SAMPLE.slippage,
  });
  return {
    step: "lifi-step1-samechain-swap-request",
    artifact,
    sha256: sha256Of(artifact),
    urlSha256: sha256Text(artifact.upstreamUrl),
    meta: {
      note:
        "The canonical LiFi EVM same-chain swap quote request (Leg-C verdict leg): both ends " +
        "on the same chain → LiFi returns a SWAP route (verified live: sushiswap + nordstern, " +
        "type lifi, includedSteps [protocol:feeCollection, swap:<dex>]) and the server fee " +
        "policy FORCES the 1% integrator fee (same-chain routes are not x1-class). urlSha256 " +
        "pins the exact upstream URL the proxy fetches (li.quest/v1/quote).",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FULL CAPTURE — one entry point for the capture script + the golden test
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build ALL Phase-4 dex-leg fixtures from the frozen live input captures.
 * Returns the capture objects {step, artifact, sha256, ...} plus the sample
 * inputs + the swap-route evidence pin (all deterministic).
 */
export function captureDexLeg() {
  const jupiterStep1 = buildJupiterStep1();
  const jupiterStep2 = buildJupiterStep2();
  const xdexStep1 = buildXdexStep1();
  const xdexStep2 = buildXdexStep2();
  const lifiStep1 = buildLifiSwapStep1();
  const jupiterQuote = jupiterQuoteInput();
  const lifiQuote = lifiSwapQuoteInput();
  const snapshot = xdexSnapshotInput();

  return {
    tool: "golden-transaction fixtures — the DEX swap legs (regression oracle, Phase 4)",
    capturedAt: new Date().toISOString(),
    liveStatus: {
      note:
        "Input fixtures are LIVE read-only captures (2026-09-02): the Jupiter quote, the LiFi " +
        "same-chain quote and the XDEX pool snapshot. The oracle pins the CONSTRUCTION given " +
        "the same inputs. XDEX arg semantics (disc 8fbe5adac41e33de, amount_in u64 LE + min_out " +
        "u64 LE) are LIVE-CONFIRMED 1:1 by the anchor swap tx 65xjdHVd… (slot 76,014,947, " +
        "err ok — Mr. Esters' controlled $5 swap on pool " +
        "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR); the xdex sample IS that swap.",
      replaceWith:
        "On first live use: refresh the XDEX pool snapshot (tools/capture-xdex-snapshot.mjs " +
        "equivalent — read-only RPC) and re-run tools/capture-dex-golden-fixtures.mjs.",
    },
    samples: {
      jupiter: { inputMint: JUPITER_SAMPLE.inputMint, outputMint: JUPITER_SAMPLE.outputMint, amount: JUPITER_SAMPLE.amount, slippageBps: JUPITER_SAMPLE.slippageBps, userPublicKey: JUPITER_SAMPLE.userPublicKey },
      xdex: { pool: XDEX_SAMPLE.pool, inputMint: XDEX_SAMPLE.inputMint, outputMint: XDEX_SAMPLE.outputMint, amountInRaw: XDEX_SAMPLE.amountInRaw, slippageBps: XDEX_SAMPLE.slippageBps, userPubkey: XDEX_SAMPLE.userPubkey, blockhash: XDEX_SAMPLE.blockhash },
      lifi: { chain: LIFI_SWAP_SAMPLE.chain, fromToken: LIFI_SWAP_SAMPLE.fromToken, toToken: LIFI_SWAP_SAMPLE.toToken, amount: LIFI_SWAP_SAMPLE.amount, fromAddress: LIFI_SWAP_SAMPLE.fromAddress },
    },
    evidence: {
      jupiterQuote: {
        file: JUPITER_SAMPLE.quoteFile,
        outAmount: jupiterQuote.outAmount,
        routePlan: (jupiterQuote.routePlan || []).map((r) => r.swapInfo?.label || "?"),
        sha256: sha256Of(jupiterQuote),
      },
      lifiSameChainQuote: {
        file: LIFI_SWAP_SAMPLE.quoteFile,
        type: lifiQuote.type,
        tool: lifiQuote.tool,
        includedSteps: (lifiQuote.includedSteps || []).map((s) => `${s.type}:${s.tool}`),
        sha256: sha256Of(lifiQuote),
      },
      xdexSnapshot: {
        file: XDEX_SAMPLE.snapshotFile,
        capturedAt: snapshot.capturedAt,
        pool: snapshot.pool,
        programId: snapshot.programId,
        poolDiscriminator: snapshot.poolDiscriminator,
        tradeFeeRate: snapshot.ammConfig?.tradeFeeRate,
        vault0Raw: snapshot.vault0?.amountRaw,
        vault1Raw: snapshot.vault1?.amountRaw,
      },
    },
    steps: {
      jupiterStep1QuoteRequest: jupiterStep1,
      jupiterStep2SwapRequest: jupiterStep2,
      xdexStep1SwapQuote: xdexStep1,
      xdexStep2SwapIx: xdexStep2,
      lifiStep1SameChainSwapRequest: lifiStep1,
    },
  };
}

export { canonicalJson, sha256Of, sha256Bytes, EVM_ADDRESS, SOLANA_ADDRESS };
export { JUPITER_SWAP_API, JUPITER_QUOTE_PATH, JUPITER_SWAP_INSTRUCTIONS_PATH };
export { XDEX_PROGRAM_ID, XDEX_SWAP_BASE_INPUT_DISCRIMINATOR };
