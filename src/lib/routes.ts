/**
 * Teleporter route brain — the single source of truth for route typing.
 *
 * X1-source routes (X1 → Solana = x1_reverse, X1 → any other chain =
 * x1_onward) are gated by REVERSE_ENABLED so an operator can disable the
 * off-ramp in one env var. That flag now DEFAULTS ON: the reverse off-ramp is
 * COMPLETE and fail-closed end to end (routing-engine Phase 2 — x1-burn →
 * release-wait → lifi-solana-out), proven by the golden reverse oracle.
 *
 * HISTORICAL GATE (now cleared): at the Step 1.2 cutover the reverse
 * self-relay was removed and the route was genuinely dead at step one (fee
 * ATA missing on X1); a partial fix would have let burns go out with no
 * working completion behind them, so every X1-source route was rejected and
 * fell through to "direct" — a route type that can never execute from X1
 * (X1 has no LiFi key, so the quote builder returns null). The completion
 * path (submitter release + LiFi Solana→EVM onward, with a pre-burn
 * destination-minimum refusal) now exists, so the gate is un-gated.
 *
 * Setting REVERSE_ENABLED=false still restores the old fail-closed behaviour:
 * X1-source pairs fall through to "direct" and the picker blocks X1 as a
 * source chain.
 */
import { REVERSE_ENABLED } from "./flags.ts";

export type RouteType = "direct" | "x1" | "x1_reverse" | "x1_onward" | "sol_x1";

/**
 * Determine the route type for a (from, to) chain pair.
 *
 * `reverseEnabled` defaults to the REVERSE_ENABLED flag (resolved once at
 * module load; now true by default — a kill switch, not a release gate); it is
 * a parameter only so tests can exercise both states.
 */
export function determineRoute(from: string, to: string, reverseEnabled: boolean = REVERSE_ENABLED): RouteType {
  if (to === "x1") return from === "sol" ? "sol_x1" : "x1";
  if (from === "x1") {
    // X1 → Solana is a single Warp burn/release. X1 → any other chain is a
    // TWO-leg route: Warp burn (X1→Sol) then LiFi (Sol→destination). Both run
    // the reverse completion path, so both are gated by the (default-on) flag.
    if (!reverseEnabled) return "direct";
    return to === "sol" ? "x1_reverse" : "x1_onward";
  }
  return "direct";
}
