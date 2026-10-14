/**
 * xdexSwapLeg.js — the XDEX swap leg of the routing engine's DEX family
 * (Phase 4). XDEX = X1's DEX — a Raydium-CP-Swap-style AMM running ON X1.
 * The leg is a DIRECT integration (no aggregator router, no HTTP swap API —
 * XDEX has none; see the discovery note): the swap is a single on-chain
 * instruction to the XDEX program that the app constructs + signs itself.
 *
 * ⛔ NEBULA WALL-OFF — READ FIRST. Nebula DEX is a SEPARATE project (sibling
 * dirs: nebula-dex, nebula-dex-fork, nebula-dex-site + audit zips in the
 * workspace). Its notes/docs must NEVER inform XDEX or Teleporter reasoning.
 * XDEX truth = its own live on-chain data ONLY (the anchor tx below, live
 * pool snapshots, the program's real logs). This module was once
 * contaminated by nebula-derived discriminator claims (Phase-4 pinned
 * 13bddf5c73d6bd24 from a misread sample); that is corrected here and every
 * nebula reference purged. If you are tempted to "fix" a value from a
 * nebula note or any doc — STOP: the anchor tx below is the source of
 * truth.
 *
 * DISCOVERY (2026-09-02 — the real API is not HTTP): api.xdex.xyz exposes
 * price/token endpoints only (/api/token-price/price works; /api/pools is
 * Cloudflare-gated; every /api/swap/*, /api/v1/*, /api/pool/* probe 404s).
 * The REAL swap surface is the XDEX program on X1 mainnet:
 *
 *   program     sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN
 *               owner BPFLoaderUpgradeab1e — UPGRADEABLE (verified on-chain
 *               2026-09-02, slot 76,017,299). NOT immutable. The values
 *               pinned below are the CURRENT live code's; if the program is
 *               ever upgraded, re-verify against a NEW live swap — never
 *               against a note.
 *   method      SwapBaseInput (Anchor log "Instruction: SwapBaseInput" on
 *               live txs) — args (amount_in u64, minimum_amount_out u64)
 *   data        24 bytes: 8-byte discriminator 8fbe5adac41e33de + amount_in
 *               u64 LE + minimum_amount_out u64 LE
 *   accounts    13 metas (verified order + writable flags on the live
 *               anchor tx): payer(signer,wr) authority(ro) amm_config(ro)
 *               pool(wr) input ATA(wr) output ATA(wr) input vault(wr)
 *               output vault(wr) input token program(ro) output token
 *               program(ro) input mint(ro) output mint(ro) observation(wr)
 *
 * 🔒 LIVE-TX ANCHOR (source of truth — do NOT "correct" from any doc):
 *   tx      65xjdHVdHKgnDgdBN7DDcUQEwMXWjRJoTHQgbSibojWY433MW7mPdLFUiuzxtf
 *           kumK52vHGR2ipYB6Bv4hsjQ3SR (Mr. Esters' controlled $5 swap)
 *   slot    76,014,947 — err ok (getTransaction, jsonParsed, 2026-09-02)
 *   swap    5 USDC.x → ~12.74 XNT on pool CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA
 *           3E5HQoxRvR (wXNT/USDC.x)
 *   data    8fbe5adac41e33de + 404b4c0000000000 (amount_in = 5,000,000 LE)
 *           + 0000000000000000 (min_out = 0 LE) — decoded from the tx
 *   accounts the 13-metas order above, 1:1 with this leg's construction
 *           (user FKBMEQ6yyEyaK49hEnct3HnKXrCDy5o6W3LcU2ojBtrZ signer;
 *           authority 9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU;
 *           amm_config 2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c; pool
 *           CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR; input ATA
 *           GvBWHMoBjrWhNzypAmD6sErMPWFXqCqvTwvsYsfh7A8V; output ATA
 *           RC4yGH6Yh477r4FYSAxZjGXrWsGqT2tdTtt2sGnS3Dd; input vault
 *           7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg; output vault
 *           8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb; Token-2022;
 *           Token; USDC.x mint B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq;
 *           wXNT mint So11111111111111111111111111111111111111112;
 *           observation 4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ)
 *
 * The discriminator 8fbe5adac41e33de = sha256("global:swap_base_input")[..8]
 * under classic Anchor — verified on the anchor tx above AND on 3 further
 * live XDEX swaps (5cRHH7p…, 33x2Dbp…, 5vuNvHL…), all err:ok. (The
 * Phase-4 pin 13bddf5c73d6bd24 was a misread — sampled non-swap
 * instructions / confused program — and has been corrected.)
 *
 * SDK CONSTRUCTION (feat/leg-sdk-audit — the standing official-SDK rule):
 * XDEX is a Raydium-CPMM fork running ON X1 with NO SDK of its own, so the
 * swap instruction is built by @raydium-io/raydium-sdk-v2's
 * makeSwapCpmmBaseInInstruction — the official Raydium SDK — with the
 * XDEX program id + the live pool's key set. This is correct by
 * construction: the SDK emits the SAME 8-byte discriminator (8fbe5adac41e33de),
 * the SAME amountIn/amounOutMin u64 LE layout and the SAME 13-account
 * order this leg previously hand-assembled from on-chain decoding — the
 * hand-rolled-discriminator/account-layout bug class is gone. LIVE-PROVEN
 * 2026-09-06 (slot 76,980,xxx): the SDK-built instruction SIMULATED
 * err:null on X1 mainnet (sigVerify:false) and executed the identical CP
 * swap — see docs/LEG-SDK-AUDIT.md §xdex. One documented divergence: the
 * SDK marks the fee payer READONLY at the ix level (upstream Raydium
 * shape; the live XDEX anchor tx 65xjdHVd… marked it writable). Both are
 * accepted by the live program (proven by simulation), and the serialized
 * legacy transaction is BYTE-IDENTICAL either way — @solana/web3.js
 * forces the fee-payer meta writable when it compiles the message (the
 * xdex step2 fixture's txSha256 is unchanged by this refactor).
 *
 * ARG-SEMANTICS — LIVE-CONFIRMED 1:1 (2026-09-02, the anchor tx): the
 * controlled swap above proves the layout (amount_in u64 LE + min_out u64
 * LE, 13-account order, disc 8fbe5adac41e33de) byte-for-byte: the decoded
 * args (5,000,000 / 0) + the inner Token-2022 TransferChecked into the
 * USDC.x vault + the Token TransferChecked out of the wXNT vault match the
 * CP quote within vault drift. The quote math below is also live-confirmed:
 * the CP curve + the fee config (trade 0.28% = 2800/1e6, protocol 25% +
 * fund 5% of the trade fee, creator 0 — decoded from the live AmmConfig in
 * the pool snapshot) reproduce the observed swap economics within rounding
 * (raw-ratio price 0.3973 vs the XNT price API 0.3926 USD — sane).
 * Refresh the pool snapshot before any real flow (vault balances move).
 *
 * QUOTE MATH (constant product, fee on input — Raydium curve):
 *   tradeFee  = ceil(amountInRaw × tradeFeeRate / 1_000_000)
 *   netIn     = amountInRaw − tradeFee
 *   outRaw    = floor(Rout × netIn / (Rin + netIn))     (Rin/Rout = vault
 *               raw balances of the input/output side from the pool snapshot)
 *   minOut    = floor(outRaw × (10000 − slippageBps) / 10000)
 * The input vault physically receives the GROSS amountIn; the fee accrues
 * in the vault for the protocol/fund collectors (Raydium semantics).
 *
 * ctx: { snapshot (the pool snapshot — vault balances + fee config + the
 *        fixed key set), userPubkey (X1/SVM session pubkey), inputMint,
 *        outputMint, amountInRaw, slippageBps?, blockhash? (DI — tests pin
 *        a synthetic one), feePayer? (defaults to userPubkey) }
 */
