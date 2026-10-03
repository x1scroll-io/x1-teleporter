/**
 * lifiEvmSwapLeg.js — the LiFi EVM same-chain SWAP leg (Phase 4, Leg C).
 *
 * LEG C VERDICT (verified live 2026-09-02 — evidence frozen in the dex-leg
 * fixtures): LiFi ALREADY quotes EVM same-chain swaps — NO swap-route
 * enabling was needed. li.quest/v1/quote with fromChain == toChain returns a
 * swap route: the live capture (eth USDC → USDT, 10 USDC, CHEAPEST) came
 * back type "lifi" / tool "sushiswap" with includedSteps
 * [protocol:feeCollection, swap:sushiswap] — a genuine same-chain swap step.
 * The app's quote path never filtered swap tools (no tools/allowBridges
 * params are sent — buildLifiQuoteParams only sets allowSwitchChain=false,
 * which gates chain-switching, NOT source-chain DEX swaps), and the server
 * fee policy (api/lifi/quote.js resolveForcedFee) already classifies
 * non-x1-class (same-chain) routes: the 0.5% integrator fee is FORCED
 * (fee=0.005) — the policy text calls same-chain routes out explicitly.
 * Conclusion: EVM swap legs are DONE by LiFi — a future same-chain EVM lane
 * runs the existing /api/lifi/quote → stepTransaction/status path with the
 * params this leg pins.
 *
 * This leg is the engine home of that construction: the canonical same-chain
 * quote REQUEST — the params the UI would send to OUR proxy
 * /api/lifi/quote (mirror of buildLifiQuoteParams' conventions, both ends on
 * the same EVM chain), plus the server-side fee policy applied
 * (resolveForcedFee → integrator forced + fee 0.005 for a same-chain route).
 * The oracle pins: the client params, the policy decision, and the exact
 * upstream URL the proxy fetches (li.quest/v1/quote + params) — with the
 * frozen live swap-route quote as the input fixture.
 *
 * family "evm": execution (approval + submit) would run through the EIP-1193
 * provider via the engine's single SignerResolver — same as the forward
 * leg's lifi-evm-bridge. Build-only here: the approval gate
 * (lifiApproval.validateLiFiApproval — the Step-1.1 audit) already accepts
 * swap tools (toolKeysForChain reads BOTH "bridges" and "exchanges" groups
 * of /v1/tools, so a sushiswap/uniswap step passes the audit).
 *
 * ctx: { chain ("eth" default — CHAINS lifiKey), fromToken, toToken (the
 *        canonical token addresses from TOKENS), amount (raw base units),
 *        fromAddress, toAddress, slippage? }
 */
import { createLeg } from "../../legContract.js";
import { CHAINS, TOKENS } from "../../../lib/teleportConstants.js";
import { LIFI_INTEGRATOR_ACCOUNT } from "../../../lib/fees.ts";
import { resolveForcedFee } from "../../../../api/lifi/quote.js";

/** The x1-class marker param our proxy reads (api/lifi/quote.js — internal
 *  to the handler; mirrored here for the policy-application step). */
export const X1_CLASS_MARKER = "x1Class";

/** The upstream LiFi API base the serverless proxy targets (api/_lifi.js). */
export const LIFI_API = "https://li.quest/v1";

/**
 * Shape the golden artifact: the canonical same-chain EVM swap quote request
 * — the client params (what the UI sends to /api/lifi/quote) + the server
 * fee-policy decision (resolveForcedFee — the REAL policy function the proxy
 * runs) + the exact upstream URL the proxy fetches after applying the policy
 * (integrator forced, fee forced/absent, x1Class stripped). NO placeholders:
 * fromAddress/toAddress are real connected wallet addresses.
 *
 * @param {object} args
 * @param {string} [args.chain] the CHAINS key ("eth" default)
 * @param {string} [args.fromToken] TOKENS symbol on the chain ("USDC")
 * @param {string} [args.toToken] TOKENS symbol on the chain ("USDT")
 * @param {string|number} args.amount raw amount in base units
 * @param {string} args.fromAddress the connected EVM session address
 * @param {string} args.toAddress the destination (same wallet for a swap)
 * @param {number} [args.slippage] slippage percent (default 0.5)
 * @returns {{chainId, fromToken, toToken, amount, params, policy,
 *            upstreamUrl}} the fixture-shaped artifact
 */
