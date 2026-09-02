/**
 * reverseReleaseStage.js — runs the release-wait of the reverse route
 * X1 → EVM through the routing engine's legs: the warp-release-wait leg.
 *
 * This runner is the engine home of the release poller contract
 * (TeleportForm's defaultReleasePoller — the #40 same-origin /api/warp/*
 * proxy path). The release itself is SUBMITTER-constructed (the official
 * Warp submitter broadcasts the Solana bridge_in_v2 tx — never the app);
 * this stage only DETECTS it:
 *
 *   1. warp-release-wait leg — build the poll artifact (source sig, from=x1,
 *      the expected release amount when known), then confirm = pollWarpStatus
 *      (the PROVEN poller — guardian-sig progress + destTxSig completion
 *      detection, 404-is-normal semantics — unchanged).
 *
 * RESULT SHAPE — the releasePoller contract the form reads:
 *   { ok: true, destinationTx, raw }        — release confirmed
 *   { ok: false, terminal: true, raw }      — the bridge reported failure
 *   { ok: false, timedOut: true, sawSigs }  — still awaiting (funds safe)
 *
 * ctx: { route, sig, onUpdate?, maxMs?, api? }
 */
import { legById } from "../routePlanner.js";

/**
 * Run the reverse route's release-wait (poll the Warp release to Solana).
 *
 * @param {{route: object, sig: string, onUpdate?: (stage, detail) => void,
 *          maxMs?: number, api?: string}} args
 * @returns {Promise<object>} the pollWarpStatus/releasePoller result (see header)
 */
export async function runReleaseWait({
  route,
  sig,
  onUpdate = () => {},
  maxMs = 300_000,
  api = "",
}) {
  const releaseLeg = legById(route, "warp-release-wait");
  if (!releaseLeg) {
    throw new Error("reverseReleaseStage: route has no warp-release-wait leg (planner broken)");
  }
  const build = await releaseLeg.phases.build({ sourceSig: sig, from: "x1", api });
  return releaseLeg.phases.confirm({ onUpdate, maxMs }, { build });
}