import { createLeg } from "../../legContract.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";

// ── OFFICIAL-SDK LOADER (heavy-SDK discipline) ──
// @raydium-io/raydium-sdk-v2 is large; it is dynamic-imported ONLY when a
// swap instruction is actually constructed (the execute path), so the Vite
// SPA main bundle never carries it. The module loader caches the promise —
// the first construction pays the import cost, subsequent ones do not.
let raydiumSdkMakeSwapIxPromise = null;
function loadMakeSwapCpmmBaseInInstruction() {
  if (!raydiumSdkMakeSwapIxPromise) {
    raydiumSdkMakeSwapIxPromise = import("@raydium-io/raydium-sdk-v2")
      .then((m) => {
        const fn =
          m?.makeSwapCpmmBaseInInstruction ??
          m?.default?.makeSwapCpmmBaseInInstruction;
        if (typeof fn !== "function") {
          throw new Error(
            "xdexSwapLeg: @raydium-io/raydium-sdk-v2 does not export makeSwapCpmmBaseInInstruction",
          );
        }
        return fn;
      })
      .catch((e) => {
        raydiumSdkMakeSwapIxPromise = null; // allow one retry after a transient failure
        throw e;
      });
  }
  return raydiumSdkMakeSwapIxPromise;
}

/**
 * The LIVE-VERIFIED 13-account order (anchor tx 65xjdHVd…, slot 76,014,947
 * — see the module header). The SDK-built instruction is checked against
 * this list before anything is serialized: if a future Raydium SDK release
 * ever changes the CPMM swap layout, this leg fails LOUDLY instead of
 * sending a broken instruction (fail-closed drift canary).
 */
