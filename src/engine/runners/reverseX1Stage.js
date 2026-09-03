/**
 * reverseX1Stage.js — runs the burn stage (stage 1 of 2) of the reverse
 * route X1 → EVM through the routing engine's legs: the X1 reverse-burn leg.
 *
 * This runner is the engine home of what runReverse (src/warpBridge.js) did
 * for the reference path (the defaultReverseStage1Runner contract) — SAME
 * preflight order, SAME fail-closed gates, SAME return shape, with the burn
 * construction now a LegContract leg wrapping the SHARED construction helper
 * (buildReverseBurnWithSkim — the SAME code path runReverse uses):
 *
 *   0. PREFLIGHT (prelude) — assertX1FeePayer: the bare `AccountNotFound`
 *      from the live hop was the fee payer missing on X1; surface it as an
 *      actionable X1FeePayerError before anything is built. When a Teleporter
 *      fee is due: assertX1TokenBalance — the burn's total debit (0.5% skim
 *      transfer + Warp gross) must be covered (the live Custom(1) failure).
 *   1. x1-reverse-burn leg — build (fee-ATA prep + buildReverseBurn + the
 *      prepended 0.5% skim transfer — ONE tx), simulateStage2 (fail-closed),
 *      then sendStage2ViaPhantom when allowLive. The WARP_LIVE_SEND gate is
 *      forwarded as allowLive by the form — never decided here.
 *
 * RESULT SHAPE — byte-for-byte the runReverse contract the form reads:
 *   { stage: "simulation"|"simulated_ok"|"sent", success, sim, built, prep,
 *     sent?, signature? }
 * (stage "simulated_ok" means the WARP_LIVE_SEND gate held — confirm-mode.)
 *
 * ctx: { route, solAdapter, amountHuman (GROSS — the runner skims 1% and
 *        burns the net, exactly like the reference runner), allowLive,
 *        token, feeWallet, connection (X1 RPC) }
 */
import { legById } from "../routePlanner.js";
import {
  assertX1FeePayer,
  assertX1TokenBalance,
  X1_REVERSE_TOKENS,
  SKIM_BPS,
} from "../../warpBridge.js";
import { PublicKey } from "@solana/web3.js";

export function toPubkey(pk) {
  if (pk instanceof PublicKey) return pk;
  if (pk && typeof pk.toBase58 === "function") return new PublicKey(pk.toBase58());
  return new PublicKey(pk);
}

/**
 * Run the reverse route's burn stage (X1 → Solana release).
 *
 * @param {{route: object, solAdapter: object, amountHuman: number,
 *          allowLive?: boolean, token?: "USDC.x"|"wSOL.X",
 *          feeWallet: PublicKey|string, connection: object}} args
 *   amountHuman = the GROSS the user entered — the runner computes the 1%
 *   skim (SKIM_BPS from fees.ts, mirroring the reference runner) and burns
 *   the net, so the balance preflight and the burn math match the quote box.
 * @returns {Promise<object>} the runReverse-shaped result (see header)
 * @throws {X1FeePayerError} when the X1 fee payer is missing/underfunded
 * @throws {X1UsdcBalanceError} when the X1 token balance can't cover the burn
 */
export async function runReverseX1Stage({
  route,
  solAdapter,
  amountHuman,
  allowLive = false,
  token = "USDC.x",
  feeWallet,
  connection,
}) {
  if (!solAdapter?.publicKey) throw new Error("reverseX1Stage: no Solana/X1 signer (publicKey missing)");
  if (!connection) throw new Error("reverseX1Stage: no X1 connection");
  const userPubkey = toPubkey(solAdapter.publicKey);
  const provider = solAdapter;

  // 0 — preflights (the reference order inside runReverse). Token-aware:
  //    wSOL.X is 9-dec (amounts + skim in wSOL.X units).
  await assertX1FeePayer(connection, userPubkey);
  const tok = X1_REVERSE_TOKENS[token] || X1_REVERSE_TOKENS["USDC.x"];
  const skim = (amountHuman * Number(SKIM_BPS)) / 10_000; // 1% of the gross
  const burnAmount = amountHuman - skim; // bridge_out burns the net
  if (skim > 0 && feeWallet) {
    await assertX1TokenBalance(connection, userPubkey, {
      mint: tok.mint,
      decimals: tok.decimals,
      sym: token,
      requiredHuman: skim + burnAmount, // 0.5% skim transfer + Warp gross
    });
  }

  // 1 — the x1-reverse-burn leg (bundled create + skim transfer + BridgeOut
  //     in ONE tx). Sim fail-closed; the WARP_LIVE_SEND gate (allowLive)
  //     decides broadcast vs confirm-mode.
  const burnLeg = legById(route, "x1-reverse-burn");
  if (!burnLeg) throw new Error("reverseX1Stage: route has no x1-reverse-burn leg (planner broken)");
  const burnCtx = {
    connection,
    userPubkey,
    amountHuman: burnAmount,
    feeAmount: skim,
    feeWallet: feeWallet ? toPubkey(feeWallet) : null,
    token,
  };
  const burnBuild = await burnLeg.phases.build(burnCtx);
  const built = burnBuild.built;
  const prep = burnBuild.prep;
  const sim = await burnLeg.phases.simulate({ connection }, { build: burnBuild });
  if (!sim.ok) {
    return { stage: "simulation", success: false, sim, built, prep };
  }
  if (!allowLive) {
    return { stage: "simulated_ok", success: true, sim, built, sent: null, prep };
  }
  const sig = await burnLeg.phases.submit({ connection, provider }, { build: burnBuild });
  return { stage: "sent", success: true, sim, built, signature: sig, prep };
}
