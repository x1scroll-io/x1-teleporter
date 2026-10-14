/**
 * solanaSdk.js — the OFFICIAL-SDK instruction builders for the Solana
 * dexDirect legs' signable-execute path.
 *
 * Standing rule (Mr. Esters): every protocol integration uses the official
 * SDK. The dexDirect quote artifacts were already cross-checked against
 * these SDKs on identical state (frozen in the dex-direct fixtures); this
 * module makes the EXECUTE instruction construction official too:
 *
 *   Raydium CPMM → @raydium-io/raydium-sdk-v2 makeSwapCpmmBaseInInstruction
 *   Raydium CLMM → @raydium-io/raydium-sdk-v2 ClmmInstrument.swapV2Instruction
 *   Orca Whirlpool → @orca-so/whirlpools-sdk WhirlpoolIx.swapV2Ix
 *
 * BYTE-PARITY VERIFIED 2026-09-07 (this phase): against the frozen
 * dex-direct step2 artifacts, each official builder reproduces the pinned
 * instruction byte-for-byte — same program id, same 13/15+/15 account
 * metas, same data hex (discriminator + u64 amounts + u128 price limit +
 * flags). The repo's hand-verified construction (live read-only sims on
 * mainnet during capture) and the official SDK agree exactly.
 *
 * FAIL-CLOSED DRIFT CANARY: every builder re-derives the canonical pinned
 * artifact through the leg's own shape function (the frozen-construction
 * source) and compares the SDK instruction against it. If a future SDK
 * release ever changes a layout, the builder THROWS here — before anything
 * is serialized or signed — instead of producing a broken instruction
 * (the xdexSwapLeg discipline, live-proven on X1).
 *
 * 🔴 FUNDS RULE: these builders CONSTRUCT instructions only. Nothing here
 * signs, serializes a broadcast, or touches a send path. The heavy SDKs
 * are dynamic-imported (bundle discipline — the main bundle never carries
 * raydium-sdk-v2 / @orca-so/whirlpools-sdk / anchor).
 */
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { shapeRaydiumCpmmArtifact, shapeRaydiumClmmArtifact } from "./raydiumSwapLeg.js";
import { shapeOrcaSwapArtifact } from "./orcaSwapLeg.js";
import {
  RAYDIUM_CLMM_MIN_SQRT_PRICE_X64,
  RAYDIUM_CLMM_MAX_SQRT_PRICE_X64,
} from "./solanaMath.js";
import { ORCA_WHIRLPOOL_PROGRAM_ID } from "./orcaSwapLeg.js";
import { SPL_TOKEN_PROGRAM_ID } from "./orcaSwapLeg.js";

// ── Official-SDK loaders (heavy-SDK discipline — cached dynamic imports) ──
// Mirrors the xdexSwapLeg loader: the SDK is imported ONLY when an
// instruction is actually constructed, so the Vite main bundle never
// carries it. Each loader caches its promise; a transient failure resets
// for one retry.

let raydiumCpmmBuilderPromise = null;
function loadRaydiumCpmmBuilder() {
  if (!raydiumCpmmBuilderPromise) {
    raydiumCpmmBuilderPromise = import("@raydium-io/raydium-sdk-v2")
      .then((m) => {
        const fn = m?.makeSwapCpmmBaseInInstruction ?? m?.default?.makeSwapCpmmBaseInInstruction;
        if (typeof fn !== "function") {
          throw new Error("solanaSdk: @raydium-io/raydium-sdk-v2 does not export makeSwapCpmmBaseInInstruction");
        }
        return fn;
      })
      .catch((e) => {
        raydiumCpmmBuilderPromise = null;
        throw e;
      });
  }
  return raydiumCpmmBuilderPromise;
}

let raydiumClmmInstrumentPromise = null;
function loadRaydiumClmmInstrument() {
  if (!raydiumClmmInstrumentPromise) {
    raydiumClmmInstrumentPromise = import("@raydium-io/raydium-sdk-v2")
      .then((m) => {
        const inst = m?.ClmmInstrument ?? m?.default?.ClmmInstrument;
        if (typeof inst?.swapV2Instruction !== "function") {
          throw new Error("solanaSdk: @raydium-io/raydium-sdk-v2 does not export ClmmInstrument.swapV2Instruction");
        }
        return inst;
      })
      .catch((e) => {
        raydiumClmmInstrumentPromise = null;
        throw e;
      });
  }
  return raydiumClmmInstrumentPromise;
}