const XDEX_SWAP_ACCOUNT_ORDER = Object.freeze([
  "payer", // 0 (signer)
  "authority", // 1
  "amm_config", // 2
  "pool", // 3 (w)
  "input_ata", // 4 (w)
  "output_ata", // 5 (w)
  "input_vault", // 6 (w)
  "output_vault", // 7 (w)
  "input_token_program", // 8
  "output_token_program", // 9
  "input_mint", // 10
  "output_mint", // 11
  "observation", // 12 (w)
]);

/** The live XDEX program id on X1 mainnet — owner BPFLoaderUpgradeab1e
 *  (UPGRADEABLE — verified on-chain 2026-09-02; NOT immutable). Values in
 *  this module are the CURRENT live code's; re-verify against a NEW live
 *  swap if the program is ever upgraded. */
export const XDEX_PROGRAM_ID = "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN";
/** The live SwapBaseInput discriminator = sha256("global:swap_base_input")[..8]
 *  — LIVE-VERIFIED on the anchor swap tx 65xjdHVd… (slot 76,014,947, err ok,
 *  5 USDC.x → ~12.74 XNT) + 3 further live swaps (5cRHH7p…, 33x2Dbp…,
 *  5vuNvHL…). Anchor = source of truth; never "correct" from a note. */
export const XDEX_SWAP_BASE_INPUT_DISCRIMINATOR = "8fbe5adac41e33de";
/** Raydium/XDEX fee denominator (fee rates are hundredths of a bip, 1e-6). */
export const XDEX_FEE_DENOMINATOR = 1_000_000;
/** The pool's vault-authority PDA — read from the live pool snapshot
 *  (vault0/vault1 accountOwner) AND position 1 of the live anchor swap ix
 *  (9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU). Exported for the fixed
 *  key documentation. */
export const XDEX_AUTHORITY = "9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU";

function toPubkey(pk) {
  return pk instanceof PublicKey ? pk : new PublicKey(pk);
}

/** Resolve the side roles from the pool snapshot for a requested pair.
 *  token0/token1 come from the snapshot's poolFields (token_0_mint /
 *  token_1_mint); the input side must be one of them. Returns the input
 *  vault, output vault, token programs, decimals and mints.
 * @throws when the pair is not the snapshot's pair
 */