export function shapeLifiSameChainSwapArtifact({
  chain = "eth",
  fromTokenSymbol = "USDC",
  toTokenSymbol = "USDT",
  amount,
  fromAddress,
  toAddress,
  slippage = 0.5,
}) {
  const chainId = CHAINS[chain]?.lifiKey;
  const fromToken = TOKENS[chain]?.[fromTokenSymbol]?.address;
  const toToken = TOKENS[chain]?.[toTokenSymbol]?.address;
  const decimals = TOKENS[chain]?.[fromTokenSymbol]?.decimals;
  if (!chainId || !fromToken || !toToken || !decimals) {
    throw new Error("shapeLifiSameChainSwapArtifact: unknown chain/token pair");
  }
  if (!fromAddress || !toAddress) {
    throw new Error("shapeLifiSameChainSwapArtifact: real wallet addresses required (no placeholders)");
  }
  const amountStr = String(amount);
  if (!/^[0-9]+$/.test(amountStr)) {
    throw new Error(`shapeLifiSameChainSwapArtifact: amount must be raw base units (got "${amountStr}")`);
  }

  const params = {
    fromChain: String(chainId),
    toChain: String(chainId), // SAME chain on both ends → LiFi returns a swap route
    fromToken,
    toToken,
    fromAmount: amountStr,
    fromAddress,
    toAddress,
    slippage: String(slippage / 100),
    integrator: LIFI_INTEGRATOR_ACCOUNT,
    order: "CHEAPEST",
    // allowSwitchChain=false — same-chain: no destination chain to switch
    allowSwitchChain: "false",
  };

  // The server fee policy on the proxy (api/lifi/quote.js — the REAL code):
  // a same-chain request carries no x1Class marker → NOT x1-class → the 1%
  // integrator fee is FORCED (fee=0.005) — that fee IS the once-per-journey
  // Teleporter fee on non-X1 routes (fee-model v2: 0.5% capped at $250).
  const qs = new URLSearchParams(params);
  const policy = {
    forcedFee: resolveForcedFee(qs), // "0.005" — same-chain routes are not x1-class
    x1ClassPresent: qs.get(X1_CLASS_MARKER) === "1",
  };
  // Apply the policy exactly as the proxy does before forwarding:
  qs.set("integrator", LIFI_INTEGRATOR_ACCOUNT);
  if (policy.forcedFee === null) qs.delete("fee");
  else qs.set("fee", policy.forcedFee);
  qs.delete(X1_CLASS_MARKER);

  return {
    chain,
    chainId,
    fromTokenSymbol,
    toTokenSymbol,
    fromToken,
    toToken,
    amount: amountStr,
    decimals,
    params,
    policy,
    upstreamUrl: `${LIFI_API}/quote?${qs.toString()}`,
  };
}

/**
 * Create the LiFi EVM same-chain swap leg (the Leg-C verdict leg — the
 * construction a future same-chain EVM lane runs; EVM swaps are DONE by
 * LiFi, verified live + pinned).
 * ctx per phase:
 *   build: { chain?, fromToken?, toToken?, amount, fromAddress, toAddress,
 *            slippage? }
 */
export function createLifiEvmSwapLeg() {
  return createLeg({
    id: "lifi-evm-swap",
    family: "evm",
    chain: "eth",
    description:
      "The LiFi EVM same-chain swap leg — the canonical quote request for an EVM DEX swap " +
      "(USDC→USDT etc.) through OUR /api/lifi/quote policy: both ends on the same chain → " +
      "LiFi returns a swap route (verified live: type lifi / tool sushiswap, includedSteps " +
      "[feeCollection, swap:sushiswap]) and the server FORCES the 0.5% integrator fee " +
      "(resolveForcedFee — same-chain routes are not x1-class). EVM swap legs are DONE by " +
      "LiFi — this leg pins the construction (golden dex-leg fixtures).",
    goldenStep: "lifi-samechain",
    phases: {
      async build(ctx) {
        if (!Number.isFinite(Number(ctx.amount)) || Number(ctx.amount) <= 0) {
          throw new Error("lifiEvmSwapLeg.build: a positive raw amount is required");
        }
        if (!ctx.fromAddress || !ctx.toAddress) {
          throw new Error("lifiEvmSwapLeg.build: real wallet addresses required (no placeholders)");
        }
        const artifact = shapeLifiSameChainSwapArtifact({
          chain: ctx.chain ?? "eth",
          fromTokenSymbol: ctx.fromToken ?? "USDC",
          toTokenSymbol: ctx.toToken ?? "USDT",
          amount: String(ctx.amount),
          fromAddress: ctx.fromAddress,
          toAddress: ctx.toAddress,
          slippage: ctx.slippage ?? 0.5,
        });
        return { needed: true, artifact };
      },
    },
    meta: {
      wraps:
        "No new code path needed — LiFi already covers EVM same-chain swaps. The leg wraps " +
        "the EXISTING proxy fee policy (api/lifi/quote.js resolveForcedFee — forced 1% " +
        "integrator on same-chain) + the teleportConstants token registry, and pins the " +
        "upstream request construction. Execution reuses the existing /api/lifi/* path " +
        "(stepTransaction/status) + lifiApproval.validateLiFiApproval (accepts exchange " +
        "tools via toolKeysForChain).",
    },
  });
}