let orcaSdkPromise = null;
function loadOrcaSdk() {
  if (!orcaSdkPromise) {
    orcaSdkPromise = import("@orca-so/whirlpools-sdk")
      .then((m) => {
        const sdk = m?.default ?? m;
        if (typeof sdk?.WhirlpoolIx?.swapV2Ix !== "function" || typeof sdk?.WhirlpoolContext?.from !== "function") {
          throw new Error("solanaSdk: @orca-so/whirlpools-sdk does not export WhirlpoolIx.swapV2Ix / WhirlpoolContext.from");
        }
        return sdk;
      })
      .catch((e) => {
        orcaSdkPromise = null;
        throw e;
      });
  }
  return orcaSdkPromise;
}

function toPubkey(pk) {
  return pk instanceof PublicKey ? pk : new PublicKey(pk);
}

/** Normalize a web3 TransactionInstruction to the artifact's ix JSON shape. */
function normalizeIx(ix) {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    dataHex: Buffer.from(ix.data).toString("hex"),
  };
}

/**
 * THE FAIL-CLOSED DRIFT CANARY — the SDK-built instruction must equal the
 * canonical pinned artifact byte-for-byte (program id + account metas +
 * data). A changed SDK layout throws HERE, before anything is serialized
 * or signed.
 */
function assertMatchesCanonical(sdkIx, canonicalIx, dexLabel) {
  const sdk = normalizeIx(sdkIx);
  const want = {
    programId: canonicalIx.programId,
    keys: canonicalIx.keys,
    dataHex: canonicalIx.dataHex,
  };
  if (sdk.programId !== want.programId) {
    throw new Error(`solanaSdk: ${dexLabel} SDK program id drifted (${sdk.programId} vs ${want.programId}) — refusing to construct`);
  }
  if (JSON.stringify(sdk.keys) !== JSON.stringify(want.keys)) {
    throw new Error(`solanaSdk: ${dexLabel} SDK account layout drifted from the pinned artifact — refusing to construct`);
  }
  if (sdk.dataHex !== want.dataHex) {
    throw new Error(`solanaSdk: ${dexLabel} SDK instruction data drifted from the pinned artifact — refusing to construct`);
  }
}

// ── Raydium CPMM ────────────────────────────────────────────────────────────

/**
 * Build the Raydium CPMM swap_base_input instruction with the OFFICIAL SDK
 * (@raydium-io/raydium-sdk-v2 makeSwapCpmmBaseInInstruction — the same
 * builder the live-anchored XDEX leg proved on X1, here on Raydium
 * mainnet's own CPMM program). Canonical args mirror
 * shapeRaydiumCpmmArtifact.
 *
 * @returns {Promise<{ix: TransactionInstruction, canonical: object}>} the
 *   SDK instruction + the pinned canonical artifact it was checked against
 */
export async function makeRaydiumCpmmSwapIx({ snapshot, userPubkey, inputMint, amountInRaw, amountOutMinRaw = null, slippageBps = 100 }) {
  const canonical = shapeRaydiumCpmmArtifact({
    snapshot,
    userPubkey,
    inputMint,
    amountInRaw: String(amountInRaw),
    slippageBps,
    ...(amountOutMinRaw !== null ? { amountOutMinRaw: String(amountOutMinRaw) } : {}),
  });
  const pool = snapshot.pool;
  const user = toPubkey(userPubkey);
  const quote = canonical.quote;
  const quoteDir = snapshotQuoteDirectionCpmm(snapshot, String(inputMint));
  const inputProgram = quoteDir.inputIsA ? pool.mintProgramA : pool.mintProgramB;
  const outputProgram = quoteDir.inputIsA ? pool.mintProgramB : pool.mintProgramA;
  const inputAta = getAssociatedTokenAddressSync(toPubkey(quoteDir.inputMint), user, true, toPubkey(inputProgram));
  const outputAta = getAssociatedTokenAddressSync(toPubkey(quoteDir.outputMint), user, true, toPubkey(outputProgram));

  const makeSwapIx = await loadRaydiumCpmmBuilder();
  const ix = makeSwapIx(
    toPubkey(pool.programId), // the Raydium CPMM program (CPMMoo8…)
    user, // payer
    toPubkey(snapshot.authority), // vault-authority PDA
    toPubkey(pool.configId), // amm_config
    toPubkey(pool.pool), // pool
    inputAta,
    outputAta,
    toPubkey(quoteDir.inputVault),
    toPubkey(quoteDir.outputVault),
    toPubkey(inputProgram),
    toPubkey(outputProgram),
    toPubkey(quoteDir.inputMint),
    toPubkey(quoteDir.outputMint),
    toPubkey(pool.observationId),
    new BN(quote.amountInRaw),
    new BN(quote.amountOutMinRaw),
  );
  assertMatchesCanonical(ix, canonical.ix, "raydium cpmm");
  return { ix, canonical };
}