export function resolveXdexDirection(snapshot, inputMint) {
  const t0 = snapshot?.poolFields?.token_0_mint;
  const t1 = snapshot?.poolFields?.token_1_mint;
  if (!t0 || !t1) throw new Error("resolveXdexDirection: snapshot has no token_0_mint/token_1_mint");
  const input = String(inputMint);
  let side;
  if (input === t0) side = { inputIsToken0: true };
  else if (input === t1) side = { inputIsToken0: false };
  else throw new Error(`resolveXdexDirection: ${input} is not the snapshot's pair (${t0}/${t1})`);

  const vault0 = snapshot.vault0 || {};
  const vault1 = snapshot.vault1 || {};
  const token0 = snapshot.token0 || {};
  const token1 = snapshot.token1 || {};
  return side.inputIsToken0
    ? {
        inputIsToken0: true,
        inputMint: t0,
        outputMint: t1,
        inputVault: snapshot.poolFields.token_0_vault,
        outputVault: snapshot.poolFields.token_1_vault,
        inputProgram: snapshot.poolFields.token_0_program,
        outputProgram: snapshot.poolFields.token_1_program,
        inputDecimals: token0.decimals,
        outputDecimals: token1.decimals,
        inputReserveRaw: vault0.amountRaw,
        outputReserveRaw: vault1.amountRaw,
      }
    : {
        inputIsToken0: false,
        inputMint: t1,
        outputMint: t0,
        inputVault: snapshot.poolFields.token_1_vault,
        outputVault: snapshot.poolFields.token_0_vault,
        inputProgram: snapshot.poolFields.token_1_program,
        outputProgram: snapshot.poolFields.token_0_program,
        inputDecimals: token1.decimals,
        outputDecimals: token0.decimals,
        inputReserveRaw: vault1.amountRaw,
        outputReserveRaw: vault0.amountRaw,
      };
}

/**
 * The XDEX constant-product quote for a fixed input amount (Raydium curve —
 * fee on input, gross amount physically lands in the input vault):
 *   tradeFee = ceil(amountInRaw × tradeFeeRate / 1e6)   (creator fee 0 in
 *     the live config; when a pool's creatorFeeRate > 0 AND the pool marks
 *     creator-fee-on-input, the input fee rate is trade + creator — the
 *     formula parameterizes via the snapshot's fee rates)
 *   outRaw   = floor(Rout × (amountInRaw − tradeFee) / (Rin + amountInRaw −
 *              tradeFee))
 *
 * @param {object} args
 * @param {object} args.snapshot the live pool snapshot (vault raw balances +
 *   ammConfig fee rates)
 * @param {string} args.inputMint the input mint (token0 or token1 of the pool)
 * @param {string|number} args.amountInRaw raw input amount in base units
 * @param {number} [args.slippageBps] slippage tolerance in bps (default 100)
 * @returns {{direction, tradeFeeRate, tradeFeeRaw, netInRaw, inRaw,
 *            outRaw, minOutRaw, priceImpactBps}} deterministic quote
 */
