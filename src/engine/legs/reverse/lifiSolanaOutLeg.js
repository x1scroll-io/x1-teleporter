/**
 * lifiSolanaOutLeg.js — the LiFi Solana→EVM out leg of the reverse route
 * (X1 → EVM): after the Warp release lands WSOL/USDC on Solana, LiFi carries
 * it to the destination EVM chain as the user-selected stable. This leg is
 * the engine home of the reverse stage-2 path (TeleportForm's
 * defaultReverseStage2Runner + src/lib/lifiSolanaTx.js — the #43 submit-fix
 * shape).
 *
 * THE SAFETY PIN (the whole point of the engine migration): the leg's build
 * artifact is the DETERMINISTIC QUERY — buildReverseLifiQuoteParams with
 * toAddress = the connected EVM wallet (the destination the UI showed
 * pre-sign, #44). The golden step3 fixture pins that toAddress byte-for-byte
 * (the EVM destination 0x1870aFAfA…), and the leg's simulate phase REFUSES
 * to execute a quote whose action.toAddress drifted from the pinned
 * destination — a wrong-recipient quote can never reach the wallet.
 *
 * THE SIGNER (the wrong-wallet-field bug, structurally fixed): the leg NEVER
 * resolves a signer itself. The stage runner resolves the Solana/X1 signer
 * through the engine's SINGLE SignerResolver — the SAME resolver the forward
 * leg uses (SignerResolver.resolve("svm", session) →
 * resolveSolanaAdapter → the Wallet-Standard adapter's sign functions).
 * One resolver, one code path, both directions. The submit phase signs with
 * that already-resolved adapter — the raw session/provider shape never
 * reaches the executor (the #43 bug class cannot recur).
 *
 * REUSE (wrap, don't rewrite): buildReverseLifiQuoteParams (reverseQuote.js),
 * materializeLiFiSolanaTx + simulateLiFiSolanaTx + sendLiFiSolanaTx
 * (lifiSolanaTx.js — the #43 executor split into the LegContract phases; the
 * composed executeLiFiSolanaTx keeps the identical order for non-engine
 * callers).
 *
 * ctx: { to, toTokenSymbol, netOnSolana, fromAddress, toAddress, token,
 *        lifiData (runner-fetched), solAdapter (SignerResolver-resolved),
 *        apiBase, solanaRpc, simulate? }
 */
import { createLeg } from "../../legContract.js";
import { buildReverseLifiQuoteParams } from "../../../lib/reverseQuote.js";
import {
  materializeLiFiSolanaTx,
  simulateLiFiSolanaTx,
  sendLiFiSolanaTx,
} from "../../../lib/lifiSolanaTx.js";

const normalizeEvm = (a) => String(a || "").toLowerCase();

/**
 * Build the deterministic LiFi-out query artifact for the reverse leg.
 * Pure + offline. The artifact carries the PINNED destination (toAddress) —
 * the golden step3 byte surface — plus the exact query params the runner
 * sends to /api/lifi/quote.
 *
 * Returns null when the chain/token/wallet set can't be resolved (the
 * reference "No route for the selected destination chain" — caller decides
 * the message). Throws when the destination is missing/not an EVM address.
 */
export function buildLifiOutArtifact({
  to,
  toTokenSymbol = "USDC",
  netOnSolana,
  fromAddress,
  toAddress,
  slippage = 0.5,
  token = "USDC.x",
}) {
  if (!toAddress || !/^0x[0-9a-fA-F]{40}$/.test(String(toAddress))) {
    throw new Error("lifiSolanaOutLeg.build: no usable EVM destination (toAddress)");
  }
  const built = buildReverseLifiQuoteParams({
    to,
    toTokenSymbol,
    netOnSolana,
    fromAddress,
    toAddress, // the connected EVM wallet — NO placeholders (the reference rule)
    slippage,
    token,
  });
  if (!built) return null;
  const fromSymbol = token === "wSOL.X" ? "WSOL" : "USDC";
  // The artifact field set is the GOLDEN step3 contract (the oracle's
  // capture shape) — the engine must reproduce it field-for-field.
  return {
    to,
    toTokenSymbol,
    token, // the X1 source token — drives the Solana-side fromToken
    fromSymbol,
    decimals: built.decimals,
    toDecimals: built.toDecimals,
    fromDecimals: built.decimals,
    netOnSolana,
    fromAmountRaw: built.qs.get("fromAmount"),
    fromChain: built.qs.get("fromChain"),
    toChain: built.qs.get("toChain"),
    fromToken: built.qs.get("fromToken"), // WSOL (So111…) — the Warp release token
    toToken: built.qs.get("toToken"), // USDC on the destination EVM chain
    fromAddress: built.qs.get("fromAddress"),
    // ── THE PIN — the recipient the LiFi leg must deliver to. The fixture
    //    pins this to the EVM destination; the engine cannot drift. ──
    toAddress: built.qs.get("toAddress"),
    slippage: built.qs.get("slippage"),
    integrator: built.qs.get("integrator"),
    order: built.qs.get("order"),
    allowSwitchChain: built.qs.get("allowSwitchChain"),
    x1Class: built.qs.get("x1Class"),
    hasFeeParam: built.qs.has("fee"), // x1-class: the fee key is ABSENT (policy)
    qsParams: Object.fromEntries([...built.qs.entries()].sort()),
  };
}