/** CPMM direction resolver (mirror of raydiumCpmmQuote's side selection). */
export function snapshotQuoteDirectionCpmm(snapshot, inputMint) {
  const pool = snapshot.pool;
  const inputIsA = inputMint === pool.mintA;
  if (!inputIsA && inputMint !== pool.mintB) {
    throw new Error(`snapshotQuoteDirectionCpmm: inputMint ${inputMint} is not a mint of pool ${pool.pool}`);
  }
  return {
    inputIsA,
    inputMint,
    outputMint: inputIsA ? pool.mintB : pool.mintA,
    inputVault: inputIsA ? pool.vaultA : pool.vaultB,
    outputVault: inputIsA ? pool.vaultB : pool.vaultA,
  };
}

// ── Raydium CLMM ────────────────────────────────────────────────────────────

/** CLMM direction resolver (mirror of raydiumClmmQuote's zeroForOne). */
export function snapshotQuoteDirectionClmm(snapshot, inputMint) {
  const pool = snapshot.pool;
  const zeroForOne = inputMint === pool.mintA;
  if (!zeroForOne && inputMint !== pool.mintB) {
    throw new Error(`snapshotQuoteDirectionClmm: inputMint ${inputMint} is not a mint of pool ${pool.pool}`);
  }
  return {
    zeroForOne,
    inputMint,
    outputMint: zeroForOne ? pool.mintB : pool.mintA,
    inputVault: zeroForOne ? pool.vaultA : pool.vaultB,
    outputVault: zeroForOne ? pool.vaultB : pool.vaultA,
    inputProgram: zeroForOne ? pool.mintProgramA || SPL_TOKEN_PROGRAM_ID : pool.mintProgramB || SPL_TOKEN_PROGRAM_ID,
    outputProgram: zeroForOne ? pool.mintProgramB || SPL_TOKEN_PROGRAM_ID : pool.mintProgramA || SPL_TOKEN_PROGRAM_ID,
  };
}

/**
 * Build the Raydium CLMM swap_v2 instruction with the OFFICIAL SDK
 * (ClmmInstrument.swapV2Instruction). Canonical args mirror
 * shapeRaydiumClmmArtifact; the sqrt-price limit defaults to the leg's
 * trade-direction extreme (no-limit convention) when not supplied.
 *
 * @returns {Promise<{ix: TransactionInstruction, canonical: object}>}
 */
export async function makeRaydiumClmmSwapIx({ snapshot, userPubkey, inputMint, amountInRaw, amountOutMinRaw = null, slippageBps = 100, sqrtPriceLimitX64 = null }) {
  const canonical = shapeRaydiumClmmArtifact({
    snapshot,
    userPubkey,
    inputMint,
    amountInRaw: String(amountInRaw),
    slippageBps,
    ...(amountOutMinRaw !== null ? { amountOutMinRaw: String(amountOutMinRaw) } : {}),
    ...(sqrtPriceLimitX64 !== null ? { sqrtPriceLimitX64: String(sqrtPriceLimitX64) } : {}),
  });
  const pool = snapshot.pool;
  const user = toPubkey(userPubkey);
  const quote = canonical.quote;
  const dir = snapshotQuoteDirectionClmm(snapshot, String(inputMint));
  const zeroForOne = dir.zeroForOne;
  const inputAta = getAssociatedTokenAddressSync(toPubkey(dir.inputMint), user, true, toPubkey(dir.inputProgram));
  const outputAta = getAssociatedTokenAddressSync(toPubkey(dir.outputMint), user, true, toPubkey(dir.outputProgram));
  const limit = sqrtPriceLimitX64 !== null
    ? BigInt(String(sqrtPriceLimitX64))
    : (zeroForOne ? RAYDIUM_CLMM_MIN_SQRT_PRICE_X64 + 1n : RAYDIUM_CLMM_MAX_SQRT_PRICE_X64 - 1n);

  const ClmmInstrument = await loadRaydiumClmmInstrument();
  const ix = ClmmInstrument.swapV2Instruction(
    toPubkey(pool.programId), // the Raydium CLMM program (CAMMCzo5…)
    user, // payer
    toPubkey(pool.pool), // poolId
    toPubkey(pool.configId), // ammConfig
    inputAta,
    outputAta,
    toPubkey(dir.inputVault),
    toPubkey(dir.outputVault),
    toPubkey(dir.inputMint),
    toPubkey(dir.outputMint),
    snapshot.tickArrays.map((t) => toPubkey(t.address)), // tickArray[]
    toPubkey(pool.observationId),
    new BN(quote.amountInRaw),
    new BN(quote.amountOutMinRaw),
    new BN(limit.toString()),
    true, // isBaseInput — this leg quotes base-in
    toPubkey(snapshot.pdas.bitmapExtension),
  );
  assertMatchesCanonical(ix, canonical.ix, "raydium clmm");
  return { ix, canonical };
}