export function xdexQuote({ snapshot, inputMint, amountInRaw, slippageBps = 100 }) {
  const dir = resolveXdexDirection(snapshot, inputMint);
  const inRaw = BigInt(String(amountInRaw));
  if (inRaw <= 0n) throw new Error("xdexQuote: a positive raw input amount is required");

  const tradeFeeRate = BigInt(snapshot?.ammConfig?.tradeFeeRate ?? 0);
  const creatorFeeRate = BigInt(snapshot?.ammConfig?.creatorFeeRate ?? 0);
  // is_creator_fee_on_input is a per-pool runtime flag (not in the static
  // snapshot); with creatorFeeRate = 0 on the live config the distinction is
  // moot — the input fee rate is trade + creator when creator fees exist.
  const inputFeeRate = tradeFeeRate + creatorFeeRate;
  const feeDen = BigInt(XDEX_FEE_DENOMINATOR);
  // ceil(a × r / d)
  const tradeFeeRaw = (inRaw * inputFeeRate + feeDen - 1n) / feeDen;
  const netInRaw = inRaw - tradeFeeRaw;
  const rin = BigInt(String(dir.inputReserveRaw));
  const rout = BigInt(String(dir.outputReserveRaw));
  const outRaw = (rout * netInRaw) / (rin + netInRaw);
  const minOutRaw = (outRaw * BigInt(10000 - slippageBps)) / 10000n;

  // price impact vs the raw reserve ratio (in the output token per input token)
  const spotOut = (rout * 10000n) / rin; // out per 10000 in, raw
  const execOut = (outRaw * 10000n) / inRaw;
  const priceImpactBps = spotOut > 0n && execOut < spotOut
    ? Number(((spotOut - execOut) * 10000n) / spotOut)
    : 0;

  return {
    ...dir,
    tradeFeeRate: tradeFeeRate.toString(),
    tradeFeeRaw: tradeFeeRaw.toString(),
    netInRaw: netInRaw.toString(),
    inRaw: inRaw.toString(),
    outRaw: outRaw.toString(),
    minOutRaw: minOutRaw.toString(),
    outHuman: Number(outRaw) / 10 ** dir.outputDecimals,
    priceImpactBps,
    slippageBps,
  };
}

/**
 * Shape the golden artifact: the swap instruction (13 metas in the verified
 * order + the 24-byte data) and — when a blockhash is supplied — the full
 * unsigned serialized transaction (fee payer = the session pubkey). ATAs are
 * derived offline (getAssociatedTokenAddressSync, allowOwnerOffCurve).
 *
 * @param {object} args
 * @param {object} args.snapshot the live pool snapshot
 * @param {string} args.userPubkey the X1/SVM session pubkey
 * @param {string} args.inputMint token0 or token1 mint (the input side)
 * @param {string|number} args.amountInRaw raw input amount
 * @param {number} [args.slippageBps] slippage tolerance in bps
 * @param {string} [args.blockhash] DI'd blockhash — present → serialize the tx
 * @param {string} [args.feePayer] defaults to userPubkey
 * @returns {object} the fixture-shaped artifact
 */
