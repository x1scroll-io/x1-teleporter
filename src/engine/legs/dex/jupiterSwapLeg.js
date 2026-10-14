/**
 * jupiterSwapLeg.js — the JUPITER swap leg of the routing engine's DEX
 * family (Phase 4: instruments-first DEX migration). Jupiter = the Solana
 * DEX aggregator (jup.ag) — one swap instruction aggregated across every
 * Solana DEX/CLMM/CPMM.
 *
 * GREENFIELD (no reference lane to wrap): the engine's DEX lanes have no
 * existing code path (the forward/reverse/THORChain lanes bridge; they do
 * NOT swap on Solana — the LiFi legs quote WSOL/USDC → EVM directly and the
 * THORChain landing auto-advance is documented as a future lane). This leg
 * is therefore the CANONICAL construction, pinned by the Phase-4 oracle
 * (test/fixtures/golden/dex-leg/jupiter-*.json): what the app-controlled,
 * deterministic bytes of a Jupiter swap ARE — the two REQUEST artifacts:
 *
 *   step1  THE QUOTE REQUEST — the canonical serialized URL for
 *          GET https://api.jup.ag/swap/v1/quote (input mint, output mint,
 *          raw amount, slippage bps). The live quote RESPONSE is fetched by
 *          the stage layer (DI — the leg never constructs endpoints), then
 *          frozen as an oracle INPUT (a quote is market data — the oracle
 *          pins the CONSTRUCTION given the same quote, exactly like the
 *          forward leg freezes the LiFi quote).
 *   step2  THE SWAP-INSTRUCTIONS REQUEST — the canonical POST body for
 *          https://api.jup.ag/swap/v1/swap-instructions: the quote response
 *          forwarded VERBATIM as quoteResponse + the pinned user pubkey +
 *          the fixed option set (wrapAndUnwrapSol, dynamicComputeUnitLimit,
 *          prioritizationFeeLamports). The response (swapInstruction +
 *          setupInstructions + lookup tables) is assembled + signed by the
 *          stage layer with the proven Solana tx assembly once a live lane
 *          lands — this leg pins the request the lane will send.
 *
 * HOST NOTE (discovery, 2026-09-02): the older v6 host
 * `https://quote-api.jup.ag/v6/*` no longer resolves (dead DNS). Jupiter's
 * current public swap API is `https://api.jup.ag/swap/v1/*` (quote +
 * swap-instructions), which the fixture pins. The leg's API bases are
 * module constants — one place to point at a future endpoint change.
 *
 * family "svm": the leg's signing surface is the Solana/X1 Wallet-Standard
 * adapter via the engine's SINGLE SignerResolver ("svm" →
 * resolveSolanaAdapter). Build is pure/offline; the network half (quote
 * fetch → swap-instructions fetch → LUT assembly → sign-and-send) is the
 * stage layer's job with DI'd executors — mirror of the THORChain quote leg
 * (which pins the request; the fetch stays in the stage/UI layer).
 *
 * ctx: { inputMint, outputMint, amount (raw base units), slippageBps,
 *        quote? (the frozen/live quote response — step2 needs it) }
 */
import { createLeg } from "../../legContract.js";

/** Jupiter's current public swap API base (discovery: the old
 *  quote-api.jup.ag/v6 host is dead — see module header). */
export const JUPITER_SWAP_API = "https://api.jup.ag/swap/v1";
export const JUPITER_QUOTE_PATH = "/quote";
export const JUPITER_SWAP_INSTRUCTIONS_PATH = "/swap-instructions";

/** The fixed option set the swap-instructions request carries (the stage
 *  layer's assembly contract — wrap SOL when the input is native, dynamic
 *  compute-unit budget, auto priority fees). */
export const JUPITER_SWAP_OPTIONS = Object.freeze({
  wrapAndUnwrapSol: true,
  dynamicComputeUnitLimit: true,
  prioritizationFeeLamports: "auto",
});

/**
 * Shape the golden step1 artifact: the canonical serialized Jupiter quote
 * request URL. Param order is fixed (the canonicalization the fixture pins):
 * inputMint, outputMint, amount, slippageBps, then optional flags. Amount is
 * RAW base units (lamports / 10^decimals) — never human units.
 *
 * @param {object} args
 * @param {string} args.inputMint the source SPL mint (base58)
 * @param {string} args.outputMint the destination SPL mint (base58)
 * @param {string|number} args.amount raw source amount in base units
 * @param {number} [args.slippageBps] slippage in basis points (default 50)
 * @param {boolean} [args.onlyDirectRoutes] restrict to direct routes (default
 *   false — the aggregator may route through intermediate mints)
 * @returns {{url: string, params: object}} the canonical request
 */
