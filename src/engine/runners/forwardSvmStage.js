/**
 * forwardSvmStage.js — runs the SVM stage (stage 2 of 2) of the forward
 * route ETH → X1 through the routing engine's legs: the X1 ATA-prep leg,
 * then the Warp lock leg.
 *
 * This runner is the engine home of what runStage2 (src/warpBridge.js) did
 * for the reference path — SAME order, SAME fail-closed gates, SAME return
 * shape, with each step now a LegContract leg:
 *
 *   0. PREFLIGHT (prelude) — assertSolanaFeePayer: the bare `AccountNotFound`
 *      from the live hop was the fee payer missing on Solana; surface it as
 *      an actionable Stage2FeePayerError before anything is built.
 *   1. x1-ata-create leg — ensure the recipient's X1 token ATA (USDC.x /
 *      wSOL.X — Token-2022) exists BEFORE the Solana leg locks funds
 *      (bridge_in_v2 requires it). Sim-mode: simulate on X1, broadcast
 *      nothing. Live mode (allowLive): guarded broadcast via
 *      sendX1AtaCreation (signTransaction + app-side broadcast through the
 *      SAME X1 connection — a wallet on Solana mainnet cannot broadcast an
 *      X1 tx itself).
 *   2. warp-lock leg — buildStage2 (ComputeBudget + 0.5% skim + BridgeOut),
 *      simulateStage2 (fail-closed), then sendStage2ViaPhantom when
 *      allowLive. The WARP_LIVE_SEND gate is forwarded as allowLive by the
 *      form — never decided here.
 *
 * RESULT SHAPE — byte-for-byte the runStage2 contract the form reads:
 *   { stage: "x1_ata_simulation"|"simulation"|"simulated_ok"|"sent",
 *     success, sim, built, prep, sent?, signature? }
 * (stage "simulated_ok" means the WARP_LIVE_SEND gate held — confirm-mode.)
 *
 * ctx: { route, solAdapter, amountHuman, allowLive, destToken,
 *        feeWalletSvm, connections: { solana, x1 }, createX1Ata? }
 */
import { legById } from "../routePlanner.js";
import { assertSolanaFeePayer, X1_FORWARD_TOKENS } from "../../warpBridge.js";
import { PublicKey } from "@solana/web3.js";

export function toPubkey(pk) {
  if (pk instanceof PublicKey) return pk;
  if (pk && typeof pk.toBase58 === "function") return new PublicKey(pk.toBase58());
  return new PublicKey(pk);
}

/**
 * Run the forward route's SVM stage (X1 ATA prep → Warp lock).
 *
 * @param {{route: object, solAdapter: object, amountHuman: number,
 *          allowLive?: boolean, destToken?: "USDC.x"|"wSOL.X",
 *          feeWalletSvm: PublicKey|string,
 *          connections: {solana: object, x1: object},
 *          createX1Ata?: boolean}} args
 * @returns {Promise<object>} the runStage2-shaped result (see header)
 * @throws {Stage2FeePayerError} when the Solana fee payer is missing/underfunded
 * @throws {SimulationError} from the guarded live sends (allowLive only)
 */
export async function runForwardSvmStage({
  route,
  solAdapter,
  amountHuman,
  allowLive = false,
  destToken = "USDC.x",
  feeWalletSvm,
  connections,
  createX1Ata = true,
}) {
  if (!solAdapter?.publicKey) throw new Error("forwardSvmStage: no Solana/X1 signer (publicKey missing)");
  if (!connections?.solana) throw new Error("forwardSvmStage: no Solana connection");
  const userPubkey = toPubkey(solAdapter.publicKey);
  const provider = solAdapter;

  // 0 — fee-payer preflight (Solana): actionable error, not AccountNotFound.
  await assertSolanaFeePayer(connections.solana, userPubkey);

  // 1 — the X1 ATA-prep leg (bridge_in_v2 prerequisite). Mirrors runStage2:
  //     no X1 connection or createX1Ata=false → no prep (prep: null).
  const ataLeg = legById(route, "x1-ata-create");
  let prep = null;
  if (createX1Ata && connections.x1 && ataLeg) {
    const fwd = X1_FORWARD_TOKENS[destToken] || X1_FORWARD_TOKENS["USDC.x"];
    const ataCtx = {
      connection: connections.x1,
      userPubkey,
      payer: userPubkey,
      mint: fwd.destMint, // USDC.x / wSOL.X recipient ATA
    };
    const ataBuild = await ataLeg.phases.build(ataCtx);
    prep = ataBuild.prep || null;
    if (ataBuild.needed) {
      if (allowLive) {
        // Guarded broadcast (sendX1AtaCreation re-simulates internally with a
        // fresh blockhash — the same double-guard the reference live path has).
        await ataLeg.phases.submit({ ...ataCtx, provider }, { build: ataBuild });
      } else {
        const prepSim = await ataLeg.phases.simulate(ataCtx, { build: ataBuild });
        if (!prepSim.ok) {
          return { stage: "x1_ata_simulation", success: false, sim: prepSim, prep, built: null };
        }
      }
    }
  }

  // 2 — the Warp lock leg (skim transfer + BridgeOut). Sim fail-closed; the
  //     WARP_LIVE_SEND gate (allowLive) decides broadcast vs confirm-mode.
  const warpLeg = legById(route, "warp-lock");
  if (!warpLeg) throw new Error("forwardSvmStage: route has no warp-lock leg (planner broken)");
  const warpCtx = {
    connection: connections.solana,
    userPubkey,
    feeWalletSvm,
    amountHuman,
    destToken,
  };
  const warpBuild = await warpLeg.phases.build(warpCtx);
  const built = warpBuild.built;
  const sim = await warpLeg.phases.simulate({ connection: connections.solana }, { build: warpBuild });
  if (!sim.ok) {
    return { stage: "simulation", success: false, sim, built, prep };
  }
  if (!allowLive) {
    return { stage: "simulated_ok", success: true, sim, built, sent: null, prep };
  }
  const sig = await warpLeg.phases.submit({ connection: connections.solana, provider }, { build: warpBuild });
  return { stage: "sent", success: true, sim, built, signature: sig, prep };
}