export async function shapeXdexSwapArtifact({
  snapshot,
  userPubkey,
  inputMint,
  amountInRaw,
  slippageBps = 100,
  blockhash = null,
  feePayer = null,
}) {
  const user = toPubkey(userPubkey);
  const quote = xdexQuote({ snapshot, inputMint, amountInRaw, slippageBps });
  const payer = feePayer ? toPubkey(feePayer) : user;

  const inputAta = getAssociatedTokenAddressSync(
    toPubkey(quote.inputMint),
    user,
    true, // allowOwnerOffCurve — the engine's session pubkeys can be PDAs
    toPubkey(quote.inputProgram),
  );
  const outputAta = getAssociatedTokenAddressSync(
    toPubkey(quote.outputMint),
    user,
    true,
    toPubkey(quote.outputProgram),
  );

  // ── OFFICIAL-SDK CONSTRUCTION (@raydium-io/raydium-sdk-v2) ──
  // XDEX is a Raydium-CPMM fork on X1 with no SDK of its own; the swap
  // instruction is built by the official Raydium SDK with the XDEX program
  // id + the live key set. The SDK emits the same 8fbe5adac41e33de
  // discriminator, the same u64-LE amount layout and the same 13-account
  // order this leg used to hand-assemble (LIVE-PROVEN on X1 mainnet by
  // simulation 2026-09-06 — see the module header + docs/LEG-SDK-AUDIT.md).
  const makeSwapIx = await loadMakeSwapCpmmBaseInInstruction();
  const ix = makeSwapIx(
    toPubkey(XDEX_PROGRAM_ID), // programId — the XDEX program on X1
    payer, // payer (SDK shape: signer, READONLY — accepted by the live program)
    toPubkey(XDEX_AUTHORITY), // authority
    toPubkey(snapshot.poolFields.amm_config), // amm_config
    toPubkey(snapshot.pool), // pool
    inputAta, // user input ATA
    outputAta, // user output ATA
    toPubkey(quote.inputVault), // input vault
    toPubkey(quote.outputVault), // output vault
    toPubkey(quote.inputProgram), // input token program
    toPubkey(quote.outputProgram), // output token program
    toPubkey(quote.inputMint), // input mint
    toPubkey(quote.outputMint), // output mint
    toPubkey(snapshot.poolFields.observation_key), // observation
    new BN(quote.inRaw), // amountIn (u64 LE)
    new BN(quote.minOutRaw), // amounOutMin (u64 LE)
  );

  // FAIL-CLOSED DRIFT CANARY: the SDK-built account list must equal the
  // LIVE-VERIFIED 13-account order (anchor tx 65xjdHVd…) and carry the
  // verified 24-byte payload. A changed layout/discriminator throws HERE —
  // before anything could be serialized or signed — instead of sending a
  // broken instruction. (The SDK marks the payer readonly; the live anchor
  // marked it writable — both accepted by the program, and the serialized
  // legacy message is identical either way because @solana/web3.js forces
  // the fee-payer meta writable at compile time.)
  const ixKeys = ix.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));
  const ixPubkeys = ixKeys.map((k) => k.pubkey);
  const expectedPubkeys = [
    payer.toBase58(),
    XDEX_AUTHORITY,
    snapshot.poolFields.amm_config,
    snapshot.pool,
    inputAta.toBase58(),
    outputAta.toBase58(),
    quote.inputVault,
    quote.outputVault,
    quote.inputProgram,
    quote.outputProgram,
    quote.inputMint,
    quote.outputMint,
    snapshot.poolFields.observation_key,
  ];
  if (ixKeys.length !== 13 || !ixPubkeys.every((pk, i) => pk === expectedPubkeys[i])) {
    throw new Error(
      "xdexSwapLeg: the Raydium SDK account layout drifted from the LIVE-VERIFIED XDEX " +
        "order (anchor tx 65xjdHVd…) — refusing to construct. Re-verify against a new live " +
        "swap before touching this guard.",
    );
  }
  const data = Buffer.from(ix.data);
  if (data.length !== 24 || data.toString("hex").slice(0, 16) !== XDEX_SWAP_BASE_INPUT_DISCRIMINATOR) {
    throw new Error(
      "xdexSwapLeg: the Raydium SDK swap payload drifted from the LIVE-VERIFIED XDEX " +
        "24-byte shape (disc 8fbe5adac41e33de + amount_in u64 LE + min_out u64 LE) — " +
        "refusing to construct.",
    );
  }

  const ixJson = {
    programId: ix.programId.toBase58(),
    keys: ixKeys,
    dataBase64: data.toString("base64"),
    dataHex: data.toString("hex"),
  };

  const artifact = {
    programId: XDEX_PROGRAM_ID,
    discriminator: XDEX_SWAP_BASE_INPUT_DISCRIMINATOR,
    pool: snapshot.pool,
    userPubkey: user.toBase58(),
    inputAta: inputAta.toBase58(),
    outputAta: outputAta.toBase58(),
    amountInRaw: quote.inRaw,
    minOutRaw: quote.minOutRaw,
    quote: {
      tradeFeeRate: quote.tradeFeeRate,
      tradeFeeRaw: quote.tradeFeeRaw,
      netInRaw: quote.netInRaw,
      inRaw: quote.inRaw,
      outRaw: quote.outRaw,
      minOutRaw: quote.minOutRaw,
      outHuman: quote.outHuman,
      priceImpactBps: quote.priceImpactBps,
      slippageBps: quote.slippageBps,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inputDecimals: quote.inputDecimals,
      outputDecimals: quote.outputDecimals,
    },
    ix: ixJson,
  };

  if (blockhash) {
    const tx = new Transaction();
    tx.feePayer = payer;
    tx.recentBlockhash = blockhash;
    tx.add(ix);
    artifact.transaction = {
      blockhash: tx.recentBlockhash,
      feePayer: payer.toBase58(),
      instructionCount: tx.instructions.length,
      serializedBase64: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64"),
    };
  }

  return artifact;
}