export function shapeJupiterQuoteRequestArtifact({
  inputMint,
  outputMint,
  amount,
  slippageBps = 50,
  onlyDirectRoutes = false,
}) {
  if (!inputMint || !outputMint) {
    throw new Error("shapeJupiterQuoteRequestArtifact: inputMint and outputMint are required");
  }
  const amountStr = String(amount);
  if (!/^[0-9]+$/.test(amountStr)) {
    throw new Error(`shapeJupiterQuoteRequestArtifact: amount must be raw base units (got "${amountStr}")`);
  }
  const params = {
    inputMint,
    outputMint,
    amount: amountStr,
    slippageBps: String(slippageBps),
    ...(onlyDirectRoutes ? { onlyDirectRoutes: "true" } : {}),
  };
  const qs = new URLSearchParams(params);
  return {
    url: `${JUPITER_SWAP_API}${JUPITER_QUOTE_PATH}?${qs.toString()}`,
    params,
  };
}

/**
 * Shape the golden step2 artifact: the canonical swap-instructions REQUEST
 * — the POST body the stage layer sends to assemble the swap transaction.
 * The quoteResponse is forwarded VERBATIM (never reshaped — the aggregator
 * requires the exact quote it issued), the user pubkey is the pinned
 * Solana/X1 session pubkey (never user-typed for the destination of the
 * swap output), and the option set is the fixed JUPITER_SWAP_OPTIONS.
 *
 * @param {object} args
 * @param {object} args.quote the Jupiter quote response (verbatim)
 * @param {string} args.userPublicKey the Solana/X1 session pubkey
 * @returns {{url: string, body: object}} the canonical request
 */
export function shapeJupiterSwapRequestArtifact({ quote, userPublicKey }) {
  if (!quote || typeof quote !== "object" || !quote.routePlan) {
    throw new Error("shapeJupiterSwapRequestArtifact: a Jupiter quote response is required");
  }
  if (!userPublicKey) {
    throw new Error("shapeJupiterSwapRequestArtifact: userPublicKey is required (no placeholders)");
  }
  const body = {
    quoteResponse: quote,
    userPublicKey,
    ...JUPITER_SWAP_OPTIONS,
  };
  return {
    url: `${JUPITER_SWAP_API}${JUPITER_SWAP_INSTRUCTIONS_PATH}`,
    body,
  };
}

/**
 * Create the Jupiter swap leg.
 * ctx per phase:
 *   build: { inputMint, outputMint, amount, slippageBps?, onlyDirectRoutes?,
 *            quote?, userPublicKey? }
 *     — step1 (the quote request) always builds; step2 (the swap-instructions
 *       request) builds when a quote + userPublicKey are in the ctx (the
 *       stage layer feeds the live quote back through the leg).
 */
export function createJupiterSwapLeg() {
  return createLeg({
    id: "jupiter-swap",
    family: "svm",
    chain: "sol",
    description:
      "The Jupiter swap leg (Solana DEX aggregator, api.jup.ag/swap/v1) — the canonical " +
      "quote-request URL (raw base-unit amount, slippage bps) + the swap-instructions " +
      "request body (quote forwarded verbatim + the pinned session pubkey + the fixed " +
      "option set). Build is pure/offline; the quote fetch → swap-instructions fetch → " +
      "LUT assembly → sign-and-send half is the stage layer's job with DI'd executors " +
      "(family svm — the signer is the engine's single SignerResolver). Golden steps " +
      "step1-quote-request / step2-swap-request (test/fixtures/golden/dex-leg/).",
    goldenStep: "jupiter",
    phases: {
      async build(ctx) {
        if (!ctx.inputMint || !ctx.outputMint) {
          throw new Error("jupiterSwapLeg.build: inputMint and outputMint are required");
        }
        if (!Number.isFinite(Number(ctx.amount)) || Number(ctx.amount) <= 0) {
          throw new Error("jupiterSwapLeg.build: a positive raw amount is required");
        }
        const quoteRequest = shapeJupiterQuoteRequestArtifact({
          inputMint: ctx.inputMint,
          outputMint: ctx.outputMint,
          amount: String(ctx.amount),
          slippageBps: ctx.slippageBps ?? 50,
          onlyDirectRoutes: ctx.onlyDirectRoutes === true,
        });
        const artifact = { step: "step1-quote-request", ...quoteRequest };
        if (ctx.quote && ctx.userPublicKey) {
          const swapRequest = shapeJupiterSwapRequestArtifact({
            quote: ctx.quote,
            userPublicKey: ctx.userPublicKey,
          });
          artifact.step2SwapRequest = swapRequest;
        }
        return { needed: true, artifact };
      },
    },
    meta: {
      wraps:
        "GREENFIELD construction (no reference lane to wrap): GET api.jup.ag/swap/v1/quote " +
        "(canonical param order, raw base-unit amount) + POST api.jup.ag/swap/v1/swap-instructions " +
        "(quoteResponse verbatim + userPublicKey + wrapAndUnwrapSol/dynamicComputeUnitLimit/" +
        "prioritizationFeeLamports). Host note: quote-api.jup.ag/v6 is dead (DNS) — the " +
        "fixture pins the current api.jup.ag/swap/v1 host.",
    },
  });
}