// ── Orca Whirlpool ──────────────────────────────────────────────────────────

/**
 * Build the Orca Whirlpool swap_v2 instruction with the OFFICIAL SDK
 * (@orca-so/whirlpools-sdk WhirlpoolIx.swapV2Ix — anchor-built against the
 * SDK's bundled Whirlpool IDL). `readHandle` is the minimal connection
 * surface the anchor SDK requires for Program construction (instruction
 * building never calls it — a stub satisfies it). Canonical args mirror
 * shapeOrcaSwapArtifact.
 *
 * @returns {Promise<{ix: TransactionInstruction, canonical: object}>}
 */
export async function makeOrcaSwapV2Ix({ snapshot, userPubkey, inputMint, amountInRaw, amountOutMinRaw = null, slippageBps = 100, sqrtPriceLimit = null, readHandle }) {
  const canonical = shapeOrcaSwapArtifact({
    snapshot,
    userPubkey,
    inputMint,
    amountInRaw: String(amountInRaw),
    slippageBps,
    ...(amountOutMinRaw !== null ? { amountOutMinRaw: String(amountOutMinRaw) } : {}),
    ...(sqrtPriceLimit !== null ? { sqrtPriceLimit: String(sqrtPriceLimit) } : {}),
  });
  const wp = snapshot.whirlpool;
  const user = toPubkey(userPubkey);
  const aToB = String(inputMint) === wp.mintA;
  if (!aToB && inputMint !== wp.mintB) {
    throw new Error(`makeOrcaSwapV2Ix: inputMint ${inputMint} is not a mint of whirlpool ${wp.pool}`);
  }
  const tokenProgramA = snapshot.tokenProgramA || SPL_TOKEN_PROGRAM_ID;
  const tokenProgramB = snapshot.tokenProgramB || SPL_TOKEN_PROGRAM_ID;
  const ataA = getAssociatedTokenAddressSync(toPubkey(wp.mintA), user, true, toPubkey(tokenProgramA));
  const ataB = getAssociatedTokenAddressSync(toPubkey(wp.mintB), user, true, toPubkey(tokenProgramB));
  const quote = canonical.quote;

  const sdk = await loadOrcaSdk();
  const ctx = sdk.WhirlpoolContext.from(readHandle, { publicKey: user }, ORCA_WHIRLPOOL_PROGRAM_ID);
  const built = sdk.WhirlpoolIx.swapV2Ix(ctx.program, {
    whirlpool: toPubkey(wp.pool),
    tokenMintA: toPubkey(wp.mintA),
    tokenMintB: toPubkey(wp.mintB),
    tokenOwnerAccountA: ataA,
    tokenOwnerAccountB: ataB,
    tokenVaultA: toPubkey(wp.vaultA),
    tokenVaultB: toPubkey(wp.vaultB),
    tokenProgramA: toPubkey(tokenProgramA),
    tokenProgramB: toPubkey(tokenProgramB),
    tickArray0: toPubkey(snapshot.tickArrays[0].address),
    tickArray1: toPubkey(snapshot.tickArrays[1].address),
    tickArray2: toPubkey(snapshot.tickArrays[2].address),
    oracle: toPubkey(snapshot.oracle),
    tokenAuthority: user,
    amount: new BN(quote.amountInRaw),
    otherAmountThreshold: new BN(quote.amountOutMinRaw),
    sqrtPriceLimit: new BN(canonical.ix.sqrtPriceLimit),
    amountSpecifiedIsInput: true,
    aToB,
    supplementalTickArrays: [],
  });
  const ix = built.instructions[0];
  assertMatchesCanonical(ix, canonical.ix, "orca whirlpool");
  return { ix, canonical };
}