/**
 * Create the XDEX swap leg.
 * ctx per phase:
 *   build: { snapshot, userPubkey, inputMint, amountInRaw, slippageBps?,
 *            blockhash?, feePayer? }
 */
export function createXdexSwapLeg() {
  return createLeg({
    id: "xdex-swap",
    family: "svm",
    chain: "x1",
    description:
      "The XDEX swap leg (X1's Raydium-CP-Swap-style DEX — DIRECT on-chain integration, " +
      "no HTTP swap API): the constant-product quote from the pool snapshot (0.28% trade " +
      "fee from the live AmmConfig) + the SwapBaseInput instruction (13 metas in the live " +
      "order, disc 8fbe5adac41e33de — LIVE-VERIFIED on the anchor swap tx 65xjdHVd…, slot " +
      "76,014,947 — + amount_in u64 LE + min_out u64 LE) + the unsigned serialized tx " +
      "(golden dex-leg fixtures). family svm — the signer is the engine's single " +
      "SignerResolver.",
    goldenStep: "xdex",
    phases: {
      async build(ctx) {
        if (!ctx.snapshot) throw new Error("xdexSwapLeg.build: snapshot (the pool state) is required");
        if (!ctx.userPubkey) throw new Error("xdexSwapLeg.build: userPubkey is required");
        if (!ctx.inputMint) throw new Error("xdexSwapLeg.build: inputMint is required");
        if (!Number.isFinite(Number(ctx.amountInRaw)) || Number(ctx.amountInRaw) <= 0) {
          throw new Error("xdexSwapLeg.build: a positive raw amountInRaw is required");
        }
        const artifact = await shapeXdexSwapArtifact({
          snapshot: ctx.snapshot,
          userPubkey: ctx.userPubkey,
          inputMint: ctx.inputMint,
          amountInRaw: String(ctx.amountInRaw),
          slippageBps: ctx.slippageBps ?? 100,
          blockhash: ctx.blockhash ?? null,
          feePayer: ctx.feePayer ?? null,
        });
        return { needed: true, artifact };
      },
    },
    meta: {
      wraps:
        "OFFICIAL-SDK construction (@raydium-io/raydium-sdk-v2 makeSwapCpmmBaseInInstruction " +
        "with the XDEX program id — XDEX is a Raydium-CPMM fork on X1 with no SDK of its " +
        "own; the official Raydium SDK is the construction path, dynamic-imported in the " +
        "execute path only). XDEX program sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN " +
        "(UPGRADEABLE — BPFLoaderUpgradeab1e) SwapBaseInput (disc 8fbe5adac41e33de = " +
        "sha256(global:swap_base_input)[..8] — the SDK emits the same disc; LIVE-VERIFIED " +
        "on the anchor tx 65xjdHVd… slot 76,014,947 err ok AND by X1-mainnet simulation of " +
        "the SDK-built ix 2026-09-06 — see the module header) + the CP curve (fee on input; " +
        "live AmmConfig trade 2800/1e6, protocol 250000/1e6, fund 50000/1e6, creator 0). " +
        "SDK drift canary: the built account list + payload are checked against the " +
        "LIVE-VERIFIED 13-account order before anything serializes. Refresh the pool " +
        "snapshot before any real flow. NEBULA WALL-OFF: nebula-dex is a separate " +
        "project — its notes never inform this leg; XDEX truth = its own live on-chain " +
        "data (anchor tx + snapshots) only.",
    },
  });
}