/**
 * Create the LiFi Solana→EVM out leg.
 * ctx per phase:
 *   build:   { to, toTokenSymbol, netOnSolana, fromAddress, toAddress, token }
 *   simulate: { lifiData, toAddress, apiBase?, solanaRpc?, simulate? } (+ build)
 *   submit:   { lifiData, solAdapter, solanaRpc? } (+ build + simulate)
 */
export function createLifiSolanaOutLeg() {
  return createLeg({
    id: "lifi-solana-out",
    family: "svm",
    chain: "sol",
    description:
      "The LiFi Solana→EVM leg of the reverse route — WSOL/USDC released on Solana carried " +
      "to the destination EVM stable. Deterministic query artifact with the PINNED EVM " +
      "destination (golden step3), materialise → fail-closed simulation (Step 1.3A) → sign " +
      "+ send with the SignerResolver-resolved adapter (the #43 fix shape).",
    goldenStep: "step3-lifi-out (toAddress pin + quote reference)",
    phases: {
      async build(ctx) {
        const artifact = buildLifiOutArtifact({
          to: ctx.to,
          toTokenSymbol: ctx.toTokenSymbol,
          netOnSolana: ctx.netOnSolana,
          fromAddress: ctx.fromAddress,
          toAddress: ctx.toAddress,
          token: ctx.token || "USDC.x",
        });
        if (!artifact) {
          throw new Error("No route for the selected destination chain");
        }
        return { needed: true, artifact };
      },

      async simulate(ctx, built) {
        const a = built?.build?.artifact;
        if (!a) throw new Error("lifiSolanaOutLeg.simulate: no build artifact");
        if (!ctx.lifiData) throw new Error("lifiSolanaOutLeg.simulate: no lifiData to execute");
        // ── THE DESTINATION PIN — refuse to execute a quote whose recipient
        //    drifted from the pinned EVM destination (the wrong-wallet-field
        //    bug class: a wrong toAddress is IRREVERSIBLE). Case-insensitive
        //    compare — the checksummed/lowercase forms are the same account.
        const quoteTo = normalizeEvm(ctx.lifiData?.action?.toAddress);
        if (quoteTo && quoteTo !== normalizeEvm(a.toAddress)) {
          throw new Error(
            `Refusing to send: the LiFi leg's destination (${ctx.lifiData?.action?.toAddress}) ` +
              `does not match the connected EVM wallet (${a.toAddress}). No funds moved.`,
          );
        }
        // Materialise (proxy /stepTransaction when the quote carries no
        // executable tx) + deserialise + MANDATORY PRE-SEND SIMULATION
        // (Step 1.3A, fail-closed — throws SimulationError on a
        // failed/unavailable sim; the wallet is NEVER prompted on a doomed
        // tx). The signer is untouched here.
        const { b64 } = await materializeLiFiSolanaTx({
          lifiData: ctx.lifiData,
          apiBase: ctx.apiBase ?? "",
        });
        const { vtx, conn } = await simulateLiFiSolanaTx({
          b64,
          solanaRpc: ctx.solanaRpc,
          simulate: ctx.simulate, // test seam — the fail-closed gate is untouched
        });
        return { ok: true, vtx, conn, b64 };
      },

      async submit(ctx, built) {
        const sim = built?.simulate;
        if (!sim?.ok || !sim.vtx) throw new Error("lifiSolanaOutLeg.submit: simulation did not pass");
        if (!ctx.solAdapter) {
          throw new Error("Connect your Solana/X1 wallet to sign");
        }
        // Sign + send with the ALREADY-RESOLVED adapter (the runner resolved
        // it through the engine's SINGLE SignerResolver — same as forward).
        return sendLiFiSolanaTx({ sol: ctx.solAdapter, vtx: sim.vtx, conn: sim.conn });
      },
    },
    meta: {
      wraps:
        "reverseQuote.buildReverseLifiQuoteParams (deterministic query + toAddress pin) + " +
        "lifiSolanaTx.materializeLiFiSolanaTx / simulateLiFiSolanaTx / sendLiFiSolanaTx (the " +
        "#43 executeLiFiSolanaTx split into LegContract phases — same order, same gates). The " +
        "signer is resolved by the RUNNER via the engine's single SignerResolver (the same " +
        "resolver the forward leg uses) — never by this leg.",
    },
  });
}
