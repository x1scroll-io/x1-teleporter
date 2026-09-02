/**
 * reverseLiFiStage.js — runs the LiFi stage (stage 2 of 2) of the reverse
 * route X1 → EVM through the routing engine's legs: the lifi-solana-out leg.
 *
 * This runner is the engine home of what defaultReverseStage2Runner did for
 * the reference path (TeleportForm.jsx — the #43 submit-fix shape) — SAME
 * sequence, SAME status lines, SAME error policy, with the LiFi Solana→EVM
 * leg now a LegContract leg:
 *
 *   0. SIGNER (the whole point — done HERE, never in the leg): the Solana/X1
 *      signer is resolved through the engine's SINGLE SignerResolver —
 *      resolveSigner("svm", session) — the EXACT resolver the forward leg's
 *      stage runner uses. One resolver, one code path, both directions. The
 *      wrong-wallet-field bug that stranded funds (the #43 bug: reading the
 *      raw session provider shape instead of the resolved adapter) is
 *      structurally impossible: the executor only ever sees the resolver's
 *      output.
 *   1. lifi-solana-out leg — build the deterministic query artifact (the
 *      toAddress PIN — the connected EVM wallet), then the runner fetches a
 *      FRESH quote for the net that actually LANDED on Solana (fail-closed —
 *      a quote failure surfaces instead of guessing, reference behavior),
 *      then the leg's simulate (materialise → Step 1.3A fail-closed sim +
 *      the destination-pin guard) and submit (sign + send with the resolved
 *      adapter).
 *
 * RESULT — the executor contract the form reads: the final-leg transaction
 * signature (a string).
 *
 * ctx: { route, solAdapter (SignerResolver-resolved), evmAddress, to,
 *        toTokenSymbol, netOnSolana, token, onStatus?, apiBase? }
 */
import { legById } from "../routePlanner.js";
import { buildReverseLifiQuoteParams } from "../../lib/reverseQuote.js";

/**
 * Run the reverse route's LiFi stage (Solana → EVM).
 *
 * @param {{route: object, solAdapter: object, evmAddress: string, to: string,
 *          toTokenSymbol?: string, netOnSolana: number, token?: string,
 *          onStatus?: (msg: string) => void, apiBase?: string}} args
 * @returns {Promise<string>} the LiFi tx signature (the final-leg hash)
 * @throws {Error} "No route for the selected destination chain" / the quote
 *   error verbatim / the SimulationError from the leg's fail-closed sim /
 *   the destination-pin guard error when the quote's recipient drifted.
 */
export async function runReverseLiFiStage({
  route,
  solAdapter,
  evmAddress,
  to,
  toTokenSymbol = "USDC",
  netOnSolana,
  token = "USDC.x",
  onStatus = () => {},
  apiBase = "",
  simulate, // test seam — mirrors executeLiFiSolanaTx's seam; the fail-closed Step 1.3A gate is untouched
}) {
  if (!solAdapter) throw new Error("Connect your Solana/X1 wallet to sign");
  const fromAddress =
    solAdapter.publicKey?.toBase58
      ? solAdapter.publicKey.toBase58()
      : String(solAdapter.publicKey);

  // 1 — the leg's deterministic query artifact (the toAddress PIN — the
  //     connected EVM wallet; NO placeholders, the reference rule).
  const outLeg = legById(route, "lifi-solana-out");
  if (!outLeg) throw new Error("reverseLiFiStage: route has no lifi-solana-out leg (planner broken)");
  const outBuild = await outLeg.phases.build({
    to,
    toTokenSymbol,
    netOnSolana,
    fromAddress,
    toAddress: evmAddress,
    token,
  });
  const artifact = outBuild.artifact;

  // 2 — the FRESH quote for the net that actually landed on Solana (the
  //     reference runner's fail-closed fetch — never guess the leg).
  onStatus("Quoting the Solana → " + to + " leg…");
  const resp = await fetch(`${apiBase}/api/lifi/quote?${artifact.qsParams ? new URLSearchParams(artifact.qsParams) : ""}`);
  const d = await resp.json();
  if (d?.error || d?.message) throw new Error(d.message || d.error);
  onStatus("Sending the Solana → " + to + " leg…");

  // 3 — simulate (materialise + Step 1.3A sim + the destination-pin guard)
  //     then submit (sign + send with the SignerResolver-resolved adapter).
  const ctx = {
    lifiData: d,
    solAdapter,
    toAddress: evmAddress,
    apiBase,
    simulate,
  };
  const sim = await outLeg.phases.simulate(ctx, { build: outBuild });
  if (!sim?.ok) {
    throw new Error(sim?.err || "The Solana → EVM leg did not pass simulation");
  }
  return outLeg.phases.submit(ctx, { build: outBuild, simulate: sim });
}

/**
 * Build the reverse LiFi-out query params WITHOUT a route (pure helper for
 * tests + the golden rebuild): the deterministic query the runner sends.
 * Exists so byte-identity can be asserted against the golden step3 fixture
 * without executing anything.
 */
export function reverseLifiQueryArtifact(args) {
  return buildReverseLifiQuoteParams(args);
}
